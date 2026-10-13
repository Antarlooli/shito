'use strict';

const { makeResult } = require('../result');

function notInstalled(source, type, bin, hint) {
  return makeResult({
    source,
    type,
    status: 'skipped',
    detail: `Not installed on this server: "${bin}" CLI missing (${hint})`,
  });
}

function notConfigured(source, type, envName, link) {
  return makeResult({
    source,
    type,
    status: 'skipped',
    detail: `Not configured: set ${envName} to enable this source`,
    link,
  });
}

function summary(source, type, detail, { status = 'info', link = '', raw = null } = {}) {
  return makeResult({ source, type, detail, status, link, raw });
}

function errorRow(source, type, message, link = '') {
  return makeResult({ source, type, status: 'error', detail: `Error: ${message}`, link });
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Stops starting new items
 * once `deadline` (epoch ms) has passed; unstarted items get `undefined`.
 */
async function mapPool(items, limit, fn, deadline = Infinity) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (Date.now() >= deadline) return;
      const idx = next++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { error: err };
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

/** Turns a list of { name, url, detail? } hits into result rows. */
function hitRows(source, type, hits, { detailPrefix = 'Found', maxRows = 300, extra = {} } = {}) {
  return hits.slice(0, maxRows).map((hit) =>
    makeResult({
      source,
      type,
      status: 'hit',
      detail: hit.detail || `${detailPrefix}: ${hit.name}`,
      link: hit.url,
      raw: hit.raw ?? { ...extra, ...hit },
    }),
  );
}

module.exports = { notInstalled, notConfigured, summary, errorRow, mapPool, hitRows };
