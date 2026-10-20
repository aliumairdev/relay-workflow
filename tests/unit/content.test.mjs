import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../helpers.mjs';
import { modelIds } from '../../core/lib/neutrality.mjs';

const CORE = path.join(REPO, 'core');
const PLANNED = new Set(['relay-init', 'relay-doctor', 'relay-status', 'relay-proof', 'relay-resume', 'relay-issues-create', 'relay-codex-dispatch', 'relay-loop', 'relay-orchestrate', 'relay-decision', 'relay-triage', 'relay-env-check', 'relay-brief', 'relay-route', 'relay-packet', 'relay-ledger', 'relay-governor', 'relay-report', 'relay-ci', 'relay-sync', 'relay-resolve', 'relay-bot-gate', 'relay-merge', 'relay-quick-merge', 'relay-merge-stack', 'relay-verdict', 'relay-gh']);
const WORKFLOW_SKILLS = ['orchestrate', 'review-protocol', 'claim-and-lease', 'handoff', 'model-routing', 'real-env-proof', 'design-before-code', 'owner-decisions', 'token-discipline', 'issue-journal'];
const COMMANDS = ['init', 'plan', 'dispatch', 'claim', 'handoff', 'review', 'merge', 'mode', 'status', 'proof', 'resume', 'route', 'report', 'doctor', 'journal'];
const AGENTS = ['orchestrator', 'planner', 'implementer', 'reviewer', 'senior-reviewer', 'release-auditor', 'docs-writer', 'qa-post-merge', 'debugger', 'architect'];
const FORBIDDEN = /nexus|shopify|liquid|aliumair/i;

function frontmatter(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  assert.ok(m, `${file}: missing frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, ''); }
  return { fm, body: t.slice(m[0].length), text: t };
}
const files = [
  ...COMMANDS.map((n) => ['command', path.join(CORE, 'commands', `${n}.md`), n]),
  ...AGENTS.map((n) => ['agent', path.join(CORE, 'agents', `${n}.md`), n]),
  ...WORKFLOW_SKILLS.map((n) => ['skill', path.join(CORE, 'skills', n, 'SKILL.md'), n]),
];

for (const [kind, file, name] of files) {
  test(`${kind} ${name}: frontmatter, neutrality, links, referenced scripts`, () => {
    assert.ok(fs.existsSync(file), `${file} missing`);
    const { fm, text } = frontmatter(file);
    if (kind === 'command') {
      assert.ok(fm.description, 'description'); assert.ok('argument-hint' in fm, 'argument-hint'); assert.ok(fm['allowed-tools'], 'allowed-tools');
      assert.ok(text.length < 2400, `command too large (${text.length})`);
    } else if (kind === 'agent') {
      assert.deepEqual(Object.keys(fm).filter((k) => !['brief'].includes(k)), ['name', 'description', 'tier', 'tools', 'color']);
      assert.equal(fm.name, name); assert.match(fm.tier, /^T[0-3]$/); assert.ok(fm.tools.split(',').length >= 3);
      if (name === 'reviewer' || name === 'senior-reviewer') assert.match(fm.description, /Never reviews a PR built by its own runtime/);
      const ph = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      if (name === 'implementer') assert.ok(ph.includes('role_name') && ph.includes('role_paths'));
      assert.ok(ph.every((p) => name === 'implementer' && ['role_name', 'role_paths'].includes(p)), `unexpected placeholders in ${name}`);
      if (fm.brief) assert.ok(fs.existsSync(path.join(CORE, 'briefs', `${fm.brief}.md`)), `brief ${fm.brief} missing`);
    } else {
      assert.equal(fm.name, name); assert.match(fm.description, /^Use when/);
      assert.ok(text.length < 3072, `skill too large (${text.length})`);
    }
    assert.deepEqual(modelIds(text), [], 'no model ids');
    assert.ok(!FORBIDDEN.test(text), `forbidden project term in ${file}`);
    for (const s of new Set(text.match(/\brelay-[a-z][a-z-]*/g) || [])) {
      const exists = fs.existsSync(path.join(CORE, 'scripts', s));
      assert.ok(exists || PLANNED.has(s), `${file}: unknown script ${s}`);
    }
    for (const m of text.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${file}: broken link ${m[1]}`);
  });
}

test('journal rule is present in every issue-facing agent and skill', () => {
  for (const n of ['implementer', 'reviewer', 'senior-reviewer', 'docs-writer', 'qa-post-merge', 'debugger']) assert.match(fs.readFileSync(path.join(CORE, 'agents', `${n}.md`), 'utf8'), /relay-journal/, n);
  for (const n of ['orchestrate', 'review-protocol', 'claim-and-lease', 'handoff', 'real-env-proof', 'design-before-code', 'owner-decisions']) assert.match(fs.readFileSync(path.join(CORE, 'skills', n, 'SKILL.md'), 'utf8'), /\.\.\/issue-journal\/SKILL\.md/, n);
});
