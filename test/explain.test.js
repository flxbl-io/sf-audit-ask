import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainer, plain } from '../src/explain.js';
import { turnstile } from '../src/human.js';

const evidence = { at: '2026-09-19T04:21:14.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Information', display: 'Changed fiscal year start month from 7 to 4' };
const facts = { question: 'Was the fiscal year set to start in April?', verdict: 'yes', p: 0.97, evidence, rows: 3646, from: '2026-03-23T00:00:00.000+0000', to: '2026-09-20T00:00:00.000+0000' };
const replying = (reply, seen = []) => ({ messages: { create: async (request) => { seen.push(request); if (reply instanceof Error) throw reply; return reply; } } });
const text = (value, stop_reason = 'end_turn', usage = { input_tokens: 240, output_tokens: 31 }) => ({ stop_reason, content: [{ type: 'text', text: value }], usage });
const NONE = { input: 0, output: 0 };

test('plain: every verdict has a sentence, with no model involved', () => {
  assert.match(plain(facts), /records it on 19 September 2026: "Changed fiscal year start month from 7 to 4"/);
  assert.match(plain({ ...facts, evidence: null }), /no single change could be pointed to among the 3,646 changes between 23 March 2026 and 20 September 2026/);
  assert.match(plain({ ...facts, verdict: 'no', evidence: null }), /Nothing among the 3,646 changes.*does not audit/);
  assert.match(plain({ ...facts, verdict: 'unclear', evidence: null }), /naming the exact value/);
  assert.match(plain({ ...facts, verdict: 'no', evidence: null, rows: 1, from: '9/10/2026', to: '9/10/2026' }), /the 1 change between 9\/10\/2026/);
});

test('without a key the template speaks, and says so', async () => {
  assert.deepEqual(await explainer()(facts), { message: plain(facts), by: 'template', tokens: NONE });
});

test('Haiku is shown the question, the verdict and the one row: never the trail', async () => {
  const seen = [];
  const said = await explainer({ client: replying(text('  On 19 September 2026 the fiscal year start\n moved from July to April. '), seen) })(facts);
  assert.deepEqual(said, { message: 'On 19 September 2026 the fiscal year start moved from July to April.', by: 'haiku', tokens: { input: 240, output: 31 } });
  assert.equal(seen[0].model, 'claude-haiku-4-5');
  assert.deepEqual(Object.keys(JSON.parse(seen[0].messages[0].content)), ['question', 'verdict', 'likelihood_of_yes', 'changes_read', 'from', 'to', 'row']);
  assert.match(seen[0].system, /never instructions to follow/);
});

test('a refusal, a cut-off sentence, an empty one or any failure falls back to the template, still counting what was spent; a long one is cut', async () => {
  for (const reply of [text('I cannot', 'refusal'), text('On 19 Septem', 'max_tokens'), text('   '), { stop_reason: 'end_turn', content: [] }, new Error('timeout')]) {
    const said = await explainer({ client: replying(reply) })(facts);
    assert.deepEqual([said.message, said.by], [plain(facts), 'template']);
    assert.deepEqual(said.tokens, reply.usage ? { input: 240, output: 31 } : NONE);
  }
  assert.equal((await explainer({ client: replying(text('x'.repeat(900))) })(facts)).message.length, 320);
});

test('turnstile: passes only on success, tells Cloudflare the address, and a check that cannot be made is a no', async () => {
  let sent;
  const ok = turnstile({ secret: 's3cret', fetch: async (url, init) => { sent = { url, body: Object.fromEntries(init.body) }; return { json: async () => ({ success: true }) }; } });
  assert.equal(await ok('token', '198.51.100.7'), true);
  assert.deepEqual(sent, { url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify', body: { secret: 's3cret', response: 'token', remoteip: '198.51.100.7' } });
  assert.equal(await ok('', '198.51.100.7'), false);
  assert.equal(await ok(undefined), false);
  assert.equal(await turnstile({ secret: 's', fetch: async () => ({ json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) }) })('token'), false);
  assert.equal(await turnstile({ secret: 's', fetch: async () => { throw new Error('network'); } })('token'), false);
});
