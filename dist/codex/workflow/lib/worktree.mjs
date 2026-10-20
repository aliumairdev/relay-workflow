import fs from 'node:fs';
import path from 'node:path';
import { git } from './exec.mjs';
import { expandHome } from './config.mjs';
import { RelayError, EXIT } from './exit.mjs';

// realpath of the nearest existing ancestor + the remaining tail (target may not exist yet).
export function realish(p) {
  let cur = path.resolve(p), tail = [];
  while (!fs.existsSync(cur)) { tail.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; }
  return path.join(fs.realpathSync(cur), ...tail);
}
export const isInside = (child, parent) => { const rel = path.relative(realish(parent), realish(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export const mainCheckout = (cfg) => realish(cfg.__root);
export function worktreeRoot(cfg) {
  const raw = cfg.project.worktree_root ? expandHome(cfg.project.worktree_root) : path.join(path.dirname(cfg.__root), `${cfg.project.name}-worktrees`);
  return path.resolve(cfg.__root, raw);
}
export const worktreePath = (cfg, runtime, issue) => path.join(worktreeRoot(cfg), `${runtime}-${issue}`);

export function branchName(cfg, { runtime, issue, slug }) {
  return cfg.claims.branch_pattern.replace('{runtime}', runtime).replace('{issue}', String(issue)).replace('{slug}', slug);
}

export function listWorktrees(cwd) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd });
  const out = []; let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: realish(line.slice(9)) }; out.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line === 'detached') cur.detached = true;
  }
  return out;
}

export function ensureOutsideMain(cfg, target) {
  if (isInside(target, mainCheckout(cfg))) throw new RelayError(`refused: worktree path ${target} is inside the main checkout`, EXIT.ENV);
}

export function fetchOrigin(cwd) {
  const r = git(['fetch', 'origin', '--prune'], { cwd });
  if (r.code !== 0) throw new RelayError(`fetch failed: ${r.stderr.trim().split('\n')[0]}`, EXIT.ENV);
}
export const remoteHas = (cwd, branch) => git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { cwd }).code === 0;
export const localHas = (cwd, branch) => git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd }).code === 0;
