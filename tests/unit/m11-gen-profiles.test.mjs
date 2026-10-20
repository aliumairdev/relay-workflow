import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPlan, generateConfig, configFromText, detectStack } from '../../core/lib/install.mjs';
import { parseConfig } from '../../core/lib/config.mjs';
import { listProfiles, loadProfile, loadLessons } from '../../core/lib/profile.mjs';
import { modelIds } from '../../core/lib/neutrality.mjs';
import { golden } from '../golden/helpers.mjs';
import { REPO } from '../helpers.mjs';

const tmp = (files = {}) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gen-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const op = (plan, p) => plan.ops.find((o) => o.path === p);

test('T-GEN-1: Cursor rules golden', () => {
  const d = tmp(); const plan = buildPlan(d, { runtimes: ['cursor'], name: 'demo', repo: 'o/demo' });
  const c = op(plan, '.cursor/rules/relay.mdc').content;
  golden('gen/cursor-relay.mdc', c);
  assert.deepEqual(modelIds(c), [], 'no model ids in shared rules'); assert.match(c, /alwaysApply: true/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('T-GEN-2: Gemini GEMINI.md block golden (imports AGENTS.md)', () => {
  const d = tmp(); const plan = buildPlan(d, { runtimes: ['gemini'], name: 'demo', repo: 'o/demo' });
  const b = op(plan, 'GEMINI.md').body;
  golden('gen/gemini-block.md', b); assert.match(b, /^@AGENTS\.md/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('T-GEN-3: Copilot instructions golden', () => {
  const d = tmp(); const plan = buildPlan(d, { runtimes: ['copilot'], name: 'demo', repo: 'o/demo' });
  const b = op(plan, '.github/copilot-instructions.md').body;
  golden('gen/copilot-block.md', b); assert.deepEqual(modelIds(b), []);
  fs.rmSync(d, { recursive: true, force: true });
});

const STRATEGIES = new Set(['union', 'json-deep-merge', 'line-union', 'keep-both']);

for (const [stack, marker] of [['rails', { 'config/application.rb': '' }], ['nextjs', { 'next.config.js': 'module.exports={}' }], ['shopify-theme', { 'layout/theme.liquid': '' }], ['generic', {}]]) {
  test(`T-PROFILE: ${stack} - detected, generates a schema-valid config, resolver strategies exist, profile is self-consistent`, () => {
    const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'echo ok' } }), ...marker });
    try {
      assert.equal(detectStack(d), stack);
      const text = generateConfig(d, { stack, runtimes: ['claude', 'codex'], name: 'demo', repo: 'o/demo' });
      const { value, errors } = parseConfig(text);
      assert.deepEqual(errors, [], JSON.stringify(errors));
      assert.equal(value.project.stack, stack);
      for (const r of value.resolvers) assert.ok(STRATEGIES.has(r.strategy), `${stack}: resolver strategy ${r.strategy} is implemented`);
      for (const r of value.resolvers) assert.ok(fs.existsSync(path.join(REPO, 'core/resolvers', `${r.strategy === 'union' ? 'md-union' : r.strategy}.mjs`)), `resolver module for ${r.strategy}`);
      const cfg = configFromText(text, d);
      assert.ok(cfg.ci.steps.length >= 1, 'CI steps from the profile or package.json');
      const prof = loadProfile(stack);
      assert.ok(prof.description && prof.lessons);
      assert.ok(Array.isArray(loadLessons(stack)));
      for (const p of prof.destructive_patterns || []) assert.doesNotThrow(() => new RegExp(p.pattern, 'i'), p.pattern);
      assert.ok(listProfiles().includes(stack));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
}
