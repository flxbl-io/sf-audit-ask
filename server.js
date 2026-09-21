/**
 * The whole server: the page and the question endpoint. It exists to hold the keys and to count attempts.
 *
 * It keeps no trail. The rows arrive with each question and are gone when the answer is sent, so any process can
 * answer any request: one Node server on a box, or a function on Vercel (api/[route].js). There is no login, no
 * database of visitors, no cookie and no analytics, and a log line names neither the question nor the address.
 */

import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { MAX_ROWS, answer, prepare } from './src/engine.js';
import { explainer } from './src/explain.js';
import { passes, turnstile } from './src/human.js';
import { jev } from './src/jev.js';
import { addressKey, attempts, clientAddress, redisAttempts, redisCommand, semaphore } from './src/limits.js';
import { cost, PRICES } from './src/cost.js';

// Everything the page loads, and nothing else. The font is served from here so that no visit touches a font CDN;
// the pictures of Flux likewise.
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/csv.js': ['csv.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.png': ['favicon.png', 'image/png', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
  '/flux.webp': ['flux.webp', 'image/webp', 'public, max-age=86400'],
  '/flux-play.webp': ['flux-play.webp', 'image/webp', 'public, max-age=86400'],
  '/og.jpg': ['og.jpg', 'image/jpeg', 'public, max-age=86400'],
  '/fonts/inter.var.woff2': ['fonts/inter.var.woff2', 'font/woff2', 'public, max-age=604800, immutable'],
};
// Turnstile is the one third party a browser talks to, and only when it is switched on.
const CSP = (human) => [
  "default-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "img-src 'self' data:",
  ...(human ? ["script-src 'self' https://challenges.cloudflare.com", 'frame-src https://challenges.cloudflare.com'] : []),
].join('; ');

const FIELD_LIMITS = { at: 40, action: 120, section: 120, display: 2000 };
const BROWSER_ID = /^[A-Za-z0-9-]{16,64}$/;
const BODY_BYTES = 12 * 1024 * 1024;
const INFLATED_BYTES = 96 * 1024 * 1024;

class Refused extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

async function body(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Refused(413, 'That file is too large to send. Export fewer months and try again.');
    chunks.push(chunk);
  }
  let raw = Buffer.concat(chunks);
  if (request.headers['content-encoding'] === 'gzip') {
    try { raw = gunzipSync(raw, { maxOutputLength: INFLATED_BYTES }); } catch { throw new Refused(413, 'That could not be unpacked, or is too large.'); }
  }
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new Refused(400, 'The request is not JSON.'); }
}

function rowsFrom(input) {
  if (!Array.isArray(input?.rows) || !input.rows.length) throw new Refused(400, 'Send {"rows": [...]} with at least one row.');
  if (input.rows.length > MAX_ROWS) throw new Refused(413, `At most ${MAX_ROWS} rows.`);
  return input.rows.map((row) => {
    const clean = {};
    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
      if (typeof row?.[field] !== 'string') throw new Refused(400, `Every row needs the text fields ${Object.keys(FIELD_LIMITS).join(', ')}.`);
      clean[field] = row[field].slice(0, limit);
    }
    return clean;
  });
}

/** `(request, response)`: everything but the listening. A Vercel function exports this as it is. */
export function createHandler({
  judge,
  locate,
  explain = explainer(),
  human = null,            // { siteKey, verify(token, ip), secret }: when set, a question needs a pass from a passed check
  questions = null,        // the attempt counter; in memory unless one is handed in (Redis, where processes come and go)
  now = Date.now,
  maxAttempts = 20,
  attemptWindowMs = 24 * 3600_000,
  inFlight = 8,
  trustedProxies = 0,
  clientIpHeader = null,
  maxBodyBytes = BODY_BYTES,
  serveFiles = true,       // false where the host serves public/ itself
  sourceUrl = 'https://github.com/flxbl-io/sf-audit-ask',
  commit = null,
  wording = 'template',    // 'haiku' when Claude Haiku writes the sentence under a verdict
  log = () => {},
} = {}) {
  const counter = questions ?? attempts({ max: maxAttempts, windowMs: attemptWindowMs, now });
  const gate = semaphore(inFlight);
  const csp = CSP(Boolean(human));
  const humans = human ? passes({ secret: human.secret, now }) : null;

  const address = (request) => clientAddress(request, { trustedProxies, header: clientIpHeader });
  const visitor = (request) => {
    const keys = [`ip:${addressKey(address(request))}`];
    const id = request.headers['x-browser-id'];
    if (typeof id === 'string' && BROWSER_ID.test(id)) keys.push(`browser:${id}`);
    return keys;
  };

  const routes = {
    // What the page needs to describe itself truthfully: the limits in force, who words the answers, which build.
    'GET /api/config': async () => ({
      maxAttempts, windowHours: Math.round(attemptWindowMs / 3600_000), maxRows: MAX_ROWS, maxBodyBytes,
      turnstileSiteKey: human?.siteKey ?? null, wording, counter: questions ? 'redis' : 'memory', sourceUrl, commit, prices: PRICES,
    }),

    'GET /api/limits': async (request) => ({ left: await counter.left(visitor(request)), max: maxAttempts }),

    // The check is made once; the pass it buys is good for half an hour from the same address.
    'POST /api/human': async (request) => {
      if (!human) return { pass: null, until: null };
      const input = await body(request, 8 * 1024);
      if (!(await human.verify(input?.token, address(request)))) throw new Refused(403, 'The "are you human" check did not pass. Please try it again.', { human: false });
      return humans.issue(addressKey(address(request)));
    },

    'POST /api/ask': async (request) => {
      // Refused before the body is read: a request with no pass should not get to send 100,000 rows first.
      if (humans && !humans.check(request.headers['x-human-pass'], addressKey(address(request)))) {
        throw new Refused(403, 'Please do the "are you human" check again.', { human: false });
      }
      // Likewise for someone with no questions left. The count itself is taken below, once the request is known to be good.
      const keys = visitor(request);
      if ((await counter.left(keys)) < 1) throw new Refused(429, `That is all ${maxAttempts} questions for now.`, { left: 0 });
      const input = await body(request, maxBodyBytes);
      const question = typeof input?.question === 'string' ? input.question.trim() : '';
      if (question.length < 5 || question.length > 500) throw new Refused(400, 'Ask a question of 5 to 500 characters.');
      const rows = rowsFrom(input);

      const taken = await counter.take(keys);
      if (!taken.ok) throw new Refused(429, `That is all ${maxAttempts} questions for now.`, { left: 0, retryAt: taken.retryAt });
      const started = now();
      try {
        const trail = prepare(rows);
        const result = await answer(trail, question, { judge, locate, gate, workers: inFlight });
        const said = await explain({ question, verdict: result.verdict, p: result.p, evidence: result.evidence, rows: trail.rows.length, from: trail.from, to: trail.to });
        const spent = cost({ jevTokens: result.tokens, haiku: said.tokens });
        // Neither the question nor the address is logged.
        log(`ask ${result.verdict} p=${result.p.toFixed(2)} rows=${trail.rows.length} pages=${result.pages} requests=${result.requests} tokens=${result.tokens} words=${said.by} usd=${spent.total.toFixed(6)} ms=${now() - started}`);
        return { ...result, message: said.message, messageBy: said.by, haikuTokens: said.tokens, cost: spent, left: taken.left, rows: trail.rows.length, cut: trail.cut, superseded: trail.superseded };
      } catch (error) {
        await Promise.resolve(counter.refund(keys, taken)).catch(() => {});
        log(`ask failed: ${error.message}`);
        throw new Refused(502, 'The question could not be answered just now. It was not counted against you.', { left: await Promise.resolve(counter.left(keys)).catch(() => undefined) });
      }
    },
  };

  // Keys whose attempts have all left the window are forgotten, so the map does not grow for ever.
  setInterval(() => counter.sweep(), 10 * 60_000).unref();

  return async function handler(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;
    const send = (status, type, content, headers = {}) => {
      response.writeHead(status, {
        'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': csp,
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()', 'cache-control': 'no-cache', ...headers,
      });
      response.end(content);
    };
    const json = (status, value, headers = {}) => send(status, 'application/json; charset=utf-8', JSON.stringify(value), { 'cache-control': 'no-store', ...headers });
    try {
      const file = serveFiles && request.method === 'GET' && FILES[path];
      if (file) return send(200, file[1], await readFile(new URL(`./public/${file[0]}`, import.meta.url)), file[2] ? { 'cache-control': file[2] } : {});
      if (request.method === 'GET' && path === '/favicon.ico') { response.writeHead(204); return response.end(); }
      const route = routes[`${request.method} ${path}`];
      if (!route) throw new Refused(404, 'Not found.');
      json(200, await route(request));
    } catch (error) {
      const refused = error instanceof Refused;
      if (!refused) log(`error: ${error.message}`);
      const headers = refused && error.extra.retryAt ? { 'retry-after': String(Math.max(1, Math.ceil((error.extra.retryAt - now()) / 1000))) } : {};
      json(refused ? error.status : 500, { error: refused ? error.message : 'Something went wrong on our side.', ...(refused ? error.extra : {}) }, headers);
    }
  };
}

export const createApp = (options) => createServer(createHandler(options));

/** The handler's options, from the environment. Shared by `npm start` and the Vercel function. */
export function fromEnv(env = process.env, log = (line) => console.log(`${new Date().toISOString()} ${line}`)) {
  const number = (name, fallback) => (env[name] ? Number(env[name]) : fallback);
  const onVercel = Boolean(env.VERCEL);
  const maxAttempts = number('ATTEMPTS', 20);
  const attemptWindowMs = number('ATTEMPT_WINDOW_HOURS', 24) * 3600_000;
  // Upstash's own names (UPSTASH_REDIS_REST_URL) or the KV_REST_API_URL Vercel's integration sets, under whatever prefix
  // the integration was given (UPSTASH_PROD_KV_REST_API_URL), each with its _TOKEN beside it. A read-only token is never it.
  const restPair = (suffix) => Object.keys(env).sort()
    .filter((name) => name.endsWith(`${suffix}_URL`) && env[name] && env[`${name.slice(0, -4)}_TOKEN`])
    .map((name) => ({ name, url: env[name], token: env[`${name.slice(0, -4)}_TOKEN`] }))[0];
  const redis = restPair('REDIS_REST') ?? restPair('KV_REST_API');
  const salt = env.COUNTER_SALT || env.TURNSTILE_SECRET || env.TYPESAFE_API_KEY || '';
  const questions = redis
    ? redisAttempts({ command: redisCommand({ url: redis.url, token: redis.token }), hash: (key) => createHmac('sha256', `count:${salt}`).update(key).digest('base64url').slice(0, 22), max: maxAttempts, windowMs: attemptWindowMs })
    : null;
  const human = env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET ? { siteKey: env.TURNSTILE_SITE_KEY, secret: env.TURNSTILE_SECRET, verify: turnstile({ secret: env.TURNSTILE_SECRET }) } : null;
  // Vercel sets x-real-ip itself and lets nothing else write it; its request bodies stop at 4.5 MB.
  const clientIpHeader = env.CLIENT_IP_HEADER || (onVercel ? 'x-real-ip' : null);
  return {
    options: {
      ...jev({ apiKey: env.TYPESAFE_API_KEY, base: env.TYPESAFE_BASE_URL, model: env.TYPESAFE_MODEL }),
      explain: explainer({ apiKey: env.ANTHROPIC_API_KEY }),
      wording: env.ANTHROPIC_API_KEY ? 'haiku' : 'template',
      human, questions, maxAttempts, attemptWindowMs, clientIpHeader,
      inFlight: number('JEV_IN_FLIGHT', 8),
      trustedProxies: number('TRUSTED_PROXIES', 0),
      maxBodyBytes: number('MAX_BODY_BYTES', onVercel ? 4 * 1024 * 1024 : BODY_BYTES),
      serveFiles: !onVercel,
      sourceUrl: env.SOURCE_URL || undefined,
      commit: env.GIT_COMMIT || env.VERCEL_GIT_COMMIT_SHA || null,
      log,
    },
    summary: `human check: ${human ? 'Cloudflare Turnstile' : 'OFF (set TURNSTILE_SITE_KEY and TURNSTILE_SECRET)'}; wording: ${env.ANTHROPIC_API_KEY ? 'Claude Haiku' : 'built-in sentences'}; attempts counted in: ${redis ? `Redis (${redis.name})` : 'this process\'s memory'}; address from: ${clientIpHeader || (number('TRUSTED_PROXIES', 0) ? 'x-forwarded-for' : 'the socket')}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { options, summary } = fromEnv();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  createApp(options).listen(port, host, () => { options.log(`sf-audit-ask on http://${host}:${port}`); options.log(summary); });
}
