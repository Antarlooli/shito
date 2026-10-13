'use strict';

const path = require('path');
const express = require('express');

const defaultConfig = require('./src/config');
const { detectInputType, validateForcedType, TYPES } = require('./src/detect');
const { runSearch } = require('./src/orchestrator');
const { TtlCache } = require('./src/cache');
const { createQueryLogger } = require('./src/querylog');
const { SOURCES } = require('./src/sources');

const MAX_QUERY_LENGTH = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Fixed-window per-IP limiter. Returns { allowed, retryAfterSec }. */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function check(key, now = Date.now()) {
    const windowStart = now - windowMs;
    const recent = (hits.get(key) || []).filter((t) => t > windowStart);
    if (recent.length >= max) {
      hits.set(key, recent);
      return { allowed: false, retryAfterSec: Math.ceil((recent[0] + windowMs - now) / 1000) };
    }
    recent.push(now);
    hits.set(key, recent);
    // Keep the map from growing without bound.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (!v.some((t) => t > windowStart)) hits.delete(k);
    }
    return { allowed: true, retryAfterSec: 0 };
  };
}

function createApp(config = defaultConfig, options = {}) {
  const app = express();
  const cache = options.cache || new TtlCache({ ttlMs: config.cacheTtlMs });
  const logQuery = options.logQuery || createQueryLogger(config.logFile);
  const rateLimit = createRateLimiter(config.rateLimit);

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // Baseline hardening. No X-Frame-Options or frame-ancestors: the console is previewed in an iframe.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  app.use(express.json({ limit: '2kb' }));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', sources: SOURCES.length });
  });

  app.get('/api/sources', (req, res) => {
    res.json({
      types: TYPES,
      sources: SOURCES.map((s) => ({ id: s.id, name: s.name, types: s.types })),
    });
  });

  app.post('/api/search', async (req, res) => {
    const verdict = rateLimit(req.ip || 'unknown');
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSec));
      return res.status(429).json({ error: `Rate limit reached. Retry in ${verdict.retryAfterSec}s.` });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawQuery = typeof body.query === 'string' ? body.query : '';
    const trimmed = rawQuery.trim();
    if (!trimmed) return res.status(400).json({ error: 'Query is required.' });
    if (trimmed.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer.` });
    }
    if (CONTROL_CHARS.test(trimmed)) {
      return res.status(400).json({ error: 'Query contains control characters.' });
    }

    let query;
    let type;
    let candidates = [];
    const forced = typeof body.type === 'string' && body.type !== 'auto' ? body.type : null;
    if (forced) {
      query = validateForcedType(forced, trimmed);
      if (!query) {
        return res.status(400).json({ error: `"${trimmed}" is not a valid ${forced}.` });
      }
      type = forced;
      candidates = [forced];
    } else {
      const detected = detectInputType(trimmed);
      if (!detected.type) {
        return res.status(400).json({
          error: 'Could not detect input type. Try an email, phone, IP, domain, username or full name.',
        });
      }
      query = detected.query;
      type = detected.type;
      candidates = detected.candidates;
    }

    try {
      const result = await runSearch({ query, type, config, cache });
      // Local query log, required by the on-page disclaimer. Never blocks the response.
      logQuery({
        ip: req.ip,
        query,
        type,
        forced: Boolean(forced),
        durationMs: result.durationMs,
        stats: result.stats,
      });
      res.json({
        query,
        type,
        candidates,
        durationMs: result.durationMs,
        stats: result.stats,
        sources: result.sources,
        results: result.results,
      });
    } catch (err) {
      console.error('[search] unexpected failure:', err);
      res.status(500).json({ error: 'Search failed unexpectedly. Check the server log.' });
    }
  });

  // Static frontend.
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));

  // JSON error handler, including malformed JSON bodies.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (req.path.startsWith('/api/')) {
      return res.status(status >= 400 && status < 500 ? status : 500).json({
        error: status >= 400 && status < 500 ? 'Malformed request.' : 'Internal error.',
      });
    }
    return res.status(status).send('Not found');
  });

  return app;
}

if (require.main === module) {
  const app = createApp(defaultConfig);
  app.listen(defaultConfig.port, defaultConfig.host, () => {
    console.log(`OSINT Recon Console listening on http://${defaultConfig.host}:${defaultConfig.port}`);
    console.log(`Query log: ${defaultConfig.logFile}`);
  });
}

module.exports = { createApp, createRateLimiter, MAX_QUERY_LENGTH };
