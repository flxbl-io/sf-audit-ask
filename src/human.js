/**
 * "Are you human?", by Cloudflare Turnstile. Asked once, then a pass is handed back that is good for half an hour
 * from the same address. The pass is a signed note, not a session: nothing about it is kept on the server, so it
 * works the same whichever process answers the next request. No cookie, no account.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** `verify(token, ip)` resolves to true or false. It does not throw: a check that cannot be made is a no. */
export function turnstile({ secret, fetch = globalThis.fetch, timeoutMs = 5000 }) {
  return async function verify(token, ip) {
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set('remoteip', ip);
      const response = await fetch(VERIFY, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
      return (await response.json())?.success === true;
    } catch {
      return false;
    }
  };
}

/** `issue(addressKey)` and `check(pass, addressKey)`. A pass names when it ends and is only good from the address it was given to. */
export function passes({ secret, ttlMs = 30 * 60_000, now = Date.now }) {
  const sign = (text) => createHmac('sha256', `pass:${secret}`).update(text).digest('base64url');
  return {
    issue(addressKey) {
      const until = now() + ttlMs;
      return { pass: `${until}.${sign(`${until}.${addressKey}`)}`, until };
    },
    check(pass, addressKey) {
      const [until, signature] = String(pass ?? '').split('.');
      if (!/^\d{1,16}$/.test(until ?? '') || !signature || Number(until) < now()) return false;
      const expected = Buffer.from(sign(`${until}.${addressKey}`));
      const given = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
