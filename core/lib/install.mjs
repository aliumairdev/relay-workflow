// Installer engine for `relay-workflow init|update|uninstall`.
// Every change is an "op" evaluated against the filesystem first (so --dry-run and the real run share one code path),
// then committed. Managed blocks and a lock file with checksums make init idempotent, update drift-aware and
// uninstall exact. Content outside managed blocks is never touched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { CORE, parseConfig, withDefaults } from './config.mjs';
import { loadProfile, listProfiles, profileDir } from './profile.mjs';
import { renderAgents, parseTemplate } from './agents.mjs';
import { upsertBlock, removeBlock, findBlock, wrap, sha, mergeJson, revertJson } from './managed.mjs';
import { now, iso } from './clock.mjs';
import { RelayError, EXIT } from './exit.mjs';

export const VERSION = JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8')).version;
export const RUNTIMES = ['claude', 'codex', 'cursor', 'gemini', 'copilot'];
const HEADLESS = { claude: { exec_cmd: 'claude -p', prompt_mode: 'arg' }, codex: { exec_cmd: 'codex exec', prompt_mode: 'arg' }, gemini: { exec_cmd: 'gemini -p', prompt_mode: 'arg' } };
const read = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

// ---- detection ------------------------------------------------------------------------------
export function detectStack(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  if (has('layout/theme.liquid') || has('config/settings_schema.json')) return 'shopify-theme';
  if (has('config/application.rb') || has('Gemfile') && has('bin/rails')) return 'rails';
  if (['next.config.js', 'next.config.mjs', 'next.config.ts'].some(has)) return 'nextjs';
  return 'generic';
}
function git(root, args) { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
export function detectRepo(root) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(git(root, ['remote', 'get-url', 'origin']));
  return m ? `${m[1]}/${m[2]}` : 'local';
}
export function detectBranch(root) {
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  return head || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
}
function detectCi(root) {
  const f = path.join(root, 'package.json');
  if (!fs.existsSync(f)) return [];
  let scripts = {}; try { scripts = JSON.parse(fs.readFileSync(f, 'utf8')).scripts || {}; } catch { return []; }
  return ['lint', 'check', 'test', 'build'].filter((s) => scripts[s]).map((s) => ({ name: s, cmd: s === 'test' ? 'npm test --silent' : `npm run -s ${s}` }));
}

// ---- workflow.yaml generation ---------------------------------------------------------------
export function generateConfig(root, { stack, runtimes, name, repo }) {
  const profile = loadProfile(stack) || {};
  const rt = {};
  if (runtimes.includes('claude')) rt.claude = { enabled: true, ...HEADLESS.claude, resume: 'send_message', models: { T0: 'claude-haiku-5-5', T1: 'claude-sonnet-5-5', T2: 'claude-opus-5-5', T3: 'claude-fable-5-1' }, effort_env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' }, strengths: ['orchestration', 'parallel-subagents', 'ui-design-gate', 'review'] };
  if (runtimes.includes('codex')) rt.codex = { enabled: true, ...HEADLESS.codex, exec_args: [], resume: 'relaunch', models: { T0: '<mini-model>', T1: '<default-model>', T2: '<top-model>' }, strengths: ['focused-implementation', 'review', 'long-running-refactor'], bot: { logins: ['chatgpt-codex-connector[bot]'], severity_block: ['P0', 'P1'] } };
  if (runtimes.includes('gemini')) rt.gemini = { enabled: true, ...HEADLESS.gemini, resume: 'relaunch', models: { T0: '<mini-model>', T1: '<default-model>', T2: '<top-model>' }, strengths: ['large-context'] };
  const headless = Object.keys(rt);
  const ci = { mode: 'local', retry_once_on_fail: true, steps: profile.ci?.steps || detectCi(root), ...(profile.ci?.full_steps ? { full_steps: profile.ci.full_steps } : {}), ...(profile.ci?.sync_steps ? { sync_steps: profile.ci.sync_steps } : {}), ...(profile.ci?.failure_grep ? { failure_grep: profile.ci.failure_grep } : {}) };
  const cfg = {
    version: 1,
    project: { name, repo, default_branch: detectBranch(root), stack, worktree_root: `~/worktrees/${name}`, state_file: 'harness/STATE.json' },
    policy: { mode: 'gated', fast_merge: { close_note: 'Fixed by merged PR #{pr}; verification follows on main.', post_merge_qa: 'required' } },
    ...(headless.length ? { runtimes: rt } : {}),
    runtime_policy: { default: 'any', fallback_order: headless },
    review: { cross_runtime: headless.length > 1, routine_tier: 'T1', order: ['acceptance', 'architecture', 'correctness', 'tests', 'security'], delta_only_rereview: true, max_rework_rounds: 3 },
    labels: { file: 'core/labels.json', aliases: {} },
    claims: { lease_minutes: 30, heartbeat_minutes: 10, branch_pattern: 'agent/{runtime}/{issue}-{slug}' },
    plan: { min_ready: 8, target_ready: [10, 20] },
    ci,
    bot: { gate: !!rt.codex, logins: rt.codex ? rt.codex.bot.logins : [], require_reply_from_non_bot: true, recheck_after_push_minutes: 3 },
    ...(profile.environment ? { environment: profile.environment } : {}),
    ...(profile.proof ? { proof: profile.proof } : {}),
    resolvers: profile.resolvers || [{ match: '**/*.md', strategy: 'union' }],
    ...(profile.shared_append_only?.length ? { shared_append_only: profile.shared_append_only } : {}),
    routing: { allow_high_effort: false, default_effort: 'medium', packet_max_words: 500, ...(profile.risk ? { risk: { thresholds: { second_reviewer: 40, senior: 80 }, hard_senior_paths: profile.risk.hard_senior_paths || [], signals: (profile.risk.paths?.length ? [{ kind: 'path', globs: profile.risk.paths, points: 40 }] : []).concat([{ kind: 'label', any: ['risk:high'], points: 50 }, { kind: 'rework', rounds_gte: 2, points: 20 }]) } } : {}) },
    budgets: { tier_share_max: { T2: 0.04, T3: 0.01, top_combined: 0.05 }, per_pr_cost_ceiling_usd: 15 },
    concurrency: { max_agents: 8, hard_max: 20, load_limit_factor: 1.5, heavy_slots: 2 },
    rate_limit: { max_retries: 3, backoff_s: [30, 60, 120] },
    security: { secret_patterns: ['(?i)password\\s*[:=]\\s*\\S+', 'ghp_[A-Za-z0-9]+', 'sk-[A-Za-z0-9]{20,}'], destructive_allowlist: [], mutation_scope: profile.environment?.name ? [profile.environment.name] : [] },
    telemetry: 'off',
    honesty: { require_not_verified: true, evidence_lint: true },
    journal: { require: ['plan', 'summary'] },
  };
  const header = `# Relay workflow configuration (generated by relay-workflow init ${VERSION}). Edit freely: init never overwrites this file.\n# Models marked <...> are placeholders: set them before dispatching to that runtime.\n# policy.mode: gated (reviewed, CI + bot gate + verdict) | fast (merge first, verify after).\n`;
  return header + YAML.stringify(cfg, { lineWidth: 0 });
}

export function configFromText(text, root) {
  const { value, errors } = parseConfig(text);
  if (errors.length) throw new RelayError(`workflow.yaml is invalid:\n${errors.map((e) => `  line ${e.line ?? '?'} ${e.path}: ${e.message}`).join('\n')}`, EXIT.INVALID);
  const cfg = withDefaults(value);
  Object.defineProperty(cfg, '__root', { value: root, enumerable: false });
  Object.defineProperty(cfg, '__file', { value: path.join(root, 'workflow.yaml'), enumerable: false });
  return cfg;
}

// ---- content builders -----------------------------------------------------------------------
function agentsBlock(cfg, profile) {
  const rules = profile?.brief_rules?.profile_rules || 'See docs/ for architecture and conventions; add project-specific architecture rules here.';
  const cmds = (cfg.ci.steps || []).map((s) => `- ${s.name}: \`${s.cmd}\``).join('\n') || '- (no validation commands configured: set `ci.steps` in workflow.yaml)';
  return read('templates/AGENTS.template.md').replace('{{architecture_rules}}', rules).replace('{{validation_commands}}', cmds);
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]));
}
function skillOps(srcDir, dstBase) {
  if (!fs.existsSync(srcDir)) return [];
  return listFiles(srcDir).map((f) => ({ type: 'create', path: `${dstBase}/${f}`, content: fs.readFileSync(path.join(srcDir, f), 'utf8') }));
}

function shimOps() {
  const dir = path.join(CORE, 'scripts');
  return fs.readdirSync(dir).filter((f) => f.startsWith('relay-')).sort().map((f) => ({
    type: 'create', path: `.relay/bin/${f}`, mode: 0o755,
    content: `#!/bin/sh\n# generated by relay-workflow ${VERSION}; runs the installed copy, or fetches the pinned version\nR=${JSON.stringify(path.join(dir, f))}\n[ -f "$R" ] && exec node "$R" "$@"\nexec npx --yes relay-workflow@${VERSION} ${f.slice(6)} "$@"\n`,
  }));
}

const cursorRules = () => `---\ndescription: Relay multi-agent workflow rules\nalwaysApply: true\n---\nRead AGENTS.md first: it is the single contract for this repository.\n\n- Work claim-first: \`relay-claim <issue> --agent <id> --runtime cursor\` (or the \`claim_issue\` MCP tool). Never edit without a claim.\n- Work in your own worktree on \`agent/cursor/<issue>-<slug>\`; verify with \`relay-worktree verify\`.\n- Keep the issue history current with \`relay-journal post <issue> --kind plan|progress|decision|test|blocker|pr|summary\`.\n- Stop with work remaining? \`relay-handoff post <issue> --to <runtime> --reason <reason>\`; never go silent.\n- Tier names only (T0 docs, T1 implement, T2 high-risk, T3 exceptional); ask \`relay-route\` before raising effort or tier.\n- Never claim a check passed without running it; list gaps under NOT_VERIFIED. Never commit secrets.\n`;
const geminiBlock = () => `@AGENTS.md\n\n## Gemini notes\nThe contract above applies unchanged. Use \`relay-claim\`, \`relay-journal\` and \`relay-handoff\` exactly as described; work only in your claimed worktree.\n`;
const copilotBlock = () => `# Relay workflow\n\nRead AGENTS.md first: it is the single contract for this repository.\n\n- Claim an issue before editing (\`relay-claim\`); work on \`agent/<runtime>/<issue>-<slug>\` in a separate worktree.\n- Keep the issue history current (\`relay-journal post\`): plan before coding, progress, decisions, tests, blockers, PR, summary.\n- Hand work off explicitly (\`relay-handoff post\`); do not leave a claim silent.\n- Tier names only; no model ids in shared docs.\n- Do not claim a check passed unless you ran it; list gaps under NOT_VERIFIED.\n- Never commit secrets.\n`;

const GITIGNORE = `.relay/*\n!.relay/lock.json`;

// ---- plan -----------------------------------------------------------------------------------
export function buildPlan(root, opts = {}) {
  const warnings = [];
  const cfgFile = path.join(root, 'workflow.yaml');
  const existing = fs.existsSync(cfgFile);
  const stack = opts.stack || detectStack(root);
  if (!existing && !listProfiles().includes(stack)) throw new RelayError(`unknown stack "${stack}" (available: ${listProfiles().join(', ')})`, EXIT.INVALID);
  const runtimes = opts.runtimes?.length ? opts.runtimes : ['claude'];
  for (const r of runtimes) if (!RUNTIMES.includes(r)) throw new RelayError(`unknown runtime "${r}" (available: ${RUNTIMES.join(', ')})`, EXIT.INVALID);
  const name = opts.name || path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const cfgText = existing ? fs.readFileSync(cfgFile, 'utf8') : generateConfig(root, { stack, runtimes, name, repo: opts.repo || detectRepo(root) });
  const cfg = configFromText(cfgText, root);
  const profile = loadProfile(cfg.project.stack || stack);
  const ops = [];
  const add = (op) => ops.push(op);

  add({ type: 'create', path: 'workflow.yaml', content: cfgText });
  add({ type: 'block', path: 'AGENTS.md', name: 'agents', body: agentsBlock(cfg, profile) });
  if (runtimes.includes('claude')) {
    add({ type: 'block', path: 'CLAUDE.md', name: 'claude', body: read('templates/CLAUDE.template.md').replace(/^@AGENTS\.md\n+/, ''), importLine: '@AGENTS.md' });
    add({ type: 'json', path: '.claude/settings.json', patch: { env: cfg.runtimes?.claude?.effort_env || { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } } });
    for (const a of renderAgents(cfg, { dir: path.join(CORE, 'agents') })) add({ type: 'create', path: `.claude/agents/${a.file}`, content: a.content });
  }
  if (runtimes.includes('codex')) {
    for (const a of renderAgents(cfg, { dir: path.join(CORE, 'agents') })) add({ type: 'create', path: `.relay/codex/prompts/${a.file}`, content: parseTemplate(a.content, a.file).body });
  }
  if (runtimes.includes('cursor')) add({ type: 'create', path: '.cursor/rules/relay.mdc', content: cursorRules() });
  if (runtimes.includes('gemini')) add({ type: 'block', path: 'GEMINI.md', name: 'gemini', body: geminiBlock() });
  if (runtimes.includes('copilot')) add({ type: 'block', path: '.github/copilot-instructions.md', name: 'copilot', body: copilotBlock() });

  // Skills: Codex and other file-based runtimes read .agents/skills; Claude gets profile skills (core skills ship in the plugin).
  const skills = opts.skills || 'auto';
  const coreSkills = (dst) => { for (const d of fs.readdirSync(path.join(CORE, 'skills')).sort()) ops.push(...skillOps(path.join(CORE, 'skills', d), `${dst}/${d}`)); };
  const profSkills = (dst) => { const sd = path.join(profileDir(cfg.project.stack || stack), profile?.skills || 'skills'); if (fs.existsSync(sd)) for (const d of fs.readdirSync(sd).sort()) ops.push(...skillOps(path.join(sd, d), `${dst}/${d}`)); };
  if (skills !== 'none') {
    const fileBased = runtimes.some((r) => r !== 'claude');
    if (fileBased) { if (skills !== 'profile') coreSkills('.agents/skills'); profSkills('.agents/skills'); }
    if (runtimes.includes('claude')) { if (skills === 'all') coreSkills('.claude/skills'); profSkills('.claude/skills'); }
  }

  add({ type: 'create', path: '.github/ISSUE_TEMPLATE/task.md', content: `---\nname: Task\nabout: A unit of agent work\nlabels: state:backlog\n---\n${read('templates/issue.md')}` });
  add({ type: 'create', path: '.github/pull_request_template.md', content: read('templates/pull_request.md') });
  add({ type: 'create', path: 'harness/STATE.json', content: JSON.stringify({ ...JSON.parse(read('templates/STATE.json')), policy: { mode: cfg.policy.mode, changed_at: null, reason: null } }, null, 2) + '\n' });
  for (const d of ['handoffs', 'blockers', 'reports', 'proof']) add({ type: 'create', path: `harness/${d}/.gitkeep`, content: '' });
  add({ type: 'block', path: '.gitignore', name: 'relay', body: GITIGNORE, style: 'hash' });
  ops.push(...shimOps());
  return { ops, cfg, stack: cfg.project.stack || stack, runtimes, warnings };
}

// ---- evaluate / commit ----------------------------------------------------------------------
const abs = (root, p) => path.join(root, p);
const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

export function evaluate(root, op, lockEntry = null) {
  const f = abs(root, op.path);
  const before = readOr(f);
  let after = before, action = 'unchanged', meta = {};
  if (op.type === 'create') {
    if (before == null) { after = op.content; action = 'create'; }
    else if (before === op.content) action = 'unchanged';
    else if (lockEntry) { after = op.content; action = 'modify'; }         // ours from an earlier run: update decides about hand edits
    else { action = 'keep-existing'; }                                     // a file the user already had: never overwritten
    meta = { sha: sha(op.content), mode: op.mode };
  } else if (op.type === 'block') {
    let base = before;
    if (op.importLine && base != null && !new RegExp(`^${op.importLine}\\s*$`, 'm').test(base.replace(/```[\s\S]*?```/g, ''))) base = `${op.importLine}\n\n${base}`;
    const body = op.importLine && (base == null || !findBlock(base, op.name, op.style)) && (before == null || base !== before || true) ? op.body : op.body;
    let seed = base;
    if (op.importLine && seed == null) seed = `${op.importLine}\n`;
    const up = upsertBlock(seed, op.name, body, op.style || 'html');
    after = up.text;
    action = before == null ? 'create' : after === before ? 'unchanged' : 'modify';
    meta = { sha: sha(wrap(op.name, body, op.style || 'html')), prefix: up.prefix ?? lockEntry?.prefix ?? '', name: op.name, style: op.style || 'html', importAdded: !!(op.importLine && before != null && base !== before) || (op.importLine && before == null) };
  } else if (op.type === 'json') {
    let cur = {}; if (before != null) { try { cur = JSON.parse(before); } catch { throw new RelayError(`${op.path} is not valid JSON; fix or remove it first`, EXIT.INVALID); } }
    const { value, record } = mergeJson(cur, op.patch);
    after = JSON.stringify(value, null, 2) + '\n';
    action = before == null ? 'create' : record.length ? 'modify' : 'unchanged';
    meta = { record: lockEntry && !record.length ? lockEntry.record : [...(lockEntry?.record || []), ...record] };
  }
  return { op, path: op.path, action, before, after, meta, existed: before != null };
}

function writeFile(root, p, content, mode) {
  const f = abs(root, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  if (mode) fs.chmodSync(f, mode);
}

function unifiedDiff(label, before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diff-'));
  fs.writeFileSync(path.join(dir, 'a'), before ?? ''); fs.writeFileSync(path.join(dir, 'b'), after ?? '');
  const r = spawnSync('diff', ['-u', '--label', `a/${label}`, '--label', `b/${label}`, path.join(dir, 'a'), path.join(dir, 'b')], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout;
}

export const readLock = (root) => { try { return JSON.parse(fs.readFileSync(abs(root, '.relay/lock.json'), 'utf8')); } catch { return null; } };

// init: evaluate every op; with dryRun return the diffs, otherwise write files, back up originals and write the lock.
export function init(root, opts = {}) {
  const plan = buildPlan(root, opts);
  const lock = readLock(root);
  const evals = plan.ops.map((op) => evaluate(root, op, lock?.files?.[op.path]));
  const changes = evals.filter((e) => ['create', 'modify'].includes(e.action));
  const kept = evals.filter((e) => e.action === 'keep-existing').map((e) => e.path);
  const summary = { stack: plan.stack, runtimes: plan.runtimes, create: evals.filter((e) => e.action === 'create').map((e) => e.path), modify: evals.filter((e) => e.action === 'modify').map((e) => e.path), kept, unchanged: evals.filter((e) => e.action === 'unchanged').length };
  if (opts.dryRun) return { ...summary, dryRun: true, diffs: changes.map((e) => unifiedDiff(e.path, e.before, e.after)).join('\n') };

  const stamp = iso(now()).replace(/[:]/g, '-');
  const next = { version: VERSION, stack: plan.stack, runtimes: plan.runtimes, installed_at: lock?.installed_at || iso(now()), files: { ...(lock?.files || {}) } };
  for (const e of evals) {
    const prev = lock?.files?.[e.path];
    if (e.action === 'keep-existing') continue;
    if (['create', 'modify'].includes(e.action)) {
      if (e.existed && !prev?.backedUp && !fs.existsSync(abs(root, `.relay/backup/${stamp}/${e.path}`)) && !(e.path.startsWith('.relay/'))) writeFile(root, `.relay/backup/${stamp}/${e.path}`, e.before);
      writeFile(root, e.path, e.after, e.meta.mode);
    }
    const created = prev ? prev.created : !e.existed;
    next.files[e.path] = { type: e.op.type, created, sha: e.meta.sha, ...(e.op.type === 'block' ? { name: e.meta.name, style: e.meta.style, prefix: prev?.prefix ?? e.meta.prefix ?? '', importAdded: prev?.importAdded ?? e.meta.importAdded } : {}), ...(e.op.type === 'json' ? { record: e.meta.record } : {}), ...(e.existed && !prev ? { backedUp: stamp } : prev?.backedUp ? { backedUp: prev.backedUp } : {}) };
  }
  const lockText = JSON.stringify(next, null, 2) + '\n';
  if (readOr(abs(root, '.relay/lock.json')) !== lockText) writeFile(root, '.relay/lock.json', lockText);
  return { ...summary, dryRun: false };
}

// update: re-plan with the locked options; hand-edited managed content is never overwritten silently.
export function update(root, opts = {}) {
  const lock = readLock(root);
  if (!lock) throw new RelayError('not installed: run relay-workflow init first', EXIT.INVALID);
  const plan = buildPlan(root, { stack: lock.stack, runtimes: lock.runtimes, skills: opts.skills });
  const evals = plan.ops.map((op) => ({ ...evaluate(root, op, lock.files[op.path] || { sha: '', record: [] }), lock: lock.files[op.path] }));
  const conflicts = [], toApply = [];
  for (const e of evals) {
    if (!['modify', 'create'].includes(e.action) && e.action !== 'unchanged') continue;
    const prev = lock.files[e.path];
    if (e.action === 'create' || !prev) { toApply.push(e); continue; }
    let currentSha = null;
    if (prev.type === 'create' && e.before != null) currentSha = sha(e.before);
    if (prev.type === 'block' && e.before != null) { const b = findBlock(e.before, prev.name, prev.style); currentSha = b ? sha(b.body) : null; }
    const edited = currentSha != null && currentSha !== prev.sha && !(e.action === 'unchanged');
    if (e.action === 'modify' && edited) conflicts.push(e); else if (e.action === 'modify') toApply.push(e);
  }
  const summary = { conflicts: conflicts.map((e) => e.path), apply: toApply.filter((e) => e.action === 'modify').map((e) => e.path), create: toApply.filter((e) => e.action === 'create').map((e) => e.path) };
  if (opts.dryRun) return { ...summary, dryRun: true, diffs: [...toApply, ...conflicts].map((e) => unifiedDiff(e.path, e.before, e.after)).join('\n') };
  if (conflicts.length && !opts.keep && !opts.overwrite) return { ...summary, needsHuman: true };
  const stamp = iso(now()).replace(/[:]/g, '-');
  const next = { ...lock, version: VERSION, files: { ...lock.files } };
  for (const e of [...toApply, ...(opts.overwrite ? conflicts : [])]) {
    if (e.existed) writeFile(root, `.relay/backup/${stamp}/${e.path}`, e.before);
    writeFile(root, e.path, e.after, e.meta.mode);
    const prev = lock.files[e.path];
    next.files[e.path] = { ...(prev || { type: e.op.type, created: !e.existed }), type: e.op.type, sha: e.meta.sha, ...(e.op.type === 'json' ? { record: e.meta.record } : {}) };
  }
  writeFile(root, '.relay/lock.json', JSON.stringify(next, null, 2) + '\n');
  return { ...summary, kept: opts.keep ? summary.conflicts : [], dryRun: false };
}

// uninstall: remove managed blocks, revert merged JSON keys, delete files that still match the lock.
export function uninstall(root, opts = {}) {
  const lock = readLock(root);
  if (!lock) throw new RelayError('not installed: nothing to uninstall', EXIT.INVALID);
  const removed = [], kept = [], reverted = [];
  const entries = Object.entries(lock.files).sort(([a], [b]) => (a < b ? 1 : -1));
  const rmEmptyDirs = (p) => { let d = path.dirname(abs(root, p)); while (d.startsWith(root) && d !== root) { try { fs.rmdirSync(d); } catch { break; } d = path.dirname(d); } };
  for (const [p, e] of entries) {
    const f = abs(root, p);
    if (!fs.existsSync(f)) continue;
    if (opts.keepConfig && p === 'workflow.yaml') { kept.push(p); continue; }
    const text = fs.readFileSync(f, 'utf8');
    if (e.type === 'create') {
      if (sha(text) === e.sha || opts.force) { if (!opts.dryRun) { fs.rmSync(f); rmEmptyDirs(p); } removed.push(p); } else kept.push(p);
    } else if (e.type === 'block') {
      const r = removeBlock(text, e.name, e.style, e.prefix || '');
      let out = r.text;
      if (e.importAdded) out = out.replace(/^@AGENTS\.md\n(\n)?/, '');
      if (!r.removed) continue;
      if (!opts.dryRun) { if (out === '' && e.created) { fs.rmSync(f); rmEmptyDirs(p); } else fs.writeFileSync(f, out); }
      reverted.push(p);
    } else if (e.type === 'json') {
      let cur; try { cur = JSON.parse(text); } catch { kept.push(p); continue; }
      const v = revertJson(cur, e.record || []);
      if (!opts.dryRun) { if (e.created && !Object.keys(v).length) { fs.rmSync(f); rmEmptyDirs(p); } else fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); }
      reverted.push(p);
    }
  }
  if (!opts.dryRun) {
    fs.rmSync(abs(root, '.relay/lock.json'), { force: true });
    fs.rmSync(abs(root, '.relay/backup'), { recursive: true, force: true });
    for (const d of ['.relay/bin', '.relay/codex/prompts', '.relay/codex', '.relay']) { try { fs.rmdirSync(abs(root, d)); } catch { /* not empty: runtime data stays */ } }
  }
  return { removed, reverted, kept, dryRun: !!opts.dryRun };
}
