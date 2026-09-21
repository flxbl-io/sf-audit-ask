import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ROWS, parseCsv, trailRows } from '../public/csv.js';

test('quotes, doubled quotes, commas and line breaks inside a field, CRLF and a BOM', () => {
  const text = '﻿a,b\r\n"x, ""y""","line one\nline two"\r\nlast,\r\n';
  assert.deepEqual(parseCsv(text), [['a', 'b'], ['x, "y"', 'line one\nline two'], ['last', '']]);
});

test('the sf CLI file: codes kept, usernames dropped, sorted oldest first', () => {
  const { rows, format, notes } = trailRows([
    'CreatedDate,CreatedBy.Username,Action,Section,Display,DelegateUser',
    '2026-09-19T04:21:14.000+0000,admin@example.com,orgFiscalYearStartMonth,Company Information,Changed fiscal year start month from 7 to 4,',
    '2026-09-19T04:09:53.000+0000,admin@example.com,orgFiscalYearStartMonth,Company Information,Changed fiscal year start month from 1 to 7,delegate@example.com',
  ].join('\n'));
  assert.equal(format, 'sf-cli');
  assert.deepEqual(notes, []);
  assert.deepEqual(rows.map((r) => r.display), ['Changed fiscal year start month from 1 to 7', 'Changed fiscal year start month from 7 to 4']);
  assert.deepEqual(Object.keys(rows[0]), ['at', 'action', 'section', 'display']);
  assert.ok(!JSON.stringify(rows).includes('example.com'));
});

test('the Setup page file: Action is the sentence, the dates are not sorted on, the file order is reversed', () => {
  const { rows, format, notes } = trailRows([
    'Date,User,Source Namespace Prefix,Action,Section,Delegate User',
    '"9/10/2026, 4:21:14 AM PDT",admin@example.com,,Changed fiscal year start month from 7 to 4,Company Information,',
    '"9/10/2026, 4:09:53 AM PDT",admin@example.com,,Changed fiscal year start month from 1 to 7,Company Information,',
  ].join('\n'));
  assert.equal(format, 'setup-page');
  assert.equal(rows[0].action, '');
  assert.deepEqual(rows.map((r) => r.display), ['Changed fiscal year start month from 1 to 7', 'Changed fiscal year start month from 7 to 4']);
  assert.match(notes[0], /file's own order/);
  assert.ok(!JSON.stringify(rows).includes('example.com'));
});

test('only the newest rows of a file over the cap are kept, and it says so', () => {
  const lines = ['CreatedDate,Action,Section,Display'];
  for (let i = 0; i < MAX_ROWS + 5; i++) lines.push(`${new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()},code,,row ${i}`);
  const { rows, notes } = trailRows(lines.join('\n'));
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(rows[0].display, 'row 5');
  assert.match(notes[0], /Only the newest 100,000/);
});

test('a file that is not a trail says what was expected', () => {
  assert.throws(() => trailRows('name,email\nA,a@example.com'), /does not look like a Setup Audit Trail/);
  assert.throws(() => trailRows(''), /empty/);
  assert.throws(() => trailRows('CreatedDate,Action,Section,Display\n'), /no rows/);
});
