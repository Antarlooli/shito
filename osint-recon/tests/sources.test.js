'use strict';

// Tests for source adapters that run external tools or local HTTP services.
// External CLIs are replaced with small Node scripts so the tests need no network and no installs.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const username = require('../src/sources/username');
const { runHolehe } = require('../src/sources/email');
const { runPhoneInfoga, runNumverify } = require('../src/sources/phone');
const { withTimeout, deriveSourceStatus } = require('../src/orchestrator');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-test-'));

function fakeScript(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

function testConfig(overrides = {}) {
  return {
    ...config,
    cliTimeoutMs: 20_000,
    ...overrides,
    bins: { ...config.bins, ...(overrides.bins || {}) },
  };
}

test('Sherlock wrapper: parses the CLI output into hit rows', async () => {
  const bin = fakeScript(
    'fake-sherlock',
    `console.log('[*] Checking');console.log('[+] GitHub: https://github.com/' + process.argv[2]);console.log('[-] Twitter: Not Found!');`,
  );
  const rows = await username.runSherlock({ query: 'torvalds', type: 'username', config: testConfig({ bins: { sherlock: bin } }) });
  const hits = rows.filter((r) => r.status === 'hit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].link, 'https://github.com/torvalds');
  assert.equal(hits[0].detail, 'Account found: GitHub');
  assert.equal(rows[0].source, 'Sherlock');
});

test('Sherlock wrapper: missing binary yields a "not installed" skip row', async () => {
  const rows = await username.runSherlock({
    query: 'torvalds',
    type: 'username',
    config: testConfig({ bins: { sherlock: 'definitely-not-a-real-binary-xyz' } }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped');
  assert.match(rows[0].detail, /Not installed/);
});

test('Sherlock wrapper: failures printed on stdout become an error row', async () => {
  const bin = fakeScript(
    'fake-sherlock-fail',
    `console.log('ERROR:  Problem while attempting to access data file URL');process.exit(1);`,
  );
  const rows = await username.runSherlock({ query: 'torvalds', type: 'username', config: testConfig({ bins: { sherlock: bin } }) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].detail, /^Error: Sherlock failed: Problem while attempting/);
});

test('NebulaOSINT wrapper: clean exit without a JSON report means zero matches', async () => {
  const bin = fakeScript('fake-nebula-empty', `console.log('Note: No matches found.');`);
  const rows = await username.runNebula({ query: 'nobody', type: 'username', config: testConfig({ bins: { nebula: bin } }) });
  assert.equal(rows[0].status, 'miss');
  assert.match(rows[0].detail, /No matches reported by NebulaOSINT/);
});

test('Maigret wrapper: reads the JSON report written to --folderoutput', async () => {
  const bin = fakeScript(
    'fake-maigret',
    `const fs=require('fs');const a=process.argv;const dir=a[a.indexOf('--folderoutput')+1];const user=a[2];
fs.writeFileSync(dir+'/report_'+user+'_simple.json', JSON.stringify({
  GitHub:{username:user,url_user:'https://github.com/'+user,status:{status:'Claimed',url:'https://github.com/'+user}},
  Other:{username:user,url_user:'https://x.test/'+user,status:{status:'Available'}}
}));`,
  );
  const rows = await username.runMaigret({ query: 'torvalds', type: 'username', config: testConfig({ bins: { maigret: bin } }) });
  const hits = rows.filter((r) => r.status === 'hit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].link, 'https://github.com/torvalds');
});

test('Maigret wrapper: a run that writes no report becomes an error row', async () => {
  const bin = fakeScript('fake-maigret-fail', `console.error('boom: rate limited');process.exit(2);`);
  const rows = await username.runMaigret({ query: 'nobody', type: 'username', config: testConfig({ bins: { maigret: bin } }) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].detail, /boom: rate limited/);
});

test('Holehe wrapper: runs the CLI and returns only used sites', async () => {
  const bin = fakeScript(
    'fake-holehe',
    `console.log('[+] Email used, [-] Email not used');console.log('[+] twitter.com');console.log('[+] github.com');`,
  );
  const rows = await runHolehe({ query: 'a@example.com', type: 'email', config: testConfig({ bins: { holehe: bin } }) });
  assert.deepEqual(rows.filter((r) => r.status === 'hit').map((r) => r.link), ['https://twitter.com/', 'https://github.com/']);
});

test('Optional-key sources report "not configured" when the key is absent', async () => {
  const cfg = testConfig({ keys: { hibp: '', leakcheck: '', numverify: '' }, phoneinfogaUrl: '' });
  const numverify = await runNumverify({ query: '+15556661212', type: 'phone', config: cfg });
  assert.equal(numverify[0].status, 'skipped');
  assert.match(numverify[0].detail, /NUMVERIFY_API_KEY/);

  const pi = await runPhoneInfoga({ query: '+15556661212', type: 'phone', config: cfg });
  assert.equal(pi[0].status, 'skipped');
  assert.match(pi[0].detail, /PHONEINFOGA_URL/);
});

test('WhatsMyName: checks sites over HTTP and reports matches', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/found/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><div class="profile-card">hi</div></html>');
    } else if (req.url.startsWith('/slow/')) {
      // Never responds in time, so the request times out.
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>nope</html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const dataPath = path.join(tmp, 'wmn-test.json');
  fs.writeFileSync(
    dataPath,
    JSON.stringify({
      sites: [
        { name: 'FoundSite', uri_check: `${base}/found/{account}`, e_code: 200, e_string: 'profile-card', cat: 'social' },
        { name: 'MissingSite', uri_check: `${base}/missing/{account}`, e_code: 200, e_string: 'profile-card', cat: 'social' },
        { name: 'InvalidSite', uri_check: `${base}/found/{account}`, valid: false },
        { name: 'SlowSite', uri_check: `${base}/slow/{account}`, e_code: 200 },
      ],
    }),
  );

  username._resetWmnCache();
  const cfg = testConfig({ wmn: { dataPath, dataUrl: '', concurrency: 4, requestTimeoutMs: 500, budgetMs: 10_000 } });
  const rows = await username.runWhatsMyName({ query: 'alice', type: 'username', config: cfg });
  server.closeAllConnections?.();
  server.close();

  const hits = rows.filter((r) => r.status === 'hit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].detail, 'Profile match: FoundSite');
  assert.equal(hits[0].link, `${base}/found/alice`);
  const summaryRow = rows[0];
  assert.match(summaryRow.detail, /Checked 3\/3 sites: 1 match\(es\), 1 unreachable/);
  username._resetWmnCache();
});

test('WhatsMyName: when most requests fail, the summary is an error', async () => {
  const dataPath = path.join(tmp, 'wmn-dead.json');
  fs.writeFileSync(
    dataPath,
    JSON.stringify({
      sites: [
        { name: 'A', uri_check: 'http://127.0.0.1:1/{account}', e_code: 200 },
        { name: 'B', uri_check: 'http://127.0.0.1:1/{account}', e_code: 200 },
      ],
    }),
  );
  username._resetWmnCache();
  const cfg = testConfig({ wmn: { dataPath, dataUrl: '', concurrency: 2, requestTimeoutMs: 1000, budgetMs: 10_000 } });
  const rows = await username.runWhatsMyName({ query: 'alice', type: 'username', config: cfg });
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].detail, /Most requests failed/);
  username._resetWmnCache();
});

test('withTimeout rejects with the message and clears its timer on success', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'too slow'), /too slow/);
  assert.equal(await withTimeout(Promise.resolve('fine'), 1000, 'unused'), 'fine');
});

test('deriveSourceStatus classifies source outcomes', () => {
  assert.equal(deriveSourceStatus([]), 'ok');
  assert.equal(deriveSourceStatus([{ status: 'skipped' }]), 'skipped');
  assert.equal(deriveSourceStatus([{ status: 'error' }, { status: 'skipped' }]), 'error');
  assert.equal(deriveSourceStatus([{ status: 'error' }, { status: 'miss' }]), 'ok');
});

process.on('exit', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
