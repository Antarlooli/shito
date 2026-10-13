'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { getJson } = require('../http');
const { makeResult } = require('../result');
const { notConfigured, summary, errorRow } = require('./helpers');

const TYPE = 'phone';

/** Parses the number locally with libphonenumber. No key, no network. */
async function runLibphonenumber(ctx) {
  const source = 'libphonenumber';
  const link = 'https://github.com/catamphetamine/libphonenumber-js';
  const phone = parsePhoneNumberFromString(ctx.query, ctx.config.defaultCountry);
  if (!phone || !phone.isValid()) {
    return [
      summary(source, TYPE, `Not a valid phone number (parsed with default country ${ctx.config.defaultCountry}; use +<country code>)`, {
        status: 'miss',
        link,
      }),
    ];
  }
  const kind = phone.getType() || 'UNKNOWN';
  const rows = [
    summary(source, TYPE, `Valid ${kind.toLowerCase().replace('_', ' ')} number in ${phone.country || 'unknown country'}`, {
      status: 'info',
      link,
      raw: { e164: phone.number, country: phone.country, type: kind },
    }),
    makeResult({ source, type: TYPE, status: 'info', detail: `E.164: ${phone.number}`, raw: { e164: phone.number } }),
    makeResult({ source, type: TYPE, status: 'info', detail: `International: ${phone.formatInternational()}` }),
    makeResult({ source, type: TYPE, status: 'info', detail: `Country: ${phone.country || 'n/a'} (+${phone.countryCallingCode})` }),
    makeResult({
      source: 'WhatsApp',
      type: TYPE,
      status: 'info',
      detail: 'Click-to-chat link (opens WhatsApp for this number; manual check only)',
      link: `https://wa.me/${phone.number.replace('+', '')}`,
    }),
  ];
  return rows;
}

/** Numverify (apilayer) validation. Free plan: 100 requests/month, key required. */
async function runNumverify(ctx) {
  const source = 'Numverify';
  const link = 'https://numverify.com/';
  const { config } = ctx;
  if (!config.keys.numverify) return [notConfigured(source, TYPE, 'NUMVERIFY_API_KEY', link)];

  const digits = ctx.query.replace(/\D/g, '');
  const res = await getJson('http://apilayer.net/api/validate', {
    timeout: 15_000,
    params: { access_key: config.keys.numverify, number: digits },
  });
  const data = res.data && typeof res.data === 'object' ? res.data : null;
  if (!data) return [errorRow(source, TYPE, `unexpected response (HTTP ${res.status})`, link)];
  if (data.success === false || data.error) {
    return [errorRow(source, TYPE, data.error?.info || data.error?.type || `request rejected (HTTP ${res.status})`, link)];
  }
  if (!data.valid) return [summary(source, TYPE, 'Numverify: number not valid', { status: 'miss', link })];

  return [
    summary(
      source,
      TYPE,
      `Numverify: valid ${data.line_type || 'line'} in ${data.country_name || data.country_code || 'unknown'}` +
        (data.carrier ? `, carrier ${data.carrier}` : ''),
      { status: 'info', link, raw: { carrier: data.carrier, line_type: data.line_type, location: data.location } },
    ),
  ];
}

/**
 * PhoneInfoga, run as its REST server (`phoneinfoga serve`), local scanner endpoint.
 * The response is free-form, so the summary lists which scanner sections returned data.
 */
async function runPhoneInfoga(ctx) {
  const source = 'PhoneInfoga';
  const link = 'https://github.com/sundowndev/phoneinfoga';
  const { config } = ctx;
  if (!config.phoneinfogaUrl) return [notConfigured(source, TYPE, 'PHONEINFOGA_URL (e.g. http://phoneinfoga:5000)', link)];

  const number = `+${ctx.query.replace(/\D/g, '')}`;
  const url = `${config.phoneinfogaUrl}/api/numbers/${encodeURIComponent(number)}/scan/local`;
  const res = await getJson(url, { timeout: 60_000 });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    return [errorRow(source, TYPE, `PhoneInfoga returned HTTP ${res.status}`, link)];
  }
  const sections = Object.entries(res.data)
    .filter(([, v]) => v && (typeof v !== 'object' || Object.keys(v).length > 0))
    .map(([k]) => k);
  return [
    summary(source, TYPE, `Local scan complete; sections with data: ${sections.join(', ') || 'none'}`, {
      status: sections.length ? 'info' : 'miss',
      link,
      raw: res.data,
    }),
  ];
}

module.exports = { runLibphonenumber, runNumverify, runPhoneInfoga };
