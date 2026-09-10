#!/usr/bin/env node
/**
 * Builds a standalone copy of the popup with the `chrome.*` APIs stubbed out
 * and fake capture data, so the layout can be opened in a plain browser tab.
 *
 * Run from the project root:  node tools/preview.js
 * Then open the printed file:// URL.
 */

const fs = require('fs');
const path = require('path');

const root = path.dirname(__dirname);
const src = path.join(root, 'src');
const outFile = path.join(root, '.preview', 'popup.html');

const STUB = `<script>
// --- test double for the extension APIs ---------------------------------
const FIELDS = [
  ['@timestamp', 1284], ['message', 1284], ['log.level', 1281], ['host.name', 1284],
  ['service.name', 1120], ['http.request.method', 902], ['http.response.status_code', 902],
  ['url.path', 902], ['client.ip', 884], ['user.name', 431], ['trace.id', 388],
  ['error.stack_trace', 46], ['kubernetes.pod.name', 1284], ['_index', 1284], ['_id', 1284]
].map(([name, filled]) => ({ name, filled }));

const ACTIVITY = [0,0,0,0,0,2,9,14,11,6,3,0,0,0,7,22,31,26,18,9,4,1,0,0,0,0,5,12,19,24,
                  17,11,28,41,33,20,12,6,15,23];

window.chrome = {
  runtime: { lastError: null },
  tabs: {
    query: async () => [{ id: 1, url: 'https://kibana.corp.example.com/app/discover' }],
    sendMessage: (_id, message, reply) => {
      if (message.type === 'kle:status') {
        reply({
          ok: true, host: 'kibana.corp.example.com', kibana: true, sawNetwork: true,
          capturing: true, rowCount: 1284, maxRows: 50000, fields: FIELDS, activity: ACTIVITY
        });
      } else {
        reply({ ok: true });
      }
    }
  },
  storage: { local: { get: async (defaults) => defaults, set: () => {} } }
};
</script>`;

const html = fs
  .readFileSync(path.join(src, 'popup.html'), 'utf8')
  .replace('<link rel="stylesheet" href="popup.css" />', '<link rel="stylesheet" href="../src/popup.css" />')
  .replace('<script src="popup.js"></script>', `${STUB}\n    <script src="../src/popup.js"></script>`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`file://${outFile}`);
