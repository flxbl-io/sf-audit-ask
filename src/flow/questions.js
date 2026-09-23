/**
 * Jev as a flow engine. The page sends a flow's decisions (never the rest of the file) and a situation in plain words;
 * each decision becomes one Choice, "the flow is here: which outcome does it take?", its options the decision's own
 * outcomes described by their conditions, in the order the flow tries them. Every decision is asked in one request, so
 * the whole flow is judged at once and the page follows connectors through the answers it reaches.
 *
 * Measured on a real 9-decision flow with 14 situations whose true paths were walked by code from record values:
 * 11-12 of 14 exact once an OR outcome is offered once per condition (10-11 before). The misses: Jev near 50/50 (the
 * page shows a fork below 0.6), and two outcomes holding at once, where Salesforce takes the first and Jev took the
 * more salient one. Start conditions are read as holding unless the situation rules them out: a situation that never
 * mentioned a case's status had been read as "does not start" (0.58-0.62); now 0.85-0.87, with a closed case still
 * 0.94 "does not start". Tried and dropped, as no better or worse:
 * quoting field names ('the Application's "Urgent" field'), and telling Jev in the question to prefer the first outcome
 * and to spread its answer when the situation is silent; and a "cannot tell" option on every decision (6-7 of 10: Jev
 * then shied away from clear first decisions too). The same request can come back a few points apart
 * (0.60, 0.69, 0.66), so the page asks each situation once and keeps the answer.
 */

import { words, objectName } from '../../public/flow/graph.js';

export { words, objectName };
export const LIMITS = { decisions: 120, rules: 40, conditions: 40, text: 400, lookups: 400, formulas: 40, steps: 200, situation: 1200 };
export const ENTRY = '$entry';

class Invalid extends Error {}
const str = (v, limit = LIMITS.text) => (typeof v === 'string' ? v.slice(0, limit) : null);
const need = (ok, message) => { if (!ok) throw new Invalid(message); };

/** The flow as the page sends it, checked and cut to size. Throws Invalid with a sentence for the person. */
export function cleanFlow(input) {
  need(input && typeof input === 'object', 'Send the flow as {"flow": {...}}.');
  need(Array.isArray(input.decisions) && input.decisions.length > 0, 'This flow has no decisions, so there is nothing for Jev to decide.');
  need(input.decisions.length <= LIMITS.decisions, `At most ${LIMITS.decisions} decisions.`);
  const names = new Set();
  const decisions = input.decisions.map((d) => {
    need(d && typeof d.name === 'string' && d.name && !names.has(d.name), 'Every decision needs its own name.');
    names.add(d.name);
    need(Array.isArray(d.rules) && d.rules.length > 0 && d.rules.length <= LIMITS.rules, `A decision has 1 to ${LIMITS.rules} outcomes.`);
    return {
      name: str(d.name), label: str(d.label) || str(d.name), default: str(d.default) || 'Default outcome', defaultLeadsTo: str(d.defaultLeadsTo),
      entry: d.name === ENTRY, changedToMeet: d.changedToMeet === true,
      rules: d.rules.map((r) => {
        need(r && typeof r.label === 'string' && Array.isArray(r.conditions) && r.conditions.length <= LIMITS.conditions, `An outcome has a label and up to ${LIMITS.conditions} conditions.`);
        return {
          label: str(r.label), logic: str(r.logic) || 'and', leadsTo: str(r.leadsTo),
          conditions: r.conditions.map((c) => ({ left: str(c?.left) ?? '', op: str(c?.op) ?? '', right: c?.right && typeof c.right === 'object' ? { type: str(c.right.type) ?? '', value: str(c.right.value) ?? '' } : null })),
        };
      }),
    };
  });
  const map = (value, limit, clean) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).slice(0, limit).map(([k, v]) => [str(k), clean(v)]));
  return {
    label: str(input.label) || 'Untitled flow', type: str(input.type), object: str(input.object), trigger: str(input.trigger), recordTrigger: str(input.recordTrigger),
    decisions,
    lookups: map(input.lookups, LIMITS.lookups, (v) => ({ label: str(v?.label), object: str(v?.object) })),
    formulas: map(input.formulas, LIMITS.formulas, (v) => str(v)),
    first: str(input.first),
    steps: Array.isArray(input.steps) ? input.steps.slice(0, LIMITS.steps).filter((s) => s && typeof s.label === 'string').map((s) => ({ label: str(s.label), next: str(s.next) })) : [],
  };
}
export const isInvalid = (error) => error instanceof Invalid;

// ---- naming things the way a person would (the names themselves come from the page's module) -----------------------
/** 'a Case', 'an Application'. */
export const a = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

export function describe(ref, flow) {
  if (!ref) return 'an empty value';
  const prior = ref.startsWith('$Record__Prior');
  if (ref.startsWith('$Record')) {
    const parts = ref.split('.').slice(1);
    if (parts.length > 1 && /^Id$/i.test(parts.at(-1))) parts.pop();
    return `the ${objectName(flow.object)}'s ${parts.map(words).join(' › ') || 'record'}${prior ? ' before this save' : ''}`;
  }
  if (ref.startsWith('$')) return `the ${words(ref.slice(1).split('.').join(' '))} setting`;
  const [head, ...rest] = ref.split('.');
  const lookup = flow.lookups[head];
  if (lookup) {
    const found = `the ${objectName(lookup.object)} record${rest.length ? '' : 's'} found by the step "${lookup.label}"`;
    return rest.length ? `${rest.map(words).join(' › ')} of ${found}` : found;
  }
  if (flow.formulas[head]) return `the formula "${words(head)}" (${flow.formulas[head]})`;
  return `the value "${words(ref)}"`;
}

const OPS = {
  EqualTo: 'is', NotEqualTo: 'is not', Contains: 'contains', StartsWith: 'starts with', EndsWith: 'ends with',
  GreaterThan: 'is greater than', LessThan: 'is less than', GreaterThanOrEqualTo: 'is at least', LessThanOrEqualTo: 'is at most',
  In: 'is one of', NotIn: 'is not one of',
};

/** One condition as a sentence: "the Application's Status is 'Formally Approved'". */
export function sentence(c, flow) {
  if (c.op === 'Formula') return `this formula is true: ${c.right?.value ?? ''}`;
  const subject = describe(c.left, flow);
  const on = c.right?.value !== 'false';
  const lookup = Boolean(flow.lookups[c.left]);
  if (c.op === 'IsChanged') return `${subject} ${on ? 'was' : 'was not'} changed by this save`;
  if (c.op === 'IsNull' || c.op === 'IsBlank' || c.op === 'IsEmpty') return lookup ? `${subject} ${on ? 'found nothing' : 'found at least one record'}` : `${subject} ${on ? 'is empty' : 'has a value'}`;
  if (c.op === 'WasSet') return `${subject} ${on ? 'was' : 'was not'} set`;
  if (c.op === 'WasSelected') return `${subject} ${on ? 'was' : 'was not'} selected`;
  if (c.op === 'WasVisited') return `${subject} ${on ? 'was' : 'was not'} visited`;
  const right = !c.right ? 'nothing'
    : c.right.type === 'elementReference' ? describe(c.right.value, flow)
      : c.right.type === 'stringValue' ? `'${c.right.value}'`
        : c.right.type === 'booleanValue' ? (c.right.value === 'true' ? 'true (ticked)' : 'false (not ticked)')
          : c.right.value;
  return `${subject} ${OPS[c.op] ?? c.op} ${right}`;
}

/** An outcome's conditions, with its logic: a string for and/or, a structure for "1 AND (2 OR 3)". */
function when(rule, flow) {
  const parts = rule.conditions.map((c) => sentence(c, flow));
  if (!parts.length) return 'Always.';
  if (parts.length === 1) return parts[0];
  if (/^(and|or)$/i.test(rule.logic)) return parts.join(rule.logic.toLowerCase() === 'and' ? ', and ' : ', or ');
  return { logic: rule.logic, conditions: Object.fromEntries(parts.map((p, i) => [String(i + 1), p])) };
}

/** What the situation describes, by the kind of flow. */
export function setting(flow) {
  const record = objectName(flow.object);
  if (flow.trigger === 'RecordBeforeDelete') return `a Salesforce ${record} record being deleted`;
  if (flow.trigger === 'RecordAfterSave' || flow.trigger === 'RecordBeforeSave') {
    const how = { Create: 'created', Update: 'updated', CreateAndUpdate: 'created or updated' }[flow.recordTrigger] ?? 'saved';
    return `one save of a Salesforce ${record} record (it was ${how})`;
  }
  if (flow.trigger === 'Scheduled') return `a scheduled run of the flow${flow.object ? ` over ${record} records` : ''}`;
  if (flow.trigger === 'PlatformEvent') return `${a(record)} event arriving`;
  if (flow.type === 'Flow') return 'a person going through this screen flow, and what they enter or choose';
  return 'the situation in which this flow runs';
}

/** One Choice per decision, keyed by the decision's name. `keys` maps each option back to the outcome it stands for. */
export function decisionQuestions(flow) {
  const questions = {};
  const keys = {};
  const intro = `\`situation\` describes ${setting(flow)}, which runs the flow \`flow\`.`;
  for (const d of flow.decisions) {
    const criteria = {};
    const back = {};
    const add = (label, description) => {
      let key = label || 'Unnamed outcome';
      for (let n = 2; key in criteria; n++) key = `${label} (${n})`;
      criteria[key] = description;
      back[key] = label;
    };
    // An outcome that holds when any one of its conditions does is offered once per condition: each option is then one
    // plain fact, and the options' probabilities add up to the outcome's. Order is kept.
    const offer = (r) => {
      if (/^or$/i.test(r.logic) && r.conditions.length > 1 && r.conditions.length <= 40) for (const c of r.conditions) add(r.label, `${sentence(c, flow)} (one of the ways "${r.label}" holds)`);
      else add(r.label, when(r, flow));
    };
    if (d.entry) {
      offer(d.rules[0]);
      add(d.default, 'The situation rules the entry conditions out: it says, or plainly means, that they do not hold for this save.');
      // A situation is told because it is one the flow is for: silence about an entry condition is not against it.
      questions[d.name] = { type: 'choice', criteria, instructions: {
        question: `${intro} The flow starts only when its entry conditions hold${d.changedToMeet ? ', and only when this save is what made them hold' : ''}. ` +
          'Does it start? It does unless something in `situation` rules the entry conditions out.',
      } };
    } else {
      for (const r of d.rules) offer(r);
      add(d.default, 'None of the other outcomes hold.');
      questions[d.name] = { type: 'choice', criteria, instructions: {
        decision: d.label,
        question: `${intro} When the flow reaches the decision \`decision\`, which outcome does it take, going only by \`situation\`? ` +
          'The outcomes are tried in the order listed and the first one that holds is taken.',
      } };
    }
    keys[d.name] = back;
  }
  return { questions, keys };
}

/**
 * Every decision judged for one situation: { answers: { name: { choice, probabilities } }, tokens, requests }.
 * `decide(state, questions, signal)` is Jev's. A request too large for Jev is split in two and asked again.
 */
export async function navigate(flow, situation, { decide, signal }) {
  const { questions, keys } = decisionQuestions(flow);
  const state = { flow: flow.label, situation };
  const stats = { tokens: 0, requests: 0, tooLarge: [] };
  const ask = async (names) => {
    try {
      const { answers, tokens } = await decide(state, Object.fromEntries(names.map((n) => [n, questions[n]])), signal);
      stats.tokens += tokens;
      stats.requests++;
      return answers;
    } catch (error) {
      if (error.code !== 'too_large') throw error;
      // One decision too large for Jev to read at all (32k tokens with the situation) gets no answer: the page asks the
      // person there instead of failing the walk. Seen on 934 real flows: the largest decision is about 1,300 tokens.
      if (names.length === 1) { stats.tooLarge.push(names[0]); return {}; }
      const half = Math.ceil(names.length / 2);
      return { ...(await ask(names.slice(0, half))), ...(await ask(names.slice(half))) };
    }
  };
  const raw = await ask(Object.keys(questions));

  // Back to the flow's own outcome labels. An answer that is not one of the options is dropped, never guessed at.
  const answers = {};
  for (const [name, back] of Object.entries(keys)) {
    const a = raw?.[name];
    if (!a || !(a.choice in back)) continue;
    const probabilities = {};
    for (const [key, p] of Object.entries(a.probabilities ?? {})) if (key in back && Number.isFinite(p)) probabilities[back[key]] = (probabilities[back[key]] ?? 0) + p;
    answers[name] = { choice: back[a.choice], probabilities };
  }
  return { answers, ...stats };
}
