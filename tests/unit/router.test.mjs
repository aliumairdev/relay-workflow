import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { decide, riskScore, routingOf, propose, capCheck, explain } from '../../core/lib/router.mjs';
import { parseConfig } from '../../core/lib/config.mjs';
import { REPO } from '../helpers.mjs';

const doc = YAML.parse(fs.readFileSync(path.join(REPO, 'tests/router/cases.yaml'), 'utf8'));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => (isObj(a) && isObj(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? deepMerge(a[k], b[k]) : a[k]])) : b);
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

test('router table config is itself a valid workflow.yaml fragment', () => {
  const { errors } = parseConfig(YAML.stringify({ version: 1, project: { name: 'x', repo: 'a/b' }, ...doc.config }));
  assert.deepEqual(errors, []);
});

for (const c of doc.cases) {
  test(`router row ${c.id}: ${c.name}`, () => {
    const cfg = c.config_patch ? deepMerge(doc.config, c.config_patch) : doc.config;
    const r = decide(c.input, cfg);
    for (const [k, v] of Object.entries(c.expect)) assert.deepEqual(get(r, k) ?? (v === null ? null : undefined), v, `${k} in ${JSON.stringify(r.decision)} / ${r.reasons.join(' | ')}`);
    for (const [k, re] of Object.entries(c.expect_match || {})) assert.match(String(get(r, k)), new RegExp(re));
  });
}

test('router is deterministic and offline: same inputs, same output', () => {
  const c = doc.cases.find((x) => x.id === '6');
  assert.deepEqual(decide(c.input, doc.config), decide(c.input, doc.config));
});

test('risk score is clamped to 0..100 and signals are itemised', () => {
  const routing = routingOf(doc.config);
  const r = riskScore({ labels: ['risk:high', 'area:accessibility'], paths: ['snippets/compat-a'], files: 50, lines: 2000, rework_rounds: 3, proof_failed: true }, routing);
  assert.equal(r.score, 100);
  assert.ok(r.signals.some((s) => s.kind === 'size' && s.points === 30), 'only the largest matching size signal counts');
  assert.ok(r.signals.some((s) => s.kind === 'rework' && s.points === 35));
});

test('unknown task class is rejected with exit 3', () => {
  assert.throws(() => decide({ class: 'nonsense' }, doc.config), (e) => e.code === 3);
});

test('explicit --tier override bypasses the cap and says so', () => {
  const r = decide({ class: 'implement', override: { tier: 'T2', reason: 'cart', by: 'human' }, history: { tier_share: { T2: 0.2 } } }, doc.config);
  assert.equal(r.decision.tier, 'T2'); assert.ok(!r.denied);
  assert.match(r.ledger_note, /cart/);
  assert.ok(r.reasons.some((x) => /cap bypassed/.test(x)));
});

test('cap check: combined top-tier cap and per-tier cap', () => {
  const b = doc.config.budgets;
  assert.equal(capCheck('T1', { T2: 0.5 }, b).ok, true);
  assert.equal(capCheck('T2', { T2: 0.03, T3: 0.02 }, b).ok, false, 'combined 5% reached');
  assert.equal(capCheck('T3', { T3: 0.01 }, b).ok, false);
  assert.equal(capCheck('T2', { T2: 0.039 }, b).ok, true);
});

test('explain lists the signals table', () => {
  const t = explain(decide(doc.cases.find((x) => x.id === '6').input, doc.config));
  assert.match(t, /risk score: 100/); assert.match(t, /\+40 {2}path/);
});

test('propose: de-escalation after a clean first-pass streak, never applied', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-10-${10 + i}T00:00:00Z`, run_id: `r${i}`, runtime: 'claude', tier: 'T2', task_class: 'high_risk_review', outcome: 'approved', issue: i }));
  const p = propose(rows, doc.config);
  assert.equal(p[0].kind, 'downgrade'); assert.equal(p[0].task_class, 'high_risk_review'); assert.equal(p[0].with_second_reviewer, true);
  assert.deepEqual(propose(rows.slice(1), doc.config), [], 'a streak of 9 is not enough');
  const mixed = rows.map((r, i) => (i === 9 ? { ...r, outcome: 'changes_requested' } : r));
  assert.deepEqual(propose(mixed, doc.config), []);
});

test('propose: escaped defects after T1-only approval suggest more scrutiny', () => {
  const rows = [
    { ts: '2026-10-10T00:00:00Z', run_id: 'a', runtime: 'claude', tier: 'T1', task_class: 'routine_review', outcome: 'approved', issue: 295 },
    { ts: '2026-10-11T00:00:00Z', run_id: 'b', runtime: 'claude', tier: 'T1', task_class: 'debug_real_env', outcome: 'failed', issue: 295 },
  ];
  assert.equal(propose(rows, doc.config)[0].kind, 'add_risk_scrutiny');
});
