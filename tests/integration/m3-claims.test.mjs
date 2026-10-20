import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue } from '../helpers.mjs';

const names = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();
const claimsOn = (sb, n) => sb.comments(n).filter((c) => c.body.includes('relay:claim '));

test('T-CLAIM-1: 10 parallel claimers -> exactly one claim and one state:claimed', async () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'race', labels: ['state:ready', 'agent:any'] });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => sb.spawnScript('relay-claim', [String(n), '--agent', `a${i}`, '--runtime', i % 2 ? 'codex' : 'claude', '--json'])));
    const won = results.filter((r) => r.code === 0), lost = results.filter((r) => r.code === 7);
    assert.equal(won.length, 1, results.map((r) => r.code + ':' + r.stderr.trim().slice(0, 80)).join(' | '));
    assert.equal(lost.length, 9);
    assert.deepEqual(names(sb, n).filter((l) => l.startsWith('state:')), ['state:claimed']);
    assert.equal(claimsOn(sb, n).length, 1, 'losers removed their comments');
    assert.equal(sb.state().claims.length, 1);
    assert.equal(sb.state().claims[0].agent_id, won[0].json().agent_id);
  } finally { sb.cleanup(); }
});

test('T-CLAIM-2: claim refused when the owner label is for the other runtime', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { labels: ['state:ready', 'agent:codex'] });
    const r = sb.run('relay-claim', [String(n), '--agent', 'cl-1', '--runtime', 'claude']);
    assert.equal(r.code, 7); assert.match(r.stderr, /owner label/);
    assert.equal(claimsOn(sb, n).length, 0, 'refusal posts nothing');
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'cx-1', '--runtime', 'codex']).code, 0);
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'cx-2', '--runtime', 'codex']).code, 7, 'second claim on a live claim');
    const closed = seedIssue(sb, { labels: ['state:backlog'] });
    assert.equal(sb.run('relay-claim', [String(closed), '--agent', 'x', '--runtime', 'codex']).code, 7, 'backlog is not claimable');
  } finally { sb.cleanup(); }
});

test('T-CLAIM-3: expired lease swept, takeover continues the branch, late heartbeat fails', () => {
  const sb = makeSandbox({ now: '2026-10-20T10:00:00Z' });
  try {
    const n = seedIssue(sb, { title: 'Dies midway', labels: ['state:ready', 'agent:any'] });
    const a = sb.run('relay-claim', [String(n), '--agent', 'claude-dead', '--runtime', 'claude', '--lease-min', '2', '--json']);
    assert.equal(a.code, 0, a.stderr);
    const branch = a.json().branch;
    assert.equal(sb.run('relay-lease', ['heartbeat', String(n), '--agent', 'claude-dead']).code, 0, 'heartbeat while live');
    // a still-live claim cannot be swept or taken over
    assert.equal(sb.run('relay-lease', ['sweep', '--json']).json().expired.length, 0, 'live claims are not swept');
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'codex-2', '--runtime', 'codex']).code, 7);

    const later = { env: { RELAY_NOW: '2026-10-20T10:30:00Z' } };
    const sw = sb.run('relay-lease', ['sweep', '--json'], later);
    assert.equal(sw.code, 0, sw.stderr);
    assert.equal(sw.json().expired.length, 1);
    assert.ok(names(sb, n).includes('state:ready') && !names(sb, n).includes('state:claimed'));
    assert.ok(sb.comments(n).some((c) => c.body.includes('relay:lease-expired')));
    assert.equal(sb.state().claims.length, 0);
    assert.equal(sb.run('relay-lease', ['sweep'], later).stdout.trim(), 'no expired leases', 'sweep is idempotent');

    const b = sb.run('relay-claim', [String(n), '--agent', 'codex-2', '--runtime', 'codex', '--json'], later);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(b.json().branch, branch, 'takeover continues the previous branch name');
    const hb = sb.run('relay-lease', ['heartbeat', String(n), '--agent', 'claude-dead'], later);
    assert.equal(hb.code, 7); assert.match(hb.stderr, /claim lost/);
    assert.equal(sb.run('relay-lease', ['heartbeat', String(n), '--agent', 'codex-2'], later).code, 0);
  } finally { sb.cleanup(); }
});

test('T-CLAIM-3b: an expired but unswept claim can be taken over directly', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { labels: ['state:ready', 'agent:any'] });
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'a', '--runtime', 'claude', '--lease-min', '1']).code, 0);
    const later = { env: { RELAY_NOW: '2026-10-20T11:00:00Z' } };
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'b', '--runtime', 'codex'], later).code, 0);
    assert.equal(sb.run('relay-lease', ['heartbeat', String(n), '--agent', 'a'], later).code, 7);
    assert.equal(sb.state().claims.length, 1);
    assert.equal(sb.state().claims[0].agent_id, 'b');
  } finally { sb.cleanup(); }
});

test('T-OWN-1: overlapping owned paths refused; append-only shared path allowed', () => {
  const sb = makeSandbox();
  try {
    sb.patchConfig((t) => t + 'shared_append_only: ["locales/*.json"]\n');
    const [a, b] = [seedIssue(sb, { labels: ['state:ready', 'agent:any'] }), seedIssue(sb, { labels: ['state:ready', 'agent:any'] })];
    assert.equal(sb.run('relay-claim', [String(a), '--agent', 'x', '--runtime', 'claude', '--owned', 'src/a/**,locales/en.json']).code, 0);
    const clash = sb.run('relay-claim', [String(b), '--agent', 'y', '--runtime', 'codex', '--owned', 'src/a/x.js']);
    assert.equal(clash.code, 7); assert.match(clash.stderr, /overlap/);
    assert.ok(names(sb, b).includes('state:ready'), 'refused claim leaves the issue ready');
    assert.equal(sb.run('relay-claim', [String(b), '--agent', 'y', '--runtime', 'codex', '--owned', 'src/b/**,locales/en.json']).code, 0, 'shared append-only path is not a conflict');
  } finally { sb.cleanup(); }
});

test('T-HAND-1: handoff Claude -> Codex -> Claude with ack, same branch, preserved chain', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Pill radius', labels: ['state:ready', 'agent:claude'] });
    const c1 = sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude', '--json']);
    assert.equal(c1.code, 0, c1.stderr);
    const branch = c1.json().branch;
    const wt = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']).json().path;
    fs.writeFileSync(path.join(wt, 'src/partial.mjs'), 'export const x = 1;\n');
    sb.git(['add', '-A'], wt); sb.git(['commit', '-qm', 'feat: partial work'], wt);
    const file = path.join(sb.root, 'h1.json');
    fs.writeFileSync(file, JSON.stringify({ done: ['scaffold'], remaining: ['tests'], decisions: ['keep x as const'], next_steps: ['add test'], risks: [], not_verified: ['visual check'], tests_run: [{ cmd: 'npm test', result: 'pass', evidence: '1 pass' }] }));
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
    const dirtyTry = sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'capability'], { cwd: wt });
    assert.equal(dirtyTry.code, 9, 'uncommitted work blocks the handoff'); assert.match(dirtyTry.stderr, /uncommitted/);
    fs.rmSync(path.join(wt, 'dirty.txt'));
    const bad = sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'whatever', '--from-file', file], { cwd: wt });
    assert.equal(bad.code, 3, 'invalid reason enum');
    const h = sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'capability', '--from-file', file, '--json'], { cwd: wt });
    assert.equal(h.code, 0, h.stderr);
    const sha = h.json().sha;
    const l = names(sb, n);
    assert.ok(l.includes('handoff:to-codex') && l.includes('agent:codex') && !l.includes('agent:claude') && l.includes('state:ready'), l.join());
    const rec = sb.run('relay-handoff', ['read', String(n)]).json();
    assert.equal(rec.sha, sha);
    for (const k of ['done', 'remaining', 'files_touched', 'tests_run', 'not_verified', 'decisions', 'next_steps', 'risks', 'links']) assert.ok(k in rec, k);
    assert.ok(rec.files_touched.includes('src/partial.mjs'));
    assert.equal(rec.links.branch, branch);
    assert.equal(sb.state().claims.length, 0, 'sender claim released');
    assert.equal(sb.git(['ls-remote', '--heads', 'origin', branch]).stdout.includes(branch), true, 'branch pushed for the receiver');
    assert.ok(!fs.existsSync(wt), 'sender worktree retired so the receiver can use the branch');

    const noAck = sb.run('relay-claim', [String(n), '--agent', 'codex-1', '--runtime', 'codex']);
    assert.equal(noAck.code, 7); assert.match(noAck.stderr, new RegExp(`--ack-handoff ${sha}`), 'script echoes the handoff sha');
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'codex-1', '--runtime', 'codex', '--ack-handoff', 'deadbeef']).code, 7);
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'claude-9', '--runtime', 'claude', '--ack-handoff', sha]).code, 7, 'handoff addressed to codex only');
    const c2 = sb.run('relay-claim', [String(n), '--agent', 'codex-1', '--runtime', 'codex', '--ack-handoff', sha, '--json']);
    assert.equal(c2.code, 0, c2.stderr);
    assert.equal(c2.json().branch, branch, 'receiver continues the same branch');
    assert.ok(!names(sb, n).some((x) => x.startsWith('handoff:')), 'handoff label removed on claim');
    const wt2 = sb.run('relay-worktree', ['create', String(n), '--runtime', 'codex', '--json']);
    assert.equal(wt2.code, 0, wt2.stderr);
    assert.ok(fs.existsSync(path.join(wt2.json().path, 'src/partial.mjs')), 'receiver sees the sender work');

    // back again: chain preserved
    fs.writeFileSync(path.join(sb.root, 'h2.json'), JSON.stringify({ done: ['tests'], remaining: ['review'], next_steps: ['open PR'] }));
    const h2 = sb.run('relay-handoff', ['post', String(n), '--to', 'claude', '--reason', 'review_rework', '--from-file', path.join(sb.root, 'h2.json'), '--json'], { cwd: wt2.json().path });
    assert.equal(h2.code, 0, h2.stderr);
    assert.equal(h2.json().handoff.previous, sha, 'chain links the previous handoff');
    assert.equal(sb.run('relay-handoff', ['read', String(n), '--all']).json().length, 2);
  } finally { sb.cleanup(); }
});

test('relay-state rebuild reconstructs claims from GitHub', async () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { labels: ['state:ready', 'agent:any'] });
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'a', '--runtime', 'claude', '--owned', 'src/**']).code, 0);
    fs.rmSync(path.join(sb.work, 'harness'), { recursive: true });
    assert.equal(sb.run('relay-state', ['claims', '--json']).json().length, 0);
    assert.equal(sb.run('relay-state', ['rebuild']).code, 0);
    const c = sb.run('relay-state', ['claims', '--json']).json();
    assert.equal(c.length, 1); assert.deepEqual(c[0].owned_paths, ['src/**']);
  } finally { sb.cleanup(); }
});
