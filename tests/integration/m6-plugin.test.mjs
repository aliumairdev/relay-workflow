import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, HOOKS } from '../../generators/build-claude-plugin.mjs';
import { renderAgents } from '../../core/lib/agents.mjs';
import { parseConfig, withDefaults } from '../../core/lib/config.mjs';
import { golden } from '../golden/helpers.mjs';
import { REPO } from '../helpers.mjs';

let out;
before(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plugin-')); build({ out }); });

test('golden: plugin manifest, hooks.json and a generated agent', () => {
  golden('claude/plugin.json', fs.readFileSync(path.join(out, '.claude-plugin/plugin.json'), 'utf8'));
  golden('claude/hooks.json', fs.readFileSync(path.join(out, 'hooks/hooks.json'), 'utf8'));
  golden('claude/agents-reviewer.md', fs.readFileSync(path.join(out, 'agents/reviewer.md'), 'utf8'));
  golden('claude/agents-senior-reviewer.md', fs.readFileSync(path.join(out, 'agents/senior-reviewer.md'), 'utf8'));
});

test('build is deterministic', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plugin2-'));
  build({ out: other });
  const list = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => !f.startsWith('node_modules') && fs.statSync(path.join(d, f)).isFile()).sort();
  assert.deepEqual(list(out), list(other));
  for (const f of list(out)) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(other, f))), f);
  fs.rmSync(other, { recursive: true, force: true });
});

test('layout: every spec component exists', () => {
  for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'scripts/relay-claim', 'scripts/relay-journal', 'templates/AGENTS.template.md', 'labels.json', 'workflow.schema.json', 'node_modules/yaml/package.json', 'node_modules/ajv/package.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const cmds = fs.readdirSync(path.join(out, 'commands')).map((f) => f.replace('.md', '')).sort();
  for (const c of 'init plan dispatch claim handoff review merge mode status proof resume route report doctor'.split(' ')) assert.ok(cmds.includes(c), `command ${c}`);
  const skills = fs.readdirSync(path.join(out, 'skills'));
  for (const s of 'orchestrate review-protocol claim-and-lease handoff model-routing real-env-proof design-before-code owner-decisions token-discipline issue-journal test-driven-development surgical-patch blast-radius adversarial-review'.split(' ')) assert.ok(skills.includes(s), `skill ${s}`);
  assert.ok(fs.readdirSync(path.join(out, 'agents')).length >= 10);
});

test('hooks.json only references executable scripts that exist', () => {
  for (const groups of Object.values(HOOKS.hooks)) for (const g of groups) for (const h of g.hooks) {
    const rel = h.command.replace(/^"|"$/g, '').replace('${CLAUDE_PLUGIN_ROOT}/', '');
    const f = path.join(out, rel);
    assert.ok(fs.existsSync(f), rel);
    assert.ok(fs.statSync(f).mode & 0o111, `${rel} not executable`);
    assert.match(fs.readFileSync(f, 'utf8'), /^#!\/usr\/bin\/env node/);
    assert.match(h.command, /^"\$\{CLAUDE_PLUGIN_ROOT\}\/.*"$/, 'plugin root is quoted');
  }
});

test('the built plugin is self-contained: scripts run from the copy with no access to the source tree', () => {
  const r = spawnSync(process.execPath, [path.join(out, 'scripts/relay-brief'), 'list'], { cwd: os.tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dispatch/);
  const cfg = path.join(os.tmpdir(), `relay-cfg-${process.pid}.yaml`);
  fs.writeFileSync(cfg, 'version: 1\nproject: { name: x, repo: a/b }\n');
  const v = spawnSync(process.execPath, [path.join(out, 'scripts/relay-state'), 'get', 'policy.mode'], { cwd: os.tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, RELAY_CONFIG: cfg } });
  assert.equal(v.status, 0, v.stderr); assert.equal(JSON.parse(v.stdout), 'gated');
  fs.rmSync(cfg);
});

test('no generated agent keeps a template placeholder', () => {
  for (const f of fs.readdirSync(path.join(out, 'agents'))) assert.ok(!/\{\{/.test(fs.readFileSync(path.join(out, 'agents', f), 'utf8')), f);
});

test('agents: tier mapping from workflow.yaml, per-role implementers, overrides, no model ids in templates', () => {
  const { value } = parseConfig(fs.readFileSync(path.join(REPO, 'tests/fixtures/workflow.shopify.yaml'), 'utf8'));
  const agents = renderAgents(withDefaults(value), { dir: path.join(REPO, 'core/agents') });
  const names = agents.map((a) => a.file.replace('.md', ''));
  for (const n of ['foundation-implementer', 'design-implementer', 'commerce-implementer', 'docs-implementer', 'reviewer', 'senior-reviewer']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('implementer'), 'generic implementer replaced by role implementers');
  const model = (n) => /^model: (.+)$/m.exec(agents.find((a) => a.file === `${n}.md`).content)[1];
  assert.equal(model('reviewer'), 'claude-sonnet-5-5');
  assert.equal(model('senior-reviewer'), 'claude-opus-5-5');
  assert.equal(model('docs-implementer'), 'claude-haiku-5-5', 'role tier T0 from workflow.yaml');
  assert.equal(model('architect'), 'claude-fable-5-1');
  assert.match(agents.find((a) => a.file === 'commerce-implementer.md').content, /sections\/header\*/, 'role paths injected');

  const custom = withDefaults({ version: 1, project: { name: 'p', repo: 'a/b' }, runtimes: { claude: { models: { T1: 'my-model' } } }, routing: { overrides: { agents: { reviewer: { tier: 'T2' } } } } });
  const c = renderAgents(custom, { dir: path.join(REPO, 'core/agents') });
  assert.match(c.find((a) => a.file === 'reviewer.md').content, /model: claude-opus-5-5/, 'agent override moves reviewer to T2');
  assert.match(c.find((a) => a.file === 'planner.md').content, /model: claude-opus-5-5/);
  assert.match(c.find((a) => a.file === 'implementer.md').content, /model: my-model/, 'runtime model mapping');
  assert.throws(() => renderAgents(withDefaults({ version: 1, project: { name: 'p', repo: 'a/b' }, tiers: { T9: { name: 'x' } } }), { dir: path.join(REPO, 'core/agents'), runtime: 'codex' }), /no codex model for tier/);
});

const claudeAvailable = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
test('claude plugin validate --strict passes for the manifest and every component directory', { skip: claudeAvailable ? false : 'claude binary not installed: NOT_VERIFIED' }, () => {
  for (const d of ['', 'skills', 'agents', 'commands']) {
    const r = spawnSync('claude', ['plugin', 'validate', '--strict', path.join(out, d)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${d || 'plugin'}: ${r.stdout}${r.stderr}`);
  }
});
