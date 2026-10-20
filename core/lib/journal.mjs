import { embed, extract } from './markers.mjs';
import { now, iso } from './clock.mjs';
import { RelayError, EXIT } from './exit.mjs';

export const KINDS = ['claimed', 'plan', 'progress', 'decision', 'test', 'blocker', 'pr', 'review', 'rework', 'handoff', 'lease', 'summary'];
export const MAX_TEXT = 1200;          // entries stay short (token discipline); detail lives in commits and PR
const MAX_BODY = 60000;                // GitHub comment limit is 65536

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ');

function render(log) {
  const last = log.entries.at(-1);
  const head = `**Implementation log** for #${log.issue} · ${log.entries.length} entr${log.entries.length === 1 ? 'y' : 'ies'}${last ? ` · latest: ${last.kind} (${last.at})` : ''}`;
  const rows = log.entries.map((e) => `| ${e.n} | ${e.at} | ${cell(e.agent_id)}${e.runtime ? ` (${cell(e.runtime)})` : ''} | ${e.kind} | ${cell(e.text)}${e.head_sha ? ` · \`${e.head_sha}\`` : ''} |`);
  return `${head}\n\n| # | time | agent | kind | note |\n|---|---|---|---|---|\n${rows.join('\n')}`;
}

function build(log) {
  // Compact the oldest entries' text if the comment would exceed the platform limit.
  let body = embed('journal-log', log, render(log));
  for (let i = 0; body.length > MAX_BODY && i < log.entries.length; i++) {
    log.entries[i].text = log.entries[i].text.slice(0, 60) + (log.entries[i].text.length > 60 ? '…' : '');
    body = embed('journal-log', log, render(log));
  }
  return body;
}

export function findLog(comments) {
  let found = null;
  for (const c of comments) {
    const m = extract(c.body, 'journal-log')[0];
    if (m && (!found || c.id > found.id)) found = { id: c.id, log: m.data };
  }
  return found;
}

export function readLog(cp, issue) {
  const f = findLog(cp.listComments(issue));
  return f ? f.log : { type: 'journal-log', issue, entries: [] };
}

// Append one entry to the issue's living log comment (created on first use).
export function appendEntry(cp, issue, { kind, text, agent_id = 'unknown', runtime = null, head_sha = null }) {
  if (!KINDS.includes(kind)) throw new RelayError(`unknown journal kind "${kind}" (one of ${KINDS.join(', ')})`, EXIT.INVALID);
  const clean = String(text ?? '').trim();
  if (!clean) throw new RelayError('journal entry needs text', EXIT.INVALID);
  if (clean.length > MAX_TEXT) throw new RelayError(`journal entry too long (${clean.length} > ${MAX_TEXT} chars): summarise; detail belongs in commits and the PR`, EXIT.INVALID);
  const found = findLog(cp.listComments(issue));
  const log = found ? found.log : { type: 'journal-log', issue, entries: [] };
  const entry = { n: (log.entries.at(-1)?.n ?? 0) + 1, at: iso(now()), kind, agent_id, runtime, text: clean };
  if (head_sha) entry.head_sha = head_sha;
  log.entries.push(entry);
  const body = build(log);
  if (found) cp.editComment(found.id, body); else cp.comment(issue, body);
  return entry;
}

// Best-effort variant for automatic entries: a journal problem must never break claim/handoff.
export function appendQuietly(cp, issue, entry) {
  try { return appendEntry(cp, issue, entry); } catch (e) { process.stderr.write(`warning: journal not updated (${e.message})\n`); return null; }
}

export function checkLog(log, require) {
  const have = new Set(log.entries.map((e) => e.kind));
  return { ok: require.every((k) => have.has(k)), missing: require.filter((k) => !have.has(k)), entries: log.entries.length };
}
