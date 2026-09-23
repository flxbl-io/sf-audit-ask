/**
 * A Salesforce flow, read from its .flow-meta.xml, as a graph: the page draws it, the walk follows it, and the server
 * is sent only what its questions need. The same module runs in the browser and in the tests, so it needs nothing but
 * the language: it reads the XML itself.
 *
 * Jev decides the decisions; this code only follows connectors. It never evaluates a condition.
 */

// ---- XML: enough for Salesforce metadata ---------------------------------------------------------------------------
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e] ?? m);

/** Elements, text, entities, CDATA, comments and the declaration. Attributes are skipped: metadata carries only xmlns. */
export function parseXml(source) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf('<', at);
    const text = source.slice(at, open === -1 ? source.length : open);
    if (text.trim()) stack.at(-1).text += decode(text);
    if (open === -1) break;
    const skip = (end, add = 0) => { const found = source.indexOf(end, open); if (found === -1) throw new Error('The XML ends too early.'); return found + add; };
    if (source.startsWith('<!--', open)) { at = skip('-->', 3); continue; }
    if (source.startsWith('<![CDATA[', open)) { const end = skip(']]>'); stack.at(-1).text += source.slice(open + 9, end); at = end + 3; continue; }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) { at = skip('>', 1); continue; }
    const close = skip('>');
    const tag = source.slice(open + 1, close);
    at = close + 1;
    if (tag[0] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const node = { name: tag.split(/[\s/]/)[0], children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!tag.endsWith('/')) stack.push(node);
  }
  return root.children[0];
}

const child = (node, path) => path.split('/').reduce((n, name) => n?.children.find((c) => c.name === name), node);
const children = (node, name) => node?.children.filter((c) => c.name === name) ?? [];
const text = (node, path) => { const n = child(node, path); return n ? n.text.trim() : undefined; };
const number = (node, path) => { const v = Number(text(node, path)); return Number.isFinite(v) ? v : null; };

// ---- the flow ------------------------------------------------------------------------------------------------------
const CONNECTORS = ['connector', 'defaultConnector', 'faultConnector', 'nextValueConnector', 'noMoreValuesConnector'];
const NOT_ELEMENTS = new Set(['variables', 'formulas', 'constants', 'textTemplates', 'choices', 'dynamicChoiceSets', 'stages',
  'processMetadataValues', 'start', 'customProperties', 'processType', 'label', 'status', 'apiVersion', 'description',
  'interviewLabel', 'runInMode', 'environments', 'areMetricsLoggedToDataCloud', 'isTemplate', 'triggerOrder', 'sourceTemplate']);
export const LIMITS = { elements: 600, decisions: 120, rules: 40, conditions: 40, text: 400 };

/** acme__Status__c → Status; Urgent__c → Urgent (a prefix is a namespace only when a suffix follows too). */
export const words = (api) => String(api).replace(/^[a-z0-9]+__(?=.+__[a-z]$)/i, '').replace(/__[a-z]$/i, '').replace(/_/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2').trim();
/** acme__Invoices__c → Invoice. */
export const objectName = (api) => (api ? words(api).replace(/(?<=[^s])s$/, '') : 'record');

const valueOf = (node) => { const v = node?.children[0]; return v ? { type: v.name, value: v.text.trim() } : null; };

/**
 * A record-triggered flow's entry conditions, as one more decision the walk meets first: "Runs" or "Does not run".
 * Filters name a field of the record; a formula is kept as it is written.
 */
export const ENTRY = '$entry';
function entryOf(start) {
  const filters = children(start, 'filters');
  const formula = text(start, 'filterFormula');
  if (!filters.length && !formula) return null;
  const conditions = formula
    ? [{ left: 'the entry formula', op: 'Formula', right: { type: 'formula', value: formula } }]
    : filters.map((f) => ({ left: `$Record.${text(f, 'field')}`, op: text(f, 'operator') ?? '', right: valueOf(child(f, 'value')) }));
  const logic = formula ? 'and' : text(start, 'filterLogic') ?? 'and';
  return {
    name: ENTRY, kind: 'decisions', label: 'Start conditions',
    rules: [{ name: 'Runs', label: 'Runs', logic, target: null, conditions }],
    default: { label: 'Does not run', target: null },
    changedToMeet: text(start, 'doesRequireRecordChangedToMeetCriteria') === 'true',
  };
}

/** The flow, from the text of a .flow-meta.xml. Throws a sentence a person can act on. */
export function parseFlow(xml) {
  let root;
  try { root = parseXml(xml); } catch { throw new Error('That file is not readable XML.'); }
  if (root?.name !== 'Flow') throw new Error('That is not a Salesforce flow: a .flow-meta.xml file starts with <Flow>.');
  const start = child(root, 'start');
  const mode = children(root, 'processMetadataValues').find((m) => text(m, 'name') === 'CanvasMode');
  // A record-triggered flow can run straight away, and later on scheduled paths (or only on them: "run asynchronously").
  const paths = [
    ...(text(start, 'connector/targetReference') ? [{ target: text(start, 'connector/targetReference'), label: null }] : []),
    ...children(start, 'scheduledPaths').filter((p) => text(p, 'connector/targetReference')).map((p) => ({
      target: text(p, 'connector/targetReference'),
      label: text(p, 'label') ?? (text(p, 'pathType') === 'AsyncAfterCommit' ? 'Run asynchronously' : 'Scheduled path'),
    })),
  ];
  const flow = {
    label: text(root, 'label') ?? 'Untitled flow', type: text(root, 'processType') ?? 'Flow', status: text(root, 'status'),
    object: text(start, 'object') ?? null, trigger: text(start, 'triggerType') ?? null, recordTrigger: text(start, 'recordTriggerType') ?? null,
    start: paths[0]?.target ?? text(root, 'startElementReference') ?? null, startVia: paths[0]?.label ?? null, paths,
    startAt: { x: number(start, 'locationX'), y: number(start, 'locationY') },
    canvas: text(mode, 'value/stringValue') === 'AUTO_LAYOUT_CANVAS' ? 'auto' : 'free',
    entry: entryOf(start),
    elements: new Map(),
    formulas: new Map(children(root, 'formulas').map((f) => [text(f, 'name'), text(f, 'expression') ?? ''])),
  };
  for (const el of root.children) {
    const name = text(el, 'name');
    if (NOT_ELEMENTS.has(el.name) || !name) continue;
    const next = Object.fromEntries(CONNECTORS.map((c) => [c, text(el, `${c}/targetReference`)]).filter(([, t]) => t));
    const node = { name, kind: el.name, label: text(el, 'label') ?? name, next, object: text(el, 'object') ?? null, x: number(el, 'locationX'), y: number(el, 'locationY') };
    if (el.name === 'decisions') {
      node.rules = children(el, 'rules').map((r) => ({
        name: text(r, 'name'), label: text(r, 'label') ?? text(r, 'name'), logic: text(r, 'conditionLogic') ?? 'and',
        target: text(r, 'connector/targetReference') ?? null,
        conditions: children(r, 'conditions').map((c) => ({ left: text(c, 'leftValueReference') ?? '', op: text(c, 'operator') ?? '', right: valueOf(child(c, 'rightValue')) })),
      }));
      node.default = { label: text(el, 'defaultConnectorLabel') ?? 'Default outcome', target: next.defaultConnector ?? null };
    }
    flow.elements.set(name, node);
  }
  if (!flow.start || !flow.elements.has(flow.start)) throw new Error('This flow has no first step to start from.');
  if (flow.elements.size > LIMITS.elements) throw new Error(`This flow has ${flow.elements.size} elements; at most ${LIMITS.elements} can be drawn.`);
  return flow;
}

/** Every decision Jev is asked about: the entry conditions first, when the flow has them. */
export const decisionsOf = (flow) => [...(flow.entry ? [flow.entry] : []), ...[...flow.elements.values()].filter((e) => e.kind === 'decisions')];

/**
 * What the server is sent: the decisions with their outcomes and conditions, the names of the lookups they refer to,
 * and the labels of the other steps (for writing situations). Never a variable's value: a flow file has none.
 */
export function wire(flow) {
  const cut = (s) => (typeof s === 'string' ? s.slice(0, LIMITS.text) : s);
  const decisions = decisionsOf(flow).slice(0, LIMITS.decisions).map((d) => ({
    name: cut(d.name), label: cut(d.label), default: cut(d.default.label), ...(d.name === ENTRY ? { entry: true, changedToMeet: d.changedToMeet } : {}),
    rules: d.rules.slice(0, LIMITS.rules).map((r) => ({ label: cut(r.label), logic: cut(r.logic),
      conditions: r.conditions.slice(0, LIMITS.conditions).map((c) => ({ left: cut(c.left), op: cut(c.op), right: c.right && { type: cut(c.right.type), value: cut(c.right.value) } })) })),
  }));
  // Where each outcome leads, so situations can be written to reach a step. The entry's "Runs" leads to the first step.
  const leads = (target) => (target ? cut(flow.elements.get(target)?.label ?? target) : 'the end of the flow');
  decisionsOf(flow).slice(0, LIMITS.decisions).forEach((d, i) => {
    decisions[i].rules.forEach((r, j) => { r.leadsTo = d.name === ENTRY ? leads(flow.start) : leads(d.rules[j].target); });
    decisions[i].defaultLeadsTo = d.name === ENTRY ? 'the flow not running at all' : leads(d.default.target);
  });
  const lookups = Object.fromEntries([...flow.elements.values()].filter((e) => e.kind === 'recordLookups').map((e) => [cut(e.name), { label: cut(e.label), object: cut(e.object) }]));
  const used = new Set(decisions.flatMap((d) => d.rules.flatMap((r) => r.conditions.flatMap((c) => [c.left.split('.')[0], c.right?.type === 'elementReference' ? c.right.value.split('.')[0] : null]))));
  const formulas = Object.fromEntries([...flow.formulas].filter(([name]) => used.has(name)).slice(0, 40).map(([name, expression]) => [cut(name), cut(expression)]));
  // Every other step and where it goes next, so a situation can be traced to the end.
  const steps = [...flow.elements.values()].filter((e) => e.kind !== 'decisions').slice(0, 200).map((e) => ({
    label: cut(e.label),
    next: e.kind === 'loops' ? `for each item: ${leads(e.next.nextValueConnector)}; after the last: ${leads(e.next.noMoreValuesConnector)}` : leads(e.next.connector),
  }));
  return { label: cut(flow.label), type: cut(flow.type), object: cut(flow.object), trigger: cut(flow.trigger), recordTrigger: cut(flow.recordTrigger),
    first: leads(flow.start), decisions, lookups, formulas, steps };
}

// ---- the walk ------------------------------------------------------------------------------------------------------
/**
 * The path, from Jev's answers: `answers[decisionName]` is { choice, probabilities }. A decision Jev is less than `sure`
 * about stops the walk at a fork, unless the person has chosen for it in `chosen[decisionName]`. A loop is gone round
 * once and left. Each step says how it was reached, so the page can draw the edge it travels.
 */
export function follow(flow, answers, { sure = 0.6, chosen = {} } = {}) {
  const judged = (name) => {
    const answer = answers?.[name];
    const ranked = answer ? Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1]) : [];
    const pick = chosen[name] ?? (answer && answer.probabilities?.[answer.choice] >= sure ? answer.choice : null);
    return { ranked, pick, by: chosen[name] ? 'you' : 'jev', p: pick ? answer?.probabilities?.[pick] ?? null : null };
  };
  const first = { name: '$start', kind: 'start', label: 'Start' };
  const steps = [first];
  if (flow.entry) {
    const { ranked, pick, by, p } = judged(ENTRY);
    Object.assign(first, { ranked, by, decision: true });
    if (!pick) { first.fork = true; return steps; }
    Object.assign(first, { outcome: pick, p });
    if (pick !== 'Runs') { steps.push({ name: '$end:$start', kind: 'end', label: 'Does not start', from: '$start', via: pick }); return steps; }
  }
  const seen = new Set();
  let at = flow.start, via = flow.startVia, from = '$start';
  while (at) {
    if (seen.has(at)) { steps.push({ name: at, kind: 'again', label: flow.elements.get(at)?.label ?? at, from, via }); break; }
    seen.add(at);
    const node = flow.elements.get(at);
    if (!node) { steps.push({ name: at, kind: 'missing', label: at, from, via }); break; }
    const step = { name: node.name, kind: node.kind, label: node.label, from, via };
    steps.push(step);
    from = node.name;
    if (node.kind === 'loops') {
      const into = node.next.nextValueConnector;
      [at, via] = into && !seen.has(into) ? [into, 'For each item'] : [node.next.noMoreValuesConnector, 'After the last item'];
      continue;
    }
    if (node.kind !== 'decisions') { [at, via] = [node.next.connector, null]; continue; }

    const { ranked, pick, by, p } = judged(node.name);
    Object.assign(step, { ranked, by });
    if (!pick) { step.fork = true; break; }
    const rule = node.rules.find((r) => r.label === pick);
    Object.assign(step, { outcome: pick, p });
    [at, via] = [rule ? rule.target : node.default.target, pick];
  }
  const last = steps.at(-1);
  if (!last.fork && last.kind !== 'missing' && last.kind !== 'again') steps.push({ name: `$end:${last.name}`, kind: 'end', label: 'End', from: last.name, via: last.kind === 'decisions' ? last.outcome : null });
  return steps;
}

// ---- where things go on the canvas ---------------------------------------------------------------------------------
const edgesOf = (node) => {
  if (node.kind === 'decisions') return [...node.rules.map((r) => ({ to: r.target, label: r.label })), { to: node.default.target, label: node.default.label, default: true }];
  if (node.kind === 'loops') return [{ to: node.next.nextValueConnector, label: 'For each item' }, { to: node.next.noMoreValuesConnector, label: 'After the last item' }];
  return [{ to: node.next.connector, label: null }, ...(node.next.faultConnector ? [{ to: node.next.faultConnector, label: 'Fault', fault: true }] : [])];
};

/**
 * Every node's centre and every edge. Flow Builder saves where it drew each element, for auto-layout flows too, so the
 * page draws the flow as an admin already knows it. A flow saved without positions is laid out in rows by depth.
 * A missing target (an outcome that ends the flow) gets a small End node of its own.
 */
export function layout(flow) {
  const nodes = new Map();
  const placed = [...flow.elements.values()].some((e) => e.x || e.y);
  const free = flow.canvas === 'free';
  if (placed) {
    const at = (x, y) => ({ x: (x ?? 0) + (free ? 24 : 0), y: (y ?? 0) + (free ? 24 : 0) });
    for (const e of flow.elements.values()) nodes.set(e.name, { ...at(e.x, e.y), kind: e.kind, label: e.label });
    // Flow Builder's start card is tall, so in auto-layout it is saved far above the first step: draw it just above.
    const first = nodes.get(flow.start);
    nodes.set('$start', free && flow.startAt.x !== null ? { ...at(flow.startAt.x, flow.startAt.y), kind: 'start', label: 'Start' } : { x: first.x, y: first.y - 118, kind: 'start', label: 'Start' });
  } else {
    // Depth by longest path from the start, so a merge sits below every branch that leads to it. The edge back into a
    // loop is not followed, or the loop would push itself down for ever.
    const depth = new Map([[flow.start, 1]]);
    for (let round = 0; round < flow.elements.size; round++) {
      let changed = false;
      for (const [name, d] of [...depth]) {
        for (const e of edgesOf(flow.elements.get(name))) {
          const target = flow.elements.get(e.to);
          if (!target || (target.kind === 'loops' && depth.has(e.to))) continue;
          if ((depth.get(e.to) ?? 0) < d + 1) { depth.set(e.to, d + 1); changed = true; }
        }
      }
      if (!changed) break;
    }
    const rows = new Map();
    for (const [name, d] of depth) { if (!rows.has(d)) rows.set(d, []); rows.get(d).push(name); }
    // Row by row, each node sits under the average of its parents, in the order of its parents' outcomes.
    const parents = new Map();
    for (const e of flow.elements.values()) edgesOf(e).forEach((out, i) => { if (out.to) { if (!parents.has(out.to)) parents.set(out.to, []); parents.get(out.to).push({ from: e.name, i }); } });
    nodes.set('$start', { x: 0, y: 0, kind: 'start', label: 'Start' });
    for (const d of [...rows.keys()].sort((a, b) => a - b)) {
      const order = (name) => {
        const placed = (parents.get(name) ?? []).filter((p) => nodes.has(p.from));
        return placed.length ? placed.reduce((sum, p) => sum + nodes.get(p.from).x + p.i, 0) / placed.length : 0;
      };
      const names = rows.get(d).sort((a, b) => order(a) - order(b));
      names.forEach((name, i) => { const e = flow.elements.get(name); nodes.set(name, { x: (i - (names.length - 1) / 2) * 300, y: d * 130, kind: e.kind, label: e.label }); });
    }
    let spare = 0;
    for (const e of flow.elements.values()) if (!nodes.has(e.name)) nodes.set(e.name, { x: -600, y: 130 * ++spare, kind: e.kind, label: e.label, stray: true });
  }

  const drop = free ? 110 : 96;
  const edges = (flow.paths.length ? flow.paths : [{ target: flow.start, label: null }])
    .filter((p) => nodes.has(p.target)).map((p) => ({ from: '$start', to: p.target, label: p.label }));
  if (flow.entry) {
    const s = nodes.get('$start');
    nodes.set('$end:$start', { ...freeSpot(nodes, s.x + 340, s.y, 'right'), kind: 'end', label: 'Does not start' });
    edges.push({ from: '$start', to: '$end:$start', label: 'Does not run', side: true });
  }
  for (const e of flow.elements.values()) {
    const from = nodes.get(e.name);
    const outs = edgesOf(e);
    const branches = e.kind === 'decisions' || e.kind === 'loops';
    outs.forEach((out, branch) => {
      if (out.to && nodes.has(out.to)) { edges.push({ from: e.name, to: out.to, label: out.label, fault: out.fault, default: out.default }); return; }
      // An outcome with nowhere to go ends the flow there; so does a step with no next step. A fault path that is not
      // wired is not drawn.
      if (out.fault) return;
      const end = `$end:${e.name}${branches ? `:${branch}` : ''}`;
      const spread = branches ? (branch - (outs.length - 1) / 2) * 150 : 0;
      nodes.set(end, { ...freeSpot(nodes, from.x + spread, from.y + drop), kind: 'end', label: 'End' });
      edges.push({ from: e.name, to: end, label: out.label, default: out.default });
    });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes.values()) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  return { nodes, edges, box: { x: minX - 140, y: minY - 70, width: maxX - minX + 420, height: maxY - minY + 170 } };
}

/** The nearest place near (x, y) that no node already takes: down a row at a time, or rightwards. */
function freeSpot(nodes, x, y, towards = 'down') {
  const taken = (px, py) => [...nodes.values()].some((n) => Math.abs(n.x - px) < 200 && Math.abs(n.y - py) < 56);
  for (let k = 0; k < 40; k++) {
    const spot = towards === 'down' ? { x, y: y + k * 108 } : { x: x + k * 220, y };
    if (!taken(spot.x, spot.y)) return spot;
  }
  return { x, y };
}

/** The End node a walk finishes on, in layout()'s naming, so the page lights the right one. */
export function endNodeOf(flow, step) {
  if (step.from === '$start') return '$end:$start';
  const e = flow.elements.get(step.from);
  if (!e) return null;
  if (e.kind === 'decisions') return `$end:${e.name}:${edgesOf(e).findIndex((o) => o.label === step.via)}`;
  if (e.kind === 'loops') return `$end:${e.name}:1`;
  return `$end:${e.name}`;
}
