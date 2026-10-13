'use strict';

const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) OSINT-Recon-Console/1.0 (educational research; +https://github.com/Antarlooli/shito)';

/**
 * Shared HTTP client. Never throws on HTTP error codes: callers inspect `status`
 * themselves, because many OSINT APIs use 404 to mean "no record".
 */
const client = axios.create({
  timeout: 15_000,
  maxRedirects: 5,
  maxContentLength: 2 * 1024 * 1024,
  maxBodyLength: 64 * 1024,
  validateStatus: () => true,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  },
});

/** GET with an explicit timeout. Returns { status, data, headers }. */
async function getJson(url, { timeout = 15_000, headers = {}, params } = {}) {
  const res = await client.get(url, { timeout, headers, params, responseType: 'json', transitional: { silentJSONParsing: true, forcedJSONParsing: true } });
  return { status: res.status, data: res.data, headers: res.headers };
}

module.exports = { client, getJson, USER_AGENT };
