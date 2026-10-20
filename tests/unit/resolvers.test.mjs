import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCRIPTS } from '../helpers.mjs';
import { FIX, conflictRepo, g } from '../m4-helpers.mjs';

const MAP = path.join(FIX, 'strategy-map.json');
const read = (c, n) => fs.readFileSync(path.join(FIX, 'res', c, n), 'utf8');

function resolveCase(name) {
  const file = read(name, 'path').trim();
  const d = conflictRepo(file, { base: read(name, 'base'), ours: read(name, 'ours'), theirs: read(name, 'theirs') });
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'relay-resolve'), '--strategy-map', MAP], { cwd: d, encoding: 'utf8', env: { ...process.env, RELAY_CONFIG: '/nonexistent/workflow.yaml' } });
  return { d, file, r };
}

for (const [id, name] of [['T-RES-1', 'md'], ['T-RES-2', 'json'], ['T-RES-3', 'importmap'], ['T-RES-4', 'locales']]) {
  test(`${id}: ${name} resolver output is byte-identical to the expected fixture`, () => {
    const { d, file, r } = resolveCase(name);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`resolved: ${file.replace(/[./]/g, '\\$&')}`));
    assert.equal(fs.readFileSync(path.join(d, file), 'utf8'), read(name, 'expected'));
    assert.equal(g(d, 'diff', '--name-only', '--diff-filter=U').stdout.trim(), '', 'file staged (no longer unmerged)');
    assert.equal(g(d, 'commit', '--no-edit', '-q').status, 0, 'merge can be committed');
  });
}

test('T-RES-5: a file with no matching resolver is left untouched and exits 2', () => {
  const d = conflictRepo('src/code.js', { base: 'a\nb\n', ours: 'a\nours\n', theirs: 'a\ntheirs\n' });
  const before = fs.readFileSync(path.join(d, 'src/code.js'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'relay-resolve'), '--strategy-map', MAP], { cwd: d, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /UNRESOLVED: src\/code\.js/);
  assert.equal(fs.readFileSync(path.join(d, 'src/code.js'), 'utf8'), before);
});

test('T-RES-6: malformed JSON is reported unresolved rather than corrupted', () => {
  const d = conflictRepo('locales/en.json', { base: '{"a":1}\n', ours: '{"a":1,"b":\n', theirs: '{"a":1,"c":2}\n' });
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'relay-resolve'), '--strategy-map', MAP], { cwd: d, encoding: 'utf8' });
  assert.equal(r.status, 2);
});
