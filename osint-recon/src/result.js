'use strict';

/**
 * Normalised result shape shared by every source.
 *
 * {
 *   source: "Sherlock",
 *   type:   "username",
 *   detail: "Account found: GitHub",
 *   link:   "https://github.com/torvalds",
 *   raw:    { ...original payload, trimmed if large },
 *   status: "hit" | "miss" | "info" | "error" | "skipped"
 * }
 *
 * `hit` = positive finding, `miss` = checked and nothing found, `info` = context data,
 * `error` = the source failed, `skipped` = not run (missing key, unsupported input, ...).
 */

const STATUSES = new Set(['hit', 'miss', 'info', 'error', 'skipped']);

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function makeResult({ source, type, detail, link = '', raw = null, status = 'info' }) {
  return {
    source,
    type,
    detail: String(detail ?? ''),
    link: safeHttpUrl(link),
    raw: raw ?? null,
    status: STATUSES.has(status) ? status : 'info',
  };
}

/** Keeps `raw` payloads from ballooning the response for very large sources. */
function trimRaw(value, maxChars = 4000) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length <= maxChars) return value ?? null;
    return { truncated: true, preview: text.slice(0, maxChars) };
  } catch {
    return null;
  }
}

module.exports = { makeResult, safeHttpUrl, trimRaw, STATUSES };
