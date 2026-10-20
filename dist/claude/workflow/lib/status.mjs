import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState } from './state.mjs';
import { relayDir } from './config.mjs';
import { now } from './clock.mjs';
import * as Ops from './contractops.mjs';

const count = (issues, label) => issues.filter((i) => i.labels.includes(label)).length;

// Gather a status snapshot. The control plane is optional: if it fails we still report local state.
export function gather(cfg, cp) {
  const st = readState(cfg);
  const at = now();
  const snap = {
    mode: st.policy.mode, release_status: st.release_status, milestone: st.current_milestone,
    paused: fs.existsSync(path.join(relayDir(cfg), 'pause')), orchestrating: fs.existsSync(path.join(relayDir(cfg), 'orchestrating')),
    claims: st.claims.map((c) => ({ issue: c.issue, agent_id: c.agent_id, runtime: c.runtime, branch: c.branch, lease_until: c.lease_until, expired: new Date(c.lease_until) <= at })),
    owner_decisions: st.owner_decisions || [], control_plane: 'ok', issues: null, contracts: [],
    load: { load1: Number(os.loadavg()[0].toFixed(2)), cores: os.cpus().length },
  };
  try {
    const open = cp.listIssues({ state: 'open' });
    const workable = (i) => !i.labels.includes('owner-decision');
    snap.contracts = Ops.summaries(cp, cfg, { open });
    snap.issues = {
      backlog: count(open, 'state:backlog'), ready: open.filter((i) => i.labels.includes('state:ready') && workable(i)).length,
      claimed: count(open, 'state:claimed'), in_progress: count(open, 'state:in-progress'), review: count(open, 'state:review'),
      changes_requested: count(open, 'state:changes-requested'), blocked: count(open, 'state:blocked'), owner_decision: count(open, 'owner-decision'),
    };
  } catch (e) { snap.contracts = snap.contracts || []; snap.control_plane = `unavailable: ${String(e.message).split('\n')[0].slice(0, 120)}`; }
  const ledger = path.join(relayDir(cfg), 'ledger', 'usage.jsonl');
  if (fs.existsSync(ledger)) {
    const mix = { T0: 0, T1: 0, T2: 0, T3: 0 }; let n = 0;
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) { try { const r = JSON.parse(line); if (r.tier in mix) { mix[r.tier]++; n++; } } catch { /* skip */ } }
    snap.tier_mix = n ? Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, Number((v / n).toFixed(3))])) : null;
  }
  return snap;
}

export function renderBrief(s) {
  const i = s.issues;
  const lines = [
    `Relay: mode ${s.mode}${s.paused ? ' · PAUSED (.relay/pause)' : ''}${s.orchestrating ? ' · orchestrating' : ''} · control plane ${s.control_plane}`,
    i ? `Issues: ${i.ready} ready, ${i.claimed + i.in_progress} in flight, ${i.review} in review, ${i.changes_requested} changes requested, ${i.blocked} blocked, ${i.owner_decision} owner decisions` : 'Issues: (control plane unavailable)',
    `Claims: ${s.claims.length ? s.claims.map((c) => `#${c.issue} ${c.agent_id}${c.expired ? ' (LEASE EXPIRED)' : ''}`).join(', ') : 'none'}`,
  ];
  for (const c of s.contracts || []) {
    if (c.state === 'GITHUB_CLOSED_CONTRACT_INCOMPLETE') lines.push(`!! Issue #${c.issue} GITHUB_CLOSED_CONTRACT_INCOMPLETE — GitHub says closed, contract ${c.complete}/${c.total} (remaining ${c.remaining.concat(c.blocked).join(', ') || 'see check'}); run \`relay-contract reconcile ${c.issue}\``);
    else lines.push(`Issue #${c.issue} ${c.state}`, `  Contract: ${c.complete}/${c.total} complete`, `  PRs merged: ${c.prs_merged}`, `  Runtime proof: ${c.runtime_proof}`, ...(c.remaining.length || c.blocked.length ? [`  Remaining: ${c.remaining.concat(c.blocked).join(', ')}${c.blocked.length ? ` (externally blocked: ${c.blocked.join(', ')})` : ''}`] : []));
  }
  if (s.owner_decisions.length) lines.push(`Owner decisions: ${s.owner_decisions.map((d) => `#${d.issue} ${d.question}`).join('; ')}`);
  if (s.claims.some((c) => c.expired)) lines.push('Action: run `relay-lease sweep` to return expired claims to the queue.');
  lines.push('Recovery order: AGENTS.md → harness/STATE.json → relay-state claims → relay-lease sweep → ready issues.');
  return lines.join('\n');
}
