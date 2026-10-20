import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSandbox, seedIssue } from '../helpers.mjs';
import { GitHub } from '../../core/adapters/control-plane/github.mjs';

test('M0: sandbox creates and tears down in under 20s', () => {
  const t0 = Date.now();
  const sb = makeSandbox();
  assert.ok(fs.existsSync(`${sb.work}/workflow.yaml`));
  assert.equal(sb.git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main');
  sb.cleanup();
  assert.ok(Date.now() - t0 < 20000);
  assert.ok(!fs.existsSync(sb.root));
});

test('M0: fake gh round-trips an issue with labels and comments via the adapter', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'hello', labels: ['state:ready', 'agent:codex'] });
    const gh = new GitHub({ repo: 'local/sandbox', gh: sb.env.RELAY_GH });
    process.env.RELAY_FAKE_GH_DB = sb.env.RELAY_FAKE_GH_DB;
    const issue = gh.getIssue(n);
    assert.deepEqual(issue.labels.sort(), ['agent:codex', 'state:ready']);
    const c1 = gh.comment(n, 'first'); const c2 = gh.comment(n, 'second');
    assert.ok(c1.created_at < c2.created_at, 'deterministic increasing timestamps');
    assert.deepEqual(gh.listComments(n).map((c) => c.body), ['first', 'second']);
    gh.removeLabel(n, 'state:ready'); gh.addLabels(n, ['state:claimed']);
    assert.deepEqual(gh.getIssue(n).labels.sort(), ['agent:codex', 'state:claimed']);
    assert.equal(gh.removeLabel(n, 'nope'), false);
    assert.equal(gh.listIssues({ labels: ['state:claimed'] }).length, 1);
    gh.closeIssue(n);
    assert.equal(gh.listIssues().length, 0);
  } finally { sb.cleanup(); }
});
