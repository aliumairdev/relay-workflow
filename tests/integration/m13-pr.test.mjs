import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue, prsOf } from '../helpers.mjs';

test('relay-pr open: opens the PR through the control plane, enforces Closes #N and the evidence lint, is idempotent; handoff to a disabled runtime is refused', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 'Open me', body: '## Owned Paths\nsrc/**\n', labels: ['state:ready', 'agent:claude'] });
    sb.run('relay-claim', [String(n), '--agent', 'c1', '--runtime', 'claude']);
    const wt = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']).json().path;
    fs.writeFileSync(path.join(wt, 'src/x.mjs'), 'export const x = 1;\n'); sb.git(['add', '-A'], wt); sb.git(['commit', '-qm', 'feat: x'], wt);

    assert.equal(sb.run('relay-pr', ['open'], { cwd: wt }).code, 3, 'a body is required');
    assert.equal(sb.run('relay-pr', ['open', '--body', 'All tests pass.'], { cwd: wt }).code, 3, 'needs Closes #N');
    const lintFail = sb.run('relay-pr', ['open', '--body', `Closes #${n}\nAll tests pass.`], { cwd: wt });
    assert.equal(lintFail.code, 3); assert.match(lintFail.stderr, /evidence lint/);
    assert.equal(sb.run('relay-pr', ['open', '--body', `Closes #${n}`], { cwd: sb.work }).code, 7, 'refuses on the default branch');

    const body = `Closes #${n}\n\n## Validation (real results)\n\`npm test\` → 1 pass\n\n## NOT_VERIFIED\nvisual check: no browser\n`;
    const r = sb.run('relay-pr', ['open', '--body', body, '--json'], { cwd: wt });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(prsOf(sb).length, 1); assert.equal(prsOf(sb)[0].title, 'Open me'); assert.match(prsOf(sb)[0].body, new RegExp(`Closes #${n}`));
    assert.equal(sb.run('relay-pr', ['open', '--body', body, '--json'], { cwd: wt }).json().existing, true, 'idempotent');
    assert.equal(prsOf(sb).length, 1);

    sb.patchConfig((t) => t.replace('codex: { enabled: true,', 'codex: { enabled: false,'));
    const h = sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'capability'], { cwd: wt });
    assert.equal(h.code, 3); assert.match(h.stderr, /not enabled in workflow\.yaml/);
  } finally { sb.cleanup(); }
});
