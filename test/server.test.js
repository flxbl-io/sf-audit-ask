import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createApp, fromEnv } from '../server.js';

const rows = [
  { at: '2026-09-19T04:21:14.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Information', display: 'Changed fiscal year start month from 7 to 4' },
  { at: '2026-09-19T04:20:31.000+0000', action: 'changedDefaultWorkflowUser', section: 'Process Automation Settings', display: 'Changed Default Workflow User from User User to Integration User' },
];
const APRIL = 'Was the fiscal year set to start in April?';
let judged = 0, failing = false;
const judge = async (question, lines) => {
  judged++;
  if (failing) throw Object.assign(new Error('Jev refused the request (500 error)'), { code: 'jev' });
  return { p: /April/.test(question) && lines.some((l) => l.includes('to 4')) ? 0.96 : 0.04, tokens: 100 };
};
const locate = async (question, lines) => ({ index: lines.findIndex((l) => l.includes('to 4')), tokens: 10 });

let app, base, clock = 1_000_000;
before(async () => {
  app = createApp({ judge, locate, now: () => clock, trustedProxies: 1, commit: 'abc1234def', maxAttempts: 5 });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

const call = async (path, { ip = '203.0.113.1', browser, body, gzip = false, at = base, headers: extra = {} } = {}) => {
  const headers = { 'x-forwarded-for': ip, 'content-type': 'application/json', ...extra };
  if (browser) headers['x-browser-id'] = browser;
  if (gzip) headers['content-encoding'] = 'gzip';
  const payload = body === undefined ? undefined : gzip ? gzipSync(JSON.stringify(body)) : JSON.stringify(body);
  const response = await fetch(at + path, { method: body === undefined ? 'GET' : 'POST', headers, body: payload });
  return { status: response.status, retryAfter: response.headers.get('retry-after'), json: await response.json() };
};
const BROWSER = 'browser-0000-0000-0001';

test('the rows travel with the question (gzipped), and the answer is yes or no', async () => {
  const yes = await call('/api/ask', { ip: '198.51.100.1', gzip: true, body: { question: APRIL, rows } });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.verdict, 'yes');
  assert.equal(yes.json.rows, 2);
  assert.equal(yes.json.left, 4);
  assert.match(yes.json.evidence.display, /from 7 to 4/);
  const no = await call('/api/ask', { ip: '198.51.100.1', body: { question: 'Was the fiscal year set to start in October?', rows } });
  assert.equal(no.json.verdict, 'no');
  assert.equal(no.json.evidence, null);
  assert.equal(no.json.left, 3);
});

test('the server keeps nothing: there is no upload to refer back to, only what each request carries', async () => {
  assert.equal((await call('/api/trail', { body: { rows } })).status, 404);
  assert.equal((await call('/api/ask', { ip: '198.51.100.2', body: { question: APRIL, id: 'anything' } })).status, 400);
});

test('five questions per address or browser, the sixth is refused without asking Jev, whichever of the two is new', async () => {
  const ask = (ip, browser) => call('/api/ask', { ip, browser, body: { question: APRIL, rows } });
  for (let i = 0; i < 5; i++) assert.equal((await ask('203.0.113.50', BROWSER)).status, 200);
  const before = judged;
  const sixth = await ask('203.0.113.50', BROWSER);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.json.left, 0);
  assert.equal((await ask('203.0.113.50', 'browser-0000-0000-0002')).status, 429, 'a new browser id, same address');
  assert.equal((await ask('203.0.113.51', BROWSER)).status, 429, 'a new address, same browser');
  assert.equal((await ask('6.6.6.6, 203.0.113.50', undefined)).status, 429, 'a made-up x-forwarded-for entry');
  assert.equal(judged, before);
  assert.equal((await call('/api/limits', { ip: '203.0.113.50', browser: BROWSER })).json.left, 0);
  assert.equal((await ask('203.0.113.52', 'browser-0000-0000-0003')).status, 200, 'someone else');
  clock += 25 * 3600_000;
  assert.equal((await ask('203.0.113.50', BROWSER)).status, 200, 'a day later');
});

test('a question Jev could not answer is not counted', async () => {
  failing = true;
  const failed = await call('/api/ask', { ip: '203.0.113.60', body: { question: APRIL, rows } });
  failing = false;
  assert.equal(failed.status, 502);
  assert.equal(failed.json.left, 5);
  assert.ok(!JSON.stringify(failed.json).includes('Jev refused'));
});

test('bad input is refused and costs nothing', async () => {
  const ip = '203.0.113.80';
  assert.equal((await call('/api/ask', { ip, body: { question: 'hm', rows } })).status, 400);
  assert.equal((await call('/api/ask', { ip, body: { question: APRIL, rows: [{ at: 1 }] } })).status, 400);
  assert.equal((await call('/api/ask', { ip, body: { question: APRIL, rows: [] } })).status, 400);
  assert.equal((await call('/api/nothing')).status, 404);
  assert.equal((await call('/api/limits', { ip })).json.left, 5);
});

test('the page and its assets are served from here, under a policy that allows nothing from anywhere else', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /default-src 'self'/);
  assert.ok(!policy.includes('http'), 'with the human check off, no other origin is allowed at all');
  const html = await response.text();
  assert.match(html, /<h1>Ask <span class="name">Flux<\/span>/);
  // No telemetry is a claim the page makes; this is the check that nothing it loads comes from a third party.
  const loaded = [...html.matchAll(/<(?:script|link|img)[^>]+(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loaded.length >= 3 && loaded.every((url) => url.startsWith('/')), `loads: ${loaded.join(', ')}`);
  for (const [path, type] of [['/style.css', 'text/css'], ['/app.js', 'text/javascript'], ['/csv.js', 'text/javascript'], ['/favicon.png', 'image/png'], ['/flux.webp', 'image/webp'], ['/flux-play.webp', 'image/webp'], ['/og.jpg', 'image/jpeg'], ['/fonts/inter.var.woff2', 'font/woff2']]) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, path);
    assert.ok(asset.headers.get('content-type').startsWith(type), path);
  }
  const css = await (await fetch(base + '/style.css')).text();
  assert.ok(!/url\(["']?https?:|@import/.test(css), 'the stylesheet fetches nothing from elsewhere');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('the page is told the limits in force, who words the answers, where attempts are counted, and which build it is', async () => {
  const { json } = await call('/api/config');
  assert.deepEqual(json, { maxAttempts: 5, windowHours: 24, maxRows: 100000, maxBodyBytes: 12 * 1024 * 1024, turnstileSiteKey: null, wording: 'template', counter: 'memory', sourceUrl: 'https://github.com/flxbl-io/sf-audit-ask', commit: 'abc1234def', prices: { jevInput: 0.042, haikuInput: 1, haikuOutput: 5 } });
});

test('an answer carries a sentence, and says who wrote it', async () => {
  const yes = await call('/api/ask', { ip: '203.0.113.90', body: { question: APRIL, rows } });
  assert.equal(yes.json.messageBy, 'template');
  // One page judged at 100 tokens and one row located at 10, at $0.042 a million; the template costs nothing.
  assert.deepEqual(yes.json.cost, { jev: 0.00000462, haiku: 0, total: 0.00000462 });
  assert.deepEqual(yes.json.haikuTokens, { input: 0, output: 0 });
  assert.match(yes.json.message, /records it on 19 September 2026.*from 7 to 4/);
  const no = await call('/api/ask', { ip: '203.0.113.90', body: { question: 'Was the fiscal year set to start in October?', rows } });
  assert.match(no.json.message, /Nothing among the 2 changes/);
});

test('with the human check on: a question needs a pass, a pass needs a passed check, and it is only good from the address it was given to', async () => {
  const seen = [];
  let when = 5_000_000;
  const guarded = createApp({ judge, locate, now: () => when, clientIpHeader: 'x-real-ip', human: { siteKey: 'site-key', secret: 'turnstile-secret', verify: async (token, ip) => { seen.push([token, ip]); return token === 'good'; } } });
  await new Promise((resolve) => guarded.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${guarded.address().port}`;
  const from = (ip, extra = {}) => ({ at, headers: { 'x-real-ip': ip, ...extra } });
  try {
    const before = judged;
    assert.equal((await call('/api/ask', { ...from('198.51.100.7'), body: { question: APRIL, rows } })).status, 403, 'no pass');
    assert.equal((await call('/api/ask', { ...from('198.51.100.7', { 'x-human-pass': `${when + 60_000}.forged` }), body: { question: APRIL, rows } })).status, 403, 'a forged pass');
    assert.equal((await call('/api/human', { ...from('198.51.100.7'), body: { token: 'bad' } })).status, 403);
    assert.equal(judged, before);

    const passed = await call('/api/human', { ...from('198.51.100.7'), body: { token: 'good' } });
    assert.equal(passed.status, 200);
    assert.deepEqual(seen.at(-1), ['good', '198.51.100.7'], 'Cloudflare is told the address the host saw');
    const pass = { 'x-human-pass': passed.json.pass };
    assert.equal((await call('/api/ask', { ...from('198.51.100.7', pass), body: { question: APRIL, rows } })).json.verdict, 'yes');
    assert.equal((await call('/api/ask', { ...from('198.51.100.7', pass), body: { question: APRIL, rows } })).status, 200, 'the pass is good for more than one question');
    assert.equal((await call('/api/ask', { ...from('198.51.100.99', pass), body: { question: APRIL, rows } })).status, 403, 'someone else using the same pass');
    when += 31 * 60_000;
    assert.equal((await call('/api/ask', { ...from('198.51.100.7', pass), body: { question: APRIL, rows } })).status, 403, 'half an hour later');

    assert.equal((await (await fetch(at + '/api/config')).json()).turnstileSiteKey, 'site-key');
    const policy = (await fetch(at + '/')).headers.get('content-security-policy');
    assert.deepEqual(policy.match(/https:\/\/[^ ;]+/g), ['https://challenges.cloudflare.com', 'https://challenges.cloudflare.com']);
  } finally {
    guarded.close();
  }
});

test('attempts can be counted somewhere shared, and the page is told so', async () => {
  const calls = [];
  const questions = { left: async (keys) => { calls.push(['left', keys]); return 3; }, take: async (keys) => { calls.push(['take', keys]); return { ok: true, left: 2, member: 'm1' }; }, refund: async (keys, taken) => { calls.push(['refund', taken.member]); }, sweep: () => 0 };
  const shared = createApp({ judge, locate, questions, trustedProxies: 1 });
  await new Promise((resolve) => shared.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${shared.address().port}`;
  try {
    assert.equal((await call('/api/config', { at })).json.counter, 'redis');
    assert.equal((await call('/api/ask', { at, ip: '203.0.113.5', browser: BROWSER, body: { question: APRIL, rows } })).json.left, 2);
    assert.deepEqual(calls.at(-1), ['take', ['ip:203.0.113.5', `browser:${BROWSER}`]]);
    failing = true;
    await call('/api/ask', { at, ip: '203.0.113.5', body: { question: APRIL, rows } });
    failing = false;
    assert.deepEqual(calls.find(([name]) => name === 'refund'), ['refund', 'm1'], 'the very attempt that was counted is the one given back');
  } finally {
    shared.close();
  }
});

test('fromEnv: 20 questions unless told otherwise, and the Redis pair is found under any prefix an integration gives it, never by its read-only token', () => {
  const quiet = () => {};
  const base = { TYPESAFE_API_KEY: 'k' };
  assert.equal(fromEnv(base, quiet).options.maxAttempts, 20);
  assert.equal(fromEnv({ ...base, ATTEMPTS: '7' }, quiet).options.maxAttempts, 7);
  assert.equal(fromEnv(base, quiet).options.questions, null);
  assert.match(fromEnv(base, quiet).summary, /counted in: this process's memory/);
  const prod = fromEnv({ ...base, UPSTASH_PROD_KV_REST_API_URL: 'https://r.upstash.io', UPSTASH_PROD_KV_REST_API_TOKEN: 't', UPSTASH_PROD_KV_REST_API_READ_ONLY_TOKEN: 'ro', UPSTASH_PROD_REDIS_URL: 'redis://x' }, quiet);
  assert.ok(prod.options.questions);
  assert.match(prod.summary, /Redis \(UPSTASH_PROD_KV_REST_API_URL\)/);
  assert.match(fromEnv({ ...base, KV_REST_API_URL: 'https://r', KV_REST_API_TOKEN: 't' }, quiet).summary, /Redis \(KV_REST_API_URL\)/);
  assert.match(fromEnv({ ...base, UPSTASH_REDIS_REST_URL: 'https://r', UPSTASH_REDIS_REST_TOKEN: 't', KV_REST_API_URL: 'https://other', KV_REST_API_TOKEN: 't2' }, quiet).summary, /Redis \(UPSTASH_REDIS_REST_URL\)/, "Upstash's own names come first");
  assert.equal(fromEnv({ ...base, UPSTASH_PROD_KV_REST_API_URL: 'https://r', UPSTASH_PROD_KV_REST_API_READ_ONLY_TOKEN: 'ro' }, quiet).options.questions, null, 'a URL with only a read-only token is not used');
});
