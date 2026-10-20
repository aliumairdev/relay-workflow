import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSandbox, seedIssue, enforceContracts, useFakeRuntimes, FOUR_AC_BODY, SCRIPTS, REPO } from '../helpers.mjs';
import { build } from '../../generators/build-claude-plugin.mjs';
import { TOOLS } from '../../core/lib/mcp.mjs';

const RULES = [/ISSUE OWNERSHIP/, /COMPLETE work contract/, /relay-contract check/, /Never:[^\n]*follow-up/];

test('T-XRT-1: every runtime gets the same ownership rules in dispatch, review and QA briefs (one canonical source)', () => {
  const sb = enforceContracts(makeSandbox());
  try {
    const seen = {};
    for (const rt of ['claude', 'codex', 'gemini']) {
      for (const brief of ['dispatch', 'review', 'post-merge-qa']) {
        const r = sb.run('relay-brief', ['render', brief, '--stdout', '--var', 'issue=7', '--var', `runtime=${rt}`, '--var', 'agent_id=a1', '--var', 'branch=agent/x/7-y', '--var', 'pr=9', '--var', 'prs=#9', '--var', 'ref=main', '--var', 'tier_name=implement', '--var', 'review_runtime=claude', '--var', 'role_name=general']);
        assert.equal(r.code, 0, `${rt}/${brief}: ${r.stderr}`);
        for (const re of RULES) assert.match(r.stdout, re, `${rt}/${brief} lacks ${re}`);
        // strip only the runtime wrapper line and compare: the lifecycle semantics are identical
        const core = r.stdout.split('\n').filter((l) => !/^RUNTIME: /.test(l)).join('\n').replace(/\b(claude|codex|gemini)\b/gi, 'RT');
        (seen[brief] ??= new Set()).add(core);
      }
    }
    for (const [brief, variants] of Object.entries(seen)) assert.equal(variants.size, 1, `${brief} brief differs between runtimes beyond the wrapper`);
    assert.match(sb.run('relay-brief', ['render', 'review', '--stdout', '--var', 'issue=7', '--var', 'runtime=codex', '--var', 'agent_id=a', '--var', 'branch=b', '--var', 'pr=9', '--var', 'tier_name=t']).stdout, /CONTRACT_COVERAGE|--coverage AC1=PASS/);
  } finally { sb.cleanup(); }
});

test('T-XRT-2: installer output for every runtime carries the contract rule; init writes contract.mode enforce', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-xrt-')));
  try {
    const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.invalid'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' } }));
    g('add', '-A'); g('commit', '-qm', 'init');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'relay-init'), 'init', '--no-labels', '--yes', '--runtime', 'claude,codex,gemini,cursor,copilot'], { cwd: d, encoding: 'utf8', env: { ...process.env, RELAY_GH: path.join(REPO, 'tests/fakes/gh'), RELAY_FAKE_GH_DB: path.join(d, '.fake-gh.json') } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const read = (f) => fs.readFileSync(path.join(d, f), 'utf8');
    assert.match(read('AGENTS.md'), /PR complete != issue complete\. Merged != verified\. GitHub closed != contract complete/);
    assert.match(read('AGENTS.md'), /Refs #<N>/);
    for (const f of ['.cursor/rules/relay.mdc', '.github/copilot-instructions.md', 'GEMINI.md']) assert.match(read(f), /relay-contract/, f);
    assert.match(read('.github/pull_request_template.md'), /## Contract Coverage[\s\S]*Issue completion:/);
    assert.match(read('.github/pull_request_template.md'), /Refs #<N>/);
    assert.match(read('workflow.yaml'), /contract:\n\s+mode: enforce/);
    assert.ok(fs.existsSync(path.join(d, '.relay/bin/relay-contract')));
    for (const a of ['implementer', 'reviewer', 'orchestrator', 'qa-post-merge', 'release-auditor']) assert.match(read(`.claude/agents/${a}.md`), /relay-contract|contract/, a);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('T-XRT-3: the generated Claude plugin is rebuilt from core and exposes the contract on every surface', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plugin-'));
  try {
    build({ out });
    const committed = path.join(REPO, 'dist/claude/workflow');
    for (const f of ['scripts/relay-contract', 'lib/contract.mjs', 'lib/contractops.mjs', 'schemas/contract.schema.json', 'briefs/ownership.md', 'commands/contract.md', 'skills/issue-contract/SKILL.md', 'agents/implementer.md', 'agents/reviewer.md', 'lib/mcp.mjs', 'hooks/hooks.json']) {
      assert.ok(fs.existsSync(path.join(out, f)), `${f} generated`);
      assert.equal(fs.readFileSync(path.join(out, f), 'utf8'), fs.readFileSync(path.join(committed, f), 'utf8'), `${f}: committed dist is stale (run node generators/build-claude-plugin.mjs)`);
    }
    assert.match(fs.readFileSync(path.join(out, 'agents/implementer.md'), 'utf8'), /WHOLE issue contract/);
    assert.match(fs.readFileSync(path.join(out, 'agents/reviewer.md'), 'utf8'), /CONTRACT_COVERAGE/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('T-XRT-4: MCP exposes the same lifecycle gate as the CLI (no tool can close an issue or open a decision around it)', () => {
  assert.ok(TOOLS.issue_contract && TOOLS.contract_mark);
  const verbs = TOOLS.issue_contract.schema.properties.action.enum;
  for (const v of ['extract', 'show', 'update', 'check', 'reconcile', 'audit', 'close', 'sweep', 'pr_section', 'release_audit']) assert.ok(verbs.includes(v), v);
  assert.deepEqual(TOOLS.owner_decision.schema.required.sort(), ['category', 'contract_gap', 'default', 'evidence', 'issue', 'options', 'question', 'unsafe_because']);
  // every MCP tool maps to a relay-* script that exists: no logic of its own
  for (const [name, t] of Object.entries(TOOLS)) {
    const sample = Object.fromEntries((t.schema.required || []).map((k) => [k, t.schema.properties[k].type === 'integer' ? 1 : t.schema.properties[k].type === 'array' ? ['x'] : t.schema.properties[k].enum ? t.schema.properties[k].enum[0] : 'x']));
    const [script] = t.argv(sample, os.tmpdir(), 'gated');
    assert.ok(fs.existsSync(path.join(SCRIPTS, script)), `${name} -> ${script}`);
  }
});

test('T-XRT-5: a headless runtime (codex) gets the contract in its brief, and a partial slice is reported as incomplete, never "done"', () => {
  const sb = useFakeRuntimes(enforceContracts(makeSandbox()));
  try {
    const n = seedIssue(sb, { title: 'Prospect admission', body: `${FOUR_AC_BODY}\n## Owned Paths\nsrc/**\n`, labels: ['state:ready', 'agent:codex'] });
    const r = sb.run('relay-codex-dispatch', [String(n), '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = r.json();
    assert.equal(res.outcome, 'done'); assert.equal(res.issue_complete, false);
    assert.deepEqual(res.contract.unresolved, ['AC1', 'AC2', 'AC3', 'AC4']);
    assert.equal(res.contract.next, 'implement');
    const brief = fs.readdirSync(path.join(sb.work, '.relay/briefs')).find((f) => f.startsWith(`issue-${n}-`));
    const text = fs.readFileSync(path.join(sb.work, '.relay/briefs', brief), 'utf8');
    assert.match(text, new RegExp(`ISSUE CONTRACT #${n} — 0/4 complete`));
    assert.match(text, /- \[ \] AC4 \[TODO · runtime proof\]/);
    assert.match(text, /Your job is to complete the ENTIRE contract/);
    assert.match(text, /RUNTIME: Codex/);
    // the dispatcher output is not the end of ownership: the issue is still open and still unresolved
    assert.equal(sb.issue(n).state, 'open');
    assert.equal(sb.run('relay-contract', ['check', String(n)]).code, 4);
  } finally { sb.cleanup(); }
});
