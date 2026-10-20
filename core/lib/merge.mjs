import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relayDir } from './config.mjs';
import { acquire, release, withLock } from './lockfile.mjs';
import { runCI } from './ci.mjs';
import { syncBranch, commitsBehind } from './sync.mjs';
import { unanswered } from './botgate.mjs';
import { approvedFor } from './verdict.mjs';
import { updateState } from './state.mjs';
import { git } from './exec.mjs';
import { iso, now } from './clock.mjs';
import { readLog, checkLog } from './journal.mjs';
import { lint as lintEvidence } from './evidence.mjs';
import * as ledger from './ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (s) => (s > 0 ? new Promise((r) => setTimeout(r, s * 1000)) : Promise.resolve());
export const settleS = (opt) => Number(opt ?? process.env.RELAY_SETTLE_S ?? 15);
export const isMerged = (p) => p.merged === true || p.pull_request?.merged === true || !!p.merged_at;

export function parsePair(s) {
  const [pr, issue = '0'] = String(s).split(':');
  if (!/^\d+$/.test(pr) || !/^\d+$/.test(issue)) throw new Error(`bad pair "${s}" (expected <pr>:<issue>)`);
  return { pr: Number(pr), issue: Number(issue) };
}

// Serialise the merge queue: pid + mtime lock with stale detection.
export async function withMergeLock(cfg, fn, { waitS = Number(process.env.RELAY_LOCK_WAIT_S ?? 900) } = {}) {
  const file = path.join(relayDir(cfg), 'locks', 'merge.lock');
  const end = Date.now() + waitS * 1000;
  while (!acquire(file).acquired) {
    if (Date.now() > end) throw Object.assign(new Error('merge queue lock busy'), { busy: true });
    await sleep(0.2);
  }
  try { return await fn(); } finally { release(file); }
}

// Append-only usage ledger row (lock-protected). Never contains prompts, code or secrets.
export async function appendLedger(cfg, row) {
  const dir = path.join(relayDir(cfg), 'ledger'); fs.mkdirSync(dir, { recursive: true });
  const full = { ts: iso(now()), run_id: `merge-${row.pr ?? 'x'}-${Date.now().toString(36)}`, runtime: 'script', model: 'none', tier: 'T0', task_class: 'merge', ...row };
  await withLock(path.join(dir, 'usage.lock'), () => fs.appendFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(full) + '\n'));
}

// Merge-queue close-out of the linked issue: state:done, drop transient labels, close.
export async function closeIssueDone(cp, cfg, issue) {
  const labels = cp.getIssue(issue).labels.filter((l) => !l.startsWith('state:') && !l.startsWith('handoff:') && !/^review:(claude|codex|human|main|changes)$/.test(l));
  cp.setLabels(issue, [...labels, 'state:done']);
  cp.closeIssue(issue);
  try { await updateState(cfg, (s) => { s.claims = s.claims.filter((c) => c.issue !== issue); }); } catch { /* STATE.json is a cache; relay-state rebuild repairs it */ }
}

function markPR(cp, pr) {
  const labels = cp.getIssue(pr).labels.filter((l) => !/^review:(claude|codex|human|main|changes)$/.test(l));
  if (!labels.includes('review:approved')) labels.push('review:approved');
  cp.setLabels(pr, labels);
}

// Gated pipeline for one pair. Returns {pr, issue, status: merged|already|skip|failed, reason, line}.
export async function mergeGated(ctx, { pr, issue }, { settle = settleS(), emit = () => {}, dryRun = false } = {}) {
  const { cfg, cp } = ctx, root = cfg.__root;
  const done = (status, line, reason) => ({ pr, issue, status, reason, line });
  const skip = (reason) => done('skip', `#${pr} SKIP (${reason})`, reason);
  let p = cp.getPR(pr);
  if (isMerged(p)) return done('already', `#${pr} already merged`);
  if (p.state !== 'open') return skip('pull request is closed');
  const br = p.head.ref;
  if (git(['fetch', 'origin', '--prune'], { cwd: root }).code !== 0) return skip('sync failed');

  let v = approvedFor(cp, root, pr, p.head.sha, cfg.project.default_branch);
  if (!v.ok) return skip('no verdict for head sha');
  // honesty gates (opt-in through workflow.yaml; `relay-workflow init` enables them)
  if (issue > 0 && cfg.journal?.require?.length && !checkLog(readLog(cp, issue), cfg.journal.require).ok) return skip('issue journal incomplete');
  if (cfg.honesty?.evidence_lint === true && lintEvidence(p.body, { kind: 'pr' }).length) return skip('evidence lint failed');
  const ceiling = cfg.budgets?.per_pr_cost_ceiling_usd;
  if (ceiling != null) {
    const spent = ledger.readAll(cfg).filter((r) => r.pr === pr || (issue > 0 && r.issue === issue)).reduce((n, r) => n + (r.cost_usd || 0), 0);
    if (spent >= ceiling) return skip('budget denied');
  }
  const behind = commitsBehind(cfg, br);
  if (behind === null) return skip('sync failed');
  if (dryRun) return done('skip', `#${pr} DRY-RUN (would ${behind ? 'sync, ' : ''}run CI, bot gate, then squash-merge)`, 'dry-run');
  if (behind > 0) {
    const s = await syncBranch(cfg, br);
    emit(s.msg); for (const l of s.summary || []) emit(`    ${l}`);
    if (s.code !== 0) return skip('sync failed');
    await sleep(settle);
    p = cp.getPR(pr);
    v = approvedFor(cp, root, pr, p.head.sha, cfg.project.default_branch);
    if (!v.ok) return skip('no verdict for head sha');
  }
  const ci = runCI(cfg, br, { emit });
  if (ci.code !== 0) return skip('local CI failed');
  if (cfg.bot?.gate) {
    const open = unanswered(cp, cfg, pr);
    if (open.length) return skip(`${open.length} unanswered bot comments`);
  }
  const proofBin = path.join(here, '..', 'scripts', 'relay-proof');
  if (cfg.proof?.pre_merge && fs.existsSync(proofBin)) {
    const r = spawnSync(process.execPath, [proofBin, '--stage', 'pre-merge', '--ref', br], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) { emit(`environment check exit ${r.status}: ${(r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`); return skip('env check failed'); }
  }
  try { cp.mergePR(pr, 'squash'); } catch (e) { emit(e.message); return done('failed', `#${pr} MERGE FAILED`, e.message); }
  markPR(cp, pr);
  if (issue > 0) await closeIssueDone(cp, cfg, issue);
  await appendLedger(cfg, { pr, issue: issue || null, outcome: 'done', reason: 'gated merge' });
  return done('merged', `#${pr} MERGED${issue > 0 ? ` (issue #${issue})` : ''}`);
}

// Fast pipeline: merge first; on conflict sync (resolvers, no tests) and retry.
export async function mergeFast(ctx, { pr, issue }, { settle = settleS(), emit = () => {} } = {}) {
  const { cfg, cp } = ctx;
  let p = cp.getPR(pr);
  const br = p.head.ref;
  if (!isMerged(p)) {
    let ok = true;
    try { cp.mergePR(pr, 'squash'); } catch { ok = false; }
    if (!ok) {
      const s = await syncBranch(cfg, br, { steps: false });
      emit(s.msg);
      await sleep(settle);
      try { cp.mergePR(pr, 'squash'); } catch (e) { emit(e.message); }
    }
    p = cp.getPR(pr);
  }
  if (!isMerged(p)) { await appendLedger(cfg, { pr, issue: issue || null, outcome: 'failed', reason: 'fast merge failed' }); return { pr, issue, status: 'failed', line: `#${pr} NOT MERGED` }; }
  if (issue > 0) {
    const note = (cfg.policy.fast_merge?.close_note ?? 'Fixed by merged PR #{pr}; verification follows on main.').replaceAll('{pr}', String(pr));
    cp.comment(issue, note);
    await closeIssueDone(cp, cfg, issue);
  }
  if ((cfg.policy.fast_merge?.post_merge_qa ?? 'required') !== 'off') {
    const dir = path.join(cfg.__root, '.relay', 'qa-queue'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pr}.json`), JSON.stringify({ pr, issue: issue || null, branch: br, enqueued_at: iso(now()) }) + '\n');
  }
  await appendLedger(cfg, { pr, issue: issue || null, outcome: 'done', reason: 'fast merge' });
  return { pr, issue, status: 'merged', line: `#${pr} MERGED` };
}
