/**
 * A Setup Audit Trail CSV, turned into rows. Runs in the browser, so the file itself is never uploaded, and the
 * User and Delegate User columns are dropped here: a username never leaves the visitor's machine.
 *
 * Two files are understood:
 *   - `sf data query --result-format csv` over SetupAuditTrail: CreatedDate, Action (a code), Section, Display.
 *   - the download on Setup's "View Setup Audit Trail" page: Date, User, Source Namespace Prefix, Action (the
 *     sentence, not a code), Section, Delegate User. Its dates are in the exporter's locale, so they are shown
 *     but never sorted on; the file's own order (newest first) is used instead.
 */

export const MAX_ROWS = 100_000;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text) {
  const records = [];
  let record = [], field = '', quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (source[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else field += c;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

/** Rows oldest first, at most the newest MAX_ROWS of them, and what a person should know about how they were read. */
export function trailRows(text) {
  const [header, ...records] = parseCsv(text);
  if (!header) throw new Error('The file is empty.');
  const column = (...names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const display = column('display');
  const at = column('createddate', 'date');
  const action = column('action');
  const section = column('section');
  const setupPage = display < 0;
  if (at < 0 || action < 0) throw new Error(`This does not look like a Setup Audit Trail. Expected the columns CreatedDate, Action, Section, Display (sf data query) or Date, Action, Section (the Setup page download); found: ${header.join(', ').slice(0, 200)}.`);

  const cell = (record, i) => (i < 0 ? '' : (record[i] ?? '').trim());
  let rows = records
    .map((record) => ({ at: cell(record, at), action: setupPage ? '' : cell(record, action), section: cell(record, section), display: cell(record, setupPage ? action : display) }))
    .filter((row) => row.display || row.action);
  if (!rows.length) throw new Error('The file has a header and no rows.');

  const notes = [];
  if (rows.every((row) => ISO.test(row.at))) rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  else {
    rows.reverse();
    notes.push('The dates are not in ISO format, so the rows were taken in the file\'s own order, newest first, as the Setup page writes it.');
  }
  if (rows.length > MAX_ROWS) {
    notes.push(`The file has ${rows.length.toLocaleString('en')} rows. Only the newest ${MAX_ROWS.toLocaleString('en')} are read.`);
    rows = rows.slice(-MAX_ROWS);
  }
  return { rows, notes, format: setupPage ? 'setup-page' : 'sf-cli' };
}
