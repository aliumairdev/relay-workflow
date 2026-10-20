import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRules, loadLessons, loadProfile, profileDir, runRules } from '../../core/lib/profile.mjs';
import { REPO } from '../helpers.mjs';

const STACK = 'shopify-theme';

test('T-LESSON-1: every lint rule has a positive (bad) and a negative (good) fixture', async () => {
  const rules = await loadRules(STACK);
  assert.ok(rules.length >= 6);
  for (const r of rules) {
    const dir = path.join(profileDir(STACK), 'fixtures', r.id);
    const files = fs.readdirSync(dir);
    const bad = files.find((f) => f.startsWith('bad.')), good = files.find((f) => f.startsWith('good.'));
    assert.ok(bad && good, `${r.id}: needs bad.* and good.* fixtures`);
    const hits = r.check(fs.readFileSync(path.join(dir, bad), 'utf8'), bad);
    assert.ok(hits.length >= 1, `${r.id}: must flag its bad fixture`);
    assert.ok(hits.every((h) => h.line >= 1 && h.message), `${r.id}: findings carry line and message`);
    assert.deepEqual(r.check(fs.readFileSync(path.join(dir, good), 'utf8'), good), [], `${r.id}: must not flag its good fixture`);
  }
});

test('lessons registry: L1..L22, every lint reference exists, machine-checkable lessons name a rule', async () => {
  const lessons = loadLessons(STACK);
  assert.deepEqual(lessons.map((l) => l.id), Array.from({ length: 22 }, (_, i) => `L${i + 1}`));
  const ids = new Set((await loadRules(STACK)).map((r) => r.id));
  for (const l of lessons) {
    assert.ok(l.class && l.rule && l.form && l.evidence, `${l.id} has class, rule, form, evidence`);
    for (const ref of [].concat(l.lint || [])) assert.ok(ids.has(ref), `${l.id} references missing rule ${ref}`);
  }
  for (const id of ['liquid-capture-strip', 'block-wrapper-child-combinator', 'liquid-blank-after-filter', 'schema-range-step']) assert.ok(lessons.some((l) => [].concat(l.lint || []).includes(id)), `${id} is tied to a lesson`);
  assert.deepEqual(loadProfile(STACK).harness_gap_rules.filter((r) => !ids.has(r)), [], 'harness_gap_rules all exist');
});

test('rules find real-shaped violations when run over a tree, and stay quiet on clean files', async () => {
  const fx = path.join(profileDir(STACK), 'fixtures');
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'lint-'));
  fs.mkdirSync(path.join(tmp, 'sections')); fs.mkdirSync(path.join(tmp, 'assets')); fs.mkdirSync(path.join(tmp, 'snippets'));
  fs.copyFileSync(path.join(fx, 'schema-range-step/bad.liquid'), path.join(tmp, 'sections/range.liquid'));
  fs.copyFileSync(path.join(fx, 'schema-range-step/good.liquid'), path.join(tmp, 'sections/ok.liquid'));
  fs.copyFileSync(path.join(fx, 'block-wrapper-child-combinator/bad.css'), path.join(tmp, 'assets/base.css'));
  fs.copyFileSync(path.join(fx, 'liquid-capture-strip/good.liquid'), path.join(tmp, 'snippets/clean.liquid'));
  const v = await runRules(STACK, tmp);
  assert.ok(v.some((x) => x.rule === 'schema-range-step' && x.file === 'sections/range.liquid'));
  assert.ok(v.some((x) => x.rule === 'block-wrapper-child-combinator' && x.file === 'assets/base.css'));
  assert.ok(!v.some((x) => x.file === 'sections/ok.liquid' || x.file === 'snippets/clean.liquid'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('profile keeps platform facts out of core', () => {
  const core = ['core/briefs', 'core/scripts', 'core/lib', 'core/skills', 'core/commands', 'core/agents', 'core/templates'];
  const bad = /liquid|shopify|\.shopify-block|theme push/i;
  const hits = [];
  for (const d of core) for (const f of fs.readdirSync(path.join(REPO, d), { recursive: true })) {
    const p = path.join(REPO, d, f);
    if (!fs.statSync(p).isFile() || /(^|\/)(neutrality|profile|install)\.mjs$/.test(f)) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (bad.test(t)) hits.push(`${d}/${f}`);
  }
  assert.deepEqual(hits, [], 'platform-specific text belongs under core/profiles/');
});
