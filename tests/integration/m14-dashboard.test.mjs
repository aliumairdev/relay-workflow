import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeSandbox, seedIssue, SCRIPTS, REPO } from '../helpers.mjs';

function setup(sb) {
  const a = seedIssue(sb, { title: 'Working issue <b>x</b>', labels: ['state:ready', 'agent:any'] });
  const b = seedIssue(sb, { title: 'Stale issue', labels: ['state:ready', 'agent:any'] });
  seedIssue(sb, { title: 'Waiting in the queue', labels: ['state:ready', 'agent:codex'] });
  assert.equal(sb.run('relay-claim', [String(a), '--agent', 'claude-live', '--runtime', 'claude', '--lease-min', '30']).code, 0);
  assert.equal(sb.run('relay-claim', [String(b), '--agent', 'codex-old', '--runtime', 'codex', '--lease-min', '1']).code, 0);
  sb.run('relay-journal', ['post', String(a), '--kind', 'progress', '--text', 'wiring the widget', '--agent', 'claude-live']);
  // a reviewer currently running + a rate-limited run + an agent seen earlier now idle
  fs.mkdirSync(path.join(sb.work, '.relay/ledger'), { recursive: true });
  fs.writeFileSync(path.join(sb.work, '.relay/ledger/usage.jsonl'), JSON.stringify({ ts: '2026-10-20T09:30:00Z', run_id: 'r-old', agent_id: 'claude-done', runtime: 'claude', tier: 'T1', task_class: 'implement', issue: 99, outcome: 'done', pr: 7 }) + '\n');
  fs.writeFileSync(path.join(sb.work, '.relay/governor.json'), JSON.stringify({ running: { 'r-rev': { run_id: 'r-rev', agent_id: 'codex-rev', runtime: 'codex', task_class: 'routine_review', pr: 12, started_at: '2026-10-20T09:59:00Z' }, 'r-rl': { run_id: 'r-rl', agent_id: 'claude-throttled', runtime: 'claude', task_class: 'implement', issue: 5, started_at: '2026-10-20T09:58:00Z' } }, rate_limits: { 'r-rl': { attempts: 2, next_at: '2026-10-20T10:05:00Z' } } }));
  return { a, b };
}

test('dashboard snapshot: working, stale, waiting and idle agents; capacity; queue; feed', () => {
  const sb = makeSandbox({ now: '2026-10-20T10:00:00Z' });
  try {
    const { a } = setup(sb);
    // push the clock past the 1-minute lease of codex-old
    const snap = sb.run('relay-dashboard', ['--once'], { env: { RELAY_NOW: '2026-10-20T10:02:00Z' } }).json();
    const by = Object.fromEntries(snap.agents.map((x) => [x.agent_id, x]));
    assert.equal(by['claude-live'].status, 'working'); assert.equal(by['claude-live'].issue, a); assert.match(by['claude-live'].doing, /wiring the widget/); assert.equal(by['claude-live'].doing_kind, 'progress');
    assert.equal(by['codex-old'].status, 'stale'); assert.match(by['codex-old'].reason, /relay-lease sweep/);
    assert.equal(by['codex-rev'].status, 'working'); assert.equal(by['codex-rev'].task, 'routine_review'); assert.equal(by['codex-rev'].pr, 12);
    assert.equal(by['claude-throttled'].status, 'waiting'); assert.match(by['claude-throttled'].reason, /rate limited \(attempt 2\)/);
    assert.equal(by['claude-done'].status, 'idle'); assert.equal(by['claude-done'].last_outcome, 'done');
    assert.deepEqual(snap.counts, { working: 2, waiting: 1, stale: 1, idle: 1 });
    assert.deepEqual(snap.agents.map((x) => x.status), ['working', 'working', 'waiting', 'stale', 'idle'], 'sorted: working first, idle last');
    const claude = snap.runtimes.find((r) => r.runtime === 'claude');
    assert.equal(claude.working, 1); assert.equal(claude.waiting, 1); assert.equal(claude.idle_agents, 1); assert.equal(claude.free_slots, 6, '8 slots - working - waiting');
    assert.equal(snap.issues.by_state.ready, 1); assert.equal(snap.issues.by_state.claimed, 2);
    assert.ok(snap.issues.lists.ready.some((i) => i.title === 'Waiting in the queue'));
    assert.ok(snap.feed.some((e) => e.kind === 'progress' && /wiring/.test(e.text)));
    assert.equal(snap.control_plane, 'ok'); assert.equal(snap.mode, 'gated');
  } finally { sb.cleanup(); }
});

test('dashboard degrades to local state when the control plane is down', () => {
  const sb = makeSandbox({ now: '2026-10-20T10:00:00Z' });
  try {
    setup(sb);
    const snap = sb.run('relay-dashboard', ['--once'], { env: { RELAY_GH: '/nonexistent/gh' } }).json();
    assert.match(snap.control_plane, /^unavailable/); assert.ok(snap.agents.some((x) => x.agent_id === 'claude-live'), 'claims still shown');
  } finally { sb.cleanup(); }
});

test('dashboard server: serves the page and /api/status, read-only, localhost, hardened headers; page never uses innerHTML', async () => {
  const sb = makeSandbox({ now: '2026-10-20T10:00:00Z' });
  const p = spawn(process.execPath, [path.join(SCRIPTS, 'relay-dashboard'), '--port', '0'], { cwd: sb.work, env: sb.env });
  try {
    setup(sb);
    const line = await new Promise((resolve, reject) => { let b = ''; p.stdout.on('data', (d) => { b += d; if (/\n/.test(b)) resolve(b); }); p.on('exit', () => reject(new Error('exited: ' + b))); setTimeout(() => reject(new Error('no start line')), 20000); });
    const url = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(line)[1];
    const get = (u, method = 'GET') => new Promise((res, rej) => { const r = http.request(u, { method }, (m) => { let d = ''; m.on('data', (c) => (d += c)); m.on('end', () => res({ status: m.statusCode, headers: m.headers, body: d })); }); r.on('error', rej); r.end(); });
    const page = await get(url + '/');
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.headers['content-security-policy'], /default-src 'self'/); assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const api = await get(url + '/api/status');
    assert.equal(api.status, 200); const s = JSON.parse(api.body); assert.ok(s.agents.length >= 3); assert.equal(s.project, 'sandbox');
    assert.equal((await get(url + '/api/status', 'POST')).status, 405, 'read-only');
    assert.equal((await get(url + '/nope')).status, 404);
  } finally { p.kill(); sb.cleanup(); }
  const html = fs.readFileSync(path.join(REPO, 'core/dashboard/index.html'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), 'untrusted tracker text is only assigned with textContent');
});
