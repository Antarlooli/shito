# OSINT Recon Console

A hacker-themed, single-page OSINT research console. Type one identifier (name, username,
email, phone, IP or domain) into the centred search box. The backend detects the type,
queries the applicable free OSINT sources in parallel, and renders the normalised results
in a link-rich table.

> **For educational and authorised use only.** Every search is written to a local log file
> (`data/queries.log`). Only search for identifiers you are authorised to investigate, and
> respect each upstream service's terms of use and rate limits.

## Quick start

```bash
cd osint-recon
npm install
npm start                       # http://localhost:3000
```

Searches work without any extra setup, but the Python-based sources (Sherlock, Maigret,
Holehe, NebulaOSINT) only run when their CLIs are on `PATH`. Those sources otherwise show a
"Not installed" row.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install sherlock-project maigret holehe "httpx[http2]>=0.27,<0.28"
pip install https://codeload.github.com/ismailtsdln/NebulaOSINT/tar.gz/refs/heads/main
```

To load settings from a file, copy `.env.example` to `.env` and run
`node --env-file=.env server.js` (Node 20.6+).

### Docker

```bash
docker build -t osint-recon .
docker run --rm -p 3000:3000 --env-file .env -v "$PWD/data:/app/data" osint-recon
```

The image contains Node 20 and the Python CLIs in a venv. It runs as a non-root user and
includes a health check on `/api/health`.

## How it works

```
Browser ──POST /api/search {query, type?}──► Express
                                            │
                                 detectInputType()  (regex table, priority-ordered)
                                            │
                              runSearch(): Promise.allSettled over applicable sources
                 ┌──────────────┬───────────┴──────────┬───────────────┐
           username sources  email sources       ip / domain    phone / pivots
           (CLI + HTTP)      (CLI + HTTP + DNS)  (HTTP + DNS)    (local + links)
                                            │
                 normalised rows: {source, type, detail, link, raw, status}
                                            │
                                  JSON response ──► table (textContent only)
```

- **Isolation.** Each source has its own timeout. A failure, timeout or missing dependency
  becomes an `error` or `skipped` row. It never fails the whole search.
- **Statuses.** `hit` = found, `miss` = checked with no result, `info` = context,
  `error` = failed, `skipped` = not run (missing key or CLI, or private IP).
- **Input detection.** Patterns overlap, for example `example.com` also matches the username
  pattern. Detection uses a priority order and returns the other matches as `candidates`.
  The UI shows them, and the MODE selector overrides auto-detection.
- **Safety.** Queries are length-limited and checked for control characters. Outbound
  requests only use fixed hosts with encoded parameters. Result links must be http(s). The
  UI uses `textContent` only. Sources are rate-limited per client IP.

## Sources

| Type | Source | Access | Status |
|---|---|---|---|
| username | Sherlock | CLI (`pip install sherlock-project`) | integrated |
| username | Maigret | CLI (`pip install maigret`), top N sites | integrated |
| username | WhatsMyName | JSON site definitions checked directly | integrated |
| username | NebulaOSINT | CLI (`pip install` from GitHub) | integrated |
| email | Holehe | CLI (`pip install holehe`), password-reset flows | integrated |
| email | XposedOrNot | free, keyless API | integrated |
| email | Have I Been Pwned | `HIBP_API_KEY` (paid v3 key) | integrated, needs key |
| email | Gravatar | keyless JSON profile (SHA256, MD5 fallback) | integrated |
| email | Hudson Rock | keyless community API | integrated |
| email | DNS MX | local DNS, detects null-MX domains | integrated |
| email, username | LeakCheck | keyless public API, or `LEAKCHECK_API_KEY` for Pro v2 | integrated |
| phone | libphonenumber | local parsing, no network | integrated |
| phone | Numverify | `NUMVERIFY_API_KEY` (100 req/month free) | integrated, needs key |
| phone | PhoneInfoga | `PHONEINFOGA_URL` (`phoneinfoga serve`) | integrated, needs service |
| phone | SearchPhone | standalone script with its own keys | link only |
| ip | Shodan InternetDB | keyless | integrated |
| ip | ip-api.com | keyless, 45 req/min, cached 10 min | integrated |
| ip | ipwho.is | keyless | integrated |
| ip | Reverse DNS | local DNS | integrated |
| domain | RDAP (rdap.org) | keyless | integrated |
| domain | crt.sh | keyless, certificate transparency | integrated |
| domain | DNS records | local DNS (A, AAAA, MX, NS, TXT) | integrated |
| all | Pivot links + Awesome OSINT, OSINT Hub, osint-mcp | static deep links | integrated |

## Configuration

Every variable is optional. See `.env.example` for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Listen address |
| `HIBP_API_KEY` | | Enables Have I Been Pwned |
| `LEAKCHECK_API_KEY` | | Uses the Pro API v2 instead of the public API |
| `NUMVERIFY_API_KEY` | | Enables Numverify |
| `PHONEINFOGA_URL` | | e.g. `http://phoneinfoga:5000` |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | `10`, `60000` | Searches per client IP per window |
| `SOURCE_TIMEOUT_MS` | `25000` | Default per-source timeout |
| `CLI_TIMEOUT_MS` | `240000` | Timeout for each Python CLI |
| `SHERLOCK_LOCAL` | `1` | Use Sherlock's bundled site data. Set `0` to download the latest data |
| `MAIGRET_TOP_SITES` | `100` | Sites checked by Maigret (its own default is 500) |
| `WMN_CONCURRENCY`, `WMN_BUDGET_MS` | `25`, `90000` | WhatsMyName parallelism and total time budget |
| `CACHE_TTL_MS` | `600000` | Cache for rate-limited sources |
| `DEFAULT_COUNTRY` | `US` | Country for parsing national-format phone numbers |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `LOG_FILE`, `DATA_DIR` | `data/queries.log`, `data/` | Local paths |

## API reference

`POST /api/search` with body `{ "query": "...", "type": "auto" }` (`type` is optional:
`email`, `phone`, `ip`, `domain`, `username`, `name`).

Response:

```json
{
  "query": "test@example.com",
  "type": "email",
  "candidates": ["email"],
  "durationMs": 435,
  "stats": { "hits": 2, "misses": 1, "errors": 3, "sourcesOk": 3, "sourcesFailed": 3, "sourcesSkipped": 1 },
  "sources": [{ "id": "holehe", "name": "Holehe", "status": "ok", "rows": 2, "ms": 434, "cached": false }],
  "results": [
    { "source": "Holehe", "type": "email", "detail": "Email registered on twitter.com",
      "link": "https://twitter.com/", "raw": { "name": "twitter.com" }, "status": "hit" }
  ]
}
```

Other endpoints: `GET /api/health`, `GET /api/sources`.

Errors: `400` for invalid or undetectable input, `429` when rate-limited (with `Retry-After`),
`500` for unexpected failures.

## Project layout

```
osint-recon/
  server.js              Express app: /api/search, static UI, rate limit, query log
  src/
    detect.js            Input type detection (regex table + priority + candidates)
    orchestrator.js      Parallel fan-out with timeouts, normalisation, stats
    config.js            Environment-driven configuration
    result.js            Normalised result shape and URL safety
    cli.js               Child-process runner with hard timeout and ENOENT detection
    http.js              Shared axios client (never throws on HTTP status)
    cache.js             TTL cache for rate-limited APIs
    querylog.js          Local JSON-lines query log
    sources/             One module per input family, plus the source registry
  public/                index.html, style.css, script.js (vanilla, no build step)
  tests/                 node:test suites (detection, parsers, CLI wrappers, HTTP, e2e)
  Dockerfile
```

## Tests

```bash
npm test
```

The suites use `node:test` and need no network access. External CLIs are replaced with
small fake scripts, the WhatsMyName checker runs against a local HTTP server, and the
end-to-end tests use only non-network sources.

## Notes and limitations

- **Keyed and paid services.** Have I Been Pwned's `breachedaccount` endpoint needs a paid
  v3 key, and Numverify needs a free key. Both are off unless configured.
- **Run time.** Username searches run Sherlock, Maigret, WhatsMyName and NebulaOSINT at the
  same time. Expect 30 seconds to a few minutes.
- **Upstream changes.** Free OSINT services change their endpoints and response formats
  often. Parsers are defensive, and a changed format usually shows as an `error` row.
- **Sherlock and Maigret data.** Both pull site data from their upstream projects at run
  time. Outbound access to those hosts is required for full results.
- **Name searches** only generate deep links. There is no reliable free, keyless name lookup
  API, so the console does not pretend to have one.
- **Template credit.** The visual style is inspired by the CC0-licensed
  [thelearn-tech/hacker-theme](https://github.com/thelearn-tech/hacker-theme). The CSS is
  written from scratch, so the page has no external CDN dependencies.
- **Third-party tools and datasets** (Sherlock, Maigret, Holehe, NebulaOSINT, WhatsMyName)
  keep their own licences. Check them before redistributing.
