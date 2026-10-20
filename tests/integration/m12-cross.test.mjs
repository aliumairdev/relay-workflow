// T-CROSS-1: the two-runtime dry run (AGENT_HANDOFF section 7) with fake runtimes.
// Covered by dedicated tests instead of repeated here: stale-claim takeover (T-CLAIM-3), rate-limit fallback (T-RL-1b),
// handoff chain (T-HAND-1), claim race (T-CLAIM-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue, useFakeRuntimes, ledgerRows, prsOf } from '../helpers.mjs';

const BODY = (p) => `## Objective\nAdd a thing\n\n## Owned Paths\n${p}\n`;
const labels = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();
const behaviors = (sb, list) => { sb.env.FAKE_RUNTIME_BEHAVIORS = JSON.stringify(list); fs.rmSync(sb.env.FAKE_RUNTIME_STATE, { force: true }); };

test('T-CROSS-1: claude and codex build, cross-review, rework, bot-gate, and merge through the queue; then fast mode', () => {
  const sb = useFakeRuntimes(makeSandbox());
  sb.patchConfig((t) => t + 'journal: { require: [plan, summary] }\n');
  try {
    const A = seedIssue(sb, { title: 'Alpha feature', body: BODY('src/a/**'), labels: ['state:ready', 'agent:claude'] });
    const B = seedIssue(sb, { title: 'Beta feature', body: BODY('src/b/**'), labels: ['state:ready', 'agent:codex'] });

    // 1. dispatch both: separate claims, branches and worktrees
    const dA = sb.run('relay-codex-dispatch', [String(A), '--runtime', 'claude', '--json']);
    const dB = sb.run('relay-codex-dispatch', [String(B), '--runtime', 'codex', '--json']);
    assert.equal(dA.code, 0, dA.stderr + dA.stdout); assert.equal(dB.code, 0, dB.stderr + dB.stdout);
    const claims = sb.state().claims;
    assert.deepEqual(claims.map((c) => [c.issue, c.runtime]).sort(), [[A, 'claude'], [B, 'codex']]);
    assert.match(claims.find((c) => c.issue === A).branch, /^agent\/claude\//); assert.match(claims.find((c) => c.issue === B).branch, /^agent\/codex\//);
    assert.notEqual(claims[0].worktree, claims[1].worktree);
    const prA = dA.json().pr, prB = dB.json().pr;
    assert.ok(prA && prB && prA !== prB);

    // 2. a second claimer for A is refused
    assert.equal(sb.run('relay-claim', [String(A), '--agent', 'late', '--runtime', 'claude']).code, 7);

    // 5. cross-review: the implementer's own runtime may not review or verdict
    assert.equal(sb.run('relay-codex-dispatch', ['--review', String(prA), '--runtime', 'claude']).code, 7, 'claude may not review a claude PR');
    const own = sb.run('relay-verdict', ['post', String(prA), '--result', 'APPROVED', '--checklist', '{"acceptance":"PASS"}'], { env: { RELAY_RUNTIME: 'claude', RELAY_ACTOR: 'reviewer' } });
    assert.equal(own.code, 7, 'own-runtime verdict rejected');
    behaviors(sb, ['review:CHANGES']);
    const rv1 = sb.run('relay-codex-dispatch', ['--review', String(prA), '--runtime', 'codex', '--json']);
    assert.equal(rv1.code, 0, rv1.stderr + rv1.stdout); assert.equal(rv1.json().outcome, 'changes_requested');
    assert.ok(labels(sb, prA).includes('review:changes'));
    assert.ok(labels(sb, A).includes('state:changes-requested'));

    // 6. rework: the builder pushes a fix; the reviewer re-reviews the new head only
    const wtA = claims.find((c) => c.issue === A).worktree;
    fs.mkdirSync(path.join(wtA, 'src/a'), { recursive: true });
    fs.writeFileSync(path.join(wtA, 'src/a/fix.mjs'), 'export const fixed = true;\n');
    sb.git(['add', '-A'], wtA); assert.equal(sb.git(['commit', '-qm', 'fix: address review'], wtA).status, 0);
    assert.equal(sb.git(['push', '-q', 'origin', 'HEAD'], wtA).status, 0);
    sb.run('relay-labels', ['set', String(A), 'state:in-progress', '--actor-class', 'implementer']);
    sb.run('relay-labels', ['set', String(A), 'state:review', '--actor-class', 'implementer'], {});
    sb.run('relay-labels', ['set', String(prA), 'review:codex', '--remove', 'review:changes', '--actor-class', 'human']);
    behaviors(sb, ['review:APPROVED']);
    const rv2 = sb.run('relay-codex-dispatch', ['--review', String(prA), '--runtime', 'codex', '--json']);
    assert.equal(rv2.code, 0, rv2.stderr + rv2.stdout); assert.equal(rv2.json().outcome, 'approved');
    const again = sb.run('relay-codex-dispatch', ['--review', String(prA), '--runtime', 'codex', '--json']);
    assert.equal(again.json().outcome, 'skipped', 'a verdict for this head already exists');

    // 7. PR B: claude approves; the bot comments twice; the queue refuses until a non-bot replies
    behaviors(sb, ['review:APPROVED']);
    const rvB = sb.run('relay-codex-dispatch', ['--review', String(prB), '--runtime', 'claude', '--json']);
    assert.equal(rvB.code, 0, rvB.stderr + rvB.stdout);
    const ids = [];
    for (let i = 0; i < 2; i++) ids.push(JSON.parse(sb.ghAs('codex-bot[bot]', ['api', '-X', 'POST', `repos/local/sandbox/pulls/${prB}/comments`, '--input', '-'], JSON.stringify({ body: `P1 issue ${i}`, path: 'src/b/x.mjs' }), 'Bot').stdout).id);
    const blocked = sb.run('relay-merge', [`${prB}:${B}`]);
    assert.equal(blocked.stdout.trim(), `#${prB} SKIP (2 unanswered bot comments)`);
    for (const id of ids) sb.ghAs('claude-builder', ['api', '-X', 'POST', `repos/local/sandbox/pulls/${prB}/comments`, '--input', '-'], JSON.stringify({ body: 'Fixed in abc1234: handled', in_reply_to: id }), 'User');

    // 10. gated merge in queue order; issues done; verdict markers exist
    const m = sb.run('relay-merge', [`${prA}:${A}`, `${prB}:${B}`]);
    assert.equal(m.code, 0, m.stdout + m.stderr);
    assert.deepEqual(m.stdout.trim().split('\n'), [`#${prA} MERGED (issue #${A})`, `#${prB} MERGED (issue #${B})`]);
    for (const n of [A, B]) { assert.equal(sb.issue(n).state, 'closed'); assert.ok(labels(sb, n).includes('state:done')); }
    for (const pr of [prA, prB]) assert.ok(sb.comments(pr).some((c) => c.body.includes('relay:verdict')), `verdict marker on #${pr}`);
    assert.deepEqual(sb.db().merged.map((x) => x.pr), [prA, prB]);

    // journal complete for both issues (the queue required it)
    for (const n of [A, B]) assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 0);

    // 11. router/ledger assertions: only T1 used, one row per run, no secrets anywhere
    const rows = ledgerRows(sb);
    assert.ok(rows.filter((r) => r.task_class !== 'merge').every((r) => r.tier === 'T1'), 'no top tier used');
    assert.ok(rows.some((r) => r.task_class === 'routine_review' && r.runtime === 'codex') && rows.some((r) => r.task_class === 'routine_review' && r.runtime === 'claude'));
    const rep = sb.run('relay-report', ['--json']);
    assert.equal(rep.code, 0, rep.stderr);

    // 12. fast mode: merged immediately, exact close note, QA queued
    const C = seedIssue(sb, { title: 'Gamma tweak', body: BODY('src/c/**'), labels: ['state:ready', 'agent:codex'] });
    behaviors(sb, ['implement']);
    const dC = sb.run('relay-codex-dispatch', [String(C), '--runtime', 'codex', '--json']);
    assert.equal(dC.code, 0, dC.stderr);
    sb.run('relay-state', ['set', 'policy.mode', '"fast"', '--reason', 'not production']);
    assert.equal(sb.state().policy.reason, 'not production');
    const q = sb.run('relay-quick-merge', [`${dC.json().pr}:${C}`]);
    assert.equal(q.code, 0, q.stdout + q.stderr); assert.equal(q.stdout.trim(), `#${dC.json().pr} MERGED`);
    assert.ok(sb.comments(C).some((c) => c.body === `Fixed by merged PR #${dC.json().pr}; verification follows on main.`), 'exact close note');
    assert.equal(sb.run('relay-qa', ['list', '--json']).json().length, 1, 'post-merge QA enqueued');

    // no secrets in any file the run produced
    const bad = [];
    for (const f of fs.readdirSync(sb.work, { recursive: true })) {
      const p = path.join(sb.work, f);
      if (f.startsWith('.git/') || !fs.statSync(p).isFile()) continue;
      if (/ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fs.readFileSync(p, 'utf8'))) bad.push(f);
    }
    assert.deepEqual(bad, []);
  } finally { sb.cleanup(); }
});
