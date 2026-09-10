#!/usr/bin/env node
/**
 * Checks the response parsing, search-replay helpers and CSV serialisation
 * against the payload shapes different Kibana / Elasticsearch versions return.
 *
 * Run from the project root:  node tools/selftest.js
 * No node installed? Serve the project and open tools/selftest.html instead.
 */

if (typeof window === 'undefined') {
  const fs = require('fs');
  const path = require('path');
  const root = path.dirname(__dirname);
  for (const file of ['src/lib/parse.js', 'src/lib/csv.js']) {
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
}
const { parse, csv } = globalThis.__KLE__;

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}\n         expected ${b}\n         actual   ${a}`);
  }
}

const hit = (id, source, extra = {}) => ({ _index: 'logstash-2026.09.09', _id: id, _source: source, ...extra });

console.log('response shapes');
{
  // Elasticsearch 7/8 `_search`
  const body = JSON.stringify({
    took: 5,
    hits: { total: { value: 2 }, hits: [hit('a', { message: 'one' }), hit('b', { message: 'two' })] }
  });
  check('plain _search', parse.extractHits(body).length, 2);

  // `_msearch` — several responses in one body
  const msearch = JSON.stringify({
    responses: [
      { hits: { hits: [hit('a', { message: 'one' })] } },
      { hits: { hits: [hit('b', { message: 'two' })] } }
    ]
  });
  check('_msearch responses[]', parse.extractHits(msearch).length, 2);

  // Kibana 7/8 bsearch: NDJSON, one envelope per line, sometimes length-prefixed
  const bsearch =
    '84\n' +
    JSON.stringify({ id: 0, result: { rawResponse: { hits: { hits: [hit('a', { message: 'one' })] } } } }) +
    '\n' +
    JSON.stringify({ id: 1, result: { rawResponse: { hits: { hits: [hit('b', { message: 'two' })] } } } }) +
    '\n';
  check('bsearch ndjson', parse.extractHits(bsearch).length, 2);

  // Async search
  const asyncSearch = JSON.stringify({
    is_partial: false,
    response: { hits: { hits: [hit('a', { message: 'one' })] } }
  });
  check('_async_search', parse.extractHits(asyncSearch).length, 1);

  // Already-parsed object (XHR responseType: "json")
  check('parsed object input', parse.extractHits({ hits: { hits: [hit('a', {})] } }).length, 1);

  // The matching-document count rides along on the returned array
  check(
    'total captured (rest_total_hits_as_int)',
    parse.extractHits({ hits: { total: 133968, hits: [hit('a', {})] } }).total,
    { value: 133968, gte: false }
  );
  check(
    'total captured (object form, gte)',
    parse.extractHits({ hits: { total: { value: 10000, relation: 'gte' }, hits: [hit('a', {})] } }).total,
    { value: 10000, gte: true }
  );
  check('no docs, no total', parse.extractHits({ hits: { total: 7, hits: [] } }).total, undefined);

  // Garbage must not throw or invent rows
  check('empty body', parse.extractHits('').length, 0);
  check('html error page', parse.extractHits('<html>502</html>').length, 0);
  check('null', parse.extractHits(null).length, 0);

  // A `_source` field literally named "hits" must not be mistaken for an envelope
  const decoy = JSON.stringify({ hits: { hits: [hit('a', { hits: { hits: [1, 2, 3] } })] } });
  check('does not walk into _source', parse.extractHits(decoy).length, 1);
}

console.log('url matching');
{
  const urls = {
    'https://kibana.corp/internal/bsearch?compress=true': true,
    'https://kibana.corp/elasticsearch/_msearch': true,
    'https://kibana.corp/internal/search/ese': true,
    'https://es.corp:9200/logstash-*/_search': true,
    'https://kibana.corp/api/status': false,
    'https://kibana.corp/bundles/app.js': false
  };
  for (const [url, expected] of Object.entries(urls)) {
    check(url.slice(0, 52), parse.isSearchUrl(url), expected);
  }
}

console.log('row flattening');
{
  const row = parse.hitToRow(
    hit('a', {
      '@timestamp': '2026-09-09T12:00:00.000Z',
      message: 'GET /health 200',
      http: { response: { status_code: 200 }, request: { method: 'GET' } },
      tags: ['beats', 'nginx'],
      empty: {}
    })
  );
  check('dotted paths', row['http.response.status_code'], 200);
  check('nested method', row['http.request.method'], 'GET');
  check('array kept whole', row.tags, ['beats', 'nginx']);
  check('empty object', row.empty, '');
  check('metadata attached', [row._id, row._index], ['a', 'logstash-2026.09.09']);

  // `fields` responses wrap values in arrays; `_source` wins where both exist
  const withFields = parse.hitToRow({
    _id: 'b',
    _source: { message: 'from source' },
    fields: { message: ['from fields'], 'host.name': ['web-01'], ips: ['10.0.0.1', '10.0.0.2'] }
  });
  check('_source wins over fields', withFields.message, 'from source');
  check('single field unwrapped', withFields['host.name'], 'web-01');
  check('multi-value field kept', withFields.ips, ['10.0.0.1', '10.0.0.2']);
}

console.log('deduplication');
{
  const a = hit('same-id', { message: 'one' });
  const b = hit('same-id', { message: 'one' });
  check('same _id, same key', parse.hitKey(a, parse.hitToRow(a)) === parse.hitKey(b, parse.hitToRow(b)), true);

  const c = hit('other-id', { message: 'one' });
  check('different _id, different key', parse.hitKey(a, parse.hitToRow(a)) === parse.hitKey(c, parse.hitToRow(c)), false);

  // Hits without an _id (aggregation top_hits, some proxies) fall back to content
  const anon = { message: 'one', level: 'info' };
  const same = { level: 'info', message: 'one' };
  check('id-less rows keyed by content', parse.hitKey(null, anon) === parse.hitKey(null, same), true);
  check('different content differs', parse.hitKey(null, anon) === parse.hitKey(null, { message: 'two' }), false);
}

console.log('column order');
{
  check(
    'timestamp then message then rest, metadata last',
    parse.orderFields(['_id', 'host.name', 'message', '_index', '@timestamp', 'log.level']),
    ['@timestamp', 'message', 'log.level', 'host.name', '_id', '_index']
  );
}

console.log('csv output');
{
  const rows = [
    { a: 'plain', b: 'has,comma', c: 'has"quote' },
    { a: 'line\nbreak', b: '=cmd|calc', c: null },
    { a: 42, b: true, c: { nested: 1 } }
  ];
  const out = csv.toCsv(rows, ['a', 'b', 'c'], { bom: false });
  const lines = out.trimEnd().split('\r\n');

  check('header', lines[0], 'a,b,c');
  check('comma quoted', lines[1], 'plain,"has,comma","has""quote"');
  // The guard prefix alone needs no quoting — there is no delimiter in the cell.
  check('newline quoted, formula guarded', lines[2], '"line\nbreak",\'=cmd|calc,');
  check(
    'formula guard combines with quoting',
    csv.toCsv([{ a: '=SUM(A1,A2)' }], ['a'], { bom: false }).trimEnd(),
    'a\r\n"\'=SUM(A1,A2)"'
  );
  check('numbers, booleans, objects', lines[3], '42,true,"{""nested"":1}"');

  check('bom on by default', csv.toCsv([{ a: 1 }], ['a']).charCodeAt(0), 0xfeff);
  check('bom off', csv.toCsv([{ a: 1 }], ['a'], { bom: false }).charCodeAt(0), 'a'.charCodeAt(0));
  check(
    'semicolon delimiter re-quotes',
    csv.toCsv([{ a: 'x;y', b: 'p,q' }], ['a', 'b'], { bom: false, delimiter: ';' }).trimEnd(),
    'a;b\r\n"x;y";p,q'
  );
  check('negative number not guarded', csv.toCsv([{ a: -42 }], ['a'], { bom: false }).trimEnd(), 'a\r\n-42');
  check('negative decimal not guarded', csv.toCsv([{ a: '-.5' }], ['a'], { bom: false }).trimEnd(), 'a\r\n-.5');
  check('minus-word still guarded', csv.toCsv([{ a: '-cmd' }], ['a'], { bom: false }).trimEnd(), "a\r\n'-cmd");
  check(
    'formula guard can be turned off',
    csv.toCsv([{ a: '=1+1' }], ['a'], { bom: false, guardFormulas: false }).trimEnd(),
    'a\r\n=1+1'
  );
  check('missing field becomes empty cell', csv.toCsv([{ a: 1 }], ['a', 'zz'], { bom: false }).trimEnd(), 'a,zz\r\n1,');
  check('filename shape', /^logstash-logs-\d{8}-\d{6}\.csv$/.test(csv.suggestFilename()), true);
  check('filename prefix sanitised', /^my-logs-\d{8}-\d{6}\.csv$/.test(csv.suggestFilename('my/logs')), true);
}

console.log('search replay');
{
  // A dashboard batch: two size:0 aggregation queries around the document query.
  const msearch =
    JSON.stringify({ index: ['access-logs-*'], ignore_unavailable: true }) + '\n' +
    JSON.stringify({ size: 0, query: { match_all: {} }, aggs: { by_status: {} } }) + '\n' +
    JSON.stringify({ index: ['access-logs-*'], ignore_unavailable: true }) + '\n' +
    JSON.stringify({ size: 500, sort: [{ '@timestamp': { order: 'desc' } }], query: { bool: {} } }) + '\n' +
    JSON.stringify({ index: ['access-logs-*'] }) + '\n' +
    JSON.stringify({ size: 0, query: { match_all: {} } }) + '\n';
  const picked = parse.pickDocRequest(msearch);
  check('picks the document query out of a batch', picked && picked.body.size, 500);
  check('keeps its msearch header', picked && picked.header.index, ['access-logs-*']);

  const single = parse.pickDocRequest(JSON.stringify({ query: { match_all: {} }, size: 100 }));
  check('plain _search body accepted', single && [single.header, single.body.size], [null, 100]);

  check('aggregation-only batch rejected',
    parse.pickDocRequest(JSON.stringify({ index: [] }) + '\n' + JSON.stringify({ size: 0, query: {} }) + '\n'),
    null);
  check('garbage rejected', parse.pickDocRequest('not json'), null);

  const page = parse.prepareDocBody(picked.body, 1000);
  check('page size applied', page.size, 1000);
  check('_doc tiebreaker appended', page.sort, [{ '@timestamp': { order: 'desc' } }, '_doc']);
  check('tiebreaker not doubled', parse.prepareDocBody(page, 1000).sort.length, 2);
  const heavy = parse.prepareDocBody(
    { query: {}, sort: ['@timestamp'], from: 20, aggs: { x: {} }, highlight: { fields: {} }, search_after: [1] },
    500
  );
  check('from/aggs/highlight/search_after stripped',
    ['from', 'aggs', 'highlight', 'search_after'].filter((k) => k in heavy), []);
  check(
    'sortless query gets a default time sort',
    parse.prepareDocBody({ query: {} }, 10).sort,
    [{ '@timestamp': 'desc' }, '_doc']
  );
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
if (typeof process !== 'undefined') process.exit(failures ? 1 : 0);
else window.__selftestFailures = failures;
