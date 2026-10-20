import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue } from '../helpers.mjs';

const logComments = (sb, n) => sb.comments(n).filter((c) => c.body.includes('relay:journal-log'));

test('T-JOURNAL-1: one living log comment; claim/handoff entries are automatic; check gates required kinds', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Journal me', labels: ['state:ready', 'agent:claude'] });
    assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 3, 'empty journal is incomplete');
    assert.equal(sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude']).code, 0);
    assert.equal(logComments(sb, n).length, 1, 'claim created the living comment');

    const post = (kind, text, extra = []) => sb.run('relay-journal', ['post', String(n), '--kind', kind, '--text', text, ...extra]);
    assert.equal(post('plan', 'Add widget in src/widget.mjs; run npm test').code, 0);
    assert.equal(post('test', 'npm test → 1 pass').code, 0);
    assert.equal(logComments(sb, n).length, 1, 'still a single comment, edited in place');
    assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 3, 'summary still missing');
    assert.match(sb.run('relay-journal', ['check', String(n)]).stderr + sb.run('relay-journal', ['check', String(n), '--json']).stdout, /summary/);
    assert.equal(post('summary', 'Widget added. NOT_VERIFIED: visual check').code, 0);
    assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 0);
    assert.equal(sb.run('relay-journal', ['check', String(n), '--require', 'plan,decision']).code, 3);

    const log = sb.run('relay-journal', ['read', String(n), '--json']).json();
    assert.deepEqual(log.entries.map((e) => e.kind), ['claimed', 'plan', 'test', 'summary']);
    assert.deepEqual(log.entries.map((e) => e.n), [1, 2, 3, 4]);
    assert.equal(log.entries[1].agent_id, 'claude-1', 'agent identity taken from the active claim');
    assert.match(logComments(sb, n)[0].body, /\| 2 \|.*plan/, 'human-readable table rendered');
  } finally { sb.cleanup(); }
});

test('T-JOURNAL-2: handoff and lease expiry append entries; chain survives takeover', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Hand me', labels: ['state:ready', 'agent:claude'] });
    sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude', '--lease-min', '2']);
    const wt = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']).json().path;
    fs.writeFileSync(path.join(wt, 'a.txt'), 'x'); sb.git(['add', '-A'], wt); sb.git(['commit', '-qm', 'wip'], wt);
    const f = path.join(sb.root, 'h.json'); fs.writeFileSync(f, JSON.stringify({ done: ['scaffold'], remaining: ['tests'] }));
    assert.equal(sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'capability', '--from-file', f], { cwd: wt }).code, 0);
    let kinds = sb.run('relay-journal', ['read', String(n), '--json']).json().entries.map((e) => e.kind);
    assert.deepEqual(kinds, ['claimed', 'handoff']);

    const sha = sb.run('relay-handoff', ['read', String(n)]).json().sha;
    sb.run('relay-claim', [String(n), '--agent', 'codex-1', '--runtime', 'codex', '--ack-handoff', sha, '--lease-min', '1']);
    const later = { env: { RELAY_NOW: '2026-10-20T12:00:00Z' } };
    assert.equal(sb.run('relay-lease', ['sweep'], later).code, 0);
    kinds = sb.run('relay-journal', ['read', String(n), '--json'], later).json().entries.map((e) => e.kind);
    assert.deepEqual(kinds, ['claimed', 'handoff', 'claimed', 'lease']);
    assert.equal(logComments(sb, n).length, 1);
  } finally { sb.cleanup(); }
});

test('T-JOURNAL-3: validation — bad kind, empty or oversized text rejected with exit 3', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { labels: ['state:ready'] });
    assert.equal(sb.run('relay-journal', ['post', String(n), '--kind', 'gossip', '--text', 'x']).code, 3);
    assert.equal(sb.run('relay-journal', ['post', String(n), '--kind', 'progress', '--text', '   ']).code, 3);
    const big = sb.run('relay-journal', ['post', String(n), '--kind', 'progress', '--text', 'y'.repeat(1300)]);
    assert.equal(big.code, 3); assert.match(big.stderr, /too long/);
    assert.equal(sb.run('relay-journal', ['post', String(n), '--kind', 'progress', '--text', 'a | b\nsecond line']).code, 0, 'pipes and newlines are escaped in the table');
  } finally { sb.cleanup(); }
});
