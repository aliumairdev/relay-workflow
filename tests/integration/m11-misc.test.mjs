import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from '../helpers.mjs';

test('relay-issues-create: creates issues from a plan, resolves deps, is idempotent, rejects bad plans', () => {
  const sb = makeSandbox();
  try {
    const f = path.join(sb.root, 'plan.json');
    const plan = { issues: [{ key: 'a', title: 'Foundation', body: '## Objective\nx', labels: ['state:ready', 'agent:any'] }, { key: 'b', title: 'Feature', labels: ['state:backlog', 'state:ready-for-agent'.replace('state:ready-for-agent', 'agent:codex')], deps: ['a'] }] };
    fs.writeFileSync(f, JSON.stringify(plan));
    const r = sb.run('relay-issues-create', [f, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const { numbers } = r.json();
    assert.match(sb.issue(numbers.b).body, new RegExp(`Depends on: #${numbers.a}`));
    assert.equal(sb.run('relay-issues-create', [f, '--json']).json().created.length, 0, 'idempotent by title');
    fs.writeFileSync(f, JSON.stringify({ issues: [{ key: 'x', title: 'Bad', labels: ['state:ready', 'state:done'] }] }));
    assert.equal(sb.run('relay-issues-create', [f]).code, 3);
    fs.writeFileSync(f, JSON.stringify({ issues: [{ key: 'x', title: 'Bad', deps: ['nope'] }] }));
    assert.equal(sb.run('relay-issues-create', [f]).code, 3);
  } finally { sb.cleanup(); }
});

test('relay-qa: lists the post-merge queue, renders the QA brief, marks items done', () => {
  const sb = makeSandbox();
  try {
    assert.equal(sb.run('relay-qa', ['next']).stdout.trim(), 'QA queue empty');
    fs.mkdirSync(path.join(sb.work, '.relay/qa-queue'), { recursive: true });
    fs.writeFileSync(path.join(sb.work, '.relay/qa-queue/7.json'), JSON.stringify({ pr: 7, issue: 3, branch: 'agent/x/3-y' }));
    assert.match(sb.run('relay-qa', ['list']).stdout, /#7 \(issue #3\)/);
    const n = sb.run('relay-qa', ['next']);
    assert.equal(n.code, 0, n.stderr); assert.match(n.stdout, /post-merge QA agent/); assert.match(n.stdout, /#7/); assert.match(n.stdout, /ISSUE JOURNAL/);
    assert.equal(sb.run('relay-qa', ['done', '7']).code, 0);
    assert.equal(sb.run('relay-qa', ['done', '7']).code, 3);
  } finally { sb.cleanup(); }
});
