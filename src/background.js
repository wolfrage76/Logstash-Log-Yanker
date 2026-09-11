/**
 * Service worker. Badge sync + dynamic content-script registration for the
 * Kibana origin the user chose in Settings. No host is baked into the
 * manifest — after permission is granted we register document_start scripts
 * and also inject on each navigation so capture matches the old static path.
 */

const BADGE_COLOR = '#12766a';

/** @type {string} */
let activeOrigin = '';

function formatCount(count) {
  if (count <= 0) return '';
  if (count < 1000) return String(count);
  if (count < 100000) return `${Math.round(count / 100) / 10}k`;
  return `${Math.round(count / 1000)}k`;
}

function setBadge(tabId, count) {
  if (typeof tabId !== 'number') return;
  const text = formatCount(count);
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

async function unregisterDynamic() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['kle-main', 'kle-isolated'] });
  } catch {
    // Nothing registered yet.
  }
}

/** Same files/worlds the old static content_scripts used. */
async function injectTab(tabId) {
  if (typeof tabId !== 'number') return;
  try {
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
  } catch {
    // No host permission yet, or a restricted URL.
  }
}

async function injectMatchingTabs(origin) {
  if (!origin) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${origin}/*` });
  } catch {
    return;
  }
  await Promise.all(tabs.map((tab) => injectTab(tab.id)));
}

/**
 * Register document_start scripts for the chosen origin and inject into any
 * tabs already open there (registration alone does not touch existing tabs).
 */
async function registerFor(url) {
  await unregisterDynamic();
  activeOrigin = '';
  if (!url || typeof url !== 'string') return;

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }

  activeOrigin = origin;
  const matches = [`${origin}/*`];
  await chrome.scripting.registerContentScripts([
    {
      id: 'kle-main',
      matches,
      js: ['src/lib/parse.js', 'src/interceptor.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false
    },
    {
      id: 'kle-isolated',
      matches,
      js: ['src/lib/parse.js', 'src/lib/csv.js', 'src/content.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: false
    }
  ]);
  await injectMatchingTabs(origin);
}

async function ensureRegistered() {
  const { kibanaUrl } = await chrome.storage.local.get({ kibanaUrl: '' });
  await registerFor(kibanaUrl);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRegistered().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensureRegistered().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.kibanaUrl) {
    registerFor(changes.kibanaUrl.newValue || '').catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'kle:count') {
    setBadge(sender.tab && sender.tab.id, Number(message.count) || 0);
    return false;
  }

  if (message.type === 'kle:registerUrl') {
    registerFor(message.url).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String((error && error.message) || error) })
    );
    return true;
  }
  return false;
});

// Early inject on navigations to the configured host — belt-and-suspenders with
// registerContentScripts so hooks are in place before Kibana's first searches.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') setBadge(tabId, 0);
  if (!activeOrigin) return;
  const url = (tab && tab.url) || changeInfo.url || '';
  if (!url.startsWith(activeOrigin)) return;
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    injectTab(tabId);
  }
});

ensureRegistered().catch(() => {});
