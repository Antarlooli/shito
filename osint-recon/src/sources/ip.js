'use strict';

const dns = require('dns').promises;
const { getJson } = require('../http');
const { makeResult } = require('../result');
const { summary, errorRow } = require('./helpers');

const TYPE = 'ip';

/** Private, loopback, link-local, CGNAT and reserved ranges have no public OSINT data. */
function isPublicIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

function privateSkip(source) {
  return [
    makeResult({
      source,
      type: TYPE,
      status: 'skipped',
      detail: 'Private, loopback or reserved address: no public OSINT data to query',
    }),
  ];
}

/* ------------------------------------------------------- Shodan InternetDB */

async function runShodanInternetDb(ctx) {
  const source = 'Shodan InternetDB';
  const ip = ctx.query;
  const link = `https://www.shodan.io/host/${ip}`;
  if (!isPublicIPv4(ip)) return privateSkip(source);

  const res = await getJson(`https://internetdb.shodan.io/${ip}`, { timeout: 15_000 });
  if (res.status === 404) {
    return [summary(source, TYPE, 'No InternetDB record for this IP', { status: 'miss', link })];
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  }
  const { ports = [], hostnames = [], tags = [], vulns = [], cpes = [] } = res.data;
  const rows = [
    summary(
      source,
      TYPE,
      `Open ports: ${ports.join(', ') || 'none'}${tags.length ? ` | tags: ${tags.join(', ')}` : ''}${cpes.length ? ` | ${cpes.length} CPE(s)` : ''}`,
      { status: 'info', link, raw: { ports, tags, cpes: cpes.slice(0, 20) } },
    ),
  ];
  for (const host of hostnames.slice(0, 25)) {
    rows.push(makeResult({ source, type: TYPE, status: 'info', detail: `Hostname: ${host}`, link: `https://${host}` }));
  }
  for (const cve of vulns.slice(0, 50)) {
    rows.push(
      makeResult({
        source,
        type: TYPE,
        status: 'hit',
        detail: `Known vulnerability: ${cve}`,
        link: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve)}`,
      }),
    );
  }
  return rows;
}

/* ----------------------------------------------------------------- ip-api */

async function runIpApi(ctx) {
  const source = 'ip-api.com';
  const ip = ctx.query;
  const link = `https://ip-api.com/#${ip}`;
  if (!isPublicIPv4(ip)) return privateSkip(source);

  // Free tier is HTTP-only and limited to 45 requests/minute. This runs server-side, so plain HTTP is fine.
  const res = await getJson(`http://ip-api.com/json/${ip}`, {
    timeout: 15_000,
    params: {
      fields: 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,query',
    },
  });
  const d = res.data;
  if (res.status === 429) return [errorRow(source, TYPE, 'rate limited (45 requests/min on free tier)', link)];
  if (!d || typeof d !== 'object') return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  if (d.status !== 'success') return [errorRow(source, TYPE, d.message || 'lookup failed', link)];

  const flags = [d.proxy && 'proxy/VPN', d.hosting && 'hosting/datacenter'].filter(Boolean);
  return [
    summary(source, TYPE, `Location: ${[d.city, d.regionName, d.country].filter(Boolean).join(', ')} (${d.countryCode || ''})`, {
      status: 'info',
      link,
      raw: d,
    }),
    makeResult({ source, type: TYPE, status: 'info', detail: `Network: ${d.isp || 'n/a'}${d.as ? ` | ${d.as}` : ''}` }),
    makeResult({ source, type: TYPE, status: 'info', detail: `Timezone: ${d.timezone || 'n/a'} | coords ${d.lat}, ${d.lon}` }),
    ...(flags.length
      ? [makeResult({ source, type: TYPE, status: 'hit', detail: `Flags: ${flags.join(', ')}`, link })]
      : []),
  ];
}

/* ----------------------------------------------------------------- ipwho.is */

async function runIpWhoIs(ctx) {
  const source = 'ipwho.is';
  const ip = ctx.query;
  const link = `https://ipwho.is/${ip}`;
  if (!isPublicIPv4(ip)) return privateSkip(source);

  const res = await getJson(`https://ipwho.is/${ip}`, { timeout: 15_000 });
  const d = res.data;
  if (!d || typeof d !== 'object') return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  if (d.success === false) return [errorRow(source, TYPE, d.message || 'lookup failed', link)];

  const conn = d.connection || {};
  return [
    summary(source, TYPE, `Geo: ${[d.city, d.region, d.country].filter(Boolean).join(', ')} | ${d.timezone?.id || 'tz n/a'}`, {
      status: 'info',
      link,
      raw: { city: d.city, country: d.country, isp: conn.isp, asn: conn.asn },
    }),
    makeResult({ source, type: TYPE, status: 'info', detail: `ISP: ${conn.isp || 'n/a'} | ASN ${conn.asn || 'n/a'} | org ${conn.org || 'n/a'}` }),
  ];
}

/* ------------------------------------------------------------ Reverse DNS */

async function runReverseDns(ctx) {
  const source = 'Reverse DNS';
  const ip = ctx.query;
  if (!isPublicIPv4(ip)) return privateSkip(source);
  try {
    const names = await dns.reverse(ip);
    return [
      summary(source, TYPE, `PTR record(s): ${names.join(', ')}`, { status: 'info', raw: { ptr: names } }),
    ];
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return [summary(source, TYPE, 'No PTR record (reverse DNS not configured)', { status: 'miss' })];
    }
    return [errorRow(source, TYPE, `reverse lookup failed (${err.code || err.message})`)];
  }
}

module.exports = {
  isPublicIPv4,
  runShodanInternetDb,
  runIpApi,
  runIpWhoIs,
  runReverseDns,
};
