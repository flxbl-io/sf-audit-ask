import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost, opusCost, PRICES } from '../src/cost.js';

test('cost: the published prices, applied to what each service reported', () => {
  assert.deepEqual(PRICES, { jevInput: 0.042, haikuInput: 1, haikuOutput: 5, opusInput: 5, opusOutput: 25 });
  assert.deepEqual(cost({ jevTokens: 1_000_000, haiku: { input: 1_000_000, output: 1_000_000 } }), { jev: 0.042, haiku: 6, total: 6.042 });
  // A question over 3,700 rows, seen live: about 220,000 tokens for Jev, a short sentence from Haiku.
  assert.deepEqual(cost({ jevTokens: 220_000, haiku: { input: 520, output: 60 } }), { jev: 0.00924, haiku: 0.00082, total: 0.01006 });
  assert.deepEqual(cost({ jevTokens: 110 }), { jev: 0.00000462, haiku: 0, total: 0.00000462 });
  assert.deepEqual(cost(), { jev: 0, haiku: 0, total: 0 });
});

test('cost: situations written by Claude Opus 5, at $5 in and $25 out a million', () => {
  // One set of six situations for a nine-decision flow, seen live: about 3,900 tokens in and 1,600 out.
  assert.equal(opusCost({ input: 3_941, output: 1_616 }), 0.060105);
  assert.equal(opusCost(), 0);
});
