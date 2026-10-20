// Mutation check for guard tests (lesson L19): a guard test must FAIL once the guard is deliberately broken.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { git } from './exec.mjs';

const sh = (cmd, cwd) => spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000, env: process.env });

// checks: [{name, test, mutate}] from workflow.yaml honesty.mutation_checks. Runs against a temp worktree of `ref`.
export function runMutationChecks(cfg, checks, { ref = 'HEAD' } = {}) {
  const results = [];
  for (const c of checks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mut-'));
    const add = git(['worktree', 'add', '--detach', dir, ref], { cwd: cfg.__root });
    if (add.code !== 0) { results.push({ name: c.name, status: 'error', detail: `cannot create worktree: ${add.stderr.trim().split('\n')[0]}` }); continue; }
    try {
      const base = sh(c.test, dir);
      if (base.status !== 0) { results.push({ name: c.name, status: 'baseline-failed', detail: `test fails before mutation: ${(base.stdout + base.stderr).trim().slice(-200)}` }); continue; }
      const mut = sh(c.mutate, dir);
      if (mut.status !== 0) { results.push({ name: c.name, status: 'error', detail: `mutation command failed: ${mut.stderr.trim().slice(0, 200)}` }); continue; }
      const changed = git(['status', '--porcelain'], { cwd: dir }).stdout.trim();
      if (!changed) { results.push({ name: c.name, status: 'error', detail: 'mutation changed nothing: the check proves nothing' }); continue; }
      const after = sh(c.test, dir);
      results.push(after.status !== 0 ? { name: c.name, status: 'killed', detail: 'test fails against the broken guard' } : { name: c.name, status: 'survived', detail: 'test STILL PASSES with the guard broken: it does not guard anything' });
    } finally {
      git(['worktree', 'remove', '--force', dir], { cwd: cfg.__root }); fs.rmSync(dir, { recursive: true, force: true }); git(['worktree', 'prune'], { cwd: cfg.__root });
    }
  }
  return results;
}
