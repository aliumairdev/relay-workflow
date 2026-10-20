// Usage report from the ledger (ARCHITECTURE 10.4). Pure over rows.
import { priceRow } from './ledger.mjs';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const rowCost = (cfg, r) => r.cost_usd ?? priceRow(cfg, r) ?? 0;
const tok = (r) => (r.tokens_in || 0) + (r.tokens_out || 0);

export function buildReport(rows, cfg = {}, { merged = [] } = {}) {
  const work = rows.filter((r) => !['admitted'].includes(r.outcome));
  const priced = work.filter((r) => r.outcome !== 'fallback');
  const totalTokens = priced.reduce((n, r) => n + tok(r), 0);
  const tiers = {};
  for (const r of priced) {
    const t = (tiers[r.tier] ||= { runs: 0, tokens: 0, cost_usd: 0 });
    t.runs += 1; t.tokens += tok(r); t.cost_usd = r4(t.cost_usd + rowCost(cfg, r));
  }
  const tierMix = {};
  const caps = cfg.budgets?.tier_share_max || {}, targets = cfg.budgets?.tier_share_target || {};
  for (const t of ['T0', 'T1', 'T2', 'T3']) {
    const x = tiers[t] || { runs: 0, tokens: 0, cost_usd: 0 };
    const share = totalTokens > 0 ? x.tokens / totalTokens : priced.length ? x.runs / priced.length : 0;
    tierMix[t] = { ...x, share: r4(share), cap: caps[t] ?? null, over_cap: caps[t] != null && share > caps[t], target: targets[t] ?? null };
  }
  const topShare = (tierMix.T2.share + tierMix.T3.share);
  const topCombined = { share: r4(topShare), cap: caps.top_combined ?? null, over_cap: caps.top_combined != null && topShare > caps.top_combined };

  // PR <-> issue links: any row carrying both ties them together.
  const prIssues = {};
  for (const r of work) if (r.pr != null && r.issue != null) (prIssues[r.pr] ||= new Set()).add(r.issue);
  const mergedPrs = new Set([...merged, ...work.filter((r) => r.task_class === 'merge' && r.outcome === 'done' && r.pr != null).map((r) => r.pr)]);
  const perPr = {};
  for (const pr of mergedPrs) {
    const issues = prIssues[pr] || new Set();
    perPr[pr] = r4(work.filter((r) => r.pr === pr || (r.pr == null && r.issue != null && issues.has(r.issue))).reduce((n, r) => n + rowCost(cfg, r), 0));
  }
  const costs = Object.values(perPr);
  const costPerMergedPr = { merged_prs: costs.length, mean_usd: costs.length ? r4(costs.reduce((a, b) => a + b, 0) / costs.length) : null, by_pr: perPr };

  const rework = {};
  for (const r of work.filter((x) => ['approved', 'changes_requested'].includes(x.outcome))) {
    const k = `${r.tier}/${r.runtime}`;
    const x = (rework[k] ||= { reviews: 0, changes_requested: 0 });
    x.reviews += 1; if (r.outcome === 'changes_requested') x.changes_requested += 1;
  }
  for (const x of Object.values(rework)) x.rework_rate = r4(x.changes_requested / x.reviews);

  const byRuntime = {};
  for (const r of priced) { const x = (byRuntime[r.runtime] ||= { runs: 0, tokens: 0, cost_usd: 0 }); x.runs += 1; x.tokens += tok(r); x.cost_usd = r4(x.cost_usd + rowCost(cfg, r)); }

  return {
    rows: rows.length, total_cost_usd: r4(priced.reduce((n, r) => n + rowCost(cfg, r), 0)), total_tokens: totalTokens,
    tier_mix: tierMix, top_combined: topCombined, cost_per_merged_pr: costPerMergedPr, by_runtime: byRuntime, rework_by_tier_runtime: rework,
    escalations: work.filter((r) => r.outcome === 'escalated' || r.escalation_from).length,
    rate_limit_incidents: rows.filter((r) => r.rate_limit).length, fallbacks: rows.filter((r) => r.outcome === 'fallback').length,
    unpriced_rows: priced.filter((r) => r.cost_usd == null && priceRow(cfg, r) === undefined).length,
  };
}

export function renderMarkdown(rep, { since } = {}) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const L = [`# Relay usage report${since ? ` (since ${since})` : ''}`, '', `Rows: ${rep.rows} · tokens: ${rep.total_tokens} · cost: ${rep.total_cost_usd} USD`, '',
    '## Tier mix vs caps', '', '| Tier | Runs | Tokens | Cost USD | Share | Cap |', '|---|---|---|---|---|---|'];
  for (const [t, x] of Object.entries(rep.tier_mix)) L.push(`| ${t} | ${x.runs} | ${x.tokens} | ${x.cost_usd} | ${pct(x.share)}${x.over_cap ? ' **OVER**' : ''} | ${x.cap != null ? pct(x.cap) : '-'} |`);
  L.push('', `Top tiers combined: ${pct(rep.top_combined.share)}${rep.top_combined.cap != null ? ` (cap ${pct(rep.top_combined.cap)})` : ''}${rep.top_combined.over_cap ? ' **OVER**' : ''}`, '',
    '## Cost per merged PR', '', `Merged PRs: ${rep.cost_per_merged_pr.merged_prs} · mean: ${rep.cost_per_merged_pr.mean_usd ?? 'n/a'} USD`, '');
  for (const [pr, c] of Object.entries(rep.cost_per_merged_pr.by_pr)) L.push(`- #${pr}: ${c} USD`);
  L.push('', '## Rework by tier/runtime', '', '| Tier/runtime | Reviews | Changes requested | Rate |', '|---|---|---|---|');
  for (const [k, x] of Object.entries(rep.rework_by_tier_runtime)) L.push(`| ${k} | ${x.reviews} | ${x.changes_requested} | ${pct(x.rework_rate)} |`);
  L.push('', `Escalations: ${rep.escalations} · rate-limit incidents: ${rep.rate_limit_incidents} · fallbacks: ${rep.fallbacks}`);
  if (rep.unpriced_rows) L.push(`Note: ${rep.unpriced_rows} row(s) have no price (add tiers.<T>.price_usd_per_mtok to workflow.yaml).`);
  return L.join('\n') + '\n';
}
