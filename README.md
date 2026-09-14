# Logstash Log Yanker

A Chrome extension that yanks the logs you're looking at in Kibana / Logstash Discover and
saves them as CSV or JSON. Everything happens locally in your browser — no data is sent anywhere.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Open the extension popup → **Settings** (gear). Enter your Kibana URL and click
   **Apply** (or **Done**). Allow Chrome's permission prompt.
4. Reload your Kibana tab. Click the extension icon — if it isn't connected, click
   **Connect to this tab**, then reload the Kibana tab once more so capture starts
   from page load.

The toolbar icon shows a running count of captured rows for the tab.

### It only runs on the host you choose

No Kibana host is baked into the extension. Set yours in **Settings**: enter the URL
and click **Apply** or **Done**. Chrome asks to allow that site, content scripts are
registered for it (and injected into matching open tabs), and the choice persists in
extension storage. **Connect to this tab** also grants and saves the current tab's
origin. After the first grant, reload the Kibana tab so hooks run from page load —
that is what makes Fetch reliable.

## How it works

The flow is two clicks: open the popup, hit **Fetch**, save.

The big button — labelled **Fetch all N results**, or **Fetch first 3000 of N** when the
search matches more — re-runs the current search directly against Elasticsearch (with the
page's own session, so nothing extra to configure) and pulls the newest **3000** matching
documents at most (in pages of 500). It works from **Discover** and from a **dashboard saved-search panel**
(the log table). Visualization-only panels are ignored. It keeps the exact index, query,
filters and time range Kibana used and drops the aggregations. Every fetch starts fresh, so
the buffer always reflects the current search; want a different slice, narrow the query or
time range in Kibana and fetch again.

Nothing is captured while you browse — the extension only *watches* Kibana's searches to
know what to replay, which is what arms the Fetch button.

There is deliberately no DOM scraping: scraped cells are lossy (local-time timestamps with
milliseconds dropped, truncated long values, display-only formatting), and on dashboards the
biggest table is usually an aggregation panel, not your logs.

Duplicates are dropped automatically, by document ID where there is one.

## Exporting

**Save CSV** writes a spreadsheet-ready file. **Save JSON** writes a JSON array of objects
instead — values keep their raw types there (numbers stay numbers, multi-value fields stay
arrays, nested paths stay dotted keys), which makes it the better choice for `jq`, scripts,
or re-indexing.

Pick the columns you want in the **Columns** list — everything is selected by default, and the
number beside each field is how many captured rows actually have a value for it, which makes it
easy to spot the fields worth keeping. Your choices are remembered per host.

The two options worth knowing about:

The two format options live in **Settings** (gear icon), persisted in extension storage:

- **Byte-order mark** — leave it on if you open CSVs in Excel, otherwise accented and non-Latin
  characters come out garbled. The separator is always a comma.
- **Prefix cells starting with `=` or `+`** — leave it on. Log content is untrusted input, and a
  message beginning with `=` would otherwise be run as a formula when the file is opened.
  Plain negative numbers (`-12.5`) are recognised as data and left alone.

Nested fields become dotted columns (`http.response.status_code`). In CSV, multi-value fields
are joined with `; ` and unflattenable objects are written as JSON strings; in JSON they stay
arrays and objects.

## Things to know

- The buffer lives in the page, so a full page reload clears it. Moving around inside Kibana is
  fine — only a real reload resets things. Each **Fetch** also replaces it.
- The 3000-document cap is hard-coded (`MAX_ROWS` in `src/content.js`); fetches page in chunks of 500.
- **Copy** is limited to about 4 MB; past that, save the file instead.

## Development

```sh
node tools/selftest.js      # parsing, search-replay helpers and CSV serialisation
python3 tools/make-icons.py # regenerate the toolbar icons
```

For the browser-based checks (which also cover machines without node), serve the folder and
open the pages:

```sh
python3 -m http.server 8731 --bind 127.0.0.1
# http://127.0.0.1:8731/tools/selftest.html     — the selftest, run in the browser
# http://127.0.0.1:8731/tools/integration.html  — end-to-end checks
node tools/preview.js       # then open .preview/popup.html — the popup with stub data
```

`tools/integration.html` runs the real interceptor and content script against a mock
paginating `_msearch` endpoint, covering capture, the fetch-all replay, deduplication, export
and the CSV output. Headless, if Chrome is installed:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --user-data-dir=/tmp/kle-test --proxy-server="direct://" --virtual-time-budget=10000 \
  --dump-dom http://127.0.0.1:8731/tools/integration.html | grep -E 'ok|FAIL|passed'
```

### Layout

| Path                 | Role                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `src/interceptor.js` | Runs in the page's JS context; watches `fetch`/`XHR` for searches and keeps the last document query as a replay template |
| `src/content.js`     | Holds the captured rows, replays the template with `search_after` (Fetch all results), writes the file |
| `src/lib/parse.js`   | Pulls hits out of any Elasticsearch response shape; flattens them; picks and prepares the replayable document query |
| `src/lib/csv.js`     | RFC 4180 CSV serialisation                                            |
| `src/popup.*`        | The panel behind the toolbar icon                                     |
| `src/background.js`  | Keeps the badge in sync; registers the content scripts for the configured Kibana URL |
