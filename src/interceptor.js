/**
 * Runs in the page's own JavaScript context (MAIN world) so it can watch the
 * search requests Kibana makes — XHR for the classic courier, fetch elsewhere.
 *
 * Templates (request bodies that contain a document query) are forwarded to
 * the content script. The interceptor can be re-armed at any time: Kibana
 * sometimes replaces `window.fetch`, and late injection after Connect also
 * needs a second chance.
 */
(() => {
  const NS = globalThis.__KLE__;
  if (!NS || !NS.parse) return;

  const { isSearchUrl, extractHits, MAX_BODY_BYTES, bodyHasDocQuery } = NS.parse;
  const CHANNEL = 'kibana-log-exporter';
  const MAX_TEMPLATE_BYTES = 1024 * 1024;
  const ORIGIN = window.location.origin === 'null' ? '*' : window.location.origin;
  const HOOK = Symbol.for('kle.interceptor');

  const diag = (NS.diag = NS.diag || {
    ready: true,
    searchesSeen: 0,
    lastUrl: '',
    lastError: '',
    lastHits: 0,
    templateSeen: false,
    armedAt: 0
  });

  const post = (payload) => {
    try {
      window.postMessage({ channel: CHANNEL, ...payload }, ORIGIN);
    } catch {
      /* structured-clone failure */
    }
  };

  const tooLarge = (contentLength) => {
    const size = Number(contentLength);
    return Number.isFinite(size) && size > MAX_BODY_BYTES;
  };

  const bodyFrom = async (input, init, xhrBody) => {
    if (typeof xhrBody === 'string' && xhrBody) return xhrBody;
    if (init && typeof init.body === 'string' && init.body) return init.body;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        const text = await input.clone().text();
        if (text) return text;
      } catch {
        /* locked */
      }
    }
    if (init && init.body && typeof init.body === 'object') {
      try {
        if (typeof Blob !== 'undefined' && init.body instanceof Blob) return await init.body.text();
        if (init.body instanceof URLSearchParams) return init.body.toString();
        if (ArrayBuffer.isView(init.body) || init.body instanceof ArrayBuffer) {
          const bytes = init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body;
          return new TextDecoder().decode(bytes);
        }
      } catch {
        /* ignore */
      }
    }
    return undefined;
  };

  const sendTemplate = (url, requestBody) => {
    if (typeof requestBody !== 'string' || !requestBody) return false;
    if (requestBody.length >= MAX_TEMPLATE_BYTES) return false;
    if (typeof bodyHasDocQuery === 'function' && !bodyHasDocQuery(requestBody)) return false;
    diag.templateSeen = true;
    post({
      type: 'template',
      source: 'network',
      url: String(url || ''),
      body: requestBody,
      total: null
    });
    return true;
  };

  const noteHits = (responseBody) => {
    try {
      const hits = extractHits(responseBody);
      diag.lastHits = hits.length;
      // The template goes out on the request; the matching-total only exists
      // in the response. Send it after the fact so the popup can show
      // "Fetch all 133,968 results".
      if (hits.length && hits.total) post({ type: 'total', total: hits.total });
    } catch (error) {
      diag.lastError = String((error && error.message) || error).slice(0, 160);
    }
  };

  function installFetch() {
    const current = window.fetch;
    if (current && current[HOOK]) return current;
    const original = current;
    if (typeof original !== 'function') return null;

    function kleFetch(input, init) {
      const promise = original.apply(this, arguments);
      let url;
      try {
        url = typeof input === 'string' ? input : input && input.url;
      } catch {
        url = undefined;
      }
      if (!isSearchUrl(url)) return promise;

      diag.searchesSeen += 1;
      diag.lastUrl = String(url).slice(0, 200);
      const bodyPromise = bodyFrom(input, init);

      promise
        .then(async (response) => {
          const requestBody = await bodyPromise.catch(() => undefined);
          if (requestBody) sendTemplate(url, requestBody);
          if (!response || !response.ok || response.bodyUsed) return;
          if (tooLarge(response.headers && response.headers.get('content-length'))) return;
          try {
            noteHits(await response.clone().text());
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});

      return promise;
    }
    kleFetch[HOOK] = true;
    try {
      Object.defineProperty(kleFetch, 'name', { value: 'fetch' });
    } catch {
      /* non-fatal */
    }
    window.fetch = kleFetch;
    return kleFetch;
  }

  function installXHR() {
    const XHR = window.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    if (XHR.prototype.send && XHR.prototype.send[HOOK]) return;

    const URL_KEY = Symbol('kleUrl');
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    function kleOpen(method, url) {
      try {
        this[URL_KEY] = url;
      } catch {
        /* frozen */
      }
      return originalOpen.apply(this, arguments);
    }

    function kleSend(body) {
      const url = this[URL_KEY];
      if (isSearchUrl(url)) {
        diag.searchesSeen += 1;
        diag.lastUrl = String(url || '').slice(0, 200);
        // Prefer sync capture for string bodies (Kibana 7 courier); decode others.
        if (typeof body === 'string' && body) sendTemplate(url, body);
        else {
          bodyFrom(undefined, undefined, body)
            .then((requestBody) => {
              if (requestBody) sendTemplate(url, requestBody);
            })
            .catch(() => {});
        }
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            if (tooLarge(this.getResponseHeader('content-length'))) return;
            const type = this.responseType;
            if (type === 'json') noteHits(this.response);
            else if (type === 'arraybuffer' && this.response) {
              noteHits(new TextDecoder('utf-8').decode(new Uint8Array(this.response)));
            } else if (type === '' || type === 'text') noteHits(this.responseText);
          } catch (error) {
            diag.lastError = String((error && error.message) || error).slice(0, 160);
          }
        });
      }
      return originalSend.apply(this, arguments);
    }
    kleOpen[HOOK] = true;
    kleSend[HOOK] = true;
    XHR.prototype.open = kleOpen;
    XHR.prototype.send = kleSend;
  }

  function arm() {
    installFetch();
    installXHR();
    diag.armedAt = Date.now();
    diag.ready = true;
    post({ type: 'ready', kibana: looksLikeKibana(), diag: { ...diag } });
  }

  const looksLikeKibana = () => {
    try {
      return !!(
        globalThis.__kbnBundles__ ||
        globalThis.__osdBundles__ ||
        globalThis.__kbnStrictCsp__ ||
        document.querySelector(
          'meta[name="kbn-injected-metadata"], kbn-injected-metadata, #kibana-body, #osd-body, [data-test-subj="kibanaChrome"]'
        )
      );
    } catch {
      return false;
    }
  };

  // Re-arm when the content script asks (Connect / Fetch / popup open).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === 'arm' || data.type === 'ping') arm();
  });

  arm();
  document.addEventListener('DOMContentLoaded', arm);

  // Kibana can replace window.fetch after boot — re-check periodically.
  setInterval(() => {
    if (!window.fetch || !window.fetch[HOOK]) installFetch();
  }, 3000);

  let lastDiag = '';
  setInterval(() => {
    const snapshot = JSON.stringify(diag);
    if (snapshot === lastDiag) return;
    lastDiag = snapshot;
    post({ type: 'diag', diag: { ...diag } });
  }, 2000);
})();
