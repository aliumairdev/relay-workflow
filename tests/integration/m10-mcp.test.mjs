import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeSandbox, seedIssue, SCRIPTS } from '../helpers.mjs';

// Minimal scripted MCP client: newline-delimited JSON-RPC over stdio.
function client(sb) {
  const p = spawn(process.execPath, [path.join(SCRIPTS, 'relay-mcp')], { cwd: sb.work, env: sb.env });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { isError: r.result.isError, text: r.result.content[0].text, json: () => JSON.parse(r.result.content[0].text) }; };
  return { rpc, call, close: () => p.kill() };
}

test('T-MCP-2: initialize, eight tools with schemas, input validation rejects bad calls', async () => {
  const sb = makeSandbox(); const c = client(sb);
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'relay');
    const tools = (await c.rpc('tools/list')).result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['claim_issue', 'enqueue_merge', 'handoff', 'owner_decision', 'record_usage', 'release_claim', 'route_model', 'run_local_ci']);
    assert.ok(tools.every((t) => t.inputSchema.type === 'object' && t.description));
    const missing = await c.call('claim_issue', { issue: 1 });
    assert.ok(missing.isError); assert.match(missing.text, /required property/);
    const extra = await c.call('claim_issue', { issue: 1, agent_id: 'a', runtime: 'claude', sudo: true });
    assert.ok(extra.isError); assert.match(extra.text, /sudo/);
    assert.ok((await c.call('handoff', { issue: 1, to: 'nobody', reason: 'capability' })).isError, 'enum enforced');
    assert.ok((await c.call('no_such_tool', {})).isError);
    assert.equal((await c.rpc('nope')).error.code, -32601);
  } finally { c.close(); sb.cleanup(); }
});

test('T-MCP-1: a client with no Claude/Codex specifics runs claim -> handoff -> claim(other agent) -> usage -> decision; GitHub state matches the script-driven flow', async () => {
  const sb = makeSandbox(); const c = client(sb);
  try {
    const n = seedIssue(sb, { title: 'Via MCP', labels: ['state:ready', 'agent:any'] });
    const claim = await c.call('claim_issue', { issue: n, agent_id: 'agent-a', runtime: 'claude', owned_paths: ['src/**'] });
    assert.ok(!claim.isError, claim.text);
    const branch = claim.json().branch;
    const wt = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']).json().path;

    const again = await c.call('claim_issue', { issue: n, agent_id: 'agent-b', runtime: 'codex' });
    assert.ok(again.isError); assert.match(again.text, /already claimed/);

    const h = await c.call('handoff', { issue: n, to: 'codex', reason: 'capability', agent_id: 'agent-a', cwd: wt, done: ['scaffold'], remaining: ['finish'], next_steps: ['finish it'], tests_run: [{ cmd: 'npm test', result: 'pass', evidence: '1 pass' }] });
    assert.ok(!h.isError, h.text);
    const sha = h.json().sha;
    const labels = () => sb.issue(n).labels.map((l) => l.name).sort();
    assert.ok(labels().includes('handoff:to-codex') && labels().includes('state:ready'));

    assert.ok((await c.call('claim_issue', { issue: n, agent_id: 'agent-b', runtime: 'codex' })).isError, 'handoff must be acknowledged');
    const b = await c.call('claim_issue', { issue: n, agent_id: 'agent-b', runtime: 'codex', ack_handoff: sha });
    assert.ok(!b.isError, b.text); assert.equal(b.json().branch, branch);

    const u = await c.call('record_usage', { run_id: 'r-mcp-1', agent_id: 'agent-b', runtime: 'codex', tier: 'T1', task_class: 'implement', issue: n, tokens_in: 1000, tokens_out: 100, outcome: 'done' });
    assert.ok(!u.isError, u.text);
    assert.ok(!(await c.call('record_usage', { run_id: 'r2', runtime: 'codex', tier: 'T9', task_class: 'x', outcome: 'done' })).isError === false, 'bad tier rejected');

    const d = await c.call('owner_decision', { issue: n, question: 'Which name?', options: ['A', 'B'], default: 'A' });
    assert.ok(!d.isError, d.text);
    assert.ok(labels().includes('state:blocked'));

    const r = await c.call('route_model', { target: n });
    assert.ok(!r.isError, r.text); assert.ok(r.json().decision.tier);

    const rel = await c.call('release_claim', { issue: n, agent_id: 'agent-b', reason: 'done for now' });
    assert.ok(!rel.isError, rel.text);

    // the same sequence driven by scripts leaves the same shape of state: comments contain claim, handoff, claim, release markers
    const kinds = sb.comments(n).flatMap((x) => [...x.body.matchAll(/<!-- relay:([a-z-]+) /g)].map((m) => m[1]));
    assert.deepEqual(kinds.filter((k) => ['claim', 'handoff', 'release'].includes(k)), ['claim', 'handoff', 'release', 'claim', 'release']);
    assert.equal(sb.state().claims.length, 0);
  } finally { c.close(); sb.cleanup(); }
});
