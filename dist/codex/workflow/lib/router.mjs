// Deterministic, offline routing engine (ARCHITECTURE 3.3, PLUGIN_SPEC 8). No model calls, no I/O.
import { matches, matchesAny } from './glob.mjs';
import { RelayError, EXIT } from './exit.mjs';

export const TIERS = ['T0', 'T1', 'T2', 'T3'];
const tierUp = (t, max = 'T2') => TIERS[Math.min(TIERS.indexOf(t) + 1, TIERS.indexOf(max))];
const REVIEW_CLASSES = ['routine_review', 'high_risk_review'];

export const DEFAULT_ROUTING = {
  allow_high_effort: false, default_effort: 'medium', packet_max_words: 500,
  task_classes: {
    plan: { tier: 'T1', upgrade_if: { novelty: 'high', tier: 'T2' } },
    implement: { tier: 'T1' },
    routine_review: { tier: 'T1' },
    high_risk_review: { tier: 'T2', packet: 'required' },
    docs: { tier: 'T0' },
    audit: { tier: 'T2', packet: 'required' },
    debug_real_env: { tier: 'T1', escalate_after_attempts: 2, escalate_to: 'T2' },
    conflict_resolution: { tier: 'T1', script_first: true },
    triage: { tier: 'T0', effort: 'low' },
  },
  risk: { thresholds: { second_reviewer: 40, senior: 80 }, hard_senior_paths: [], signals: [], path_cap: 60 },
  escalation: { failed_reviews: 2, failed_proof: 1, unknown_root_cause_attempts: 2 },
  deescalation: { clean_first_pass_streak: 10, propose_only: true },
  overrides: { agents: {}, labels: {} },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = k in a ? merge(a[k], b[k]) : b[k];
  return out;
}
export const routingOf = (cfg) => merge(DEFAULT_ROUTING, cfg?.routing || {});

// ---- risk -------------------------------------------------------------------------------------
export function riskScore(input, routing) {
  const labels = input.labels || [], paths = input.paths || [];
  const files = input.files ?? paths.length, lines = input.lines ?? 0, rework = input.rework_rounds ?? 0;
  const signals = []; let pathPoints = 0;
  let size = null, rw = null;
  for (const s of routing.risk.signals || []) {
    if (s.kind === 'path') {
      const hit = paths.find((p) => matchesAny(s.globs, p));
      if (hit) { pathPoints += s.points; signals.push({ kind: 'path', matched: hit, points: s.points }); }
    } else if (s.kind === 'label') {
      const hit = (s.any || []).find((l) => labels.includes(l));
      if (hit) signals.push({ kind: 'label', matched: hit, points: s.points });
    } else if (s.kind === 'size') {
      const over = (s.files_gt != null && files > s.files_gt) || (s.lines_gt != null && lines > s.lines_gt);
      if (over && (!size || s.points > size.points)) size = { kind: 'size', files, lines, points: s.points };
    } else if (s.kind === 'rework') {
      if (rework >= s.rounds_gte && (!rw || s.points > rw.points)) rw = { kind: 'rework', rounds: rework, points: s.points };
    } else if (s.kind === 'proof_failed') {
      if (input.proof_failed) signals.push({ kind: 'proof_failed', points: s.points });
    } else if (s.kind === 'paths_only') {
      if (paths.length && paths.every((p) => matchesAny(s.globs, p))) signals.push({ kind: 'paths_only', points: s.points });
    }
  }
  if (size) signals.push(size);
  if (rw) signals.push(rw);
  const cap = routing.risk.path_cap ?? 60;
  if (pathPoints > cap) signals.push({ kind: 'path_cap', points: cap - pathPoints });
  const raw = signals.reduce((n, s) => n + s.points, 0);
  const hard = (routing.risk.hard_senior_paths || []).map((g) => ({ g, hit: paths.find((p) => matches(g, p)) })).filter((x) => x.hit).map((x) => ({ kind: 'hard_senior_path', glob: x.g, matched: x.hit }));
  return { score: Math.max(0, Math.min(100, raw)), signals, hard_rules: hard };
}

// ---- budget caps ------------------------------------------------------------------------------
export function capCheck(tier, share = {}, budgets = {}) {
  const max = budgets.tier_share_max || {};
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  if (tier === 'T2' || tier === 'T3') {
    if (max[tier] != null && (share[tier] || 0) >= max[tier]) return { ok: false, reason: `${tier} share ${pct(share[tier] || 0)} is at or above the ${pct(max[tier])} cap` };
    const top = (share.T2 || 0) + (share.T3 || 0);
    if (max.top_combined != null && top >= max.top_combined) return { ok: false, reason: `top-tier share ${pct(top)} is at or above the ${pct(max.top_combined)} combined cap` };
  }
  return { ok: true };
}

// ---- runtimes ---------------------------------------------------------------------------------
export function enabledRuntimes(cfg) {
  const names = Object.entries(cfg?.runtimes || {}).filter(([, r]) => r.enabled !== false).map(([n]) => n);
  return names.length ? names : ['claude'];
}
const modelFor = (cfg, rt, tier) => cfg?.runtimes?.[rt]?.models?.[tier] ?? cfg?.tiers?.[tier]?.[rt] ?? null;

export function pickRuntime(cfg, { labels = [], paths = [], review = false, implementer = null }) {
  const enabled = enabledRuntimes(cfg), pol = cfg?.runtime_policy || {};
  const order = (pol.fallback_order || enabled).filter((r) => enabled.includes(r));
  const reasons = [];
  const owner = labels.map((l) => /^agent:(claude|codex|gemini)$/.exec(l)?.[1]).find(Boolean);
  if (review && (cfg?.review?.cross_runtime ?? true)) {
    const impl = implementer || owner;
    if (impl) {
      const other = order.find((r) => r !== impl) || enabled.find((r) => r !== impl);
      if (other) return { runtime: other, same_runtime: false, reasons: [`cross-review: implementer runtime is ${impl}`] };
      return { runtime: impl, same_runtime: true, reasons: [`cross-review impossible: only ${impl} enabled; use a different agent instance and role file`] };
    }
  }
  if (owner && enabled.includes(owner)) return { runtime: owner, same_runtime: false, reasons: [`owner label agent:${owner}`] };
  for (const r of pol.rules || []) {
    const w = r.when || {};
    const hit = (w.labels_any || []).some((l) => labels.includes(l)) || (w.paths_any || []).some((g) => paths.some((p) => matches(g, p)));
    if (hit && enabled.includes(r.prefer)) { reasons.push(`runtime_policy rule prefers ${r.prefer}`); return { runtime: r.prefer, same_runtime: false, reasons }; }
  }
  const def = pol.default && pol.default !== 'any' && enabled.includes(pol.default) ? pol.default : order[0] || enabled[0];
  return { runtime: def, same_runtime: false, reasons: [`default runtime ${def}`] };
}

// ---- decision ---------------------------------------------------------------------------------
export function decide(input, cfg = {}) {
  const routing = routingOf(cfg);
  const labels = input.labels || [], reasons = [];
  let cls = input.class;
  if (input.release_candidate) { cls = 'audit'; reasons.push('release candidate: audit class (hard rule)'); }
  const cdef = routing.task_classes[cls];
  if (!cdef) throw new RelayError(`unknown task class "${cls}" (one of ${Object.keys(routing.task_classes).join(', ')})`, EXIT.INVALID);
  const review = cls === 'routine_review';
  const risk = riskScore(input, routing);
  const th = routing.risk.thresholds;

  let tier = cdef.tier, packet = cdef.packet === 'required', secondReviewer = false, preReview = null, agentNeeded = true;

  if (cls === 'plan' && cdef.upgrade_if && input.novelty === cdef.upgrade_if.novelty) { tier = cdef.upgrade_if.tier; reasons.push(`novelty ${input.novelty}: ${tier}`); }
  if (cls === 'debug_real_env') {
    const after = cdef.escalate_after_attempts ?? routing.escalation.unknown_root_cause_attempts;
    if ((input.attempt ?? 1) > after && !input.root_cause_known) { tier = cdef.escalate_to || 'T2'; packet = true; reasons.push(`attempt ${input.attempt} > ${after} without root cause: ${tier}`); }
    if (input.t2_attempts_unresolved && input.cross_system) { tier = 'T3'; packet = true; reasons.push('root cause unknown after a T2 attempt with cross-system implications: T3 via packet'); }
  }
  if (cls === 'conflict_resolution' && cdef.script_first && input.resolver_exit === 0) { agentNeeded = false; reasons.push('resolver exit 0: no agent needed'); }
  if (cls === 'conflict_resolution' && input.resolver_exit === 2) reasons.push('resolver exit 2: agent resolves the leftovers');

  if (review) {
    if (risk.hard_rules.length) { tier = 'T2'; packet = true; reasons.push(`hard senior path ${risk.hard_rules[0].matched}: T2`); }
    else if (risk.score >= th.senior) { tier = 'T2'; packet = true; preReview = cdef.tier; reasons.push(`score ${risk.score} >= ${th.senior}: ${preReview} pre-review, packet, senior review`); }
    else if (risk.score >= th.second_reviewer) { secondReviewer = true; reasons.push(`score ${risk.score} >= ${th.second_reviewer}: second reviewer`); }
  }

  // escalation (one tier up, never past T2 automatically)
  const esc = routing.escalation;
  let escalatedFrom = null;
  if ((input.failed_reviews ?? 0) >= esc.failed_reviews && tier !== 'T2') { escalatedFrom = tier; tier = tierUp(tier); reasons.push(`${input.failed_reviews} failed reviews: ${escalatedFrom} -> ${tier}`); }
  else if (input.from_failed_proof && (input.failed_proofs ?? 1) >= esc.failed_proof && tier !== 'T2') { escalatedFrom = tier; tier = tierUp(tier); reasons.push(`follows a failed real-environment proof: ${escalatedFrom} -> ${tier}`); }

  // overrides: CLI flag > route label > agent pin
  let override = null;
  const routeLabel = labels.find((l) => /^route:T[0-3]$/.test(l));
  if (input.override?.tier) override = { source: 'flag', tier: input.override.tier, reason: input.override.reason || null };
  else if (routeLabel) override = { source: `label ${routeLabel}`, tier: routing.overrides.labels?.[routeLabel]?.tier || routeLabel.slice(6), reason: null };
  else if (input.agent && routing.overrides.agents?.[input.agent]?.tier) override = { source: `agent ${input.agent}`, tier: routing.overrides.agents[input.agent].tier, reason: null };
  if (override) { reasons.push(`override (${override.source}): ${override.tier}`); tier = override.tier; }
  if (TIERS.indexOf(tier) >= 2) packet = true;

  // cap
  const share = input.history?.tier_share || {};
  const cap = capCheck(tier, share, cfg.budgets);
  const denied = !cap.ok && !override;
  if (!cap.ok && override) reasons.push(`cap bypassed by override: ${cap.reason}`);

  // effort
  let effort = cdef.effort || cfg.tiers?.[tier]?.effort || routing.default_effort;
  if (input.requested_effort) {
    if (input.requested_effort === 'high' && !routing.allow_high_effort) reasons.push(`effort high refused (allow_high_effort: false): ${routing.default_effort}`), (effort = routing.default_effort);
    else effort = input.requested_effort;
  }

  // runtime and model
  const rtc = pickRuntime(cfg, { labels, paths: input.paths || [], review, implementer: input.implementer_runtime });
  let runtime = rtc.runtime; reasons.push(...rtc.reasons);
  let model = modelFor(cfg, runtime, tier);
  if (!model) {
    const alt = enabledRuntimes(cfg).find((r) => r !== runtime && modelFor(cfg, r, tier));
    if (alt && !(review && rtc.same_runtime === false && (cfg.review?.cross_runtime ?? true) && (input.implementer_runtime || labels.some((l) => l === `agent:${alt}`)) && alt === input.implementer_runtime)) { reasons.push(`${runtime} has no ${tier} model: using ${alt}`); runtime = alt; model = modelFor(cfg, alt, tier); }
  }

  const decision = {
    tier: agentNeeded ? tier : null, model: agentNeeded ? model : null, runtime, effort, agent_needed: agentNeeded,
    second_reviewer: secondReviewer, reviewer_tier: review ? (tier) : null, pre_review_tier: preReview,
    packet_required: agentNeeded && packet, same_runtime: !!rtc.same_runtime, max_tokens: cfg.budgets?.max_tokens_per_task?.[tier] ?? null,
  };
  if (secondReviewer) {
    const second = enabledRuntimes(cfg).find((r) => r !== runtime);
    decision.second_reviewer_runtime = second || runtime;
  }
  const result = {
    target: input.target || null, task_class: cls,
    risk: { score: risk.score, signals: risk.signals, hard_rules: risk.hard_rules },
    decision, reasons,
    budget: { tier_share_now: share, cap_ok: cap.ok, per_pr_spent_usd: input.history?.per_pr_spent_usd ?? 0 },
    overridden: !!override, override, escalation_from: escalatedFrom,
  };
  if (override) result.ledger_note = `override_by ${input.override?.by || 'label'}: ${override.source} -> ${override.tier}${override.reason ? ` (${override.reason})` : ''}`;
  if (denied) {
    result.denied = true;
    result.reasons.push(`denied: ${cap.reason}`);
    result.decision.fallback = { tier: cdef.tier === 'T2' ? 'T1' : 'T1', second_reviewer: review || cls === 'high_risk_review', requires_owner_approval: true, runtime };
  }
  return result;
}

// ---- feedback proposals (never applied) -----------------------------------------------------
// rows: ledger rows. Proposes (a) downgrade when the last N T2 results of a class were clean first passes,
// (b) adding review scrutiny where T1-only approvals later escaped (outcome failed on the same issue).
export function propose(rows, cfg = {}) {
  const routing = routingOf(cfg), n = routing.deescalation.clean_first_pass_streak;
  const out = [];
  const byClass = {};
  for (const r of rows) if (r.tier === 'T2' || r.tier === 'T3') (byClass[r.task_class] ||= []).push(r);
  for (const [cls, list] of Object.entries(byClass)) {
    const tail = list.slice(-n);
    if (tail.length >= n && tail.every((r) => r.outcome === 'approved' || r.outcome === 'done')) out.push({ kind: 'downgrade', task_class: cls, from: tail.at(-1).tier, to: 'T1', with_second_reviewer: true, evidence: `${n} consecutive clean first-pass results at ${tail.at(-1).tier}`, apply: 'edit workflow.yaml routing.task_classes (owner approval required)' });
  }
  const t1Approved = new Set(rows.filter((r) => r.tier === 'T1' && r.outcome === 'approved' && r.issue != null).map((r) => r.issue));
  const escaped = rows.filter((r) => (r.outcome === 'failed' || r.task_class === 'debug_real_env') && r.issue != null && t1Approved.has(r.issue));
  if (escaped.length) out.push({ kind: 'add_risk_scrutiny', issues: [...new Set(escaped.map((r) => r.issue))], evidence: `${escaped.length} defect(s) found after T1-only approval`, apply: 'add the affected paths to routing.risk.signals (owner approval required)' });
  return out;
}

export function explain(result) {
  const lines = [`task class: ${result.task_class}`, `risk score: ${result.risk.score}`];
  for (const s of result.risk.signals) lines.push(`  ${s.points >= 0 ? '+' : ''}${s.points}  ${s.kind}${s.matched ? ` (${s.matched})` : ''}`);
  for (const h of result.risk.hard_rules) lines.push(`  hard rule: ${h.kind} ${h.matched}`);
  const d = result.decision;
  lines.push(`decision: ${d.tier ?? 'no agent'} ${d.model ?? ''} on ${d.runtime}, effort ${d.effort}${d.second_reviewer ? ', second reviewer' : ''}${d.packet_required ? ', packet required' : ''}`);
  for (const r of result.reasons) lines.push(`- ${r}`);
  return lines.join('\n');
}
