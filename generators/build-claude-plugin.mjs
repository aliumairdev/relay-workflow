#!/usr/bin/env node
// Build the Claude Code plugin (dist/claude/workflow) from core/. Deterministic: same inputs, same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from '../core/lib/config.mjs';
import { renderAgents } from '../core/lib/agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const HOOKS = {
  description: 'Relay workflow guards: goal-loop stop hook, destructive-command gate, secret and worktree guards, ledger counters, session recovery summary.',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-stop\"' }] }],
    PreToolUse: [
      { matcher: 'Bash', hooks: [
        { type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-destructive-gate\"' },
        { type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-brief-lint\"' }] },
      { matcher: 'Write|Edit|MultiEdit', hooks: [
        { type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-secret-guard\"' },
        { type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-worktree-guard\"' }] },
    ],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-ledger\"' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: '\"${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-session-start\"' }] }],
  },
};

export const manifest = () => ({
  name: 'workflow',
  version: pkg.version,
  description: pkg.description,
  author: { name: 'owner' },
  license: pkg.license,
  keywords: ['multi-agent', 'workflow', 'github', 'codex', 'claude', 'model-routing'],
});

const README = `# workflow (Relay) — Claude Code plugin

Multi-agent build workflow: GitHub control plane, model routing, claims and handoffs across Claude and Codex, merge queue, real-environment proof, and a per-issue implementation journal.

Install: \`/plugin marketplace add <owner>/relay\`, \`/plugin install workflow@relay-marketplace\`, then \`/workflow:init\`.

Generated from \`core/\`; do not edit by hand. Commands: \`/workflow:init plan dispatch claim handoff review merge mode status proof resume route report doctor journal\`.
`;

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(s)) continue;
    if (e.isDirectory()) copyDir(s, d, skip);
    else { fs.copyFileSync(s, d); fs.chmodSync(d, fs.statSync(s).mode); }
  }
}

export function build({ out = path.join(ROOT, 'dist/claude/workflow') } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  const core = path.join(ROOT, 'core');
  // agents/ is generated; the neutral templates ship as agent-templates/ for relay-init
  copyDir(core, out, (s) => s === path.join(core, 'agents') || s.endsWith('.DS_Store'));
  copyDir(path.join(core, 'agents'), path.join(out, 'agent-templates'));
  const cfg = withDefaults({ version: 1, project: { name: 'project', repo: 'local' } });
  fs.mkdirSync(path.join(out, 'agents'), { recursive: true });
  for (const a of renderAgents(cfg, { dir: path.join(core, 'agents') })) fs.writeFileSync(path.join(out, 'agents', a.file), a.content);

  fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(out, '.claude-plugin/plugin.json'), JSON.stringify(manifest(), null, 2) + '\n');
  fs.mkdirSync(path.join(out, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(out, 'hooks/hooks.json'), JSON.stringify(HOOKS, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'README.md'), README);

  // runtime dependencies so the plugin is self-contained
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) copyDir(nm, path.join(out, 'node_modules'), (s) => /[\\/](\.bin|\.package-lock\.json)$/.test(s));

  // marketplace entry at the repository root (dist is committed as release artifacts)
  const mk = path.join(ROOT, '.claude-plugin');
  fs.mkdirSync(mk, { recursive: true });
  fs.writeFileSync(path.join(mk, 'marketplace.json'), JSON.stringify({
    name: 'relay-marketplace', owner: { name: 'owner' }, description: 'Relay: multi-agent build workflow plugins for Claude Code',
    plugins: [{ name: 'workflow', source: './dist/claude/workflow', description: 'Multi-agent build workflow', version: pkg.version }],
  }, null, 2) + '\n');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.indexOf('--out');
  console.log(build(outArg > 0 ? { out: path.resolve(process.argv[outArg + 1]) } : {}));
}
