'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const { runCli } = require('../cli');
const { getJson } = require('../http');
const { makeResult } = require('../result');
const { notInstalled, notConfigured, summary, errorRow, hitRows } = require('./helpers');

const TYPE = 'email';

function isNullMx(record) {
  return !record.exchange || record.exchange === '.';
}

/* ------------------------------------------------------------------ Holehe */

// Found sites print as "[+] domain.tld   optional extra info". The legend line
// "[+] Email used, [-] Email not used, ..." also starts with "[+]" but has no dot-separated domain.
const HOLEHE_LINE = /^\[\+\]\s+([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b\s*(.*)$/i;

function parseHoleheOutput(stdout) {
  const hits = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = HOLEHE_LINE.exec(line.trim());
    if (!m) continue;
    const domain = m[1].toLowerCase();
    const extra = m[2].replace(/\s+/g, ' ').trim();
    hits.push({
      name: domain,
      url: `https://${domain}`,
      detail: `Email registered on ${domain}${extra ? ` (${extra})` : ''}`,
    });
  }
  return hits;
}

async function runHolehe(ctx) {
  const source = 'Holehe';
  const { config, query } = ctx;
  let res;
  try {
    res = await runCli(config.bins.holehe, [query, '--only-used', '--no-color', '-T', '10'], {
      timeoutMs: config.cliTimeoutMs,
    });
  } catch (err) {
    if (err.code === 'ENOENT') return [notInstalled(source, TYPE, config.bins.holehe, 'pip install holehe')];
    throw err;
  }
  const hits = parseHoleheOutput(res.stdout);
  if (hits.length === 0 && (res.timedOut || (res.code !== 0 && res.stderr.trim()))) {
    const reason = res.timedOut ? 'timed out' : res.stderr.trim().split('\n').pop().slice(0, 200);
    return [errorRow(source, TYPE, `Holehe ${reason}`)];
  }
  return [
    summary(source, TYPE, `Password-reset flows checked: email registered on ${hits.length} site(s)`, {
      status: hits.length ? 'info' : 'miss',
      link: 'https://github.com/megadose/holehe',
    }),
    ...hitRows(source, TYPE, hits, { detailPrefix: 'Registered' }),
  ];
}

/* ---------------------------------------------------------- XposedOrNot */

async function runXposedOrNot(ctx) {
  const source = 'XposedOrNot';
  const url = `https://api.xposedornot.com/v1/check-email/${encodeURIComponent(ctx.query)}`;
  const link = 'https://xposedornot.com/';
  const res = await getJson(url, { timeout: 20_000 });

  if (res.status === 404) {
    return [summary(source, TYPE, 'No breaches found in XposedOrNot', { status: 'miss', link })];
  }
  if (res.status === 429) return [errorRow(source, TYPE, 'rate limited (HTTP 429)', link)];
  if (res.status !== 200 || typeof res.data !== 'object' || res.data === null) {
    return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  }
  const groups = Array.isArray(res.data.breaches) ? res.data.breaches : [];
  const names = [...new Set(groups.flat().filter((n) => typeof n === 'string' && n))];
  if (names.length === 0) {
    return [summary(source, TYPE, 'No breaches found in XposedOrNot', { status: 'miss', link })];
  }
  return [
    summary(source, TYPE, `Exposed in ${names.length} breach(es)`, { status: 'info', link }),
    ...names.map((name) =>
      makeResult({ source, type: TYPE, status: 'hit', detail: `Breach: ${name}`, link, raw: { breach: name } }),
    ),
  ];
}

/* -------------------------------------------------- Have I Been Pwned (keyed) */

async function runHibp(ctx) {
  const source = 'Have I Been Pwned';
  const { config, query } = ctx;
  const link = 'https://haveibeenpwned.com/';
  if (!config.keys.hibp) return [notConfigured(source, TYPE, 'HIBP_API_KEY', link)];

  const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(query)}`;
  const res = await getJson(url, {
    timeout: 20_000,
    params: { truncateResponse: 'false' },
    headers: { 'hibp-api-key': config.keys.hibp },
  });
  if (res.status === 404) return [summary(source, TYPE, 'No breaches found in HIBP', { status: 'miss', link })];
  if (res.status === 401 || res.status === 403) return [errorRow(source, TYPE, 'API key rejected (HTTP ' + res.status + ')', link)];
  if (res.status === 429) return [errorRow(source, TYPE, 'rate limited (HTTP 429)', link)];
  if (res.status !== 200 || !Array.isArray(res.data)) return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];

  return [
    summary(source, TYPE, `Found in ${res.data.length} breach(es)`, { status: 'info', link }),
    ...res.data.map((b) =>
      makeResult({
        source,
        type: TYPE,
        status: 'hit',
        detail: `Breach: ${b.Title || b.Name} (${b.BreachDate || 'date n/a'}) - data: ${(b.DataClasses || []).slice(0, 6).join(', ')}`,
        link: `https://haveibeenpwned.com/PwnedWebsites#${encodeURIComponent(b.Name || '')}`,
        raw: { name: b.Name, date: b.BreachDate, pwnCount: b.PwnCount, dataClasses: b.DataClasses },
      }),
    ),
  ];
}

/* --------------------------------------------------------------- Gravatar */

async function runGravatar(ctx) {
  const source = 'Gravatar';
  const email = ctx.query.trim().toLowerCase();
  const sha256 = crypto.createHash('sha256').update(email).digest('hex');
  const md5 = crypto.createHash('md5').update(email).digest('hex');

  // SHA256 is the current identifier; MD5 is still served for legacy accounts.
  let profile = null;
  let usedHash = sha256;
  for (const hash of [sha256, md5]) {
    const res = await getJson(`https://gravatar.com/${hash}.json`, { timeout: 15_000 });
    if (res.status === 200 && res.data && Array.isArray(res.data.entry) && res.data.entry[0]) {
      profile = res.data.entry[0];
      usedHash = hash;
      break;
    }
    if (res.status !== 404 && res.status !== 200) {
      return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, `https://gravatar.com/${sha256}`)];
    }
  }

  const avatarLink = `https://gravatar.com/avatar/${usedHash}`;
  if (!profile) {
    return [summary(source, TYPE, 'No Gravatar profile for this email', { status: 'miss', link: avatarLink })];
  }

  const rows = [
    makeResult({
      source,
      type: TYPE,
      status: 'hit',
      detail: `Profile: ${profile.displayName || profile.preferredUsername || 'unnamed'}${profile.currentLocation ? ` (${profile.currentLocation})` : ''}`,
      link: profile.profileUrl || `https://gravatar.com/${usedHash}`,
      raw: { preferredUsername: profile.preferredUsername, displayName: profile.displayName, location: profile.currentLocation },
    }),
    makeResult({ source, type: TYPE, status: 'info', detail: 'Avatar image', link: avatarLink }),
  ];
  for (const account of (profile.accounts || []).slice(0, 50)) {
    rows.push(
      makeResult({
        source,
        type: TYPE,
        status: 'hit',
        detail: `Linked account: ${account.display || account.shortname || account.domain}`,
        link: account.url,
        raw: { domain: account.domain, shortname: account.shortname, verified: account.verified },
      }),
    );
  }
  return rows;
}

/* ------------------------------------------------------------ Hudson Rock */

async function runHudsonRock(ctx) {
  const source = 'Hudson Rock';
  const link = 'https://cavalier.hudsonrock.com/';
  const res = await getJson(
    'https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email',
    { timeout: 20_000, params: { email: ctx.query } },
  );
  if (res.status !== 200 || typeof res.data !== 'object' || res.data === null) {
    return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  }
  const stealers = Array.isArray(res.data.stealers) ? res.data.stealers : [];
  if (stealers.length === 0) {
    return [summary(source, TYPE, 'No infostealer records for this email', { status: 'miss', link })];
  }
  return [
    summary(source, TYPE, `Infostealer infection record(s): ${stealers.length}`, { status: 'hit', link }),
    ...stealers.slice(0, 10).map((s) =>
      makeResult({
        source,
        type: TYPE,
        status: 'hit',
        detail: `Infostealer record: host ${s.computer_name || 'unknown'}, compromised ${s.date_compromised || 'date n/a'}`,
        link,
        // Only the non-sensitive metadata is kept; credentials are never stored.
        raw: { date_compromised: s.date_compromised, operating_system: s.operating_system },
      }),
    ),
  ];
}

/* ---------------------------------------------------------- Mail routing */

async function runEmailMx(ctx) {
  const source = 'DNS MX';
  const domain = ctx.query.split('@')[1];
  try {
    const records = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    if (records.length === 0) throw Object.assign(new Error('none'), { code: 'ENODATA' });
    // RFC 7505 "null MX": a single record with an empty or "." exchange means the domain refuses mail.
    if (records.length === 1 && isNullMx(records[0])) {
      return [summary(source, TYPE, `${domain} publishes a null MX: it does not accept mail`, { status: 'miss', raw: { mx: records } })];
    }
    const hosts = records.filter((r) => !isNullMx(r));
    return [
      summary(source, TYPE, `${domain} accepts mail via ${hosts.length} MX host(s)`, {
        status: 'info',
        raw: { mx: records },
      }),
      ...hosts.slice(0, 10).map((r) =>
        makeResult({ source, type: TYPE, status: 'info', detail: `MX ${r.exchange} (priority ${r.priority})`, raw: r }),
      ),
    ];
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return [summary(source, TYPE, `${domain} has no MX records (cannot receive mail)`, { status: 'miss' })];
    }
    return [errorRow(source, TYPE, `DNS lookup failed (${err.code || err.message})`)];
  }
}

module.exports = {
  isNullMx,
  parseHoleheOutput,
  runHolehe,
  runXposedOrNot,
  runHibp,
  runGravatar,
  runHudsonRock,
  runEmailMx,
};
