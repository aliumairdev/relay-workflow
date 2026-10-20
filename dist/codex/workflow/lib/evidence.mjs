// Evidence lint (honesty protocol): a claim of success needs evidence, and PRs must carry a NOT_VERIFIED section.
// Pure functions: lint(text, {kind}) -> [{rule, message}].
const CLAIM = [
  /\b(?:all\s+|unit\s+|e2e\s+|integration\s+)?tests?\s+(?:all\s+)?(?:pass(?:ed|es|ing)?|are\s+(?:passing|green))\b/i,
  /\b(?:checks?|ci|build|lint)\s+(?:is\s+|are\s+)?(?:green|pass(?:ed|es|ing)?)\b/i,
  /\b(?:verified|validated|confirmed)\b/i,
  /\bno\s+regressions?\b/i,
  /\bproduction[- ]ready\b/i,
  /\b(?:fully\s+)?(?:works|working)\s+(?:as\s+expected|correctly)\b/i,
];
const PLACEHOLDER = /^\s*<[^>\n]{2,}>\s*$/;

export function section(body, name) {
  const re = new RegExp(`^#{1,4}\\s*${name}\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|(?![\\s\\S]))`, 'im');
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}
const meaningful = (s) => !!s && s.split('\n').some((l) => l.trim() && !PLACEHOLDER.test(l));

// Evidence tokens: fenced output, "command → result", "N pass", exit codes, log paths, run URLs, or a filled Evidence section.
export function hasEvidence(text) {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/(?:→|->)\s*\S/.test(text)) return true;
  if (/\b\d+\s+(?:pass(?:ed|ing)?|ok|tests?)\b/i.test(text)) return true;
  if (/\bexit\s+(?:code\s+)?\d+\b/i.test(text)) return true;
  if (/(?:harness|\.relay)\/[\w./-]+\.(?:log|json|md)/.test(text)) return true;
  if (/https?:\/\/\S+\/(?:actions\/runs|pull|runs?|jobs?)\/\S+/i.test(text)) return true;
  const ev = section(text, 'Evidence');
  return meaningful(ev) && !/^(none|n\/a)\.?$/i.test(ev.trim());
}

export function claimsIn(text) {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/^#{1,4}\s*NOT_VERIFIED\s*$[\s\S]*?(?=^#{1,4}\s|(?![\s\S]))/gim, '');
  return CLAIM.map((re) => re.exec(stripped)?.[0]).filter(Boolean);
}

export function lint(text, { kind = 'pr' } = {}) {
  const out = [];
  const body = String(text || '');
  if (kind === 'pr') {
    const nv = section(body, 'NOT_VERIFIED');
    if (nv == null) out.push({ rule: 'not-verified-section', message: 'PR body has no NOT_VERIFIED section (write "none" only if every claim has evidence)' });
    else if (!meaningful(nv)) out.push({ rule: 'not-verified-section', message: 'NOT_VERIFIED section is empty or still a template placeholder' });
    for (const name of ['Validation', 'Outcome']) {
      const s = section(body, name.replace('Validation', 'Validation(?: \\(real results\\))?'));
      if (s != null && !meaningful(s)) out.push({ rule: 'placeholder-left', message: `section "${name}" still contains only template placeholder text` });
    }
  }
  const claims = claimsIn(body);
  if (claims.length && !hasEvidence(body)) out.push({ rule: 'claim-without-evidence', message: `claims "${claims.slice(0, 3).join('", "')}" with no evidence (quote the command and result line, fenced output, or a log path; otherwise list it under NOT_VERIFIED)` });
  if (kind === 'pr') {
    const nv = section(body, 'NOT_VERIFIED');
    if (nv && /^(none|n\/a)\.?$/i.test(nv.trim()) && !hasEvidence(body)) out.push({ rule: 'none-without-evidence', message: 'NOT_VERIFIED says "none" but the PR carries no evidence at all' });
  }
  return out;
}

// Handoff records: a passing test entry must carry evidence; not_verified must be an array.
export function lintHandoff(rec) {
  const out = [];
  if (!Array.isArray(rec.not_verified)) out.push({ rule: 'handoff-not-verified', message: 'handoff needs a not_verified list (empty only if truly nothing is unverified)' });
  for (const t of rec.tests_run || []) if (t.result === 'pass' && !String(t.evidence || '').trim()) out.push({ rule: 'handoff-test-without-evidence', message: `tests_run "${t.cmd}" says pass without evidence (result line or log path)` });
  return out;
}
