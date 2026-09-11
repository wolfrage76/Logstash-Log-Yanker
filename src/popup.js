/**
 * Popup: shows what the content script has captured and drives the export.
 * All state lives in the content script, so this file only renders and sends
 * commands. If the content script isn't on the tab yet (common after installing
 * or reloading the extension), we inject it on demand.
 */

const SETTINGS = {
  bom: true,
  guardFormulas: true,
  filenamePrefix: 'logstash-logs'
};

const el = (id) => document.getElementById(id);

const ui = {
  lamp: el('lamp'),
  state: el('state'),
  host: el('host'),
  settingsBtn: el('settingsBtn'),
  settingsPanel: el('settingsPanel'),
  kibanaUrl: el('kibanaUrl'),
  applyUrl: el('applyUrl'),
  settingsDone: el('settingsDone'),
  unavailable: el('unavailable'),
  unavailableLead: el('unavailableLead'),
  unavailableBody: el('unavailableBody'),
  connect: el('connect'),
  main: el('main'),
  count: el('count'),
  traceLine: el('traceLine'),
  traceFill: el('traceFill'),
  fetchAll: el('fetchAll'),
  fetchNote: el('fetchNote'),
  progress: el('progress'),
  progressFill: el('progressFill'),
  saveJson: el('saveJson'),
  fieldCount: el('fieldCount'),
  fieldFilter: el('fieldFilter'),
  fieldList: el('fieldList'),
  selectAll: el('selectAll'),
  selectNone: el('selectNone'),
  bom: el('bom'),
  guardFormulas: el('guardFormulas'),
  save: el('save'),
  copy: el('copy'),
  clear: el('clear'),
  message: el('message')
};

let tabId = null;
let tabUrl = '';
let host = '';
/** Fields the user has explicitly unchecked; anything new is exported. */
let deselected = new Set();
let fieldSignature = '';
let lastFields = [];
let busy = false;
let settingsOpen = false;
let pollTimer = 0;
let lastConnectError = '';

// --- messaging ------------------------------------------------------------

function send(type, payload = {}) {
  return new Promise((resolve) => {
    if (tabId === null) {
      resolve(null);
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: `kle:${type}`, payload }, (response) => {
      if (chrome.runtime.lastError) {
        lastConnectError = chrome.runtime.lastError.message || 'No content script on this tab.';
        resolve(null);
        return;
      }
      lastConnectError = '';
      resolve(response || null);
    });
  });
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|devtools|edge|about|view-source|chrome-search|chrome-devtools):/i.test(
    url
  );
}

function tabOrigin() {
  try {
    if (!tabUrl || isRestrictedUrl(tabUrl)) return '';
    return new URL(tabUrl).origin;
  } catch {
    return '';
  }
}

/**
 * Grant host permission (must start permissions.request before any other await
 * when interactive — otherwise Chrome drops the user gesture and never saves),
 * persist the origin, and register document_start scripts for it.
 * @returns {Promise<boolean>}
 */
async function ensureHostAccess(origin, options = {}) {
  const interactive = !!options.interactive;
  if (!origin) return false;
  const pattern = `${origin}/*`;

  let permissionPromise = null;
  if (interactive) {
    permissionPromise = chrome.permissions.request({ origins: [pattern] });
  }

  let granted = false;
  try {
    if (permissionPromise) granted = await permissionPromise;
    else granted = await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (!granted) return false;

  await chrome.storage.local.set({ kibanaUrl: origin });
  if (ui.kibanaUrl && !ui.kibanaUrl.value.trim()) ui.kibanaUrl.value = origin;

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'kle:registerUrl', url: origin }, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
  return !!(result && result.ok);
}

/**
 * For an already-open Kibana tab we inject on demand (same files as registration).
 */
async function injectIntoTab() {
  if (tabId === null) throw new Error('No active tab.');
  if (isRestrictedUrl(tabUrl)) {
    throw new Error('This page is a Chrome internal page. Open your Kibana URL in a normal tab.');
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/lib/parse.js', 'src/interceptor.js'],
    world: 'MAIN',
    injectImmediately: true
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/lib/parse.js', 'src/lib/csv.js', 'src/content.js'],
    world: 'ISOLATED',
    injectImmediately: true
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * @param {{ interactive?: boolean }} [options]
 */
async function ensureConnected(options = {}) {
  const interactive = !!options.interactive;
  const origin = tabOrigin();
  if (origin) await ensureHostAccess(origin, { interactive });

  let status = await send('status');
  if (status && status.ok) {
    send('arm');
    return status;
  }

  if (isRestrictedUrl(tabUrl)) {
    lastConnectError =
      'Chrome blocks extensions on this page. Switch to your Kibana tab (https://…).';
    return null;
  }

  try {
    ui.state.textContent = 'Connecting';
    await injectIntoTab();
    status = await send('status');
    if (status && status.ok) {
      send('arm');
      return status;
    }
    lastConnectError =
      lastConnectError ||
      'Injected, but the page did not answer. Reload the Kibana tab and click Connect again.';
  } catch (error) {
    lastConnectError = String((error && error.message) || error);
  }
  return status && status.ok ? status : null;
}

// --- formatting -----------------------------------------------------------

/** Thin-space thousands, so the counter reads like a mechanical one. */
function formatCount(value) {
  return Number(value || 0)
    .toLocaleString('en-US')
    .replace(/,/g, '\u2009');
}

function tracePath(buckets) {
  const values = Array.isArray(buckets) && buckets.length ? buckets : [0, 0];
  const peak = Math.max(1, ...values);
  const width = 120;
  const height = 34;
  const pad = 1.5;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  let line = '';
  values.forEach((value, index) => {
    const x = index * step;
    const y = height - pad - (value / peak) * (height - pad * 2);
    line += `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  return { line: line.trim(), fill: `${line}L${width} ${height} L0 ${height} Z` };
}

/** The hero button, its note and the progress bar. */
function renderFetchControls(status) {
  const total = status.templateTotal;
  const totalText = total ? `${formatCount(total.value)}${total.gte ? '+' : ''}` : '';
  const cap = status.maxRows;
  const overCap = total && total.value > cap;

  ui.fetchAll.disabled = false;
  ui.fetchAll.textContent = status.fetching
    ? 'Stop'
    : overCap
      ? `Fetch first ${formatCount(cap)} of ${totalText}`
      : totalText
        ? `Fetch all ${totalText} results`
        : 'Fetch results';

  if (status.fetching) {
    const phase = status.fetchProgress && status.fetchProgress.phase;
    ui.fetchNote.textContent =
      phase === 'refreshing'
        ? 'Refreshing Kibana search…'
        : phase === 'scrape'
          ? 'Reading visible rows…'
          : 'Fetching…';
    ui.fetchAll.title = 'Click to stop';
  } else {
    ui.fetchNote.textContent =
      'Click anytime — refreshes the current Discover / saved-search query and pulls matching documents.';
    ui.fetchAll.title = '';
  }

  const progress = status.fetching ? status.fetchProgress : null;
  ui.progress.hidden = !(progress && progress.phase === 'paging');
  if (progress && progress.phase === 'paging') {
    const denominator = Math.min(progress.total || 0, status.maxRows) || 0;
    const percent = denominator ? Math.min(100, (status.rowCount / denominator) * 100) : 0;
    ui.progressFill.style.width = `${percent.toFixed(1)}%`;
    const totalPart = progress.total
      ? ` of ~${formatCount(Math.min(progress.total, status.maxRows))}`
      : '';
    say(`Fetching — page ${progress.pages}, ${formatCount(status.rowCount)} rows${totalPart}…`);
  } else if (!status.fetching) {
    ui.progressFill.style.width = '0%';
  }
}

function say(text, tone = '') {
  ui.message.textContent = text;
  if (tone) ui.message.dataset.tone = tone;
  else delete ui.message.dataset.tone;
}

// --- field list -----------------------------------------------------------

function selectedFields() {
  return lastFields.map((f) => f.name).filter((name) => !deselected.has(name));
}

function persistDeselected() {
  if (!host) return;
  chrome.storage.local.set({ [`deselected:${host}`]: [...deselected] });
}

function applyFilter() {
  const term = ui.fieldFilter.value.trim().toLowerCase();
  for (const row of ui.fieldList.children) {
    const name = row.dataset.field || '';
    row.hidden = !!term && !name.toLowerCase().includes(term);
  }
}

function renderFields(fields) {
  const signature = fields.map((f) => f.name).join('\u0000');
  const counts = new Map(fields.map((f) => [f.name, f.filled]));

  if (signature !== fieldSignature) {
    fieldSignature = signature;
    ui.fieldList.textContent = '';
    for (const field of fields) {
      const row = document.createElement('label');
      row.className = 'field';
      row.dataset.field = field.name;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !deselected.has(field.name);
      box.addEventListener('change', () => {
        if (box.checked) deselected.delete(field.name);
        else deselected.add(field.name);
        persistDeselected();
        updateTally();
      });

      const name = document.createElement('span');
      name.className = 'field__name';
      name.textContent = field.name;
      name.title = field.name;

      const filled = document.createElement('span');
      filled.className = 'field__filled';

      row.append(box, name, filled);
      ui.fieldList.append(row);
    }
    applyFilter();
  }

  for (const row of ui.fieldList.children) {
    const value = counts.get(row.dataset.field);
    row.lastElementChild.textContent = value === undefined ? '' : formatCount(value);
  }
  lastFields = fields;
  updateTally();
}

function updateTally() {
  const total = lastFields.length;
  const chosen = selectedFields().length;
  ui.fieldCount.textContent = total ? `${chosen}/${total}` : '';
  ui.save.disabled = busy || !chosen;
  ui.saveJson.disabled = busy || !chosen;
  ui.copy.disabled = busy || !chosen;
}

function setAll(checked) {
  if (checked) deselected.clear();
  else for (const field of lastFields) deselected.add(field.name);
  persistDeselected();
  for (const row of ui.fieldList.children) row.firstElementChild.checked = checked;
  updateTally();
}

// --- status ---------------------------------------------------------------

function renderDisconnected() {
  if (settingsOpen) return;
  ui.main.hidden = true;
  ui.unavailable.hidden = false;
  ui.lamp.dataset.state = 'idle';
  ui.state.textContent = 'Not connected';
  ui.host.textContent = host || '';

  if (isRestrictedUrl(tabUrl)) {
    ui.unavailableLead.textContent = 'Wrong kind of tab';
    ui.unavailableBody.textContent =
      'Chrome blocks extensions on chrome:// pages, the Web Store, and the new-tab page. Open your Kibana Discover URL in a normal browser tab, then click Connect.';
    ui.connect.hidden = true;
  } else {
    ui.unavailableLead.textContent = 'Not connected to this tab';
    ui.unavailableBody.textContent =
      lastConnectError ||
      'The exporter is not running on this tab yet. Click Connect (or reload the Kibana tab after updating the extension).';
    ui.connect.hidden = false;
    ui.connect.disabled = false;
    ui.connect.textContent = 'Connect to this tab';
  }
}

function renderStatus(status) {
  if (!status || !status.ok) {
    renderDisconnected();
    return;
  }
  if (settingsOpen) return;

  ui.unavailable.hidden = true;
  ui.main.hidden = false;
  host = status.host || host;
  ui.host.textContent = host;

  ui.lamp.dataset.state = 'live';
  ui.state.textContent = status.fetching ? 'Fetching' : 'Ready';

  renderFetchControls(status);

  ui.count.textContent = formatCount(status.rowCount);
  const path = tracePath(status.activity);
  ui.traceLine.setAttribute('d', path.line);
  ui.traceFill.setAttribute('d', path.fill);

  renderFields(status.fields || []);

  if (!status.rowCount && status.hint) {
    say(status.hint);
  } else if (status.rowCount && ui.message.textContent && ui.message.textContent.includes('No rows')) {
    say('');
  }
}

async function refresh() {
  const status = await ensureConnected();
  renderStatus(status);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    // After a successful connect, just ping — don't re-inject every second.
    const status = await send('status');
    if (status && status.ok) {
      renderStatus(status);
      return;
    }
    renderDisconnected();
  }, 1000);
}

// --- actions --------------------------------------------------------------

function exportOptions() {
  return {
    fields: selectedFields(),
    bom: ui.bom.checked,
    guardFormulas: ui.guardFormulas.checked,
    filenamePrefix: SETTINGS.filenamePrefix
  };
}

function setBusy(value) {
  busy = value;
  ui.save.disabled = value;
  ui.saveJson.disabled = value;
  ui.copy.disabled = value;
  if (!value) updateTally();
}

async function withConnection(action) {
  const status = await ensureConnected({ interactive: true });
  if (!status) {
    renderDisconnected();
    say(lastConnectError || 'Could not reach the page. Click Connect, or reload the Kibana tab.', 'bad');
    return null;
  }
  return action();
}

ui.connect.addEventListener('click', async () => {
  ui.connect.disabled = true;
  ui.connect.textContent = 'Connecting…';
  const status = await ensureConnected({ interactive: true });
  renderStatus(status);
  if (status) {
    say(
      'Connected. Reload this Kibana tab once so capture starts from page load, then click Fetch.',
      'good'
    );
  } else {
    ui.connect.disabled = false;
    ui.connect.textContent = 'Connect to this tab';
  }
});

ui.fetchAll.addEventListener('click', async () => {
  await withConnection(async () => {
    const status = await send('status');
    if (status && status.fetching) {
      await send('fetchAllStop');
      say('Stopping…');
      return;
    }
    ui.fetchAll.textContent = 'Stop';
    say('Refreshing search and fetching…');
    // The fetch keeps running in the page even if this popup closes; the
    // response below only arrives if the popup is still open at the end.
    const result = await send('fetchAll');
    if (!result) say(lastConnectError || 'Could not reach the page.', 'bad');
    else if (!result.ok) say(result.error || 'Fetch failed.', 'bad');
    else {
      const ofTotal =
        result.total && result.total > result.rowCount ? ` of ${formatCount(result.total)}` : '';
      const suffix = result.stopped ? ' — stopped early' : result.scraped ? ' (from visible table)' : '';
      say(`Fetched ${formatCount(result.rowCount)}${ofTotal} rows${suffix}. Save below.`, 'good');
    }
    refresh();
  });
});

async function saveAs(format) {
  await withConnection(async () => {
    setBusy(true);
    const result = await send('save', { ...exportOptions(), format });
    setBusy(false);
    if (!result) say(lastConnectError || 'Could not reach the page.', 'bad');
    else if (!result.ok) say(result.error || 'Export failed.', 'bad');
    else {
      say(
        `Saved ${result.filename} — ${formatCount(result.rowCount)} rows, ${result.columnCount} columns.`,
        'good'
      );
    }
  });
}

ui.save.addEventListener('click', () => saveAs('csv'));
ui.saveJson.addEventListener('click', () => saveAs('json'));

ui.copy.addEventListener('click', async () => {
  await withConnection(async () => {
    setBusy(true);
    const result = await send('csvText', exportOptions());
    if (result && result.ok) {
      try {
        await navigator.clipboard.writeText(result.text);
        say(`Copied ${formatCount(result.rowCount)} rows to the clipboard.`, 'good');
      } catch {
        say('The clipboard is blocked. Save the CSV file instead.', 'bad');
      }
    } else {
      say((result && result.error) || lastConnectError || 'Could not reach the page.', 'bad');
    }
    setBusy(false);
  });
});

ui.clear.addEventListener('click', async () => {
  await withConnection(async () => {
    const result = await send('clear');
    if (result) say('Buffer cleared.');
    fieldSignature = '';
    refresh();
  });
});

// --- settings -------------------------------------------------------------

function setSettingsOpen(open) {
  settingsOpen = open;
  ui.settingsPanel.hidden = !open;
  if (open) {
    ui.main.hidden = true;
    ui.unavailable.hidden = true;
    say('');
  } else {
    refresh();
  }
}

ui.settingsBtn.addEventListener('click', () => setSettingsOpen(!settingsOpen));

/**
 * Applying a URL: normalise to an origin, get Chrome's host permission for it,
 * then have the service worker register the content scripts against it.
 * @returns {Promise<boolean>}
 */
async function applyKibanaUrl() {
  const raw = ui.kibanaUrl.value.trim();
  if (!raw) {
    say('Enter your Kibana URL, e.g. https://kibana.example.com', 'bad');
    return false;
  }
  let origin;
  try {
    origin = new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
  } catch {
    say('That does not look like a URL.', 'bad');
    return false;
  }

  ui.applyUrl.disabled = true;
  try {
    const ok = await ensureHostAccess(origin, { interactive: true });
    if (!ok) {
      say('Chrome needs permission for that site — click Apply and allow the prompt.', 'bad');
      return false;
    }
    ui.kibanaUrl.value = origin;
    if (tabOrigin() === origin) {
      try {
        await injectIntoTab();
        await send('arm');
      } catch {
        /* not on that tab / no activeTab */
      }
    }
    say(`Active on ${origin}. Reload your Kibana tab once, then click Fetch.`, 'good');
    return true;
  } finally {
    ui.applyUrl.disabled = false;
  }
}

ui.settingsDone.addEventListener('click', async () => {
  const raw = ui.kibanaUrl.value.trim();
  if (raw) {
    const ok = await applyKibanaUrl();
    if (!ok) return;
  }
  setSettingsOpen(false);
});

ui.applyUrl.addEventListener('click', () => {
  applyKibanaUrl();
});
ui.kibanaUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') applyKibanaUrl();
});

ui.selectAll.addEventListener('click', () => setAll(true));
ui.selectNone.addEventListener('click', () => setAll(false));
ui.fieldFilter.addEventListener('input', applyFilter);

ui.bom.addEventListener('change', () => chrome.storage.local.set({ bom: ui.bom.checked }));
ui.guardFormulas.addEventListener('change', () =>
  chrome.storage.local.set({ guardFormulas: ui.guardFormulas.checked })
);
// --- boot -----------------------------------------------------------------

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    renderDisconnected();
    return;
  }
  tabId = tab.id;
  tabUrl = tab.url || '';
  try {
    host = new URL(tabUrl).host;
  } catch {
    host = '';
  }

  const stored = await chrome.storage.local.get({
    bom: SETTINGS.bom,
    guardFormulas: SETTINGS.guardFormulas,
    kibanaUrl: '',
    [`deselected:${host}`]: []
  });
  ui.bom.checked = stored.bom !== false;
  ui.guardFormulas.checked = stored.guardFormulas !== false;
  ui.kibanaUrl.value = stored.kibanaUrl || '';
  deselected = new Set(stored[`deselected:${host}`] || []);

  if (!ui.kibanaUrl.value) {
    const origin = tabOrigin();
    if (origin) ui.kibanaUrl.value = origin;
    else setSettingsOpen(true);
  }

  await refresh();
  startPolling();
})();
