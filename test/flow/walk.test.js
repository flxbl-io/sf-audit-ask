import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { parseFlow, wire, follow, layout, decisionsOf, endNodeOf, ENTRY } from '../../public/flow/graph.js';
import { cleanFlow, decisionQuestions, describe, isInvalid, navigate, sentence, words } from '../../src/flow/questions.js';
import { outline } from '../../src/flow/situations.js';
import { createApp } from '../../server.js';

const SAMPLE = readFileSync(new URL('../../public/flow/samples/case-triage.flow-meta.xml', import.meta.url), 'utf8');
const flow = parseFlow(SAMPLE);
const sent = cleanFlow(JSON.parse(JSON.stringify(wire(flow))));

/** Answers as Jev gives them: the named outcome at `p`, the rest shared out. */
const answer = (choice, p = 0.95) => ({ choice, probabilities: { [choice]: p, Other: 1 - p } });
const labels = (steps) => steps.map((s) => (s.ranked?.length ? `${s.kind === 'start' ? 'Start' : s.label} → ${s.fork ? '?' : s.outcome}` : s.label));

test('a flow file is read: its start, its entry conditions and its decisions', () => {
  assert.equal(flow.label, 'Case Triage');
  assert.equal(flow.object, 'Case');
  assert.equal(flow.trigger, 'RecordAfterSave');
  assert.equal(flow.start, 'Customer_Tier');
  assert.deepEqual(flow.entry.rules[0].conditions, [{ left: '$Record.Status', op: 'NotEqualTo', right: { type: 'stringValue', value: 'Closed' } }]);
  assert.deepEqual(decisionsOf(flow).map((d) => d.name), [ENTRY, 'Customer_Tier', 'Incident_Kind', 'Contact_Channel', 'Account_Size', 'Warranty_Check', 'Customer_Mood']);
  assert.equal(flow.elements.get('Incident_Kind').rules[1].logic, '1 AND (2 OR 3)');
});

test('anything that is not a flow is refused with a sentence', () => {
  assert.throws(() => parseFlow('<Profile><name>x</name></Profile>'), /not a Salesforce flow/);
  assert.throws(() => parseFlow('<Flow><label>x</label>'), /no first step/);
  assert.throws(() => parseFlow('<Flow <label'), /readable XML|not a Salesforce flow/);
});

test('a flow that only runs on a scheduled path starts there', () => {
  const xml = `<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>Later</label><processType>AutoLaunchedFlow</processType>
    <start><object>Opportunity</object><triggerType>RecordAfterSave</triggerType><scheduledPaths><connector><targetReference>Do_It</targetReference></connector><pathType>AsyncAfterCommit</pathType></scheduledPaths></start>
    <recordUpdates><name>Do_It</name><label>Do it</label></recordUpdates></Flow>`;
  const later = parseFlow(xml);
  assert.equal(later.start, 'Do_It');
  assert.equal(later.startVia, 'Run asynchronously');
  assert.deepEqual(labels(follow(later, {})), ['Start', 'Do it', 'End']);
});

test('the walk follows Jev: custom logic, then the outcome it names, to the end', () => {
  const steps = follow(flow, {
    [ENTRY]: answer('Runs'), Customer_Tier: answer('Strategic'), Incident_Kind: answer('Major outage'), Contact_Channel: answer('By phone'),
  });
  assert.deepEqual(labels(steps), ['Start → Runs', 'Customer Tier → Strategic', 'Incident Kind → Major outage', 'Page the on-call engineer', 'Contact Channel → By phone', 'Schedule a call back', 'End']);
  assert.equal(steps.at(-1).kind, 'end');
});

test('below 0.6 the walk stops at a fork, and a choice made there carries it on', () => {
  const answers = { [ENTRY]: answer('Runs'), Customer_Tier: answer('Standard', 0.52), Account_Size: answer('Regular'), Warranty_Check: answer('Covered') };
  const stopped = follow(flow, answers);
  assert.equal(stopped.at(-1).fork, true);
  assert.equal(stopped.at(-1).name, 'Customer_Tier');
  const chosen = follow(flow, answers, { chosen: { Customer_Tier: 'Standard' } });
  assert.deepEqual(labels(chosen).slice(1), ['Customer Tier → Standard', 'Account Size → Regular', 'Warranty Check → Covered', 'Create a return (RMA)', 'End']);
  assert.equal(chosen[1].by, 'you');
});

test('a flow whose start conditions do not hold goes nowhere', () => {
  const steps = follow(flow, { [ENTRY]: answer('Does not run') });
  assert.deepEqual(labels(steps), ['Start → Does not run', 'Does not start']);
  assert.equal(endNodeOf(flow, steps.at(-1)), '$end:$start');
});

test('the layout places every node, draws every edge between placed nodes, and ends where the walk ends', () => {
  const { nodes, edges } = layout(flow);
  for (const n of nodes.values()) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  for (const e of edges) assert.ok(nodes.has(e.from) && nodes.has(e.to), `${e.from} → ${e.to}`);
  const steps = follow(flow, { [ENTRY]: answer('Runs'), Customer_Tier: answer('Basic'), Customer_Mood: answer('Calm') });
  assert.ok(nodes.has(endNodeOf(flow, steps.at(-1))));
  // Nothing sits on top of anything else.
  const placed = [...nodes.values()];
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(Math.abs(placed[i].x - placed[j].x) >= 150 || Math.abs(placed[i].y - placed[j].y) >= 50, `${placed[i].label} / ${placed[j].label}`);
});

test('names read as a person would say them', () => {
  assert.equal(words('acme__Status__c'), 'Status');
  assert.equal(words('Urgent__c'), 'Urgent');
  assert.equal(words('Account_Owner__r'), 'Account Owner');
  assert.equal(describe('$Record.Account.Tier__c', sent), "the Case's Account › Tier");
  const withLookup = { ...sent, lookups: { Get_Tasks: { label: 'Get Existing Tasks', object: 'Task' } } };
  assert.equal(sentence({ left: 'Get_Tasks', op: 'IsNull', right: { type: 'booleanValue', value: 'true' } }, withLookup), 'the Task records found by the step "Get Existing Tasks" found nothing');
  assert.equal(sentence({ left: '$Record.Priority', op: 'IsChanged', right: { type: 'booleanValue', value: 'true' } }, sent), "the Case's Priority was changed by this save");
});

test('each decision is one Choice over its own outcomes, in order, with the default last; an OR outcome once per condition', () => {
  const { questions, keys } = decisionQuestions(sent);
  assert.equal(Object.keys(questions).length, 7);
  assert.deepEqual(Object.keys(questions.Customer_Tier.criteria), ['Strategic', 'Strategic (2)', 'Standard', 'Basic']);
  assert.match(questions.Customer_Tier.criteria.Strategic, /Tier is 'Platinum' \(one of the ways "Strategic" holds\)/);
  assert.match(questions.Customer_Tier.criteria['Strategic (2)'], /Strategic Account is true/);
  assert.equal(keys.Customer_Tier['Strategic (2)'], 'Strategic');
  assert.equal(questions.Incident_Kind.criteria['Major outage'].logic, '1 AND (2 OR 3)');
  assert.match(questions[ENTRY].instructions.question, /starts only when its entry conditions hold/);
  assert.deepEqual(Object.keys(questions[ENTRY].criteria), ['Runs', 'Does not run']);
});

test('the server checks what it is sent', () => {
  assert.throws(() => cleanFlow({ decisions: [] }), (e) => isInvalid(e) && /no decisions/.test(e.message));
  assert.throws(() => cleanFlow({ decisions: [{ name: 'A', rules: [{ label: 'x', conditions: [] }] }, { name: 'A', rules: [{ label: 'y', conditions: [] }] }] }), /its own name/);
  const long = cleanFlow({ label: 'x'.repeat(5000), decisions: [{ name: 'A', label: 'A', rules: [{ label: 'y', conditions: [{ left: 'z'.repeat(5000), op: 'EqualTo' }] }] }] });
  assert.equal(long.label.length, 400);
  assert.equal(long.decisions[0].rules[0].conditions[0].left.length, 400);
});

test('navigate asks every decision at once, splits a request that is too large, and maps answers back', async () => {
  const twin = { ...sent, decisions: [{ name: 'D', label: 'D', default: 'Same', rules: [{ label: 'Same', logic: 'and', conditions: [] }] }] };
  const calls = [];
  const decide = async (state, questions) => {
    calls.push(Object.keys(questions));
    if (Object.keys(questions).length > 4) throw Object.assign(new Error('too big'), { code: 'too_large' });
    return { tokens: 10, answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { choice: Object.keys(q.criteria).at(-1), probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, 0.5])) }])) };
  };
  const walked = await navigate(sent, 'A Platinum customer reports an outage.', { decide });
  assert.equal(calls[0].length, 7);
  assert.equal(walked.requests, 2);
  assert.equal(Object.keys(walked.answers).length, 7);
  // Two outcomes with one label: the option keys differ, the answer comes back as the flow's own label.
  const split = await navigate(sent, 'A strategic customer reports an outage.', { decide: async (state, questions) => ({ tokens: 1, answers: { Customer_Tier: { choice: 'Strategic (2)', probabilities: { Strategic: 0.3, 'Strategic (2)': 0.6, Standard: 0.05, Basic: 0.05 } } } }) });
  assert.equal(split.answers.Customer_Tier.choice, 'Strategic');
  assert.equal(split.answers.Customer_Tier.probabilities.Strategic, 0.8999999999999999);
  const same = await navigate(twin, 'Anything at all.', { decide });
  assert.equal(same.answers.D.choice, 'Same');
  assert.equal(same.answers.D.probabilities.Same, 1);
});

test('a decision too large for Jev to read is left for the person, and the rest of the walk is still Jev\'s', async () => {
  const decide = async (state, questions) => {
    if ('Customer_Tier' in questions) throw Object.assign(new Error('too big'), { code: 'too_large' });
    return { tokens: 10, answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 0.9 } }])) };
  };
  const walked = await navigate(sent, 'A Platinum customer reports an outage.', { decide });
  assert.deepEqual(walked.tooLarge, ['Customer_Tier']);
  assert.equal(walked.answers.Customer_Tier, undefined);
  assert.equal(Object.keys(walked.answers).length, 6);
  const steps = follow(flow, walked.answers);
  assert.equal(steps.at(-1).name, 'Customer_Tier');
  assert.equal(steps.at(-1).fork, true);
  assert.deepEqual(steps.at(-1).ranked, []);
});

test('the situation writer reads the whole flow: start conditions, decisions and where every step goes', () => {
  const text = outline(sent);
  assert.match(text, /runs on one save of a Salesforce Case record \(it was created or updated\)/);
  assert.match(text, /Decision "Start conditions":/);
  assert.match(text, /"Major outage" when \(custom logic 1 AND \(2 OR 3\)/);
  assert.match(text, /"Page the on-call engineer" → Contact Channel/);
});

// ---- the routes ---------------------------------------------------------------------------------------------------
let app, base, failing = false, written = 0;
const decide = async (state, questions) => {
  if (failing) throw Object.assign(new Error('Jev refused the request (500 error)'), { code: 'jev' });
  return { tokens: 1234, answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 0.9 } }])) };
};
const writeSituations = async () => { written++; return { model: 'claude-opus-5', tokens: { input: 3000, output: 1500 }, situations: [{ title: 'Outage', text: 'A Platinum customer is down.', path: ['Start conditions → Runs'], vague: false }] }; };
before(async () => {
  app = createApp({ judge: async () => ({ p: 0, tokens: 0 }), locate: async () => ({ index: null, tokens: 0 }), decide, writeSituations, maxWalks: 3, trustedProxies: 1 });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());
const post = async (path, body, ip) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
};

test('a walk returns an answer for every decision, and counts against its own allowance', async () => {
  const walked = await post('/api/flow-walk', { flow: wire(flow), situation: 'A Platinum customer reports their whole site is down.' }, '198.51.100.20');
  assert.equal(walked.status, 200);
  assert.equal(Object.keys(walked.json.answers).length, 7);
  assert.equal(walked.json.walksLeft, 2);
  assert.equal(walked.json.tokens, 1234);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.flow, { maxWalks: 3, writer: true, walker: true });
});

test('a walk is refused for a situation too short to read, and not counted', async () => {
  const refused = await post('/api/flow-walk', { flow: wire(flow), situation: 'down' }, '198.51.100.21');
  assert.equal(refused.status, 400);
  const limits = await (await fetch(`${base}/api/limits`, { headers: { 'x-forwarded-for': '198.51.100.21' } })).json();
  assert.equal(limits.walksLeft, 3);
});

test('a walk Jev could not answer is given back', async () => {
  failing = true;
  const failed = await post('/api/flow-walk', { flow: wire(flow), situation: 'A Platinum customer reports their whole site is down.' }, '198.51.100.22');
  failing = false;
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /not counted/);
  assert.equal(failed.json.walksLeft, 3);
});

test('situations are written by Claude and counted; the allowance runs out', async () => {
  const ip = '198.51.100.23';
  const first = await post('/api/flow-situations', { flow: wire(flow) }, ip);
  assert.equal(first.status, 200);
  assert.equal(first.json.situations[0].title, 'Outage');
  assert.equal(first.json.cost, 0.0525);
  await post('/api/flow-situations', { flow: wire(flow) }, ip);
  await post('/api/flow-situations', { flow: wire(flow) }, ip);
  const out = await post('/api/flow-situations', { flow: wire(flow) }, ip);
  assert.equal(out.status, 429);
  assert.equal(written, 3);
});
