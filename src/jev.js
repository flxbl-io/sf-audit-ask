/**
 * Two things are asked of Jev, over plain fetch. The key never appears in an error.
 *   judge:  one page of the trail, one yes/no question, one probability. This alone decides the answer.
 *   locate: after a yes, which row of that page says so. It is only shown to the person; it decides nothing.
 */

const INSTRUCTIONS =
  'The `audit_trail` is part of a Salesforce Setup Audit Trail, oldest first, one change per line. Do its lines show ' +
  'that the answer to `question` is yes?';

// The FROM/TO sentence is measured: without it "was the fiscal year set to July?" scored 0.79 against a row that
// reads "from 7 to 4". With it, 0.41, and true questions did not move (0.93-0.97).
const CRITERIA = {
  true: 'A line records the very change the question asks about, with any value it names (a level, a month, a user, a name) matching.',
  false:
    'No line records that change; or the lines about that setting record a different value or the opposite direction; ' +
    'or the value asked about is only the OLD value a line says the setting was changed FROM, not the new value it was ' +
    'changed TO; or the lines are only about unrelated settings.',
};

const WHERE =
  'Each line of `audit_trail` starts with its number in square brackets. Which one line records the change that makes ' +
  'the answer to `question` yes? If several do, choose the latest. If no line offered here does, choose NONE.';
/** A Choice takes at most 255 options, so a page is pointed into in ranges of this many lines, all in one request. */
const RANGE = 200;
/** Below this, no row is shown. Showing the wrong row as the reason is worse than showing none. */
const LOCATED = 0.5;

const RETRIES = 6;
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

// The model is pinned: the 0.8 cutoff was measured on this version, and `jev-latest` moves without notice.
export function jev({ apiKey, base = 'https://api.typesafe.ai/v1', model = 'jev-1.13.0', fetch = globalThis.fetch }) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const url = `${base.replace(/\/$/, '')}/systemone`;

  async function ask(state, questions, signal) {
    const body = JSON.stringify({ model, state, questions });
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: 'POST', signal, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body });
      // Reading a page changes nothing, so a throttled read is simply asked again.
      if (response.status === 429 && attempt < RETRIES) {
        await wait((Number(response.headers.get('retry-after')) || 0.5 * 2 ** attempt) * 1000, signal);
        continue;
      }
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        const type = String(json?.detail?.error_type ?? json?.error?.type ?? 'error').slice(0, 60);
        throw Object.assign(new Error(`Jev refused the request (${response.status} ${type})`), { code: type === 'max_tokens_exceeded' ? 'too_large' : 'jev' });
      }
      return json;
    }
  }

  return {
    /** Any questions over one state, answered as Jev answers them: { answers, tokens }. Used by the flow walk. */
    async decide(state, questions, signal) {
      const json = await ask(state, questions, signal);
      if (!json?.answers || typeof json.answers !== 'object') throw Object.assign(new Error('Jev\'s answer was unreadable'), { code: 'jev' });
      return { answers: json.answers, tokens: Number(json.usage?.input_tokens) || 0 };
    },

    async judge(question, lines, signal) {
      const json = await ask({ question, audit_trail: lines }, { yes: { type: 'noul', instructions: INSTRUCTIONS, criteria: CRITERIA } }, signal);
      const p = json?.answers?.yes?.noul;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw Object.assign(new Error('Jev\'s answer was unreadable'), { code: 'jev' });
      return { p, tokens: Number(json.usage?.input_tokens) || 0 };
    },

    /** The index into `lines` of the row that says yes, or null. Anything unreadable is null, never a guess. */
    async locate(question, lines, signal) {
      const questions = {};
      for (let from = 0; from < lines.length; from += RANGE) {
        const criteria = { NONE: 'No line offered here records the change the question asks about.' };
        for (let i = from; i < Math.min(from + RANGE, lines.length); i++) criteria[String(i + 1)] = null;
        questions[`where_${from}`] = { type: 'choice', instructions: WHERE, criteria };
      }
      const json = await ask({ question, audit_trail: lines.map((text, i) => `[${i + 1}] ${text}`) }, questions, signal);
      let best = null;
      for (const [id, asked] of Object.entries(questions)) {
        const picked = json?.answers?.[id];
        const p = picked?.probabilities?.[picked?.choice];
        if (!picked || picked.choice === 'NONE' || !(picked.choice in asked.criteria) || typeof p !== 'number' || !(p >= LOCATED && p <= 1)) continue;
        if (!best || p > best.p) best = { index: Number(picked.choice) - 1, p };
      }
      return { index: best?.index ?? null, p: best?.p ?? null, tokens: Number(json?.usage?.input_tokens) || 0 };
    },
  };
}
