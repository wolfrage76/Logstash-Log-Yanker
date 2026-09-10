/**
 * Content script (isolated world). Owns the captured row buffer and builds
 * and saves the CSV.
 *
 * Rows arrive from the interceptor (MAIN world), which watches Kibana's own
 * search traffic. On demand, `fetchAll` replays the last captured search
 * request with `search_after` pagination to pull the *entire* result set —
 * every field, raw values, not just the page Kibana happened to load.
 *
 * The buffer lives here rather than in the popup because the popup is torn
 * down every time it closes, and here rather than in the service worker
 * because that lets the download reuse the page's own long-lived context.
 */
(() => {
  const NS = globalThis.__KLE__;
  if (!NS || !NS.parse || !NS.csv) return;
  if (NS.contentInstalled) return;
  NS.contentInstalled = true;

  const { parse, csv } = NS;
  const CHANNEL = 'kibana-log-exporter';

  const DEFAULTS = {
    bom: true,
    guardFormulas: true,
    filenamePrefix: 'kibana-logs'
  };

  const DELIMITER = ',';
  /** Hard result cap: every fetch pulls at most this many documents. */
  const MAX_ROWS = 500;
  const BUCKET_MS = 2000;
  const BUCKET_COUNT = 40;

  const state = {
    rows: [],
    rowKeys: [],
    keys: new Set(),
    fields: [],
    fieldSet: new Set(),
    fieldCounts: new Map(),
    fieldPresence: new Map(),
    kibana: false,
    sawNetwork: false,
    lastCaptureAt: 0,
    buckets: new Array(BUCKET_COUNT).fill(0),
    bucketAt: Math.floor(Date.now() / BUCKET_MS),
    interceptorReady: false,
    diag: null,
    lastSource: '',
    /** Last search request that produced documents; what `fetchAll` replays. */
    template: null,
    fetching: false,
    fetchCancel: false,
    fetchProgress: null
  };

  // --- activity ring buffer (drives the popup sparkline) -------------------

  function advanceBuckets() {
    const now = Math.floor(Date.now() / BUCKET_MS);
    const steps = now - state.bucketAt;
    if (steps <= 0) return;
    if (steps >= BUCKET_COUNT) {
      state.buckets.fill(0);
    } else {
      for (let i = 0; i < steps; i += 1) {
        state.buckets.shift();
        state.buckets.push(0);
      }
    }
    state.bucketAt = now;
  }

  function bumpActivity(count) {
    advanceBuckets();
    state.buckets[BUCKET_COUNT - 1] += count;
  }

  // --- buffer -------------------------------------------------------------

  function isEmptyValue(value) {
    return value === null || value === undefined || value === '';
  }

  function noteFields(row) {
    for (const field of Object.keys(row)) {
      if (!state.fieldSet.has(field)) {
        state.fieldSet.add(field);
        state.fields.push(field);
      }
      state.fieldPresence.set(field, (state.fieldPresence.get(field) || 0) + 1);
      if (!isEmptyValue(row[field])) {
        state.fieldCounts.set(field, (state.fieldCounts.get(field) || 0) + 1);
      }
    }
  }

  function trimBuffer() {
    const excess = state.rows.length - MAX_ROWS;
    if (excess <= 0) return;
    const dropped = state.rows.splice(0, excess);
    const droppedKeys = state.rowKeys.splice(0, excess);
    for (const key of droppedKeys) state.keys.delete(key);
    let removedField = false;
    for (const row of dropped) {
      for (const field of Object.keys(row)) {
        if (!isEmptyValue(row[field])) {
          const filled = (state.fieldCounts.get(field) || 1) - 1;
          if (filled <= 0) state.fieldCounts.delete(field);
          else state.fieldCounts.set(field, filled);
        }
        const present = (state.fieldPresence.get(field) || 1) - 1;
        if (present <= 0) {
          // No remaining row has this field; drop the column entirely.
          state.fieldPresence.delete(field);
          state.fieldCounts.delete(field);
          state.fieldSet.delete(field);
          removedField = true;
        } else {
          state.fieldPresence.set(field, present);
        }
      }
    }
    if (removedField) state.fields = state.fields.filter((field) => state.fieldSet.has(field));
  }

  /**
   * @param {{key: string, row: object}[]} batch
   * @returns {number} rows that were new
   */
  function addRows(batch) {
    let added = 0;
    for (const item of batch) {
      if (!item || !item.row || typeof item.row !== 'object') continue;
      const key = item.key;
      if (typeof key === 'string' && state.keys.has(key)) continue;
      if (typeof key === 'string') state.keys.add(key);
      state.rows.push(item.row);
      state.rowKeys.push(key);
      noteFields(item.row);
      added += 1;
    }
    if (added) {
      trimBuffer();
      bumpActivity(added);
      state.lastCaptureAt = Date.now();
      reportCount();
    }
    return added;
  }

  function clearBuffer() {
    state.rows = [];
    state.rowKeys = [];
    state.keys = new Set();
    state.fields = [];
    state.fieldSet = new Set();
    state.fieldCounts = new Map();
    state.fieldPresence = new Map();
    state.buckets.fill(0);
    reportCount();
  }

  // --- badge --------------------------------------------------------------

  let reportTimer = 0;
  function reportCount() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      try {
        chrome.runtime.sendMessage({ type: 'kle:count', count: state.rows.length }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        // Extension context invalidated (reloaded/updated); nothing to do.
      }
    }, 500);
  }

  // --- network capture ----------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.type === 'ready' || data.type === 'diag') {
      state.interceptorReady = true;
      if (data.kibana) state.kibana = true;
      if (data.diag) state.diag = data.diag;
      return;
    }
    if (data.type === 'template') {
      if (typeof data.url === 'string' && typeof data.body === 'string') {
        // Dashboards fire many aggregation-only `_msearch` batches. Only keep
        // a template we can actually replay (Discover *or* saved-search panel).
        if (!parse.bodyHasDocQuery(data.body)) return;
        const total =
          data.total && typeof data.total.value === 'number'
            ? { value: data.total.value, gte: !!data.total.gte }
            : null;
        state.template = { url: data.url, body: data.body, total, at: Date.now() };
        state.sawNetwork = true;
        state.kibana = true;
        state.lastSource = data.source || 'network';
      }
      return;
    }
    // Matching-document count, learned from the response after the template.
    if (data.type === 'total') {
      if (state.template && data.total && typeof data.total.value === 'number') {
        state.template.total = { value: data.total.value, gte: !!data.total.gte };
      }
      return;
    }
  });

  // --- fetch everything ----------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function ingestHits(hits) {
    const batch = new Array(hits.length);
    for (let i = 0; i < hits.length; i += 1) {
      const row = parse.hitToRow(hits[i]);
      batch[i] = { key: parse.hitKey(hits[i], row), row };
    }
    return addRows(batch);
  }

  /** Ask the MAIN-world interceptor to (re)patch fetch/XHR. */
  function armInterceptor() {
    try {
      window.postMessage({ channel: CHANNEL, type: 'arm' }, '*');
    } catch {
      /* ignore */
    }
  }

  /**
   * Clicks whatever Kibana control re-runs the current query so our interceptor
   * can catch a fresh document-search template without the user refreshing.
   */
  function nudgeKibanaRefresh() {
    const selectors = [
      '[data-test-subj="querySubmitButton"]',
      '[data-test-subj="superDatePickerApplyTimeButton"]',
      '[data-test-subj="dashboardRefreshButton"]',
      '[data-test-subj="refreshQuery"]',
      '[data-test-subj="queryInputSubmit"]',
      'button[aria-label="Refresh"]',
      'button[aria-label="Update"]',
      '.kuiLocalSearchButton',
      '.euiSuperUpdateButton'
    ];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      try {
        node.click();
        return sel;
      } catch {
        /* try next */
      }
    }
    // Last resort: submit the query bar with Enter.
    const input =
      document.querySelector('[data-test-subj="queryInput"]') ||
      document.querySelector('input[aria-label*="Search"]') ||
      document.querySelector('.kuiLocalSearchInput input');
    if (input) {
      try {
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        return 'queryInput+Enter';
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /** Wait until a usable template arrives (or timeout). */
  async function waitForTemplate(timeoutMs, preferNewerThan) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (state.template && parse.bodyHasDocQuery(state.template.body)) {
        if (!preferNewerThan || state.template.at > preferNewerThan) return state.template;
        // After a couple seconds, settle for the existing template.
        if (Date.now() - started > 2500) return state.template;
      }
      await sleep(150);
    }
    return state.template && parse.bodyHasDocQuery(state.template.body) ? state.template : null;
  }

  /**
   * Re-arm hooks and force Kibana to re-run the current query so we always
   * capture whatever filters / time range are on screen right now.
   */
  async function ensureTemplate() {
    armInterceptor();
    const previousAt = state.template ? state.template.at : 0;
    state.fetchProgress = { pages: 0, added: 0, total: null, phase: 'refreshing' };
    nudgeKibanaRefresh();
    const fresh = await waitForTemplate(8000, previousAt);
    if (fresh) return fresh;
    return state.template && parse.bodyHasDocQuery(state.template.body) ? state.template : null;
  }

  // --- visible table fallback (Kibana 7 doc table / saved search) ----------

  function cleanText(node) {
    if (!node) return '';
    return (node.textContent || '').replace(/[\u200b-\u200f\u00ad]/g, '').replace(/\s+/g, ' ').trim();
  }

  function scrapeVisibleRows() {
    const table =
      document.querySelector('table[data-test-subj="docTable"], table.kbn-table, .kbnDocTable table') ||
      document.querySelector('[data-test-subj="docTable"] table') ||
      null;
    if (!table) return [];

    const headers = [];
    table.querySelectorAll('thead th, thead td').forEach((cell, index) => {
      const testSubj = cell.getAttribute('data-test-subj') || '';
      const match = testSubj.match(/^docTableHeaderField(?:-(.*))?$/);
      let name = (match && match[1]) || cleanText(cell) || `column_${index + 1}`;
      if (!name || /^(select|time|)$/i.test(name) && index === 0) {
        /* keep */
      }
      headers.push(name);
    });

    const rows = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (tr.classList.contains('kbnDocTableDetails__row')) return;
      const cells = tr.querySelectorAll('td');
      if (!cells.length) return;
      const row = {};
      cells.forEach((cell, index) => {
        const field = headers[index] || `column_${index + 1}`;
        if (/openDetails|select|filter/i.test(field)) return;
        // Expand filter buttons / truncated source
        const dl = cell.querySelector('dl');
        if (dl) {
          let key = null;
          for (const child of dl.children) {
            if (child.tagName === 'DT') key = cleanText(child).replace(/[:\s]+$/, '');
            else if (child.tagName === 'DD' && key) {
              row[key] = cleanText(child);
              key = null;
            }
          }
          return;
        }
        const text = cleanText(cell);
        if (text) row[field] = text;
      });
      if (Object.keys(row).length) rows.push(row);
    });
    return rows;
  }

  /**
   * Always safe to call: re-arms hooks, refreshes Kibana if needed to catch the
   * current query, then paginates. If no network template appears, falls back
   * to scraping whatever log rows are visible on the page.
   */
  async function fetchAll(payload) {
    if (state.fetching) return { ok: false, error: 'A fetch is already running.' };

    state.fetching = true;
    state.fetchCancel = false;
    state.fetchProgress = { pages: 0, added: 0, total: null, phase: 'starting' };

    try {
      const template = await ensureTemplate();

      if (!template) {
        // Fall back to whatever is rendered (Discover / saved-search table).
        state.fetchProgress = { pages: 0, added: 0, total: null, phase: 'scrape' };
        clearBuffer();
        const visible = scrapeVisibleRows();
        if (!visible.length) {
          return {
            ok: false,
            error:
              'Could not capture the current search. Make sure a Discover view or saved-search log table is visible, then click Fetch again.'
          };
        }
        const batch = visible.map((row) => ({ key: parse.hitKey(null, row), row }));
        addRows(batch);
        state.lastSource = 'visible-table';
        return {
          ok: true,
          added: visible.length,
          pages: 1,
          rowCount: state.rows.length,
          total: visible.length,
          scraped: true,
          complete: true
        };
      }

      const picked = parse.pickDocRequest(template.body);
      if (!picked) {
        return {
          ok: false,
          error: 'Captured a search but it had no document query. Open a log table panel and try again.'
        };
      }

      const pageSize = Math.max(1, Math.min(MAX_ROWS, Number(payload && payload.pageSize) || MAX_ROWS));
      const body = parse.prepareDocBody(picked.body, pageSize);
      const paged = Array.isArray(body.sort) && body.sort.length > 0;
      const index =
        picked.index ||
        (picked.header &&
          (picked.header.index ||
            (Array.isArray(picked.header.index) && picked.header.index.join(',')))) ||
        null;
      const replayUrl = parse.resolveReplayUrl(template.url, index);
      const isMsearch = /_msearch/i.test(replayUrl || '');

      state.fetchProgress = { pages: 0, added: 0, total: null, phase: 'paging' };

      let added = 0;
      // Every fetch reflects the *current* search — but keep the previous rows
      // until the replacement actually starts arriving, so a failed replay
      // doesn't wipe a good buffer.
      let cleared = false;
      for (let page = 0; ; page += 1) {
        const requestBody = isMsearch
          ? `${JSON.stringify(picked.header || { index: index || '_all' })}\n${JSON.stringify(body)}\n`
          : JSON.stringify(body);
        const response = await fetch(replayUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: kibanaRequestHeaders(isMsearch),
          body: requestBody
        });
        if (!response.ok) {
          // Network replay failed — try visible rows so Fetch still does something.
          const visible = scrapeVisibleRows();
          if (visible.length && !added) {
            if (!cleared) {
              clearBuffer();
              cleared = true;
            }
            const batch = visible.map((row) => ({ key: parse.hitKey(null, row), row }));
            addRows(batch);
            return {
              ok: true,
              added: visible.length,
              rowCount: state.rows.length,
              scraped: true,
              error: `Search HTTP ${response.status}; exported visible rows instead.`
            };
          }
          const hint =
            response.status === 404
              ? ' (could not reach the Elasticsearch proxy)'
              : response.status === 400
                ? ' (bad request)'
                : '';
          return { ok: false, added, error: `Search failed with HTTP ${response.status}.${hint}` };
        }
        const parsedBody = await response.json();
        const result = Array.isArray(parsedBody.responses)
          ? parsedBody.responses[0]
          : parsedBody.rawResponse || parsedBody.response || parsedBody;
        if (!result || result.error) {
          const reason =
            (result && result.error && (result.error.type || result.error.reason)) || 'unknown';
          return { ok: false, added, error: `Elasticsearch error: ${String(reason).slice(0, 140)}` };
        }
        if (!cleared) {
          clearBuffer();
          cleared = true;
        }
        const hits = (result.hits && result.hits.hits) || [];
        const total = result.hits && result.hits.total;
        if (typeof total === 'number') state.fetchProgress.total = total;
        else if (total && typeof total.value === 'number') state.fetchProgress.total = total.value;

        added += ingestHits(hits);
        state.fetchProgress.pages = page + 1;
        state.fetchProgress.added = added;
        state.lastSource = 'fetch';

        const done =
          !paged || hits.length < pageSize || state.rows.length >= MAX_ROWS || state.fetchCancel;
        if (done) {
          return {
            ok: true,
            added,
            pages: page + 1,
            rowCount: state.rows.length,
            total: state.fetchProgress.total,
            complete: paged && hits.length < pageSize,
            capped: state.rows.length >= MAX_ROWS && hits.length >= pageSize,
            stopped: state.fetchCancel
          };
        }
        const cursor = hits[hits.length - 1].sort;
        if (!Array.isArray(cursor) || !cursor.length) {
          return {
            ok: true,
            added,
            pages: page + 1,
            rowCount: state.rows.length,
            total: state.fetchProgress.total,
            complete: true
          };
        }
        body.search_after = cursor;
        await sleep(100);
      }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      state.fetching = false;
      state.fetchProgress = null;
      reportCount();
    }
  }

  /** Headers Kibana 7.x expects on proxied ES calls. */
  function kibanaRequestHeaders(isMsearch) {
    const headers = {
      'Content-Type': isMsearch ? 'application/x-ndjson' : 'application/json',
      'kbn-xsrf': 'true',
      'osd-xsrf': 'true'
    };
    const version = readKibanaVersion();
    if (version) headers['kbn-version'] = version;
    return headers;
  }

  function readKibanaVersion() {
    try {
      const injected = document.querySelector('kbn-injected-metadata');
      if (injected) {
        const raw = injected.getAttribute('data');
        if (raw) {
          const data = JSON.parse(raw);
          if (data && data.version) return String(data.version);
        }
      }
      const meta = document.querySelector('meta[name="kbn-version"]');
      if (meta && meta.content) return meta.content;
    } catch {
      /* ignore */
    }
    return null;
  }

  // --- export -------------------------------------------------------------

  function resolveFields(requested) {
    const ordered = parse.orderFields(state.fields.slice());
    if (!Array.isArray(requested) || !requested.length) return ordered;
    const wanted = new Set(requested);
    const selected = ordered.filter((field) => wanted.has(field));
    // Honour any requested field that hasn't been seen in a row yet.
    const included = new Set(selected);
    for (const field of requested) {
      if (!included.has(field)) {
        included.add(field);
        selected.push(field);
      }
    }
    return selected;
  }

  /** JSON array of row objects, selected columns only, raw (unstringified) values. */
  function buildJson(options) {
    const fields = resolveFields(options.fields);
    if (!fields.length || !state.rows.length) return { text: '', fields, rowCount: 0 };
    const parts = new Array(state.rows.length);
    for (let i = 0; i < state.rows.length; i += 1) {
      const row = state.rows[i];
      const doc = {};
      for (const field of fields) {
        if (row[field] !== undefined) doc[field] = row[field];
      }
      parts[i] = JSON.stringify(doc);
    }
    return { text: `[\n${parts.join(',\n')}\n]\n`, fields, rowCount: state.rows.length };
  }

  function buildCsv(options) {
    const fields = resolveFields(options.fields);
    if (!fields.length || !state.rows.length) return { text: '', fields, rowCount: 0 };
    const text = csv.toCsv(state.rows, fields, {
      delimiter: DELIMITER,
      bom: options.bom !== false,
      guardFormulas: options.guardFormulas !== false
    });
    return { text, fields, rowCount: state.rows.length };
  }

  function saveFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 60000);
  }

  // --- popup messaging ----------------------------------------------------

  function fieldSummary() {
    return parse.orderFields(state.fields.slice()).map((field) => ({
      name: field,
      filled: state.fieldCounts.get(field) || 0
    }));
  }

  /** Second opinion on "is this Kibana", for pages the page-world check missed. */
  function looksLikeKibanaDom() {
    return !!document.querySelector(
      'meta[name="kbn-injected-metadata"], kbn-injected-metadata, #kibana-body, #osd-body,' +
        ' [data-test-subj="kibanaChrome"], [data-test-subj="discoverDocTable"],' +
        ' [data-test-subj="euiDataGridBody"], table.kbn-table, [data-test-subj="discover-layout"],' +
        ' .dscDocuments__content, [data-test-subj="docTable"], [data-test-subj="dashboardViewport"],' +
        ' dashboard-viewport, [data-shared-item]'
    );
  }

  function captureHint() {
    if (state.fetching) return 'Fetching…';
    if (state.rows.length) return 'Fetched. Pick columns and save below.';
    return 'Click Fetch anytime — it refreshes the current query and pulls the matching documents.';
  }

  function status() {
    advanceBuckets();
    if (!state.kibana && looksLikeKibanaDom()) state.kibana = true;
    armInterceptor();
    return {
      ok: true,
      url: location.href,
      host: location.host,
      kibana: state.kibana,
      sawNetwork: state.sawNetwork,
      interceptorReady: state.interceptorReady,
      rowCount: state.rows.length,
      maxRows: MAX_ROWS,
      fields: fieldSummary(),
      activity: state.buckets.slice(),
      lastCaptureAt: state.lastCaptureAt,
      lastSource: state.lastSource,
      template: !!state.template,
      templateTotal: (state.template && state.template.total) || null,
      fetching: state.fetching,
      fetchProgress: state.fetchProgress,
      hint: captureHint(),
      diag: state.diag
    };
  }

  const HANDLERS = {
    status: () => status(),

    arm: () => {
      armInterceptor();
      return { ok: true };
    },

    clear: () => {
      clearBuffer();
      return { ok: true, rowCount: 0 };
    },

    fetchAll: (payload) => fetchAll(payload),

    fetchAllStop: () => {
      state.fetchCancel = true;
      return { ok: true };
    },

    save: (options) => {
      const json = options.format === 'json';
      const { text, fields, rowCount } = json ? buildJson(options) : buildCsv(options);
      if (!rowCount || !fields.length) {
        return { ok: false, error: 'Nothing captured yet. Click "Fetch all results" first.' };
      }
      const filename = csv.suggestFilename(
        options.filenamePrefix || DEFAULTS.filenamePrefix,
        json ? 'json' : 'csv'
      );
      saveFile(text, filename, json ? 'application/json' : 'text/csv;charset=utf-8');
      return { ok: true, filename, rowCount, columnCount: fields.length, bytes: text.length };
    },

    csvText: (options) => {
      const limitBytes = Number(options.limitBytes) || 4 * 1024 * 1024;
      const { text, rowCount } = buildCsv(options);
      if (!rowCount) return { ok: false, error: 'Nothing captured yet.' };
      if (text.length > limitBytes) {
        return { ok: false, error: 'Too much data to copy. Save the CSV file instead.' };
      }
      return { ok: true, text: text.replace(/^\uFEFF/, ''), rowCount };
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('kle:')) return false;
    const handler = HANDLERS[message.type.slice(4)];
    if (!handler) return false;
    try {
      const result = handler(message.payload || {});
      if (result && typeof result.then === 'function') {
        result.then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
        return true;
      }
      sendResponse(result);
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
    return false;
  });

  // Boot: tell the page-world interceptor we're here and to keep hooks installed.
  armInterceptor();
})();
