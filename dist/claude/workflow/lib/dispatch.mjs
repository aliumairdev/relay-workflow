// Headless dispatch (Codex and any runtime with exec_cmd): claim -> worktree -> brief -> run -> classify -> ledger -> next action.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decide, enabledRuntimes } from './router.mjs';
import * as gov from './governor.mjs';
import * as ledger from './ledger.mjs';
import { renderBrief } from './brief.mjs';
import { buildCommand, classify, execAgent } from './runtime.mjs';
import { runScript, relayEnv } from './scripts.mjs';
import { parseOwnedPaths, closesIssue, runtimeFromBranch } from './issue.mjs';
import { handoffsOf } from './handoff.mjs';
import { analyze } from './claims.mjs';
import { readState } from './state.mjs';
import { appendQuietly } from './journal.mjs';
import { extract } from './markers.mjs';
import { changeLabels } from './labelops.mjs';
import { acquire, release } from './lockfile.mjs';
import { relayDir } from './config.mjs';
import { modelFor, DEFAULT_TIERS } from './agents.mjs';
import { git } from './exec.mjs';
import { EXIT } from './exit.mjs';

const rid = () => crypto.randomBytes(2).toString('hex');
const runsDir = (cfg) => path.join(relayDir(cfg), 'runs');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const result = (code, outcome, extra = {}) => ({ code, outcome, ...extra });

export function reviewRuntimeFor(cfg, implementer) {
  const enabled = enabledRuntimes(cfg);
  if (!(cfg.review?.cross_runtime ?? true)) return implementer;
  const order = (cfg.runtime_policy?.fallback_order || enabled).filter((r) => enabled.includes(r));
  return order.find((r) => r !== implementer) || implementer;
}

// Commit and push uncommitted work so whoever continues sees it (honest WIP commit).
function saveWip(dir, branch, why) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (!git(['status', '--porcelain'], { cwd: dir }).stdout.trim()) return false;
  git(['add', '-A'], { cwd: dir });
  git(['commit', '-m', `wip: uncommitted work saved by the dispatcher (${why})`], { cwd: dir });
  return git(['push', '-u', 'origin', branch], { cwd: dir }).code === 0;
}

const estimate = (text) => Math.ceil(String(text || '').length / 4);

async function record(cfg, base, extra) {
  try { await ledger.append(cfg, { ...base, estimated: true, ...extra }); } catch (e) { process.stderr.write(`warning: ledger row not written (${e.message})\n`); }
}

function lockFor(cfg, name) {
  const f = path.join(relayDir(cfg), 'locks', `${name}.lock`);
  const lk = acquire(f, { staleAfterS: 4 * 3600 });
  return { ok: lk.acquired, release: () => release(f) };
}

export async function dispatchIssue(cfg, cp, { issue: n, runtime: wantRt = null }) {
  const lk = lockFor(cfg, `dispatch-${n}`);
  if (!lk.ok) return result(EXIT.REFUSED, 'skipped', { reason: `#${n} is being dispatched by another process` });
  try { return await dispatchIssueLocked(cfg, cp, n, wantRt); } finally { lk.release(); }
}

async function dispatchIssueLocked(cfg, cp, n, wantRt) {
  const item = cp.getIssue(n);
  if (item.pull_request || item.state !== 'open') return result(EXIT.REFUSED, 'refused', { reason: `#${n} is not an open issue` });
  const comments = cp.listComments(n);
  const handoffLabel = item.labels.find((l) => l.startsWith('handoff:'));
  const ownerLabel = item.labels.map((l) => /^agent:(claude|codex|gemini)$/.exec(l)?.[1]).find(Boolean);
  const owned = parseOwnedPaths(item.body);

  const rows = ledger.readAll(cfg);
  const { share, enough } = ledger.tierShare(rows, cfg.budgets?.tier_share_min_runs ?? 10);
  const routed = decide({ target: { kind: 'issue', number: n }, class: 'implement', labels: item.labels, paths: owned, history: { tier_share: enough ? share : {} } }, cfg);
  if (routed.denied) return result(EXIT.DENIED, 'denied', { reason: 'router denied (budget/cap)', routed });
  const runtime = wantRt || ownerLabel || routed.decision.runtime;
  if (!cfg.runtimes?.[runtime]?.exec_cmd) return result(EXIT.REFUSED, 'refused', { reason: `runtime ${runtime} has no exec_cmd: it is dispatched by the orchestrator session, not headlessly` });
  const tier = routed.decision.tier || 'T1';
  const model = modelFor(cfg, runtime, tier);

  // Run identity: a rate-limited run keeps its id so the governor's backoff applies to the resume.
  const runFile = path.join(runsDir(cfg), `issue-${n}.json`);
  const prev = readJson(runFile);
  const resumed = !!(prev && prev.runtime === runtime);
  const run_id = resumed ? prev.run_id : `r-${n}-${rid()}`;
  const agent_id = resumed ? prev.agent_id : `${runtime}-${rid()}`;
  const base = { run_id, agent_id, runtime, model: model && !/^<.*>$/.test(model) ? model : undefined, tier, task_class: 'implement', issue: n };

  const adm = await gov.admit(cfg, { run_id, agent_id, runtime, tier, task_class: 'implement', issue: n }, { rows });
  if (adm.code !== EXIT.OK) return result(adm.code, adm.decision, { reason: adm.reason, retry_after_s: adm.retry_after_s, fallback: adm.fallback, run_id });

  const unwind = async (reason) => { runScript(cfg, 'relay-lease', ['release', String(n), '--agent', agent_id, '--reason', reason]); await gov.release(cfg, run_id); fs.rmSync(runFile, { force: true }); };

  // Claim (skipped when resuming our own live claim)
  let claim = readState(cfg).claims.find((c) => c.issue === n && c.agent_id === agent_id);
  if (claim) runScript(cfg, 'relay-lease', ['heartbeat', String(n), '--agent', agent_id]);
  else {
    const latest = handoffLabel ? handoffsOf(comments).at(-1) : null;
    const args = [String(n), '--agent', agent_id, '--runtime', runtime, '--json', ...(owned.length ? ['--owned', owned.join(',')] : []), ...(latest ? ['--ack-handoff', latest.sha] : [])];
    const c = runScript(cfg, 'relay-claim', args, { env: { RELAY_ACTOR: 'implementer' } });
    if (c.code !== 0) { await gov.release(cfg, run_id); fs.rmSync(runFile, { force: true }); return result(c.code === EXIT.REFUSED ? EXIT.REFUSED : c.code, 'refused', { reason: c.stderr.trim() }); }
    claim = c.json();
  }
  const wt = runScript(cfg, 'relay-worktree', ['create', String(n), '--runtime', runtime, '--json']);
  if (wt.code !== 0) { await unwind(`worktree failed: ${wt.stderr.trim().slice(0, 120)}`); return result(EXIT.ENV, 'failed', { reason: wt.stderr.trim() }); }
  const dir = wt.json().path, branch = claim.branch;

  // Brief
  const role = (item.labels.map((l) => /^agent:([1-7])$/.exec(l)?.[1]).find(Boolean));
  const latestHandoff = handoffLabel ? handoffsOf(comments).at(-1) : null;
  const vars = {
    issue: String(n), runtime, branch, agent_id, tier_name: cfg.tiers?.[tier]?.name || DEFAULT_TIERS[tier]?.name || tier,
    role_name: (role && cfg.roles?.[role]?.name) || 'general', review_runtime: reviewRuntimeFor(cfg, runtime),
    owned_paths: owned.join(', ') || '(see issue)', forbidden_paths: (cfg.shared_append_only || []).map((p) => `${p} (append-only)`).join(', ') || '(none declared)',
    preclaimed_note: `The dispatcher already claimed #${n} for you (agent ${agent_id}) and created your worktree: skip relay-claim and relay-worktree create, run \`relay-worktree verify\` first.`,
    issue_text: `Title: ${item.title}\n\n${String(item.body || '(no body)').slice(0, 6000)}`,
    handoff_ack: latestHandoff ? ` --ack-handoff ${latestHandoff.sha}` : '',
  };
  let text = renderBrief('dispatch', vars, cfg);
  if (latestHandoff) text = renderBrief('handoff', { ...vars, from_runtime: latestHandoff.from.runtime, reason: latestHandoff.reason, handoff_sha: latestHandoff.sha }, cfg).text + '\n' + text.text;
  else text = text.text;
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  fs.mkdirSync(path.join(relayDir(cfg), 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(relayDir(cfg), 'briefs', `issue-${n}-${hash}.md`), text);

  fs.mkdirSync(runsDir(cfg), { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify({ run_id, agent_id, runtime, tier, issue: n, started: new Date().toISOString() }));
  const hbMs = Number(process.env.RELAY_HEARTBEAT_MS || cfg.claims.heartbeat_minutes * 60000);
  const env = relayEnv(cfg, { ...(cfg.runtimes[runtime].effort_env || {}), RELAY_AGENT_ID: agent_id, RELAY_ISSUE: String(n), RELAY_ACTOR: 'implementer', RELAY_RUN_ID: run_id, RELAY_RUNTIME: runtime });
  const spec = buildCommand(cfg, runtime, { model, prompt: text });
  const res = await execAgent(spec, { cwd: dir, env, tickMs: hbMs, onTick: () => runScript(cfg, 'relay-lease', ['heartbeat', String(n), '--agent', agent_id]), logDir: path.join(runsDir(cfg), run_id) });
  let outcome = classify(cfg, runtime, res);
  const row = { ...base, brief_hash: hash, wall_s: res.wall_s, tokens_in: estimate(text), tokens_out: estimate(res.stdout) };

  if (outcome === 'done') {
    const pr = cp.listPRs('all').find((p) => (p.head?.ref || p.pull_request?.head?.ref) === branch);
    const held = analyze(cp.listComments(n)).valid?.claim.agent_id === agent_id;
    if (!pr && held) {
      await unwind('agent exited without opening a PR while holding the claim');
      appendQuietly(cp, n, { kind: 'blocker', text: `${agent_id} exited 0 without a PR and without a handoff; claim released, issue returned to the queue.`, agent_id: 'dispatcher', runtime });
      await record(cfg, row, { outcome: 'failed', reason: 'exited without a PR' });
      return result(EXIT.ERROR, 'failed', { reason: 'agent exited without a PR while holding the claim', run_id });
    }
    await gov.release(cfg, run_id); fs.rmSync(runFile, { force: true });
    await record(cfg, row, { pr: pr?.number ?? null, outcome: 'done' });
    return result(EXIT.OK, 'done', { run_id, agent_id, pr: pr?.number ?? null, branch });
  }

  const fallbackTo = () => { const order = (cfg.runtime_policy?.fallback_order || enabledRuntimes(cfg)).filter((r) => enabledRuntimes(cfg).includes(r)); return order.find((r) => r !== runtime) || null; };
  const hand = async (to, reason, handoffReason = 'rate_limited') => {
    saveWip(dir, branch, reason);
    runScript(cfg, 'relay-worktree', ['remove', String(n)]);
    await gov.fallbackRelabel(cp, cfg, n, { from: runtime, to, reason, agentId: agent_id, handoffReason });
    appendQuietly(cp, n, { kind: 'handoff', text: `Governor fallback ${runtime} → ${to}: ${reason}. Branch ${branch} pushed with any uncommitted work as a WIP commit.`, agent_id: 'dispatcher', runtime });
    await gov.release(cfg, run_id); fs.rmSync(runFile, { force: true });
  };

  if (outcome === 'rate_limited') {
    const rl = await gov.noteRateLimit(cfg, run_id, { run: { run_id, agent_id, runtime, tier, task_class: 'implement', issue: n } });
    await record(cfg, row, { outcome: 'rate_limited', rate_limit: true, reason: `attempt ${rl.attempt}` });
    if (rl.action === 'backoff') return result(EXIT.WAIT, 'rate_limited', { run_id, attempt: rl.attempt, retry_after_s: rl.wait_s, reason: `rate limited; resume the same run ${run_id} after ${rl.wait_s}s` });
    if (rl.action === 'fallback') {
      await record(cfg, row, { outcome: 'fallback', rate_limit: true, reason: rl.reason });
      await hand(rl.to_runtime, rl.reason);
      return result(EXIT.OK, 'fallback', { run_id, from_runtime: runtime, to_runtime: rl.to_runtime, reason: rl.reason });
    }
    await unwind(rl.reason);
    return result(EXIT.NEEDS_HUMAN, 'rate_limited', { reason: rl.reason });
  }

  if (outcome === 'missing_binary') {
    const to = fallbackTo();
    const reason = `${runtime} binary not found (${cfg.runtimes[runtime].exec_cmd.split(/\s+/)[0]})`;
    await record(cfg, row, { outcome: 'failed', reason });
    if (to) { await record(cfg, row, { outcome: 'fallback', reason }); await hand(to, reason, 'capability'); return result(EXIT.ENV, 'fallback', { run_id, from_runtime: runtime, to_runtime: to, reason }); }
    await unwind(reason);
    return result(EXIT.ENV, 'failed', { reason });
  }

  const tail = res.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  saveWip(dir, branch, `exit ${res.code}`);
  await unwind(`agent failed (exit ${res.code})`);
  appendQuietly(cp, n, { kind: 'blocker', text: `${agent_id} failed (exit ${res.code})${res.timedOut ? ' after timeout' : ''}: ${tail || 'no error output'}. Claim released.`, agent_id: 'dispatcher', runtime });
  await record(cfg, row, { outcome: 'failed', reason: `exit ${res.code}` });
  return result(EXIT.ERROR, 'failed', { run_id, reason: `exit ${res.code}: ${tail}` });
}

// ---- review dispatch ---------------------------------------------------------------------------
const verdictsOf = (comments) => comments.flatMap((c) => extract(c.body, 'verdict').map((m) => ({ ...m.data, comment_id: c.id })));

export async function dispatchReview(cfg, cp, { pr, runtime: wantRt = null }) {
  const lk = lockFor(cfg, `review-${pr}`);
  if (!lk.ok) return result(EXIT.REFUSED, 'skipped', { reason: `PR #${pr} is being reviewed by another process` });
  try { return await dispatchReviewLocked(cfg, cp, pr, wantRt); } finally { lk.release(); }
}

async function dispatchReviewLocked(cfg, cp, pr, wantRt) {
  const item = cp.getPR(pr);
  if (item.state !== 'open') return result(EXIT.REFUSED, 'refused', { reason: `PR #${pr} is not open` });
  const branch = item.head?.ref || item.pull_request?.head?.ref, head = item.head?.sha || item.pull_request?.head?.sha;
  const implRt = runtimeFromBranch(branch), issue = closesIssue(item.body);
  const comments = cp.listComments(pr);
  const verdicts = verdictsOf(comments);
  if (verdicts.some((v) => v.head_sha === head)) return result(EXIT.OK, 'skipped', { reason: `a verdict already exists for head ${head}` });

  const rows = ledger.readAll(cfg);
  const { share, enough } = ledger.tierShare(rows, cfg.budgets?.tier_share_min_runs ?? 10);
  const rework = verdicts.filter((v) => v.result === 'CHANGES').length;
  const routed = decide({ target: { kind: 'pr', number: pr }, class: 'routine_review', labels: item.labels, paths: [], rework_rounds: rework, failed_reviews: rework, implementer_runtime: implRt, history: { tier_share: enough ? share : {} } }, cfg);
  if (routed.denied) return result(EXIT.DENIED, 'denied', { reason: 'router denied (budget/cap)' });
  const runtime = routed.decision.runtime;
  if (wantRt && wantRt !== runtime) return result(EXIT.REFUSED, 'refused', { reason: `PR #${pr} must be reviewed by ${runtime} (implementer ${implRt}), not ${wantRt}` });
  if (!cfg.runtimes?.[runtime]?.exec_cmd) return result(EXIT.REFUSED, 'refused', { reason: `runtime ${runtime} has no exec_cmd` });
  const tier = routed.decision.tier || 'T1', model = modelFor(cfg, runtime, tier);
  const run_id = `r-pr${pr}-${rid()}`, agent_id = `${runtime}-rev-${rid()}`;
  const base = { run_id, agent_id, runtime, model: model && !/^<.*>$/.test(model) ? model : undefined, tier, task_class: 'routine_review', issue: issue ?? null, pr };
  const adm = await gov.admit(cfg, { run_id, agent_id, runtime, tier, task_class: 'routine_review', issue, pr }, { rows });
  if (adm.code !== EXIT.OK) return result(adm.code, adm.decision, { reason: adm.reason, retry_after_s: adm.retry_after_s, run_id });

  const scratch = `review-${pr}`;
  const wt = runScript(cfg, 'relay-worktree', ['create', '--scratch', scratch, '--ref', branch, '--json']);
  if (wt.code !== 0) { await gov.release(cfg, run_id); return result(EXIT.ENV, 'failed', { reason: wt.stderr.trim() }); }
  const prior = verdicts.at(-1);
  const text = renderBrief('review', {
    pr: String(pr), issue: String(issue ?? '?'), branch, runtime, agent_id, tier_name: cfg.tiers?.[tier]?.name || DEFAULT_TIERS[tier]?.name || tier,
    delta_note: prior ? `Re-review ONLY the delta since the previous verdict (head ${prior.head_sha}); do not re-review unchanged files.` : '',
    ...(routed.decision.second_reviewer ? { profile_review_gate: 'This PR scored above the second-reviewer threshold: be explicit about every checklist item.' } : {}),
  }, cfg).text;
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  const env = relayEnv(cfg, { ...(cfg.runtimes[runtime].effort_env || {}), RELAY_AGENT_ID: agent_id, RELAY_PR: String(pr), ...(issue ? { RELAY_ISSUE: String(issue) } : {}), RELAY_ACTOR: 'reviewer', RELAY_RUN_ID: run_id, RELAY_RUNTIME: runtime });
  const res = await execAgent(buildCommand(cfg, runtime, { model, prompt: text }), { cwd: wt.json().path, env, logDir: path.join(runsDir(cfg), run_id) });
  runScript(cfg, 'relay-worktree', ['remove', '--scratch', scratch]);
  const outcome = classify(cfg, runtime, res);
  const row = { ...base, brief_hash: hash, wall_s: res.wall_s, tokens_in: estimate(text), tokens_out: estimate(res.stdout) };
  await gov.release(cfg, run_id);

  if (outcome === 'done') {
    const v = verdictsOf(cp.listComments(pr)).find((x) => x.head_sha === head && x.reviewer?.agent_id === agent_id);
    if (!v) { await record(cfg, row, { outcome: 'failed', reason: 'reviewer exited without posting a verdict' }); return result(EXIT.ERROR, 'failed', { reason: 'reviewer exited without posting a verdict for the current head', run_id }); }
    await record(cfg, row, { outcome: v.result === 'APPROVED' ? 'approved' : 'changes_requested' });
    return result(EXIT.OK, v.result === 'APPROVED' ? 'approved' : 'changes_requested', { run_id, pr, head_sha: head });
  }
  if (outcome === 'rate_limited') {
    await record(cfg, row, { outcome: 'rate_limited', rate_limit: true });
    return result(EXIT.WAIT, 'rate_limited', { reason: 'reviewer rate limited; retry later', retry_after_s: (cfg.rate_limit?.backoff_s || [30])[0] });
  }
  await record(cfg, row, { outcome: 'failed', reason: outcome === 'missing_binary' ? 'binary not found' : `exit ${res.code}` });
  return result(outcome === 'missing_binary' ? EXIT.ENV : EXIT.ERROR, 'failed', { reason: outcome === 'missing_binary' ? `${runtime} binary not found` : `exit ${res.code}` });
}
