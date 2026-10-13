'use strict';

/**
 * Source registry. Each entry declares which input types it handles and how long it may run.
 * `timeoutMs` may be a number or a function of the config (CLI-based sources depend on config).
 */

const username = require('./username');
const email = require('./email');
const leakcheck = require('./leakcheck');
const phone = require('./phone');
const ip = require('./ip');
const domain = require('./domain');
const pivots = require('./pivots');

const SOURCES = [
  // Username enumeration
  { id: 'sherlock', name: 'Sherlock', types: ['username'], run: username.runSherlock, timeoutMs: (c) => c.cliTimeoutMs + 30_000 },
  { id: 'maigret', name: 'Maigret', types: ['username'], run: username.runMaigret, timeoutMs: (c) => c.cliTimeoutMs + 30_000 },
  { id: 'whatsmyname', name: 'WhatsMyName', types: ['username'], run: username.runWhatsMyName, timeoutMs: (c) => c.wmn.budgetMs + 60_000 },
  { id: 'nebula', name: 'NebulaOSINT', types: ['username'], run: username.runNebula, timeoutMs: (c) => c.cliTimeoutMs + 30_000 },

  // Email intelligence
  { id: 'holehe', name: 'Holehe', types: ['email'], run: email.runHolehe, timeoutMs: (c) => c.cliTimeoutMs + 30_000 },
  { id: 'xposedornot', name: 'XposedOrNot', types: ['email'], run: email.runXposedOrNot },
  { id: 'hibp', name: 'Have I Been Pwned', types: ['email'], run: email.runHibp },
  { id: 'gravatar', name: 'Gravatar', types: ['email'], run: email.runGravatar },
  { id: 'hudsonrock', name: 'Hudson Rock', types: ['email'], run: email.runHudsonRock },
  { id: 'email-mx', name: 'DNS MX', types: ['email'], run: email.runEmailMx },

  // Breach / leak data (email and username)
  { id: 'leakcheck', name: 'LeakCheck', types: ['email', 'username'], run: leakcheck.runLeakCheck },

  // Phone
  { id: 'libphonenumber', name: 'libphonenumber', types: ['phone'], run: phone.runLibphonenumber },
  { id: 'numverify', name: 'Numverify', types: ['phone'], run: phone.runNumverify },
  { id: 'phoneinfoga', name: 'PhoneInfoga', types: ['phone'], run: phone.runPhoneInfoga, timeoutMs: 75_000 },

  // IP address
  { id: 'shodan-internetdb', name: 'Shodan InternetDB', types: ['ip'], run: ip.runShodanInternetDb },
  { id: 'ip-api', name: 'ip-api.com', types: ['ip'], run: ip.runIpApi, cacheable: true },
  { id: 'ipwhois', name: 'ipwho.is', types: ['ip'], run: ip.runIpWhoIs, cacheable: true },
  { id: 'reverse-dns', name: 'Reverse DNS', types: ['ip'], run: ip.runReverseDns },

  // Domain
  { id: 'rdap', name: 'RDAP / WHOIS', types: ['domain'], run: domain.runRdap },
  { id: 'crtsh', name: 'crt.sh', types: ['domain'], run: domain.runCrtSh, timeoutMs: 60_000 },
  { id: 'dns', name: 'DNS records', types: ['domain'], run: domain.runDnsRecords },

  // Pivots and meta-catalog links (every input type; no network calls)
  { id: 'pivots', name: 'Pivot Links', types: ['username', 'email', 'phone', 'ip', 'domain', 'name'], run: pivots.runPivots },
];

module.exports = { SOURCES };
