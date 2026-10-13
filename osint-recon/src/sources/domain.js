'use strict';

const dns = require('dns').promises;
const { getJson } = require('../http');
const { makeResult } = require('../result');
const { summary, errorRow } = require('./helpers');

const TYPE = 'domain';

/* ------------------------------------------------------------------ RDAP */

/** Extracts the registrar's display name from an RDAP entity list. */
function registrarName(entities = []) {
  for (const entity of entities) {
    if (!Array.isArray(entity.roles) || !entity.roles.includes('registrar')) continue;
    const fn = entity.vcardArray?.[1]?.find((field) => field[0] === 'fn');
    if (fn && fn[3]) return String(fn[3]);
    if (entity.handle) return `handle ${entity.handle}`;
  }
  return null;
}

async function runRdap(ctx) {
  const source = 'RDAP / WHOIS';
  const domain = ctx.query;
  const link = `https://rdap.org/domain/${domain}`;
  const res = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { timeout: 20_000 });

  if (res.status === 404) {
    return [summary(source, TYPE, 'No RDAP record (not registered, or TLD has no RDAP service)', { status: 'miss', link })];
  }
  const d = res.data;
  if (res.status !== 200 || !d || typeof d !== 'object') {
    return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  }

  const events = Object.fromEntries((d.events || []).map((e) => [e.eventAction, e.eventDate]));
  const nameservers = (d.nameservers || []).map((n) => n.ldhName).filter(Boolean);
  const registrar = registrarName(d.entities);
  const statuses = Array.isArray(d.status) ? d.status : [];

  const rows = [
    summary(source, TYPE, `Registrar: ${registrar || 'not disclosed'}`, {
      status: 'info',
      link,
      raw: { handle: d.handle, ldhName: d.ldhName, status: statuses, events, nameservers },
    }),
  ];
  if (events.registration) rows.push(makeResult({ source, type: TYPE, status: 'info', detail: `Registered: ${events.registration}` }));
  if (events.expiration) rows.push(makeResult({ source, type: TYPE, status: 'info', detail: `Expires: ${events.expiration}` }));
  if (events['last changed']) rows.push(makeResult({ source, type: TYPE, status: 'info', detail: `Last changed: ${events['last changed']}` }));
  if (statuses.length) rows.push(makeResult({ source, type: TYPE, status: 'info', detail: `EPP status: ${statuses.join(', ')}` }));
  if (nameservers.length) rows.push(makeResult({ source, type: TYPE, status: 'info', detail: `Nameservers: ${nameservers.join(', ')}` }));
  return rows;
}

/* ----------------------------------------------------------------- crt.sh */

/** Pulls unique hostnames that belong to `domain` out of crt.sh JSON rows. */
function extractSubdomains(rows, domain) {
  const names = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const raw of String(row?.name_value || '').split('\n')) {
      const name = raw.trim().toLowerCase().replace(/^\*\./, '');
      if (name && (name === domain || name.endsWith(`.${domain}`)) && !/[\s/]/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

async function runCrtSh(ctx) {
  const source = 'crt.sh';
  const domain = ctx.query;
  const link = `https://crt.sh/?q=${encodeURIComponent(domain)}`;
  // %25 is a URL-encoded "%" wildcard, so this returns every certificate for *.domain.
  const res = await getJson('https://crt.sh/', {
    timeout: 45_000,
    params: { q: `%.${domain}`, output: 'json' },
  });
  if (res.status !== 200) {
    return [errorRow(source, TYPE, `certificate transparency query failed (HTTP ${res.status})`, link)];
  }
  const names = extractSubdomains(res.data, domain);
  if (names.length === 0) {
    return [summary(source, TYPE, 'No certificates found in CT logs', { status: 'miss', link })];
  }
  return [
    summary(source, TYPE, `${names.length} unique hostname(s) seen in certificate transparency logs`, {
      status: 'info',
      link,
      raw: { count: names.length },
    }),
    ...names.slice(0, 200).map((name) =>
      makeResult({ source, type: TYPE, status: 'hit', detail: `Subdomain: ${name}`, link: `https://${name}` }),
    ),
  ];
}

/* ------------------------------------------------------------------- DNS */

async function runDnsRecords(ctx) {
  const source = 'DNS records';
  const domain = ctx.query;
  const lookups = [
    ['A', () => dns.resolve4(domain)],
    ['AAAA', () => dns.resolve6(domain)],
    ['MX', () => dns.resolveMx(domain).then((r) => r.map((m) => (!m.exchange || m.exchange === '.' ? 'null MX (no mail)' : `${m.exchange} (${m.priority})`)))],
    ['NS', () => dns.resolveNs(domain)],
    ['TXT', () => dns.resolveTxt(domain).then((r) => r.map((chunks) => chunks.join('')))],
  ];
  const settled = await Promise.allSettled(lookups.map(([, fn]) => fn()));

  const rows = [];
  let anyAnswer = false;
  settled.forEach((outcome, i) => {
    const [label] = lookups[i];
    if (outcome.status === 'fulfilled' && outcome.value.length) {
      anyAnswer = true;
      rows.push(
        makeResult({
          source,
          type: TYPE,
          status: 'info',
          detail: `${label}: ${outcome.value.slice(0, 10).join(', ')}`,
          raw: { record: label, values: outcome.value },
        }),
      );
    }
  });
  if (!anyAnswer) {
    const codes = [...new Set(settled.map((s) => s.reason?.code).filter(Boolean))];
    if (codes.includes('ENOTFOUND') || codes.length === 0) {
      return [summary(source, TYPE, 'Domain does not resolve (no A/AAAA/MX/NS/TXT records)', { status: 'miss' })];
    }
    return [errorRow(source, TYPE, `DNS lookup failed (${codes.join(', ')})`)];
  }
  return [summary(source, TYPE, `Resolved ${rows.length} record type(s)`, { status: 'info' }), ...rows];
}

module.exports = { registrarName, extractSubdomains, runRdap, runCrtSh, runDnsRecords };
