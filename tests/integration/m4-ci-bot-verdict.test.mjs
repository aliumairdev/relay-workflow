import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue } from '../helpers.mjs';
import { agentBranch, openPR, verdict } from '../m4-helpers.mjs';

const BOT = 'codex-bot[bot]';
const labels = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();
const useCi = (sb, steps) => sb.patchConfig((t) => t.replace(/^ci:.*\n(?:[ \t]+.*\n?)*/m, '') + `ci:\n  steps:\n${steps.map(([n, c]) => `    - { name: ${n}, cmd: ${JSON.stringify(c)} }`).join('\n')}\n`);

test('T-CI-1: steps reported pass/FAIL, exit codes, log tail on failure, 9 when branch missing', () => {
  const sb = makeSandbox();
  try {
    const branch = agentBranch(sb, { runtime: 'codex', issue: 1, files: { 'a.txt': 'x\n' } });
    useCi(sb, [['ok', 'echo fine'], ['bad', 'echo boom-line; exit 1'], ['after', 'echo still-runs']]);
    const r = sb.run('relay-ci', [branch]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^ {2}ok: pass$/m); assert.match(r.stdout, /^ {2}bad: FAIL$/m); assert.match(r.stdout, /^ {2}after: pass$/m);
    assert.match(r.stdout, new RegExp(`${branch.replace(/[/]/g, '\\/')}: LOCAL CI FAILED \\(log .*ci-.*\\.log\\)`));
    assert.match(r.stdout, /boom-line/, 'log tail shown on failure');
    const log = r.stdout.match(/\(log (.*)\)/)[1];
    assert.ok(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('boom-line'));
    assert.ok(fs.existsSync(path.join(sb.work, '.relay/ci-wt')), 'dedicated worktree under .relay/ci-wt');

    useCi(sb, [['ok', 'echo fine'], ['unit', 'test -f a.txt']]);
    const g = sb.run('relay-ci', [branch, '--json']);
    assert.equal(g.code, 0, g.stdout + g.stderr);
    assert.deepEqual(g.json().steps.map((s) => s.ok), [true, true], 'runs against the branch checkout and reuses the worktree');
    assert.match(sb.run('relay-ci', [branch]).stdout, /LOCAL CI OK/);
    assert.equal(sb.run('relay-ci', ['agent/codex/404-nope']).code, 9);
    // --full adds full_steps
    sb.patchConfig((t) => t + '  full_steps: ["echo e2e-ran"]\n');
    const f = sb.run('relay-ci', [branch, '--full']);
    assert.match(f.stdout, /echo e2e-ran: pass/); assert.doesNotMatch(sb.run('relay-ci', [branch]).stdout, /e2e-ran/);
  } finally { sb.cleanup(); }
});

function inline(sb, pr, body, as = BOT, type = 'Bot', extra = {}) {
  const r = sb.ghAs(as, ['api', '-X', 'POST', `repos/local/sandbox/pulls/${pr}/comments`, '--input', '-'], JSON.stringify({ body, path: 'a.txt', ...extra }), type);
  assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout).id;
}
const count = (sb, pr) => sb.run('relay-bot-gate', [String(pr), '--json']);

test('T-BOT-1: bot comments block; a bot self-reply does not clear; an agent reply clears; non-bot comments ignored', () => {
  const sb = makeSandbox();
  try {
    const branch = agentBranch(sb, { runtime: 'claude', issue: 1, files: { 'a.txt': 'x\n' } });
    const pr = openPR(sb, { branch });
    assert.equal(count(sb, pr).code, 0);
    const c1 = inline(sb, pr, 'P1: null deref'), c2 = inline(sb, pr, 'consider renaming');
    inline(sb, pr, 'looks odd', 'some-human', 'User');
    inline(sb, pr, 'lookalike', 'not-codex-bot[bot]', 'Bot');
    let r = count(sb, pr);
    assert.equal(r.code, 1); assert.equal(r.json().count, 2);
    assert.deepEqual(r.json().comments.map((c) => c.id).sort(), [c1, c2].sort());
    assert.equal(sb.run('relay-bot-gate', [String(pr)]).stdout.trim(), '2');

    inline(sb, pr, 'Fixed in abc', BOT, 'Bot', { in_reply_to: c1 });
    assert.equal(count(sb, pr).json().count, 2, 'reply by the bot itself does not clear');
    inline(sb, pr, 'Fixed in abc123: guarded', 'relay-user', 'User', { in_reply_to: c1 });
    assert.equal(count(sb, pr).json().count, 1, 'reply from the agent clears');
    inline(sb, pr, 'not applicable: intentional', 'relay-user', 'User', { in_reply_to: c2 });
    r = count(sb, pr); assert.equal(r.code, 0); assert.equal(r.json().count, 0);

    // severity filter: P3 is below the blocking threshold ([P0, P1])
    inline(sb, pr, 'P3: nit');
    assert.equal(count(sb, pr).json().count, 0);
    // review-level comment from the bot blocks until a non-bot comments afterwards
    const rv = sb.ghAs(BOT, ['api', '-X', 'POST', `repos/local/sandbox/pulls/${pr}/reviews`, '--input', '-'], JSON.stringify({ body: 'Please add a test', event: 'COMMENTED' }), 'Bot');
    assert.equal(rv.code, 0);
    assert.equal(count(sb, pr).json().count, 1);
    assert.equal(count(sb, pr).json().comments[0].kind, 'review');
    sb.ghAs(BOT, ['api', '-X', 'POST', `repos/local/sandbox/issues/${pr}/comments`, '--input', '-'], JSON.stringify({ body: 'ack' }), 'Bot');
    assert.equal(count(sb, pr).json().count, 1, 'bot comment does not answer itself');
    sb.run('relay-labels', ['set', String(pr), 'type:bug']); // unrelated activity
    sb.gh(['api', '-X', 'POST', `repos/local/sandbox/issues/${pr}/comments`, '--input', '-'], JSON.stringify({ body: 'added the test' }));
    assert.equal(count(sb, pr).json().count, 0);
  } finally { sb.cleanup(); }
});

test('T-BOT-1b: pagination - more than 100 inline comments are all counted', () => {
  const sb = makeSandbox();
  try {
    const branch = agentBranch(sb, { runtime: 'claude', issue: 1, files: { 'a.txt': 'x\n' } });
    const pr = openPR(sb, { branch });
    const db = sb.db();
    for (let i = 0; i < 130; i++) db.prComments.push({ id: 9000 + i, pr, body: `P1 issue ${i}`, in_reply_to_id: null, user: { login: BOT, type: 'Bot' }, created_at: '2026-10-20T10:00:00Z', path: 'a.txt' });
    sb.saveDb(db);
    assert.equal(count(sb, pr).json().count, 130);
  } finally { sb.cleanup(); }
});

test('T-XREV-1: verdict by the implementer runtime is rejected (exit 7) when cross-review is on', () => {
  const sb = makeSandbox();
  try {
    const issue = seedIssue(sb, { labels: ['state:review', 'agent:claude'] });
    const branch = agentBranch(sb, { runtime: 'claude', issue, files: { 'a.txt': 'x\n' } });
    const pr = openPR(sb, { branch, issue });
    const own = verdict(sb, pr, 'APPROVED', 'claude');
    assert.equal(own.code, 7, own.stderr); assert.match(own.stderr, /cross-runtime/);
    assert.equal(sb.comments(pr).filter((c) => c.body.includes('relay:verdict')).length, 0, 'nothing posted');
    assert.ok(!labels(sb, pr).includes('review:approved'));

    const bad = sb.run('relay-verdict', ['post', String(pr), '--result', 'CHANGES', '--checklist', '{}', '--runtime', 'codex']);
    assert.equal(bad.code, 3, 'CHANGES needs a numbered list');
    const ch = verdict(sb, pr, 'CHANGES', 'codex');
    assert.equal(ch.code, 0, ch.stderr);
    assert.ok(labels(sb, pr).includes('review:changes'));
    assert.ok(labels(sb, issue).includes('state:changes-requested') && !labels(sb, issue).includes('state:review'));
    const ok = verdict(sb, pr, 'APPROVED', 'codex');
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(labels(sb, pr).includes('review:approved') && !labels(sb, pr).includes('review:changes'));
    const body = sb.comments(pr).filter((c) => c.body.includes('relay:verdict')).at(-1).body;
    assert.match(body, /MAIN REVIEW\nResult: APPROVED\nAcceptance: PASS/);
    const rec = JSON.parse(/relay:verdict (\{.*?\}) -->/s.exec(body)[1]);
    assert.equal(rec.implementer_runtime, 'claude'); assert.equal(rec.reviewer.runtime, 'codex'); assert.equal(rec.head_sha.length, 40);

    // single-runtime / cross-review off: allowed
    sb.patchConfig((t) => t.replace(/^review:.*$/m, 'review: { cross_runtime: false }'));
    assert.equal(verdict(sb, pr, 'APPROVED', 'claude').code, 0);
  } finally { sb.cleanup(); }
});
