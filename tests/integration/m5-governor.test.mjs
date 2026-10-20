import { test } from 'node:test';
import assert from 'node:assert/strict';
import { m5Sandbox, writeLedger, shareLedger, seedIssue } from '../helpers.mjs';

const admit = (sb, run, opts) => sb.run('relay-governor', ['admit', '--run', JSON.stringify(run), '--json'], opts);
const names = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();

test('T-GOV-1: top-tier share above the cap denies a new T2 dispatch (exit 11) with a fallback; below the cap admits', () => {
  const sb = m5Sandbox();
  try {
    writeLedger(sb, shareLedger(100000)); // T2 share = 5.0% >= 4% cap
    const denied = admit(sb, { run_id: 'g1', tier: 'T2', runtime: 'claude', task_class: 'high_risk_review' });
    assert.equal(denied.code, 11, denied.stderr);
    assert.equal(denied.json().decision, 'deny');
    assert.deepEqual(denied.json().fallback, { tier: 'T1', second_reviewer: true, requires_owner_approval: true });
    assert.match(denied.json().reason, /cap/);
    assert.equal(admit(sb, { run_id: 'g2', tier: 'T1', runtime: 'claude', task_class: 'implement' }).code, 0, 'T1 is unaffected by the T2 cap');

    writeLedger(sb, shareLedger(50000)); // 2.6%
    const ok = admit(sb, { run_id: 'g3', tier: 'T2', runtime: 'claude', task_class: 'high_risk_review' });
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(ok.json().decision, 'admit');
  } finally { sb.cleanup(); }
});

test('T-GOV-1b: tiny ledgers do not trip the share cap; per-task token limit and per-PR ceiling deny', () => {
  const sb = m5Sandbox();
  try {
    writeLedger(sb, [{ ts: '2026-10-19T10:00:00Z', run_id: 'only', runtime: 'claude', tier: 'T2', task_class: 'audit', tokens_in: 1000, outcome: 'done' }]);
    assert.equal(admit(sb, { run_id: 'a', tier: 'T2', runtime: 'claude', task_class: 'audit' }).code, 0, 'below tier_share_min_runs the share is not trusted');
    assert.equal(admit(sb, { run_id: 'b', tier: 'T2', runtime: 'claude', task_class: 'audit', est_tokens: 300000 }).code, 11, 'T2 per-task token limit is 250k');
    assert.equal(admit(sb, { run_id: 'c', tier: 'T1', runtime: 'claude', task_class: 'implement', issue: 9, pr_spent_usd: 15 }).code, 11, 'per-PR cost ceiling');
  } finally { sb.cleanup(); }
});

test('T-LOAD-1: load above the limit waits (exit 10, retry_after); heavy slots limit to 2; max_agents waits', () => {
  const sb = m5Sandbox();
  try {
    const over = { env: { RELAY_FAKE_LOAD: '100', RELAY_FAKE_CORES: '4' } };
    const w = admit(sb, { run_id: 'l1', tier: 'T1', runtime: 'claude', task_class: 'implement' }, over);
    assert.equal(w.code, 10); assert.ok(w.json().retry_after_s > 0); assert.match(w.json().reason, /load 100 exceeds limit 6/);
    const s = sb.run('relay-governor', ['sample-load', '--json'], over).json();
    assert.deepEqual([s.load1, s.cores, s.limit, s.over], [100, 4, 6, true]);
    const calm = { env: { RELAY_FAKE_LOAD: '2', RELAY_FAKE_CORES: '4' } };
    assert.equal(admit(sb, { run_id: 'l2', tier: 'T1', runtime: 'claude', task_class: 'implement' }, calm).code, 0);

    const heavy = (id) => admit(sb, { run_id: id, tier: 'T1', runtime: 'claude', task_class: 'implement', heavy: true }, calm);
    assert.equal(heavy('h1').code, 0); assert.equal(heavy('h2').code, 0);
    const third = heavy('h3'); assert.equal(third.code, 10); assert.match(third.json().reason, /heavy slots/);
    assert.equal(sb.run('relay-governor', ['release', 'h1']).code, 0);
    assert.equal(heavy('h3').code, 0, 'a freed slot admits the third');
    assert.equal(admit(sb, { run_id: 'h2', tier: 'T1', runtime: 'claude', task_class: 'implement', heavy: true }, calm).json().resumed, true, 'a known run id is not double counted');
  } finally { sb.cleanup(); }
});

test('T-LOAD-1b: max_agents caps concurrency', () => {
  const sb = m5Sandbox();
  try {
    sb.patchConfig((t) => t.replace('max_agents: 8', 'max_agents: 2'));
    const calm = { env: { RELAY_FAKE_LOAD: '0', RELAY_FAKE_CORES: '4' } };
    for (const id of ['m1', 'm2']) assert.equal(admit(sb, { run_id: id, tier: 'T1', runtime: 'claude', task_class: 'implement' }, calm).code, 0);
    assert.equal(admit(sb, { run_id: 'm3', tier: 'T1', runtime: 'claude', task_class: 'implement' }, calm).code, 10);
    assert.equal(sb.run('relay-governor', ['admit', '--dry-run', '--json', '--run', JSON.stringify({ run_id: 'm4', tier: 'T1', runtime: 'claude' })], calm).code, 10);
  } finally { sb.cleanup(); }
});

test('T-RL-1: backoff schedule on a fake clock resumes the same run id; exceeding retries falls back and relabels with a reason', () => {
  const sb = m5Sandbox();
  try {
    const n = seedIssue(sb, { title: 'Flaky limit', labels: ['state:ready', 'agent:any'] });
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude', '--lease-min', '600']).code, 0);
    const at = (s) => ({ env: { RELAY_NOW: new Date(Date.parse('2026-10-20T10:00:00Z') + s * 1000).toISOString(), RELAY_FAKE_LOAD: '0', RELAY_FAKE_CORES: '4' } });
    const run = { run_id: 'r1', tier: 'T1', runtime: 'claude', task_class: 'implement', issue: n, agent_id: 'claude-1' };
    assert.equal(admit(sb, run, at(0)).code, 0);

    let r = sb.run('relay-governor', ['note-rate-limit', 'r1', '--json'], at(0));
    assert.equal(r.code, 0, r.stderr); assert.deepEqual([r.json().action, r.json().wait_s, r.json().attempt, r.json().resume_same_run], ['backoff', 30, 1, true]);
    const early = admit(sb, run, at(10));
    assert.equal(early.code, 10); assert.equal(early.json().retry_after_s, 20);
    const resumed = admit(sb, run, at(30));
    assert.equal(resumed.code, 0); assert.equal(resumed.json().resumed, true, 'same run id resumes');

    r = sb.run('relay-governor', ['note-rate-limit', 'r1', '--json'], at(30));
    assert.equal(r.json().wait_s, 60);
    assert.equal(admit(sb, run, at(89)).code, 10); assert.equal(admit(sb, run, at(90)).code, 0);
    r = sb.run('relay-governor', ['note-rate-limit', 'r1', '--json'], at(90));
    assert.equal(r.json().wait_s, 120);
    assert.equal(admit(sb, run, at(210)).code, 0);

    // fourth hit exceeds max_retries=3 -> fallback to the other runtime
    r = sb.run('relay-governor', ['note-rate-limit', 'r1', '--json'], at(210));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json().action, r.json().from_runtime, r.json().to_runtime], ['fallback', 'claude', 'codex']);
    const l = names(sb, n);
    assert.ok(l.includes('agent:codex') && l.includes('handoff:to-codex') && l.includes('state:ready') && !l.includes('agent:claude'), l.join());
    const h = sb.run('relay-handoff', ['read', String(n)]).json();
    assert.equal(h.reason, 'rate_limited'); assert.match(h.decisions[0], /claude rate limited, 3 retries/);
    assert.equal(sb.state().claims.length, 0, 'claim released');

    const rows = sb.run('relay-ledger', ['read']).json();
    assert.equal(rows.filter((x) => x.outcome === 'rate_limited' && x.rate_limit).length, 4);
    const fb = rows.find((x) => x.outcome === 'fallback'); assert.ok(fb && /rate limited/.test(fb.reason));

    // codex completes from the handoff: exactly one live claim, no duplicate work item
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'codex-1', '--runtime', 'codex']).code, 7, 'ack required');
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'codex-1', '--runtime', 'codex', '--ack-handoff', h.sha]).code, 0);
    assert.equal(sb.comments(n).filter((c) => c.body.includes('relay:claim ')).length, 2);
    assert.equal(sb.run('relay-governor', ['admit', '--json', '--run', JSON.stringify({ run_id: 'r1', tier: 'T1', runtime: 'codex', task_class: 'implement' })], at(215)).code, 0, 'fallback frees the old slot');
  } finally { sb.cleanup(); }
});

test('T-RL-1b: --retry-after overrides the schedule; no other runtime enabled -> needs human (exit 2)', () => {
  const sb = m5Sandbox();
  try {
    const calm = { env: { RELAY_FAKE_LOAD: '0', RELAY_FAKE_CORES: '4' } };
    admit(sb, { run_id: 'x', tier: 'T1', runtime: 'claude', task_class: 'implement' }, calm);
    assert.equal(sb.run('relay-governor', ['note-rate-limit', 'x', '--retry-after', '7', '--json']).json().wait_s, 7);
    assert.equal(sb.run('relay-governor', ['note-rate-limit', 'nope']).code, 3, 'unknown run id');
    sb.patchConfig((t) => t.replace('codex: { enabled: true', 'codex: { enabled: false'));
    for (let i = 0; i < 2; i++) sb.run('relay-governor', ['note-rate-limit', 'x']);
    const last = sb.run('relay-governor', ['note-rate-limit', 'x', '--json']);
    assert.equal(last.code, 2); assert.equal(last.json().action, 'no_fallback');
  } finally { sb.cleanup(); }
});
