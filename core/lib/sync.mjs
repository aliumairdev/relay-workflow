import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh, git } from './exec.mjs';
import { relayDir } from './config.mjs';
import { resolveConflicts } from './resolve.mjs';

const safe = (b) => b.replace(/[^\w.-]+/g, '_');
const sleep = (s) => (s > 0 ? new Promise((r) => setTimeout(r, s * 1000)) : Promise.resolve());
export const retrySleepS = () => Number(process.env.RELAY_RETRY_SLEEP_S ?? 20);

// Merge origin/<default> into <branch> in a temp worktree, resolve conflicts by registry, run sync_steps
// (one retry), push. Returns {code: 0|2|3|9, msg, sha, log, summary:[lines], resolved:[files]}.
export async function syncBranch(cfg, branch, { steps = true } = {}) {
  const root = cfg.__root, def = cfg.project.default_branch;
  let fetched = false;
  for (let t = 0; t < 3 && !fetched; t++) { fetched = git(['fetch', 'origin', '--prune'], { cwd: root }).code === 0; if (!fetched) await sleep(Math.min(retrySleepS(), 3)); }
  if (!fetched) return { code: 9, msg: `${branch}: fetch failed` };
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sync-'));
  fs.rmSync(W, { recursive: true });
  const res = { resolved: [] };
  try {
    const add = git(['worktree', 'add', '-q', '--detach', W, `origin/${branch}`], { cwd: root });
    if (add.code !== 0) return { code: 9, msg: `${branch}: cannot check out origin/${branch}: ${add.stderr.trim()}` };
    if (git(['merge', '-q', '--no-edit', `origin/${def}`], { cwd: W }).code !== 0) {
      const r = await resolveConflicts({ cwd: W, resolvers: cfg.resolvers || [] });
      res.resolved = r.resolved;
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], { cwd: W }).stdout.trim();
      if (r.leftovers.length || unmerged) {
        git(['merge', '--abort'], { cwd: W });
        return { code: 2, msg: `${branch}: needs manual resolution`, leftovers: r.leftovers };
      }
      if (git(['commit', '-q', '--no-edit'], { cwd: W }).code !== 0) { git(['merge', '--abort'], { cwd: W }); return { code: 2, msg: `${branch}: merge commit failed`, leftovers: [] }; }
    }
    if (steps && cfg.ci.sync_steps?.length) {
      const logDir = path.join(relayDir(cfg), 'logs'); fs.mkdirSync(logDir, { recursive: true });
      const log = path.join(logDir, `sync-${safe(branch)}.log`); fs.writeFileSync(log, '');
      if (cfg.ci.install?.cmd) sh('sh', ['-c', cfg.ci.install.cmd], { cwd: W });
      const attempts = cfg.ci.retry_once_on_fail === false ? 1 : 2;
      let ok = false;
      for (let t = 1; t <= attempts && !ok; t++) {
        ok = true;
        for (const c of cfg.ci.sync_steps) { const r = sh('sh', ['-c', c], { cwd: W }); fs.appendFileSync(log, `$ ${c}\n${r.stdout}${r.stderr}\n`); if (r.code !== 0) { ok = false; break; } }
        if (!ok && t < attempts) { fs.appendFileSync(log, `--- retry after failure (attempt ${t}) ---\n`); await sleep(retrySleepS()); }
      }
      if (!ok) {
        const re = new RegExp(cfg.ci.failure_grep || 'not ok|✖|violation|error|Error', '');
        const summary = fs.readFileSync(log, 'utf8').split('\n').filter((l) => re.test(l)).slice(0, 8);
        return { code: 3, msg: `${branch}: validate/test FAILED after merge (log ${log})`, log, summary };
      }
    }
    const sha = git(['rev-parse', '--short', 'HEAD'], { cwd: W }).stdout.trim();
    const push = git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: W });
    if (push.code !== 0) return { code: 9, msg: `${branch}: push failed: ${push.stderr.trim().split('\n')[0]}` };
    return { ...res, code: 0, msg: `${branch}: synced with ${def} (${sha})`, sha };
  } finally {
    git(['worktree', 'remove', '--force', W], { cwd: root });
    fs.rmSync(W, { recursive: true, force: true });
    git(['worktree', 'prune'], { cwd: root });
  }
}

export function commitsBehind(cfg, branch) {
  const r = git(['rev-list', '--count', `origin/${branch}..origin/${cfg.project.default_branch}`], { cwd: cfg.__root });
  return r.code === 0 ? Number(r.stdout.trim()) : null;
}
