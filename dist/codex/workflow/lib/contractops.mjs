// Issue-contract persistence and control-plane effects: living contract comment, drift refresh, the closure gate,
// post-merge settling (issue stays active until the contract is complete), and reconciliation of GitHub-closed issues.
import path from 'node:path';
import { embed, extract as extractMarkers } from './markers.mjs';
import * as C from './contract.mjs';
import { validateAgainst } from './schema.mjs';
import { withLock } from './lockfile.mjs';
import { relayDir } from './config.mjs';
import { updateState } from './state.mjs';
import { analyze } from './claims.mjs';
import { appendQuietly } from './journal.mjs';
import { runScript } from './scripts.mjs';
import { iso, now } from './clock.mjs';
import { RelayError, EXIT } from './exit.mjs';

const MAX_BODY = 60000;
export const LABELS = { open: 'contract:open', blocked: 'contract:blocked-external', closedIncomplete: 'contract:closed-incomplete', complete: 'contract:complete' };
const CONTRACT_LABELS = Object.values(LABELS);

export const modeOf = (cfg) => cfg?.contract?.mode ?? 'enforce';
export const enforced = (cfg) => modeOf(cfg) === 'enforce';

// ---- storage -----------------------------------------------------------------------------------------------
function human(contract) {
  const ev = C.evaluate(contract, { requireAudit: false });
  const rows = contract.requirements.map((r) => `| ${r.id} | ${ev.effective[r.id]} | ${String(r.text).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 140)} | ${r.evidence.length} |`);
  return `**Issue contract** for #${contract.issue} · ${ev.counts.complete}/${ev.counts.total} complete · rev ${contract.rev}\n\n| id | status | requirement | evidence |\n|---|---|---|---|\n${rows.join('\n')}\n\n_A merged PR, a green test or a closed issue is not completion: every requirement needs an acceptable final disposition (\`relay-contract check ${contract.issue}\`)._`;
}

export function findContract(comments) {
  let found = null;
  for (const c of comments) {
    const m = extractMarkers(c.body, 'issue-contract')[0];
    if (m && (!found || c.id > found.id)) found = { id: c.id, contract: m.data };
  }
  return found;
}

export const load = (cp, issue) => findContract(cp.listComments(issue));

function build(contract) {
  const v = C.SCHEMA_VERSION === contract.schema_version ? validateAgainst('contract', contract) : { ok: false, errors: [`unsupported contract schema_version ${contract.schema_version}`] };
  if (!v.ok) throw new RelayError(`issue contract would be invalid: ${v.errors.join('; ')}`, EXIT.INVALID);
  let body = embed('issue-contract', contract, human(contract));
  for (let i = 0; body.length > MAX_BODY && i < contract.requirements.length; i++) {      // compact old evidence, never requirement text or status
    for (const r of contract.requirements) r.evidence = r.evidence.slice(-Math.max(1, 3 - i));
    body = embed('issue-contract', contract, human(contract));
  }
  return body;
}

function lockFile(cfg, issue) { return path.join(relayDir(cfg), 'locks', `contract-${issue}.lock`); }

// Locked read-modify-write of the contract comment. fn(contract) returns the next contract (or undefined = unchanged).
export async function mutate(cp, cfg, issue, fn) {
  return withLock(lockFile(cfg, issue), async () => {
    const found = load(cp, issue);
    if (!found) throw new RelayError(`#${issue} has no issue contract yet: run \`relay-contract extract ${issue}\``, EXIT.INVALID);
    const next = (await fn(found.contract)) ?? found.contract;
    if (next !== found.contract) cp.editComment(found.id, build(next));
    return next;
  });
}

// Load the contract, creating (bootstrapping) it from the live issue when missing. Idempotent; never invents evidence.
export async function ensure(cp, cfg, issue) {
  return withLock(lockFile(cfg, issue), async () => {
    const found = load(cp, issue);
    if (found) return { contract: found.contract, created: false };
    const gh = cp.getIssue(issue);
    if (gh.pull_request) throw new RelayError(`#${issue} is a pull request, not an issue`, EXIT.INVALID);
    const contract = C.extract({ ...gh, number: issue }, cp.listComments(issue));
    cp.comment(issue, build(contract));
    syncLabels(cp, issue, gh.labels, { add: [LABELS.open] });
    appendQuietly(cp, issue, { kind: 'plan', text: `Issue contract extracted: ${contract.requirements.filter((r) => !r.derived).map((r) => r.id).join(', ')} (${contract.bootstrap ? 'bootstrapped from an existing issue; historical ticks are UNCHECKED' : 'fresh'}). Every requirement needs a final disposition before the issue can close.`, agent_id: 'relay-contract', reqs: contract.requirements.filter((r) => !r.derived).map((r) => r.id) });
    return { contract, created: true };
  });
}

function syncLabels(cp, issue, current, { add = [], remove = [] }) {
  const next = [...new Set([...current.filter((l) => !remove.includes(l)), ...add])];
  if (next.length !== current.length || next.some((l) => !current.includes(l))) cp.setLabels(issue, next);
  return next;
}

// ---- reading + gate ----------------------------------------------------------------------------------------
// Re-read the issue and merge changes into the stored contract (additions become TODO; nothing is dropped silently).
export async function refresh(cp, cfg, issue) {
  const gh = cp.getIssue(issue), comments = cp.listComments(issue);
  const found = load(cp, issue);
  if (!found) return { ...(await ensure(cp, cfg, issue)), added: [], vanished: [], drifted: false };
  if (!C.hasDrifted(found.contract, { ...gh, number: issue }, comments)) return { contract: found.contract, created: false, added: [], vanished: found.contract.drift?.vanished || [], drifted: false };
  let result;
  const contract = await mutate(cp, cfg, issue, (cur) => { result = C.update(cur, { ...gh, number: issue }, comments); return result.contract; });
  appendQuietly(cp, issue, { kind: 'progress', text: `Contract drift detected and merged: added ${result.added.join(', ') || 'none'}; vanished from the issue text: ${result.vanished.join(', ') || 'none'}.`, agent_id: 'relay-contract', reqs: [...result.added, ...result.vanished] });
  return { contract, created: false, added: result.added, vanished: result.vanished, drifted: true };
}

// The mechanical closure answer. Live drift (issue edited since the contract was read) is a problem until `update` merges it.
export async function check(cp, cfg, issue, { refreshFirst = false, requireAudit = true } = {}) {
  const { contract: stored } = await ensure(cp, cfg, issue);
  const gh = cp.getIssue(issue), comments = cp.listComments(issue);
  let contract = stored;
  const drifted = C.hasDrifted(stored, { ...gh, number: issue }, comments);
  if (drifted && refreshFirst) contract = (await refresh(cp, cfg, issue)).contract;
  const ev = C.evaluate(contract, { gh: { drifted: drifted && !refreshFirst }, requireAudit });
  if (gh.state === 'closed' && !(ev.closable)) ev.problems.push({ code: 'GITHUB_CLOSED', message: `GitHub says #${issue} is CLOSED but the contract is not complete: GitHub closed != contract complete` });
  const state = C.contractState(contract, { ghState: gh.state, labels: gh.labels });
  return { contract, ev, state, drifted, gh_state: gh.state, proposals: contract.source.scope_proposals || [] };
}

// ---- closing ---------------------------------------------------------------------------------------------
export async function releaseClaim(cp, cfg, issue, reason) {
  const a = analyze(cp.listComments(issue));
  const mine = a.valid || a.records.find((r) => r.status === 'expired');
  if (mine) cp.comment(issue, embed('release', { type: 'release', issue, agent_id: mine.claim.agent_id, nonce: mine.claim.nonce, reason, at: iso(now()) }, `RELEASED by relay-contract: ${reason}`));
  try { await updateState(cfg, (s) => { s.claims = s.claims.filter((x) => x.issue !== issue); }); } catch { /* STATE.json is a cache; relay-state rebuild repairs it */ }
}

const transient = (l) => l.startsWith('state:') || l.startsWith('handoff:') || /^review:(claude|codex|human|main|changes)$/.test(l);

// Close-out of an issue whose contract passed the gate (or of any issue when contracts are off): state:done, drop transient labels, close.
export async function closeIssueDone(cp, cfg, issue, { note } = {}) {
  const labels = cp.getIssue(issue).labels.filter((l) => !transient(l) && !CONTRACT_LABELS.includes(l));
  cp.setLabels(issue, [...labels, 'state:done', ...(enforced(cfg) ? [LABELS.complete] : [])]);
  if (note) cp.comment(issue, note);
  cp.closeIssue(issue);
  try { await updateState(cfg, (s) => { s.claims = s.claims.filter((c) => c.issue !== issue); }); } catch { /* STATE.json is a cache; relay-state rebuild repairs it */ }
}

// Audit then close, only when every gate passes. Returns {closed, ev}; never closes on a failing contract.
export async function closeIfComplete(cp, cfg, issue, { by = 'relay-contract', note } = {}) {
  let r = await check(cp, cfg, issue, { refreshFirst: true, requireAudit: false });
  if (!r.ev.closable) return { closed: false, ...r };
  if (r.gh_state === 'closed') return { closed: false, already_closed: true, ...r };
  await mutate(cp, cfg, issue, (cur) => C.setAudit(cur, { by, note: note || 'final acceptance audit: every requirement has an acceptable final disposition with its required evidence' }));
  r = await check(cp, cfg, issue, { requireAudit: true });
  if (!r.ev.closable) return { closed: false, ...r };
  await closeIssueDone(cp, cfg, issue, { note: `${C.renderBlock(r.contract, { ev: r.ev })}\n\nFinal acceptance audit passed (${by}). Closing #${issue}: the complete contract is satisfied.` });
  appendQuietly(cp, issue, { kind: 'summary', text: `Contract complete (${r.ev.counts.complete}/${r.ev.counts.total}); audited by ${by}; issue closed.`, agent_id: by, reqs: r.ev.pass });
  return { closed: true, ...r };
}

// ---- after a merge ---------------------------------------------------------------------------------------
// A merged PR is a slice. Record its coverage, then either close (contract complete) or put the issue back to work.
export async function settle(c, issue, { pr, branch, head_sha, body = '', verdict = null, ci = null, qa = 'n/a', by = 'relay-merge' } = {}) {
  const { cp, cfg } = c;
  await ensure(cp, cfg, issue);
  await refresh(cp, cfg, issue);
  const cov = C.parseCoverage(body);
  const promoted = [];
  await mutate(cp, cfg, issue, (cur) => {
    let next = C.recordMergedPR(cur, { pr, branch, head_sha, coverage: cov?.coverage || {}, completes_issue: cov?.completes_issue ?? null, qa });
    // Promote covered requirements only on real evidence: green CI + a reviewer verdict that marked the requirement PASS, no runtime proof required.
    const reviewed = verdict?.contract_coverage || {};
    for (const [id, how] of Object.entries(cov?.coverage || {})) {
      const r = next.requirements.find((x) => x.id === id);
      if (how !== 'implemented' || !r || C.COMPLETE_STATUSES.includes(r.status) || r.status === C.PARKED_STATUS) continue;
      const ev = [];
      if (ci) ev.push({ kind: 'test', ref: ci, pr, at: iso(now()), by });
      if (verdict?.comment_id && reviewed[id] === 'PASS') ev.push({ kind: 'review', ref: `verdict ${verdict.comment_id} on PR #${pr} marks ${id} PASS`, pr, at: iso(now()), by });
      ev.push({ kind: 'pr', ref: `merged PR #${pr}`, pr, at: iso(now()), by });
      const promotable = ci && reviewed[id] === 'PASS' && !r.requires?.runtime_proof && r.kind !== 'repro';
      try { next = C.mark(next, id, promotable ? 'FIXED_AND_VERIFIED' : ci && r.requires?.runtime_proof ? 'TESTS_ONLY' : r.status, { evidence: ev, by }); if (promotable) promoted.push(id); } catch { next.requirements.find((x) => x.id === id).evidence.push(...ev); }
    }
    return next;
  });
  if (promoted.length) appendQuietly(cp, issue, { kind: 'proof', text: `PR #${pr} merged: ${promoted.join(', ')} FIXED_AND_VERIFIED (green CI + reviewer CONTRACT_COVERAGE PASS; no runtime proof required).`, agent_id: by, reqs: promoted });
  return afterChange(c, issue, { reason: `PR #${pr} merged`, by, pr, slice: true });
}

// Re-evaluate and put the issue in the right place: closed (gate passed), ready (work remains), or blocked (only external waits remain).
export async function afterChange(c, issue, { reason = 'contract updated', by = 'relay-contract', pr = null, slice = false, announce = false } = {}) {
  const { cp, cfg } = c;
  if (!enforced(cfg)) return { mode: modeOf(cfg) };
  const done = await closeIfComplete(cp, cfg, issue, { by });
  if (done.closed) return { closed: true, ...done };
  const { ev, contract, state } = done;
  const gh = cp.getIssue(issue);
  if (gh.state === 'closed') return { closed: false, reopened: false, ev, state };
  const current = gh.labels.find((l) => l.startsWith('state:'))?.slice(6);
  if (!slice && ['claimed', 'in-progress', 'changes-requested', 'review'].includes(current)) {   // an agent is mid-flight: do not move the issue under it
    if (!gh.labels.includes(LABELS.open)) cp.setLabels(issue, [...gh.labels, LABELS.open]);
    return { closed: false, ev, state, contract };
  }
  const waitOnly = !ev.actionable && !ev.unresolved.length && ev.blocked.length > 0 && !ev.problems.some((p) => ['QA_PENDING', 'QA_FAILED', 'DRIFT', 'DRIFT_VANISHED'].includes(p.code));
  const to = waitOnly ? 'state:blocked' : 'state:ready';
  const labels = gh.labels.filter((l) => !transient(l) && ![LABELS.open, LABELS.blocked, LABELS.closedIncomplete].includes(l));
  const touched = !gh.labels.includes(to) || gh.labels.some((l) => transient(l) && l !== to) || !gh.labels.includes(LABELS.open);
  cp.setLabels(issue, [...labels, to, LABELS.open, ...(waitOnly ? [LABELS.blocked] : [])]);
  if (touched || pr || announce) {
    const lines = [`${reason}. This is one slice of #${issue}, not the issue: the contract is ${ev.counts.complete}/${ev.counts.total} complete (${state}).`, ...(ev.unresolved.length ? [`Remaining: ${ev.unresolved.map((r) => `${r.id} (${r.status})`).join(', ')}.`] : []), ...(ev.blocked.length ? [`Externally blocked: ${ev.blocked.map((r) => `${r.id} — ${r.what}`).join('; ')}.`] : []), ...ev.problems.filter((p) => ['QA_PENDING', 'QA_FAILED', 'AUDIT_NOT_RUN'].includes(p.code)).map((p) => p.message), waitOnly ? 'Only externally blocked items remain: waiting for the owner/external party; the issue is NOT complete.' : `The issue stays ACTIVE and returns to the queue (${to}); the next unresolved requirement is dispatched automatically.`];
    cp.comment(issue, lines.join('\n'));
    appendQuietly(cp, issue, { kind: 'progress', text: lines.slice(0, 2).join(' ').slice(0, 1100), agent_id: by, reqs: ev.unresolved.map((r) => r.id) });
  }
  if (slice) {
    await releaseClaim(cp, cfg, issue, waitOnly ? 'only externally blocked requirements remain' : 'slice merged; contract incomplete, issue returns to the queue');
    runScript(cfg, 'relay-worktree', ['remove', String(issue), '--if-clean']);
  }
  return { closed: false, to, ev, state, contract };
}

// ---- GitHub closed != contract complete ---------------------------------------------------------------------
export async function reconcileClosed(c, issue, { by = 'relay-reconcile' } = {}) {
  const { cp, cfg } = c;
  const gh = cp.getIssue(issue);
  if (gh.state !== 'closed') return { action: 'none', reason: 'issue is open' };
  const r = await check(cp, cfg, issue, { requireAudit: false });
  if (r.ev.closable) {
    if (!(r.contract.audit && r.contract.audit.rev === r.contract.rev)) await mutate(cp, cfg, issue, (cur) => C.setAudit(cur, { by, note: 'closed on GitHub with a complete contract; audit recorded at reconcile' }));
    cp.setLabels(issue, [...gh.labels.filter((l) => !CONTRACT_LABELS.includes(l)), LABELS.complete]);
    return { action: 'accepted', state: 'CONTRACT_COMPLETE', ...r };
  }
  const why = `GITHUB_CLOSED_CONTRACT_INCOMPLETE: #${issue} was closed on GitHub but ${r.ev.counts.unresolved + r.ev.counts.blocked} requirement(s) are not satisfied (${[...r.ev.unresolved, ...r.ev.blocked].map((x) => x.id).join(', ')}). Closed on GitHub is not proof.`;
  if (cfg.contract?.reopen_on_incomplete !== false) {
    cp.reopenIssue(issue);
    cp.setLabels(issue, [...gh.labels.filter((l) => !transient(l) && !CONTRACT_LABELS.includes(l)), 'state:ready', LABELS.open]);
    cp.comment(issue, `${why}\nRelay reopened the issue and returned it to the queue.`);
    appendQuietly(cp, issue, { kind: 'blocker', text: `${why} Reopened by ${by}.`.slice(0, 1100), agent_id: by, reqs: r.ev.unresolved.map((x) => x.id) });
    return { action: 'reopened', state: 'GITHUB_CLOSED_CONTRACT_INCOMPLETE', ...r };
  }
  cp.setLabels(issue, [...gh.labels.filter((l) => !CONTRACT_LABELS.includes(l)), LABELS.closedIncomplete]);
  cp.comment(issue, `${why}\nPolicy forbids reopening: reconcile by hand (reopen the issue or have the owner descope the remaining requirements).`);
  appendQuietly(cp, issue, { kind: 'blocker', text: why.slice(0, 1100), agent_id: by });
  try { await updateState(cfg, (s) => { const m = `#${issue}: GitHub closed with an incomplete contract`; s.release_blockers = [...new Set([...(s.release_blockers || []), m])]; }); } catch { /* cache */ }
  return { action: 'blocked', state: 'GITHUB_CLOSED_CONTRACT_INCOMPLETE', ...r };
}

// Closed issues that still carry contract:open / contract:closed-incomplete were closed outside the gate.
export function closedOutsideGate(cp) {
  const seen = new Map();
  for (const l of [LABELS.open, LABELS.closedIncomplete, LABELS.blocked]) for (const i of cp.listIssues({ state: 'closed', labels: [l] })) seen.set(i.number, i);
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

export async function sweep(c, { by = 'relay-reconcile' } = {}) {
  const out = [];
  for (const i of closedOutsideGate(c.cp)) out.push({ issue: i.number, ...(await reconcileClosed(c, i.number, { by })) });
  return out;
}

// ---- status / dashboard / stop-hook view -----------------------------------------------------------------------
// One row per contract-tracked issue: derived state, progress and what remains. `workable` = an agent can act on it now.
export function summaries(cp, cfg, { open = null, limit = 40 } = {}) {
  if (!enforced(cfg)) return [];
  const openIssues = open ?? cp.listIssues({ state: 'open' });
  const tracked = openIssues.filter((i) => i.labels.some((l) => CONTRACT_LABELS.includes(l) && l !== LABELS.complete));
  const rows = [];
  for (const i of [...tracked, ...closedOutsideGate(cp)].slice(0, limit)) {
    const f = load(cp, i.number);
    if (!f) continue;
    const ev = C.evaluate(f.contract, { requireAudit: true });
    const state = C.contractState(f.contract, { ghState: i.state, labels: i.labels });
    const ownerHeld = i.labels.includes('owner-decision') || (f.contract.decisions || []).some((d) => !d.requirement);
    const closedIncomplete = state === 'GITHUB_CLOSED_CONTRACT_INCOMPLETE';
    rows.push({
      issue: i.number, title: i.title, state, github_state: i.state, complete: ev.counts.complete, total: ev.counts.total, prs_merged: ev.counts.prs_merged, runtime_proof: ev.runtime_proof,
      remaining: ev.unresolved.map((r) => r.id), blocked: ev.blocked.map((r) => r.id), next: ev.next, problems: ev.problems.filter((p) => !['UNRESOLVED', 'BLOCKED_EXTERNAL'].includes(p.code)).map((p) => p.code),
      workable: closedIncomplete || (!ownerHeld && i.state === 'open' && (ev.actionable || ['close', 'audit'].includes(ev.next))),
    });
  }
  return rows;
}

// Release-blocking consistency check over every contract-tracked issue (open or closed).
export function releaseAudit(cp) {
  const findings = [];
  const labelled = new Map();
  for (const l of CONTRACT_LABELS) for (const st of ['open', 'closed']) for (const i of cp.listIssues({ state: st, labels: [l] })) labelled.set(i.number, i);
  for (const [n, i] of [...labelled].sort((a, b) => a[0] - b[0])) {
    const f = load(cp, n);
    if (!f) { if (i.state === 'closed') findings.push({ issue: n, code: 'NO_CONTRACT', message: `#${n} closed with a contract label but no stored contract` }); continue; }
    const ev = C.evaluate(f.contract, { requireAudit: false });
    if (i.state === 'closed') {
      if (!ev.closable) findings.push({ issue: n, code: 'CLOSED_INCOMPLETE', message: `#${n} is closed but ${ev.counts.unresolved + ev.counts.blocked} requirement(s) are unresolved: ${[...ev.unresolved, ...ev.blocked].map((r) => r.id).join(', ')}` });
      else if (!(f.contract.audit && f.contract.audit.rev === f.contract.rev)) findings.push({ issue: n, code: 'NO_AUDIT', message: `#${n} is closed without a recorded final acceptance audit` });
      for (const r of f.contract.requirements.filter((x) => !x.derived && ['NOT_VERIFIED', 'NOT_PROVED', 'UNKNOWN', 'UNCHECKED', 'TODO', 'MERGED_NOT_VERIFIED', 'TESTS_ONLY', 'FAIL'].includes(x.status))) findings.push({ issue: n, code: 'CLOSED_WITH_NOT_VERIFIED', message: `#${n} closed with ${r.id} ${r.status}` });
    }
    for (const p of ev.problems.filter((x) => ['MISSING_EVIDENCE', 'MISSING_TEST_EVIDENCE', 'MISSING_RUNTIME_PROOF'].includes(x.code))) findings.push({ issue: n, code: p.code, message: `#${n} ${p.message}` });
    for (const fu of f.contract.followups) {
      const stolen = fu.covers.filter((id) => { const r = f.contract.requirements.find((x) => x.id === id); return r && !C.COMPLETE_STATUSES.includes(r.status); });
      if (stolen.length && i.state === 'closed') findings.push({ issue: n, code: 'FOLLOWUP_STOLE_SCOPE', message: `#${n} closed while ${stolen.join(', ')} moved to follow-up #${fu.issue} without an owner scope change` });
    }
    for (const sc of f.contract.scope_changes.filter((x) => x.action === 'removed' && !x.ref)) findings.push({ issue: n, code: 'SCOPE_REMOVED_WITHOUT_OWNER', message: `#${n} ${sc.id} removed from scope without an owner reference` });
  }
  return findings;
}
