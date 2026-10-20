// Scripted stand-in for a headless agent runtime (fake-codex / fake-claude / ...).
// Behaviours are consumed one per invocation from FAKE_RUNTIME_BEHAVIORS (JSON array) using a counter file
// FAKE_RUNTIME_STATE, so "rate-limit twice, then implement" is expressible. Default: ["implement"].
//   implement        write a file, commit, push, open PR (Closes #N), request review, journal, label state:review
//   partial          commit a file and hand the issue to the other runtime
//   rate-limit       print a 429 rate limit message, exit 1
//   die              exit 0 without doing anything
//   fail             exit 2 with an error
//   review:APPROVED | review:CHANGES   post a verdict for the PR in RELAY_PR
//   sleep:<ms>       wait, then implement
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function main(runtime) {
  const env = process.env;
  const list = JSON.parse(env.FAKE_RUNTIME_BEHAVIORS || '["implement"]');
  const stateFile = env.FAKE_RUNTIME_STATE || path.join(process.cwd(), `.fake-${runtime}-state`);
  let n = 0; try { n = Number(fs.readFileSync(stateFile, 'utf8')); } catch { /* first call */ }
  fs.writeFileSync(stateFile, String(n + 1));
  const behavior = list[Math.min(n, list.length - 1)];
  const rel = (name, args, o = {}) => spawnSync(name, args, { encoding: 'utf8', env, cwd: o.cwd || process.cwd(), input: o.input });
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: `${runtime}-agent`, GIT_AUTHOR_EMAIL: `${runtime}@example.invalid`, GIT_COMMITTER_NAME: `${runtime}-agent`, GIT_COMMITTER_EMAIL: `${runtime}@example.invalid` }, cwd: process.cwd() });
  const issue = env.RELAY_ISSUE, agent = env.RELAY_AGENT_ID;
  const ghApi = (method, route, body) => JSON.parse(spawnSync(env.RELAY_GH, ['api', '-X', method, route, '--input', '-'], { encoding: 'utf8', env, input: JSON.stringify(body) }).stdout);
  const repoOf = () => 'local/sandbox';
  // a scripted agent that silently ignores a failed protocol step would hide protocol bugs
  const must = (r, what) => { if (r.status !== 0) { process.stderr.write(`protocol step failed (${what}): ${r.stderr}${r.stdout}\n`); process.exit(3); } };
  const otherRuntime = () => (env.FAKE_REVIEW_RUNTIME || (runtime === 'codex' ? 'claude' : 'codex'));

  if (behavior === 'rate-limit') { process.stderr.write('Error: 429 Too Many Requests: rate limit exceeded, retry later\n'); process.exit(1); }
  if (behavior === 'die') process.exit(0);
  if (behavior === 'fail') { process.stderr.write('fatal: scripted failure\n'); process.exit(2); }

  if (behavior.startsWith('review:')) {
    const result = behavior.split(':')[1];
    const pr = env.RELAY_PR;
    const info = JSON.parse(rel(env.RELAY_GH, ['api', `repos/${repoOf()}/pulls/${pr}`]).stdout);
    const head = info.head?.sha;
    const checklist = JSON.stringify({ acceptance: 'PASS', architecture: 'PASS', tests: result === 'APPROVED' ? 'PASS' : 'FAIL' });
    const args = ['post', pr, '--result', result, '--checklist', checklist];
    if (result === 'CHANGES') { fs.writeFileSync(path.join(process.cwd(), '.changes.txt'), '1. src: rename the exported function\n2. tests: add an edge case\n'); args.push('--changes-file', path.join(process.cwd(), '.changes.txt')); }
    const r = rel('relay-verdict', args);
    if (r.status !== 0) { process.stderr.write(`relay-verdict failed: ${r.stderr}\n`); process.exit(r.status || 1); }
    if (issue) rel('relay-journal', ['post', issue, '--kind', 'review', '--text', `${result} on PR #${pr} (head ${String(head).slice(0, 8)})`]);
    process.exit(0);
  }

  if (behavior.startsWith('sleep:')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(behavior.split(':')[1]));

  // implement / partial
  const verify = rel('relay-worktree', ['verify']);
  if (verify.status !== 0) { process.stderr.write(`worktree verify failed: ${verify.stderr}${verify.stdout}\n`); process.exit(9); }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  rel('relay-journal', ['post', issue, '--kind', 'plan', '--text', `${runtime} plan: add src/${runtime}-${issue}.mjs and a test`]);
  const prior = fs.existsSync('src') ? fs.readdirSync('src').filter((f) => f.startsWith('partial-')) : [];
  fs.mkdirSync('src', { recursive: true });
  const file = behavior === 'partial' ? `src/partial-${runtime}-${issue}.mjs` : `src/${runtime}-${issue}.mjs`;
  fs.writeFileSync(file, `export const by = '${runtime}'; export const issue = ${issue};\n`);
  git(['add', '-A']);
  const trailers = prior.length ? `\n\nCo-authored-by: previous-agent <agent@example.invalid>` : '';
  git(['commit', '-qm', `feat: ${behavior === 'partial' ? 'partial work' : 'implement'} #${issue} (${runtime})${trailers}`]);
  if (behavior === 'partial') {
    const f = path.join(process.cwd(), '.handoff.json');
    fs.writeFileSync(f, JSON.stringify({ done: ['scaffold'], remaining: ['finish and open PR'], next_steps: ['complete implementation'] }));
    const r = rel('relay-handoff', ['post', issue, '--to', otherRuntime(), '--reason', 'capability', '--from-file', f]);
    process.exit(r.status || 0);
  }
  git(['push', '-u', 'origin', branch]);
  must(rel('relay-labels', ['set', String(issue), 'state:in-progress', '--actor-class', 'implementer']), 'state:in-progress');
  rel('relay-journal', ['post', issue, '--kind', 'progress', '--text', `pushed ${file}`]);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const pr = ghApi('POST', `repos/${repoOf()}/pulls`, { title: `${runtime}: implement #${issue}`, body: `Closes #${issue}\n\n## Runtime\n${runtime}\n\n## NOT_VERIFIED\nnone`, head: branch, base: 'main', head_sha: head });
  rel('relay-journal', ['post', issue, '--kind', 'pr', '--text', `PR #${pr.number} opened`]);
  rel('relay-journal', ['post', issue, '--kind', 'summary', '--text', `Implemented ${file}. Tests: not run by the fake agent (NOT_VERIFIED).`]);
  must(rel('relay-labels', ['set', String(issue), 'state:review', `review:${otherRuntime()}`, '--actor-class', 'implementer']), 'state:review');
  must(rel('relay-labels', ['set', String(pr.number), `review:${otherRuntime()}`, '--actor-class', 'implementer']), 'review request on the PR');
  process.exit(0);
}
