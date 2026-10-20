import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { m5Sandbox, writeLedger, shareLedger, seedIssue, REPO } from '../helpers.mjs';

const lorem = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const decisionSections = (over = {}) => ({ Problem: lorem(40), 'Relevant architecture': 'ADR-3', Files: 'src/a.js:10-40', Constraints: lorem(20), 'What was tried': lorem(30), Options: lorem(60), Recommendation: lorem(20), 'Exact decision requested': 'Pick A or B?', ...over });

test('T-PACKET-1: an 800-word packet is rejected naming the largest section; a bounded one passes', () => {
  const sb = m5Sandbox();
  try {
    const big = path.join(sb.root, 'big.json');
    fs.writeFileSync(big, JSON.stringify({ sections: decisionSections({ Options: lorem(640) }) }));
    const r = sb.run('relay-packet', ['build', '--from-file', big]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /cut "Options" \(640 words\)/);
    assert.match(r.stderr, /limit 500/);
    assert.match(r.stderr, /Problem=40/, 'per-section counts are listed');

    const ok = path.join(sb.root, 'ok.json');
    fs.writeFileSync(ok, JSON.stringify({ sections: decisionSections() }));
    const good = sb.run('relay-packet', ['build', '--from-file', ok, '--json']);
    assert.equal(good.code, 0, good.stderr);
    assert.ok(good.json().words <= 500); assert.equal(good.json().counts.Options, 60);
    assert.match(good.json().text, /^## Problem\n/);

    const missing = path.join(sb.root, 'missing.json');
    const s = decisionSections(); delete s.Recommendation;
    fs.writeFileSync(missing, JSON.stringify({ sections: s }));
    const m = sb.run('relay-packet', ['build', '--from-file', missing]);
    assert.equal(m.code, 3); assert.match(m.stderr, /missing section\(s\): Recommendation/);
    fs.writeFileSync(missing, JSON.stringify({ sections: { ...decisionSections(), Extra: 'x' } }));
    assert.equal(sb.run('relay-packet', ['build', '--from-file', missing]).code, 3);
  } finally { sb.cleanup(); }
});

test('T-PACKET-1b: the limit comes from routing.packet_max_words; review packets auto-fill PR and acceptance criteria', () => {
  const sb = m5Sandbox('routing: {packet_max_words: 120}\n');
  try {
    const f = path.join(sb.root, 'p.json');
    fs.writeFileSync(f, JSON.stringify({ sections: decisionSections() }));
    assert.equal(sb.run('relay-packet', ['build', '--from-file', f]).code, 3, '170 words > 120');

    const issue = seedIssue(sb, { title: 'Cart rework', body: '## Objective\nx\n\n## Acceptance Criteria\n- [ ] totals update\n- [ ] keyboard works\n\n## Risk\nhigh' });
    const pr = JSON.parse(sb.gh(['api', '-X', 'POST', 'repos/local/sandbox/pulls', '--input', '-'], JSON.stringify({ title: 'Rework cart', head: 'agent/x/1', base: 'main', body: `Closes #${issue}` })).stdout).number;
    fs.writeFileSync(f, JSON.stringify({ sections: { 'Diff stat': '3 files', 'Risky hunks': 'src/cart.js:10-30', Evidence: 'npm test: 12 pass', NOT_VERIFIED: 'visual check' } }));
    const r = sb.run('relay-packet', ['build', '--pr', String(pr), '--from-file', f, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json().text, new RegExp(`## PR\\n#${pr} Rework cart`));
    assert.match(r.json().text, /totals update/);
    assert.equal(sb.run('relay-packet', ['check', f]).code, 3, 'check validates against the packet schema');
  } finally { sb.cleanup(); }
});

test('ledger: append validates, prices from workflow.yaml, rejects prompts/secrets, rotates monthly, locks concurrent writers', async () => {
  const sb = m5Sandbox();
  try {
    const row = { run_id: 'r1', runtime: 'claude', tier: 'T1', task_class: 'implement', issue: 5, tokens_in: 1000000, tokens_out: 100000, outcome: 'done' };
    const a = sb.run('relay-ledger', ['append', '--row', JSON.stringify(row), '--json']);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.json().cost_usd, 4.5, '1M in * $3 + 0.1M out * $15 = 4.5');
    assert.equal(sb.run('relay-ledger', ['append', '--row', JSON.stringify({ ...row, prompt: 'write me code' })]).code, 3, 'unknown field (e.g. a prompt) refused');
    assert.equal(sb.run('relay-ledger', ['append', '--row', JSON.stringify({ ...row, run_id: 'r2', reason: 'token ghp_abcdefghijklmnop' })]).code, 3, 'secret-looking text refused');
    assert.equal(sb.run('relay-ledger', ['append', '--row', JSON.stringify({ ...row, run_id: 'r3', reason: 'x'.repeat(2500) })]).code, 3);
    assert.equal(sb.run('relay-ledger', ['append', '--row', '{nope']).code, 3);
    assert.equal(sb.run('relay-ledger', ['append', '--dry-run', '--row', JSON.stringify({ ...row, run_id: 'dry' })]).code, 0);
    assert.equal(sb.run('relay-ledger', ['read']).json().length, 1, 'dry-run and refused rows wrote nothing');

    // monthly rotation
    const next = sb.run('relay-ledger', ['append', '--row', JSON.stringify({ ...row, run_id: 'r4' })], { env: { RELAY_NOW: '2026-11-02T00:00:00Z' } });
    assert.equal(next.code, 0, next.stderr);
    const dir = path.join(sb.work, '.relay/ledger');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('usage')).sort(), ['usage-2026-10.jsonl', 'usage.jsonl']);
    assert.deepEqual(sb.run('relay-ledger', ['read']).json().map((r) => r.run_id), ['r1', 'r4'], 'read spans rotated files in order');

    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => sb.spawnScript('relay-ledger', ['append', '--row', JSON.stringify({ ...row, run_id: `c${i}` }), '--json'], { env: { RELAY_NOW: '2026-11-03T00:00:00Z' } })));
    assert.ok(rs.every((r) => r.code === 0), rs.map((r) => r.stderr).join());
    const lines = fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 9); lines.forEach((l) => JSON.parse(l));
  } finally { sb.cleanup(); }
});

test('T-REPORT-1: cost per merged PR and tier mix computed from the fixture ledger', () => {
  const sb = m5Sandbox();
  try {
    const dir = path.join(sb.work, '.relay/ledger'); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(REPO, 'tests/fixtures/m5/ledger.jsonl'), path.join(dir, 'usage.jsonl'));
    const r = sb.run('relay-report', ['--json']);
    assert.equal(r.code, 0, r.stderr);
    const rep = r.json();
    assert.equal(rep.cost_per_merged_pr.merged_prs, 2);
    assert.deepEqual(rep.cost_per_merged_pr.by_pr, { 20: 2.5, 21: 3.6 });
    assert.equal(rep.cost_per_merged_pr.mean_usd, 3.05);
    assert.equal(rep.total_cost_usd, 6.1);
    assert.equal(rep.tier_mix.T1.tokens, 450000); assert.equal(rep.tier_mix.T2.tokens, 20000); assert.equal(rep.tier_mix.T0.tokens, 10000);
    assert.equal(rep.tier_mix.T1.share, 0.9375); assert.equal(rep.tier_mix.T2.share, 0.0417);
    assert.equal(rep.tier_mix.T2.over_cap, true, 'T2 4.17% > 4% cap'); assert.equal(rep.tier_mix.T1.over_cap, false);
    assert.equal(rep.top_combined.over_cap, false);
    assert.deepEqual(rep.rework_by_tier_runtime['T1/codex'], { reviews: 2, changes_requested: 1, rework_rate: 0.5 });
    assert.equal(rep.rework_by_tier_runtime['T2/claude'].rework_rate, 0);
    assert.equal(rep.escalations, 1); assert.equal(rep.rate_limit_incidents, 1);

    const md = sb.run('relay-report', []).stdout;
    assert.match(md, /\| T2 \| 1 \| 20000 \| 1\.5 \| 4\.2% \*\*OVER\*\* \| 4\.0% \|/);
    assert.match(md, /#20: 2\.5 USD/); assert.match(md, /mean: 3\.05 USD/);
    const w = sb.run('relay-report', ['--write']);
    assert.equal(w.code, 0);
    assert.deepEqual(fs.readdirSync(path.join(sb.work, 'harness/reports')).sort(), ['usage-2026-10-20.json', 'usage-2026-10-20.md']);
    assert.equal(sb.run('relay-report', ['--merged', '99', '--json']).json().cost_per_merged_pr.merged_prs, 3, '--merged adds PRs');
    assert.equal(sb.run('relay-governor', ['report', '--json']).json().rows, 10, 'governor report is an alias');
  } finally { sb.cleanup(); }
});

test('T-REPORT-1b: unpriced rows are called out', () => {
  const sb = m5Sandbox();
  try {
    writeLedger(sb, [{ ts: '2026-10-19T10:00:00Z', run_id: 'u', runtime: 'claude', tier: 'T3', task_class: 'audit', tokens_in: 10, outcome: 'done' }]);
    const rep = sb.run('relay-report', ['--json']).json();
    assert.equal(rep.unpriced_rows, 1);
    assert.match(sb.run('relay-report', []).stdout, /no price/);
  } finally { sb.cleanup(); }
});

test('relay-route CLI: exit 0 decided, exit 8 when the T2 cap denies, override needs a reason and logs', () => {
  const sb = m5Sandbox();
  try {
    const n = seedIssue(sb, { title: 'Risky', labels: ['state:ready', 'agent:codex', 'type:feature'] });
    const ok = sb.run('relay-route', [String(n), '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual([ok.json().decision.tier, ok.json().decision.runtime], ['T1', 'codex']);
    assert.deepEqual(ok.json().target, { kind: 'issue', number: n });

    writeLedger(sb, shareLedger(100000));
    const denied = sb.run('relay-route', [String(n), '--class', 'high_risk_review', '--json']);
    assert.equal(denied.code, 8); assert.equal(denied.json().denied, true); assert.equal(denied.json().decision.fallback.tier, 'T1');

    assert.equal(sb.run('relay-route', [String(n), '--tier', 'T2']).code, 3, '--tier without --reason');
    const o = sb.run('relay-route', [String(n), '--tier', 'T2', '--reason', 'cart architecture', '--json']);
    assert.equal(o.code, 0, o.stderr); assert.equal(o.json().overridden, true);
    assert.ok(sb.issue(n).labels.some((l) => l.name === 'route:T2'));
    const last = sb.run('relay-ledger', ['read']).json().at(-1);
    assert.equal(last.outcome, 'escalated'); assert.match(last.reason, /cart architecture/);
    assert.equal(sb.run('relay-route', [String(n), '--json']).json().decision.tier, 'T2', 'the route:T2 label now pins the tier');

    const exp = sb.run('relay-route', [String(n), '--explain']);
    assert.match(exp.stdout, /risk score:/);
    assert.equal(sb.run('relay-route', [String(n), '--class', 'bogus']).code, 3);
  } finally { sb.cleanup(); }
});

test('relay-route on a PR: cross-runtime reviewer, rework counted from CHANGES verdicts, --propose never applies', () => {
  const sb = m5Sandbox();
  try {
    const issue = seedIssue(sb, { title: 'Built by codex', labels: ['state:review', 'agent:codex'] });
    const pr = JSON.parse(sb.gh(['api', '-X', 'POST', 'repos/local/sandbox/pulls', '--input', '-'], JSON.stringify({ title: 'impl', head: 'agent/codex/1', base: 'main', body: `Closes #${issue}` })).stdout).number;
    sb.gh(['api', '-X', 'POST', `repos/local/sandbox/issues/${pr}/labels`, '--input', '-'], JSON.stringify({ labels: ['agent:codex'] }));
    const r = sb.run('relay-route', [String(pr), '--json', '--paths', 'src/a.js']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().task_class, 'routine_review'); assert.equal(r.json().decision.runtime, 'claude');
    for (let i = 0; i < 2; i++) sb.gh(['api', '-X', 'POST', `repos/local/sandbox/issues/${pr}/comments`, '--input', '-'], JSON.stringify({ body: '<!-- relay:verdict {"type":"verdict","result":"CHANGES"} -->\nCHANGES' }));
    const r2 = sb.run('relay-route', [String(pr), '--json', '--paths', 'src/a.js']).json();
    assert.equal(r2.decision.tier, 'T2', 'two CHANGES verdicts raise the tier'); assert.equal(r2.escalation_from, 'T1');
    assert.equal(sb.run('relay-route', ['--propose']).stdout.trim(), 'no routing proposals');
  } finally { sb.cleanup(); }
});
