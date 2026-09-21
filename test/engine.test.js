import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ROWS, PAGE_ROWS, answer, line, paginate, prepare } from '../src/engine.js';
import { semaphore } from '../src/limits.js';

const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
const noise = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ at: at(from + i), action: 'deleteScratchOrg', section: '', display: `Deleted scratch org with ID: 00D${from + i}` }));
const fiscal = (i, a, b) => ({ at: at(i), action: 'orgFiscalYearStartMonth', section: 'Company Information', display: `Changed fiscal year start month from ${a} to ${b}` });
const gate = semaphore(8);
const QUESTION = 'Was the fiscal year set to start in April?';
/** Says yes to a page holding the row "to 4", as Jev would. */
const fake = (seen = []) => async (question, lines) => { seen.push(lines); return { p: lines.some((l) => l.includes('from 7 to 4')) ? 0.95 : 0.03, tokens: lines.length * 60 }; };

test('prepare: newest rows kept, whatever order they came in, and a changed-again setting reduced to its last row', () => {
  const rows = [fiscal(10, 1, 7), ...noise(5, 20), fiscal(30, 7, 4), { at: at(40), action: 'x', section: '', display: 'Contacts to Multiple Accounts Enabled' }, { at: at(41), action: 'x', section: '', display: 'Contacts to Multiple Accounts Disabled' }];
  const trail = prepare([...rows].reverse());
  assert.equal(trail.superseded, 2);
  assert.deepEqual(trail.rows.map((r) => r.display).filter((d) => !d.startsWith('Deleted')), ['Changed fiscal year start month from 7 to 4', 'Contacts to Multiple Accounts Disabled']);
  assert.equal(trail.rows[0].at, at(20));
});

test('prepare: over the cap, the oldest rows are the ones cut', () => {
  const trail = prepare(noise(MAX_ROWS + 10));
  assert.equal(trail.cut, 10);
  assert.equal(trail.rows.length, MAX_ROWS);
  assert.equal(trail.from, at(10));
});

test('prepare: dates that are not ISO are never sorted on', () => {
  const rows = [{ at: '9/10/2026, 4:09 AM', action: '', section: '', display: 'first' }, { at: '10/9/2026, 4:21 AM', action: '', section: '', display: 'second' }];
  assert.deepEqual(prepare(rows).rows.map((r) => r.display), ['first', 'second']);
});

test('paginate: the matching row is on page 1 however deep it is buried, and a page reads oldest first', () => {
  const trail = prepare([fiscal(0, 7, 4), ...noise(PAGE_ROWS * 4, 1)]);
  const pages = paginate(trail, QUESTION);
  assert.equal(pages.length, 5);
  assert.ok(pages[0].some((entry) => entry.row.display.includes('from 7 to 4')));
  const times = pages[0].map((entry) => entry.row.at);
  assert.deepEqual(times, [...times].sort());
});

const pointsAt = (needle) => async (question, lines) => ({ index: lines.findIndex((l) => l.includes(needle)), tokens: 10 });

test('answer: a yes stops the sweep, and shows the row Jev points to', async () => {
  const seen = [];
  const result = await answer(prepare([fiscal(0, 7, 4), ...noise(PAGE_ROWS * 40, 1)]), QUESTION, { judge: fake(seen), locate: pointsAt('from 7 to 4'), gate, workers: 4 });
  assert.equal(result.verdict, 'yes');
  assert.equal(result.p, 0.95);
  assert.equal(result.pages, 41);
  assert.ok(result.requests <= 9, `made ${result.requests} requests`);
  assert.match(result.evidence.display, /from 7 to 4/);
});

test('answer: no row found, a row that does not exist, or a failing locate shows no row and is still a yes', async () => {
  const trail = prepare([fiscal(0, 7, 4), ...noise(20, 1)]);
  for (const locate of [async () => ({ index: null, tokens: 1 }), async () => ({ index: 9999, tokens: 1 }), async () => { throw new Error('down'); }, undefined]) {
    const result = await answer(trail, QUESTION, { judge: fake(), locate, gate });
    assert.equal(result.verdict, 'yes');
    assert.equal(result.evidence, null);
  }
});

test('answer: a no is never given a row', async () => {
  let asked = 0;
  const result = await answer(prepare(noise(20)), QUESTION, { judge: fake(), locate: async () => { asked++; return { index: 0, tokens: 1 }; }, gate });
  assert.equal(result.evidence, null);
  assert.equal(asked, 0);
});

test('answer: a no has read every row, once', async () => {
  const seen = [];
  const trail = prepare(noise(PAGE_ROWS * 3 + 7));
  const result = await answer(trail, QUESTION, { judge: fake(seen), gate });
  assert.equal(result.verdict, 'no');
  assert.equal(result.requests, 4);
  assert.deepEqual(seen.flat().sort(), trail.rows.map(line).sort());
});

test('answer: between the two cutoffs it is unclear, not yes', async () => {
  const result = await answer(prepare(noise(10)), QUESTION, { judge: async () => ({ p: 0.7, tokens: 1 }), gate });
  assert.equal(result.verdict, 'unclear');
});

test('answer: a page Jev refuses as too large is read as two halves', async () => {
  const sizes = [];
  const judge = async (question, lines) => {
    sizes.push(lines.length);
    if (lines.length > 100) throw Object.assign(new Error('too large'), { code: 'too_large' });
    return { p: 0.02, tokens: 1 };
  };
  const result = await answer(prepare(noise(300)), QUESTION, { judge, gate });
  assert.equal(result.verdict, 'no');
  assert.equal(sizes.filter((n) => n <= 100).reduce((a, b) => a + b, 0), 300);
});

test('answer: a failing page fails the question; it is not read as a no', async () => {
  const judge = async () => { throw Object.assign(new Error('Jev refused the request (500 error)'), { code: 'jev' }); };
  await assert.rejects(answer(prepare(noise(PAGE_ROWS * 3)), QUESTION, { judge, gate }), /Jev refused/);
});

test('answer: never more requests in flight than the shared gate allows, across questions', async () => {
  let running = 0, most = 0;
  const judge = async () => { most = Math.max(most, ++running); await new Promise((r) => setTimeout(r, 2)); running--; return { p: 0.01, tokens: 1 }; };
  const shared = semaphore(3);
  const trail = prepare(noise(PAGE_ROWS * 6));
  await Promise.all([answer(trail, QUESTION, { judge, gate: shared }), answer(trail, QUESTION, { judge, gate: shared })]);
  assert.equal(most, 3);
});
