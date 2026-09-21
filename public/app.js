import { trailRows } from '/csv.js';

const $ = (id) => document.getElementById(id);
const count = (n) => n.toLocaleString('en');
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const money = (usd) => `$${usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3).replace(/0$/, '') : usd.toFixed(4)}`;

// Not an identity and not sent anywhere else: a random value, so that one office address is not one visitor.
let browserId = localStorage.getItem('browser-id');
if (!browserId) { browserId = crypto.randomUUID(); localStorage.setItem('browser-id', browserId); }

let config = { maxAttempts: 5, windowHours: 24, maxBodyBytes: 12 * 1024 * 1024, turnstileSiteKey: null, wording: 'template', counter: 'memory', sourceUrl: null, commit: null };
let trail = null;          // { name, rows, notes }: lives in this tab and nowhere else
let left = null;
let human = null;          // { pass, until }: what a passed check buys, for half an hour
let widget = null;
let spent = { usd: 0, asked: 0, tokens: 0 };   // this tab only, summed from what each answer reports

async function call(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-browser-id': browserId, ...options.headers } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error ?? `The server answered ${response.status}.`), json, { status: response.status });
  return json;
}

function note(element, text, error = false) {
  element.hidden = !text;
  element.textContent = text;
  element.classList.toggle('error', error);
}

function refresh(retryAt) {
  const ready = trail !== null && left > 0;
  for (const control of [$('question'), $('send'), ...document.querySelectorAll('.chip')]) control.disabled = !ready;
  $('ask').setAttribute('aria-disabled', String(!ready));
  $('meter').replaceChildren(...Array.from({ length: config.maxAttempts }, (_, i) => Object.assign(document.createElement('i'), { className: i < (left ?? 0) ? 'on' : '' })));
  $('meter').classList.toggle('many', config.maxAttempts > 8);
  $('meter').setAttribute('aria-label', `${left ?? 0} of ${config.maxAttempts} questions left`);
  if (left === null) return note($('left'), '');
  if (left > 0) return note($('left'), `${plural(left, 'question')} left of ${config.maxAttempts}, every ${config.windowHours} hours. It is a free experiment, so there is a limit.`);
  note($('left'), `That was all ${config.maxAttempts} questions for now.${retryAt ? ` More from ${new Date(retryAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : ` More within ${config.windowHours} hours.`}`, true);
}

async function gzip(text) {
  if (!('CompressionStream' in window)) return { body: new Blob([text]), headers: {} };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { body: await new Response(stream).blob(), headers: { 'content-encoding': 'gzip' } };
}

// The widget's element must not be called "turnstile": an element's id becomes a window property, and would shadow
// Cloudflare's own `window.turnstile`. Seen live: "window.turnstile.render is not a function".
/** Cloudflare's script is fetched only when the check is switched on, and only when a question is first asked. */
function turnstileToken() {
  $('human').hidden = false;
  return new Promise((resolve, reject) => {
    const show = () => {
      if (widget !== null) window.turnstile.remove(widget);
      widget = window.turnstile.render('#human-widget', { sitekey: config.turnstileSiteKey, theme: 'light', callback: resolve, 'error-callback': () => reject(new Error('The "are you human" check could not load. Please try again.')) });
    };
    if (window.turnstile) return show();
    const script = Object.assign(document.createElement('script'), { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true, onload: show });
    script.onerror = () => reject(new Error('The "are you human" check could not load. A content blocker may be stopping it.'));
    document.head.append(script);
  });
}

async function humanPass(fresh = false) {
  if (!config.turnstileSiteKey) return null;
  if (!fresh && human && human.until > Date.now() + 10_000) return human.pass;
  note($('left'), 'One quick check that you are a person…');
  const token = await turnstileToken();
  human = await call('/api/human', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  $('human').hidden = true;
  return human.pass;
}

async function choose(file) {
  if (!file) return;
  trail = null;
  $('loaded').hidden = true;
  $('drop').hidden = false;
  refresh();
  note($('trail'), `Reading ${file.name} in your browser…`);
  try {
    const { rows, notes } = trailRows(await file.text());
    trail = { name: file.name, rows, notes };
    const iso = /^\d{4}-\d{2}-\d{2}T/;
    const span = iso.test(rows[0].at) && iso.test(rows.at(-1).at) ? `, ${rows[0].at.slice(0, 10)} to ${rows.at(-1).at.slice(0, 10)}` : '';
    $('loaded-name').textContent = file.name;
    $('loaded-detail').textContent = `${plural(rows.length, 'change')}${span}. Kept in this tab; sent only when you ask.`;
    $('loaded').hidden = false;
    $('drop').hidden = true;
    note($('trail'), notes.join(' '));
    left = (await call('/api/limits')).left;
    refresh();
    if (left > 0) $('question').focus();
  } catch (error) {
    // Our own messages are written for a person. A bug's message is not, and is not shown.
    note($('trail'), error.constructor === Error ? error.message : 'Something went wrong reading that file. Nothing was sent.', true);
  } finally {
    $('file').value = '';
  }
}

function forget() {
  trail = null;
  $('loaded').hidden = true;
  $('drop').hidden = false;
  refresh();
  note($('trail'), 'Forgotten. The file was only ever in this tab, and our server kept nothing of it.');
}

const WORDS = { yes: 'Yes', no: 'No', unclear: 'Unclear' };

function showAnswer(question, result, seconds) {
  const card = $('answer-template').content.firstElementChild.cloneNode(true);
  const part = (selector) => card.querySelector(selector);
  card.classList.add(result.verdict);
  part('.asked').textContent = question;
  part('.verdict').textContent = WORDS[result.verdict];
  part('.sure-text').textContent = `${Math.round(result.p * 100)}% likely yes`;
  part('.message').textContent = result.message;
  if (result.evidence) {
    part('.evidence').hidden = false;
    part('.evidence code').append(Object.assign(document.createElement('time'), { textContent: result.evidence.at.slice(0, 19).replace('T', ' ') }), result.evidence.display);
  }
  const stopped = result.verdict === 'yes' && result.pages > 1 ? ', stopping at the first yes' : '';
  const aside = result.superseded ? ` ${plural(result.superseded, 'earlier change')} to a setting that was changed again ${result.superseded === 1 ? 'was' : 'were'} set aside: only the last one says what holds now.` : '';
  const by = result.messageBy === 'haiku' ? 'Jev decided; Claude Haiku worded it.' : 'Jev decided.';
  part('.meta').textContent = `Read ${plural(result.rows, 'change')} in ${plural(result.pages, 'page')}${stopped}, in ${seconds.toFixed(1)} s.${aside} ${by} It can be wrong.`;
  if (result.cost) {
    spent.usd += result.cost.total; spent.asked++; spent.tokens += result.tokens;
    part('.price-amount').textContent = money(result.cost.total);
    part('.price-split').textContent = `Jev ${money(result.cost.jev)} for ${count(result.tokens)} tokens read${result.messageBy === 'haiku' ? ` · Claude Haiku ${money(result.cost.haiku)}` : ''}`;
    $('tally').hidden = false;
    $('tally-spent').textContent = money(spent.usd);
    $('tally-asked').textContent = count(spent.asked);
    $('tally-avg').textContent = money(spent.usd / spent.asked);
    $('tally-tokens').textContent = count(spent.tokens);
  }
  $('answers').prepend(card);
  requestAnimationFrame(() => { part('.sure-bar i').style.width = `${Math.round(result.p * 100)}%`; });
}

async function ask(question, retried = false) {
  const pass = await humanPass(retried);
  note($('left'), `Sending ${plural(trail.rows.length, 'change')} and reading them…`);
  const packed = await gzip(JSON.stringify({ question, rows: trail.rows }));
  if (packed.body.size > config.maxBodyBytes) {
    throw new Error(`This file is too large to send in one go (${(packed.body.size / 1048576).toFixed(1)} MB packed; the limit is ${(config.maxBodyBytes / 1048576).toFixed(0)} MB). Export fewer months and try again.`);
  }
  try {
    return await call('/api/ask', { method: 'POST', body: packed.body, headers: { 'content-type': 'application/json', ...(pass ? { 'x-human-pass': pass } : {}), ...packed.headers } });
  } catch (error) {
    // The pass ran out, or the address changed (a phone moving between networks). Check once more, then ask again.
    if (error.status === 403 && error.human === false && !retried) { human = null; return ask(question, true); }
    throw error;
  }
}

$('file').addEventListener('change', (event) => choose(event.target.files[0]));
$('forget').addEventListener('click', forget);
for (const type of ['dragover', 'dragleave', 'drop']) {
  $('drop').addEventListener(type, (event) => {
    event.preventDefault();
    $('drop').classList.toggle('over', type === 'dragover');
    if (type === 'drop') choose(event.dataTransfer.files[0]);
  });
}
$('examples').addEventListener('click', (event) => {
  if (!event.target.matches('.chip') || event.target.disabled) return;
  $('question').value = event.target.textContent;
  $('question').focus();
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (!question || trail === null) return;
  $('question').disabled = $('send').disabled = true;
  $('send').classList.add('busy');
  const started = performance.now();
  try {
    const result = await ask(question);
    showAnswer(question, result, (performance.now() - started) / 1000);
    $('question').value = '';
    left = result.left;
    refresh();
    if (left > 0) $('question').focus();
  } catch (error) {
    if (typeof error.left === 'number') left = error.left;
    refresh(error.retryAt);
    $('human').hidden = true;
    if (error.status !== 429) note($('left'), error.constructor === Error ? error.message : 'Something went wrong. Nothing was counted.', true);
  } finally {
    $('send').classList.remove('busy');
  }
});

// The page describes the server it is talking to: its limits, who words the answers, and which build it is.
(async () => {
  try { config = { ...config, ...(await call('/api/config')) }; } catch { /* the defaults above are the server's defaults */ }
  for (const element of document.querySelectorAll('[data-config]')) element.textContent = config[element.dataset.config];
  const on = { turnstile: Boolean(config.turnstileSiteKey), haiku: config.wording === 'haiku', redis: config.counter === 'redis' };
  for (const element of document.querySelectorAll('[data-if]')) element.hidden = !on[element.dataset.if];
  if (config.sourceUrl) for (const id of ['source-top', 'source-mid', 'source-foot']) $(id).href = config.commit ? `${config.sourceUrl}/tree/${config.commit}` : config.sourceUrl;
  if (config.commit) $('build').textContent = ` @ ${config.commit.slice(0, 7)}`;
  if (config.prices) $('tally-note').textContent = `About, at the published prices: Jev $${config.prices.jevInput} per million tokens read, output free; Claude Haiku $${config.prices.haikuInput} in and $${config.prices.haikuOutput} out per million.`;
  refresh();
})();
