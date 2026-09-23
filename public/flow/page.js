/**
 * The Flow walk tab. A flow file is read here and drawn as Flow Builder saved it. A situation, written by Claude or by
 * the person, goes to Jev with the flow's decisions; Jev answers every decision at once, and the walk below follows
 * connectors through those answers, one step at a time, so the path can be watched. Where Jev is unsure the walk
 * stops and asks the person.
 */
import { parseFlow, wire, follow, layout, endNodeOf, decisionsOf, objectName, ENTRY } from '/flow/graph.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const svg = (name, attrs = {}, parent) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};
const h = (tag, props = {}, ...kids) => { const node = Object.assign(document.createElement(tag), props); node.append(...kids.filter((k) => k !== null && k !== undefined)); return node; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (p) => (p === null || p === undefined ? '' : p.toFixed(2));
const count = (n) => n.toLocaleString('en');
/** Dollars; below a cent, two significant digits, because a walk costs a few thousandths of a cent. */
const money = (usd) => `$${usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3).replace(/0$/, '') : usd.toLocaleString('en', { maximumSignificantDigits: 2 })}`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- tabs: one experiment at a time --------------------------------------------------------------------------------
const tabs = [...document.querySelectorAll('.tab[data-tab]')];
const panels = [...document.querySelectorAll('[data-panel]')];
function show(name) {
  for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
  for (const tab of tabs) { if (tab.dataset.tab === name) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); }
}
const fromHash = () => (location.hash === '#flow' ? 'flow' : 'audit-trail');
addEventListener('hashchange', () => show(fromHash()));
show(fromHash());

// ---- the server -----------------------------------------------------------------------------------------------------
let browserId = null;
try { browserId = localStorage.getItem('browser-id'); if (!browserId) { browserId = crypto.randomUUID(); localStorage.setItem('browser-id', browserId); } } catch { browserId = crypto.randomUUID(); }
let config = { flow: { maxWalks: 60, writer: false, walker: false }, turnstileSiteKey: null, windowHours: 24 };
let human = null;
let widget = null;

async function call(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-browser-id': browserId, ...options.headers } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error ?? `The server answered ${response.status}.`), json, { status: response.status });
  return json;
}

// The same check as the audit-trail tab, in this tab's own box.
function turnstileToken() {
  $('flow-human').hidden = false;
  return new Promise((resolve, reject) => {
    const render = () => {
      if (widget !== null) window.turnstile.remove(widget);
      widget = window.turnstile.render('#flow-human-widget', { sitekey: config.turnstileSiteKey, theme: 'light', callback: resolve, 'error-callback': () => reject(new Error('The "are you human" check could not load. Please try again.')) });
    };
    if (window.turnstile) return render();
    const script = Object.assign(document.createElement('script'), { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true, onload: render });
    script.onerror = () => reject(new Error('The "are you human" check could not load. A content blocker may be stopping it.'));
    document.head.append(script);
  });
}
async function humanPass(fresh = false) {
  if (!config.turnstileSiteKey) return null;
  if (!fresh && human && human.until > Date.now() + 10_000) return human.pass;
  const token = await turnstileToken();
  human = await call('/api/human', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  $('flow-human').hidden = true;
  return human.pass;
}
async function post(path, payload) {
  const send = async (fresh) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-human-pass': (await humanPass(fresh)) ?? '' }, body: JSON.stringify(payload) });
  try { return await send(false); } catch (error) { if (error.human === false) return send(true); throw error; }
}

function note(text, error = false) {
  const p = $('flow-note');
  p.hidden = !text;
  p.textContent = text ?? '';
  p.classList.toggle('error', error);
}
function allowance(left) {
  if (left === undefined || left === null) return;
  const max = config.flow.maxWalks;
  $('flow-left').textContent = left > 0 ? `${left} of ${max} walks and suggestions left, every ${config.windowHours} hours.` : `That was all ${max} walks for now.`;
  $('flow-left').classList.toggle('error', left < 1);
}

// ---- state ----------------------------------------------------------------------------------------------------------
let flow = null;          // the parsed flow: lives in this tab
let sent = null;          // what the server is sent of it
let drawing = null;       // { layout, nodes: Map<name, g>, edges: [{ from, to, label, path }] }
let situations = [];
let active = null;        // the situation card being walked, if any
let current = null;       // { answers, steps, chosen, situation, meta }
let run = 0;              // a newer walk cancels an older animation
const walked = new Map(); // situation text → { answers, meta }: a situation is sent once
const spent = { jev: 0, opus: 0, walks: 0, tokens: 0, written: 0 };   // this tab only, summed from what each reply reports

/** The tab's running cost, as the audit trail keeps it: a walk once, however often it is replayed. */
function tally() {
  $('flow-tally').hidden = false;
  $('flow-spent').textContent = money(spent.jev + spent.opus);
  $('flow-walks').textContent = count(spent.walks);
  $('flow-per-walk').textContent = spent.walks ? money(spent.jev / spent.walks) : '–';
  $('flow-opus').textContent = spent.written ? money(spent.opus) : '–';
  const p = config.prices;
  if (p) $('flow-tally-note').textContent = `About, at the published prices: Jev $${p.jevInput} per million tokens read, output free; Claude Opus 5 $${p.opusInput} in and $${p.opusOutput} out per million. ${count(spent.tokens)} tokens read by Jev in ${count(spent.walks)} walk${spent.walks === 1 ? '' : 's'}.`;
}

// ---- choosing a flow ------------------------------------------------------------------------------------------------
const KIND = {
  start: 'Start', end: 'End', decisions: 'Decision', assignments: 'Assignment', recordLookups: 'Get Records', recordCreates: 'Create Records',
  recordUpdates: 'Update Records', recordDeletes: 'Delete Records', actionCalls: 'Action', screens: 'Screen', loops: 'Loop', subflows: 'Subflow',
  customErrors: 'Custom Error', collectionProcessors: 'Collection', waits: 'Wait', orchestratedStages: 'Stage', recordRollbacks: 'Roll Back',
};
const describeFlow = (f) => {
  const when = { RecordAfterSave: 'after a record is saved', RecordBeforeSave: 'before a record is saved', RecordBeforeDelete: 'before a record is deleted', Scheduled: 'on a schedule', PlatformEvent: 'when a platform event arrives' }[f.trigger];
  const what = f.object ? ` on ${objectName(f.object)}` : '';
  const kind = f.type === 'Flow' ? 'Screen flow' : when ? `Runs ${when}${what}` : `${f.type}${what}`;
  const decisions = decisionsOf(f).length;
  return `${kind} · ${f.elements.size} elements · ${decisions} decision${decisions === 1 ? '' : 's'}${f.entry ? ' (with start conditions)' : ''}`;
};

function load(text, name) {
  try {
    flow = parseFlow(text);
  } catch (error) {
    note(error.message, true);
    return;
  }
  sent = wire(flow);
  if (!sent.decisions.length) note('This flow has no decisions: it always takes the same path, so there is nothing for Jev to decide. It is drawn below.');
  else note('');
  $('flow-drop').hidden = true;
  $('flow-sample').hidden = true;
  $('flow-loaded').hidden = false;
  $('flow-name').textContent = flow.label;
  $('flow-detail').textContent = `${name} · ${describeFlow(flow)}`;
  $('flow-ask').setAttribute('aria-disabled', String(!sent.decisions.length));
  for (const control of [$('situation'), $('walk'), $('suggest')]) control.disabled = !sent.decisions.length;
  $('suggest').hidden = !config.flow.writer;
  situations = [];
  walked.clear();
  current = null;
  active = null;
  run++;
  $('situation').value = '';
  $('situations').replaceChildren();
  draw();
  if (sent.decisions.length && config.flow.writer) suggest();
}

function forget() {
  expand(false);
  flow = sent = drawing = current = null;
  run++;
  $('flow-drop').hidden = false;
  $('flow-sample').hidden = false;
  $('flow-loaded').hidden = true;
  $('flow-ask').setAttribute('aria-disabled', 'true');
  $('situations').replaceChildren();
  $('stage').hidden = true;
  note('');
}

$('flow-file').addEventListener('change', async (event) => { const file = event.target.files[0]; if (file) load(await file.text(), file.name); event.target.value = ''; });
const drop = $('flow-drop');
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (event) => { event.preventDefault(); drop.classList.remove('over'); const file = event.dataTransfer.files[0]; if (file) load(await file.text(), file.name); });
$('flow-sample').addEventListener('click', async () => {
  const response = await fetch('/flow/samples/case-triage.flow-meta.xml');
  load(await response.text(), 'Sample: case-triage.flow-meta.xml');
});
$('flow-forget').addEventListener('click', forget);

// ---- situations -----------------------------------------------------------------------------------------------------
async function suggest() {
  const box = $('situations');
  box.replaceChildren(...Array.from({ length: 6 }, () => h('div', { className: 'situation skeleton' }, h('span'), h('span'), h('span'))));
  $('suggest').disabled = true;
  $('suggest-status').textContent = 'Claude Opus 5 is reading the flow and writing situations. It takes about 20 seconds.';
  const asked = flow;
  try {
    const result = await post('/api/flow-situations', { flow: sent });
    if (asked !== flow) return;
    situations = result.situations;
    allowance(result.walksLeft);
    spent.opus += result.cost ?? 0;
    spent.written++;
    tally();
    $('suggest-status').textContent = `Written by Claude Opus 5 from the flow's decisions, for ${money(result.cost ?? 0)} (${count(result.tokens?.input ?? 0)} tokens in, ${count(result.tokens?.output ?? 0)} out). Pick one to walk it, or write your own below.`;
    box.replaceChildren(...situations.map(card));
  } catch (error) {
    if (asked !== flow) return;
    box.replaceChildren();
    $('suggest-status').textContent = `${error.message} You can still describe a situation yourself below.`;
    allowance(error.walksLeft);
  } finally {
    $('suggest').disabled = !flow;
  }
}
$('suggest').addEventListener('click', suggest);

function card(situation) {
  const button = h('button', { type: 'button', className: 'situation' },
    h('strong', {}, situation.title),
    h('span', { className: 'situation-text' }, situation.text),
    h('span', { className: 'situation-status' }, situation.vague ? 'Leaves one fact out' : ''));
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.situation.active')) other.classList.remove('active');
    button.classList.add('active');
    active = { situation, button };
    $('situation').value = situation.text;
    walk(situation.text, situation);
  });
  situation.card = button;
  return button;
}

$('flow-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('situation').value.trim();
  if (text.length < 10) return note('Describe what happened in a sentence or two.', true);
  const picked = situations.find((s) => s.text === text);
  if (!picked) for (const other of document.querySelectorAll('.situation.active')) other.classList.remove('active');
  walk(text, picked ?? null);
});
$('situation').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('flow-form').requestSubmit(); });

// ---- walking --------------------------------------------------------------------------------------------------------
async function walk(text, situation) {
  if (!flow || !sent.decisions.length) return;
  note('');
  $('walk').disabled = true;
  $('walk').classList.add('busy');
  const token = ++run;
  reset();
  // The walk is the point: bring the whole canvas into view before it starts.
  if (!$('stage').classList.contains('expanded')) $('stage').scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  $('trace-list').replaceChildren(h('li', { className: 'trace-wait' }, 'Jev is reading the situation and deciding every decision at once…'));
  try {
    let result = walked.get(text);
    if (!result) {
      const started = performance.now();
      const reply = await post('/api/flow-walk', { flow: sent, situation: text });
      result = { answers: reply.answers, meta: { ms: Math.round(performance.now() - started), tokens: reply.tokens, requests: reply.requests, decisions: sent.decisions.length, cost: reply.cost ?? 0 } };
      walked.set(text, result);
      allowance(reply.walksLeft);
      spent.jev += result.meta.cost;
      spent.walks++;
      spent.tokens += reply.tokens;
      tally();
    }
    if (token !== run) return;
    current = { answers: result.answers, chosen: {}, situation, meta: result.meta, text };
    current.steps = follow(flow, current.answers, { chosen: current.chosen });
    $('trace-list').replaceChildren();
    await animate(current.steps, 0, token);
  } catch (error) {
    if (token !== run) return;
    $('trace-list').replaceChildren();
    note(error.message, true);
    allowance(error.walksLeft);
  } finally {
    if (token === run) { $('walk').disabled = false; $('walk').classList.remove('busy'); }
  }
}

/** Plays the steps from `from` on: the dot travels each connector, each node lights as it is reached. */
async function animate(steps, from, token) {
  $('canvas').classList.add('walking');
  for (let i = from; i < steps.length; i++) {
    if (token !== run) return;
    const step = steps[i];
    const name = nodeOf(step);
    if (i > 0 && i !== from) await travel(edgeOf(nodeOf(steps[i - 1]), name, step.via), token);
    if (token !== run) return;
    light(name, step);
    trace(step, i);
    focus(name);
    if (step.ranked?.length) await sleep(reduced ? 0 : 420);
    if (step.fork) { fork(step, i); return summary(steps); }
  }
  $('dot').setAttribute('opacity', '0');
  summary(steps);
  if (follows) setTimeout(() => token === run && showPath(steps), reduced ? 0 : 500);
}

/** Once the walk is over, pull back until the whole lit path is in view. */
function showPath(steps) {
  const points = steps.map((s) => drawing.layout.nodes.get(nodeOf(s))).filter(Boolean);
  if (!points.length) return;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  target = around({ x: Math.min(...xs) - 120, y: Math.min(...ys) - 80, width: Math.max(...xs) - Math.min(...xs) + 440, height: Math.max(...ys) - Math.min(...ys) + 180 });
  ease();
}

const nodeOf = (step) => (step.kind === 'end' ? endNodeOf(flow, step) : step.name);
function edgeOf(from, to, via) {
  return drawing.edges.find((e) => e.from === from && e.to === to && (via === null || via === undefined || e.label === via))
    ?? drawing.edges.find((e) => e.from === from && e.to === to);
}

function travel(edge, token) {
  if (!edge) return Promise.resolve();
  const path = edge.path;
  const length = path.getTotalLength();
  const duration = reduced ? 0 : Math.min(1100, Math.max(360, length * 0.7));
  path.classList.add('on');
  path.style.strokeDasharray = `${length}`;
  const dot = $('dot');
  dot.setAttribute('opacity', '1');
  return new Promise((resolve) => {
    const started = performance.now();
    const frame = (now) => {
      if (token !== run) return resolve();
      const t = duration ? Math.min(1, (now - started) / duration) : 1;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const point = path.getPointAtLength(length * eased);
      dot.setAttribute('cx', point.x);
      dot.setAttribute('cy', point.y);
      path.style.strokeDashoffset = `${length * (1 - eased)}`;
      if (follows) focusPoint(point.x, point.y);
      if (t < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function light(name, step) {
  for (const node of drawing.nodes.values()) node.classList.remove('current');
  const node = drawing.nodes.get(name);
  if (!node) return;
  node.classList.add('visited', 'current');
  node.classList.toggle('fork', Boolean(step.fork));
  if (step.outcome) {
    const badge = node.querySelector('.badge');
    badge.querySelector('text').textContent = `${step.outcome}${step.by === 'you' ? ' · you chose' : ` · ${pct(step.p)}`}`;
    const box = badge.querySelector('text').getBBox();
    badge.querySelector('rect').setAttribute('width', box.width + 16);
    badge.classList.add('shown');
  }
}

function reset() {
  if (!drawing) return;
  for (const node of drawing.nodes.values()) { node.classList.remove('visited', 'current', 'fork'); node.querySelector('.badge')?.classList.remove('shown'); }
  for (const edge of drawing.edges) { edge.path.classList.remove('on'); edge.path.style.strokeDasharray = ''; edge.path.style.strokeDashoffset = ''; }
  $('canvas').classList.remove('walking');
  $('dot').setAttribute('opacity', '0');
  $('fork').hidden = true;
  $('verdict').hidden = true;
  $('trace-meta').textContent = '';
  $('walk-price').hidden = true;
}

// ---- the trace beside the canvas ------------------------------------------------------------------------------------
function trace(step, index) {
  const list = $('trace-list');
  const kind = step.kind === 'start' ? 'start' : step.kind === 'end' ? 'end' : step.kind;
  const item = h('li', { className: `trace-step kind-${kind}${step.fork ? ' fork' : ''}` });
  item.dataset.index = index;
  const title = step.kind === 'start' ? (step.decision ? 'Start conditions' : 'Start') : step.label;
  item.append(h('span', { className: 'trace-kind' }, step.kind === 'start' && step.decision ? 'Start' : KIND[kind] ?? kind), h('span', { className: 'trace-label' }, title));
  if (step.ranked?.length && !step.fork) {
    item.append(h('span', { className: `trace-outcome${step.by === 'you' ? ' chosen' : ''}` }, step.outcome, h('em', {}, step.by === 'you' ? 'you chose' : `Jev ${pct(step.p)}`)));
    item.append(odds(step.ranked, step.outcome));
  }
  if (step.fork) item.append(h('span', { className: 'trace-outcome ask' }, 'Jev cannot tell', h('em', {}, `best guess ${pct(step.ranked[0]?.[1])}`)));
  list.append(item);
  // Only the list scrolls to the newest step; the page stays where the person put it.
  list.scrollTo({ left: list.scrollWidth, behavior: reduced ? 'auto' : 'smooth' });
}

function odds(ranked, picked) {
  const list = h('span', { className: 'odds' });
  for (const [label, p] of ranked.slice(0, 3)) {
    const bar = h('span', { className: `odd${label === picked ? ' picked' : ''}`, title: `${label}: ${pct(p)}` }, h('i', { style: `width:${Math.max(2, p * 100)}%` }), h('span', {}, label), h('b', {}, pct(p)));
    list.append(bar);
  }
  return list;
}

/** Jev was unsure: the person picks the outcome, and the walk goes on from that decision. */
function fork(step, index) {
  const box = $('fork');
  box.hidden = false;
  box.replaceChildren(
    h('p', {}, h('strong', {}, step.kind === 'start' ? 'Does the flow start?' : step.label), ' The situation does not settle this, so Jev is not sure. Which way should it go?'),
    h('div', { className: 'fork-options' }, ...step.ranked.map(([label, p]) => {
      const button = h('button', { type: 'button', className: 'chip' }, label, h('em', {}, pct(p)));
      button.addEventListener('click', async () => {
        box.hidden = true;
        current.chosen[step.kind === 'start' ? ENTRY : step.name] = label;
        current.steps = follow(flow, current.answers, { chosen: current.chosen });
        for (const li of [...$('trace-list').children]) if (Number(li.dataset.index) >= index) li.remove();
        $('verdict').hidden = true;
        const token = ++run;
        await animate(current.steps, index, token);
      });
      return button;
    })),
  );
}

/** How the walk compares with the path Claude wrote the situation for; and what it took. */
function summary(steps) {
  const { meta, situation } = current;
  $('trace-meta').textContent = `Jev decided all ${meta.decisions} decision${meta.decisions === 1 ? '' : 's'} in ${meta.requests === 1 ? 'one request' : `${meta.requests} requests`}, ${meta.ms.toLocaleString('en')} ms.`;
  const price = $('walk-price');
  price.hidden = false;
  price.querySelector('.price-amount').textContent = money(meta.cost);
  price.querySelector('.price-split').textContent = `Jev, ${count(meta.tokens)} tokens read`;
  const verdict = $('verdict');
  verdict.hidden = !situation?.path?.length;
  if (!situation?.path?.length) return;
  const decided = steps.filter((s) => s.ranked?.length).map((s) => ({ key: s.kind === 'start' ? 'Start conditions' : s.label, outcome: s.fork ? '?' : s.outcome, p: s.p, by: s.by, fork: s.fork }));
  const meant = situation.path.map((p) => { const [key, outcome] = p.split(/\s*→\s*/); return { key, outcome }; });
  let i = 0;
  while (i < decided.length && i < meant.length && decided[i].key === meant[i].key && decided[i].outcome === meant[i].outcome && decided[i].by === 'jev') i++;
  const status = situation.card?.querySelector('.situation-status');
  if (i === decided.length && i === meant.length) {
    verdict.className = 'verdict-line same';
    verdict.textContent = situation.vague ? 'Claude left one fact out on purpose, and Jev stopped right there to ask.' : 'Jev took the path Claude wrote this situation for.';
    if (status) status.textContent = situation.vague ? 'Jev stopped to ask' : 'Jev agreed with Claude';
  } else if (decided[i]?.by === 'you') {
    verdict.className = 'verdict-line';
    verdict.textContent = `Up to "${decided[i].key}" Jev took the path Claude meant; from there you chose.`;
  } else {
    const got = decided[i];
    const wanted = meant[i];
    verdict.className = 'verdict-line differs';
    verdict.textContent = !got ? `Claude meant the walk to reach "${wanted.key}"; it ended before that.`
      : !wanted ? `Claude's path ended at "${meant.at(-1)?.key}"; Jev's walk went on to "${got.key}".`
        : wanted.key !== got.key ? `Claude meant the walk to reach "${wanted.key}" next; Jev's reached "${got.key}".`
          : wanted.outcome === '?' ? `Claude left out a fact "${got.key}" needs, but Jev chose "${got.outcome}" anyway (${pct(got.p)}).`
            : got.fork ? `At "${got.key}" Claude meant "${wanted.outcome}"; Jev could not tell from the words.`
              : `At "${got.key}" Claude meant "${wanted.outcome}"; Jev chose "${got.outcome}" (${pct(got.p)}).`;
    if (status) status.textContent = 'Jev went another way';
  }
}

// ---- the canvas -----------------------------------------------------------------------------------------------------
const COLOURS = { start: '#29a383', end: '#8d8d8d', decisions: '#e8803a', assignments: '#e8803a', loops: '#e8803a', collectionProcessors: '#e8803a',
  recordLookups: '#d6409f', recordCreates: '#d6409f', recordUpdates: '#d6409f', recordDeletes: '#d6409f', recordRollbacks: '#d6409f',
  actionCalls: '#3e63dd', subflows: '#3e63dd', screens: '#0588f0', waits: '#8e4ec6', customErrors: '#e5484d' };
const GLYPHS = {
  start: 'M-5 -7 L7 0 L-5 7 Z',
  end: 'M-5 -5 H5 V5 H-5 Z',
  assignments: 'M-7 -3 H7 M-7 3 H7',
  recordLookups: 'M-2 -2 m-5 0 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 M2 2 L7 7',
  recordCreates: 'M0 -7 V7 M-7 0 H7',
  recordUpdates: 'M-6 6 L-6 3 L4 -7 L7 -4 L-3 6 Z',
  recordDeletes: 'M-6 -6 L6 6 M6 -6 L-6 6',
  actionCalls: 'M2 -8 L-5 1 H1 L-2 8 L5 -1 H-1 Z',
  subflows: 'M-6 -6 H2 V6 M-2 2 L2 6 L6 2',
  screens: 'M-7 -6 H7 V6 H-7 Z M-7 -2 H7',
  loops: 'M5 -3 A6 6 0 1 0 6 2 M5 -7 V-3 H1',
  customErrors: 'M0 -6 V2 M0 6 V6.5',
  waits: 'M0 -7 A7 7 0 1 0 0.1 -7 M0 -4 V0 L3 3',
};

let view = null;          // { x, y, w, h }: what the canvas shows, in the flow's own coordinates
let target = null;
let follows = true;

function draw() {
  const canvas = $('canvas');
  const L = layout(flow);
  drawing = { layout: L, nodes: new Map(), edges: [] };
  canvas.replaceChildren();
  canvas.classList.remove('walking');
  const defs = svg('defs', {}, canvas);
  const arrow = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, defs);
  svg('path', { d: 'M0 1 L9 5 L0 9 Z', class: 'arrow-head' }, arrow);
  const edgeLayer = svg('g', { class: 'edges' }, canvas);
  const labelLayer = svg('g', { class: 'edge-labels' }, canvas);
  const nodeLayer = svg('g', { class: 'nodes' }, canvas);

  for (const e of L.edges) {
    const a = L.nodes.get(e.from);
    const b = L.nodes.get(e.to);
    const { d, label } = route(a, b, e, flow.elements.get(e.from));
    const path = svg('path', { d, class: `edge${e.fault ? ' fault' : ''}`, 'marker-end': 'url(#arrow)' }, edgeLayer);
    drawing.edges.push({ ...e, path });
    if (e.label) {
      const g = svg('g', { class: 'edge-label', transform: `translate(${label.x} ${label.y})` }, labelLayer);
      const rect = svg('rect', { x: 0, y: -10, height: 20, rx: 10 }, g);
      const text = svg('text', { x: 8, y: 4 }, g);
      text.textContent = e.label.length > 34 ? `${e.label.slice(0, 32)}…` : e.label;
      rect.setAttribute('width', text.textContent.length * 6.2 + 16);
      g.setAttribute('transform', `translate(${label.x - (text.textContent.length * 6.2 + 16) / 2} ${label.y})`);
    }
  }
  for (const [name, n] of L.nodes) drawing.nodes.set(name, node(n, name, nodeLayer));
  svg('circle', { id: 'dot', r: 7, cx: 0, cy: 0, opacity: 0 }, canvas);

  $('stage').hidden = false;
  $('trace-list').replaceChildren(h('li', { className: 'trace-wait' }, sent.decisions.length ? 'Pick a situation, or write one, to walk the flow.' : 'This flow always takes the same path.'));
  $('verdict').hidden = true;
  $('fork').hidden = true;
  $('trace-meta').textContent = '';
  follows = true;
  $('follow').setAttribute('aria-pressed', 'true');
  view = null;
  fit(true);
  if (!sent.decisions.length) { current = { answers: {}, chosen: {}, meta: null }; }
}

function node(n, name, parent) {
  const g = svg('g', { class: `node kind-${n.kind}`, transform: `translate(${n.x} ${n.y})` }, parent);
  const colour = COLOURS[n.kind] ?? '#646464';
  if (n.kind === 'decisions') svg('rect', { class: 'icon', x: -17, y: -17, width: 34, height: 34, rx: 6, transform: 'rotate(45)', fill: colour }, g);
  else if (n.kind === 'start' || n.kind === 'end') svg('circle', { class: 'icon', r: n.kind === 'end' ? 15 : 21, fill: colour }, g);
  else svg('rect', { class: 'icon', x: -20, y: -20, width: 40, height: 40, rx: 11, fill: colour }, g);
  svg('circle', { class: 'ring', r: n.kind === 'end' ? 22 : 30 }, g);
  // A decision's glyph is a question mark; an element with no glyph of its own gets a dash.
  svg('path', { class: 'glyph', d: n.kind === 'decisions' ? 'M-3.5 -3.5 A3.6 3.6 0 1 1 0.5 0 V2.5 M0.5 5.5 V6' : GLYPHS[n.kind] ?? 'M-4 0 H4' }, g);

  const x = n.kind === 'end' ? 22 : 30;
  if (n.kind !== 'start' && n.kind !== 'end') svg('text', { class: 'caption', x, y: -6 }, g).textContent = KIND[n.kind] ?? n.kind;
  const lines = wrap(n.kind === 'start' ? startTitle() : n.label, 26, 2);
  lines.forEach((line, i) => { const t = svg('text', { class: 'label', x, y: (n.kind === 'start' || n.kind === 'end' ? 4 : 10) + i * 15 }, g); t.textContent = line; });
  if (n.kind === 'start' && flow.entry) { const t = svg('text', { class: 'caption', x, y: 4 + lines.length * 15 }, g); t.textContent = 'with start conditions'; }
  // Under the label, as for every node; Start's also clears its "with start conditions" line.
  const below = n.kind === 'start' ? 4 + (lines.length + (flow.entry ? 1 : 0)) * 15 + 8 : 20 + lines.length * 15 - 6;
  const badge = svg('g', { class: 'badge', transform: `translate(${x} ${below})` }, g);
  svg('rect', { x: 0, y: -11, height: 22, rx: 11 }, badge);
  svg('text', { x: 8, y: 4 }, badge);
  const tip = svg('title', {}, g);
  tip.textContent = n.kind === 'start' || n.kind === 'end' ? n.label : `${KIND[n.kind] ?? n.kind}: ${n.label}`;
  g.addEventListener('click', () => { follows = false; $('follow').setAttribute('aria-pressed', 'false'); focusPoint(n.x + 80, n.y, true); });
  return g;
}

const startTitle = () => {
  const when = { RecordAfterSave: 'saved', RecordBeforeSave: 'about to be saved', RecordBeforeDelete: 'about to be deleted' }[flow.trigger];
  if (when && flow.object) return `${objectName(flow.object)} ${when}`;
  if (flow.trigger === 'Scheduled') return 'On a schedule';
  if (flow.trigger === 'PlatformEvent') return `${flow.object ? objectName(flow.object) : 'Platform'} event`;
  return flow.type === 'Flow' ? 'Screen flow starts' : 'Flow starts';
};

function wrap(text, width, max) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width && line) { lines.push(line); line = word; } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  if (lines.length > max) { lines.length = max; lines[max - 1] = `${lines[max - 1].slice(0, width - 1)}…`; }
  return lines;
}

/** Orthogonal connectors as Flow Builder draws them: down, across where a branch splits or joins, down again. */
function route(a, b, edge, from) {
  const top = (n) => (n.kind === 'end' ? 16 : n.kind === 'decisions' ? 25 : 22);
  // "Does not run" leaves over the top of Start, so it never runs through Start's own label.
  if (edge.side) return { d: `M${a.x} ${a.y - 22} V${a.y - 46} H${b.x} V${b.y - 16}`, label: { x: (a.x + b.x) / 2 + 40, y: a.y - 46 } };
  const x1 = a.x, y1 = a.y + top(a), x2 = b.x, y2 = b.y - top(b);
  if (y2 > y1 + 8) {
    const branching = from && (from.kind === 'decisions' || from.kind === 'loops');
    if (Math.abs(x1 - x2) < 1) return { d: `M${x1} ${y1} V${y2}`, label: { x: x2, y: y1 + Math.min(40, (y2 - y1) / 2) } };
    const bend = branching ? Math.min(y1 + 34, y2 - 20) : Math.max(y2 - 34, y1 + 20);
    const r = Math.min(10, Math.abs(x2 - x1) / 2, Math.abs(bend - y1), Math.abs(y2 - bend));
    const dir = x2 > x1 ? 1 : -1;
    const d = `M${x1} ${y1} V${bend - r} Q${x1} ${bend} ${x1 + dir * r} ${bend} H${x2 - dir * r} Q${x2} ${bend} ${x2} ${bend + r} V${y2}`;
    return { d, label: { x: x2, y: branching ? bend + 22 : (bend + y2) / 2 } };
  }
  // Back up the canvas (a loop's next item): out to the right, up, and into the target's side.
  const side = Math.max(a.x, b.x) + 190;
  return { d: `M${a.x} ${a.y + top(a)} V${a.y + top(a) + 18} H${side} V${b.y} H${b.x + 26}`, label: { x: side, y: (a.y + b.y) / 2 } };
}

// ---- the camera --------------------------------------------------------------------------------------------------
/**
 * The view keeps a scale, in flow units per screen pixel, so a bigger canvas (full screen) shows more of the flow
 * instead of the same part larger. READ is the scale labels read well at: following the walk pans at it.
 */
const READ = 1.15;
function pixels() { const r = $('canvas').getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height) }; }
function apply() { $('canvas').setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); }
const scaleOf = () => view.w / pixels().w;
/** The view centred on (x, y) at `scale`. */
function at(x, y, scale) { const p = pixels(); return { x: x - (p.w * scale) / 2, y: y - (p.h * scale) / 2, w: p.w * scale, h: p.h * scale }; }
/** The view that shows all of `box`, never closer than one to one. */
function around(box) { const p = pixels(); return at(box.x + box.width / 2, box.y + box.height / 2, Math.max(box.width / p.w, box.height / p.h, 1)); }

function fit(now = false) {
  const whole = around(drawing.layout.box);
  // A flow that fits whole only too small to read starts at reading size, on its beginning.
  if (whole.w / pixels().w > READ * 1.6) {
    const s = drawing.layout.nodes.get('$start');
    target = at(s.x + 60, s.y - 70 + (pixels().h * READ) / 2, READ);
  } else target = whole;
  if (now || !view) { view = { ...target }; apply(); } else ease();
}
function focus(name) {
  if (!follows) return;
  const n = drawing.layout.nodes.get(name);
  if (n) focusPoint(n.x + 80, n.y);
}
/** Pans to (x, y), a little above the middle, at reading size (or closer, if the person has zoomed in). */
function focusPoint(x, y, force = false) {
  if (!follows && !force) return;
  const scale = Math.min(scaleOf(), READ);
  target = at(x, y + pixels().h * scale * 0.08, scale);
  ease();
}
let easing = false;
function ease() {
  if (easing) return;
  easing = true;
  const step = () => {
    const f = reduced ? 1 : 0.14;
    let done = true;
    for (const key of ['x', 'y', 'w', 'h']) { const d = target[key] - view[key]; view[key] += d * f; if (Math.abs(d) > 0.5) done = false; }
    apply();
    if (done) { view = { ...target }; apply(); easing = false; } else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function zoom(by, cx = view.x + view.w / 2, cy = view.y + view.h / 2) {
  follows = false;
  $('follow').setAttribute('aria-pressed', 'false');
  const scale = Math.min(Math.max(scaleOf() * by, 0.3), 20);
  const next = at(0, 0, scale);
  target = { x: cx - (cx - view.x) * (next.w / view.w), y: cy - (cy - view.y) * (next.h / view.h), w: next.w, h: next.h };
  ease();
}

/**
 * Full screen: the browser's own when it allows it (Esc leaves it), otherwise the stage is lifted over the page, to
 * <body>, so no transformed or clipping ancestor inside the console can hold it. Some hosts neither grant nor refuse
 * the browser's own (an app's embedded browser can leave the request unanswered), so it gets 700 ms, then the lift.
 */
const home = document.createComment('stage');
let overlay = false;
function shown(on) {
  $('stage').classList.toggle('expanded', on);
  $('expand').setAttribute('aria-pressed', String(on));
  $('expand').textContent = on ? 'Exit full screen' : 'Full screen';
}
function lift(on) {
  const stage = $('stage');
  overlay = on;
  stage.classList.toggle('overlay', on);
  document.body.classList.toggle('stage-open', on);
  if (on) { stage.before(home); document.body.append(stage); } else if (home.parentNode) home.replaceWith(stage);
}
async function expand(on) {
  const stage = $('stage');
  if (on === stage.classList.contains('expanded')) return;
  if (on) {
    const native = stage.requestFullscreen && document.fullscreenEnabled
      ? await Promise.race([stage.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false), sleep(700).then(() => false)])
      : false;
    if (!native || document.fullscreenElement !== stage) lift(true);
    shown(true);
  } else {
    if (document.fullscreenElement === stage) await document.exitFullscreen().catch(() => {});
    if (overlay) lift(false);
    shown(false);
  }
}
// Esc in the browser's own full screen leaves it without a click on the button.
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !overlay && $('stage').classList.contains('expanded')) shown(false); });
$('expand').addEventListener('click', () => expand(!$('stage').classList.contains('expanded')));
addEventListener('keydown', (event) => { if (event.key === 'Escape' && overlay) expand(false); });
$('zoom-in').addEventListener('click', () => zoom(0.8));
$('zoom-out').addEventListener('click', () => zoom(1.25));
$('fit').addEventListener('click', () => {
  follows = false;
  $('follow').setAttribute('aria-pressed', 'false');
  target = around(drawing.layout.box);
  ease();
});
$('follow').addEventListener('click', () => {
  follows = !follows;
  $('follow').setAttribute('aria-pressed', String(follows));
  const last = current?.steps?.findLast?.((s) => drawing.nodes.get(nodeOf(s))?.classList.contains('visited'));
  if (follows && last) focus(nodeOf(last));
});
{
  const canvas = $('canvas');
  let drag = null;
  canvas.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; drag = { x: event.clientX, y: event.clientY, view: { ...view } }; canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging'); });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const scale = view.w / canvas.getBoundingClientRect().width;
    if (follows && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) { follows = false; $('follow').setAttribute('aria-pressed', 'false'); }
    view = { ...drag.view, x: drag.view.x - (event.clientX - drag.x) * scale, y: drag.view.y - (event.clientY - drag.y) * scale };
    target = { ...view };
    apply();
  });
  const end = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoom(event.deltaY > 0 ? 1.12 : 0.89, view.x + ((event.clientX - r.left) / r.width) * view.w, view.y + ((event.clientY - r.top) / r.height) * view.h);
  }, { passive: false });
  // A new canvas size keeps the scale and the centre: more room shows more of the flow.
  let size = null;
  new ResizeObserver(() => {
    const p = pixels();
    if (view && drawing && size) { const next = at(view.x + view.w / 2, view.y + view.h / 2, view.w / size.w); view = next; target = { ...next }; apply(); }
    size = p;
  }).observe(canvas);
}

// ---- start --------------------------------------------------------------------------------------------------------
(async () => {
  try {
    config = { ...config, ...(await call('/api/config')) };
    const limits = await call('/api/limits');
    allowance(limits.walksLeft);
  } catch { /* the page still draws flows without the server */ }
  for (const hop of document.querySelectorAll('[data-if-flow="writer"]')) hop.hidden = !config.flow?.writer;
  if (!config.flow?.walker) note('Jev is not set up on this server, so flows can be drawn but not walked.', true);
})();
