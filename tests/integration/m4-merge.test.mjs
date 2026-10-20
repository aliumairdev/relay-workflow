import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue } from '../helpers.mjs';
import { agentBranch, stackBranch, openPR, verdict, pushMain, commitFiles, showMain } from '../m4-helpers.mjs';

const labels = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();
const remoteSha = (sb, b) => sb.git(['ls-remote', 'origin', `refs/heads/${b}`]).stdout.split('\t')[0];
const other = (rt) => (rt === 'claude' ? 'codex' : 'claude');

// issue (state:review) + branch + PR + approving verdict by the other runtime
function readyPR(sb, { runtime = 'codex', files = { 'src/feature.mjs': 'export const f = 1;\n' }, approve = true, slug = 'x' } = {}) {
  const issue = seedIssue(sb, { title: 'feature', labels: ['state:review', `agent:${runtime}`] });
  const branch = agentBranch(sb, { runtime, issue, files, slug });
  const pr = openPR(sb, { branch, issue, title: `feat: ${slug}` });
  if (approve) assert.equal(verdict(sb, pr, 'APPROVED', other(runtime)).code, 0);
  return { issue, branch, pr };
}

test('T-MERGE-1: gated - behind main -> sync -> CI -> bot gate -> squash -> issue closed state:done', () => {
  const sb = makeSandbox();
  try {
    const { issue, branch, pr } = readyPR(sb);
    pushMain(sb, { 'docs/NOTES.md': 'main moved\n' });
    const before = remoteSha(sb, branch);
    const r = sb.run('relay-merge', [`${pr}:${issue}`]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), `#${pr} MERGED (issue #${issue})`);
    assert.match(r.stderr, /synced with main/); assert.match(r.stderr, /LOCAL CI OK/);
    assert.notEqual(remoteSha(sb, branch), before, 'branch was synced with main before merging');
    assert.equal(showMain(sb, 'src/feature.mjs'), 'export const f = 1;\n');
    assert.equal(showMain(sb, 'docs/NOTES.md'), 'main moved\n');
    const i = sb.issue(issue);
    assert.equal(i.state, 'closed');
    assert.deepEqual(labels(sb, issue), ['agent:codex', 'state:done']);
    assert.equal(sb.db().items.find((x) => x.number === pr).pull_request.merged, true);
    assert.ok(labels(sb, pr).includes('review:approved'));
    assert.ok(!fs.existsSync(path.join(sb.work, '.relay/locks/merge.lock')), 'queue lock released');
    const row = JSON.parse(fs.readFileSync(path.join(sb.work, '.relay/ledger/usage.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(row.pr, pr); assert.equal(row.outcome, 'done');
    // already-merged PRs are skipped without error
    const again = sb.run('relay-merge', [`${pr}:${issue}`]);
    assert.equal(again.code, 0); assert.match(again.stdout, /already merged/);
  } finally { sb.cleanup(); }
});

test('T-MERGE-1b: each gate refuses with its exact reason and leaves the issue alone', () => {
  const sb = makeSandbox();
  try {
    // local CI failure
    const a = readyPR(sb, { slug: 'broken', files: { 'index.test.mjs': 'import test from "node:test";\ntest("x", () => { throw new Error("nope"); });\n' } });
    const ra = sb.run('relay-merge', [`${a.pr}:${a.issue}`]);
    assert.equal(ra.code, 1); assert.equal(ra.stdout.trim(), `#${a.pr} SKIP (local CI failed)`);
    assert.deepEqual(labels(sb, a.issue), ['agent:codex', 'state:review']);
    // unanswered bot comments
    const b = readyPR(sb, { slug: 'botty', files: { 'b.txt': 'b\n' } });
    for (let i = 0; i < 2; i++) sb.ghAs('codex-bot[bot]', ['api', '-X', 'POST', `repos/local/sandbox/pulls/${b.pr}/comments`, '--input', '-'], JSON.stringify({ body: `P1 problem ${i}`, path: 'b.txt' }), 'Bot');
    const rb = sb.run('relay-merge', [`${b.pr}:${b.issue}`]);
    assert.equal(rb.stdout.trim(), `#${b.pr} SKIP (2 unanswered bot comments)`); assert.equal(rb.code, 1);
    // sync failure (unresolvable conflict in a code file)
    const c = readyPR(sb, { slug: 'clash', files: { 'src/index.mjs': 'export const add = (a, b) => b + a;\n' } });
    pushMain(sb, { 'src/index.mjs': 'export const add = (a, b) => a + b + 0;\n' });
    const rc = sb.run('relay-merge', [`${c.pr}:${c.issue}`]);
    assert.equal(rc.stdout.trim(), `#${c.pr} SKIP (sync failed)`);
    assert.ok(!sb.db().merged.length, 'nothing merged');
    // a failing PR does not stop the next pair
    const d = readyPR(sb, { slug: 'fine', files: { 'd.txt': 'd\n' } });
    const multi = sb.run('relay-merge', [`${a.pr}:${a.issue}`, `${d.pr}:${d.issue}`]);
    assert.deepEqual(multi.stdout.trim().split('\n'), [`#${a.pr} SKIP (sync failed)`, `#${d.pr} MERGED (issue #${d.issue})`]);
    assert.equal(multi.code, 1);
  } finally { sb.cleanup(); }
});

test('T-MERGE-2: fast - merge first; conflict -> sync with resolvers -> retry; exact close note; QA enqueued', () => {
  const sb = makeSandbox();
  try {
    sb.git(['checkout', '-q', 'main']);
    const issue = seedIssue(sb, { title: 'spec tweak', labels: ['state:review', 'agent:claude'] });
    const branch = agentBranch(sb, { runtime: 'claude', issue, files: { 'docs/PRODUCT_SPEC.md': '# Product spec\n\nA tiny app that adds numbers fast.\n' } });
    const pr = openPR(sb, { branch, issue, title: 'docs: spec' });
    pushMain(sb, { 'docs/PRODUCT_SPEC.md': '# Product spec\n\nA tiny app that adds numbers safely.\n' });
    const before = remoteSha(sb, branch);
    const r = sb.run('relay-quick-merge', [`${pr}:${issue}`]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), `#${pr} MERGED`);
    assert.notEqual(remoteSha(sb, branch), before, 'conflict was resolved on the branch');
    const spec = showMain(sb, 'docs/PRODUCT_SPEC.md');
    assert.ok(spec.includes('numbers fast.') && spec.includes('numbers safely.'), spec);
    const note = `Fixed by merged PR #${pr}; verification follows on main.`;
    assert.ok(sb.comments(issue).some((c) => c.body === note), 'exact close note');
    assert.equal(sb.issue(issue).state, 'closed');
    const q = JSON.parse(fs.readFileSync(path.join(sb.work, `.relay/qa-queue/${pr}.json`), 'utf8'));
    assert.equal(q.pr, pr);

    // no conflict: merged immediately, branch untouched; issue 0 means no issue
    const b2 = agentBranch(sb, { runtime: 'codex', issue: 99, slug: 'plain', files: { 'p.txt': 'p\n' } });
    const pr2 = openPR(sb, { branch: b2 });
    const sha2 = remoteSha(sb, b2);
    const r2 = sb.run('relay-quick-merge', [`${pr2}:0`]);
    assert.equal(r2.stdout.trim(), `#${pr2} MERGED`); assert.equal(remoteSha(sb, b2), sha2);
    assert.equal(showMain(sb, 'p.txt'), 'p\n');

    // unresolvable conflict: NOT MERGED, exit 1, branch untouched
    const b3 = agentBranch(sb, { runtime: 'codex', issue: 98, slug: 'clash', files: { 'src/index.mjs': 'export const add = () => 0;\n' } });
    const pr3 = openPR(sb, { branch: b3 });
    pushMain(sb, { 'src/index.mjs': 'export const add = () => 1;\n' });
    const sha3 = remoteSha(sb, b3);
    const r3 = sb.run('relay-quick-merge', [`${pr3}:0`]);
    assert.equal(r3.stdout.trim(), `#${pr3} NOT MERGED`); assert.equal(r3.code, 1); assert.equal(remoteSha(sb, b3), sha3);
  } finally { sb.cleanup(); }
});

test('T-MERGE-2b: configured close note and post_merge_qa: off', () => {
  const sb = makeSandbox();
  try {
    const issue = seedIssue(sb, { labels: ['state:review'] });
    const branch = agentBranch(sb, { runtime: 'codex', issue, files: { 'q.txt': 'q\n' } });
    const pr = openPR(sb, { branch, issue });
    sb.patchConfig((t) => t.replace(/^policy:.*$/m, 'policy: { mode: fast, fast_merge: { close_note: "Shipped in #{pr}.", post_merge_qa: off } }'));
    const r = sb.run('relay-merge', [`${pr}:${issue}`]); // mode comes from policy.mode: fast
    assert.equal(r.stdout.trim(), `#${pr} MERGED`);
    assert.ok(sb.comments(issue).some((c) => c.body === `Shipped in #${pr}.`));
    assert.ok(!fs.existsSync(path.join(sb.work, `.relay/qa-queue/${pr}.json`)));
  } finally { sb.cleanup(); }
});

test('T-MERGE-3: gated merge is refused without an APPROVED verdict for the head sha', () => {
  const sb = makeSandbox();
  try {
    const { issue, branch, pr } = readyPR(sb, { approve: false });
    const none = sb.run('relay-merge', [`${pr}:${issue}`]);
    assert.equal(none.stdout.trim(), `#${pr} SKIP (no verdict for head sha)`); assert.equal(none.code, 1);
    // CHANGES is not an approval
    assert.equal(verdict(sb, pr, 'CHANGES', 'claude').code, 0);
    assert.match(sb.run('relay-merge', [`${pr}:${issue}`]).stdout, /no verdict for head sha/);
    // approve, then new work lands on the branch: the old verdict no longer covers the head
    assert.equal(verdict(sb, pr, 'APPROVED', 'claude').code, 0);
    sb.git(['fetch', '-q', 'origin']); sb.git(['checkout', '-q', branch]); commitFiles(sb, { 'late.txt': 'sneaky\n' }, 'feat: late change');
    sb.git(['push', '-q', 'origin', branch]); sb.git(['checkout', '-q', 'main']);
    const late = sb.run('relay-merge', [`${pr}:${issue}`]);
    assert.match(late.stdout, /no verdict for head sha/);
    assert.ok(!sb.db().merged.length);
    // re-review of the new head unlocks the merge
    assert.equal(verdict(sb, pr, 'APPROVED', 'claude').code, 0);
    assert.match(sb.run('relay-merge', [`${pr}:${issue}`]).stdout, /MERGED/);
    assert.equal(showMain(sb, 'late.txt'), 'sneaky\n');
  } finally { sb.cleanup(); }
});

test('T-STACK-1: three stacked PRs merge in order; squash-induced conflicts resolved; a real conflict aborts', () => {
  const sb = makeSandbox();
  try {
    const iss = [1, 2, 3].map((n) => seedIssue(sb, { title: `part ${n}`, labels: ['state:review', 'agent:codex'] }));
    const b1 = agentBranch(sb, { runtime: 'codex', issue: iss[0], slug: 'p1', files: { 'a.txt': '1\n' } });
    const b2 = stackBranch(sb, { branch: `agent/codex/${iss[1]}-p2`, parent: b1, files: { 'a.txt': '1\n2\n', 'b.txt': 'b\n' } });
    const b3 = stackBranch(sb, { branch: `agent/codex/${iss[2]}-p3`, parent: b2, files: { 'a.txt': '1\n2\n3\n', 'c.txt': 'c\n' } });
    const prs = [openPR(sb, { branch: b1, issue: iss[0] }), openPR(sb, { branch: b2, base: b1, issue: iss[1] }), openPR(sb, { branch: b3, base: b2, issue: iss[2] })];
    for (const pr of prs) assert.equal(verdict(sb, pr, 'APPROVED', 'claude').code, 0);
    const r = sb.run('relay-merge-stack', prs.map((p, i) => `${p}:${iss[i]}`));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), prs.map((p, i) => `#${p} MERGED (issue #${iss[i]})`));
    assert.deepEqual(sb.db().merged.map((m) => m.pr), prs, 'merged in order');
    assert.equal(showMain(sb, 'a.txt'), '1\n2\n3\n'); assert.equal(showMain(sb, 'b.txt'), 'b\n'); assert.equal(showMain(sb, 'c.txt'), 'c\n');
    for (const i of iss) assert.equal(sb.issue(i).state, 'closed');
    for (const pr of prs.slice(1)) assert.equal(sb.db().items.find((x) => x.number === pr).pull_request.base.ref, 'main', 'children retargeted');
  } finally { sb.cleanup(); }
});

test('T-STACK-1b: a real conflict stops the stack at that child', () => {
  const sb = makeSandbox();
  try {
    const iss = [1, 2].map((n) => seedIssue(sb, { labels: ['state:review', 'agent:codex'] }));
    const b1 = agentBranch(sb, { runtime: 'codex', issue: iss[0], slug: 'p1', files: { 'a.txt': '1\n' } });
    const b2 = stackBranch(sb, { branch: `agent/codex/${iss[1]}-p2`, parent: b1, files: { 'shared.txt': 'child\n' } });
    const prs = [openPR(sb, { branch: b1, issue: iss[0] }), openPR(sb, { branch: b2, base: b1, issue: iss[1] })];
    for (const pr of prs) verdict(sb, pr, 'APPROVED', 'claude');
    pushMain(sb, { 'shared.txt': 'main\n' });
    const r = sb.run('relay-merge-stack', prs.map((p, i) => `${p}:${iss[i]}`));
    assert.equal(r.code, 1);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], `#${prs[0]} MERGED (issue #${iss[0]})`);
    assert.ok(lines.includes('  real conflict: shared.txt'));
    assert.equal(lines.at(-1), `#${prs[1]} STACK SYNC FAILED`);
    assert.equal(sb.db().merged.length, 1);
    assert.equal(showMain(sb, 'shared.txt'), 'main\n');
  } finally { sb.cleanup(); }
});

test('merge queue lock: a live holder makes relay-merge wait; a stale lock is taken over', () => {
  const sb = makeSandbox();
  try {
    const { issue, pr } = readyPR(sb, { files: { 'l.txt': 'l\n' } });
    const lock = path.join(sb.work, '.relay/locks/merge.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const busy = sb.run('relay-merge', [`${pr}:${issue}`], { env: { RELAY_LOCK_WAIT_S: '1' } });
    assert.equal(busy.code, 10, busy.stderr);
    const old = new Date(Date.now() - 3600e3); fs.utimesSync(lock, old, old);
    assert.equal(sb.run('relay-merge', [`${pr}:${issue}`]).code, 0, 'stale lock (age) taken over');
  } finally { sb.cleanup(); }
});
