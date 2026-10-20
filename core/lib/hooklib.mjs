import fs from 'node:fs';
import path from 'node:path';
import { findConfig, loadConfig, relayDir } from './config.mjs';

// Read the hook payload (JSON on stdin).
export function readPayload() {
  try { const t = fs.readFileSync(0, 'utf8'); return t.trim() ? JSON.parse(t) : {}; } catch { return {}; }
}

// Load workflow.yaml for the payload's cwd; null when the directory is not a Relay project or the config is unreadable.
export function projectConfig(payload) {
  try {
    const f = findConfig(payload.cwd || process.cwd());
    return f ? loadConfig({ file: f }) : null;
  } catch { return null; }
}

export const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
export const allow = () => process.exit(0);
export function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  process.exit(0);
}
export function warn(message) { emit({ systemMessage: message }); process.exit(0); }

// Hooks fail open on internal errors (never trap the user) but leave a trace.
export function failOpen(cfg, name, e) {
  try {
    const dir = cfg ? path.join(relayDir(cfg), 'logs') : null;
    if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'hook-errors.log'), `${new Date().toISOString()} ${name}: ${e?.stack || e}\n`); }
  } catch { /* nothing more to do */ }
  process.exit(0);
}

export function guard(name, fn) {
  const payload = readPayload();
  const cfg = projectConfig(payload);
  try { fn(payload, cfg); } catch (e) { failOpen(cfg, name, e); }
}

// Compile a config pattern; a leading (?i) means case-insensitive.
export function toRegExp(p) {
  const ci = p.startsWith('(?i)');
  return new RegExp(ci ? p.slice(4) : p, ci ? 'i' : '');
}
