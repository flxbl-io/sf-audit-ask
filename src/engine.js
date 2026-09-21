/**
 * A yes/no question over a Setup Audit Trail of any size.
 *
 * Jev reads about 500 rows in one request, so the trail is read in pages, several at a time. The pages are cut in
 * order of relevance to the question: page 1 is the shortlist, the rest is the full sweep. The answer is the
 * highest probability any page gives. A yes stops the sweep; a no has read every row.
 *
 * Measured live on a real trail buried in 107,000 rows: a yes in about a second, a no in about nine.
 */

/** The newest rows are the ones kept: a question is about what holds now, and a newer row can undo an older one. */
export const MAX_ROWS = 100_000;
/** About 60 tokens a row, seen live. 400 rows were accepted and 700 refused, so this leaves room. */
export const PAGE_ROWS = 350;
/** At or above this a page says yes. Between UNCLEAR and this, the answer is shown as unclear. */
export const YES = 0.8;
export const UNCLEAR = 0.5;

const DISPLAY_LIMIT = 600;

// The two wordings Salesforce uses that name a setting apart from its value (from sf-autopilot's check.ts).
const SETTING = [/^Changed (.+?) from .+ to .+$/is, /^(.+) (?:Enabled|Disabled)\.?$/is];
const settingOf = (row) => {
  for (const wording of SETTING) {
    const setting = wording.exec(row.display.trim())?.[1];
    if (setting) return setting.toLowerCase();
  }
  return null;
};

const STOP = new Set('and then also that the a an was were is are has have had did does do to of for in on set please check verify confirm whether if it we you can now any'.split(' '));
const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
const searchable = (row) => `${row.action.replace(/([a-z])([A-Z])/g, '$1 $2')} ${row.section} ${row.display}`;

/** What Jev is shown for a row. Never a username: the parser does not keep one. */
export const line = (row) => [row.at.slice(0, 19).replace('T', ' '), row.action, row.section, row.display.trim().slice(0, DISPLAY_LIMIT)].filter(Boolean).join(' | ');

const ISO = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Rows oldest first, capped to the newest MAX_ROWS, a setting changed several times reduced to its last row, and
 * the word index a question is ranked against. Each step is one pass: sf-autopilot's lastWordOnly compares every
 * row with every other, which is fine for 200 rows and not for 100,000.
 *
 * Only ISO dates are sorted. "9/10/2026" is September or October depending on who exported it, and would sort
 * without complaint either way, so any other date keeps the order the parser gave.
 */
export function prepare(rows) {
  const sorted = rows.every((r) => ISO.test(r.at)) ? [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : rows;
  const kept = sorted.length > MAX_ROWS ? sorted.slice(-MAX_ROWS) : sorted;
  const last = new Map();
  kept.forEach((row, i) => { const setting = settingOf(row); if (setting) last.set(setting, i); });
  const standing = kept.filter((row, i) => { const setting = settingOf(row); return !setting || last.get(setting) === i; });

  const docs = standing.map((row) => words(searchable(row)));
  const df = new Map();
  for (const doc of docs) for (const w of new Set(doc)) df.set(w, (df.get(w) ?? 0) + 1);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
  return {
    rows: standing, docs, df, average,
    uploaded: rows.length, cut: sorted.length - kept.length, superseded: kept.length - standing.length,
    from: standing[0]?.at ?? null, to: standing.at(-1)?.at ?? null,
  };
}

/** BM25, with a word matching its own prefix ("deliver" and "deliverability"). Rare words outweigh common ones. */
function rank(trail, question) {
  const asked = [...new Set(words(question))];
  const weight = new Map(asked.map((w) => [w, Math.log(1 + (trail.docs.length - (trail.df.get(w) ?? 0) + 0.5) / ((trail.df.get(w) ?? 0) + 0.5))]));
  return trail.docs.map((doc, i) => {
    let score = 0;
    for (const w of asked) {
      const tf = doc.filter((x) => x === w || x.startsWith(w) || w.startsWith(x)).length;
      if (tf) score += weight.get(w) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / trail.average));
    }
    return { i, score };
  });
}

/** Pages in relevance order; inside a page the rows are oldest first, as Jev is told they are. */
export function paginate(trail, question, size = PAGE_ROWS) {
  const ranked = rank(trail, question).sort((a, b) => b.score - a.score || b.i - a.i);
  const pages = [];
  for (let at = 0; at < ranked.length; at += size) pages.push(ranked.slice(at, at + size).sort((a, b) => a.i - b.i).map((r) => ({ row: trail.rows[r.i], score: r.score })));
  return pages;
}

/**
 * `judge(question, lines, signal)` resolves to { p, tokens }, and throws an error with code 'too_large' when the
 * page does not fit. `gate` is shared by every question being answered, because the rate limit is per account.
 * `locate(question, lines)` resolves to { index, tokens }: after a yes, the row of that page that says so.
 */
export async function answer(trail, question, { judge, locate, gate, workers = 8, threshold = YES }) {
  const pages = paginate(trail, question);
  const stop = new AbortController();
  const stats = { pages: pages.length, requests: 0, tokens: 0 };
  let best = { p: 0, page: null };
  let next = 0;

  // A page too large for one request (long rows) is read as two halves.
  const read = async (page) => {
    try {
      const { p, tokens } = await gate(() => judge(question, page.map((entry) => line(entry.row)), stop.signal));
      stats.requests++;
      stats.tokens += tokens;
      return p;
    } catch (error) {
      if (error.code !== 'too_large' || page.length < 2) throw error;
      const half = Math.ceil(page.length / 2);
      return Math.max(await read(page.slice(0, half)), await read(page.slice(half)));
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, pages.length) }, async () => {
    while (next < pages.length && !stop.signal.aborted) {
      const page = pages[next++];
      try {
        const p = await read(page);
        if (p > best.p) best = { p, page };
        if (p >= threshold) stop.abort();
      } catch (error) {
        if (!stop.signal.aborted) { stop.abort(); throw error; }
      }
    }
  }));

  // The row is shown to the person and decides nothing, so failing to find it never fails the answer. It used to be
  // the rows sharing most words with the question: seen live, "Can admins log in as any user now?" was answered
  // yes, rightly, beside three rows about login IP ranges.
  let evidence = null;
  if (best.p >= threshold && locate) {
    try {
      const found = await gate(() => locate(question, best.page.map((entry) => line(entry.row))));
      stats.requests++;
      stats.tokens += found.tokens;
      if (Number.isInteger(found.index) && best.page[found.index]) evidence = best.page[found.index].row;
    } catch { /* no row is shown */ }
  }
  return { verdict: best.p >= threshold ? 'yes' : best.p > UNCLEAR ? 'unclear' : 'no', p: best.p, evidence, ...stats };
}
