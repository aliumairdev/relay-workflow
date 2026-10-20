// Issue contract: the GitHub issue is the COMPLETE work contract; a PR is only a slice of it.
// Pure model (no I/O): extraction from issue text, requirement dispositions, evidence rules, PR coverage, evaluation.
// Persistence and control-plane effects live in contractops.mjs. Invariant enforced here:
//   ISSUE COMPLETE  iff  every accepted requirement has an acceptable final disposition (and nothing else is pending).
import crypto from 'node:crypto';
import { section } from './issue.mjs';
import { iso, now } from './clock.mjs';
import { RelayError, EXIT } from './exit.mjs';

export const SCHEMA_VERSION = 1;
export const COMPLETE_STATUSES = ['PASS', 'FIXED_AND_VERIFIED', 'VALID_TERMINAL_DISPOSITION', 'EXPLICITLY_REMOVED_FROM_SCOPE'];
export const PARKED_STATUS = 'EXTERNALLY_BLOCKED';          // may stop the agent; never closes the issue
export const OPEN_STATUSES = ['TODO', 'UNCHECKED', 'UNKNOWN', 'NOT_PROVED', 'NOT_VERIFIED', 'NEEDS_INVESTIGATION', 'NEEDS_DECISION', 'TESTS_ONLY', 'MERGED_NOT_VERIFIED', 'FAIL'];
export const STATUSES = [...COMPLETE_STATUSES, PARKED_STATUS, ...OPEN_STATUSES];
export const EVIDENCE_KINDS = ['test', 'runtime', 'review', 'pr', 'qa', 'manual'];
export const CLASSIFICATIONS = ['fixed_by_change', 'independently_recovered', 'non_reproducible', 'unexplained'];
export const DECISION_CATEGORIES = ['product-ambiguity', 'destructive-production', 'external-provider', 'conflicting-requirements', 'scope-change', 'business-choice'];
export const CONTRACT_STATES = ['IN_IMPLEMENTATION', 'IN_REVIEW', 'MERGED_AWAITING_PROOF', 'PARTIALLY_SATISFIED', 'BLOCKED_EXTERNAL', 'CONTRACT_COMPLETE', 'GITHUB_CLOSED_CONTRACT_INCOMPLETE'];

const fail = (message, code = EXIT.INVALID) => { throw new RelayError(message, code); };
const isComplete = (r) => COMPLETE_STATUSES.includes(r.status);
export const norm = (t) => String(t || '').toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').replace(/[\s.;:,]+$/, '').trim();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

// ---- extraction --------------------------------------------------------------------------------------------
const HEADINGS = [
  { re: /^objective$/i, prefix: 'OBJ', kind: 'objective', single: true },
  { re: /^requirements?$/i, prefix: 'R', kind: 'requirement' },
  { re: /^(acceptance(?: criteria)?|done when|definition of done|done criteria|success criteria)$/i, prefix: 'AC', kind: 'acceptance' },
  { re: /^(validation|testing|required testing|tests?|test plan)$/i, prefix: 'T', kind: 'test', requires: { tests: true } },
  { re: /^(runtime proof|production proof|runtime verification|production verification|real[- ]env(?:ironment)? proof)$/i, prefix: 'RP', kind: 'runtime_proof', requires: { runtime_proof: true } },
  { re: /^(repro(?:duction)?(?: cases?| steps)?|named reproduction cases?)$/i, prefix: 'REPRO', kind: 'repro' },
  { re: /^(consolidated(?: requirements)?|linked requirements|absorbed(?: issues)?)$/i, prefix: 'X', kind: 'consolidated' },
];
const RUNTIME_RE = /\b(production|prod|runtime|staging|live (?:site|environment|system|data)|real[- ]env(?:ironment)?|post[- ]deploy(?:ment)?|deployed|against (?:the )?(?:real|live))\b/i;
const TESTS_RE = /\b(tests?|spec|specs|unit|integration|e2e|regression test)\b/i;
const PLACEHOLDER = /^<.*>$/;
const LISTITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*\S)\s*$/;

// Items of one section: list items (continuation lines joined) or, failing that, each non-empty line.
function itemsOf(text, single) {
  const lines = String(text || '').split('\n');
  const items = [];
  for (const line of lines) {
    const m = LISTITEM.exec(line);
    if (m) items.push({ text: m[2].trim(), checked: m[1] ? m[1].toLowerCase() === 'x' : null });
    else if (/^\s{2,}\S/.test(line) && items.length) items[items.length - 1].text += ` ${line.trim()}`;
  }
  if (!items.length) {
    const plain = lines.map((l) => l.trim()).filter(Boolean);
    if (single && plain.length) items.push({ text: plain.join(' '), checked: null });
    else for (const p of plain) items.push({ text: p, checked: null });
  }
  return items.filter((i) => i.text && !PLACEHOLDER.test(i.text) && !/^(none|n\/a|tbd)\.?$/i.test(i.text));
}

const headingName = (line) => {
  const m = /^\s{0,3}(?:#{1,6}\s+(.+?)\s*#*|\*\*(.+?)\*\*:?|([A-Za-z][A-Za-z ]{2,40}):)\s*$/.exec(line);
  return m ? (m[1] || m[2] || m[3]).trim().replace(/:$/, '') : null;
};

// Sections by heading: {name: text}. Only known contract headings are interesting; others end the previous section.
function sectionsOf(body) {
  const out = [];
  let cur = null;
  for (const line of String(body || '').split('\n')) {
    const name = headingName(line);
    const def = name && HEADINGS.find((h) => h.re.test(name));
    if (name && (def || /^#{1,6}\s/.test(line) || /^\*\*/.test(line))) { cur = def ? { def, lines: [] } : null; if (cur) out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ def: s.def, text: s.lines.join('\n') }));
}

// Comments that explicitly amend acceptance: a heading ("Updated acceptance:", "Done when") with list items, or "Acceptance: text".
const AMEND_HEAD = /^\s{0,3}(?:#{1,6}\s*|\*\*)?(?:updated?|new|additional|amended|extra)\s+(?:acceptance(?: criteria)?|requirements?|done when)\s*(?:\*\*)?:?\s*$|^\s{0,3}(?:#{1,6}\s*|\*\*)?(?:acceptance(?: criteria)?|done when|requirements?)\s+(?:update|amendment|change)s?\s*(?:\*\*)?:?\s*$/i;
const AMEND_INLINE = /^\s{0,3}(?:acceptance|additional acceptance|also required|new requirement)\s*:\s*(\S.*)$/i;
const DESCOPE_RE = /\b(?:de-?scope|remove(?:d)? from scope|out of scope)\s*[:\-]?\s*((?:[A-Z]+\d+)(?:\s*,\s*[A-Z]+\d+)*)/gi;

export function amendmentsOf(comments) {
  const items = [], proposals = [], ids = [];
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    const body = String(c.body || '');
    if (/<!--\s*relay:/.test(body)) continue;                  // machine comments (claims, journal, verdicts) never amend acceptance
    const lines = body.split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (AMEND_HEAD.test(lines[i])) {
        const block = [];
        for (let j = i + 1; j < lines.length && (LISTITEM.test(lines[j]) || !lines[j].trim() || /^\s{2,}\S/.test(lines[j])); j++) block.push(lines[j]);
        for (const it of itemsOf(block.join('\n'), false)) { items.push({ text: it.text, origin: `comment:${c.id}` }); found = true; }
      } else {
        const m = AMEND_INLINE.exec(lines[i]);
        if (m && !PLACEHOLDER.test(m[1])) { items.push({ text: m[1].trim(), origin: `comment:${c.id}` }); found = true; }
      }
    }
    for (const m of body.matchAll(DESCOPE_RE)) for (const id of m[1].split(/\s*,\s*/)) proposals.push({ id: id.toUpperCase(), comment_id: c.id });
    if (found || /\bde-?scope|remove(?:d)? from scope/i.test(body)) ids.push(c.id);
  }
  return { items, proposals, ids };
}

export function fingerprintOf(issue, comments) {
  const am = amendmentsOf(comments);
  return sha(JSON.stringify([issue.title, issue.body || '', am.items, am.proposals]));
}

function nextId(prefix, taken) {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  taken.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

const reqFlags = (kind, text, base = {}) => ({
  tests: !!(base.tests || kind === 'test' || (TESTS_RE.test(text) && kind !== 'objective')),
  runtime_proof: !!(base.runtime_proof || kind === 'runtime_proof' || (RUNTIME_RE.test(text) && kind !== 'objective')),
});

// Parse the issue into fresh (un-persisted) requirements. Never returns an empty list.
export function parseIssue(issue, comments = [], { taken = new Set() } = {}) {
  const found = [];
  const secs = sectionsOf(issue.body);
  const add = (def, it, origin = 'body') => {
    const id = nextId(def.prefix, taken);
    found.push({ id, text: it.text, kind: def.kind, origin, checked: it.checked, requires: reqFlags(def.kind, it.text, def.requires), ...(def.kind === 'objective' ? { derived: true } : {}) });
  };
  for (const s of secs) for (const it of itemsOf(s.text, s.def.single)) add(s.def, it);
  if (!found.some((f) => f.kind !== 'objective')) {
    // free-form issue: any checkbox in the body is an acceptance item
    const boxes = [...String(issue.body || '').matchAll(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*\S)\s*$/gm)].map((m) => ({ text: m[2].trim(), checked: m[1].toLowerCase() === 'x' })).filter((i) => !PLACEHOLDER.test(i.text));
    for (const b of boxes) add(HEADINGS[2], b);
  }
  const am = amendmentsOf(comments);
  for (const it of am.items) add({ prefix: 'AC', kind: 'amendment' }, it, it.origin);
  if (!found.length) {
    const t = String(issue.title || `issue ${issue.number}`).trim();
    found.push({ id: nextId('OBJ', taken), text: t, kind: 'requirement', origin: 'body', checked: null, requires: reqFlags('requirement', t), note: 'no parseable requirements in the issue: derived from the title; add acceptance criteria to the issue' });
  }
  return { found, amendments: am };
}

const blank = (f, status, at) => ({ id: f.id, text: f.text, kind: f.kind, origin: f.origin, ...(f.derived ? { derived: true } : {}), status, requires: f.requires, evidence: [], ...(f.note ? { note: f.note } : {}), updated_at: at });

// Build a brand-new contract from the issue as it is now. Historical checkboxes are claims, not proof: UNCHECKED.
export function extract(issue, comments = [], { at = iso(now()) } = {}) {
  const { found, amendments } = parseIssue(issue, comments);
  const closed = issue.state === 'closed';
  const c = {
    type: 'issue-contract', schema_version: SCHEMA_VERSION, issue: issue.number, title: issue.title || '', rev: 0, created_at: at, updated_at: at,
    bootstrap: closed || found.some((f) => f.checked === true),
    source: sourceOf(issue, comments, at), scope_changes: [], prs: [], followups: [], decisions: [], drift: { vanished: [] }, audit: null,
    requirements: found.map((f) => {
      const ticked = f.checked === true || closed;
      const r = blank(f, ticked ? 'UNCHECKED' : 'TODO', at);
      if (ticked) r.note = `${f.checked === true ? 'ticked in the issue body' : 'issue was already closed'} before Relay recorded evidence; prove it or fix it (no evidence is assumed)`;
      return r;
    }),
  };
  return c;
}

export function sourceOf(issue, comments, at = iso(now())) {
  const am = amendmentsOf(comments);
  return { fingerprint: fingerprintOf(issue, comments), body_sha: sha(issue.body || ''), issue_updated_at: issue.updated_at || null, read_at: at, github_state: issue.state || 'open', amendments: am.ids, scope_proposals: am.proposals };
}

export const hasDrifted = (contract, issue, comments) => contract.source.fingerprint !== fingerprintOf(issue, comments);

// Re-read the issue and merge: new text becomes new TODO requirements, nothing is dropped silently.
// Requirements whose text vanished from the issue are flagged (drift.vanished) and need an explicit reconcile.
export function update(contract, issue, comments, { at = iso(now()) } = {}) {
  const next = structuredClone(contract);
  const taken = new Set(next.requirements.map((r) => r.id));
  const { found } = parseIssue(issue, comments, { taken: new Set() });
  const byText = new Map(next.requirements.map((r) => [norm(r.text), r]));
  const seen = new Set(), added = [];
  for (const f of found) {
    const hit = byText.get(norm(f.text));
    if (hit) { seen.add(hit.id); if (hit.vanished) delete hit.vanished; continue; }
    const id = nextId(f.id.replace(/\d+$/, ''), taken);
    const r = blank({ ...f, id }, 'TODO', at);
    next.requirements.push(r); added.push(id); seen.add(id);
  }
  const vanished = next.requirements.filter((r) => !seen.has(r.id) && r.origin !== 'manual' && r.status !== 'EXPLICITLY_REMOVED_FROM_SCOPE' && !(norm(r.text) === norm(issue.title) && r.id.startsWith('OBJ'))).map((r) => r.id);
  for (const r of next.requirements) if (vanished.includes(r.id)) r.vanished = true;
  next.title = issue.title || next.title;
  next.source = sourceOf(issue, comments, at);
  next.drift = { vanished };
  if (added.length || vanished.length) bump(next, at);
  return { contract: next, added, vanished };
}

export function bump(c, at = iso(now())) { c.rev += 1; c.updated_at = at; return c; }

// ---- dispositions ------------------------------------------------------------------------------------------
const ESCAPE_RE = /\b(follow-?\s?up|new issue|separate issue|another issue|tracked (?:in|by|under) #\d+|moved to #\d+|punt(?:ed)?|deferred|defer(?:red)? to|out of scope|later pass)\b|#\d+\s+(?:will|to) (?:cover|handle|track)/i;
const UNKNOWN_WHY_RE = /\b(works now|working now|not sure why|don'?t know why|do not know why|unknown why|no idea why|unexplained|mysteriously|somehow (?:works|fixed))\b/i;
export const looksLikeScopeEscape = (text) => ESCAPE_RE.test(String(text || ''));

function find(c, id) {
  const r = c.requirements.find((x) => x.id === id);
  if (!r) fail(`no requirement ${id} in the contract for #${c.issue} (have: ${c.requirements.map((x) => x.id).join(', ')})`);
  return r;
}

// Evidence rules a complete disposition must satisfy. Returns [problem strings].
export function evidenceProblems(r) {
  const out = [];
  if (!['EXPLICITLY_REMOVED_FROM_SCOPE'].includes(r.status) && !r.evidence.length) out.push('no evidence recorded');
  if (r.requires?.tests && !r.evidence.some((e) => e.kind === 'test') && r.status !== 'EXPLICITLY_REMOVED_FROM_SCOPE') out.push('required tests lack evidence (add test evidence: command → result)');
  if (r.requires?.runtime_proof && !r.evidence.some((e) => e.kind === 'runtime' || e.kind === 'qa') && r.status !== 'EXPLICITLY_REMOVED_FROM_SCOPE') out.push('required runtime proof is missing (tests alone are TESTS_ONLY)');
  if ((r.status === 'FIXED_AND_VERIFIED') && !r.evidence.some((e) => e.kind === 'test')) out.push('FIXED_AND_VERIFIED needs test evidence');
  if ((r.status === 'FIXED_AND_VERIFIED') && !r.evidence.some((e) => e.pr || e.kind === 'pr')) out.push('FIXED_AND_VERIFIED needs the implementing PR as evidence');
  if (r.kind === 'repro' && ['PASS', 'FIXED_AND_VERIFIED', 'VALID_TERMINAL_DISPOSITION'].includes(r.status)) {
    if (!r.classification) out.push('reproduction case needs a classification (fixed_by_change | independently_recovered | non_reproducible)');
    else if (r.classification === 'unexplained') out.push('reproduction still unexplained: acceptance requires understanding');
    else if (r.status === 'FIXED_AND_VERIFIED' && r.classification !== 'fixed_by_change') out.push('FIXED_AND_VERIFIED requires classification fixed_by_change');
  }
  if (r.classification === 'unexplained' && isComplete(r) && r.status !== 'EXPLICITLY_REMOVED_FROM_SCOPE') out.push('classification unexplained cannot be a final disposition');
  if (['PASS', 'FIXED_AND_VERIFIED'].includes(r.status) && UNKNOWN_WHY_RE.test(r.note || '') && !(r.classification && r.classification !== 'unexplained')) out.push('"works now, not sure why" is not proof: classify (fixed_by_change | independently_recovered | non_reproducible)');
  return out;
}

export function parseEvidence(list, { pr, by } = {}) {
  return (list || []).map((raw) => {
    const m = /^(test|runtime|review|pr|qa|manual):([\s\S]+)$/.exec(String(raw).trim());
    if (!m) fail(`bad --evidence "${raw}" (expected <${EVIDENCE_KINDS.join('|')}>:<reference, e.g. "npm test → 12 pass" or a log path>)`);
    const ref = m[2].trim();
    if (!ref) fail(`evidence "${raw}" has an empty reference`);
    return { kind: m[1], ref: ref.slice(0, 400), ...(pr ? { pr } : {}), at: iso(now()), ...(by ? { by } : {}) };
  });
}

// Set the disposition of one requirement. Throws (exit 3 invalid / 4 gate) when the rules are not met.
export function mark(contract, id, status, { evidence = [], note, classification, blocker, needs, cite, decision, sourceText = '', by, at = iso(now()) } = {}) {
  if (!STATUSES.includes(status)) fail(`unknown status ${status} (one of ${STATUSES.join(', ')})`);
  if (status === 'EXPLICITLY_REMOVED_FROM_SCOPE') fail('EXPLICITLY_REMOVED_FROM_SCOPE is set only by `relay-contract descope` (owner action with a reference to the scope change)', EXIT.REFUSED);
  if (classification && !CLASSIFICATIONS.includes(classification)) fail(`unknown classification ${classification} (one of ${CLASSIFICATIONS.join(', ')})`);
  const next = structuredClone(contract);
  const r = find(next, id);
  if (r.derived) fail(`${id} is the issue objective: it is satisfied automatically when every other requirement is`);
  if (r.status === 'EXPLICITLY_REMOVED_FROM_SCOPE') fail(`${id} was removed from scope by the owner; it cannot be re-marked`, EXIT.REFUSED);
  const prev = r.status;
  r.status = status; r.updated_at = at;
  r.evidence.push(...evidence);
  if (note !== undefined) r.note = String(note).slice(0, 600);
  if (classification) r.classification = classification;
  if (cite) r.cite = cite;
  if (decision) r.decision = decision; else if (status !== 'NEEDS_DECISION') delete r.decision;
  if (status !== PARKED_STATUS) delete r.blocker;

  if (isComplete(r)) {
    if (r.note && looksLikeScopeEscape(r.note)) fail(`${id}: the note defers or moves the requirement to a follow-up; a follow-up issue does not satisfy an acceptance requirement (it stays unresolved unless the owner descopes it)`, EXIT.GATE_FAILED);
    if (status === 'VALID_TERMINAL_DISPOSITION') {
      const quote = norm(cite || '');
      if (quote.length < 12) fail(`${id}: VALID_TERMINAL_DISPOSITION needs --cite "<the sentence in the issue that allows ending without implementation>"`, EXIT.GATE_FAILED);
      if (sourceText && !norm(sourceText).includes(quote)) fail(`${id}: the cited sentence does not appear in the issue text; the issue itself must allow this disposition`, EXIT.GATE_FAILED);
      if (!r.evidence.length) fail(`${id}: VALID_TERMINAL_DISPOSITION needs evidence that the terminal case holds`, EXIT.GATE_FAILED);
    }
    const bad = evidenceProblems(r);
    if (bad.length) {
      const testsOnly = r.requires?.runtime_proof && r.evidence.some((e) => e.kind === 'test') && !r.evidence.some((e) => e.kind === 'runtime' || e.kind === 'qa');
      fail(`${id}: cannot be ${status}: ${bad.join('; ')}${testsOnly ? ' — record it as TESTS_ONLY until runtime proof exists' : ''}`, EXIT.GATE_FAILED);
    }
  }
  if (status === PARKED_STATUS) {
    const what = String(blocker || '').trim();
    if (what.length < 10) fail(`${id}: EXTERNALLY_BLOCKED needs --blocker "<exact blocker>" (what outside agent authority is required)`, EXIT.GATE_FAILED);
    r.blocker = { what: what.slice(0, 400), ...(needs ? { needs: String(needs).slice(0, 300) } : {}), since: r.blocker?.since || at };
  }
  if (status === 'NEEDS_DECISION' && !decision) r.note = r.note || 'marked NEEDS_DECISION without an owner decision: this is still actionable work, not a wait state';
  if (prev !== status || evidence.length || note !== undefined) bump(next, at);
  return next;
}

// Owner action: remove requirements from scope. Needs a reference to where the owner said so.
export function descope(contract, ids, { ref, reason, by, at = iso(now()) } = {}) {
  if (!ref) fail('descope needs --ref (comment:<id> containing the owner decision, or body for an edit of the issue text)', EXIT.REFUSED);
  if (!String(reason || '').trim()) fail('descope needs --reason', EXIT.REFUSED);
  const next = structuredClone(contract);
  for (const id of ids) {
    const r = find(next, id);
    if (r.derived) fail(`${id} is the objective and cannot be descoped`);
    r.status = 'EXPLICITLY_REMOVED_FROM_SCOPE'; r.updated_at = at; delete r.vanished; delete r.blocker; delete r.decision;
    r.note = `removed from scope: ${reason}`.slice(0, 600);
    next.scope_changes.push({ id, action: 'removed', at, by: by || 'owner', ref, reason: String(reason).slice(0, 400) });
  }
  next.drift = { vanished: (next.drift?.vanished || []).filter((v) => !ids.includes(v)) };
  return bump(next, at);
}

// Keep requirements that vanished from the issue text (they remain owned work).
export function keep(contract, ids, { reason, by, at = iso(now()) } = {}) {
  const next = structuredClone(contract);
  for (const id of ids) {
    const r = find(next, id);
    delete r.vanished; r.origin = 'manual';
    next.scope_changes.push({ id, action: 'kept', at, by: by || 'agent', reason: String(reason || 'kept after it vanished from the issue text').slice(0, 400) });
  }
  next.drift = { vanished: (next.drift?.vanished || []).filter((v) => !ids.includes(v)) };
  return bump(next, at);
}

export function addRequirement(contract, text, { requires = {}, kind = 'manual', at = iso(now()) } = {}) {
  const next = structuredClone(contract);
  const taken = new Set(next.requirements.map((r) => r.id));
  const id = nextId('M', taken);
  next.requirements.push({ id, text: String(text).trim(), kind, origin: 'manual', status: 'TODO', requires: { tests: !!requires.tests, runtime_proof: !!requires.runtime_proof }, evidence: [], updated_at: at });
  return bump(next, at);
}

export function addFollowup(contract, { issue, covers, reason, at = iso(now()) }) {
  const next = structuredClone(contract);
  for (const id of covers) find(next, id);
  next.followups.push({ issue, covers, at, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) });
  return bump(next, at);   // recorded for traceability only: the requirement stays unresolved
}

export function linkDecision(contract, { issue, requirement = null, category, question, at = iso(now()) }) {
  const next = structuredClone(contract);
  next.decisions.push({ issue, requirement, category, question: String(question).slice(0, 300), at });
  if (requirement) {
    const r = find(next, requirement);
    r.status = 'NEEDS_DECISION'; r.decision = issue; r.updated_at = at;
  }
  return bump(next, at);
}

export function resolveDecision(contract, issue, { at = iso(now()) } = {}) {
  const next = structuredClone(contract);
  next.decisions = next.decisions.filter((d) => d.issue !== issue);
  for (const r of next.requirements) if (r.decision === issue) { delete r.decision; if (r.status === 'NEEDS_DECISION') r.status = 'TODO'; r.updated_at = at; }
  return bump(next, at);
}

// ---- PR coverage -------------------------------------------------------------------------------------------
export const coverageSection = (body) => section(body, 'Contract Coverage');

// Parse the PR body's "## Contract Coverage": per-requirement lines and the "Issue completion" statement.
export function parseCoverage(body) {
  const sec = coverageSection(body);
  if (!sec) return null;
  const coverage = {};
  for (const line of sec.split('\n')) {
    const m = /^\s*[-*]\s*\**([A-Z]+\d+)\**\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    coverage[m[1]] = /\b(not covered|not in this|remain|remaining|pending|todo|n\/a|not addressed|out of this)\b/i.test(m[2]) || /^not\b/i.test(m[2]) ? 'not_covered' : /\b(implement|cover|fix|satisf|complet|add|done|resolv)/i.test(m[2]) ? 'implemented' : 'not_covered';
  }
  const comp = /issue completion\s*:\s*\**\s*(yes|no)\b/i.exec(sec);
  return { coverage, completes_issue: comp ? comp[1].toLowerCase() === 'yes' : null, text: sec };
}

export function coverageSkeleton(contract) {
  const open = contract.requirements.filter((r) => !isComplete(r) && !r.derived);
  return ['## Contract Coverage', `Issue: #${contract.issue}`, ...open.map((r) => `- ${r.id}: not covered by this PR`), '', 'Issue completion: NO — additional accepted requirements remain.'].join('\n');
}

// Lint a PR body against the contract. Returns [{rule, message}].
export function lintPR(body, contract) {
  const out = [];
  const cov = parseCoverage(body);
  if (!cov) return [{ rule: 'coverage-missing', message: `PR body has no "## Contract Coverage" section (generate one with \`relay-contract pr-section ${contract.issue}\`)` }];
  const open = contract.requirements.filter((r) => !isComplete(r) && !r.derived && r.status !== PARKED_STATUS);
  const known = new Set(contract.requirements.map((r) => r.id));
  for (const id of Object.keys(cov.coverage)) if (!known.has(id)) out.push({ rule: 'coverage-unknown-id', message: `coverage names ${id}, which is not in the contract for #${contract.issue}` });
  for (const r of open) if (!(r.id in cov.coverage)) out.push({ rule: 'coverage-incomplete', message: `coverage does not mention ${r.id} (${r.text.slice(0, 60)}): list every unresolved requirement as implemented or not covered` });
  if (cov.completes_issue === null) out.push({ rule: 'completion-missing', message: 'PR body must state "Issue completion: YES|NO"' });
  const uncovered = open.filter((r) => cov.coverage[r.id] !== 'implemented');
  if (cov.completes_issue === true && uncovered.length) out.push({ rule: 'false-completion', message: `PR claims "Issue completion: YES" but ${uncovered.map((r) => r.id).join(', ')} remain unresolved/uncovered` });
  for (const line of cov.text.split('\n')) {
    const m = /^\s*[-*]\s*\**([A-Z]+\d+)\**\s*:\s*(.+)$/.exec(line);
    if (m && cov.coverage[m[1]] === 'not_covered' && looksLikeScopeEscape(m[2]) && contract.requirements.find((r) => r.id === m[1] && !isComplete(r))) out.push({ rule: 'scope-escape', message: `${m[1]}: moving an accepted requirement to a follow-up/deferral is not allowed; it stays in this issue until the owner descopes it` });
  }
  return out;
}

// Record a merged PR: coverage, completion claim, QA expectation. Covered unresolved requirements become MERGED_NOT_VERIFIED.
export function recordMergedPR(contract, { pr, branch, head_sha, coverage = {}, completes_issue = null, qa = 'n/a', at = iso(now()) }) {
  const next = structuredClone(contract);
  const entry = { pr, merged: true, merged_at: at, ...(branch ? { branch } : {}), ...(head_sha ? { head_sha } : {}), coverage, completes_issue, qa };
  const i = next.prs.findIndex((p) => p.pr === pr);
  if (i >= 0) next.prs[i] = { ...next.prs[i], ...entry }; else next.prs.push(entry);
  for (const [id, cov] of Object.entries(coverage)) {
    const r = next.requirements.find((x) => x.id === id);
    if (!r || cov !== 'implemented' || isComplete(r) || r.status === PARKED_STATUS) continue;
    r.status = r.requires?.runtime_proof && r.evidence.some((e) => e.kind === 'test') ? 'TESTS_ONLY' : 'MERGED_NOT_VERIFIED';
    r.updated_at = at;
  }
  return bump(next, at);
}

export function recordOpenPR(contract, { pr, branch, coverage = {}, completes_issue = null, at = iso(now()) }) {
  const next = structuredClone(contract);
  if (next.prs.some((p) => p.pr === pr)) return contract;
  next.prs.push({ pr, merged: false, ...(branch ? { branch } : {}), coverage, completes_issue, qa: 'n/a' });
  return bump(next, at);
}

export function setQA(contract, pr, qa, { at = iso(now()) } = {}) {
  const next = structuredClone(contract);
  const p = next.prs.find((x) => x.pr === pr);
  if (!p) fail(`PR #${pr} is not recorded in the contract for #${contract.issue} (was it merged through Relay?)`);
  p.qa = qa; p.qa_at = at;
  return bump(next, at);
}

export function setAudit(contract, { by, note, at = iso(now()) }) {
  const next = structuredClone(contract);
  for (const r of next.requirements) if (r.derived && next.requirements.filter((x) => !x.derived).every(isComplete)) r.status = 'PASS';   // the objective is satisfied exactly when everything else is
  next.audit = { rev: next.rev, at, by: by || 'unknown', ...(note ? { note: String(note).slice(0, 300) } : {}) };
  return next;                                               // the audit records the revision it saw; it does not bump it
}

// ---- evaluation --------------------------------------------------------------------------------------------
// Mechanical answer to "is the issue contract complete?". `gh` = {state, drifted} from the live issue (optional).
export function evaluate(contract, { gh = {}, requireAudit = true } = {}) {
  const reqs = contract.requirements;
  const counted = reqs.filter((r) => !r.derived);
  const others = (r) => reqs.filter((x) => x !== r && !x.derived);
  const eff = (r) => (r.derived ? (others(r).every(isComplete) ? 'PASS' : 'TODO') : r.status);
  const done = counted.filter(isComplete);
  const parked = counted.filter((r) => r.status === PARKED_STATUS || (r.status === 'NEEDS_DECISION' && r.decision));
  const unresolved = counted.filter((r) => !isComplete(r) && !parked.includes(r));
  const problems = [];
  for (const r of unresolved) problems.push({ code: 'UNRESOLVED', id: r.id, message: `${r.id} ${r.status}: ${r.text}` });
  for (const r of parked) problems.push({ code: 'BLOCKED_EXTERNAL', id: r.id, message: `${r.id} ${r.status === PARKED_STATUS ? `EXTERNALLY_BLOCKED: ${r.blocker?.what}` : `waiting on owner decision #${r.decision}`}: ${r.text}` });
  for (const r of done) for (const p of evidenceProblems(r)) problems.push({ code: /runtime/.test(p) ? 'MISSING_RUNTIME_PROOF' : /tests lack/.test(p) ? 'MISSING_TEST_EVIDENCE' : 'MISSING_EVIDENCE', id: r.id, message: `${r.id} ${r.status} but ${p}` });
  for (const id of contract.drift?.vanished || []) problems.push({ code: 'DRIFT_VANISHED', id, message: `${id} vanished from the issue text: keep it (\`relay-contract reconcile --keep ${id}\`) or have the owner descope it` });
  if (gh.drifted) problems.push({ code: 'DRIFT', message: 'the issue changed since the contract was read: run `relay-contract update` and work any new requirements' });
  for (const p of contract.prs.filter((x) => x.merged)) {
    if (p.qa === 'pending') problems.push({ code: 'QA_PENDING', message: `post-merge QA is pending for PR #${p.pr}` });
    if (p.qa === 'fail') problems.push({ code: 'QA_FAILED', message: `post-merge QA failed for PR #${p.pr}: the issue returns to implementation` });
  }
  for (const d of contract.decisions || []) if (!d.requirement && !parked.some((r) => r.decision === d.issue)) problems.push({ code: 'DECISION_PENDING', message: `owner decision #${d.issue} is pending and blocks acceptance` });
  if (requireAudit && !problems.some((p) => !['BLOCKED_EXTERNAL'].includes(p.code)) && !parked.length && !(contract.audit && contract.audit.rev === contract.rev)) problems.push({ code: 'AUDIT_NOT_RUN', message: 'the final acceptance audit has not run for this contract revision (`relay-contract audit`)' });
  const has = (...codes) => problems.some((p) => codes.includes(p.code));
  const allComplete = counted.length > 0 && counted.every(isComplete);
  const closable = problems.length === 0 && allComplete;
  const rt = counted.filter((r) => r.requires?.runtime_proof);
  const runtime = !rt.length ? 'n/a' : rt.every(isComplete) ? 'complete' : rt.some((r) => isComplete(r) || r.status === 'TESTS_ONLY') ? 'partial' : 'pending';
  const merged = contract.prs.filter((p) => p.merged).length;
  const awaitingProof = counted.some((r) => ['MERGED_NOT_VERIFIED', 'TESTS_ONLY'].includes(r.status)) || contract.prs.some((p) => p.merged && p.qa === 'pending');
  const onlyProofLeft = unresolved.length > 0 && unresolved.every((r) => ['MERGED_NOT_VERIFIED', 'TESTS_ONLY'].includes(r.status));
  // What an agent should do next. 'wait_external' is the only state in which stopping is legitimate (and it is never "complete").
  let next;
  if (closable) next = 'close';
  else if (unresolved.length || has('DRIFT', 'DRIFT_VANISHED', 'QA_FAILED', 'MISSING_EVIDENCE', 'MISSING_TEST_EVIDENCE', 'MISSING_RUNTIME_PROOF')) next = onlyProofLeft && !has('DRIFT', 'DRIFT_VANISHED', 'QA_FAILED') ? 'prove' : 'implement';
  else if (has('QA_PENDING')) next = 'prove';
  else if (parked.length) next = 'wait_external';
  else if (has('AUDIT_NOT_RUN')) next = 'audit';
  else next = 'implement';
  const actionable = ['implement', 'prove'].includes(next);
  return {
    issue: contract.issue, title: contract.title, rev: contract.rev, complete: closable || (allComplete && problems.every((p) => p.code === 'AUDIT_NOT_RUN')), closable, next,
    counts: { total: counted.length, complete: done.length, unresolved: unresolved.length, blocked: parked.length, prs_merged: merged },
    pass: done.map((r) => r.id), unresolved: unresolved.map((r) => ({ id: r.id, text: r.text, status: r.status })), blocked: parked.map((r) => ({ id: r.id, text: r.text, what: r.blocker?.what || `owner decision #${r.decision}` })),
    problems, actionable, runtime_proof: runtime, awaiting_proof: awaitingProof,
    effective: Object.fromEntries(reqs.map((r) => [r.id, eff(r)])),
  };
}

// Dashboard / status state for an issue (see ARCHITECTURE contract lifecycle).
export function contractState(contract, { ghState = 'open', labels = [] } = {}) {
  const ev = evaluate(contract, { requireAudit: false });
  if (ghState === 'closed') {
    const audited = contract.audit && contract.audit.rev === contract.rev;
    return ev.closable && audited ? 'CONTRACT_COMPLETE' : 'GITHUB_CLOSED_CONTRACT_INCOMPLETE';
  }
  if (ev.complete) return 'CONTRACT_COMPLETE';
  if (!ev.actionable && ev.counts.blocked) return 'BLOCKED_EXTERNAL';
  const st = labels.find((l) => l.startsWith('state:'))?.slice(6);
  if (['claimed', 'in-progress', 'changes-requested'].includes(st)) return st === 'changes-requested' ? 'IN_REVIEW' : 'IN_IMPLEMENTATION';
  if (st === 'review') return 'IN_REVIEW';
  if (ev.awaiting_proof) return 'MERGED_AWAITING_PROOF';
  if (ev.counts.complete > 0 || ev.counts.prs_merged > 0) return 'PARTIALLY_SATISFIED';
  return 'IN_IMPLEMENTATION';
}

// ---- rendering ---------------------------------------------------------------------------------------------
const box = (r, eff) => (COMPLETE_STATUSES.includes(eff) ? '[x]' : '[ ]');
export function renderBlock(contract, { ev = evaluate(contract, { requireAudit: false }) } = {}) {
  const lines = [`ISSUE CONTRACT #${contract.issue} — ${ev.counts.complete}/${ev.counts.total} complete${ev.counts.blocked ? `, ${ev.counts.blocked} externally blocked` : ''}`];
  for (const r of contract.requirements) {
    const eff = ev.effective[r.id];
    lines.push(`- ${box(r, eff)} ${r.id} [${eff}${r.requires?.tests ? ' · tests' : ''}${r.requires?.runtime_proof ? ' · runtime proof' : ''}] ${r.text}${r.blocker ? ` (BLOCKED: ${r.blocker.what})` : ''}${r.vanished ? ' (VANISHED from issue text)' : ''}`);
  }
  return lines.join('\n');
}

export function renderStatusLines(contract, ev, state) {
  return [
    `Issue #${contract.issue} ${state}`,
    `  Contract: ${ev.counts.complete}/${ev.counts.total} complete`,
    `  PRs merged: ${ev.counts.prs_merged}`,
    `  Runtime proof: ${ev.runtime_proof}`,
    ...(ev.unresolved.length || ev.blocked.length ? [`  Remaining: ${[...ev.unresolved, ...ev.blocked].map((r) => r.id).join(', ')}`] : []),
  ];
}

export function renderCheck(ev) {
  if (ev.closable) return `PASS\nIssue #${ev.issue} contract is complete (${ev.counts.complete}/${ev.counts.total}). Closure allowed.`;
  const lines = ['FAIL', `Issue #${ev.issue} is incomplete.`, ''];
  if (ev.pass.length) lines.push('PASS:', ...ev.pass.map((id) => `  ${id}`), '');
  const un = ev.unresolved.map((r) => `  ${r.id} ${r.status} — ${r.text}`);
  if (un.length) lines.push('UNRESOLVED:', ...un, '');
  if (ev.blocked.length) lines.push('EXTERNALLY BLOCKED (does not close the issue):', ...ev.blocked.map((r) => `  ${r.id} — ${r.what}`), '');
  const other = ev.problems.filter((p) => !['UNRESOLVED', 'BLOCKED_EXTERNAL'].includes(p.code));
  if (other.length) lines.push('PROBLEMS:', ...other.map((p) => `  [${p.code}] ${p.message}`), '');
  lines.push('Closure denied.');
  return lines.join('\n');
}

// ---- owner decisions -----------------------------------------------------------------------------------------
// Owners decide product questions, not whether the agent should finish its own issue. Pure validation: returns [problems].
const NOT_A_DECISION = [
  [/\b(should i|shall i|do you want me to|want me to|would you like me to|may i|is it ok(?:ay)?(?: for me)? to|permission to)\b[\s\S]{0,80}\b(continue|proceed|finish|complete|keep going|keep working|open (?:a |another )?(?:pr|pull request)|investigate|keep (?:the |this )?issue open|close (?:the |this )?issue)\b/i, 'asking permission to continue/finish the issue is not a decision: finishing every accepted requirement is your job'],
  [/\b(follow-?\s?up|new issue|separate issue|another issue|split (?:this|it) (?:out|into))\b/i, 'moving accepted requirements into a follow-up is not a decision you may request: the requirements stay in this issue unless the owner descopes them'],
  [/\b(another|a new|more|additional) (?:pr|pull request)\b/i, 'whether to write another PR is not a decision: multiple PRs under one issue are normal'],
  [/\b(?:which|what) (?:library|framework|approach|implementation|algorithm|pattern|data structure|test (?:framework|approach)|file|function|name for the (?:function|variable|class))\b/i, 'technical implementation choices are yours: decide, journal the decision and continue'],
  [/\b(keep|leave) (?:the |this )?issue open\b|\bremaining (?:acceptance|requirements?|criteria|items?)\b/i, 'whether to keep an incomplete issue open or work the remaining requirements is not a decision: the issue stays open until the contract is complete'],
];
export function decisionProblems(f, { requirement = null } = {}) {
  const out = [];
  const text = (v) => String(v || '').trim();
  if (!DECISION_CATEGORIES.includes(f.category)) out.push(`--category must be one of ${DECISION_CATEGORIES.join(' | ')} (anything else is yours to decide)`);
  const need = [['question', 'the exact unresolved question', 15], ['contract_gap', 'why the issue contract does not already answer it (--contract-gap)', 30], ['evidence', 'evidence gathered (--evidence)', 20], ['unsafe_because', 'why proceeding automatically would be unsafe or product-changing (--unsafe-because)', 30]];
  for (const [k, label, min] of need) if (text(f[k]).length < min) out.push(`missing ${label}`);
  if (!Array.isArray(f.options) || f.options.length < 2) out.push('missing options considered (at least two)');
  if (!text(f.default)) out.push('missing recommended default (--default)');
  else if (Array.isArray(f.options) && !f.options.includes(f.default)) out.push(`--default must be one of the options (${f.options.join(', ')})`);
  for (const [re, why] of NOT_A_DECISION) if (re.test(`${f.question} ${(f.options || []).join(' ')}`)) out.push(why);
  if (requirement && f.category === undefined) out.push('--category is required');
  return out;
}
