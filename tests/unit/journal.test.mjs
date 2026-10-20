import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendEntry, readLog, findLog, MAX_TEXT } from '../../core/lib/journal.mjs';

// In-memory control plane: just the comment calls journal.mjs uses.
function memCp() {
  const comments = []; let id = 0;
  return { comments, listComments: () => comments, comment: (n, body) => { comments.push({ id: ++id, body }); return { id }; }, editComment: (cid, body) => { comments.find((c) => c.id === cid).body = body; } };
}

test('very long logs stay under the platform comment limit without dropping entries', () => {
  const cp = memCp();
  for (let i = 0; i < 80; i++) appendEntry(cp, 5, { kind: 'progress', text: `step ${i} ` + 'z'.repeat(MAX_TEXT - 20), agent_id: 'a' });
  assert.equal(cp.comments.length, 1);
  assert.ok(cp.comments[0].body.length < 65000, `${cp.comments[0].body.length}`);
  const log = readLog(cp, 5);
  assert.equal(log.entries.length, 80);
  assert.equal(log.entries.at(-1).text.length >= MAX_TEXT - 30, true, 'newest entries keep full text');
  assert.ok(log.entries[0].text.length <= 61, 'oldest entries compacted');
  assert.deepEqual(log.entries.map((e) => e.n), Array.from({ length: 80 }, (_, i) => i + 1));
});

test('a second writer appends to the existing comment instead of creating another', () => {
  const cp = memCp();
  appendEntry(cp, 1, { kind: 'plan', text: 'p', agent_id: 'a' });
  appendEntry(cp, 1, { kind: 'summary', text: 's', agent_id: 'b' });
  assert.equal(cp.comments.length, 1);
  assert.equal(findLog(cp.comments).log.entries.length, 2);
});
