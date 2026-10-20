import crypto from 'node:crypto';
import { embed, extract } from './markers.mjs';
import { now, iso, addMinutes } from './clock.mjs';
import { stateOf } from './labels.mjs';
import { globsOverlap, matchesAny } from './glob.mjs';

export const newNonce = () => crypto.randomBytes(4).toString('hex');
export const slugify = (s) => String(s || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work';

export function claimBody(claim) {
  return embed('claim', claim, `CLAIMED\nLogical Agent: ${claim.role ?? 'n/a'} (${claim.agent_id}, ${claim.runtime})\nBranch: ${claim.branch}\nLease until: ${claim.lease_until}`);
}

// Order comments by server time then id (the claim arbiter).
const order = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id);

// Analyse an issue's comment stream into claim records.
// status: active | expired (lease passed, not swept) | released | swept | superseded
export function analyze(comments, at = now()) {
  const sorted = [...comments].sort(order);
  const recs = [];
  for (const c of sorted) {
    for (const m of extract(c.body)) {
      const d = m.data;
      if (m.type === 'claim' && d.nonce) recs.push({ comment_id: c.id, created_at: c.created_at, claim: d, lease_until: d.lease_until, heartbeat_at: null, status: 'active', ended: null });
      else if (['heartbeat', 'release', 'lease-expired'].includes(m.type)) {
        const r = recs.find((x) => x.claim.nonce === d.nonce);
        if (!r) continue;
        if (m.type === 'heartbeat' && r.status === 'active') { r.lease_until = d.lease_until; r.heartbeat_at = d.at || c.created_at; }
        if (m.type === 'release') { r.status = 'released'; r.ended = d.reason || 'release'; }
        if (m.type === 'lease-expired') { r.status = 'swept'; r.ended = 'lease-expired'; }
      }
    }
  }
  for (const r of recs) if (r.status === 'active' && new Date(r.lease_until) <= at) r.status = 'expired';
  const live = recs.filter((r) => r.status === 'active');
  const valid = live[0] || null;
  for (const r of live.slice(1)) r.status = 'superseded';
  return { records: recs, valid, last: recs.at(-1) || null };
}

export function activeClaimOf(cp, issue, at = now()) {
  return analyze(cp.listComments(issue), at);
}

// Rebuild the STATE.json claims registry from GitHub (the source of truth).
export function rebuildClaims(cp, cfg, existing = []) {
  const seen = new Map();
  for (const s of ['claimed', 'in-progress']) for (const i of cp.listIssues({ state: 'open', labels: [`state:${s}`] })) seen.set(i.number, i);
  const out = [];
  for (const [n] of seen) {
    const { valid } = analyze(cp.listComments(n));
    if (!valid) continue;
    const c = valid.claim;
    const prev = existing.find((e) => e.nonce === c.nonce);
    out.push({ issue: n, agent_id: c.agent_id, runtime: c.runtime, role: c.role ?? null, branch: c.branch, worktree: prev?.worktree ?? null, owned_paths: c.owned_paths || [], claimed_at: c.claimed_at, lease_until: valid.lease_until, heartbeat_at: valid.heartbeat_at, nonce: c.nonce });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

// Owned-path overlap against other live claims; shared append-only paths are exempt.
export function findOverlap(owned, claims, cfg, selfIssue, at = now()) {
  const shared = cfg.shared_append_only || [];
  const exempt = (g) => shared.includes(g) || matchesAny(shared, g);
  const hits = [];
  for (const c of claims) {
    if (c.issue === selfIssue || new Date(c.lease_until) <= at) continue;
    for (const a of owned) for (const b of c.owned_paths || []) {
      if (exempt(a) || exempt(b)) continue;
      if (globsOverlap(a, b)) hits.push({ issue: c.issue, mine: a, theirs: b });
    }
  }
  return hits;
}

export const leaseUntil = (minutes, at = now()) => iso(addMinutes(at, minutes));
