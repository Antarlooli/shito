# OSINT Recon Console: one container serves the static UI and runs the OSINT orchestrator.
#
# Base image: Debian slim rather than Alpine. The Python OSINT CLIs (Maigret, Sherlock, Holehe)
# pull in packages with native wheels that are slow or fail to build on musl.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Python CLIs in an isolated venv. These are wrapped as child processes by the backend.
RUN python3 -m venv /opt/osint-venv
ENV PATH="/opt/osint-venv/bin:${PATH}"
# httpx is pinned: NebulaOSINT 0.1.0 needs httpx<0.28 (AsyncClient "proxies" argument and the h2 extra).
RUN pip install --no-cache-dir sherlock-project maigret holehe "httpx[http2]>=0.27,<0.28" \
 && (pip install --no-cache-dir "https://codeload.github.com/ismailtsdln/NebulaOSINT/tar.gz/refs/heads/main" \
     || echo "WARNING: NebulaOSINT failed to install; its source will report 'not installed'")

WORKDIR /app

# Node dependencies first, for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Bake in the WhatsMyName dataset so the first search does not need outbound access to GitHub.
# If the download fails, the app fetches it on first use instead.
RUN mkdir -p /app/data \
 && (curl -fsSL https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json -o /app/data/wmn-data.json \
     || echo "WARNING: could not pre-fetch wmn-data.json; it will be downloaded at first use")

# Run as an unprivileged user. Only /app/data needs to be writable (query log, WhatsMyName cache).
RUN useradd --create-home --uid 10001 app \
 && chown -R app:app /app/data
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
