'use strict';

const { makeResult } = require('../result');

/**
 * Deep-link pivots: manual next steps for each input type. Needs no keys and makes
 * no outbound requests. `{q}` is replaced with the URL-encoded query.
 * Exact-match engine links wrap the query in literal %22 quotes in the template.
 */
const PIVOTS = {
  username: [
    { label: 'Google exact-match search', url: 'https://www.google.com/search?q=%22{q}%22' },
    { label: 'DuckDuckGo exact-match search', url: 'https://duckduckgo.com/?q=%22{q}%22' },
    { label: 'GitHub user profile', url: 'https://github.com/{q}' },
    { label: 'Reddit user profile', url: 'https://www.reddit.com/user/{q}' },
  ],
  email: [
    { label: 'Google exact-match search', url: 'https://www.google.com/search?q=%22{q}%22' },
    { label: 'DuckDuckGo exact-match search', url: 'https://duckduckgo.com/?q=%22{q}%22' },
    { label: 'Have I Been Pwned (web lookup)', url: 'https://haveibeenpwned.com/account/{q}' },
    { label: 'Epieos email pivot', url: 'https://epieos.com/?q={q}&type=email' },
  ],
  phone: [
    { label: 'Google exact-match search', url: 'https://www.google.com/search?q=%22{q}%22' },
    { label: 'DuckDuckGo exact-match search', url: 'https://duckduckgo.com/?q=%22{q}%22' },
    // SearchPhone is a standalone Python script needing its own API keys, so it is linked rather than run.
    { label: 'SearchPhone toolkit (run locally with your own keys)', url: 'https://github.com/HackUnderway/SearchPhone' },
  ],
  ip: [
    { label: 'Shodan host page', url: 'https://www.shodan.io/host/{q}' },
    { label: 'Censys host page', url: 'https://search.censys.io/hosts/{q}' },
    { label: 'VirusTotal IP report', url: 'https://www.virustotal.com/gui/ip-address/{q}' },
    { label: 'AlienVault OTX indicator', url: 'https://otx.alienvault.com/indicator/ip/{q}' },
    { label: 'bgp.he.net routing info', url: 'https://bgp.he.net/ip/{q}' },
  ],
  domain: [
    { label: 'VirusTotal domain report', url: 'https://www.virustotal.com/gui/domain/{q}' },
    { label: 'Wayback Machine snapshots', url: 'https://web.archive.org/web/*/{q}' },
    { label: 'urlscan.io search', url: 'https://urlscan.io/search/#domain:{q}' },
    { label: 'SecurityTrails DNS history', url: 'https://securitytrails.com/domain/{q}/dns' },
    { label: 'AlienVault OTX indicator', url: 'https://otx.alienvault.com/indicator/domain/{q}' },
  ],
  name: [
    { label: 'Google exact-match search', url: 'https://www.google.com/search?q=%22{q}%22' },
    { label: 'DuckDuckGo exact-match search', url: 'https://duckduckgo.com/?q=%22{q}%22' },
    { label: 'LinkedIn people search', url: 'https://www.linkedin.com/search/results/people/?keywords={q}' },
    { label: 'Wikipedia search', url: 'https://en.wikipedia.org/w/index.php?search={q}' },
    { label: 'Google News search', url: 'https://news.google.com/search?q={q}' },
  ],
};

/** Curated directories from the spec's meta-resources list. Shown for every query. */
const META_RESOURCES = [
  { label: 'Awesome OSINT: curated tool directory', url: 'https://github.com/jivoi/awesome-osint' },
  { label: 'OSINT Hub: self-hosted dashboard, ~40 integrated tools', url: 'https://github.com/asdatarius/osint-hub' },
  { label: 'osint-mcp: 94 OSINT tools via one MCP server', url: 'https://github.com/bob-reis/osint-mcp' },
];

function fillTemplate(template, query) {
  return template.split('{q}').join(encodeURIComponent(query));
}

/** Builds the pivot + meta rows for a query. Pure function, no I/O. */
function buildPivotRows(type, query) {
  const pivots = PIVOTS[type] || [];
  const rows = pivots.map((p) =>
    makeResult({
      source: 'Pivot Links',
      type,
      status: 'info',
      detail: p.label,
      link: fillTemplate(p.url, query),
    }),
  );
  for (const meta of META_RESOURCES) {
    rows.push(
      makeResult({
        source: 'Meta Catalog',
        type,
        status: 'info',
        detail: meta.label,
        link: meta.url,
      }),
    );
  }
  return rows;
}

async function runPivots(ctx) {
  return buildPivotRows(ctx.type, ctx.query);
}

module.exports = { PIVOTS, META_RESOURCES, buildPivotRows, fillTemplate, runPivots };
