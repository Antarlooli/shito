/* OSINT Recon Console: frontend.
 * Vanilla JS. All server data is inserted with textContent, never innerHTML.
 */
(function () {
  'use strict';

  const MAX_QUERY = 200;
  const REQUEST_TIMEOUT_MS = 6 * 60 * 1000; // server-side budget is a few minutes for username scans
  const BAR_CELLS = 10;
  const TAG = { hit: '[+]', miss: '[-]', info: '[*]', error: '[!]', skipped: '[~]' };
  const TYPE_LABEL = {
    email: 'email', phone: 'phone', ip: 'ip', domain: 'domain', username: 'username', name: 'name',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('search-form'),
    query: $('query'),
    mode: $('mode'),
    execute: $('execute'),
    formError: $('form-error'),
    formHint: $('form-hint'),
    boot: $('boot'),
    results: $('results'),
    loader: $('loader'),
    spinner: $('spinner'),
    loaderNote: $('loader-note'),
    summary: $('summary'),
    toolbar: $('toolbar'),
    filter: $('filter'),
    exportBtn: $('export'),
    tableWrap: $('table-wrap'),
    rows: $('rows'),
    noRows: $('no-rows'),
    sourcesPanel: $('sources-panel'),
    sourcesList: $('sources-list'),
  };

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastResponse = null;
  let spinnerTimer = null;
  let busy = false;

  /* ------------------------------------------------------------- boot text */

  // Each entry is typed out character by character. Lines ending in "[OK]" are status lines.
  const BOOT_LINES = [
    '> initializing recon core ........ [OK]',
    '> loading source adapters ........ [OK]',
    '> awaiting target_',
  ];

  function typeBoot() {
    if (reducedMotion) {
      els.boot.textContent = BOOT_LINES.join('\n');
      return;
    }
    let line = 0;
    let char = 0;
    let text = '';
    const tick = () => {
      if (line >= BOOT_LINES.length) return;
      const current = BOOT_LINES[line];
      text += current[char];
      char += 1;
      els.boot.textContent = text;
      if (char >= current.length) {
        if (line < BOOT_LINES.length - 1) text += '\n';
        line += 1;
        char = 0;
        setTimeout(tick, 220);
        return;
      }
      setTimeout(tick, 16);
    };
    tick();
  }

  /* ----------------------------------------------------------- spinner UI */

  function spinnerFrame(frame, elapsedSec) {
    const filled = frame % (BAR_CELLS + 1);
    const bar = '■'.repeat(filled) + '□'.repeat(BAR_CELLS - filled);
    const dots = '.'.repeat((frame % 4));
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const ss = String(elapsedSec % 60).padStart(2, '0');
    return `[${bar}] SCANNING${dots.padEnd(3, ' ')} T+${mm}:${ss}`;
  }

  function startSpinner() {
    stopSpinner();
    const started = Date.now();
    let frame = 0;
    const paint = () => {
      els.spinner.textContent = spinnerFrame(frame, Math.floor((Date.now() - started) / 1000));
      frame += 1;
    };
    paint();
    spinnerTimer = setInterval(paint, reducedMotion ? 800 : 140);
  }

  function stopSpinner() {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = null;
  }

  /* ----------------------------------------------------------- UI helpers */

  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = !message;
  }

  function setBusy(state) {
    busy = state;
    els.execute.disabled = state;
    els.execute.textContent = state ? '> SCANNING' : '> EXECUTE';
    els.query.readOnly = state;
  }

  function showResultsPanel() {
    els.results.hidden = false;
  }

  function resetResults() {
    els.summary.hidden = true;
    els.summary.textContent = '';
    els.summary.classList.remove('error-text');
    els.toolbar.hidden = true;
    els.tableWrap.hidden = true;
    els.rows.textContent = '';
    els.noRows.hidden = true;
    els.sourcesPanel.hidden = true;
    els.sourcesList.textContent = '';
    els.filter.value = '';
  }

  function sanitizeFileName(text) {
    return String(text).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'query';
  }

  function linkDisplay(url) {
    try {
      const u = new URL(url);
      const path = u.pathname === '/' ? '' : u.pathname;
      const text = `${u.host}${path}${u.search}`;
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    } catch {
      return url;
    }
  }

  function safeHref(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- rendering */

  function renderRow(row, index) {
    const tr = document.createElement('tr');
    const status = row.status || 'info';
    tr.className = `row-${status} row-in`;
    tr.style.setProperty('--d', `${Math.min(index * 28, 1600)}ms`);

    const tdSource = document.createElement('td');
    tdSource.className = 'cell-source';
    tdSource.textContent = row.source || '';

    const tdType = document.createElement('td');
    tdType.className = 'cell-type';
    tdType.textContent = TYPE_LABEL[row.type] || row.type || '';

    const tdDetail = document.createElement('td');
    tdDetail.className = 'cell-detail';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = TAG[status] || '[*]';
    tdDetail.appendChild(tag);
    tdDetail.appendChild(document.createTextNode(row.detail || ''));

    const tdLink = document.createElement('td');
    tdLink.className = 'cell-link';
    const href = row.link ? safeHref(row.link) : null;
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = linkDisplay(href);
      a.title = href;
      tdLink.appendChild(a);
    } else {
      tdLink.textContent = '-';
    }

    tr.append(tdSource, tdType, tdDetail, tdLink);
    return tr;
  }

  function renderSummary(data) {
    const s = data.stats || {};
    const secs = ((data.durationMs || 0) / 1000).toFixed(1);
    const parts = [
      `TARGET: ${data.query}`,
      `TYPE: ${String(data.type).toUpperCase()}`,
      `HITS: ${s.hits ?? 0}`,
      `SOURCES: ${s.sourcesOk ?? 0} ok / ${s.sourcesFailed ?? 0} failed / ${s.sourcesSkipped ?? 0} skipped`,
      `TIME: ${secs}s`,
    ];
    if (Array.isArray(data.candidates) && data.candidates.length > 1) {
      parts.push(`ALSO MATCHES: ${data.candidates.slice(1).join(', ')} (use MODE to override)`);
    }
    els.summary.textContent = parts.join('  |  ');
    els.summary.hidden = false;
  }

  function renderSources(sources) {
    els.sourcesList.textContent = '';
    for (const src of sources || []) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${src.name}: `;
      const state = document.createElement('span');
      const cls = src.status === 'ok' ? (src.cached ? 's-cached' : 's-ok') : src.status === 'error' ? 's-error' : 's-skipped';
      state.className = cls;
      state.textContent = `${src.status.toUpperCase()}${src.cached ? ' (cached)' : ''} (${src.rows} row${src.rows === 1 ? '' : 's'}, ${(src.ms / 1000).toFixed(1)}s)`;
      li.append(label, state);
      els.sourcesList.appendChild(li);
    }
    els.sourcesPanel.hidden = !(sources && sources.length);
  }

  function applyFilter() {
    const needle = els.filter.value.trim().toLowerCase();
    let visible = 0;
    for (const tr of els.rows.children) {
      const show = !needle || tr.textContent.toLowerCase().includes(needle);
      tr.hidden = !show;
      if (show) visible += 1;
    }
    els.noRows.hidden = visible > 0;
  }

  function renderResults(data) {
    lastResponse = data;
    resetResults();
    renderSummary(data);
    const rows = Array.isArray(data.results) ? data.results : [];
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => frag.appendChild(renderRow(row, i)));
    els.rows.appendChild(frag);
    els.tableWrap.hidden = false;
    els.toolbar.hidden = false;
    renderSources(data.sources);
    applyFilter();
  }

  function renderFailure(message) {
    resetResults();
    lastResponse = null;
    els.summary.textContent = `ERROR: ${message}`;
    els.summary.hidden = false;
    els.summary.classList.add('error-text');
    // Keep an error row inside the table so the failure is visible in the same place as results.
    els.rows.appendChild(renderRow({ source: 'Console', type: '-', detail: message, status: 'error' }, 0));
    els.tableWrap.hidden = false;
  }

  /* ----------------------------------------------------------- search flow */

  async function runSearch(query, mode) {
    setBusy(true);
    showFormError('');
    showResultsPanel();
    resetResults();
    els.loader.hidden = false;
    els.loaderNote.textContent = 'Querying sources in parallel. Username searches can take up to a few minutes.';
    startSpinner();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, type: mode }),
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        throw new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
      }
      renderResults(data);
      els.formHint.textContent = `Last scan: ${data.query} (${data.type}). Results are sorted by source.`;
    } catch (err) {
      const message = err.name === 'AbortError'
        ? 'Request timed out in the browser. The server may still be running; try again or narrow the query.'
        : err.message || 'Network error';
      renderFailure(message);
    } finally {
      clearTimeout(abortTimer);
      stopSpinner();
      els.loader.hidden = true;
      setBusy(false);
    }
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const query = els.query.value.trim();
    if (!query) {
      showFormError('Enter a target: name, email, username, phone, IP or domain.');
      els.query.focus();
      return;
    }
    if (query.length > MAX_QUERY) {
      showFormError(`Target must be ${MAX_QUERY} characters or fewer.`);
      return;
    }
    runSearch(query, els.mode.value);
  });

  els.filter.addEventListener('input', applyFilter);

  els.exportBtn.addEventListener('click', () => {
    if (!lastResponse) return;
    const blob = new Blob([JSON.stringify(lastResponse, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recon-${sanitizeFileName(lastResponse.query)}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  typeBoot();
})();
