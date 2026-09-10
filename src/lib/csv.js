/**
 * CSV serialisation (RFC 4180) for captured log rows.
 */
(() => {
  const NS = (globalThis.__KLE__ = globalThis.__KLE__ || {});
  if (NS.csv) return;

  /** Characters that make a spreadsheet treat a cell as a formula. */
  const FORMULA_START = /^[=+\-@\t]/;
  /** `-1`, `-0.5`, `-.2` — plain negative numbers are data, not formulas. */
  const NEGATIVE_NUMBER = /^-(\d|\.\d)/;

  function escapeCell(raw, delimiter, guardFormulas) {
    let text = raw;
    // Normalise newlines so a quoted multi-line cell stays readable.
    if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
    if (guardFormulas && FORMULA_START.test(text) && !NEGATIVE_NUMBER.test(text)) {
      text = `'${text}`;
    }
    const mustQuote =
      text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\t');
    if (!mustQuote) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }

  /**
   * @param {object[]} rows      flat row objects
   * @param {string[]} fields    column order; missing values become empty cells
   * @param {object}  [options]
   * @param {string}  [options.delimiter=',']
   * @param {boolean} [options.bom=true]           byte-order mark, for Excel
   * @param {boolean} [options.guardFormulas=true] neutralise `=`/`+`/`-`/`@` cells
   * @param {boolean} [options.header=true]
   * @param {string}  [options.newline='\r\n']
   */
  function toCsv(rows, fields, options = {}) {
    const delimiter = options.delimiter || ',';
    const newline = options.newline || '\r\n';
    const guardFormulas = options.guardFormulas !== false;
    const withHeader = options.header !== false;
    const toText = NS.parse.stringifyValue;

    const lines = [];
    if (withHeader) {
      lines.push(fields.map((f) => escapeCell(f, delimiter, false)).join(delimiter));
    }
    for (const row of rows) {
      const cells = new Array(fields.length);
      for (let i = 0; i < fields.length; i += 1) {
        cells[i] = escapeCell(toText(row[fields[i]]), delimiter, guardFormulas);
      }
      lines.push(cells.join(delimiter));
    }

    const body = lines.join(newline) + newline;
    return options.bom === false ? body : `\uFEFF${body}`;
  }

  /** `kibana-logs-20260909-142530.csv` */
  function suggestFilename(prefix = 'kibana-logs', extension = 'csv') {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const safePrefix = String(prefix).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return `${safePrefix || 'kibana-logs'}-${stamp}.${extension}`;
  }

  NS.csv = { toCsv, suggestFilename, escapeCell };
})();
