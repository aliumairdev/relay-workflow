import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = path.join(REPO, 'core', 'scripts');

export function makeSandbox({ now = '2026-10-20T10:00:00Z', extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sb-'));
  const r = spawnSync('sh', [path.join(REPO, 'tests/sandbox/make-repo.sh'), root], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-repo failed: ${r.stderr}`);
  const work = path.join(root, 'work');
  const env = {
    ...process.env,
    RELAY_GH: path.join(REPO, 'tests/fakes/gh'),
    RELAY_FAKE_REMOTE: path.join(root, 'remote.git'),
    RELAY_SETTLE_S: '0',
    RELAY_RETRY_SLEEP_S: '0',
    RELAY_FAKE_GH_DB: path.join(root, 'gh.db.json'),
    RELAY_CONFIG: path.join(work, 'workflow.yaml'),
    RELAY_NOW: now,
    RELAY_ACTOR: 'human',
    RELAY_FAKE_LOAD: '0.1',   // tests must not depend on the host's real load average
    GIT_AUTHOR_NAME: 'relay-test', GIT_AUTHOR_EMAIL: 'relay@example.invalid',
    GIT_COMMITTER_NAME: 'relay-test', GIT_COMMITTER_EMAIL: 'relay@example.invalid',
    ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` inside CI steps must not think it is a child of this runner
  const sb = {
    root, work, env,
    db: () => JSON.parse(fs.readFileSync(env.RELAY_FAKE_GH_DB, 'utf8')),
    saveDb: (d) => fs.writeFileSync(env.RELAY_FAKE_GH_DB, JSON.stringify(d)),
    // Run a relay script synchronously. Returns {code, stdout, stderr, json()}.
    run(script, args = [], opts = {}) {
      const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd: opts.cwd || work, env: { ...env, ...(opts.env || {}) }, input: opts.input });
      return { code: res.status, stdout: res.stdout, stderr: res.stderr, json: () => JSON.parse(res.stdout) };
    },
    // Async spawn for races.
    spawnScript(script, args = [], opts = {}) {
      return new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: opts.cwd || work, env: { ...env, ...(opts.env || {}) } });
        let stdout = '', stderr = '';
        p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
        p.on('close', (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
      });
    },
    // Run the fake gh as another user (e.g. a review bot).
    ghAs(login, args, input, type = 'User') {
      const res = spawnSync(env.RELAY_GH, args, { encoding: 'utf8', env: { ...env, FAKE_GH_USER: login, FAKE_GH_USER_TYPE: type }, input });
      return { code: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    gh(args, input) {
      const res = spawnSync(env.RELAY_GH, args, { encoding: 'utf8', env, input });
      return { code: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    git: (args, cwd = work) => spawnSync('git', args, { encoding: 'utf8', cwd, env }),
    patchConfig(fn) { const f = path.join(work, 'workflow.yaml'); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); },
    state: () => { const f = path.join(work, 'harness/STATE.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; },
    issue: (n) => JSON.parse(sb.gh(['api', `repos/local/sandbox/issues/${n}`]).stdout),
    comments: (n) => JSON.parse(sb.gh(['api', `repos/local/sandbox/issues/${n}/comments?per_page=100`]).stdout),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  return sb;
}

// Seed an issue straight into the fake DB (faster than going through scripts).
export function seedIssue(sb, { title = 'task', body = '', labels = [] } = {}) {
  const r = sb.gh(['api', '-X', 'POST', 'repos/local/sandbox/issues', '--input', '-'], JSON.stringify({ title, body, labels }));
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout).number;
}

// ---- M5 helpers -------------------------------------------------------------------------------
export const M5_CONFIG = `
tiers:
  T0: {name: docs, price_usd_per_mtok: {in: 1, out: 5}}
  T1: {name: implement, price_usd_per_mtok: {in: 3, out: 15}}
  T2: {name: high-risk, price_usd_per_mtok: {in: 15, out: 75}}
budgets:
  tier_share_max: {T2: 0.04, T3: 0.01, top_combined: 0.05}
  max_tokens_per_task: {T0: 150000, T1: 600000, T2: 250000, T3: 250000}
  per_pr_cost_ceiling_usd: 15.0
  tier_share_min_runs: 10
concurrency: {max_agents: 8, hard_max: 20, load_limit_factor: 1.5, heavy_slots: 2}
rate_limit: {max_retries: 3, backoff_s: [30, 60, 120]}
runtime_policy: {default: any, fallback_order: [claude, codex]}
`;
export function m5Sandbox(extra = '', opts) {
  const sb = makeSandbox(opts);
  sb.patchConfig((t) => t + M5_CONFIG + extra);
  return sb;
}
export function writeLedger(sb, rows) {
  const dir = path.join(sb.work, '.relay/ledger'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
// 19 T1 rows of 100k tokens + one T2 row of `t2Tokens`: T2 share = t2/(1.9M+t2)
export function shareLedger(t2Tokens) {
  const rows = Array.from({ length: 19 }, (_, i) => ({ ts: `2026-10-19T10:${String(i).padStart(2, '0')}:00Z`, run_id: `t1-${i}`, runtime: 'claude', tier: 'T1', task_class: 'implement', issue: 100 + i, tokens_in: 90000, tokens_out: 10000, outcome: 'done' }));
  rows.push({ ts: '2026-10-19T11:00:00Z', run_id: 't2-0', runtime: 'claude', tier: 'T2', task_class: 'high_risk_review', issue: 1, tokens_in: t2Tokens, tokens_out: 0, outcome: 'approved' });
  return rows;
}

// ---- M7 helpers: wire the fake runtimes into a sandbox ----------------------------------------
export function useFakeRuntimes(sb, { claude = true, codex = true, lease = 30 } = {}) {
  const fakes = path.join(REPO, 'tests/fakes');
  sb.patchConfig((t) => t
    .replace('exec_cmd: fake-codex', `exec_cmd: ${path.join(fakes, 'fake-codex')}`)
    .replace('claude: { enabled: true, resume: send_message,', `claude: { enabled: true, exec_cmd: ${claude ? path.join(fakes, 'fake-claude') : '/nonexistent/claude'}, resume: send_message,`)
    .replace('claims: { lease_minutes: 2, heartbeat_minutes: 1 }', `claims: { lease_minutes: ${lease}, heartbeat_minutes: 1 }`));
  sb.env.FAKE_RUNTIME_STATE = path.join(sb.root, 'fake-state');
  sb.env.RELAY_HEARTBEAT_MS = '600000';
  sb.env.RELAY_FAKE_LOAD = '0.1';          // the real load average depends on whatever else runs on this machine
  return sb;
}
export const ledgerRows = (sb) => {
  const f = path.join(sb.work, '.relay/ledger/usage.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
export const prsOf = (sb) => sb.db().items.filter((i) => i.pull_request);
