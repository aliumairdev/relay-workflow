import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import { RelayError, EXIT } from './exit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORE = path.resolve(here, '..');
const schema = JSON.parse(fs.readFileSync(path.join(CORE, 'workflow.schema.json'), 'utf8'));

export const expandHome = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function findConfig(start = process.cwd()) {
  if (process.env.RELAY_CONFIG) return path.resolve(process.env.RELAY_CONFIG);
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, 'workflow.yaml');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Validate a parsed config object. Returns [{path, line, message}] (empty when valid).
export function validate(obj, doc) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const check = ajv.compile(schema);
  if (check(obj)) return [];
  return check.errors.map((e) => {
    const segs = e.instancePath.split('/').filter(Boolean);
    if (e.keyword === 'additionalProperties') segs.push(e.params.additionalProperty);
    let line = null;
    if (doc) { const node = doc.getIn(segs, true); const off = node?.range?.[0]; if (off != null) line = doc.contents ? lineAt(doc, off) : null; }
    return { path: segs.join('.') || '(root)', line, message: e.keyword === 'additionalProperties' ? `unknown key "${e.params.additionalProperty}"` : e.message };
  });
}
function lineAt(doc, off) { const src = doc.__src || ''; return src ? src.slice(0, off).split('\n').length : null; }

export function parseConfig(text) {
  const doc = YAML.parseDocument(text);
  doc.__src = text;
  if (doc.errors.length) {
    return { errors: doc.errors.map((e) => ({ path: '(yaml)', line: e.linePos?.[0]?.line ?? null, message: e.message.split('\n')[0] })) };
  }
  const value = doc.toJS();
  return { value, errors: validate(value, doc) };
}

export function loadConfig({ file, optional = false } = {}) {
  const f = file || findConfig();
  if (!f || !fs.existsSync(f)) {
    if (optional) return null;
    throw new RelayError('workflow.yaml not found (set RELAY_CONFIG or run relay-init)', EXIT.INVALID);
  }
  const { value, errors } = parseConfig(fs.readFileSync(f, 'utf8'));
  if (errors.length) {
    const msg = errors.map((e) => `${f}:${e.line ?? '?'} ${e.path}: ${e.message}`).join('\n');
    throw new RelayError(`invalid workflow.yaml\n${msg}`, EXIT.INVALID, { errors });
  }
  const cfg = withDefaults(value);
  Object.defineProperty(cfg, '__file', { value: f, enumerable: false });
  Object.defineProperty(cfg, '__root', { value: path.dirname(f), enumerable: false });
  return cfg;
}

export function withDefaults(c) {
  return {
    ...c,
    project: { default_branch: 'main', state_file: 'harness/STATE.json', ...c.project },
    policy: { mode: 'gated', ...c.policy },
    claims: { lease_minutes: 30, heartbeat_minutes: 10, branch_pattern: 'agent/{runtime}/{issue}-{slug}', ...c.claims },
    review: { cross_runtime: true, delta_only_rereview: true, max_rework_rounds: 3, routine_tier: 'T1', ...c.review },
    ci: { mode: 'local', retry_once_on_fail: true, steps: [], ...c.ci },
    bot: { gate: false, logins: [], require_reply_from_non_bot: true, ...c.bot },
    labels: { aliases: {}, ...c.labels },
    concurrency: { max_agents: 8, hard_max: 20, load_limit_factor: 1.5, heavy_slots: 2, ...c.concurrency },
  };
}

export const stateFile = (cfg) => path.resolve(cfg.__root, cfg.project.state_file);
export const relayDir = (cfg) => path.join(cfg.__root, '.relay');
