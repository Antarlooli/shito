'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli } = require('../cli');
const { client, getJson } = require('../http');
const { notInstalled, summary, errorRow, mapPool, hitRows } = require('./helpers');

const TYPE = 'username';

/* ------------------------------------------------------------------ Sherlock */

const SHERLOCK_LINE = /^\[\+\]\s*(?:\[[^\]]*\]\s*)?(.+?):\s+(https?:\/\/\S+)\s*$/;

/**
 * Parses `sherlock --print-found --no-color` stdout.
 * Found lines look like: `[+] GitHub: https://github.com/torvalds`
 */
function parseSherlockOutput(stdout) {
  const hits = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = SHERLOCK_LINE.exec(line.trim());
    if (m) hits.push({ name: m[1].trim(), url: m[2].trim() });
  }
  return hits;
}

/** Last line of `text` matching `pattern`, or '' when there is none. */
function lastLine(text, pattern) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && pattern.test(l));
  return lines.length ? lines[lines.length - 1] : '';
}

async function runSherlock(ctx) {
  const source = 'Sherlock';
  const { config, query } = ctx;
  let res;
  try {
    res = await runCli(
      config.bins.sherlock,
      [
        query,
        '--print-found',
        '--no-color',
        '--timeout', String(config.sherlockTimeoutSec),
        ...(config.sherlockLocal ? ['--local'] : []),
      ],
      { timeoutMs: config.cliTimeoutMs },
    );
  } catch (err) {
    if (err.code === 'ENOENT') return [notInstalled(source, TYPE, config.bins.sherlock, 'pip install sherlock-project')];
    throw err;
  }
  const hits = parseSherlockOutput(res.stdout);
  if (hits.length === 0) {
    // Sherlock reports failures on stdout as "ERROR: ..." lines, and exits non-zero when it cannot run.
    const errorLine = lastLine(res.stdout, /^ERROR:/) || lastLine(res.stderr, /error/i);
    if (res.timedOut) return [errorRow(source, TYPE, 'timed out')];
    if (res.code !== 0 || errorLine) {
      const reason = (errorLine || `exit code ${res.code}`).replace(/^ERROR:\s*/, '').slice(0, 200);
      return [errorRow(source, TYPE, `Sherlock failed: ${reason}`)];
    }
  }
  return [
    summary(source, TYPE, `Checked username across Sherlock site list: ${hits.length} account(s) found`, {
      status: hits.length ? 'info' : 'miss',
      link: 'https://github.com/sherlock-project/sherlock',
    }),
    ...hitRows(source, TYPE, hits, { detailPrefix: 'Account found' }),
  ];
}

/* ------------------------------------------------------------------ Maigret */

/** Reads the `*_simple.json` report that `maigret --json simple` writes. */
function parseMaigretReport(report) {
  const hits = [];
  for (const [site, value] of Object.entries(report || {})) {
    if (!value || typeof value !== 'object') continue;
    const status = value.status && typeof value.status === 'object' ? value.status : {};
    if (status.status === 'Claimed') {
      hits.push({
        name: site,
        url: value.url_user || status.url || '',
        raw: { site, username: value.username, ids: status.ids || {}, tags: status.tags || [] },
      });
    }
  }
  return hits;
}

async function runMaigret(ctx) {
  const source = 'Maigret';
  const { config, query } = ctx;
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maigret-'));
  try {
    let res;
    try {
      res = await runCli(
        config.bins.maigret,
        [
          query,
          '--json', 'simple',
          '--folderoutput', workDir,
          '--no-color',
          '--no-progressbar',
          '--no-autoupdate',
          '--top-sites', String(config.maigretTopSites),
          '--timeout', '10',
          '--retries', '1',
        ],
        { timeoutMs: config.cliTimeoutMs },
      );
    } catch (err) {
      if (err.code === 'ENOENT') return [notInstalled(source, TYPE, config.bins.maigret, 'pip install maigret')];
      throw err;
    }

    const files = (await fs.promises.readdir(workDir)).filter((f) => f.endsWith('.json'));
    if (files.length === 0) {
      const reason = res.timedOut ? 'timed out' : (res.stderr.trim().split('\n').pop() || `exit code ${res.code}`).slice(0, 200);
      return [errorRow(source, TYPE, `Maigret produced no report (${reason})`)];
    }
    const report = JSON.parse(await fs.promises.readFile(path.join(workDir, files[0]), 'utf8'));
    const hits = parseMaigretReport(report);
    return [
      summary(source, TYPE, `Scanned top ${config.maigretTopSites} sites: ${hits.length} account(s) claimed`, {
        status: hits.length ? 'info' : 'miss',
        link: 'https://github.com/soxoj/maigret',
      }),
      ...hitRows(source, TYPE, hits, { detailPrefix: 'Account claimed' }),
    ];
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------- WhatsMyName */

let wmnSitesPromise = null;

/** Loads WhatsMyName site definitions from disk, downloading them once if missing. */
function loadWmnSites(config) {
  if (!wmnSitesPromise) {
    wmnSitesPromise = (async () => {
      let data;
      try {
        data = JSON.parse(await fs.promises.readFile(config.wmn.dataPath, 'utf8'));
      } catch {
        const res = await getJson(config.wmn.dataUrl, { timeout: 60_000 });
        if (res.status !== 200 || !res.data || !Array.isArray(res.data.sites)) {
          throw new Error(`could not load WhatsMyName data (HTTP ${res.status})`);
        }
        data = res.data;
        await fs.promises.mkdir(path.dirname(config.wmn.dataPath), { recursive: true });
        await fs.promises.writeFile(config.wmn.dataPath, JSON.stringify(data));
      }
      return (data.sites || []).filter((site) => site && site.valid !== false && site.uri_check);
    })().catch((err) => {
      wmnSitesPromise = null; // allow a retry on the next search
      throw err;
    });
  }
  return wmnSitesPromise;
}

/**
 * Decides whether a WhatsMyName site has the account, using the dataset's
 * e_code / e_string (exists) and m_string (missing) fields.
 */
function wmnMatches(site, status, body) {
  if (site.m_string && body.includes(site.m_string)) return false;
  const hasTest = site.e_code != null || Boolean(site.e_string);
  if (!hasTest) return false;
  if (site.e_code != null && status !== site.e_code) return false;
  if (site.e_string && !body.includes(site.e_string)) return false;
  return true;
}

/** Checks one site. Resolves { site, found, status, url, error? }. */
async function checkWmnSite(site, username, { timeoutMs }) {
  const encoded = encodeURIComponent(username);
  const checkUrl = site.uri_check.split('{account}').join(encoded);
  const prettyUrl = (site.uri_pretty || site.uri_check).split('{account}').join(encoded);
  try {
    const res = await client.get(checkUrl, {
      timeout: timeoutMs,
      responseType: 'text',
      transformResponse: [(d) => d],
      maxContentLength: 1024 * 1024,
    });
    const body = typeof res.data === 'string' ? res.data : '';
    return { site, found: wmnMatches(site, res.status, body), status: res.status, url: prettyUrl };
  } catch (err) {
    return { site, found: null, status: null, url: prettyUrl, error: err.code || err.message };
  }
}

async function runWhatsMyName(ctx) {
  const source = 'WhatsMyName';
  const { config, query } = ctx;
  let sites;
  try {
    sites = await loadWmnSites(config);
  } catch (err) {
    return [errorRow(source, TYPE, err.message, 'https://github.com/WebBreacher/WhatsMyName')];
  }

  const deadline = Date.now() + config.wmn.budgetMs;
  const outcomes = await mapPool(
    sites,
    config.wmn.concurrency,
    (site) => checkWmnSite(site, query, { timeoutMs: config.wmn.requestTimeoutMs }),
    deadline,
  );

  let checked = 0;
  let unreachable = 0;
  const hits = [];
  for (const o of outcomes) {
    if (!o) continue;
    checked += 1;
    if (o.error) unreachable += 1;
    else if (o.found) hits.push({ name: o.site.name, url: o.url, raw: { status: o.status, category: o.site.cat } });
  }
  const notChecked = sites.length - checked;
  // If most requests failed, the server (not the sites) is probably offline or blocked.
  const mostlyUnreachable = checked > 0 && unreachable / checked > 0.5;
  const text =
    `Checked ${checked}/${sites.length} sites: ${hits.length} match(es), ${unreachable} unreachable` +
    (notChecked > 0 ? `, ${notChecked} skipped (time budget)` : '');

  return [
    summary(source, TYPE, mostlyUnreachable ? `${text}. Most requests failed; check outbound connectivity` : text, {
      status: mostlyUnreachable ? 'error' : hits.length ? 'info' : 'miss',
      link: 'https://github.com/WebBreacher/WhatsMyName',
    }),
    ...hitRows(source, TYPE, hits, { detailPrefix: 'Profile match' }),
  ];
}

/* ------------------------------------------------------------- NebulaOSINT */

async function runNebula(ctx) {
  const source = 'NebulaOSINT';
  const { config, query } = ctx;
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nebula-'));
  const jsonPath = path.join(workDir, 'nebula.json');
  try {
    let res;
    try {
      res = await runCli(config.bins.nebula, [query, '--json', jsonPath, '--timeout', '10'], {
        timeoutMs: config.cliTimeoutMs,
      });
    } catch (err) {
      if (err.code === 'ENOENT') return [notInstalled(source, TYPE, config.bins.nebula, 'pip install NebulaOSINT')];
      throw err;
    }
    let report;
    try {
      report = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    } catch {
      // NebulaOSINT writes its JSON only when it has matches; a clean exit without a file means zero matches.
      if (!res.timedOut && res.code === 0) {
        report = { total_results: null, results: [] };
      } else {
        const reason = res.timedOut ? 'timed out' : (lastLine(res.stderr, /./) || `exit code ${res.code}`).slice(0, 200);
        return [errorRow(source, TYPE, `NebulaOSINT produced no report (${reason})`)];
      }
    }
    const found = (report.results || []).filter((r) => r && r.found && r.url);
    const hits = found.map((r) => ({
      name: r.site_name || r.site || 'unknown',
      url: r.url,
      raw: { category: r.category, status_code: r.status_code },
    }));
    return [
      summary(source, TYPE, hits.length
        ? `${hits.length} site(s) found out of ${report.total_results ?? 'the'} checked`
        : `No matches reported by NebulaOSINT${report.total_results ? ` (${report.total_results} checked)` : ''}`, {
        status: hits.length ? 'info' : 'miss',
        link: 'https://github.com/ismailtsdln/NebulaOSINT',
      }),
      ...hitRows(source, TYPE, hits, { detailPrefix: 'Profile found' }),
    ];
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Test hook: forget the cached WhatsMyName dataset. */
function _resetWmnCache() {
  wmnSitesPromise = null;
}

module.exports = {
  _resetWmnCache,
  parseSherlockOutput,
  parseMaigretReport,
  wmnMatches,
  checkWmnSite,
  runSherlock,
  runMaigret,
  runWhatsMyName,
  runNebula,
};

