// Cost and load governor (ARCHITECTURE 10). State lives in .relay/governor.json under an advisory lock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relayDir } from './config.mjs';
import { withLock } from './lockfile.mjs';
import { now, iso } from './clock.mjs';
import { capCheck, enabledRuntimes } from './router.mjs';
import { tierShare } from './ledger.mjs';
import { analyze } from './claims.mjs';
import { handoffBody, handoffSha } from './handoff.mjs';
import { embed } from './markers.mjs';
import { readState, updateState } from './state.mjs';
import { validateAgainst } from './schema.mjs';
import { RelayError, EXIT } from './exit.mjs';

const govFile = (cfg) => path.join(relayDir(cfg), 'governor.json');
const readGov = (cfg) => (fs.existsSync(govFile(cfg)) ? JSON.parse(fs.readFileSync(govFile(cfg), 'utf8')) : { running: {}, rate_limits: {} });
function writeGov(cfg, g) {
  fs.mkdirSync(path.dirname(govFile(cfg)), { recursive: true });
  const tmp = `${govFile(cfg)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2));
  fs.renameSync(tmp, govFile(cfg));
}
const locked = (cfg, fn) => withLock(path.join(relayDir(cfg), 'governor.lock'), fn);

export function sampleLoad(cfg) {
  const load1 = process.env.RELAY_FAKE_LOAD != null ? Number(process.env.RELAY_FAKE_LOAD) : os.loadavg()[0];
  const cores = process.env.RELAY_FAKE_CORES != null ? Number(process.env.RELAY_FAKE_CORES) : os.cpus().length;
  const c = cfg.concurrency;
  const limit = c.load_limit_factor * cores;
  return { load1, cores, limit, pause_above: 2 * limit, over: load1 > limit, pause_low_priority: load1 > 2 * limit, retry_after_s: c.load_retry_s ?? 30 };
}

const RUN_TTL_MS = 6 * 3600e3;
function pruneStale(g, at) {
  for (const [id, r] of Object.entries(g.running)) if (at - Date.parse(r.started_at) > RUN_TTL_MS) delete g.running[id];
}
const heavyCount = (g) => Object.values(g.running).filter((r) => r.heavy).length;

// admit(cfg, run, {rows}) -> {decision:'admit'|'wait'|'deny', code, reason, retry_after_s?, fallback?}
export async function admit(cfg, run, { rows = [], dry = false } = {}) {
  const at = now().getTime();
  const b = cfg.budgets || {};
  const deny = (reason, extra = {}) => ({ decision: 'deny', code: EXIT.DENY, reason, ...extra });
  return locked(cfg, () => {
    const g = readGov(cfg);
    pruneStale(g, at);
    const resumed = !!g.running[run.run_id];

    // hard denials
    const maxTok = b.max_tokens_per_task?.[run.tier];
    if (maxTok != null && run.est_tokens != null && run.est_tokens > maxTok) return deny(`estimated ${run.est_tokens} tokens exceeds the ${run.tier} per-task limit ${maxTok}`);
    const spent = run.pr_spent_usd ?? rows.filter((r) => (run.pr != null && r.pr === run.pr) || (run.issue != null && r.issue === run.issue)).reduce((n, r) => n + (r.cost_usd || 0), 0);
    if (b.per_pr_cost_ceiling_usd != null && spent >= b.per_pr_cost_ceiling_usd) return deny(`per-PR cost ${spent.toFixed(2)} USD reached the ceiling ${b.per_pr_cost_ceiling_usd}`);
    if (run.tier === 'T2' || run.tier === 'T3') {
      const { share, enough } = tierShare(rows, b.tier_share_min_runs ?? 10);
      const eff = run.tier_share || (enough ? share : {});
      const cap = capCheck(run.tier, eff, b);
      if (!cap.ok) return deny(cap.reason, { fallback: { tier: 'T1', second_reviewer: true, requires_owner_approval: true } });
    }

    // waits
    const rl = g.rate_limits[run.run_id];
    if (rl?.next_at && at < Date.parse(rl.next_at)) return { decision: 'wait', code: EXIT.WAIT, reason: `rate-limit backoff for ${run.run_id} (attempt ${rl.attempts})`, retry_after_s: Math.ceil((Date.parse(rl.next_at) - at) / 1000) };
    if (!resumed) {
      const maxAgents = Math.min(cfg.concurrency.max_agents, cfg.concurrency.hard_max);
      if (Object.keys(g.running).length >= maxAgents) return { decision: 'wait', code: EXIT.WAIT, reason: `${maxAgents} agents already running`, retry_after_s: 60 };
      const load = sampleLoad(cfg);
      if (load.over) return { decision: 'wait', code: EXIT.WAIT, reason: `load ${load.load1} exceeds limit ${load.limit}`, retry_after_s: load.retry_after_s };
      if (run.heavy && heavyCount(g) >= cfg.concurrency.heavy_slots) return { decision: 'wait', code: EXIT.WAIT, reason: `all ${cfg.concurrency.heavy_slots} heavy slots in use`, retry_after_s: 60 };
    }
    if (!dry) {
      g.running[run.run_id] = { ...run, started_at: g.running[run.run_id]?.started_at || iso(new Date(at)) };
      if (rl) rl.next_at = null;
      writeGov(cfg, g);
    }
    return { decision: 'admit', code: EXIT.OK, reason: resumed ? 'resumed same run id' : 'admitted', resumed };
  });
}

export async function release(cfg, runId) {
  return locked(cfg, () => { const g = readGov(cfg); const had = !!g.running[runId]; delete g.running[runId]; delete g.rate_limits[runId]; writeGov(cfg, g); return had; });
}

// Record a rate limit. Backs off (same run id) up to max_retries, then proposes a runtime fallback.
export async function noteRateLimit(cfg, runId, { retryAfter, run: given } = {}) {
  const rl = cfg.rate_limit || {};
  const max = rl.max_retries ?? 3, sched = rl.backoff_s ?? [30, 60, 120];
  return locked(cfg, () => {
    const g = readGov(cfg);
    const run = g.running[runId] || given;
    if (!run) throw new RelayError(`unknown run ${runId} (admit it first or pass run details)`, EXIT.INVALID);
    const st = (g.rate_limits[runId] ||= { attempts: 0, next_at: null });
    st.attempts += 1;
    const at = now();
    if (st.attempts <= max) {
      const wait = retryAfter ?? sched[Math.min(st.attempts - 1, sched.length - 1)];
      st.next_at = iso(new Date(at.getTime() + wait * 1000));
      writeGov(cfg, g);
      return { action: 'backoff', run_id: runId, attempt: st.attempts, wait_s: wait, next_at: st.next_at, resume_same_run: true, run };
    }
    const order = (rl.fallback?.runtime_order || cfg.runtime_policy?.fallback_order || enabledRuntimes(cfg)).filter((r) => enabledRuntimes(cfg).includes(r));
    const to = order.find((r) => r !== run.runtime);
    delete g.running[runId]; delete g.rate_limits[runId];
    writeGov(cfg, g);
    if (!to) return { action: 'no_fallback', run_id: runId, attempt: st.attempts, reason: `${run.runtime} rate limited after ${max} retries and no other runtime is enabled`, run };
    return { action: 'fallback', run_id: runId, attempt: st.attempts, from_runtime: run.runtime, to_runtime: to, reason: `${run.runtime} rate limited, ${max} retries`, run };
  });
}

// Relabel an issue to another runtime with a handoff record (governor route of the label protocol).
export async function fallbackRelabel(cp, cfg, issue, { from, to, reason, agentId, handoffReason = 'rate_limited' }) {
  const comments = cp.listComments(issue);
  const a = analyze(comments);
  const live = a.records.filter((r) => ['active', 'expired'].includes(r.status)).at(-1);
  const st = readState(cfg), claim = st.claims.find((c) => c.issue === issue);
  const branch = live?.claim.branch || claim?.branch || `agent/${from}/${issue}`;
  const rec = {
    type: 'handoff', issue, from: { agent_id: agentId || live?.claim.agent_id || 'governor', runtime: from }, to: { runtime: to }, reason: handoffReason,
    done: [], remaining: ['continue from the branch head'], files_touched: [], tests_run: [], not_verified: ['work after the last pushed commit is unknown'],
    decisions: [reason], next_steps: ['read the branch diff against the default branch, then continue'], risks: [], links: { branch, pr: null, head_sha: 'unknown' }, previous: null,
  };
  rec.sha = handoffSha(rec);
  const v = validateAgainst('handoff', rec);
  if (!v.ok) throw new RelayError(`invalid fallback handoff: ${v.errors.join('; ')}`, EXIT.INVALID);
  cp.comment(issue, handoffBody(rec));
  if (live) cp.comment(issue, embed('release', { type: 'release', issue, agent_id: live.claim.agent_id, nonce: live.claim.nonce, reason: 'rate-limit fallback', at: iso(now()) }, `RELEASED by governor: ${reason}`));
  const labels = cp.getIssue(issue).labels.filter((l) => !l.startsWith('handoff:') && !l.startsWith('state:') && !/^agent:(claude|codex|any|gemini)$/.test(l));
  cp.setLabels(issue, [...labels, `agent:${to}`, `handoff:to-${to}`, 'state:ready']);
  await updateState(cfg, (s) => { s.claims = s.claims.filter((c) => c.issue !== issue); });
  return rec;
}
