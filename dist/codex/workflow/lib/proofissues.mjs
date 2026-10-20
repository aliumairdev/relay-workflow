import { readAll } from './ledger.mjs';
import { appendQuietly } from './journal.mjs';
import { TIERS } from './router.mjs';
import { closesIssue } from './issue.mjs';
import path from 'node:path';
import * as C from './contract.mjs';
import * as Ops from './contractops.mjs';

// Tier of the work that introduced a defect, raised by one (capped at T2): the next dispatch is routed higher.
export function nextTierFor(cfg, { issue, pr }) {
  const rows = readAll(cfg).filter((r) => (issue != null && r.issue === issue) || (pr != null && r.pr === pr));
  const used = rows.filter((r) => ['implement', 'debug_real_env'].includes(r.task_class)).map((r) => TIERS.indexOf(r.tier)).filter((i) => i >= 0);
  const base = used.length ? Math.max(...used) : TIERS.indexOf('T1');
  return TIERS[Math.min(base + 1, TIERS.indexOf('T2'))];
}

// One bug issue per distinct failure, routed one tier higher; deduplicated against open issues by title.
export async function raiseOnProofFailure(cfg, cp, result, { ref, issue = null, pr = null, summaryPath }) {
  if (pr && !issue) { try { issue = closesIssue(cp.getPR(pr).body); } catch { /* unknown PR */ } }
  const tier = nextTierFor(cfg, { issue, pr });
  const open = cp.listIssues({ state: 'open' });
  const created = [];
  for (const it of result.items.filter((i) => i.status === 'fail')) {
    const title = `Proof failed (${result.stage}): ${it.name} @ ${String(ref).slice(0, 12)}`;
    const dup = open.find((o) => o.title === title);
    if (dup) { created.push({ number: dup.number, duplicate: true }); continue; }
    const body = `## Objective\nFix the failure found by the real-environment proof stage.\n\n## Context\nStage \`${result.stage}\` at \`${ref}\`${issue ? `, introduced by work on #${issue}` : ''}.\n\n## Evidence\n\`\`\`\n${it.evidence}\n\`\`\`\n${it.url ? `URL: ${it.url}\n` : ''}Summary: \`${path.relative(cfg.__root, summaryPath)}\`\n\n## Acceptance Criteria\n- [ ] Root cause stated with the evidence line that supports it (see the real-env-proof skill) before any edit\n- [ ] \`relay-proof --stage ${result.stage} --ref <fix>\` passes for this item\n- [ ] If the harness missed it, a lint rule or fixture now catches it offline\n\n## Risk\nhigh (found on the real platform)\n`;
    const bug = cp.createIssue({ title, body, labels: ['type:bug', 'state:ready', 'priority:p1', 'agent:any', `route:${tier}`] });
    created.push({ number: bug.number, route: tier });
    if (issue) {
      cp.comment(issue, `Real-environment proof failed after this work (${result.stage} @ ${String(ref).slice(0, 12)}): ${it.name}. Bug filed as #${bug.number}, routed ${tier}.`);
      appendQuietly(cp, issue, { kind: 'blocker', text: `Proof failure ${it.name}: filed #${bug.number} (route ${tier}). ${it.evidence.split('\n')[0]}`.slice(0, 1100), agent_id: 'relay-proof' });
    }
  }
  // A proof failure means the work is not verified: the owning issue goes back to implementation (never stays "merged = done").
  if (issue && created.length && Ops.enforced(cfg)) {
    try {
      const cur = Ops.load(cp, issue)?.contract;
      if (cur) {
        await Ops.mutate(cp, cfg, issue, (c) => { let n = c; for (const p of c.prs.filter((x) => x.merged && (pr == null || x.pr === pr))) n = C.setQA(n, p.pr, 'fail'); return n; });
        await Ops.afterChange({ cp, cfg }, issue, { reason: `proof failed (${result.stage})`, by: 'relay-proof', announce: true });
      }
    } catch (e) { process.stderr.write(`warning: contract not updated after proof failure (${e.message})\n`); }
  }
  return created;
}
