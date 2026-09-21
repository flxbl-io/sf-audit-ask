import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressKey, attempts, clientAddress } from '../src/limits.js';

test('five attempts, then refused until the oldest leaves the window', () => {
  let clock = 1_000;
  const limit = attempts({ max: 5, windowMs: 100, now: () => clock });
  for (let i = 0; i < 5; i++) assert.deepEqual(limit.take(['ip:1']), { ok: true, left: 4 - i }, `attempt ${i + 1}`), clock++;
  assert.deepEqual(limit.take(['ip:1']), { ok: false, left: 0, retryAt: 1_100 });
  clock = 1_101;
  assert.equal(limit.take(['ip:1']).ok, true);
});

test('either key used up refuses: a new browser id from the same address, or the same browser from a new address', () => {
  const limit = attempts({ max: 5 });
  for (let i = 0; i < 5; i++) limit.take(['ip:1', 'browser:a']);
  assert.equal(limit.take(['ip:1', 'browser:b']).ok, false);
  assert.equal(limit.take(['ip:2', 'browser:a']).ok, false);
  assert.equal(limit.take(['ip:1']).ok, false);
  assert.equal(limit.take(['ip:2', 'browser:b']).ok, true);
});

test('a refused attempt counts against nothing, and a refund gives one back', () => {
  const limit = attempts({ max: 2 });
  limit.take(['ip:1', 'browser:a']);
  limit.take(['ip:1', 'browser:a']);
  assert.equal(limit.take(['ip:1', 'browser:b']).ok, false);
  assert.equal(limit.left(['browser:b']), 2);
  limit.refund(['ip:1', 'browser:a']);
  assert.equal(limit.left(['ip:1', 'browser:a']), 1);
});

test('sweep forgets keys whose attempts are all old', () => {
  let clock = 0;
  const limit = attempts({ max: 5, windowMs: 10, now: () => clock });
  limit.take(['ip:1', 'browser:a']);
  clock = 11;
  assert.equal(limit.sweep(), 0);
});

test('an IPv6 visitor is their /64, an IPv4-mapped address is the IPv4 one', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), addressKey('2001:0db8:1:2::1'));
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
});

test('x-forwarded-for is believed only as far as the proxies that are trusted', () => {
  const request = { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientAddress(request), '10.0.0.1');
  assert.equal(clientAddress(request, { trustedProxies: 1 }), '203.0.113.9');
  assert.equal(clientAddress({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }, { trustedProxies: 1 }), '10.0.0.1');
  const viaCloudflare = { headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientAddress(viaCloudflare, { header: 'CF-Connecting-IP' }), '198.51.100.7');
  assert.equal(clientAddress(viaCloudflare), '127.0.0.1', 'the header is ignored unless asked for');
});

import { redisAttempts, redisCommand } from '../src/limits.js';
import { passes } from '../src/human.js';

test('redis counter: one script call per take, keys stored as hashes, the counted attempt is the one refunded', async () => {
  const sent = [];
  const replies = [[1, 4, 0], [0, 0, 1_700_000_000_000], 2];
  const limit = redisAttempts({ command: async (args) => { sent.push(args); return replies.shift(); }, hash: (key) => `h(${key})`, max: 5, windowMs: 1000, now: () => 5000 });
  const taken = await limit.take(['ip:1', 'browser:a']);
  assert.equal(taken.ok, true);
  assert.equal(taken.left, 4);
  assert.deepEqual(sent[0].slice(0, 1).concat(sent[0].slice(2, 8)), ['EVAL', '2', 'asks:h(ip:1)', 'asks:h(browser:a)', '5000', '1000', '5']);
  assert.ok(!JSON.stringify(sent[0].slice(2)).includes('ip:1"'), 'no raw key is sent to the store');
  assert.deepEqual(await limit.take(['ip:1']), { ok: false, left: 0, retryAt: 1_700_000_000_000 });
  assert.equal(await limit.left(['ip:1']), 2);
  sent.length = 0; replies.push(1, 1);
  await limit.refund(['ip:1', 'browser:a'], taken);
  assert.deepEqual(sent, [['ZREM', 'asks:h(ip:1)', taken.member], ['ZREM', 'asks:h(browser:a)', taken.member]]);
});

test('redis command: Upstash REST, and a store that does not answer is an error, not a free pass', async () => {
  let seen;
  const ok = redisCommand({ url: 'https://example.upstash.io/', token: 'tok', fetch: async (url, init) => { seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ result: 7 }) }; } });
  assert.equal(await ok(['ZCARD', 'k']), 7);
  assert.deepEqual(seen, { url: 'https://example.upstash.io', auth: 'Bearer tok', body: ['ZCARD', 'k'] });
  await assert.rejects(redisCommand({ url: 'https://x', token: 't', fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'ERR' }) }) })(['PING']), /did not answer/);
});

test('human pass: good from the same address until it ends; forged, altered, late or borrowed is refused', () => {
  let clock = 1_000_000_000_000;
  const humans = passes({ secret: 's3cret', ttlMs: 1000, now: () => clock });
  const { pass, until } = humans.issue('203.0.113.9');
  assert.equal(until, clock + 1000);
  assert.equal(humans.check(pass, '203.0.113.9'), true);
  assert.equal(humans.check(pass, '203.0.113.10'), false);
  assert.equal(humans.check(`${until + 99999}.${pass.split('.')[1]}`, '203.0.113.9'), false, 'a later end date with the old signature');
  assert.equal(passes({ secret: 'other', now: () => clock }).check(pass, '203.0.113.9'), false);
  for (const junk of [undefined, '', 'abc', '123.', `${until}.`, {}]) assert.equal(humans.check(junk, '203.0.113.9'), false);
  clock += 1001;
  assert.equal(humans.check(pass, '203.0.113.9'), false);
});
