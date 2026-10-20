import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

export const FIX = path.join(REPO, 'tests/fixtures/m4');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
export const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: GENV });

// Build a repo that is mid-merge with a conflict on `file` (base/ours/theirs contents).
export function conflictRepo(file, { base, ours, theirs }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-res-'));
  g(d, 'init', '-q', '-b', 'main');
  const put = (c) => { fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true }); fs.writeFileSync(path.join(d, file), c); };
  put(base); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base');
  g(d, 'checkout', '-q', '-b', 'theirs'); put(theirs); g(d, 'commit', '-qam', 'theirs');
  g(d, 'checkout', '-q', 'main'); put(ours); g(d, 'commit', '-qam', 'ours');
  const m = g(d, 'merge', '--no-edit', 'theirs');
  if (m.status === 0) throw new Error('fixture did not conflict');
  return d;
}

// Agent-style branch off origin/main in the sandbox work clone; pushes it; returns to main.
export function agentBranch(sb, { runtime, issue, slug = 'x', files = {}, msg = 'feat: work' }) {
  const branch = `agent/${runtime}/${issue}-${slug}`;
  sb.git(['fetch', '-q', 'origin']);
  sb.git(['checkout', '-q', '-B', branch, 'origin/main']);
  commitFiles(sb, files, msg);
  sb.git(['push', '-q', '-f', 'origin', branch]);
  sb.git(['checkout', '-q', 'main']);
  return branch;
}
export function stackBranch(sb, { branch, parent, files, msg = 'feat: stacked' }) {
  sb.git(['fetch', '-q', 'origin']);
  sb.git(['checkout', '-q', '-B', branch, `origin/${parent}`]);
  commitFiles(sb, files, msg);
  sb.git(['push', '-q', '-f', 'origin', branch]);
  sb.git(['checkout', '-q', 'main']);
  return branch;
}
export function commitFiles(sb, files, msg) {
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(sb.work, f)), { recursive: true }); fs.writeFileSync(path.join(sb.work, f), c); }
  sb.git(['add', '-A']); const r = sb.git(['commit', '-qm', msg]); if (r.status !== 0) throw new Error(r.stderr + r.stdout);
}
export function pushMain(sb, files, msg = 'chore: main moves') {
  sb.git(['checkout', '-q', 'main']); sb.git(['pull', '-q', 'origin', 'main']);
  commitFiles(sb, files, msg); const r = sb.git(['push', '-q', 'origin', 'main']); if (r.status !== 0) throw new Error(r.stderr);
}
export function openPR(sb, { branch, base = 'main', issue, title = 'PR' }) {
  const body = issue ? `Closes #${issue}` : '';
  const r = sb.gh(['api', '-X', 'POST', 'repos/local/sandbox/pulls', '--input', '-'], JSON.stringify({ title, head: branch, base, body }));
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout).number;
}
export function verdict(sb, pr, result, runtime, extra = []) {
  const f = path.join(sb.root, `changes-${pr}.txt`); fs.writeFileSync(f, '1. fix the thing\n');
  return sb.run('relay-verdict', ['post', String(pr), '--result', result, '--checklist', '{"acceptance":"PASS","tests":"PASS"}', ...(result === 'CHANGES' ? ['--changes-file', f] : []), ...extra], { env: { RELAY_RUNTIME: runtime, RELAY_ACTOR: 'reviewer' } });
}
export const showMain = (sb, file) => sb.git(['--git-dir', path.join(sb.root, 'remote.git'), 'show', `main:${file}`]).stdout;

// ---- issue-contract slices ----------------------------------------------------------------------
// Body of a PR that is one slice of an issue: it says truthfully which requirements it covers.
export function sliceBody(issue, { covers = [], all = [], tail = 'Slice of the issue.' }) {
  const done = new Set(covers);
  const left = all.filter((id) => !done.has(id));
  return [`Refs #${issue}`, '', '## Outcome', tail, '', '## Validation (real results)', 'npm test → 1 pass', '', '## NOT_VERIFIED', 'runtime behaviour on live data (see contract)', '', '## Contract Coverage', `Issue: #${issue}`,
    ...all.map((id) => `- ${id}: ${done.has(id) ? 'implemented' : 'not covered by this PR'}`), '', `Issue completion: ${left.length ? 'NO — additional accepted requirements remain.' : 'YES'}`, ''].join('\n');
}
export function openSlicePR(sb, { branch, body, title = 'slice' }) {
  const r = sb.gh(['api', '-X', 'POST', 'repos/local/sandbox/pulls', '--input', '-'], JSON.stringify({ title, head: branch, base: 'main', body }));
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout).number;
}
// Reviewer verdict that states contract coverage (id -> PASS|FAIL|NOT_COVERED) and ISSUE_COMPLETE.
export function coverageVerdict(sb, pr, runtime, coverage, complete, result = 'APPROVED') {
  return verdict(sb, pr, result, runtime, [...Object.entries(coverage).flatMap(([id, v]) => ['--coverage', `${id}=${v}`]), '--issue-complete', complete ? 'YES' : 'NO']);
}
