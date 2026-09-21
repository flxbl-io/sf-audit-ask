import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jev } from '../src/jev.js';

const reply = (status, json, headers = {}) => ({ status, ok: status < 300, headers: new Headers(headers), json: async () => json });
const KEY = 'secret-key-never-shown';
const lines = Array.from({ length: 350 }, (_, i) => `row ${i + 1}`);

test('judge: sends the page once, as state, and reads the noul', async () => {
  let sent;
  const { judge } = jev({ apiKey: KEY, fetch: async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return reply(200, { answers: { yes: { noul: 0.91 } }, usage: { input_tokens: 1234 } }); } });
  assert.deepEqual(await judge('q?', ['a', 'b']), { p: 0.91, tokens: 1234 });
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.body.model, 'jev-1.13.0');
  assert.deepEqual(sent.body.state, { question: 'q?', audit_trail: ['a', 'b'] });
  assert.deepEqual(Object.keys(sent.body.questions), ['yes']);
});

test('judge: an unreadable answer is an error, not a no', async () => {
  for (const answers of [{}, { yes: { noul: 'high' } }, { yes: { noul: 1.2 } }]) {
    const { judge } = jev({ apiKey: KEY, fetch: async () => reply(200, { answers }) });
    await assert.rejects(judge('q?', ['a']), /unreadable/);
  }
});

test('judge: a throttled read is asked again; too large is told apart; the key is in no error', async () => {
  let calls = 0;
  const throttled = jev({ apiKey: KEY, fetch: async () => (++calls < 3 ? reply(429, {}, { 'retry-after': '0.001' }) : reply(200, { answers: { yes: { noul: 0.5 } } })) });
  assert.equal((await throttled.judge('q?', ['a'])).p, 0.5);
  assert.equal(calls, 3);
  const large = jev({ apiKey: KEY, fetch: async () => reply(400, { detail: { error_type: 'max_tokens_exceeded' } }) });
  await assert.rejects(large.judge('q?', ['a']), (error) => error.code === 'too_large' && !error.message.includes(KEY));
  const down = jev({ apiKey: KEY, fetch: async () => reply(500, { detail: `bad key ${KEY}` }) });
  await assert.rejects(down.judge('q?', ['a']), (error) => error.code === 'jev' && !error.message.includes(KEY));
  assert.throws(() => jev({ apiKey: '' }), /TYPESAFE_API_KEY/);
});

test('locate: every line is offered once, in ranges of at most 255 options, and the surest pick wins', async () => {
  let body;
  const { locate } = jev({ apiKey: KEY, fetch: async (url, init) => {
    body = JSON.parse(init.body);
    return reply(200, { usage: { input_tokens: 9 }, answers: { where_0: { choice: 'NONE', probabilities: { NONE: 0.9 } }, where_200: { choice: '317', probabilities: { 317: 0.88 } } } });
  } });
  assert.deepEqual(await locate('q?', lines), { index: 316, p: 0.88, tokens: 9 });
  assert.equal(body.state.audit_trail[316], '[317] row 317');
  const offered = Object.values(body.questions).map((q) => Object.keys(q.criteria));
  assert.ok(offered.every((ids) => ids.length <= 255 && ids.includes('NONE')));
  assert.deepEqual(offered.flat().filter((id) => id !== 'NONE').map(Number).sort((a, b) => a - b), lines.map((_, i) => i + 1));
});

test('locate: NONE, an unsure pick, a line that was not offered, or a malformed answer names no row', async () => {
  for (const where_0 of [{ choice: 'NONE', probabilities: { NONE: 1 } }, { choice: '3', probabilities: { 3: 0.3 } }, { choice: '999', probabilities: { 999: 0.99 } }, { choice: '3' }, undefined]) {
    const { locate } = jev({ apiKey: KEY, fetch: async () => reply(200, { answers: { where_0 } }) });
    assert.equal((await locate('q?', lines.slice(0, 10))).index, null);
  }
});
