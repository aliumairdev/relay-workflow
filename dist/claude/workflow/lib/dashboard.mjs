// Dashboard snapshot: who is doing what, who is idle. Read-only; derived from STATE.json, the governor registry,
// the usage ledger and the control plane. The control plane is optional (local state still renders).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readState } from './state.mjs';
import { relayDir } from './config.mjs';
import { readAll } from './ledger.mjs';
import { findLog } from './journal.mjs';
import { now } from './clock.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const RECENT_MS = 6 * 3600e3;

export function snapshot(cfg, cp) {
  const at = now();
  const st = readState(cfg);
  const gov = readJson(path.join(relayDir(cfg), 'governor.json')) || { running: {}, rate_limits: {} };
  const rows = readAll(cfg);
  const snap = { generated_at: at.toISOString(), project: cfg.project.name, repo: cfg.project.repo, mode: st.policy.mode, paused: fs.existsSync(path.join(relayDir(cfg), 'pause')), orchestrating: fs.existsSync(path.join(relayDir(cfg), 'orchestrating')), control_plane: 'ok', load: { load1: Number(os.loadavg()[0].toFixed(2)), cores: os.cpus().length } };

  const agents = new Map();
  const upsert = (id, v) => agents.set(id, { agent_id: id, status: 'idle', ...agents.get(id), ...v });

  for (const r of rows.filter((x) => x.agent_id && Date.parse(x.ts) > at.getTime() - RECENT_MS)) upsert(r.agent_id, { runtime: r.runtime, last_seen: r.ts, last_outcome: r.outcome, role: r.task_class });
  for (const [runId, r] of Object.entries(gov.running || {})) upsert(r.agent_id || runId, { runtime: r.runtime, status: 'working', task: r.task_class, issue: r.issue ?? null, pr: r.pr ?? null, run_id: runId, since: r.started_at });
  for (const [runId, rl] of Object.entries(gov.rate_limits || {})) {
    const run = gov.running?.[runId];
    if (run && rl.next_at && Date.parse(rl.next_at) > at.getTime()) upsert(run.agent_id || runId, { status: 'waiting', reason: `rate limited (attempt ${rl.attempts})`, resume_at: rl.next_at });
  }
  for (const c of st.claims) {
    const expired = Date.parse(c.lease_until) <= at.getTime();
    const prev = agents.get(c.agent_id);
    upsert(c.agent_id, { runtime: c.runtime, issue: c.issue, branch: c.branch, lease_until: c.lease_until, status: expired ? 'stale' : prev?.status === 'waiting' ? 'waiting' : 'working', task: prev?.task || 'implement', ...(expired ? { reason: 'lease expired: run relay-lease sweep' } : {}) });
  }

  const issues = { by_state: {}, lists: { ready: [], review: [], blocked: [], in_flight: [] }, owner_decisions: st.owner_decisions || [] };
  const feed = [];
  try {
    const open = cp.listIssues({ state: 'open' });
    const state = (i) => i.labels.find((l) => l.startsWith('state:'))?.slice(6) || 'none';
    for (const i of open) issues.by_state[state(i)] = (issues.by_state[state(i)] || 0) + 1;
    const pick = (s) => open.filter((i) => state(i) === s).slice(0, 8).map((i) => ({ number: i.number, title: i.title, labels: i.labels.filter((l) => /^(agent|priority|type):/.test(l)) }));
    issues.lists.ready = pick('ready'); issues.lists.review = pick('review'); issues.lists.blocked = pick('blocked');
    issues.lists.in_flight = [...pick('claimed'), ...pick('in-progress')];
    // latest journal entry per claimed issue = what the agent says it is doing
    for (const c of st.claims.slice(0, 12)) {
      const f = findLog(cp.listComments(c.issue));
      const last = f?.log.entries.at(-1);
      if (last) { upsert(c.agent_id, { doing: last.text.slice(0, 200), doing_kind: last.kind, doing_at: last.at }); }
      for (const e of (f?.log.entries || []).slice(-3)) feed.push({ at: e.at, issue: c.issue, agent: e.agent_id, kind: e.kind, text: e.text.slice(0, 160) });
    }
    snap.prs_open = cp.listPRs('open').length;
  } catch (e) { snap.control_plane = `unavailable: ${String(e.message).split('\n')[0].slice(0, 100)}`; }
  for (const r of rows.slice(-12)) feed.push({ at: r.ts, issue: r.issue ?? null, agent: r.agent_id || r.runtime, kind: r.task_class, text: `${r.outcome}${r.reason ? `: ${r.reason}` : ''}${r.pr ? ` (PR #${r.pr})` : ''}` });

  const order = { working: 0, waiting: 1, stale: 2, idle: 3 };
  const list = [...agents.values()].sort((a, b) => order[a.status] - order[b.status] || String(a.agent_id).localeCompare(b.agent_id));
  const max = Math.min(cfg.concurrency.max_agents, cfg.concurrency.hard_max);
  const enabled = Object.entries(cfg.runtimes || {}).filter(([, r]) => r.enabled !== false).map(([n]) => n);
  snap.runtimes = enabled.map((rt) => { const mine = list.filter((a) => a.runtime === rt); const busy = mine.filter((a) => ['working', 'waiting'].includes(a.status)).length; return { runtime: rt, working: mine.filter((a) => a.status === 'working').length, waiting: mine.filter((a) => a.status === 'waiting').length, stale: mine.filter((a) => a.status === 'stale').length, idle_agents: mine.filter((a) => a.status === 'idle').length, free_slots: Math.max(0, max - busy) }; });
  snap.agents = list;
  snap.counts = { working: list.filter((a) => a.status === 'working').length, waiting: list.filter((a) => a.status === 'waiting').length, stale: list.filter((a) => a.status === 'stale').length, idle: list.filter((a) => a.status === 'idle').length };
  snap.issues = issues;
  snap.feed = feed.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25);
  return snap;
}
