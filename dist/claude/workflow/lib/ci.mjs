import fs from 'node:fs';
import path from 'node:path';
import { sh, git } from './exec.mjs';
import { expandHome, relayDir } from './config.mjs';

const safe = (b) => b.replace(/[^\w.-]+/g, '_');
export const ciDir = (cfg) => path.resolve(cfg.__root, expandHome(cfg.ci.worktree_cache || path.join(relayDir(cfg), 'ci-wt')));

// Run the CI steps on origin/<branch> in a dedicated per-branch worktree. `emit(line)` receives progress lines.
// Returns {code: 0|1|9, log, steps:[{name, ok}], tail}.
export function runCI(cfg, branch, { full = false, emit = () => {} } = {}) {
  const root = cfg.__root, dir = ciDir(cfg), W = path.join(dir, safe(branch));
  const logDir = path.join(relayDir(cfg), 'logs'); fs.mkdirSync(logDir, { recursive: true }); fs.mkdirSync(dir, { recursive: true });
  const log = path.join(logDir, `ci-${safe(branch)}.log`);
  const fail9 = (why) => { emit(`${branch}: cannot check out (${why})`); return { code: 9, log, steps: [], tail: '' }; };
  if (git(['fetch', 'origin', '--prune'], { cwd: root }).code !== 0) return fail9('fetch failed');
  if (!fs.existsSync(path.join(W, '.git'))) {
    git(['worktree', 'prune'], { cwd: root });
    const a = git(['worktree', 'add', '--detach', W, `origin/${cfg.project.default_branch}`], { cwd: root });
    if (a.code !== 0) return fail9(a.stderr.trim().split('\n')[0]);
  }
  if (git(['checkout', '-q', '--detach', `origin/${branch}`], { cwd: W }).code !== 0) return fail9(`origin/${branch} not found`);
  git(['clean', '-fdq', '-e', 'node_modules'], { cwd: W });
  fs.writeFileSync(log, '');
  const runStep = (cmd) => { const r = sh('sh', ['-c', cmd], { cwd: W }); fs.appendFileSync(log, `$ ${cmd}\n${r.stdout}${r.stderr}\n`); return r.code === 0; };

  const steps = []; let fail = false;
  const inst = cfg.ci.install;
  if (inst?.cmd) {
    const key = inst.cache_key_file && path.join(W, inst.cache_key_file), mark = path.join(dir, `${safe(branch)}.installed`);
    const cur = key && fs.existsSync(key) ? fs.readFileSync(key, 'utf8') : '';
    const same = key && fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === cur && fs.existsSync(path.join(W, 'node_modules'));
    if (!same) {
      const ok = runStep(inst.cmd);
      if (ok && key) fs.writeFileSync(mark, cur);
      if (!ok) { fail = true; steps.push({ name: 'install', ok }); emit('  install: FAIL'); }
    }
  }
  const list = [...(cfg.ci.steps || []).map((s) => ({ name: s.name, cmd: s.cmd })), ...(full ? (cfg.ci.full_steps || []).map((c) => ({ name: c, cmd: c })) : [])];
  for (const s of list) { const ok = runStep(s.cmd); if (!ok) fail = true; steps.push({ name: s.name, ok }); emit(`  ${s.name}: ${ok ? 'pass' : 'FAIL'}`); }
  let tail = '';
  if (fail) tail = fs.readFileSync(log, 'utf8').split('\n').slice(-26).join('\n').replace(/\s+$/, '');
  emit(fail ? `${branch}: LOCAL CI FAILED (log ${log})` : `${branch}: LOCAL CI OK`);
  if (fail) for (const l of tail.split('\n')) emit(`    ${l}`);
  return { code: fail ? 1 : 0, log, steps, tail };
}
