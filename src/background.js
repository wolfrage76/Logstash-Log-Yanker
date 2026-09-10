/**
 * Service worker. Keeps the toolbar badge in sync, and registers the content
 * scripts dynamically for whatever Kibana URL is configured in Settings —
 * that's what lets the URL live in storage instead of the manifest.
 */

const BADGE_COLOR = '#12766a';
const DEFAULT_KIBANA_URL = 'https://logstash.propertyradar.com';

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

/**
 * (Re)registers content scripts for a user-configured origin. The default
 * host ships statically in the manifest and never depends on this — dynamic
 * registration only adds an override host from Settings. The scripts guard
 * against double-injection, so overlap with the static pair is harmless.
 */
async function registerFor(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = DEFAULT_KIBANA_URL;
  }
  const matches = [`${origin}/*`];
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['kle-main', 'kle-isolated'] });
  } catch {
    // Nothing registered yet.
  }
  if (origin === DEFAULT_KIBANA_URL) return; // manifest covers it
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
}

async function ensureRegistered() {
  const { kibanaUrl } = await chrome.storage.local.get({ kibanaUrl: DEFAULT_KIBANA_URL });
  await registerFor(kibanaUrl);
}

// Fires on install, update and reload of the unpacked extension.
chrome.runtime.onInstalled.addListener(() => {
  ensureRegistered().catch(() => {});
});
// Registered scripts persist across sessions, but re-assert to be safe.
chrome.runtime.onStartup.addListener(() => {
  ensureRegistered().catch(() => {});
});
// React to Settings changes even if the popup's explicit message is missed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.kibanaUrl) {
    registerFor(changes.kibanaUrl.newValue).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'kle:count') {
    setBadge(sender.tab && sender.tab.id, Number(message.count) || 0);
    return false;
  }

  // Sent by the popup after the user changes the Kibana URL in Settings
  // (the popup asks for the host permission first — that needs the click).
  if (message.type === 'kle:registerUrl') {
    registerFor(message.url).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String((error && error.message) || error) })
    );
    return true;
  }
  return false;
});

// A real page load throws the buffer away, so the badge has to reset with it.
// `changeInfo.url` is absent on a same-URL reload, so key off status alone.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') setBadge(tabId, 0);
});
