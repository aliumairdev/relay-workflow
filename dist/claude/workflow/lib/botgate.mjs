// Unanswered bot review comments on a PR. Exact bot logins; inline threads plus review-level comments.
// A reply clears only if it comes from a non-bot account (unless bot.require_reply_from_non_bot is false).
export const botLogins = (cfg) => [...new Set([...(cfg.bot?.logins || []), ...Object.values(cfg.runtimes || {}).flatMap((r) => r.bot?.logins || [])])];
const blockSeverities = (cfg) => [...new Set(Object.values(cfg.runtimes || {}).flatMap((r) => r.bot?.severity_block || []))];

function severityOf(body) { const m = /\bP([0-3])\b/.exec(body || ''); return m ? `P${m[1]}` : null; }

export function unanswered(cp, cfg, pr) {
  const logins = botLogins(cfg), block = blockSeverities(cfg);
  const isBot = (c) => logins.includes(c.user?.login);
  const needNonBot = cfg.bot?.require_reply_from_non_bot !== false;
  const counts = (body) => { const sev = severityOf(body); return !(block.length && sev && !block.includes(sev)); };
  const out = [];

  const inline = cp.listPRInline(pr);
  const answered = new Set();
  for (const c of inline) if (c.in_reply_to_id && (!needNonBot || !isBot(c))) answered.add(c.in_reply_to_id);
  for (const c of inline) {
    if (c.in_reply_to_id || !isBot(c) || answered.has(c.id)) continue;
    if (counts(c.body)) out.push({ id: c.id, kind: 'inline', severity: severityOf(c.body), path: c.path || null, body: String(c.body || '').slice(0, 300) });
  }
  const issueComments = cp.listComments(pr);
  for (const r of cp.listPRReviews(pr)) {
    if (!isBot(r) || !String(r.body || '').trim()) continue;
    const when = r.submitted_at || r.created_at;
    const replied = issueComments.some((c) => !isBot(c) && c.created_at > when);
    if (!replied && counts(r.body)) out.push({ id: r.id, kind: 'review', severity: severityOf(r.body), path: null, body: String(r.body).slice(0, 300) });
  }
  return out;
}
