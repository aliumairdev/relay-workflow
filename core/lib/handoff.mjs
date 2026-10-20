import crypto from 'node:crypto';
import { embed, extract } from './markers.mjs';

export const handoffSha = (rec) => { const { sha, ...rest } = rec; return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12); };

export function handoffBody(rec) {
  const list = (a) => (a.length ? a.map((x) => `- ${x}`).join('\n') : '- (none)');
  const text = [`HANDOFF ${rec.from.runtime} → ${rec.to.runtime} (${rec.reason})`, `Issue #${rec.issue} · branch ${rec.links.branch} · head ${rec.links.head_sha} · handoff ${rec.sha}`,
    '', '**Done**', list(rec.done), '', '**Remaining**', list(rec.remaining), '', '**Next steps**', list(rec.next_steps), '', '**NOT_VERIFIED**', list(rec.not_verified), '', '**Risks**', list(rec.risks)].join('\n');
  return embed('handoff', rec, text);
}

export function handoffsOf(comments) {
  const out = [];
  for (const c of [...comments].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id))) {
    for (const m of extract(c.body, 'handoff')) out.push({ comment_id: c.id, created_at: c.created_at, ...m.data });
  }
  return out;
}
