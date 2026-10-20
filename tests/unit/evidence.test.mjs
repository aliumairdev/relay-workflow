import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lint, lintHandoff, hasEvidence, claimsIn } from '../../core/lib/evidence.mjs';
import { REPO } from '../helpers.mjs';

const rules = (r) => r.map((x) => x.rule).sort();

test('T-HON-1: a PR body claiming "tests pass" without evidence or a NOT_VERIFIED section fails; with evidence it passes', () => {
  const bare = '## Outcome\nWidget added. All tests pass.\n';
  assert.deepEqual(rules(lint(bare)), ['claim-without-evidence', 'not-verified-section']);

  const withEvidence = '## Outcome\nWidget added. All tests pass.\n\n## Validation (real results)\n`npm test` → 12 pass, 0 fail\n\n## NOT_VERIFIED\nVisual check at 375px: no browser available in this environment.\n';
  assert.deepEqual(lint(withEvidence), []);

  const honest = '## Outcome\nWidget added.\n\n## NOT_VERIFIED\n- tests: not run, the sandbox has no database\n- visual check\n';
  assert.deepEqual(lint(honest), [], 'no claim, honest NOT_VERIFIED: passes');

  const noneButNoEvidence = '## Outcome\nWidget added, verified in the browser.\n\n## NOT_VERIFIED\nnone\n';
  assert.deepEqual(rules(lint(noneButNoEvidence)), ['claim-without-evidence', 'none-without-evidence']);

  const fenced = 'Verified.\n\n```\n$ npm test\n# pass 12\n```\n\n## NOT_VERIFIED\nnone\n';
  assert.deepEqual(lint(fenced), [], 'fenced command output counts as evidence');
});

test('evidence forms: result lines, exit codes, log paths, run URLs, filled Evidence section; claims inside NOT_VERIFIED or code are ignored', () => {
  for (const ok of ['npm test → ok', '12 passed', 'exit 0', 'see harness/proof/2026-10-20/abc/summary.json', 'https://github.com/o/r/actions/runs/123']) assert.ok(hasEvidence(`Tests pass. ${ok}`), ok);
  assert.ok(hasEvidence('Tests pass.\n\n## Evidence\nscreenshot taken at 375px, kept in the PR\n'), 'a filled Evidence section counts');
  assert.ok(!hasEvidence('Tests pass.\n\n## Evidence\n<paths, or N/A>\n'), 'placeholder Evidence section is not evidence');
  assert.ok(!hasEvidence('Tests pass.\n\n## Evidence\nnone\n'));
  assert.deepEqual(claimsIn('## NOT_VERIFIED\nverified in staging: not run\n'), [], 'a claim listed as NOT_VERIFIED is not a claim');
  assert.deepEqual(claimsIn('```\nverified ok\n```'), []);
});

test('the shipped PR template itself fails the lint until filled in (placeholders are not content)', () => {
  const tpl = fs.readFileSync(path.join(REPO, 'core/templates/pull_request.md'), 'utf8');
  const r = lint(tpl);
  assert.ok(r.some((x) => x.rule === 'not-verified-section' || x.rule === 'placeholder-left'), JSON.stringify(r));
});

test('handoff lint: passing tests need evidence; not_verified must be a list', () => {
  assert.deepEqual(lintHandoff({ not_verified: [], tests_run: [{ cmd: 'npm test', result: 'pass', evidence: '12 pass' }] }), []);
  assert.deepEqual(rules(lintHandoff({ not_verified: [], tests_run: [{ cmd: 'npm test', result: 'pass' }] })), ['handoff-test-without-evidence']);
  assert.deepEqual(rules(lintHandoff({ tests_run: [] })), ['handoff-not-verified']);
  assert.deepEqual(lintHandoff({ not_verified: ['x'], tests_run: [{ cmd: 'a', result: 'fail' }, { cmd: 'b', result: 'not_run' }] }), [], 'only a pass claim needs evidence');
});
