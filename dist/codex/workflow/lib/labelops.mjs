import { canon, mayAdd, stateOf, violations, repair } from './labels.mjs';
import { RelayError, EXIT } from './exit.mjs';

const HANDOFF_REMOVERS = ['human', 'orchestrator', 'implementer', 'governor'];

// Change labels on an issue/PR with actor and state-machine checks. Idempotent.
// A new state:* replaces the old one. Returns {before, after, changed}.
export function changeLabels(cp, cfg, number, { add = [], remove = [], actor = 'human' } = {}) {
  const aliases = cfg.labels?.aliases || {};
  const before = cp.getIssue(number).labels.map((l) => canon(l, aliases));
  const adds = add.map((l) => canon(l, aliases));
  const removes = remove.map((l) => canon(l, aliases));
  let after = [...before];

  const newStates = adds.filter((l) => l.startsWith('state:'));
  if (newStates.length > 1) throw new RelayError(`denied: more than one state label requested (${newStates.join(', ')})`, EXIT.DENIED);
  const from = stateOf(before)[0];
  for (const l of adds) {
    if (before.includes(l)) continue;
    if (!mayAdd(l, actor, { from })) {
      throw new RelayError(`denied: actor "${actor}" may not set ${l}${l.startsWith('state:') ? ` (from state:${from ?? 'none'})` : ''}`, EXIT.DENIED, { label: l });
    }
  }
  for (const l of removes) {
    if (!before.includes(l)) continue;
    const ok = l.startsWith('handoff:') ? HANDOFF_REMOVERS.includes(actor) : l.startsWith('state:') ? actor === 'human' || actor === 'orchestrator' || actor === 'lease' : mayAdd(l, actor);
    if (!ok) throw new RelayError(`denied: actor "${actor}" may not remove ${l}`, EXIT.DENIED, { label: l });
  }
  if (newStates.length) after = after.filter((l) => !l.startsWith('state:'));
  after = after.filter((l) => !removes.includes(l));
  for (const l of adds) if (!after.includes(l)) after.push(l);

  const same = before.length === after.length && before.every((l) => after.includes(l));
  if (!same) cp.setLabels(number, after);
  return { before, after, changed: !same, violations: violations(after) };
}

export function lintIssue(issue) {
  const v = violations(issue.labels);
  return v.length ? { number: issue.number, violations: v, repaired: repair(issue.labels) } : null;
}
