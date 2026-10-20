import { spawnSync } from 'node:child_process';

// Run a command without a shell. Returns {code, stdout, stderr}; never throws on non-zero.
export function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}
export function git(args, opts = {}) { return sh('git', args, opts); }
export function gitOk(args, opts = {}) {
  const r = git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
