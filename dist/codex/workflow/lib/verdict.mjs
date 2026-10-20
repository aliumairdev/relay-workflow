import { extract } from './markers.mjs';
import { git } from './exec.mjs';

// All verdict markers on a PR, oldest first.
export function verdictsOf(cp, pr) {
  const out = [];
  for (const c of [...cp.listComments(pr)].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id))) {
    for (const m of extract(c.body, 'verdict')) out.push({ ...m.data, comment_id: c.id });
  }
  return out;
}

// Is the verdict on `vsha` still valid for head `head`? Same sha, or only merge commits (default-branch syncs)
// were added since. `cwd` must have both objects fetched.
export function coversHead(cwd, vsha, head, def = 'main') {
  if (!vsha || !head) return false;
  if (vsha === head || head.startsWith(vsha) || vsha.startsWith(head)) return true;
  if (git(['merge-base', '--is-ancestor', vsha, head], { cwd }).code !== 0) return false;
  // commits new since the verdict, ignoring anything already on the default branch (a sync brings those in)
  const r = git(['rev-list', '--no-merges', `${vsha}..${head}`, `^origin/${def}`], { cwd });
  return r.code === 0 && r.stdout.trim() === '';
}

// The latest verdict must be APPROVED and cover the PR head.
export function approvedFor(cp, cwd, pr, head, def = 'main') {
  const all = verdictsOf(cp, pr);
  const latest = all.at(-1);
  if (!latest || latest.result !== 'APPROVED') return { ok: false, reason: latest ? `latest verdict is ${latest.result}` : 'no verdict' };
  return coversHead(cwd, latest.head_sha, head, def) ? { ok: true, verdict: latest } : { ok: false, reason: `verdict is for ${String(latest.head_sha).slice(0, 10)}, head is ${String(head).slice(0, 10)}` };
}
