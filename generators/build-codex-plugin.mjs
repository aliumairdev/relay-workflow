#!/usr/bin/env node
// Build the Codex plugin (dist/codex/workflow) from core/. Deterministic: same inputs, same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './build-claude-plugin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const manifest = () => ({
  name: 'workflow',
  version: pkg.version,
  description: pkg.description,
  author: { name: 'aliumairdev' },
  license: pkg.license,
  keywords: ['multi-agent', 'workflow', 'github', 'codex', 'claude', 'model-routing'],
  skills: './skills/',
  interface: {
    displayName: 'Relay Workflow',
    shortDescription: 'Multi-agent build workflow across Claude and Codex',
    category: 'Productivity',
  },
});

const README = `# workflow (Relay) — Codex plugin

Multi-agent build workflow: GitHub control plane, model routing, claims and handoffs across Claude and Codex, merge queue, real-environment proof.

Install: \`codex plugin marketplace add aliumairdev/relay-workflow\`, then install \`workflow\` from the Plugins directory.

Generated from \`core/\`; do not edit by hand.
`;

export function build({ out = path.join(ROOT, 'dist/codex/workflow') } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  const core = path.join(ROOT, 'core');
  // Claude subagent definitions are not part of the Codex package
  copyDir(core, out, (s) => s === path.join(core, 'agents') || s.endsWith('.DS_Store'));

  fs.mkdirSync(path.join(out, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(out, '.codex-plugin/plugin.json'), JSON.stringify(manifest(), null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'README.md'), README);

  // runtime dependencies so the plugin is self-contained
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) copyDir(nm, path.join(out, 'node_modules'), (s) => /[\\/](\.bin|\.package-lock\.json)$/.test(s));

  // marketplace entry at the repository root (dist is committed as release artifacts)
  const mk = path.join(ROOT, '.agents/plugins');
  fs.mkdirSync(mk, { recursive: true });
  fs.writeFileSync(path.join(mk, 'marketplace.json'), JSON.stringify({
    name: 'relay-marketplace',
    interface: { displayName: 'Relay' },
    plugins: [{
      name: 'workflow',
      source: { source: 'local', path: './dist/codex/workflow' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  }, null, 2) + '\n');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.indexOf('--out');
  console.log(build(outArg > 0 ? { out: path.resolve(process.argv[outArg + 1]) } : {}));
}
