import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeSandbox, seedIssue, SCRIPTS } from '../helpers.mjs';

const labelsOf = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();

test('T-LABEL-1: illegal transitions exit 8; legal ones apply and replace the old state', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { labels: ['state:ready', 'agent:codex'] });
    assert.equal(sb.run('relay-labels', ['set', String(n), 'state:done', '--actor-class', 'implementer']).code, 8);
    assert.equal(sb.run('relay-labels', ['set', String(n), 'state:review', '--actor-class', 'implementer']).code, 8, 'cannot skip claim');
    assert.equal(sb.run('relay-labels', ['set', String(n), 'agent:claude', '--actor-class', 'implementer']).code, 8, 'owner label only via handoff');
    assert.deepEqual(labelsOf(sb, n), ['agent:codex', 'state:ready'], 'denied calls changed nothing');
    const ok = sb.run('relay-labels', ['set', String(n), 'state:claimed', '--actor-class', 'implementer']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(labelsOf(sb, n), ['agent:codex', 'state:claimed']);
    assert.equal(sb.run('relay-labels', ['set', String(n), 'state:claimed', '--actor-class', 'implementer']).code, 0, 'idempotent');
    assert.equal(sb.run('relay-labels', ['set', String(n), 'state:done', '--actor-class', 'merge']).code, 8, 'claimed -> done is not a legal transition');
    assert.equal(sb.run('relay-labels', ['set', String(n), 'state:ready-for-agent', '--actor-class', 'human']).code, 0, 'legacy alias accepted for human');
    assert.ok(labelsOf(sb, n).includes('state:ready'));
    assert.equal(sb.run('relay-labels', ['set', String(n), 'x', '--actor-class', 'robot']).code, 3, 'unknown actor class');
  } finally { sb.cleanup(); }
});

test('T-LABEL-2: two state labels are detected and repaired by lint --fix', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { labels: ['state:ready', 'state:in-progress', 'agent:codex', 'agent:claude'] });
    const bad = sb.run('relay-labels', ['lint', '--json']);
    assert.equal(bad.code, 1);
    assert.equal(bad.json().violations[0].number, n);
    assert.equal(sb.run('relay-labels', ['lint', '--fix']).code, 0);
    const after = labelsOf(sb, n);
    assert.equal(after.filter((l) => l.startsWith('state:')).length, 1);
    assert.equal(after.filter((l) => /^agent:(claude|codex)$/.test(l)).length, 1);
    assert.equal(sb.run('relay-labels', ['lint']).code, 0);
    assert.ok(sb.comments(n).some((c) => c.body.includes('repaired label violations')));
  } finally { sb.cleanup(); }
});

test('T-LOCK-1: live lock respected; stale (old or dead owner) taken over', () => {
  const sb = makeSandbox();
  try {
    const live = String(process.pid);
    assert.equal(sb.run('relay-lock', ['acquire', 'merge', '--pid', live]).code, 0);
    assert.equal(sb.run('relay-lock', ['acquire', 'merge', '--pid', live]).code, 1, 'live lock respected');
    const f = path.join(sb.work, '.relay/locks/merge.lock');
    const old = new Date(Date.now() - 3600e3);
    fs.utimesSync(f, old, old);
    assert.equal(sb.run('relay-lock', ['acquire', 'merge', '--pid', live, '--stale-after', '60']).code, 0, 'stale by age');
    assert.equal(sb.run('relay-lock', ['release', 'merge', '--pid', live]).code, 0);
    assert.ok(!fs.existsSync(f));
    const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
    assert.equal(sb.run('relay-lock', ['acquire', 'merge', '--pid', dead]).code, 0);
    assert.equal(sb.run('relay-lock', ['acquire', 'merge', '--pid', live]).code, 0, 'dead owner is stale immediately');
  } finally { sb.cleanup(); }
});

test('T-WAIT-1: relay-wait waits on a pid without process-table matching; times out with exit 1', async () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'relay-wait'), 'utf8');
  assert.ok(!/pgrep|pkill|ps\s+-/.test(src.replace(/\/\/.*$/gm, '')), 'no process-table matching');
  const sb = makeSandbox();
  try {
    const child = spawn('sleep', ['1']);
    const t0 = Date.now();
    const r = await sb.spawnScript('relay-wait', ['--pid', String(child.pid), '--timeout', '10', '--interval', '0.1']);
    assert.equal(r.code, 0);
    assert.ok(Date.now() - t0 >= 700, 'actually waited for the child');
    assert.equal(sb.run('relay-wait', ['--pid', String(process.pid), '--timeout', '0.5', '--interval', '0.1']).code, 1);
    fs.writeFileSync(path.join(sb.root, 'flag'), '');
    assert.equal(sb.run('relay-wait', ['--file', path.join(sb.root, 'flag'), '--timeout', '2']).code, 0);
    assert.equal(sb.run('relay-wait', ['--cmd', 'test -e ' + path.join(sb.root, 'flag'), '--timeout', '2']).code, 0);
    assert.equal(sb.run('relay-wait', ['--cmd', 'false', '--timeout', '0.3', '--interval', '0.1']).code, 1);
  } finally { sb.cleanup(); }
});

test('T-WT-1: worktree path/branch safety and verify', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Add widget', labels: ['state:ready', 'agent:claude'] });
    // inside the main checkout is refused
    const cfgText = fs.readFileSync(path.join(sb.work, 'workflow.yaml'), 'utf8');
    sb.patchConfig((t) => t.replace(/worktree_root: [^ }]+/, 'worktree_root: ./inside'));
    assert.equal(sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude']).code, 9, 'path inside main checkout refused');
    fs.writeFileSync(path.join(sb.work, 'workflow.yaml'), cfgText);

    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude']).code, 0);
    const c = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']);
    assert.equal(c.code, 0, c.stderr);
    const { path: wt, branch } = c.json();
    assert.match(branch, /^agent\/claude\/\d+-add-widget$/);
    assert.ok(fs.existsSync(path.join(wt, 'package.json')));
    assert.equal(sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude']).code, 0, 'idempotent');
    assert.equal(fs.realpathSync(sb.state().claims[0].worktree), fs.realpathSync(wt), 'worktree recorded on the claim');

    assert.equal(sb.run('relay-worktree', ['verify'], { cwd: wt }).code, 0, 'verify ok in claimed worktree');
    assert.equal(sb.run('relay-worktree', ['verify']).code, 9, 'verify fails in main checkout');
    sb.git(['checkout', '-q', '-b', 'rogue'], wt);
    const bad = sb.run('relay-worktree', ['verify', '--issue', String(n)], { cwd: wt });
    assert.equal(bad.code, 9);
    assert.match(bad.stderr + bad.stdout, /claimed branch/);

    // branch held by another claim's worktree is refused
    const s = sb.state(); s.claims[0].worktree = '/elsewhere/claude-' + n; fs.writeFileSync(path.join(sb.work, 'harness/STATE.json'), JSON.stringify(s));
    sb.git(['checkout', '-q', branch], wt);
    const held = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude']);
    assert.equal(held.code, 9);
    assert.match(held.stderr, /held by another claim/);
  } finally { sb.cleanup(); }
});

test('relay-worktree scratch/remove/prune keep everything outside the main checkout', () => {
  const sb = makeSandbox();
  try {
    const r = sb.run('relay-worktree', ['create', '--scratch', 'rev-1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(r.json().path, 'package.json')));
    assert.equal(sb.run('relay-worktree', ['remove', '--scratch', 'rev-1']).code, 0);
    assert.ok(!fs.existsSync(r.json().path));
  } finally { sb.cleanup(); }
});

test('T-LOCK-1b: concurrent acquirers get mutual exclusion (regression: torn lock file / stat race)', async () => {
  const sb = makeSandbox();
  try {
    for (let round = 0; round < 3; round++) {
      const rs = await Promise.all(Array.from({ length: 12 }, () => sb.spawnScript('relay-lock', ['acquire', `r${round}`, '--pid', String(process.pid)])));
      assert.equal(rs.filter((r) => r.code === 0).length, 1, rs.map((r) => r.code + r.stderr.slice(0, 80)).join(' | '));
      assert.equal(rs.filter((r) => r.code === 1).length, 11);
    }
  } finally { sb.cleanup(); }
});
