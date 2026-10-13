'use strict';

const { getJson } = require('../http');
const { summary, errorRow, makeResult } = require('./helpers');

const SOURCE = 'LeakCheck';
const LINK = 'https://leakcheck.io/';

/**
 * LeakCheck supports two modes:
 *  - Public API (no key, limited): GET https://leakcheck.io/api/public?check=<q>
 *  - Pro API v2 (LEAKCHECK_API_KEY): GET https://leakcheck.io/api/v2/query/<q>?type=<t>
 * Both accept email and username searches.
 */
async function runLeakCheck(ctx) {
  const { config, query, type } = ctx;
  const usingKey = Boolean(config.keys.leakcheck);

  let res;
  if (usingKey) {
    res = await getJson(`https://leakcheck.io/api/v2/query/${encodeURIComponent(query)}`, {
      timeout: 20_000,
      params: { type },
      headers: { 'X-API-Key': config.keys.leakcheck, Accept: 'application/json' },
    });
  } else {
    res = await getJson('https://leakcheck.io/api/public', {
      timeout: 20_000,
      params: { check: query },
    });
  }

  const data = res.data && typeof res.data === 'object' ? res.data : null;
  if (!data) return [errorRow(SOURCE, type, `unexpected response (HTTP ${res.status})`, LINK)];
  if (data.success === false) {
    return [errorRow(SOURCE, type, String(data.error || `request rejected (HTTP ${res.status})`), LINK)];
  }

  const found = Number(data.found) || 0;
  const mode = usingKey ? 'Pro API' : 'public API';
  if (found === 0) {
    return [summary(SOURCE, type, `No leak records found (${mode})`, { status: 'miss', link: LINK })];
  }

  const fields = Array.isArray(data.fields) ? data.fields.slice(0, 12).join(', ') : '';
  const rows = [
    summary(SOURCE, type, `Found in ${found} leak record(s) (${mode})${fields ? `; exposed fields: ${fields}` : ''}`, {
      status: 'hit',
      link: LINK,
      raw: { found, fields: data.fields || [] },
    }),
  ];

  // Pro API returns individual records; only source names are kept, never leaked values.
  const records = Array.isArray(data.result) ? data.result.slice(0, 25) : [];
  const sourceNames = new Set();
  for (const r of records) {
    for (const s of Array.isArray(r?.sources) ? r.sources : []) {
      if (s?.name) sourceNames.add(`${s.name}${s.date ? ` (${s.date})` : ''}`);
    }
  }
  for (const name of [...sourceNames].slice(0, 25)) {
    rows.push(makeResult({ source: SOURCE, type, status: 'hit', detail: `Leak source: ${name}`, link: LINK }));
  }
  return rows;
}

module.exports = { runLeakCheck };
