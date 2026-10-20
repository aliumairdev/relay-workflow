import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue, useFakeRuntimes, ledgerRows, prsOf } from '../helpers.mjs';

const BODY = '## Objective\nAdd a thing\n\n## Owned Paths\nsrc/**\n';
const labels = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();
const kinds = (sb, n) => sb.run('relay-journal', ['read', String(n), '--json']).json().entries.map((e) => e.kind);

test('T-CODEX-1: an agent:codex issue is claimed, implemented, PR opened, ledger row written, journal kept', () => {
  const sb = useFakeRuntimes(makeSandbox());
  try {
    const n = seedIssue(sb, { title: 'Add thing', body: BODY, labels: ['state:ready', 'agent:codex', 'priority:p1'] });
    const r = sb.run('relay-codex-dispatch', [String(n), '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = r.json();
    assert.equal(res.outcome, 'done'); assert.ok(res.pr);

    const prs = prsOf(sb);
    assert.equal(prs.length, 1);
    assert.match(prs[0].pull_request.head.ref, new RegExp(`^agent/codex/${n}-add-thing$`));
    assert.match(prs[0].body, new RegExp(`Closes #${n}`));
    assert.ok(sb.git(['ls-remote', '--heads', 'origin', prs[0].pull_request.head.ref]).stdout.includes('agent/codex'), 'branch pushed');
    assert.deepEqual(labels(sb, n).filter((l) => /^(state|review|agent):/.test(l)), ['agent:codex', 'review:claude', 'state:review']);
    assert.deepEqual(kinds(sb, n), ['claimed', 'plan', 'progress', 'pr', 'summary']);
    assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 0, 'journal complete for the merge gate');

    const rows = ledgerRows(sb);
    assert.equal(rows.length, 1);
    assert.deepEqual({ runtime: rows[0].runtime, tier: rows[0].tier, task_class: rows[0].task_class, issue: rows[0].issue, outcome: rows[0].outcome, pr: rows[0].pr }, { runtime: 'codex', tier: 'T1', task_class: 'implement', issue: n, outcome: 'done', pr: res.pr });
    assert.ok(/^c-default$/.test(rows[0].model), 'model from the codex tier map');
    assert.ok(!JSON.stringify(rows[0]).includes('Add a thing'), 'ledger holds no prompt content');
    assert.equal(sb.state().claims[0].agent_id, res.agent_id);
    const brief = fs.readdirSync(path.join(sb.work, '.relay/briefs')).find((f) => f.startsWith(`issue-${n}-`));
    const text = fs.readFileSync(path.join(sb.work, '.relay/briefs', brief), 'utf8');
    assert.match(text, /already claimed #\d+ for you/); assert.match(text, /ISSUE JOURNAL/); assert.match(text, /RUNTIME: Codex/);
  } finally { sb.cleanup(); }
});

test('T-CODEX-2: two loops running concurrently produce one claim and one PR', async () => {
  const sb = useFakeRuntimes(makeSandbox());
  sb.env.FAKE_RUNTIME_BEHAVIORS = JSON.stringify(['sleep:1500']);
  try {
    const n = seedIssue(sb, { title: 'Race me', body: BODY, labels: ['state:ready', 'agent:codex'] });
    const a = sb.spawnScript('relay-loop', ['--runtime', 'codex', '--once', '--no-review', '--json'], { env: { RELAY_FAKE_GH_DB: sb.env.RELAY_FAKE_GH_DB } });
    const b = sb.spawnScript('relay-loop', ['--runtime', 'codex', '--once', '--no-review', '--json']);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.code, 0, ra.stderr); assert.equal(rb.code, 0, rb.stderr);
    assert.equal(prsOf(sb).length, 1, 'exactly one PR');
    const claims = sb.comments(n).filter((c) => c.body.includes('relay:claim '));
    assert.equal(claims.length, 1, 'exactly one claim comment');
    assert.equal(ledgerRows(sb).filter((r) => r.outcome === 'done').length, 1);
    const done = [ra, rb].map((r) => JSON.parse(r.stdout.trim().split('\n').pop())).flatMap((s) => s.dispatched);
    assert.equal(done.length, 1, 'only one loop reports a dispatch');
  } finally { sb.cleanup(); }
});

test('T-FAIL-RT: a missing runtime binary relabels the issue to the other runtime with a handoff reason; no duplicate work', () => {
  const sb = useFakeRuntimes(makeSandbox());
  try {
    sb.patchConfig((t) => t.replace(/exec_cmd: \S+fake-codex/, 'exec_cmd: /nonexistent/codex-binary'));
    const n = seedIssue(sb, { title: 'Needs codex', body: BODY, labels: ['state:ready', 'agent:codex'] });
    const r = sb.run('relay-codex-dispatch', [String(n), '--json']);
    assert.equal(r.code, 9, r.stderr + r.stdout);
    assert.equal(r.json().outcome, 'fallback'); assert.equal(r.json().to_runtime, 'claude');
    assert.deepEqual(labels(sb, n).filter((l) => /^(state|agent|handoff):/.test(l)), ['agent:claude', 'handoff:to-claude', 'state:ready']);
    const h = sb.run('relay-handoff', ['read', String(n)]).json();
    assert.equal(h.reason, 'capability'); assert.equal(h.from.runtime, 'codex'); assert.equal(h.to.runtime, 'claude');
    assert.match(sb.comments(n).map((c) => c.body).join('\n'), /binary not found/);
    assert.equal(sb.state().claims.length, 0, 'codex claim released');
    assert.equal(prsOf(sb).length, 0);

    // the claude loop picks it up, acknowledging the handoff, and completes it once
    const l = sb.run('relay-loop', ['--runtime', 'claude', '--once', '--no-review', '--json']);
    assert.equal(l.code, 0, l.stderr + l.stdout);
    assert.equal(prsOf(sb).length, 1);
    assert.match(prsOf(sb)[0].pull_request.head.ref, /^agent\/(codex|claude)\/\d+-needs-codex$/);
    assert.equal(ledgerRows(sb).filter((x) => x.outcome === 'done').length, 1);
    assert.equal(sb.run('relay-loop', ['--runtime', 'claude', '--once', '--no-review', '--json']).json().dispatched.length, 0, 'idempotent: nothing left to dispatch');
  } finally { sb.cleanup(); }
});

test('T-RL-1: rate limits back off on the schedule and resume the same run id; exceeding retries falls back', () => {
  const sb = useFakeRuntimes(makeSandbox());
  sb.env.FAKE_RUNTIME_BEHAVIORS = JSON.stringify(['rate-limit', 'rate-limit', 'implement']);
  const T0 = Date.parse('2026-10-20T10:00:00Z');
  const at = (s) => ({ env: { RELAY_NOW: new Date(T0 + s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') } });
  try {
    const n = seedIssue(sb, { title: 'Throttled', body: BODY, labels: ['state:ready', 'agent:codex'] });
    const d1 = sb.run('relay-codex-dispatch', [String(n), '--json'], at(0));
    assert.equal(d1.code, 10, d1.stderr + d1.stdout);
    assert.equal(d1.json().retry_after_s, 30); assert.equal(d1.json().attempt, 1);
    const runId = d1.json().run_id;

    const early = sb.run('relay-codex-dispatch', [String(n), '--json'], at(10));
    assert.equal(early.code, 10); assert.equal(early.json().outcome, 'wait'); assert.ok(early.json().retry_after_s <= 20, 'still inside the backoff window');

    const d2 = sb.run('relay-codex-dispatch', [String(n), '--json'], at(31));
    assert.equal(d2.code, 10, d2.stderr + d2.stdout);
    assert.equal(d2.json().retry_after_s, 60); assert.equal(d2.json().attempt, 2); assert.equal(d2.json().run_id, runId, 'same run id');

    const d3 = sb.run('relay-codex-dispatch', [String(n), '--json'], at(31 + 61));
    assert.equal(d3.code, 0, d3.stderr + d3.stdout);
    assert.equal(d3.json().outcome, 'done');

    const rows = ledgerRows(sb).filter((r) => r.issue === n);
    assert.deepEqual(rows.map((r) => r.outcome), ['rate_limited', 'rate_limited', 'done']);
    assert.ok(rows.every((r) => r.run_id === runId), 'one run id across attempts');
    assert.equal(prsOf(sb).length, 1);
    assert.equal(sb.comments(n).filter((c) => c.body.includes('relay:claim ')).length, 1, 'the claim was kept, not re-posted');
  } finally { sb.cleanup(); }
});

test('T-RL-1b: after max retries the governor relabels to the other runtime with the reason and saves WIP', () => {
  const sb = useFakeRuntimes(makeSandbox());
  sb.patchConfig((t) => t + 'rate_limit: { max_retries: 1, backoff_s: [5] }\n');
  sb.env.FAKE_RUNTIME_BEHAVIORS = JSON.stringify(['rate-limit']);
  const T0 = Date.parse('2026-10-20T10:00:00Z');
  const at = (s) => ({ env: { RELAY_NOW: new Date(T0 + s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') } });
  try {
    const n = seedIssue(sb, { title: 'Always throttled', body: BODY, labels: ['state:ready', 'agent:codex'] });
    assert.equal(sb.run('relay-codex-dispatch', [String(n)], at(0)).code, 10);
    // leave uncommitted work behind in the worktree to prove WIP is saved
    const wt = sb.state().claims[0].worktree; fs.writeFileSync(path.join(wt, 'unsaved.txt'), 'half done');
    const d = sb.run('relay-codex-dispatch', [String(n), '--json'], at(6));
    assert.equal(d.code, 0, d.stderr + d.stdout);
    assert.equal(d.json().outcome, 'fallback'); assert.equal(d.json().to_runtime, 'claude');
    assert.deepEqual(labels(sb, n).filter((l) => /^(state|agent|handoff):/.test(l)), ['agent:claude', 'handoff:to-claude', 'state:ready']);
    const h = sb.run('relay-handoff', ['read', String(n)]).json();
    assert.equal(h.reason, 'rate_limited'); assert.match(h.decisions.join(' '), /rate limited/);
    const branch = h.links.branch;
    const log = sb.git(['log', '--oneline', `origin/${branch}`]).stdout;
    assert.match(log, /wip: uncommitted work saved by the dispatcher/);
    const rows = ledgerRows(sb).map((r) => r.outcome);
    assert.ok(rows.includes('rate_limited') && rows.includes('fallback'));
    assert.equal(prsOf(sb).length, 0, 'no duplicate PR');
  } finally { sb.cleanup(); }
});

test('dispatch outcomes: silent death releases the claim; scripted failure releases and journals; denied runtime without exec_cmd is refused', () => {
  const sb = useFakeRuntimes(makeSandbox());
  try {
    const n = seedIssue(sb, { title: 'Dies', body: BODY, labels: ['state:ready', 'agent:codex'] });
    sb.env.FAKE_RUNTIME_BEHAVIORS = JSON.stringify(['die']);
    const d = sb.run('relay-codex-dispatch', [String(n), '--json']);
    assert.equal(d.code, 1); assert.match(d.json().reason, /without a PR/);
    assert.ok(labels(sb, n).includes('state:ready'), 'claim released: issue back in the queue immediately');
    assert.equal(sb.state().claims.length, 0);
    assert.equal(ledgerRows(sb).at(-1).outcome, 'failed');

    sb.env.FAKE_RUNTIME_BEHAVIORS = JSON.stringify(['fail']);
    const f = sb.run('relay-codex-dispatch', [String(n), '--json']);
    assert.equal(f.code, 1); assert.match(f.json().reason, /exit 2/);
    assert.ok(kinds(sb, n).includes('blocker'));

    sb.patchConfig((t) => t.replace(/exec_cmd: \S+fake-claude, /, ''));
    const c = seedIssue(sb, { title: 'claude only', body: BODY, labels: ['state:ready', 'agent:claude'] });
    const r = sb.run('relay-codex-dispatch', [String(c), '--runtime', 'claude']);
    assert.equal(r.code, 7); assert.match(r.stderr + r.stdout, /no exec_cmd/);
  } finally { sb.cleanup(); }
});
