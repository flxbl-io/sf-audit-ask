/** No login, so the limits are all there is: attempts per visitor, and one queue for everything sent to Jev. */

/**
 * At most `max` attempts per key in a rolling window. A visitor is several keys at once (the IP address, the
 * browser's identifier) and is refused when ANY of them is used up: a new identifier does not help from the same
 * address, and a new address does not help the same browser.
 */
export function attempts({ max = 5, windowMs = 24 * 3600_000, now = Date.now } = {}) {
  const seen = new Map();
  const recent = (key) => {
    const times = (seen.get(key) ?? []).filter((t) => t > now() - windowMs);
    if (times.length) seen.set(key, times); else seen.delete(key);
    return times;
  };
  const left = (keys) => Math.max(0, max - Math.max(0, ...keys.map((key) => recent(key).length)));
  return {
    left,
    /** Counts one attempt against every key, or none of them. */
    take(keys) {
      const spent = keys.map(recent);
      const full = spent.filter((times) => times.length >= max);
      // Free again when the oldest attempt of the fullest key leaves the window.
      if (full.length) return { ok: false, left: 0, retryAt: Math.max(...full.map((times) => times[0])) + windowMs };
      keys.forEach((key, i) => seen.set(key, [...spent[i], now()]));
      return { ok: true, left: left(keys) };
    },
    /** Gives back an attempt the visitor got nothing for (Jev was down). */
    refund(keys) {
      for (const key of keys) { const times = recent(key); times.pop(); if (times.length) seen.set(key, times); else seen.delete(key); }
    },
    /** Forget keys whose attempts have all left the window. Call now and then. */
    sweep() { for (const key of [...seen.keys()]) recent(key); return seen.size; },
  };
}

/** `gate(task)` runs at most `max` tasks at once, first come first served. */
export function semaphore(max) {
  let running = 0;
  const waiting = [];
  const release = () => { running--; waiting.shift()?.(); };
  return async function gate(task) {
    if (running >= max) await new Promise((resolve) => waiting.push(resolve));
    running++;
    try { return await task(); } finally { release(); }
  };
}

/**
 * The address a limit is counted against. An IPv6 visitor usually holds a whole /64 and can change the rest at
 * will, so only the first half of the address counts.
 */
export function addressKey(ip) {
  const address = String(ip ?? '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').replace(/%.*$/, '');
  if (!address.includes(':')) return address || 'unknown';
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * With nothing in front, the socket's address. Two ways to sit behind something, and both are only as safe as the
 * promise that visitors cannot reach this server any other way:
 *   - `header` (Cloudflare: "cf-connecting-ip"): the one address Cloudflare saw. Behind a Cloudflare Tunnel nothing
 *     else can reach the port, so nothing else can write the header.
 *   - `trustedProxies`: the entry of x-forwarded-for that the outermost trusted proxy wrote, counted from the RIGHT.
 *     Everything to its left is whatever the visitor chose to send, and believing it would hand out a fresh limit
 *     per made-up address.
 */
export function clientAddress(request, { trustedProxies = 0, header = null } = {}) {
  if (header) {
    const value = request.headers[header.toLowerCase()];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (trustedProxies > 0) {
    const hops = String(request.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length >= trustedProxies) return hops[hops.length - trustedProxies];
  }
  return request.socket.remoteAddress;
}

/**
 * The same counting, kept in Redis over Upstash's REST API (plain fetch), for hosts where two requests may not
 * meet the same process: on Vercel an in-memory count restarts with every new instance. One script does the
 * whole take, so two questions arriving together cannot both be the fifth.
 *
 * A key is stored as a keyed hash: the store holds no address and no browser identifier, only something that
 * cannot be turned back into one, and it expires with the window.
 */
const TAKE = `
local now, window, max, member = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
local most, oldest = 0, 0
for _, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  local n = redis.call('ZCARD', key)
  if n >= max then
    local first = tonumber(redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2])
    if first > oldest then oldest = first end
  end
  if n > most then most = n end
end
if most >= max then return {0, 0, oldest + window} end
for _, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
end
return {1, max - most - 1, 0}`;

const LEFT = `
local now, window, max, most = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), 0
for _, key in ipairs(KEYS) do
  local n = redis.call('ZCOUNT', key, '(' .. (now - window), '+inf')
  if n > most then most = n end
end
return math.max(0, max - most)`;

export function redisCommand({ url, token, fetch = globalThis.fetch }) {
  return async function command(args) {
    const response = await fetch(url.replace(/\/$/, ''), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(4000) });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.error) throw new Error(`The attempt counter did not answer (${response.status})`);
    return json.result;
  };
}

export function redisAttempts({ command, hash, max = 5, windowMs = 24 * 3600_000, now = Date.now, prefix = 'asks' }) {
  const names = (keys) => keys.map((key) => `${prefix}:${hash(key)}`);
  let serial = 0;
  return {
    async left(keys) { return Number(await command(['EVAL', LEFT, String(keys.length), ...names(keys), String(now()), String(windowMs), String(max)])); },
    async take(keys) {
      const member = `${now()}-${process.pid}-${serial++}-${Math.random().toString(36).slice(2, 8)}`;
      const [ok, left, retryAt] = (await command(['EVAL', TAKE, String(keys.length), ...names(keys), String(now()), String(windowMs), String(max), member])).map(Number);
      return ok ? { ok: true, left, member } : { ok: false, left: 0, retryAt };
    },
    /** Takes back exactly the attempt that was counted, not whichever is newest. */
    async refund(keys, taken) { if (taken?.member) await Promise.all(names(keys).map((key) => command(['ZREM', key, taken.member]))); },
    sweep() { return 0; },
  };
}
