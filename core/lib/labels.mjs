import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(fs.readFileSync(path.join(here, '..', 'labels.json'), 'utf8'));

export const ACTORS = ['human', 'orchestrator', 'implementer', 'reviewer', 'merge', 'governor', 'lease'];

// Allowed state transitions (ARCHITECTURE 5.1): from -> [{to, actors}]. `any` = wildcard source.
const T = (to, ...actors) => ({ to, actors });
export const TRANSITIONS = {
  backlog: [T('ready', 'orchestrator', 'human'), T('blocked', 'implementer', 'orchestrator', 'human')],
  ready: [T('claimed', 'implementer', 'orchestrator'), T('blocked', 'implementer', 'orchestrator', 'human'), T('backlog', 'orchestrator', 'human')],
  claimed: [T('in-progress', 'implementer', 'orchestrator'), T('ready', 'lease', 'orchestrator', 'implementer', 'human'), T('blocked', 'implementer', 'orchestrator', 'human')],
  'in-progress': [T('review', 'implementer', 'orchestrator'), T('ready', 'lease', 'orchestrator', 'implementer', 'human'), T('blocked', 'implementer', 'orchestrator', 'human')],
  review: [T('changes-requested', 'reviewer', 'orchestrator'), T('done', 'merge'), T('blocked', 'implementer', 'orchestrator', 'human')],
  'changes-requested': [T('in-progress', 'implementer', 'orchestrator'), T('blocked', 'implementer', 'orchestrator', 'human')],
  blocked: [T('ready', 'orchestrator', 'human')],
  done: [],
};

const GROUP_RULES = [
  // [label matcher, actors allowed to set it]  (ARCHITECTURE 5.2; state handled by TRANSITIONS)
  [/^agent:(claude|codex|any|gemini)$/, ['human', 'orchestrator', 'governor']],
  [/^agent:([1-7]|main)$/, ['human', 'orchestrator']],
  [/^handoff:/, ['human', 'orchestrator', 'implementer', 'governor']],
  [/^review:(claude|codex|human|main)$/, ['human', 'orchestrator', 'implementer']],
  [/^review:(approved|changes)$/, ['human', 'reviewer']],
  [/^route:|^risk:high$/, ['human', 'orchestrator', 'reviewer']],
  [/^(priority|area|type):/, ['human', 'orchestrator']],
  [/^owner-decision$/, ['human', 'orchestrator', 'implementer']],
];

export function canon(name, aliases = {}) {
  const all = { ...CATALOG.aliases, ...aliases };
  return all[name] || name;
}
export const stateOf = (labels) => labels.filter((l) => l.startsWith('state:')).map((l) => l.slice(6));

// May `actor` set `label`? For state labels the caller must pass the current state.
export function mayAdd(label, actor, { from } = {}) {
  if (actor === 'human') return true;
  if (label.startsWith('state:')) {
    const to = label.slice(6);
    if (!from) return actor === 'orchestrator' || actor === 'lease';
    return (TRANSITIONS[from] || []).some((t) => t.to === to && t.actors.includes(actor));
  }
  const rule = GROUP_RULES.find(([re]) => re.test(label));
  return rule ? rule[1].includes(actor) : false;
}

const EXCLUSIVE = [
  { name: 'state', re: /^state:/ },
  { name: 'runtime-owner', re: /^agent:(claude|codex|any|gemini)$/ },
  { name: 'role', re: /^agent:([1-7]|main)$/ },
  { name: 'handoff', re: /^handoff:/ },
  { name: 'verdict', re: /^review:(approved|changes)$/ },
];

// Returns [{rule, labels}] for each violated mutual-exclusion rule.
export function violations(labels) {
  const v = [];
  for (const g of EXCLUSIVE) {
    const hit = labels.filter((l) => g.re.test(l));
    if (hit.length > 1) v.push({ rule: g.name, labels: hit });
  }
  if (labels.includes('handoff:to-claude') || labels.some((l) => l.startsWith('handoff:'))) {
    if (labels.includes('state:in-progress')) v.push({ rule: 'handoff-vs-in-progress', labels: [labels.find((l) => l.startsWith('handoff:')), 'state:in-progress'] });
  }
  if (labels.includes('state:done')) {
    const extra = labels.filter((l) => l.startsWith('handoff:') || /^review:(claude|codex|human|main)$/.test(l));
    if (extra.length) v.push({ rule: 'done-clean', labels: extra });
  }
  const verdict = labels.some((l) => /^review:(approved|changes)$/.test(l));
  const req = labels.filter((l) => /^review:(claude|codex|human|main)$/.test(l));
  if (verdict && req.length) v.push({ rule: 'verdict-vs-request', labels: req });
  return v;
}

// Compute the repaired label set: keep the most advanced state, drop transient extras.
const STATE_ORDER = ['backlog', 'ready', 'claimed', 'in-progress', 'review', 'changes-requested', 'blocked', 'done'];
export function repair(labels) {
  let out = [...new Set(labels)];
  const states = stateOf(out);
  if (states.length > 1) {
    const keep = states.sort((a, b) => STATE_ORDER.indexOf(b) - STATE_ORDER.indexOf(a))[0];
    out = out.filter((l) => !l.startsWith('state:') || l === `state:${keep}`);
  }
  for (const g of EXCLUSIVE.filter((x) => x.name !== 'state')) {
    const hit = out.filter((l) => g.re.test(l));
    if (hit.length > 1) { const keep = hit[hit.length - 1]; out = out.filter((l) => !g.re.test(l) || l === keep); }
  }
  if (out.includes('state:in-progress')) out = out.filter((l) => !l.startsWith('handoff:'));
  if (out.includes('state:done')) out = out.filter((l) => !l.startsWith('handoff:') && !/^review:(claude|codex|human|main)$/.test(l));
  if (out.some((l) => /^review:(approved|changes)$/.test(l))) out = out.filter((l) => !/^review:(claude|codex|human|main)$/.test(l));
  return out;
}
