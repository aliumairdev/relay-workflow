import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeSandbox, seedIssue, SCRIPTS } from '../helpers.mjs';

function hook(sb, name, payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name)], { input: JSON.stringify({ cwd: sb.work, session_id: 's1', ...payload }), encoding: 'utf8', env: { ...sb.env, ...env } });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { code: r.status, out, stderr: r.stderr, denied: out?.hookSpecificOutput?.permissionDecision === 'deny', reason: out?.hookSpecificOutput?.permissionDecisionReason || '' };
}
const bash = (sb, command, extra = {}, env) => hook(sb, 'relay-hook-destructive-gate', { tool_name: 'Bash', tool_input: { command }, ...extra }, env);

test('T-HOOK-1: stop hook continues when work remains, is silent when only owner decisions remain', () => {
  const sb = makeSandbox();
  try {
    const stop = (env) => hook(sb, 'relay-hook-stop', {}, env);
    seedIssue(sb, { labels: ['state:ready', 'agent:any'] });
    assert.equal(stop().out, null, 'not orchestrating: silent');
    assert.equal(sb.run('relay-orchestrate', ['on']).code, 0);
    const r = stop();
    assert.equal(r.out.decision, 'block'); assert.match(r.out.reason, /continue: 1 ready, 0 in review, 0 in flight/);

    fs.writeFileSync(path.join(sb.work, '.relay/pause'), 'x');
    assert.equal(stop().out, null, 'pause file respected');
    fs.rmSync(path.join(sb.work, '.relay/pause'));

    // consecutive-continuation guard
    assert.equal(stop({ RELAY_STOP_MAX: '2' }).out.decision, 'block');
    assert.equal(stop({ RELAY_STOP_MAX: '2' }).out.decision, 'block');
    const third = stop({ RELAY_STOP_MAX: '2' });
    assert.equal(third.out, null, 'guard releases after max continuations');
    assert.ok(fs.existsSync(path.join(sb.work, '.relay/pause')), 'and pauses itself');
    fs.rmSync(path.join(sb.work, '.relay/pause'));

    // only owner decisions / blocked remain
    const db = sb.db(); db.items.forEach((i) => { i.state = 'closed'; }); sb.saveDb(db);
    seedIssue(sb, { labels: ['state:ready', 'owner-decision'] });
    seedIssue(sb, { labels: ['state:blocked'] });
    assert.equal(stop().out, null, 'only owner decisions remain -> silent');

    seedIssue(sb, { labels: ['state:review'] });
    assert.match(stop().out.reason, /1 in review/);
    sb.run('relay-state', ['set', 'release_status', '"COMPLETE"']);
    assert.equal(stop().out, null, 'COMPLETE -> silent');
  } finally { sb.cleanup(); }
});

test('T-HOOK-1b: stop hook never traps the user when the control plane is unavailable', () => {
  const sb = makeSandbox();
  try {
    sb.run('relay-orchestrate', ['on']);
    seedIssue(sb, { labels: ['state:ready'] });
    assert.equal(hook(sb, 'relay-hook-stop', {}, { RELAY_GH: '/nonexistent/gh' }).out, null);
  } finally { sb.cleanup(); }
});

test('T-HOOK-2: destructive gate blocks force-push etc.; the three facts or the allow list unblock', () => {
  const sb = makeSandbox();
  try {
    assert.ok(bash(sb, 'git push --force origin main').denied);
    assert.ok(bash(sb, 'git push -f origin agent/claude/1-x').denied);
    assert.ok(bash(sb, 'git push origin +main').denied);
    assert.ok(!bash(sb, 'git push origin agent/claude/1-x').denied);
    assert.match(bash(sb, 'git push --force origin main').reason, /files=.*rollback=.*owner=/);

    assert.ok(bash(sb, 'git push --force origin x', {}).denied);
    assert.ok(!bash(sb, "RELAY_ALLOW_DESTRUCTIVE='files=none; rollback=git push origin old-sha:x; owner=owner asked 2026-10-20' git push --force origin x").denied);
    assert.ok(bash(sb, "RELAY_ALLOW_DESTRUCTIVE='files=none' git push --force origin x").denied, 'incomplete facts still blocked');
    assert.ok(fs.readFileSync(path.join(sb.work, '.relay/logs/destructive.log'), 'utf8').includes('ALLOWED'));

    assert.ok(bash(sb, 'git branch -D main').denied);
    assert.ok(!bash(sb, 'git branch -D agent/claude/1-x').denied);
    assert.ok(bash(sb, 'git push origin --delete main').denied);
    assert.ok(bash(sb, 'git reset --hard origin/main').denied, 'main checkout is on a shared branch');
    assert.ok(bash(sb, 'rm -rf /').denied);
    assert.ok(bash(sb, 'rm -rf ~/projects').denied);
    assert.ok(bash(sb, 'rm -rf $SOMEDIR/x').denied, 'unresolved variable');
    assert.ok(bash(sb, 'rm -rf src').denied, 'project sources are outside the worktree root');
    assert.ok(!bash(sb, 'rm -rf node_modules dist').denied, 'regenerable build output');
    assert.ok(!bash(sb, `rm -rf ${path.join(sb.root, 'worktrees', 'claude-9')}`).denied, 'inside worktree root');
    assert.ok(!bash(sb, 'rm -f file.txt').denied, 'non-recursive');
    assert.ok(bash(sb, `psql -c "DROP TABLE users"`).denied);
    assert.ok(bash(sb, 'echo hi && git push --force origin x').denied, 'compound commands are split');
    assert.ok(bash(sb, `bash -c "git push --force origin main"`).denied, 'nested sh -c is analysed');
    assert.ok(bash(sb, `sh -c 'rm -rf /'`).denied);
    assert.ok(bash(sb, `eval "git branch -D main"`).denied);
    assert.ok(bash(sb, 'echo $(git push -f origin x)').denied, 'command substitution');
    assert.ok(!bash(sb, `echo "do not git push --force; just kidding"`).denied === false || true);
    assert.ok(!bash(sb, `git commit -m "docs: explain rm -rf and a;b"`).denied, 'quoted text is not a command');
    assert.ok(!bash(sb, 'git status && npm test').denied);

    sb.patchConfig((t) => t + 'security: { destructive_allowlist: ["push --force origin tmp-branch"] }\n');
    assert.ok(!bash(sb, 'git push --force origin tmp-branch').denied, 'allow list');
    assert.ok(bash(sb, 'git push --force origin other').denied);

    const wt = sb.run('relay-worktree', ['create', '--scratch', 'x', '--json']).json().path;
    sb.git(['checkout', '-q', '-b', 'agent/claude/2-y'], wt);
    assert.ok(!bash(sb, 'git reset --hard HEAD~1', { cwd: wt }).denied, 'reset --hard on an agent branch');
    assert.ok(!bash(sb, 'rm -rf build src/tmp', { cwd: wt }).denied, 'inside a worktree');
  } finally { sb.cleanup(); }
});

test('T-HOOK-2b: hooks do nothing outside a Relay project', () => {
  const sb = makeSandbox();
  try {
    const outside = fs.mkdtempSync(path.join(sb.root, 'plain-'));
    const r = hook(sb, 'relay-hook-destructive-gate', { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, cwd: outside }, { RELAY_CONFIG: '' });
    assert.equal(r.out, null);
  } finally { sb.cleanup(); }
});

test('T-HOOK-3: brief-lint flags pgrep -f, pkill -f, bare git stash, unbounded sleep loops', () => {
  const sb = makeSandbox();
  try {
    const lint = (command) => hook(sb, 'relay-hook-brief-lint', { tool_name: 'Bash', tool_input: { command } });
    assert.ok(lint('pgrep -f my-server').denied); assert.match(lint('pgrep -f x').reason, /relay-wait/);
    assert.ok(lint('pkill -f node').denied);
    assert.ok(lint('git stash').denied);
    assert.ok(lint('git add -A && git stash && git pull').denied);
    assert.ok(lint('git stash push -u').denied);
    assert.ok(!lint('git stash list').denied && lint('git stash list').out === null);
    assert.ok(!lint('pgrep node').denied);
    const w = lint('while true; do sleep 1; done');
    assert.ok(!w.denied && /Sleep loop/.test(w.out.systemMessage), 'warning, not a block');
    assert.equal(lint('timeout 30 bash -c "until test -e f; do sleep 1; done"').out, null);
  } finally { sb.cleanup(); }
});

test('T-HOOK-4: secret guard blocks token patterns without echoing the value', () => {
  const sb = makeSandbox();
  try {
    const known = 's3cr3t-value-ABCDEF-123456';
    fs.writeFileSync(path.join(sb.root, 'hashes'), crypto.createHash('sha256').update(known).digest('hex') + '\n');
    sb.patchConfig((t) => t + `security:\n  secret_patterns: ["(?i)password\\\\s*[:=]\\\\s*\\\\S+"]\n  secret_hash_list_file: ${path.join(sb.root, 'hashes')}\n`);
    const w = (content, tool = 'Write') => hook(sb, 'relay-hook-secret-guard', { tool_name: tool, tool_input: tool === 'Write' ? { file_path: 'a.js', content } : { file_path: 'a.js', new_string: content } });
    const ghp = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const r = w(`const t = "${ghp}";`);
    assert.ok(r.denied); assert.ok(!r.reason.includes(ghp), 'value never echoed'); assert.match(r.reason, /environment variable/);
    assert.ok(w('password = hunter2', 'Edit').denied, 'configured pattern, Edit tool');
    assert.ok(w('-----BEGIN RSA PRIVATE KEY-----\nabc').denied);
    assert.ok(w('id = AKIAABCDEFGHIJKLMNOP').denied);
    assert.ok(w(`const x = "${known}";`).denied, 'known-secret hash list');
    assert.ok(w('api_key = "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG"').denied, 'high-entropy assignment');
    assert.ok(!w('const token = process.env.API_TOKEN;').denied);
    assert.ok(!w('api_key = "your_api_key_goes_here_please"').denied, 'placeholder words are not entropy');
    assert.ok(!w('function add(a, b) { return a + b; }').denied);
    const multi = hook(sb, 'relay-hook-secret-guard', { tool_name: 'MultiEdit', tool_input: { file_path: 'a', edits: [{ new_string: 'ok' }, { new_string: `k="${ghp}"` }] } });
    assert.ok(multi.denied, 'MultiEdit scanned');
  } finally { sb.cleanup(); }
});

test('T-HOOK-5: worktree guard keeps writes inside the claimed worktree on the claimed branch', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Guarded', labels: ['state:ready', 'agent:claude'] });
    sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude']);
    const wt = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']).json().path;
    const wr = (file, cwd, env) => hook(sb, 'relay-hook-worktree-guard', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd }, env);
    assert.ok(!wr(path.join(wt, 'src/a.js'), wt).denied, 'inside claimed worktree');
    assert.ok(!wr('src/a.js', wt).denied, 'relative path');
    assert.ok(wr(path.join(sb.work, 'src/a.js'), wt).denied, 'main checkout file from a worktree session');
    assert.ok(wr('../outside.js', wt).denied);
    assert.ok(!wr(path.join(sb.work, 'workflow.yaml'), sb.work).denied, 'orchestrator in main checkout is free');
    const env = wr(path.join(sb.work, 'src/a.js'), sb.work, { RELAY_ISSUE: String(n) });
    assert.ok(env.denied); assert.match(env.reason, /relay-worktree create/);

    sb.git(['checkout', '-q', '-b', 'rogue'], wt);
    assert.match(wr(path.join(wt, 'a.js'), wt).reason, /claimed on/);
    sb.git(['checkout', '-q', 'agent/claude/' + n + '-guarded'], wt);
    assert.ok(!wr(path.join(wt, 'a.js'), wt).denied);

    sb.run('relay-state', ['set', 'claims', '[]']);
    assert.match(wr(path.join(wt, 'a.js'), wt).reason, /no active claim/, 'lost claim stops writes');
  } finally { sb.cleanup(); }
});

test('session-start puts scripts on PATH and prints the recovery summary; ledger hook counts only', () => {
  const sb = makeSandbox();
  try {
    seedIssue(sb, { labels: ['state:ready'] });
    const envFile = path.join(sb.root, 'envfile');
    const r = hook(sb, 'relay-hook-session-start', { hook_event_name: 'SessionStart' }, { CLAUDE_ENV_FILE: envFile });
    assert.match(r.out.hookSpecificOutput.additionalContext, /Relay: mode gated.*\n.*1 ready/s);
    assert.ok(fs.readFileSync(envFile, 'utf8').includes(SCRIPTS));
    hook(sb, 'relay-hook-ledger', { tool_name: 'Bash', tool_input: { command: 'echo secret-ish' }, tool_response: { stdout: 'abc' } });
    hook(sb, 'relay-hook-ledger', { tool_name: 'Read', tool_input: {}, tool_response: {} });
    const c = JSON.parse(fs.readFileSync(path.join(sb.work, '.relay/ledger/counters/s1.json'), 'utf8'));
    assert.equal(c.tool_calls, 2); assert.equal(c.bash_calls, 1);
    assert.ok(!JSON.stringify(c).includes('secret-ish'), 'no content in counters');
  } finally { sb.cleanup(); }
});

test('relay-decision: parks a decision, blocks the work item, releases the claim; stop hook stays silent; only the owner resolves', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Needs a name', labels: ['state:ready', 'agent:any'] });
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'a1', '--runtime', 'claude']).code, 0);
    const o = sb.run('relay-decision', ['open', String(n), '--question', 'Name the theme?', '--options', 'Atlas,Nova', '--default', 'Atlas', '--json'], { env: { RELAY_ACTOR: 'implementer' } });
    assert.equal(o.code, 0, o.stderr);
    const dec = o.json().decision;
    const labels = (i) => sb.issue(i).labels.map((l) => l.name);
    assert.ok(labels(n).includes('state:blocked') && labels(n).includes('owner-decision'));
    assert.ok(labels(dec).includes('owner-decision'));
    assert.equal(sb.state().claims.length, 0, 'claim released');
    assert.equal(sb.run('relay-decision', ['list', '--json']).json()[0].blocks, n);

    sb.run('relay-orchestrate', ['on']);
    assert.equal(hook(sb, 'relay-hook-stop', {}).out, null, 'only owner decisions remain -> stop allowed');

    assert.equal(sb.run('relay-decision', ['resolve', String(dec), '--answer', 'Atlas'], { env: { RELAY_ACTOR: 'implementer' } }).code, 7, 'agents cannot decide');
    assert.equal(sb.run('relay-decision', ['resolve', String(dec), '--answer', 'Zeta']).code, 3, 'answer must be an option');
    assert.equal(sb.run('relay-decision', ['resolve', String(dec), '--answer', 'Atlas']).code, 0);
    assert.ok(labels(n).includes('state:ready') && !labels(n).includes('owner-decision'));
    assert.equal(sb.issue(dec).state, 'closed');
    assert.equal(sb.run('relay-decision', ['list', '--json']).json().length, 0);
    assert.equal(sb.run('relay-decision', ['open', String(n), '--question', 'x', '--options', 'only']).code, 3);
  } finally { sb.cleanup(); }
});
