'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { createApp, createRateLimiter } = require('../server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-server-test-'));

async function withServer(fn, { rateMax = 50 } = {}) {
  const cfg = {
    ...config,
    rateLimit: { windowMs: 60_000, max: rateMax },
    logFile: path.join(tmp, `queries-${Math.random().toString(36).slice(2)}.log`),
    cacheTtlMs: 1000,
  };
  const logged = [];
  const app = createApp(cfg, { logQuery: async (entry) => logged.push(entry) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, logged, cfg });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

async function search(base, body, { raw = false } = {}) {
  const res = await fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
}

test('static frontend is served with the security headers', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /OSINT RECON CONSOLE/);
    assert.match(html, /&gt; EXECUTE/);
    assert.match(html, /\[ enter target: name, email, username, phone, IP, domain\.\.\. \]/);
    assert.match(html, /FOR EDUCATIONAL \/ AUTHORIZED USE ONLY\. ALL QUERIES LOGGED LOCALLY\./);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), null, 'must stay embeddable in the preview iframe');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('health and sources endpoints respond', async () => {
  await withServer(async ({ base }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.status, 'ok');
    const sources = await (await fetch(`${base}/api/sources`)).json();
    assert.ok(sources.sources.length >= 20);
    assert.deepEqual(sources.types, ['email', 'ip', 'domain', 'phone', 'username', 'name']);
  });
});

test('validation: empty, too long, control characters, undetectable and mismatched input are 400', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await search(base, { query: '' })).status, 400);
    assert.equal((await search(base, {})).status, 400);
    assert.equal((await search(base, { query: 'a'.repeat(201) })).status, 400);
    assert.equal((await search(base, { query: 'bad\u0007input' })).status, 400);
    const undetectable = await search(base, { query: 'hello world!' });
    assert.equal(undetectable.status, 400);
    assert.match(undetectable.data.error, /Could not detect input type/);
    const mismatch = await search(base, { query: 'not-an-ip', type: 'ip' });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.data.error, /not a valid ip/);
  });
});

test('malformed JSON bodies return a JSON 400', async () => {
  await withServer(async ({ base }) => {
    const res = await search(base, '{"query": ', { raw: true });
    assert.equal(res.status, 400);
    assert.equal(typeof res.data.error, 'string');
  });
});

test('name search returns only pivot rows (no network) and logs the query', async () => {
  await withServer(async ({ base, logged }) => {
    const { status, data } = await search(base, { query: 'Ada Lovelace' });
    assert.equal(status, 200);
    assert.equal(data.type, 'name');
    assert.equal(data.query, 'Ada Lovelace');
    assert.deepEqual(data.candidates, ['name']);
    assert.ok(data.results.length >= 5);
    const google = data.results.find((r) => r.detail === 'Google exact-match search');
    assert.equal(google.link, 'https://www.google.com/search?q=%22Ada%20Lovelace%22');
    assert.equal(data.stats.sourcesFailed, 0);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].query, 'Ada Lovelace');
    assert.equal(logged[0].type, 'name');
  });
});

test('private IPs skip external sources without making requests', async () => {
  await withServer(async ({ base }) => {
    const { status, data } = await search(base, { query: '192.168.1.10' });
    assert.equal(status, 200);
    assert.equal(data.type, 'ip');
    const ipSkips = data.results.filter((r) => r.source !== 'Pivot Links' && r.source !== 'Meta Catalog');
    assert.ok(ipSkips.length >= 4);
    assert.ok(ipSkips.every((r) => r.status === 'skipped'));
    assert.ok(ipSkips.every((r) => /Private/.test(r.detail)));
  });
});

test('forced MODE overrides auto-detection', async () => {
  await withServer(async ({ base }) => {
    const { status, data } = await search(base, { query: 'john.doe', type: 'username' });
    assert.equal(status, 200);
    assert.equal(data.type, 'username');
    assert.deepEqual(data.candidates, ['username']);
  });
});

test('per-IP rate limit returns 429 with Retry-After', async () => {
  await withServer(
    async ({ base }) => {
      assert.equal((await search(base, { query: 'Ada Lovelace' })).status, 200);
      assert.equal((await search(base, { query: 'Ada Lovelace' })).status, 200);
      const limited = await search(base, { query: 'Ada Lovelace' });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
    },
    { rateMax: 2 },
  );
});

test('rate limiter window slides and evicts old hits', () => {
  const limit = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limit('ip', 0).allowed, true);
  assert.equal(limit('ip', 10).allowed, true);
  const blocked = limit('ip', 20);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 1);
  assert.equal(limit('ip', 1005).allowed, true);
  assert.equal(limit('other', 20).allowed, true);
});

process.on('exit', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
