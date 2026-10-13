'use strict';

const path = require('path');

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const env = process.env;

const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',

  // Per-IP limit on POST /api/search. Each search fans out to many external services.
  rateLimit: {
    windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: int(env.RATE_LIMIT_MAX, 10),
  },

  // Default timeout for a single source. Individual sources can override this.
  sourceTimeoutMs: int(env.SOURCE_TIMEOUT_MS, 25_000),

  // Results are cached per (source, query) for this long. Only successful lookups are cached.
  cacheTtlMs: int(env.CACHE_TTL_MS, 10 * 60_000),

  // Local query log (JSON lines). Required by the on-page disclaimer.
  logFile: env.LOG_FILE || path.join(__dirname, '..', 'data', 'queries.log'),

  // Data directory for downloaded datasets (WhatsMyName) and logs.
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Optional external CLIs. Each is looked up on PATH unless overridden.
  bins: {
    sherlock: env.SHERLOCK_BIN || 'sherlock',
    maigret: env.MAIGRET_BIN || 'maigret',
    holehe: env.HOLEHE_BIN || 'holehe',
    nebula: env.NEBULA_BIN || 'nebula',
  },
  cliTimeoutMs: int(env.CLI_TIMEOUT_MS, 240_000),
  sherlockTimeoutSec: int(env.SHERLOCK_TIMEOUT_SEC, 10),
  maigretTopSites: int(env.MAIGRET_TOP_SITES, 100),

  // WhatsMyName site definitions.
  wmn: {
    dataPath: env.WMN_DATA_PATH || path.join(env.DATA_DIR || path.join(__dirname, '..', 'data'), 'wmn-data.json'),
    dataUrl: env.WMN_DATA_URL || 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json',
    concurrency: int(env.WMN_CONCURRENCY, 25),
    requestTimeoutMs: int(env.WMN_REQUEST_TIMEOUT_MS, 8_000),
    budgetMs: int(env.WMN_BUDGET_MS, 90_000),
  },

  // Optional keys. Sources that need one report "not configured" when it is absent.
  keys: {
    hibp: env.HIBP_API_KEY || '',
    leakcheck: env.LEAKCHECK_API_KEY || '',
    numverify: env.NUMVERIFY_API_KEY || '',
  },
  phoneinfogaUrl: (env.PHONEINFOGA_URL || '').replace(/\/+$/, ''),
  defaultCountry: (env.DEFAULT_COUNTRY || 'US').toUpperCase(),
};

module.exports = config;
