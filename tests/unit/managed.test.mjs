import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertBlock, removeBlock, findBlock, mergeJson, revertJson, wrap } from '../../core/lib/managed.mjs';

const ORIGINALS = ['', '# Mine\n', '# Mine\nno trailing newline', '# Mine\n\n\nmany blank lines\n\n', 'x\n\n'];

test('insert then remove restores the original bytes exactly (all trailing-newline shapes)', () => {
  for (const orig of ORIGINALS) {
    const ins = upsertBlock(orig === '' ? null : orig, 'agents', 'hello\nworld');
    assert.ok(findBlock(ins.text, 'agents'));
    const rm = removeBlock(ins.text, 'agents', 'html', ins.prefix);
    assert.equal(rm.text, orig, JSON.stringify(orig));
  }
});

test('upsert replaces only the block; surrounding user content is preserved byte for byte', () => {
  const user = 'before\n\n';
  const a = upsertBlock(user + 'after\n', 'agents', 'v1');
  const withBlock = user + wrap('agents', 'v1') + 'after\n';
  const b = upsertBlock(withBlock, 'agents', 'v2');
  assert.equal(b.text, user + wrap('agents', 'v2') + 'after\n');
  assert.equal(upsertBlock(b.text, 'agents', 'v2').changed, false, 'idempotent');
  assert.ok(a.text.startsWith(user + 'after\n'));
});

test('hash-style blocks (gitignore) and independent block names', () => {
  const t1 = upsertBlock('node_modules/\n', 'ignore', '.relay/*\n!.relay/lock.json', 'hash');
  assert.match(t1.text, /# relay:begin ignore\n\.relay\/\*\n!\.relay\/lock\.json\n# relay:end ignore\n$/);
  const t2 = upsertBlock(t1.text, 'agents', 'x');
  assert.ok(findBlock(t2.text, 'ignore', 'hash') && findBlock(t2.text, 'agents'));
  assert.equal(removeBlock(removeBlock(t2.text, 'agents', 'html', t2.prefix).text, 'ignore', 'hash', t1.prefix).text, 'node_modules/\n');
});

test('JSON merge records exactly what changed and reverts to the original', () => {
  const orig = { permissions: { allow: ['Bash(ls)'] }, env: { KEEP: '1' } };
  const { value, record } = mergeJson(orig, { env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium', KEEP: '2' }, relay: { version: '0.1.0' } });
  assert.equal(value.env.KEEP, '2'); assert.equal(value.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium'); assert.equal(value.relay.version, '0.1.0');
  assert.deepEqual(value.permissions, orig.permissions, 'unrelated keys untouched');
  assert.deepEqual(revertJson(value, record), orig);
  assert.deepEqual(mergeJson(value, { env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } }).record, [], 'merging the same value records nothing');
  assert.deepEqual(revertJson(mergeJson({}, { a: { b: { c: 1 } } }).value, mergeJson({}, { a: { b: { c: 1 } } }).record), {});
});
