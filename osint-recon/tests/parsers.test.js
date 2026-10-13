'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSherlockOutput, parseSherlockResults, parseMaigretReport, wmnMatches } = require('../src/sources/username');
const { parseHoleheOutput, isNullMx } = require('../src/sources/email');
const { registrarName, extractSubdomains } = require('../src/sources/domain');
const { isPublicIPv4 } = require('../src/sources/ip');
const { buildPivotRows, fillTemplate } = require('../src/sources/pivots');

test('Sherlock: parses [+] lines and ignores everything else', () => {
  const stdout = [
    '[*] Checking username torvalds on:',
    '[+] GitHub: https://github.com/torvalds',
    '[+] [0.42s] Reddit: https://www.reddit.com/user/torvalds',
    '[-] Instagram: Not Found!',
    '[+] Hacker News: https://news.ycombinator.com/user?id=torvalds',
    'Some other noise',
  ].join('\n');
  assert.deepEqual(parseSherlockOutput(stdout), [
    { name: 'GitHub', url: 'https://github.com/torvalds' },
    { name: 'Reddit', url: 'https://www.reddit.com/user/torvalds' },
    { name: 'Hacker News', url: 'https://news.ycombinator.com/user?id=torvalds' },
  ]);
});

test('Maigret: keeps only sites whose status is Claimed', () => {
  const report = {
    GitHub: {
      username: 'torvalds',
      url_user: 'https://github.com/torvalds',
      status: { status: 'Claimed', site_name: 'GitHub', url: 'https://github.com/torvalds', ids: { uid: '1' } },
    },
    Pinterest: { username: 'torvalds', url_user: 'https://pinterest.com/torvalds', status: { status: 'Available' } },
    Broken: null,
  };
  const hits = parseMaigretReport(report);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'GitHub');
  assert.equal(hits[0].url, 'https://github.com/torvalds');
});

test('Holehe: parses found domains and skips the legend line', () => {
  const stdout = [
    '**********',
    '   a@example.com',
    '**********',
    '[+] Email used, [-] Email not used, [x] Rate limit',
    '[+] twitter.com',
    '[+] Instagram.com  / FullName Jane',
    '[-] amazon.com',
    '[x] spotify.com',
    '121 websites checked in 0.55 seconds',
  ].join('\n');
  const hits = parseHoleheOutput(stdout);
  assert.deepEqual(
    hits.map((h) => [h.name, h.url]),
    [
      ['twitter.com', 'https://twitter.com'],
      ['instagram.com', 'https://instagram.com'],
    ],
  );
  assert.match(hits[1].detail, /FullName Jane/);
});

test('RDAP: finds the registrar name from the vCard', () => {
  const entities = [
    { roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Abuse Desk']]] },
    {
      roles: ['registrar'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, LLC']]],
    },
  ];
  assert.equal(registrarName(entities), 'Example Registrar, LLC');
  assert.equal(registrarName([]), null);
  assert.equal(registrarName([{ roles: ['registrar'], handle: '42' }]), 'handle 42');
});

test('crt.sh: extracts unique in-scope hostnames and strips wildcards', () => {
  const rows = [
    { name_value: 'example.com\n*.example.com' },
    { name_value: 'api.example.com\nwww.example.com' },
    { name_value: 'evil-example.com' },
    { name_value: 'mail.other.org' },
    { name_value: 'bad name.example.com' },
    { name_value: 'API.example.com' },
  ];
  assert.deepEqual(extractSubdomains(rows, 'example.com'), [
    'api.example.com',
    'example.com',
    'www.example.com',
  ]);
  assert.deepEqual(extractSubdomains('not an array', 'example.com'), []);
});

test('IP: private and reserved ranges are not treated as public', () => {
  for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.5.4', '172.31.255.255', '127.0.0.1', '169.254.1.1', '100.64.0.1', '224.0.0.1']) {
    assert.equal(isPublicIPv4(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1']) {
    assert.equal(isPublicIPv4(ip), true, ip);
  }
});

test('WhatsMyName: match logic uses status code, e_string and m_string', () => {
  const site = { e_code: 200, e_string: 'profile-card', m_string: 'user not found' };
  assert.equal(wmnMatches(site, 200, '<div class="profile-card">'), true);
  assert.equal(wmnMatches(site, 404, '<div class="profile-card">'), false);
  assert.equal(wmnMatches(site, 200, 'profile-card but user not found'), false);
  assert.equal(wmnMatches(site, 200, 'nothing here'), false);
  assert.equal(wmnMatches({ e_code: 200, e_string: '' }, 200, ''), true);
  assert.equal(wmnMatches({ e_code: null, e_string: null }, 200, ''), false);
});

test('pivots: query is URL-encoded and meta resources are appended', () => {
  assert.equal(fillTemplate('https://x.test/{q}', 'a b&c'), 'https://x.test/a%20b%26c');
  const rows = buildPivotRows('ip', '8.8.8.8');
  const shodan = rows.find((r) => r.detail === 'Shodan host page');
  assert.equal(shodan.link, 'https://www.shodan.io/host/8.8.8.8');
  assert.equal(shodan.status, 'info');
  assert.equal(rows.filter((r) => r.source === 'Meta Catalog').length, 3);
  assert.ok(rows.every((r) => r.type === 'ip'));
});

test('pivots: unknown types produce only meta rows', () => {
  const rows = buildPivotRows('nonexistent', 'x');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.source === 'Meta Catalog'));
});

test('MX: null MX records (RFC 7505) are recognised', () => {
  assert.equal(isNullMx({ exchange: '', priority: 0 }), true);
  assert.equal(isNullMx({ exchange: '.', priority: 0 }), true);
  assert.equal(isNullMx({ exchange: 'mx.example.net', priority: 10 }), false);
});

test('Sherlock: --print-all output separates misses from unreachable sites', () => {
  const stdout = [
    '[*] Checking username tinaamazon on:',
    '[+] [0.31s] GitHub: https://github.com/tinaamazon',
    '[-] Reddit: Error Connecting',
    '[-] Pinterest: Error Connecting',
    '[-] Instagram: Not Found!',
    '[-] Weird: Illegal Username Format For This Site!',
    '[*] Search completed with 1 results',
  ].join('\n');
  const parsed = parseSherlockResults(stdout);
  assert.equal(parsed.hits.length, 1);
  assert.equal(parsed.hits[0].name, 'GitHub');
  assert.equal(parsed.checked, 5);
  assert.equal(parsed.unreachable, 2); // "Illegal Username Format" is a per-site rejection, not a network failure
  assert.deepEqual(parseSherlockOutput(stdout), parsed.hits);
});
