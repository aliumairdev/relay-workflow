import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CORE } from './config.mjs';
import { RelayError, EXIT } from './exit.mjs';

const RULE_FILES = ['token-rules', 'codex-rules', 'worktree-safety', 'honesty', 'security'];
// Briefs about work on an issue carry the ownership contract (issue = complete work contract; PR = slice).
const OWNERSHIP_BRIEFS = ['dispatch', 'review', 'high-risk-review', 'handoff', 'fixmerge', 'post-merge-qa'];
// Briefs for work on an issue always carry the journal rule (not optional via brief_rules).
const JOURNAL_BRIEFS = ['dispatch', 'review', 'high-risk-review', 'handoff', 'fixmerge', 'docs', 'proof', 'post-merge-qa'];
const read = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8').replace(/\s+$/, '');
export const briefNames = () => fs.readdirSync(path.join(CORE, 'briefs')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

const OPTIONAL = {
  issue_contract: '(read the contract with `relay-contract show <issue>`: it lists every accepted requirement you own)', profile_rules: '', profile_review_gate: '', preclaimed_note: '', issue_text: '(read it with `gh issue view`)', delta_note: '', handoff_ack: '', resolver_hints: 'resolve conflicts with `relay-resolve`',
  forbidden_paths: '(none declared)', owned_paths: '(see issue)', report_max_words: '120', packet_max_words: '500',
  escalate_after: '2', recheck_minutes: '3', screenshots_max: '4', viewports: '375, 1440', modes: 'light, dark',
};

// Variables derived from workflow.yaml so briefs never hard-code identifiers.
export function configVars(cfg) {
  if (!cfg) return {};
  const cmds = [...(cfg.ci?.steps || []).map((s) => `${s.name}: \`${s.cmd}\``)];
  const logins = cfg.bot?.logins?.length ? cfg.bot.logins : Object.values(cfg.runtimes || {}).flatMap((r) => r.bot?.logins || []);
  const sev = Object.values(cfg.runtimes || {}).flatMap((r) => r.bot?.severity_block || []);
  return {
    project_name: cfg.project.name, repo: cfg.project.repo, default_branch: cfg.project.default_branch, mode: cfg.policy.mode,
    worktree_root: cfg.project.worktree_root || '~/worktrees/' + cfg.project.name, main_checkout: cfg.__root || '.',
    commands: cmds.join('; ') || '(see AGENTS.md)', sync_steps: (cfg.ci?.sync_steps || []).map((c) => `\`${c}\``).join(', ') || 'the project checks',
    review_order: (cfg.review?.order || ['acceptance', 'architecture', 'correctness', 'tests']).join(' → '),
    heartbeat_minutes: String(cfg.claims.heartbeat_minutes), bot_logins: logins.join(', '), bot_severity_block: sev.join('/') || 'P0/P1',
    min_ready: String(cfg.plan?.min_ready ?? 8), target_ready: (cfg.plan?.target_ready || [10, 20]).join('–'),
    mutation_scope: (cfg.security?.mutation_scope || ['the dev target']).join(', '),
    recheck_minutes: String(cfg.bot?.recheck_after_push_minutes ?? 3),
    environment_name: cfg.environment?.name || 'the configured dev target',
    ...(cfg.routing?.packet_max_words ? { packet_max_words: String(cfg.routing.packet_max_words) } : {}),
  };
}

function fill(text, vars, missing) {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
    if (k in vars) return String(vars[k]);
    missing.add(k); return `{{${k}}}`;
  });
}

// Render brief `name`; injects rule blocks (cfg.brief_rules) and the runtime wrapper. Pure.
export function renderBrief(name, userVars = {}, cfg = null) {
  if (!briefNames().includes(name)) throw new RelayError(`unknown brief: ${name}`, EXIT.INVALID);
  const vars = { ...OPTIONAL, ...configVars(cfg), ...userVars };
  const missing = new Set();
  const parts = [fill(read(`briefs/${name}.md`), vars, missing)];
  const rules = cfg?.brief_rules || RULE_FILES;
  const mainOnly = [...RULE_FILES, 'journal', 'ownership'].includes(name);
  if (!mainOnly) {
    for (const r of rules) {
      if (r === 'codex-rules' && !vars.bot_logins) continue;
      if (r === 'worktree-safety' && !('issue' in vars) && !('branch' in vars)) continue;
      parts.push(fill(read(`briefs/${r}.md`), { branch: '<branch>', issue: '<N>', runtime: vars.runtime || '<runtime>', ...vars }, missing));
    }
    if (JOURNAL_BRIEFS.includes(name) && 'issue' in vars) parts.push(fill(read('briefs/journal.md'), vars, missing));
    if (OWNERSHIP_BRIEFS.includes(name) && 'issue' in vars) parts.push(fill(read('briefs/ownership.md'), vars, missing));
    const rt = vars.runtime;
    if (rt && fs.existsSync(path.join(CORE, `adapters/runtime/${rt}/wrapper.md`))) parts.push(read(`adapters/runtime/${rt}/wrapper.md`));
  }
  if (missing.size) throw new RelayError(`brief ${name}: missing variables: ${[...missing].sort().join(', ')}`, EXIT.INVALID, { missing: [...missing] });
  const text = parts.join('\n\n') + '\n';
  return { text, hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 8) };
}
