/**
 * Shared helpers for turning Elasticsearch / Kibana search responses into flat
 * row objects. Loaded into the page world, the content-script world and the
 * popup, so it must not touch `chrome.*` or the DOM.
 */
(() => {
  const NS = (globalThis.__KLE__ = globalThis.__KLE__ || {});
  if (NS.parse) return;

  /** Response bodies bigger than this are ignored rather than parsed. */
  const MAX_BODY_BYTES = 32 * 1024 * 1024;
  /** Hits taken from a single response. */
  const MAX_HITS_PER_BODY = 20000;
  /** Guard against pathologically nested documents. */
  const MAX_WALK_DEPTH = 8;
  const MAX_FLATTEN_DEPTH = 12;

  /**
   * URL fragments that show up in Kibana / Elasticsearch / OpenSearch search
   * traffic. A match only means "worth parsing" — the payload still has to
   * contain real hits before anything is recorded.
   */
  const SEARCH_HINTS = [
    '_msearch',
    '_search',
    '_async_search',
    '_eql/search',
    'internal/search',
    'internal/bsearch',
    'api/console/proxy',
    'api/enhancements/search',
    'api/data/search',
    'elasticsearch/',
    'opensearch/',
    'bfetch'
  ];

  function isSearchUrl(url) {
    if (!url) return false;
    let s;
    try {
      s = String(url).toLowerCase();
    } catch {
      return false;
    }
    for (const hint of SEARCH_HINTS) {
      if (s.includes(hint)) return true;
    }
    return false;
  }

  /**
   * Walks an arbitrary parsed payload collecting every `hits.hits` array it can
   * find. This covers plain `_search` responses, `_msearch` `responses[]`,
   * Kibana's `{ result: { rawResponse: ... } }` envelopes, async-search
   * `{ response: ... }` and `top_hits` aggregations.
   */
  function collectHits(node, out, depth) {
    if (out.length >= MAX_HITS_PER_BODY) return;
    if (!node || typeof node !== 'object') return;
    if (depth > MAX_WALK_DEPTH) return;

    if (Array.isArray(node)) {
      for (const child of node) collectHits(child, out, depth + 1);
      return;
    }

    const hits = node.hits;
    const isHitsEnvelope = !!hits && typeof hits === 'object' && Array.isArray(hits.hits);
    if (isHitsEnvelope) {
      // Remember how many documents matched in total (the first envelope that
      // actually carries documents wins). `total` is a number with
      // `rest_total_hits_as_int`, an object otherwise.
      if (out.total === undefined && hits.hits.length) {
        const total = hits.total;
        if (typeof total === 'number') out.total = { value: total, gte: false };
        else if (total && typeof total.value === 'number') {
          out.total = { value: total.value, gte: total.relation === 'gte' };
        }
      }
      for (const hit of hits.hits) {
        if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
          out.push(hit);
          if (out.length >= MAX_HITS_PER_BODY) return;
        }
      }
    }

    for (const key of Object.keys(node)) {
      // Document bodies never contain further hit envelopes and are the
      // expensive part of the payload, so don't walk into them.
      if (key === '_source' || key === 'fields') continue;
      if (key === 'hits' && isHitsEnvelope) continue;
      collectHits(node[key], out, depth + 1);
    }
  }

  /**
   * Parses a response body. Accepts an already-parsed object (`responseType:
   * "json"`) or raw text, and handles JSON, NDJSON and length-prefixed
   * streamed batches, skipping any line that isn't valid JSON.
   *
   * The returned array carries a non-index `total` property — the matching
   * document count reported by the envelope the hits came from, as
   * `{ value, gte }` — when the response included one.
   */
  function extractHits(body) {
    if (body && typeof body === 'object') {
      const hits = [];
      collectHits(body, hits, 0);
      return hits;
    }
    const text = body;
    if (typeof text !== 'string' || text.length === 0) return [];
    if (text.length > MAX_BODY_BYTES) return [];

    const out = [];
    try {
      collectHits(JSON.parse(text), out, 0);
      return out;
    } catch {
      // Not a single JSON document — fall through to a line-by-line pass.
    }

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const first = trimmed[0];
      if (first !== '{' && first !== '[') continue;
      try {
        collectHits(JSON.parse(trimmed), out, 0);
      } catch {
        // Partial or non-JSON chunk; ignore it.
      }
      if (out.length >= MAX_HITS_PER_BODY) break;
    }
    return out;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Copies nested object properties into dotted keys (`http.response.status`),
   * matching how Kibana names fields. Arrays are left intact and stringified
   * later, so a cell can keep all of its values.
   */
  function flatten(value, prefix, out, depth) {
    if (!isPlainObject(value) || depth > MAX_FLATTEN_DEPTH) {
      if (prefix) out[prefix] = value;
      return out;
    }
    const keys = Object.keys(value);
    if (keys.length === 0 && prefix) {
      out[prefix] = '';
      return out;
    }
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const child = value[key];
      if (isPlainObject(child)) {
        flatten(child, path, out, depth + 1);
      } else {
        out[path] = child;
      }
    }
    return out;
  }

  /** `fields` responses wrap every value in an array; unwrap single values. */
  function unwrapFieldValue(value) {
    if (Array.isArray(value) && value.length === 1) return value[0];
    return value;
  }

  /**
   * Turns one hit into a flat row. `_source` wins over `fields` (docvalue and
   * runtime fields) so the row matches what the user sees in Discover.
   */
  function hitToRow(hit) {
    const row = {};
    if (isPlainObject(hit._source)) {
      flatten(hit._source, '', row, 0);
    }
    if (isPlainObject(hit.fields)) {
      for (const key of Object.keys(hit.fields)) {
        if (row[key] === undefined) row[key] = unwrapFieldValue(hit.fields[key]);
      }
    }
    if (hit._index !== undefined) row._index = hit._index;
    if (hit._id !== undefined) row._id = hit._id;
    return row;
  }

  /**
   * Stable identity for a hit so the same document captured twice (scrolling,
   * auto-refresh, overlapping queries) is only exported once.
   */
  function hitKey(hit, row) {
    if (hit && hit._id !== undefined && hit._id !== null) {
      return `${hit._index ?? ''}\u0000${hit._id}`;
    }
    // No `_id` (aggregation hits, some proxies): fall back to the row contents.
    let signature = '';
    const keys = Object.keys(row).sort();
    for (const key of keys) signature += `${key}\u0001${stringifyValue(row[key])}\u0002`;
    return `sig\u0000${signature}`;
  }

  /** Renders any field value as a single-line string for CSV output. */
  function stringifyValue(value) {
    if (value === null || value === undefined) return '';
    const type = typeof value;
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(stringifyValue).join('; ');
    if (type === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }



  /**
   * Pulls an Elasticsearch document query out of whatever wrapper Kibana put
   * around it: plain `_search`, `_msearch` NDJSON (Discover *and* dashboard
   * saved-search panels), or `/internal/bsearch` batch envelopes.
   *
   * Dashboards mix many `size: 0` aggregation queries with one real document
   * query — we score candidates so the saved-search / Discover request wins.
   *
   * Returns `{ header, body, index }` (`header`/`index` may be null) or null.
   */
  function pickDocRequest(bodyText) {
    if (typeof bodyText !== 'string' || !bodyText.trim()) return null;

    const candidates = [];

    const scoreBody = (body, size) => {
      let score = size;
      if (Array.isArray(body.sort) || body.sort) score += 1000;
      if (body.stored_fields || body.docvalue_fields || body.fields) score += 200;
      if (body._source !== undefined && body._source !== false) score += 50;
      if (body.version || body.seq_no_primary_term) score += 25;
      // Tiny sizes are usually "sample a few docs for a viz", not the log table.
      if (size > 0 && size < 5) score -= 500;
      return score;
    };

    const indexFrom = (value) => {
      if (value == null) return null;
      if (Array.isArray(value)) return value.filter(Boolean).join(',') || null;
      return String(value) || null;
    };

    const consider = (body, header, index) => {
      if (!isPlainObject(body)) return;
      const size = typeof body.size === 'number' ? body.size : body.query ? 10 : 0;
      if (!body.query && !body.pit && !Array.isArray(body.docs)) return;
      if (body.query && size === 0) return;
      candidates.push({
        header: header || null,
        body,
        index: indexFrom(index),
        size,
        score: scoreBody(body, size)
      });
    };

    const walk = (node, depth) => {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (!isPlainObject(node)) return;

      if (isPlainObject(node.params) && isPlainObject(node.params.body)) {
        consider(node.params.body, null, node.params.index || null);
      }
      if (isPlainObject(node.request)) walk(node.request, depth + 1);
      if (Array.isArray(node.batch)) walk(node.batch, depth + 1);
      if (node.query || node.pit || Array.isArray(node.docs)) consider(node, null, node.index);

      for (const key of Object.keys(node)) {
        if (key === 'params' || key === 'request' || key === 'batch' || key === 'query') continue;
        const child = node[key];
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };

    // NDJSON (_msearch): alternating header / body lines. Trailing blanks OK.
    const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsedLines = [];
    let allLinesJson = lines.length > 0;
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        allLinesJson = false;
        break;
      }
    }

    if (allLinesJson && parsedLines.length >= 2) {
      // Kibana 7 courier `_msearch`: header, body, header, body, …
      for (let i = 0; i + 1 < parsedLines.length; i += 2) {
        const header = parsedLines[i];
        const body = parsedLines[i + 1];
        if (isPlainObject(header) && header.query && !(isPlainObject(body) && body.query)) {
          // Mis-framed: first object is already a search body.
          consider(header, null, header.index || null);
        }
        const index =
          (isPlainObject(header) && (header.index || header.INDEX)) ||
          (isPlainObject(body) && body.index) ||
          null;
        consider(body, isPlainObject(header) ? header : null, index);
      }
      if (parsedLines.length % 2 === 1) {
        const last = parsedLines[parsedLines.length - 1];
        if (isPlainObject(last) && last.query) consider(last, null, last.index || null);
      }
    } else if (allLinesJson && parsedLines.length === 1) {
      walk(parsedLines[0], 0);
    } else {
      try {
        walk(JSON.parse(bodyText), 0);
      } catch {
        return null;
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.size - a.size);
    const best = candidates[0];
    return { header: best.header, body: best.body, index: best.index };
  }

  /**
   * Prefer a plain `_search` against Kibana's ES proxy. That works the same for
   * Discover and for a dashboard saved-search panel, and paginates cleanly with
   * `search_after`. Falls back to the original URL when no index is known.
   */
  function resolveReplayUrl(templateUrl, index) {
    if (!templateUrl) return null;
    let u;
    try {
      u = new URL(templateUrl, (typeof location !== 'undefined' && location.href) || 'http://localhost/');
    } catch {
      return templateUrl;
    }
    const space = u.pathname.match(/^(\/s\/[^/]+)/);
    const prefix = space ? space[1] : '';

    if (index) {
      const idx = String(Array.isArray(index) ? index.join(',') : index)
        .split(',')
        .map((part) => encodeURIComponent(part.trim()).replace(/%2A/gi, '*'))
        .join(',');
      return `${u.origin}${prefix}/elasticsearch/${idx}/_search`;
    }

    if (u.pathname.includes('_msearch') || u.pathname.includes('_search') || u.pathname.includes('_async_search')) {
      return u.href;
    }
    return `${u.origin}${prefix}/elasticsearch/_search`;
  }

  /**
   * Turns a captured document query into a page request for `search_after`
   * pagination: strips panel-only decoration, sets the page size, and appends
   * a `_doc` tiebreaker so equal sort values cannot skip documents.
   */
  function prepareDocBody(body, pageSize) {
    const out = { ...body };
    delete out.from;
    delete out.aggs;
    delete out.aggregations;
    delete out.highlight;
    delete out.search_after;
    delete out.suggest;
    delete out.script_fields;
    out.size = pageSize;
    // Saved-search panels sometimes disable _source; turn it back on so CSV
    // export gets real field values, not just docvalues.
    if (out._source === false) out._source = true;
    let sort = out.sort;
    if (sort && !Array.isArray(sort)) sort = [sort];
    if (Array.isArray(sort) && sort.length) {
      const tiebroken = sort.some(
        (entry) => entry === '_doc' || (isPlainObject(entry) && '_doc' in entry)
      );
      out.sort = tiebroken ? sort.slice() : sort.concat('_doc');
    } else {
      out.sort = [{ '@timestamp': 'desc' }, '_doc'];
    }
    return out;
  }

  /** True when a raw request body contains at least one replayable doc query. */
  function bodyHasDocQuery(bodyText) {
    return !!pickDocRequest(bodyText);
  }

  const TIME_FIELDS = ['@timestamp', 'timestamp', 'time', '_time', 'date', '@time'];
  const LEAD_FIELDS = ['message', 'log.level', 'level', 'severity', 'log_level', 'request'];

  /**
   * Orders columns the way a log reader expects: timestamp, then the message
   * and severity, then everything else in the order it was discovered, with
   * Elasticsearch metadata pushed to the end.
   */
  function orderFields(fields) {
    const remaining = fields.slice();
    const ordered = [];
    const take = (predicate) => {
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (predicate(remaining[i])) ordered.push(remaining.splice(i, 1)[0]);
      }
    };
    for (const name of TIME_FIELDS) take((field) => field.toLowerCase() === name);
    for (const name of LEAD_FIELDS) take((field) => field.toLowerCase() === name);
    const meta = [];
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (remaining[i] === '_index' || remaining[i] === '_id') meta.push(remaining.splice(i, 1)[0]);
    }
    meta.sort();
    return ordered.concat(remaining, meta);
  }

  NS.parse = {
    isSearchUrl,
    extractHits,
    hitToRow,
    hitKey,
    flatten,
    stringifyValue,
    orderFields,
    isPlainObject,
    pickDocRequest,
    prepareDocBody,
    resolveReplayUrl,
    bodyHasDocQuery,
    MAX_BODY_BYTES
  };
})();
