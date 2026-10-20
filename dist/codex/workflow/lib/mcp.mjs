// Relay MCP server: ten neutral tools over stdio (JSON-RPC 2.0, newline-delimited). A thin wrapper: no logic of its own,
// every tool runs the matching relay-* script so behaviour is identical to the CLI.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv/dist/2020.js';
import { SCRIPTS_DIR } from './scripts.mjs';
import { VERSION } from './install.mjs';

const str = { type: 'string' }, int = { type: 'integer' }, strs = { type: 'array', items: str };
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

// Each tool: description, input schema, argv builder -> [script, args].
export const TOOLS = {
  claim_issue: { description: 'Atomically claim a ready issue (lease + branch). Refused if already claimed, overlapping, wrong owner label, or handoff not acknowledged.',
    schema: obj({ issue: int, agent_id: str, runtime: str, owned_paths: strs, ack_handoff: str, role: str, lease_minutes: int }, ['issue', 'agent_id', 'runtime']),
    argv: (a) => ['relay-claim', [String(a.issue), '--agent', a.agent_id, '--runtime', a.runtime, '--json', ...(a.owned_paths?.length ? ['--owned', a.owned_paths.join(',')] : []), ...(a.ack_handoff ? ['--ack-handoff', a.ack_handoff] : []), ...(a.role ? ['--role', a.role] : []), ...(a.lease_minutes ? ['--lease-min', String(a.lease_minutes)] : [])]] },
  release_claim: { description: 'Release a claim; the issue returns to state:ready.',
    schema: obj({ issue: int, agent_id: str, reason: str }, ['issue', 'agent_id']),
    argv: (a) => ['relay-lease', ['release', String(a.issue), '--agent', a.agent_id, ...(a.reason ? ['--reason', a.reason] : []), '--json']] },
  handoff: { description: 'Hand work to another runtime or the human: pushes the branch, posts the handoff record, relabels, releases the claim.',
    schema: obj({ issue: int, to: { enum: ['claude', 'codex', 'gemini', 'human', 'blocked'] }, reason: { enum: ['rate_limited', 'capability', 'review_rework', 'owner_request', 'lease_takeover'] }, done: strs, remaining: strs, files_touched: strs, tests_run: { type: 'array', items: obj({ cmd: str, result: { enum: ['pass', 'fail', 'not_run'] }, evidence: str }, ['cmd', 'result']) }, not_verified: strs, decisions: strs, next_steps: strs, risks: strs, agent_id: str, cwd: str }, ['issue', 'to', 'reason']),
    argv: (a, tmp) => { const f = path.join(tmp, 'handoff.json'); const { issue, to, reason, agent_id, cwd, ...rest } = a; return ['relay-handoff', ['post', String(issue), '--to', to, '--reason', reason, '--from-file', f, '--json', ...(agent_id ? ['--agent', agent_id] : [])], { file: f, data: rest, cwd }]; } },
  route_model: { description: 'Deterministic model/tier/runtime decision for an issue or PR (no model call).',
    schema: obj({ target: int, task_class: str, explain: { type: 'boolean' } }, ['target']),
    argv: (a) => ['relay-route', [String(a.target), ...(a.task_class ? ['--class', a.task_class] : []), '--json']] },
  run_local_ci: { description: 'Run the configured CI steps for a branch in a dedicated worktree.',
    schema: obj({ branch: str, full: { type: 'boolean' } }, ['branch']),
    argv: (a) => ['relay-ci', [a.branch, ...(a.full ? ['--full'] : [])]] },
  enqueue_merge: { description: 'Run the merge queue for a PR (gated or fast according to policy.mode).',
    schema: obj({ pr: int, issue: int }, ['pr']),
    argv: (a, tmp, mode) => [mode === 'fast' ? 'relay-quick-merge' : 'relay-merge', [`${a.pr}:${a.issue ?? 0}`]] },
  record_usage: { description: 'Append a usage row (no prompts, code or secrets) to the ledger.',
    schema: obj({ run_id: str, agent_id: str, runtime: str, tier: { enum: ['T0', 'T1', 'T2', 'T3'] }, task_class: str, model: str, issue: int, pr: int, tokens_in: int, tokens_out: int, outcome: str }, ['run_id', 'runtime', 'tier', 'task_class', 'outcome']),
    argv: (a) => ['relay-ledger', ['append', '--json', '--row', JSON.stringify(a)]] },
  owner_decision: { description: 'Park a decision only the owner can make (product ambiguity, destructive production mutation, external/provider authorization, conflicting requirements, scope change, business choice). Rejected unless the question, why the issue contract does not answer it, evidence, options, recommended default and why automatic progress is unsafe are all given. Never for technical choices or for asking whether to finish an issue.',
    schema: obj({ issue: int, question: str, options: strs, default: str, category: { enum: ['product-ambiguity', 'destructive-production', 'external-provider', 'conflicting-requirements', 'scope-change', 'business-choice'] }, contract_gap: str, evidence: str, unsafe_because: str, requirement: str, deadline: str }, ['issue', 'question', 'options', 'default', 'category', 'contract_gap', 'evidence', 'unsafe_because']),
    argv: (a) => ['relay-decision', ['open', String(a.issue), '--question', a.question, '--options', a.options.join(','), '--default', a.default, '--category', a.category, '--contract-gap', a.contract_gap, '--evidence', a.evidence, '--unsafe-because', a.unsafe_because, ...(a.requirement ? ['--requirement', a.requirement] : []), ...(a.deadline ? ['--deadline', a.deadline] : []), '--json']] },
  issue_contract: { description: 'The issue is the COMPLETE work contract; a PR is a slice. Read or gate it: extract|show|update|check|reconcile|audit|close|sweep|pr_section. `check` and `close` fail unless every accepted requirement has an acceptable final disposition (merged PR, passing tests or a GitHub-closed issue are not completion).',
    schema: obj({ action: { enum: ['extract', 'show', 'update', 'check', 'reconcile', 'audit', 'close', 'sweep', 'pr_section', 'release_audit'] }, issue: int, keep: strs, agent_id: str }, ['action']),
    argv: (a) => ['relay-contract', [String(a.action).replace('_', '-'), ...(a.issue ? [String(a.issue)] : []), ...(a.keep?.length ? ['--keep', a.keep.join(',')] : []), ...(a.agent_id ? ['--agent', a.agent_id] : []), '--json']] },
  contract_mark: { description: 'Record the final disposition of requirement(s) with evidence (PASS, FIXED_AND_VERIFIED, VALID_TERMINAL_DISPOSITION, EXTERNALLY_BLOCKED, or an open status such as FAIL/TESTS_ONLY). Refused without the evidence the requirement demands (tests, runtime proof, reproduction classification); follow-ups never satisfy a requirement.',
    schema: obj({ issue: int, ids: strs, status: str, evidence: strs, pr: int, note: str, classification: { enum: ['fixed_by_change', 'independently_recovered', 'non_reproducible', 'unexplained'] }, blocker: str, needs: str, cite: str, agent_id: str }, ['issue', 'ids', 'status']),
    argv: (a) => ['relay-contract', ['mark', String(a.issue), a.ids.join(','), a.status, ...(a.evidence || []).flatMap((e) => ['--evidence', e]), ...(a.pr ? ['--pr', String(a.pr)] : []), ...(a.note ? ['--note', a.note] : []), ...(a.classification ? ['--classification', a.classification] : []), ...(a.blocker ? ['--blocker', a.blocker] : []), ...(a.needs ? ['--needs', a.needs] : []), ...(a.cite ? ['--cite', a.cite] : []), ...(a.agent_id ? ['--agent', a.agent_id] : []), '--json']] },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, ajv.compile(t.schema)]));

import fs from 'node:fs';
import os from 'node:os';

export function callTool(name, args, { env = process.env, cwd = process.cwd() } = {}) {
  const t = TOOLS[name];
  if (!t) return { isError: true, text: `unknown tool ${name}` };
  const v = validators[name];
  if (!v(args ?? {})) return { isError: true, text: `invalid input: ${v.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : ''}`).join('; ')}` };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-'));
  try {
    let mode = 'gated';
    if (name === 'enqueue_merge') { try { mode = JSON.parse(spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'relay-state'), 'get', 'policy.mode'], { env, cwd, encoding: 'utf8' }).stdout) || 'gated'; } catch { /* default */ } }
    const [script, argv, extra] = t.argv(args, tmp, mode);
    if (extra?.file) fs.writeFileSync(extra.file, JSON.stringify(extra.data));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...argv], { env, cwd: extra?.cwd || cwd, encoding: 'utf8' });
    const text = (r.stdout.trim() || r.stderr.trim() || `(exit ${r.status})`);
    return { isError: r.status !== 0, text: r.status === 0 ? text : `exit ${r.status}: ${r.stderr.trim() || text}`, exit: r.status };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function handle(msg, ctx = {}) {
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': return ok({ protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'relay', version: VERSION } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
    case 'tools/call': { const r = callTool(msg.params?.name, msg.params?.arguments, ctx); return ok({ content: [{ type: 'text', text: r.text }], isError: !!r.isError }); }
    default: return msg.id === undefined ? null : err(-32601, `method not found: ${msg.method}`);
  }
}

export function serve(input = process.stdin, output = process.stdout, ctx = {}) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); continue; }
      const res = handle(msg, ctx);
      if (res) output.write(JSON.stringify(res) + '\n');
    }
  });
}

// Used by `relay-workflow doctor`: the server must list every tool.
export async function selfTest() { return Object.keys(handle({ id: 1, method: 'tools/list' }).result.tools.reduce((o, t) => ({ ...o, [t.name]: 1 }), {})).length === Object.keys(TOOLS).length; }
