import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { CORE } from './config.mjs';

export const SCRIPTS_DIR = path.join(CORE, 'scripts');
export const scriptPath = (name) => path.join(SCRIPTS_DIR, name);

// Environment for child scripts/agents: relay-* on PATH, config pinned.
export function relayEnv(cfg, extra = {}) {
  return { ...process.env, PATH: `${SCRIPTS_DIR}${path.delimiter}${process.env.PATH || ''}`, RELAY_CONFIG: cfg.__file, ...extra };
}

// Run a relay script synchronously: {code, stdout, stderr, json()}.
export function runScript(cfg, name, args = [], { env = {}, cwd = cfg.__root, input } = {}) {
  const r = spawnSync(process.execPath, [scriptPath(name), ...args], { encoding: 'utf8', cwd, env: relayEnv(cfg, env), input });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '', json: () => JSON.parse(r.stdout) };
}
export { spawn };
