import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, mayAdd, violations, repair, canon } from '../../core/lib/labels.mjs';

test('catalog has the full label set with aliases', () => {
  const names = new Set(CATALOG.labels.map((l) => l.name));
  for (const n of ['agent:claude', 'agent:codex', 'agent:any', 'agent:7', 'agent:main', 'handoff:to-codex', 'state:ready', 'state:done', 'review:approved', 'review:changes', 'route:T2', 'risk:high', 'owner-decision', 'priority:p0', 'area:docs', 'type:refactor']) assert.ok(names.has(n), n);
  assert.equal(canon('state:ready-for-agent'), 'state:ready');
  assert.equal(new Set(CATALOG.labels.map((l) => l.name)).size, CATALOG.labels.length, 'no duplicates');
});

test('state transitions follow the allowed-setter table', () => {
  assert.ok(mayAdd('state:claimed', 'implementer', { from: 'ready' }));
  assert.ok(!mayAdd('state:done', 'implementer', { from: 'review' }));
  assert.ok(mayAdd('state:done', 'merge', { from: 'review' }));
  assert.ok(!mayAdd('state:ready', 'implementer', { from: 'backlog' }));
  assert.ok(mayAdd('state:ready', 'lease', { from: 'claimed' }));
  assert.ok(!mayAdd('state:review', 'implementer', { from: 'ready' }), 'cannot skip claim');
  assert.ok(mayAdd('state:changes-requested', 'reviewer', { from: 'review' }));
  assert.ok(!mayAdd('state:in-progress', 'reviewer', { from: 'changes-requested' }));
});

test('non-state labels follow the actor matrix', () => {
  assert.ok(!mayAdd('agent:codex', 'implementer'));
  assert.ok(mayAdd('agent:codex', 'governor'));
  assert.ok(mayAdd('handoff:to-claude', 'implementer'));
  assert.ok(!mayAdd('review:approved', 'implementer'));
  assert.ok(mayAdd('review:approved', 'reviewer'));
  assert.ok(mayAdd('risk:high', 'reviewer'));
  assert.ok(!mayAdd('route:T2', 'implementer'));
  assert.ok(mayAdd('anything', 'human'));
});

test('mutual exclusion violations and repair', () => {
  assert.deepEqual(violations(['state:ready', 'state:in-progress']).map((v) => v.rule), ['state']);
  assert.deepEqual(repair(['state:ready', 'state:in-progress', 'agent:codex']).sort(), ['agent:codex', 'state:in-progress']);
  assert.ok(violations(['state:in-progress', 'handoff:to-codex']).some((v) => v.rule === 'handoff-vs-in-progress'));
  assert.deepEqual(violations(['state:ready', 'agent:codex', 'agent:3', 'priority:p1']), []);
  assert.ok(violations(['agent:codex', 'agent:claude']).length === 1);
  assert.ok(violations(['review:approved', 'review:changes']).length === 1);
  assert.deepEqual(repair(['state:done', 'handoff:to-codex', 'review:codex']), ['state:done']);
  assert.deepEqual(violations(repair(['state:ready', 'state:claimed', 'state:review', 'review:approved', 'review:codex'])), []);
});
