'use strict';

const { SOURCES } = require('./sources');
const { makeResult } = require('./result');

/** Resolves after `ms`, or rejects with a timeout error. The timer is always cleared. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sourceTimeout(source, config) {
  if (typeof source.timeoutMs === 'function') return source.timeoutMs(config);
  return source.timeoutMs ?? config.sourceTimeoutMs;
}

/** A source is "ok" if any row is not an error/skip, "skipped" if all rows are skips, else "error". */
function deriveSourceStatus(rows) {
  if (rows.length === 0) return 'ok';
  if (rows.every((r) => r.status === 'skipped')) return 'skipped';
  if (rows.every((r) => r.status === 'error' || r.status === 'skipped')) return 'error';
  return 'ok';
}

/**
 * Runs every source that applies to `type` in parallel. Each source is isolated:
 * one failure, timeout or missing dependency produces an error row and never aborts the others.
 *
 * @param {{ query: string, type: string, config: object, cache?: import('./cache').TtlCache }} params
 */
async function runSearch({ query, type, config, cache }) {
  const started = Date.now();
  const applicable = SOURCES.filter((s) => s.types.includes(type));
  const ctx = { query, type, config };

  const outcomes = await Promise.allSettled(
    applicable.map(async (source) => {
      const t0 = Date.now();
      const cacheKey = `${source.id}|${type}|${query}`;
      if (source.cacheable && cache) {
        const cached = cache.get(cacheKey);
        if (cached) return { rows: cached, ms: 0, cached: true };
      }
      const rows = await withTimeout(
        Promise.resolve().then(() => source.run(ctx)),
        sourceTimeout(source, config),
        `timed out after ${Math.round(sourceTimeout(source, config) / 1000)}s`,
      );
      if (!Array.isArray(rows)) throw new Error('source returned an invalid result');
      if (source.cacheable && cache && rows.every((r) => r.status !== 'error')) cache.set(cacheKey, rows);
      return { rows, ms: Date.now() - t0, cached: false };
    }),
  );

  const results = [];
  const sources = [];
  outcomes.forEach((outcome, i) => {
    const source = applicable[i];
    let rows;
    let ms = 0;
    let cached = false;
    if (outcome.status === 'fulfilled') {
      ({ rows, ms, cached } = outcome.value);
    } else {
      const message = outcome.reason?.message || String(outcome.reason);
      rows = [makeResult({ source: source.name, type, status: 'error', detail: `Error: ${message}` })];
    }
    // Rows from a source always carry the source's display name.
    const labelled = rows.map((r) => ({ ...r, source: r.source || source.name }));
    results.push(...labelled);
    sources.push({
      id: source.id,
      name: source.name,
      status: deriveSourceStatus(labelled),
      rows: labelled.length,
      ms,
      cached,
    });
  });

  const count = (status) => results.filter((r) => r.status === status).length;
  const sourceCount = (status) => sources.filter((s) => s.status === status).length;

  return {
    query,
    type,
    durationMs: Date.now() - started,
    results,
    sources,
    stats: {
      hits: count('hit'),
      misses: count('miss'),
      errors: count('error'),
      sourcesOk: sourceCount('ok'),
      sourcesFailed: sourceCount('error'),
      sourcesSkipped: sourceCount('skipped'),
    },
  };
}

module.exports = { runSearch, withTimeout, deriveSourceStatus };
