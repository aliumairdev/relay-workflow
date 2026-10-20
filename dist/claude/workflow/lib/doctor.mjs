// relay-workflow doctor (PLUGIN_SPEC 12.3). Each check returns {id, status: pass|warn|fail|skip, message, fix?}.
// Exit semantics are applied by the caller: 0 all pass, 1 warnings, 3 failures.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE, findConfig, parseConfig, withDefaults } from './config.mjs';
import { readLock, VERSION, configFromText } from './install.mjs';
import { findBlock, sha, upsertBlock } from './managed.mjs';
import { modelIds } from './neutrality.mjs';
import { CATALOG, violations } from './labels.mjs';
import { decide } from './router.mjs';
import { controlPlane } from '../adapters/control-plane/github.mjs';
import { listWorktrees, isInside, realish } from './worktree.mjs';
import { readState } from './state.mjs';

const compat = JSON.parse(fs.readFileSync(path.join(CORE, 'compat.json'), 'utf8'));
const res = (id, status, message, fix) => ({ id, status, message, ...(fix ? { fix } : {}) });
const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

export async function doctor(root, { fix = false, env = process.env } = {}) {
  const checks = [];
  const add = (c) => { checks.push(c); return c; };
  const cfgFile = findConfig(root) && fs.existsSync(path.join(root, 'workflow.yaml')) ? path.join(root, 'workflow.yaml') : null;
  let cfg = null;

  // Config
  if (!cfgFile) add(res('config', 'fail', 'workflow.yaml not found: run `relay-workflow init`'));
  else {
    const { value, errors } = parseConfig(fs.readFileSync(cfgFile, 'utf8'));
    if (errors.length) add(res('config', 'fail', `workflow.yaml invalid: ${errors.map((e) => `line ${e.line ?? '?'} ${e.path}: ${e.message}`).join('; ')}`));
    else {
      cfg = configFromText(fs.readFileSync(cfgFile, 'utf8'), root);
      const notes = [];
      const placeholders = Object.entries(cfg.runtimes || {}).flatMap(([rt, r]) => Object.entries(r.models || {}).filter(([, m]) => /^<.*>$/.test(String(m))).map(([t]) => `${rt}.${t}`));
      if (placeholders.length) notes.push(`placeholder model ids: ${placeholders.join(', ')}`);
      const missingPaths = Object.entries(cfg.roles || {}).flatMap(([id, r]) => (r.paths || []).filter((p) => !/[*?{]/.test(p) && !fs.existsSync(path.join(root, p))).map((p) => `role ${id}: ${p}`));
      if (missingPaths.length) notes.push(`role paths missing: ${missingPaths.join(', ')}`);
      const unpriced = Object.keys(cfg.tiers || {}).filter((t) => !cfg.tiers[t].price_usd_per_mtok && cfg.tiers[t].cost_rel == null);
      if (unpriced.length) notes.push(`tiers without a price: ${unpriced.join(', ')} (cost reports will be estimates)`);
      add(notes.length ? res('config', 'warn', `schema-valid; ${notes.join('; ')}`) : res('config', 'pass', 'workflow.yaml is schema-valid'));
    }
  }

  const lock = readLock(root);
  const runtimes = cfg ? Object.entries(cfg.runtimes || {}).filter(([, r]) => r.enabled !== false).map(([n]) => n) : [];
  const claudeOn = runtimes.includes('claude') || lock?.runtimes?.includes('claude');

  // CLAUDE imports AGENTS
  if (!claudeOn) add(res('claude-imports-agents', 'skip', 'Claude runtime not enabled'));
  else {
    const t = readOr(path.join(root, 'CLAUDE.md'));
    const has = t != null && /^@AGENTS\.md\s*$/m.test(t.replace(/```[\s\S]*?```/g, ''));
    if (has) add(res('claude-imports-agents', 'pass', 'CLAUDE.md imports @AGENTS.md'));
    else {
      const c = add(res('claude-imports-agents', 'fail', t == null ? 'CLAUDE.md is missing' : 'CLAUDE.md has no `@AGENTS.md` import line', 'insert the import line'));
      if (fix) { fs.writeFileSync(path.join(root, 'CLAUDE.md'), `@AGENTS.md\n\n${t ?? ''}`); c.status = 'pass'; c.message = 'inserted the @AGENTS.md import (fixed)'; c.fixed = true; }
    }
  }

  // AGENTS neutral + size
  const agents = readOr(path.join(root, 'AGENTS.md'));
  if (agents == null) { add(res('agents-neutral', 'fail', 'AGENTS.md is missing')); add(res('agents-size', 'skip', 'AGENTS.md is missing')); }
  else {
    const configured = cfg ? Object.values(cfg.runtimes || {}).flatMap((r) => Object.values(r.models || {})).filter((m) => m && !/^<.*>$/.test(String(m))) : [];
    const lines = agents.split('\n').flatMap((l, i) => {
      const hits = [...modelIds(l), ...configured.filter((m) => l.includes(m))];
      if (/\.claude\//.test(l) || /SendMessage/.test(l)) hits.push('runtime-specific reference');
      return hits.length ? [`line ${i + 1}: ${[...new Set(hits)].join(', ')}`] : [];
    });
    add(lines.length ? res('agents-neutral', 'fail', `AGENTS.md is not runtime-neutral (use tier names): ${lines.slice(0, 5).join('; ')}`, 'replace model ids with tier names (T0..T3)') : res('agents-neutral', 'pass', 'AGENTS.md names tiers only'));
    const bytes = Buffer.byteLength(agents), max = cfg?.agents_md?.max_bytes ?? 32768, warn = Math.round(max * 0.75);
    add(bytes > max ? res('agents-size', 'fail', `AGENTS.md is ${bytes} bytes (limit ${max}): trim it`) : bytes > warn ? res('agents-size', 'warn', `AGENTS.md is ${bytes} bytes (warn at ${warn})`) : res('agents-size', 'pass', `AGENTS.md is ${bytes} bytes`));
  }

  // Generated drift
  if (!lock) add(res('generated-drift', 'warn', 'no .relay/lock.json: not installed with relay-workflow, drift cannot be checked'));
  else {
    const drift = [];
    for (const [p, e] of Object.entries(lock.files)) {
      const t = readOr(path.join(root, p));
      if (t == null) { if (e.type !== 'dir') drift.push(`${p} (missing)`); continue; }
      if (e.type === 'create' && sha(t) !== e.sha) drift.push(`${p} (edited)`);
      if (e.type === 'block') { const b = findBlock(t, e.name, e.style); if (!b) drift.push(`${p} (managed block removed)`); else if (sha(b.body) !== e.sha) drift.push(`${p} (managed block edited)`); }
    }
    add(drift.length ? res('generated-drift', 'warn', `generated content differs from the lock: ${drift.slice(0, 6).join(', ')}${drift.length > 6 ? ` +${drift.length - 6}` : ''}`, 'run `relay-workflow update` (keeps edits with --keep)') : res('generated-drift', 'pass', `${Object.keys(lock.files).length} generated entries match the lock`));
    add(lock.version === VERSION ? res('version', 'pass', `installed ${lock.version}`) : res('version', 'warn', `installed ${lock.version}, tool is ${VERSION}`, 'run `relay-workflow update`'));
  }

  // Auth / binaries
  const gh = env.RELAY_GH || 'gh';
  const auth = run(gh, ['auth', 'status'], { env });
  const authRes = add(auth.error ? res('auth', 'warn', `gh not found (${gh}): GitHub control plane unavailable`, 'install the GitHub CLI and run `gh auth login`') : auth.status === 0 ? res('auth', 'pass', 'gh is authenticated') : res('auth', 'warn', 'gh is not authenticated', 'run `gh auth login`'));
  const missingBins = [];
  for (const rt of runtimes) {
    const cmd = cfg.runtimes[rt].exec_cmd?.trim().split(/\s+/)[0];
    if (!cmd) continue;
    const found = path.isAbsolute(cmd) ? fs.existsSync(cmd) : run('sh', ['-c', `command -v ${JSON.stringify(cmd)}`]).status === 0;
    if (!found) missingBins.push(`${rt}: ${cmd}`);
  }
  add(missingBins.length ? res('runtime-binaries', 'warn', `runtime binaries not found: ${missingBins.join(', ')} (that runtime cannot be dispatched headlessly; fallback applies)`) : res('runtime-binaries', runtimes.length ? 'pass' : 'skip', runtimes.length ? 'runtime binaries present' : 'no runtimes configured'));

  // Labels (needs the control plane)
  if (!cfg || cfg.project.repo === 'local' || authRes.status !== 'pass') add(res('labels', 'skip', 'control plane not available'));
  else {
    try {
      const cp = controlPlane(cfg);
      const have = new Set(cp.listRepoLabels().map((l) => l.name));
      const missing = CATALOG.labels.filter((l) => !have.has(l.name));
      const open = cp.listIssues({ state: 'open' });
      const bad = open.filter((i) => violations(i.labels).length);
      const c = add(missing.length || bad.length ? res('labels', missing.length ? 'fail' : 'warn', `${missing.length} label(s) missing${bad.length ? `; ${bad.length} issue(s) violate exclusion rules (${bad.slice(0, 4).map((i) => '#' + i.number).join(', ')})` : ''}`, 'create labels / `relay-labels lint --fix`') : res('labels', 'pass', `${CATALOG.labels.length} labels present; no exclusion violations`));
      if (fix && (missing.length || bad.length)) {
        for (const l of missing) cp.createLabel(l);
        c.status = 'pass'; c.message = `created ${missing.length} label(s) (fixed); run relay-labels lint --fix for ${bad.length} issue(s)`; c.fixed = true;
      }
    } catch (e) { add(res('labels', 'warn', `could not check labels: ${String(e.message).split('\n')[0]}`)); }
  }

  // Routing sanity
  if (!cfg) add(res('routing', 'skip', 'no config'));
  else {
    const problems = [];
    for (const cls of ['plan', 'implement', 'routine_review', 'high_risk_review', 'docs', 'audit', 'debug_real_env', 'conflict_resolution', 'triage']) {
      try { const r = decide({ target: { kind: 'issue', number: 1 }, class: cls, labels: [], paths: [] }, cfg); if (!r.decision && !r.denied) problems.push(`${cls} did not resolve`); } catch (e) { problems.push(`${cls}: ${String(e.message).split('\n')[0]}`); }
    }
    const top = cfg.budgets?.tier_share_max?.top_combined;
    if (top != null && top > 0.05) problems.push(`top-tier cap ${top} exceeds 5 percent`);
    if (cfg.routing?.allow_high_effort === true) problems.push('routing.allow_high_effort is true (effort should stay medium)');
    add(problems.length ? res('routing', 'warn', problems.join('; ')) : res('routing', 'pass', 'every task class resolves; caps within 5 percent; effort not raised'));
  }

  // Scripts executable
  const scripts = path.join(CORE, 'scripts');
  const notExec = fs.readdirSync(scripts).filter((f) => f.startsWith('relay-') && !(fs.statSync(path.join(scripts, f)).mode & 0o111));
  const sc = add(notExec.length ? res('scripts', 'fail', `not executable: ${notExec.join(', ')}`, 'chmod +x') : res('scripts', 'pass', 'all relay-* scripts are executable'));
  if (fix && notExec.length) { for (const f of notExec) fs.chmodSync(path.join(scripts, f), 0o755); sc.status = 'pass'; sc.message = `made ${notExec.length} script(s) executable (fixed)`; sc.fixed = true; }

  // Secrets
  {
    const pats = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bsk-[A-Za-z0-9_-]{20,}\b/, ...(cfg?.security?.secret_patterns || []).map((p) => { try { return new RegExp(p.replace(/^\(\?i\)/, ''), p.startsWith('(?i)') ? 'i' : ''); } catch { return null; } }).filter(Boolean)];
    const tracked = run('git', ['ls-files'], { cwd: root }).stdout.split('\n').filter(Boolean);
    const extra = ['harness/STATE.json', '.relay/ledger/usage.jsonl'].filter((f) => fs.existsSync(path.join(root, f)));
    const hits = [];
    for (const f of [...new Set([...tracked, ...extra])]) {
      if (/(^|\/)(node_modules|dist|\.relay\/(bin|backup))\//.test(f) || /\.(png|jpe?g|gif|ico|woff2?|lock|svg|pdf|zip|gz)$/i.test(f) || /package-lock\.json$/.test(f)) continue;
      let t; try { const st = fs.statSync(path.join(root, f)); if (st.size > 1_000_000) continue; t = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
      if (t.includes('\0')) continue;
      if (pats.some((re) => re.test(t))) hits.push(f);
    }
    add(hits.length ? res('secrets', 'fail', `possible secrets in: ${hits.slice(0, 6).join(', ')} (values not shown); remove, rotate and use environment variables`) : res('secrets', 'pass', `no secret patterns in ${tracked.length} tracked file(s), STATE.json or the ledger`));
  }

  // Worktrees
  if (!cfg) add(res('worktrees', 'skip', 'no config'));
  else {
    const main = realish(root);
    const wts = listWorktrees(root).filter((w) => w.path !== main);
    const inside = wts.filter((w) => isInside(w.path, main));
    let claims = []; try { claims = readState(cfg).claims.map((c) => c.worktree && realish(c.worktree)); } catch { /* no state yet */ }
    const stale = wts.filter((w) => !claims.includes(w.path) && Date.now() - fs.statSync(w.path).mtimeMs > 7 * 864e5);
    const wr = add(inside.length ? res('worktrees', 'fail', `worktree(s) inside the main checkout: ${inside.map((w) => w.path).join(', ')}`, 'remove them; worktrees live outside the main checkout') : stale.length ? res('worktrees', 'warn', `${stale.length} stale worktree(s): ${stale.map((w) => w.path).join(', ')}`, '`relay-worktree prune --older 7d`') : res('worktrees', 'pass', `${wts.length} worktree(s), none inside the main checkout`));
    if (fix && stale.length && !inside.length) { run(process.execPath, [path.join(CORE, 'scripts', 'relay-worktree'), 'prune', '--older', '7d'], { cwd: root, env: { ...env, RELAY_CONFIG: cfgFile } }); wr.status = 'pass'; wr.message = `pruned ${stale.length} stale worktree(s) (fixed)`; wr.fixed = true; }
  }

  // Compat
  {
    const bad = [];
    if (cmp(process.versions.node, compat.node) < 0) bad.push(`node ${process.versions.node} < ${compat.node}`);
    const gv = /(\d+\.\d+(?:\.\d+)?)/.exec(run('git', ['--version']).stdout)?.[1];
    if (!gv) bad.push('git not found'); else if (cmp(gv, compat.git) < 0) bad.push(`git ${gv} < ${compat.git}`);
    const ghv = /(\d+\.\d+(?:\.\d+)?)/.exec(run(gh, ['--version'], { env }).stdout)?.[1];
    if (ghv && !/fake/.test(run(gh, ['--version'], { env }).stdout) && cmp(ghv, compat.gh) < 0) bad.push(`gh ${ghv} < ${compat.gh}`);
    add(bad.length ? res('compat', 'warn', `below the supported minimum: ${bad.join('; ')}`, 'upgrade') : res('compat', 'pass', `node ${process.versions.node}, git ${gv}${ghv ? `, gh ${ghv}` : ''} meet the matrix`));
  }

  // MCP (only when registered)
  const mcp = readOr(path.join(root, '.mcp.json'));
  if (!mcp || !/relay/.test(mcp)) add(res('mcp', 'skip', 'relay MCP server not registered'));
  else {
    const m = await import('./mcp.mjs').catch(() => null);
    add(m ? ((await m.selfTest?.()) ? res('mcp', 'pass', 'MCP server starts and lists its tools') : res('mcp', 'fail', 'MCP server did not list the expected tools')) : res('mcp', 'warn', 'MCP server module not available in this install'));
  }

  const status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return { status, exit: status === 'fail' ? 3 : status === 'warn' ? 1 : 0, checks };
}
