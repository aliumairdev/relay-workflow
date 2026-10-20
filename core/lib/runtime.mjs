import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toRegExp } from './hooklib.mjs';
import { RelayError, EXIT } from './exit.mjs';

const DEFAULT_RATE_LIMIT = ['rate.?limit', 'too many requests', '\\b429\\b', 'quota exceeded', 'usage limit'];
const isPlaceholder = (m) => !m || /^<.*>$/.test(m);

// Build the headless command for a runtime from workflow.yaml (nothing hard-coded: flags differ by installed version).
export function buildCommand(cfg, runtime, { model, prompt }) {
  const r = cfg.runtimes?.[runtime];
  if (!r?.exec_cmd) throw new RelayError(`runtime ${runtime} has no exec_cmd in workflow.yaml (headless dispatch unavailable)`, EXIT.INVALID);
  const [cmd, ...pre] = r.exec_cmd.trim().split(/\s+/);
  const args = [...pre, ...(r.exec_args || [])];
  if (model && !isPlaceholder(model) && r.model_flag !== '') args.push(r.model_flag || '--model', model);
  const mode = r.prompt_mode || 'arg';
  if (mode === 'arg') args.push(prompt);
  return { cmd, args, stdin: mode === 'stdin' ? prompt : null, timeoutMs: (r.timeout_s || 3600) * 1000, env: r.env || {} };
}

export function classify(cfg, runtime, res) {
  if (res.error?.code === 'ENOENT') return 'missing_binary';
  if (res.timedOut) return 'failed';
  const pats = (cfg.runtimes?.[runtime]?.rate_limit_patterns || DEFAULT_RATE_LIMIT).map((p) => new RegExp(p.replace(/^\(\?i\)/, ''), 'i'));
  const tail = `${res.stderr.slice(-4000)}\n${res.stdout.slice(-2000)}`;
  if (res.code !== 0 && pats.some((re) => re.test(tail))) return 'rate_limited';
  return res.code === 0 ? 'done' : 'failed';
}

// Run the command in cwd; resolves {code, stdout, stderr, error, timedOut, wall_s}. Calls onTick every tickMs (heartbeats).
export function execAgent(spec, { cwd, env, onTick, tickMs, logDir }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', error = null, timedOut = false;
    const p = spawn(spec.cmd, spec.args, { cwd, env: { ...env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    p.on('error', (e) => { error = e; });
    p.stdout?.on('data', (d) => { stdout += d; });
    p.stderr?.on('data', (d) => { stderr += d; });
    if (spec.stdin != null) p.stdin.end(spec.stdin); else p.stdin?.end();
    const tick = onTick && tickMs ? setInterval(() => { try { onTick(); } catch { /* heartbeat is best effort */ } }, tickMs) : null;
    const kill = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, spec.timeoutMs);
    p.on('close', (code) => {
      clearInterval(tick); clearTimeout(kill);
      if (logDir) { fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(path.join(logDir, 'stdout.log'), stdout); fs.writeFileSync(path.join(logDir, 'stderr.log'), stderr); }
      resolve({ code: error ? 127 : code ?? 1, stdout, stderr: error ? `${stderr}${error.message}` : stderr, error, timedOut, wall_s: Math.round((Date.now() - t0) / 100) / 10 });
    });
  });
}
