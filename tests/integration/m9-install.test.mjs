import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SCRIPTS, REPO } from '../helpers.mjs';
import { parseConfig } from '../../core/lib/config.mjs';
import { removeBlock, findBlock } from '../../core/lib/managed.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'core/package.json'), 'utf8')).version;

function repo(files = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-inst-')));
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'echo ok', lint: 'echo lint' } }, null, 2) + '\n');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  g('add', '-A'); g('commit', '-qm', 'init');
  return d;
}
const cli = (d, cmd, args = [], env = {}) => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, cmd), ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, RELAY_GH: path.join(REPO, 'tests/fakes/gh'), RELAY_FAKE_GH_DB: path.join(d, '.fake-gh.json'), ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
};
// every file (relative path -> sha), ignoring .git and the fake gh database
function snapshot(d) {
  const out = {};
  for (const f of fs.readdirSync(d, { recursive: true })) {
    if (f === '.git' || f.startsWith('.git/') || f === '.fake-gh.json') continue;
    const p = path.join(d, f);
    out[f] = fs.statSync(p).isDirectory() ? 'DIR' : crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const INIT = ['init', '--no-labels', '--yes'];

test('T-INIT-1: a clean repo gets the expected files; a second init changes nothing', () => {
  const d = repo();
  try {
    const r = cli(d, 'relay-init', [...INIT, '--runtime', 'claude']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    for (const f of ['workflow.yaml', 'AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.github/ISSUE_TEMPLATE/task.md', '.github/pull_request_template.md', 'harness/STATE.json', 'harness/handoffs/.gitkeep', 'harness/blockers/.gitkeep', 'harness/reports/.gitkeep', 'harness/proof/.gitkeep', '.relay/lock.json', '.gitignore']) assert.ok(fs.existsSync(path.join(d, f)), f);
    assert.ok(fs.readdirSync(path.join(d, '.claude/agents')).length >= 10, 'agents generated');
    assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8')).env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
    assert.ok(fs.statSync(path.join(d, '.relay/bin/relay-claim')).mode & 0o111, 'shims are executable');
    const cfg = parseConfig(fs.readFileSync(path.join(d, 'workflow.yaml'), 'utf8'));
    assert.deepEqual(cfg.errors, [], 'generated workflow.yaml validates');
    assert.deepEqual(cfg.value.ci.steps.map((s) => s.name), ['lint', 'test'], 'CI steps detected from package.json');
    assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /npm test --silent/, 'validation commands rendered into AGENTS.md');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'harness/STATE.json'), 'utf8')).policy.mode, 'gated');
    assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /# relay:begin relay\n\.relay\/\*\n!\.relay\/lock\.json/);

    const before = snapshot(d);
    const again = cli(d, 'relay-init', [...INIT, '--runtime', 'claude']);
    assert.equal(again.code, 0); assert.match(again.stdout, /already installed, no changes/);
    assert.deepEqual(snapshot(d), before, 'second init changes no byte');
  } finally { rm(d); }
});

test('T-INIT-3: existing AGENTS.md / CLAUDE.md / settings / .gitignore content is preserved byte for byte outside managed blocks', () => {
  const orig = {
    'AGENTS.md': '# Team rules\n\n- Be kind.\n- Squash merges only.\n',
    'CLAUDE.md': '# Claude notes\n\nUse the monorepo layout.',                       // no trailing newline
    '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, env: { KEEP: '1' } }, null, 2) + '\n',
    '.gitignore': 'node_modules/\n.env\n',
  };
  const d = repo(orig);
  try {
    const r = cli(d, 'relay-init', [...INIT, '--runtime', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    const agents = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith(orig['AGENTS.md']), 'user content kept in place');
    assert.equal(removeBlock(agents, 'agents', 'html', JSON.parse(fs.readFileSync(path.join(d, '.relay/lock.json'), 'utf8')).files['AGENTS.md'].prefix).text, orig['AGENTS.md']);
    const claude = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /^@AGENTS\.md\n/, 'import line added at the top'); assert.ok(claude.includes('# Claude notes\n\nUse the monorepo layout.'));
    const settings = JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }); assert.equal(settings.env.KEEP, '1'); assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
    const ig = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
    assert.ok(ig.startsWith('node_modules/\n.env\n')); assert.ok(findBlock(ig, 'relay', 'hash'));
    // originals backed up before the first modification
    const backups = fs.readdirSync(path.join(d, '.relay/backup'));
    assert.equal(backups.length, 1);
    for (const f of Object.keys(orig)) assert.equal(fs.readFileSync(path.join(d, '.relay/backup', backups[0], f), 'utf8'), orig[f], `backup of ${f}`);
    // an already-imported CLAUDE.md is not given a second import line
    const d2 = repo({ 'CLAUDE.md': '@AGENTS.md\n\nmine\n' });
    cli(d2, 'relay-init', [...INIT, '--runtime', 'claude']);
    assert.equal((fs.readFileSync(path.join(d2, 'CLAUDE.md'), 'utf8').match(/^@AGENTS\.md$/gm) || []).length, 1);
    rm(d2);
  } finally { rm(d); }
});

test('T-CLI-1: --dry-run prints unified diffs and writes nothing', () => {
  const d = repo({ 'AGENTS.md': '# Mine\n' });
  try {
    const before = snapshot(d);
    const r = cli(d, 'relay-init', ['init', '--dry-run', '--runtime', 'claude,codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^--- a\/workflow\.yaml$/m); assert.match(r.stdout, /^\+\+\+ b\/AGENTS\.md$/m); assert.match(r.stdout, /nothing was written/);
    assert.deepEqual(snapshot(d), before);
    assert.ok(!fs.existsSync(path.join(d, '.relay')), 'no .relay directory either');
  } finally { rm(d); }
});

test('T-CLI-2: version pinning', () => {
  const d = repo();
  try {
    const bad = cli(d, 'relay-init', [...INIT, '--version', '9.9.9']);
    assert.equal(bad.code, 3); assert.match(bad.stderr, /npx relay-workflow@9\.9\.9/);
    assert.ok(!fs.existsSync(path.join(d, 'workflow.yaml')), 'nothing written on a version mismatch');
    const ok = cli(d, 'relay-init', [...INIT, '--version', VERSION]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.relay/lock.json'), 'utf8')).version, VERSION);
    assert.equal(cli(d, 'relay-workflow', ['version']).stdout.trim(), VERSION);
    assert.equal(VERSION, JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version, 'core and package versions agree');
  } finally { rm(d); }
});

test('T-CLI-3: update applies unedited changes, stops on hand-edited managed content, --keep keeps it, --overwrite replaces with a backup', () => {
  const d = repo();
  try {
    cli(d, 'relay-init', [...INIT, '--runtime', 'claude']);
    // a config change flows into the generated AGENTS.md block (unedited -> applied)
    fs.writeFileSync(path.join(d, 'workflow.yaml'), fs.readFileSync(path.join(d, 'workflow.yaml'), 'utf8').replace('npm test --silent', 'npm run -s test:unit'));
    const up = cli(d, 'relay-update', ['--json']);
    assert.equal(up.code, 0, up.stderr + up.stdout);
    assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /npm run -s test:unit/);

    // hand edit inside the managed block
    const f = path.join(d, 'AGENTS.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## Standards', '## Standards (edited by hand)'));
    fs.writeFileSync(path.join(d, 'workflow.yaml'), fs.readFileSync(path.join(d, 'workflow.yaml'), 'utf8').replace('npm run -s test:unit', 'npm run -s test:all'));
    const edited = fs.readFileSync(f, 'utf8');
    const blocked = cli(d, 'relay-update', []);
    assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr); assert.match(blocked.stdout, /hand-edited managed content, not changed: AGENTS\.md/);
    assert.equal(fs.readFileSync(f, 'utf8'), edited, 'nothing overwritten without a decision');

    const dry = cli(d, 'relay-update', ['--dry-run']);
    assert.equal(dry.code, 0); assert.match(dry.stdout, /hand-edited/); assert.equal(fs.readFileSync(f, 'utf8'), edited);

    const kept = cli(d, 'relay-update', ['--keep']);
    assert.equal(kept.code, 0, kept.stderr); assert.equal(fs.readFileSync(f, 'utf8'), edited, '--keep keeps the edit'); assert.match(kept.stdout, /kept your edits in: AGENTS\.md/);

    const over = cli(d, 'relay-update', ['--overwrite']);
    assert.equal(over.code, 0, over.stderr);
    assert.match(fs.readFileSync(f, 'utf8'), /npm run -s test:all/); assert.ok(!fs.readFileSync(f, 'utf8').includes('edited by hand'));
    const backups = fs.readdirSync(path.join(d, '.relay/backup'));
    assert.ok(backups.some((b) => fs.existsSync(path.join(d, '.relay/backup', b, 'AGENTS.md')) && fs.readFileSync(path.join(d, '.relay/backup', b, 'AGENTS.md'), 'utf8').includes('edited by hand')), 'the edited version is backed up');
    assert.equal(cli(d, 'relay-update', ['--keep', '--overwrite']).code, 3);
  } finally { rm(d); }
});

test('T-CLI-4: uninstall restores the original tree exactly (clean repo and repo with existing files)', () => {
  for (const files of [{}, { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': 'notes', '.claude/settings.json': '{\n  "env": {\n    "A": "1"\n  }\n}\n', '.gitignore': 'node_modules/\n', 'GEMINI.md': 'g\n' }]) {
    const d = repo(files);
    try {
      const original = snapshot(d);
      assert.equal(cli(d, 'relay-init', [...INIT, '--runtime', 'claude,codex,cursor,gemini,copilot']).code, 0);
      assert.notDeepEqual(snapshot(d), original);
      const u = cli(d, 'relay-uninstall', ['--json']);
      assert.equal(u.code, 0, u.stderr);
      assert.deepEqual(snapshot(d), original, 'tree identical to before init');
    } finally { rm(d); }
  }
  // a generated file the user edited is kept (not silently deleted) unless --force
  const d = repo();
  try {
    cli(d, 'relay-init', [...INIT, '--runtime', 'claude']);
    const f = path.join(d, '.claude/agents/reviewer.md');
    fs.appendFileSync(f, '\nmy own rule\n');
    const u = cli(d, 'relay-uninstall', ['--json']);
    assert.ok(fs.existsSync(f), 'edited generated file kept'); assert.deepEqual(u.json().kept, ['.claude/agents/reviewer.md']);
    assert.equal(cli(d, 'relay-uninstall', []).code, 3, 'second uninstall: not installed');
  } finally { rm(d); }
});

test('T-CLI-5: init per runtime flag (claude, codex, cursor, gemini, copilot) and stack profiles', () => {
  const expect = {
    claude: ['CLAUDE.md', '.claude/agents/reviewer.md', '.claude/settings.json'],
    codex: ['.relay/codex/prompts/reviewer.md', '.agents/skills/issue-journal/SKILL.md', '.agents/skills/test-driven-development/SKILL.md'],
    cursor: ['.cursor/rules/relay.mdc'],
    gemini: ['GEMINI.md'],
    copilot: ['.github/copilot-instructions.md'],
  };
  for (const [rt, files] of Object.entries(expect)) {
    const d = repo();
    try {
      const r = cli(d, 'relay-init', [...INIT, '--runtime', rt]);
      assert.equal(r.code, 0, `${rt}: ${r.stderr}`);
      for (const f of files) assert.ok(fs.existsSync(path.join(d, f)), `${rt}: ${f}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, '.relay/lock.json'), 'utf8')).runtimes, [rt]);
      if (rt !== 'claude') assert.ok(!fs.existsSync(path.join(d, 'CLAUDE.md')), `${rt}: no Claude files`);
    } finally { rm(d); }
  }
  const d = repo();
  try {
    assert.equal(cli(d, 'relay-init', [...INIT, '--runtime', 'vim']).code, 3);
    assert.equal(cli(d, 'relay-init', [...INIT, '--stack', 'cobol']).code, 3);
    const gem = (() => { cli(d, 'relay-init', [...INIT, '--runtime', 'gemini']); return fs.readFileSync(path.join(d, 'GEMINI.md'), 'utf8'); })();
    assert.match(gem, /^<!-- relay:begin gemini -->\n@AGENTS\.md/);
  } finally { rm(d); }
  // stacks: rails ships its framework skills into the project; the profile fills CI and resolvers
  const r = repo({ 'config/application.rb': '' });
  try {
    const res = cli(r, 'relay-init', [...INIT, '--runtime', 'claude']);
    assert.equal(res.code, 0, res.stderr);
    const cfg = parseConfig(fs.readFileSync(path.join(r, 'workflow.yaml'), 'utf8')).value;
    assert.equal(cfg.project.stack, 'rails'); assert.ok(cfg.ci.steps.some((s) => s.cmd.includes('bin/rails test')));
    for (const s of ['rails-backend', 'hotwire-frontend', 'tailwind-ui']) assert.ok(fs.existsSync(path.join(r, '.claude/skills', s, 'SKILL.md')), s);
    assert.ok(!fs.existsSync(path.join(r, '.claude/skills/test-driven-development')), 'core skills come from the plugin for Claude');
    assert.match(fs.readFileSync(path.join(r, 'AGENTS.md'), 'utf8'), /RAILS: follow the rails-backend/);
    const all = cli(r, 'relay-update', ['--skills', 'all']);
    assert.equal(all.code, 0);
    assert.ok(fs.existsSync(path.join(r, '.claude/skills/test-driven-development/SKILL.md')), '--skills all adds the core skills');
  } finally { rm(r); }
});

test('T-DOC-1: doctor detects a missing @AGENTS.md import, model ids, oversize AGENTS.md, a missing label and a drifted generated file; --fix repairs the safe ones', () => {
  const d = repo();
  try {
    const init = cli(d, 'relay-init', ['init', '--yes', '--runtime', 'claude', '--repo', 'local/sandbox']);
    assert.equal(init.code, 0, init.stderr); assert.match(init.stdout, /labels: 58 created/, 'init creates the label set');
    const clean = cli(d, 'relay-doctor', ['--json']);
    const by = (r) => Object.fromEntries(r.json().checks.map((c) => [c.id, c]));
    assert.equal(by(clean)['claude-imports-agents'].status, 'pass'); assert.equal(by(clean)['agents-neutral'].status, 'pass'); assert.equal(by(clean)['agents-size'].status, 'pass');
    assert.equal(by(clean)['generated-drift'].status, 'pass'); assert.equal(by(clean).secrets.status, 'pass'); assert.equal(by(clean).scripts.status, 'pass');
    assert.notEqual(clean.code, 3, JSON.stringify(clean.json().checks.filter((c) => c.status === 'fail')));

    const dbf = path.join(d, '.fake-gh.json'); const db = JSON.parse(fs.readFileSync(dbf, 'utf8'));
    db.labels = db.labels.filter((l) => l.name !== 'handoff:to-codex'); fs.writeFileSync(dbf, JSON.stringify(db));
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# no import here\n');
    fs.appendFileSync(path.join(d, 'AGENTS.md'), '\nUse claude-sonnet-5-5 for implementation and SendMessage to resume.\n' + 'filler line to grow the file\n'.repeat(1500));
    fs.appendFileSync(path.join(d, '.claude/agents/reviewer.md'), '\ndrift\n');
    const bad = cli(d, 'relay-doctor', ['--json']);
    const c = by(bad);
    assert.equal(bad.code, 3);
    assert.equal(c['claude-imports-agents'].status, 'fail');
    assert.equal(c['agents-neutral'].status, 'fail'); assert.match(c['agents-neutral'].message, /claude-sonnet-5-5/);
    assert.equal(c['agents-size'].status === 'warn' || c['agents-size'].status === 'fail', true, c['agents-size'].message);
    assert.equal(c['generated-drift'].status, 'warn'); assert.match(c['generated-drift'].message, /reviewer\.md \(edited\)/);
    assert.equal(c.labels.status, 'fail', c.labels.message); assert.match(c.labels.message, /^1 label\(s\) missing/);

    const fixed = cli(d, 'relay-doctor', ['--fix', '--json']);
    const f = by(fixed);
    assert.equal(f['claude-imports-agents'].status, 'pass'); assert.equal(f['claude-imports-agents'].fixed, true);
    assert.equal(f.labels.status, 'pass'); assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md\n/);
    assert.equal(f['agents-neutral'].status, 'fail', 'a content problem is reported, not rewritten');
  } finally { rm(d); }
});

test('doctor: secrets in tracked files fail without printing the value; worktrees inside the main checkout fail; CLI dispatcher routes scripts', () => {
  const d = repo();
  try {
    cli(d, 'relay-init', [...INIT, '--runtime', 'claude']);
    const token = 'ghp_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
    fs.writeFileSync(path.join(d, 'config.js'), `module.exports = { token: "${token}" };\n`);
    spawnSync('git', ['add', '-A'], { cwd: d });
    const r = cli(d, 'relay-doctor', ['--json']);
    const sec = r.json().checks.find((c) => c.id === 'secrets');
    assert.equal(sec.status, 'fail'); assert.match(sec.message, /config\.js/); assert.ok(!JSON.stringify(r.json()).includes(token), 'value never printed');
    fs.rmSync(path.join(d, 'config.js'));
    spawnSync('git', ['add', '-A'], { cwd: d });

    spawnSync('git', ['worktree', 'add', '-q', '-b', 'inside', path.join(d, 'wt-inside')], { cwd: d });
    const w = cli(d, 'relay-doctor', ['--json']).json().checks.find((c) => c.id === 'worktrees');
    assert.equal(w.status, 'fail'); assert.match(w.message, /inside the main checkout/);

    const via = cli(d, 'relay-workflow', ['doctor', '--json']);
    assert.ok(via.json().checks.length > 8, 'dispatcher runs the doctor');
    assert.equal(cli(d, 'relay-workflow', ['nope']).code, 3);
    assert.match(cli(d, 'relay-workflow', ['help']).stdout, /installer:\s+init\s+doctor\s+update\s+uninstall/);
  } finally { rm(d); }
});
