// Real-environment proof (ARCHITECTURE 9.5). Generic engine; platform specifics come from the stack profile / workflow.yaml.
//   exit 0 pass | 4 platform errors (push failed, error signature in a page, failed command) | 5 target unavailable
//   6 render errors (unexpected HTTP status / empty page) | 8 refused (target not in security.mutation_scope)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProfile } from './profile.mjs';
import os from 'node:os';
import { git } from './exec.mjs';
import { now, iso } from './clock.mjs';
import { EXIT } from './exit.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => (!isObj(a) || !isObj(b) ? (b === undefined ? a : b) : Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, merge(a[k], b[k])])));
export const STAGES = { 'pre-merge': 'pre_merge', 'post-merge': 'post_merge', release: 'release' };

// Profile defaults under workflow.yaml (the project wins).
export function proofConfig(cfg) {
  const p = loadProfile(cfg.project.stack) || {};
  return { environment: merge(p.environment || {}, cfg.environment || {}), proof: merge(p.proof || {}, cfg.proof || {}) };
}

// env:NAME -> process.env value (undefined when unset). Plain values pass through.
export const resolveRef = (ref, env = process.env) => (typeof ref === 'string' && ref.startsWith('env:') ? env[ref.slice(4)] : ref);

export function expand(text, vars, missing) {
  return String(text).replace(/\$\{(\w+)\}/g, (m, k) => { if (vars[k] != null && vars[k] !== '') return vars[k]; missing.add(k); return m; });
}

const tail = (s, n = 400) => String(s || '').trim().slice(-n);
function summarisePushErrors(stdout) {
  try {
    const j = JSON.parse(stdout);
    const errs = j.errors || j.error || (Array.isArray(j) ? j.filter((x) => x.error || x.errors) : null);
    if (!errs || (Array.isArray(errs) && !errs.length)) return null;
    const list = Array.isArray(errs) ? errs : Object.entries(errs).map(([file, e]) => ({ file, e }));
    return list.slice(0, 20).map((e) => `${e.file ?? e.path ?? ''}: ${String(e.e ?? e.message ?? JSON.stringify(e)).slice(0, 200)}`).join('\n');
  } catch { return null; }
}

// Run `fn(dir)` with a temp worktree of `ref` (origin/<ref> when it is a remote branch), so push/commands see the PR's files.
export async function withRefWorktree(cfg, ref, fn) {
  if (!ref || ref === 'HEAD') return fn(cfg.__root);
  git(['fetch', 'origin', '--prune'], { cwd: cfg.__root });
  const target = git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${ref}`], { cwd: cfg.__root }).code === 0 ? `origin/${ref}` : ref;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-'));
  const add = git(['worktree', 'add', '--detach', dir, target], { cwd: cfg.__root });
  if (add.code !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return fn(cfg.__root, `ref ${ref} not found locally: ran in the main checkout`); }
  try { return await fn(dir); } finally { git(['worktree', 'remove', '--force', dir], { cwd: cfg.__root }); fs.rmSync(dir, { recursive: true, force: true }); git(['worktree', 'prune'], { cwd: cfg.__root }); }
}

const runShell = (cmd, cwd, env) => spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });

async function fetchPage(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: (await r.text()).slice(0, 2_000_000) };
  } catch (e) { return { status: 0, body: '', error: String(e.cause?.code || e.message) }; }
}

// Run a stage. Returns {exit, items[], summary}. Never mutates anything outside the configured target.
export async function runProof(cfg, { stage = 'pre-merge', ref = 'HEAD', suite = 'quick', cwd = null, env = process.env } = {}) {
  if (!cwd) return withRefWorktree(cfg, ref, (dir) => runProof(cfg, { stage, ref, suite, cwd: dir, env }));
  const key = STAGES[stage];
  const { environment, proof } = proofConfig(cfg);
  const sc = proof[key] || {};
  const items = [];
  const add = (name, status, evidence = '', extra = {}) => items.push({ name, status, evidence: String(evidence).slice(0, 4000), ...extra });
  const base = { stage, ref, suite, started: iso(now()) };
  const notVerifiedAll = (why) => {
    const names = [sc.push && 'push', ...(sc.probe_pages || []).map((p) => `page ${typeof p === 'string' ? p : p.path}`), ...(sc.commands || []).map((c) => c.name), ...((sc.include && suite === 'full' ? sc.include : []) || []).map((n) => `tool ${n}`)].filter(Boolean);
    const done = new Set(items.map((i) => i.name));          // a step that really ran (e.g. the push) keeps its recorded result
    for (const n of (names.length ? names : ['environment']).filter((x) => !done.has(x))) add(n, 'not_verified', why);
    return { exit: EXIT.TARGET_UNAVAILABLE, items, ...base, finished: iso(now()), note: 'target unavailable: nothing was verified and nothing is claimed' };
  };

  // Target
  const target = resolveRef(environment.target_ref, env);
  const vars = { ...env, REF: ref };
  for (const [k, v] of Object.entries(environment)) if (/_ref$/.test(k)) { const val = resolveRef(v, env); if (val) vars[k.replace(/_ref$/, '').toUpperCase()] = val; }
  if (environment.target_ref && !target) return notVerifiedAll(`target ${environment.target_ref} is not configured in this environment`);

  const needsMutation = !!sc.push;
  const scope = cfg.security?.mutation_scope || [];
  if (needsMutation && !(environment.name && scope.includes(environment.name))) {
    return { exit: EXIT.DENIED, items: [{ name: 'scope', status: 'refused', evidence: `environment "${environment.name ?? '(unnamed)'}" is not listed in security.mutation_scope (${scope.join(', ') || 'empty'}); proof only mutates the configured dev target` }], ...base, finished: iso(now()) };
  }

  // Push / apply
  let platformErrors = 0, renderErrors = 0;
  if (sc.push) {
    const missing = new Set();
    const cmd = expand(sc.push, vars, missing);
    if (missing.size) return notVerifiedAll(`missing variables for push: ${[...missing].join(', ')}`);
    const r = runShell(cmd, cwd, { ...env, REF: ref });
    const errs = summarisePushErrors(r.stdout);
    if (r.error?.code === 'ENOENT' || r.status === 127) return notVerifiedAll(`push command not available: ${tail(r.stderr, 160)}`);
    if (r.status !== 0 || errs) { platformErrors++; add('push', 'fail', errs || tail(r.stderr || r.stdout)); } else add('push', 'pass', `exit 0${r.stdout ? `: ${tail(r.stdout, 160)}` : ''}`);
  }

  // Probe pages
  const baseUrl = resolveRef(environment.base_url_ref, env) || proof.base_url;
  const pages = sc.probe_pages || [];
  if (pages.length) {
    if (!baseUrl) return notVerifiedAll('no base URL configured (environment.base_url_ref / proof.base_url): pages were not probed');
    const sigs = sc.error_signatures || [];
    const probes = pages.map((p) => (typeof p === 'string' ? { path: p, expect_status: /404/.test(p) ? 404 : null } : p));
    const missing = new Set();
    const results = await Promise.all(probes.map(async (p) => {
      const url = new URL(expand(p.path, vars, missing), baseUrl.replace(/\/?$/, '/')).href;
      return { p, url, ...(await fetchPage(url)) };
    }));
    if (missing.size) return notVerifiedAll(`missing variables for pages: ${[...missing].join(', ')}`);
    if (results.every((r) => r.status === 0)) return notVerifiedAll(`target ${baseUrl} is unreachable (${results[0].error})`);
    for (const r of results) {
      const name = `page ${r.p.path}`;
      const hit = sigs.find((s) => r.body.includes(s));
      const want = r.p.expect_status;
      const okStatus = want ? r.status === want : r.status >= 200 && r.status < 400;
      if (hit) { platformErrors++; add(name, 'fail', `error signature "${hit}" in the response (HTTP ${r.status})`, { url: r.url }); }
      else if (!okStatus) { renderErrors++; add(name, 'fail', `HTTP ${r.status}${r.error ? ` (${r.error})` : ''}, expected ${want || '2xx/3xx'}`, { url: r.url }); }
      else if (!r.body.trim() && r.status !== 204) { renderErrors++; add(name, 'fail', 'empty response body', { url: r.url }); }
      else add(name, 'pass', `HTTP ${r.status}, ${r.body.length} bytes, no error signatures`, { url: r.url });
    }
  }

  // Generic commands
  for (const c of sc.commands || []) {
    const missing = new Set();
    const r = runShell(expand(c.cmd, vars, missing), cwd, { ...env, REF: ref });
    if (missing.size) { add(c.name, 'not_verified', `missing variables: ${[...missing].join(', ')}`); continue; }
    if (r.status === 0) add(c.name, 'pass', `exit 0${r.stdout ? `: ${tail(r.stdout, 120)}` : ''}`);
    else { platformErrors++; add(c.name, 'fail', `exit ${r.status}: ${tail(r.stderr || r.stdout)}`); }
  }

  // Full-suite tools (lighthouse, theme editor, ...): run only when a command is configured; otherwise honest NOT_VERIFIED
  if (suite === 'full') {
    for (const tool of sc.include || []) {
      const cmd = proof.tools?.[tool];
      if (!cmd) { add(`tool ${tool}`, 'not_verified', `no command configured under proof.tools.${tool}`); continue; }
      const r = runShell(expand(cmd, vars, new Set()), cwd, { ...env, REF: ref });
      if (r.status === 0) add(`tool ${tool}`, 'pass', tail(r.stdout, 160)); else { platformErrors++; add(`tool ${tool}`, 'fail', `exit ${r.status}: ${tail(r.stderr || r.stdout)}`); }
    }
  }

  const exit = platformErrors ? EXIT.GATE_FAILED : renderErrors ? EXIT.RENDER : EXIT.OK;
  return { exit, items, ...base, finished: iso(now()) };
}

export function writeSummary(cfg, result, { ref }) {
  const date = result.started.slice(0, 10);
  const dir = path.join(cfg.__root, 'harness', 'proof', date, String(ref).replace(/[^\w.-]/g, '_').slice(0, 60));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'summary.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), `# Proof ${result.stage} @ ${ref}\n\nExit ${result.exit}${result.note ? ` — ${result.note}` : ''}\n\n${result.items.map((i) => `- **${i.status.toUpperCase()}** ${i.name}: ${i.evidence.split('\n')[0]}`).join('\n')}\n`);
  return { dir, file };
}
