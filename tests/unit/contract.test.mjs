import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../core/lib/contract.mjs';

const BODY = `## Objective
Admit active prospects and report them.

## Acceptance Criteria
- [ ] replan --apply admits an active experiment prospect
- [ ] all 8 experiment 87 prospects have a next step
- [ ] legacy prospects migrated and before/after reported
- [ ] list attach handles existing list members (verify in production against live data)

## Validation
- npm test
`;
const issue = (over = {}) => ({ number: 2945, title: 'Prospect admission', body: BODY, state: 'open', ...over });

test('extract: objective, acceptance, validation and runtime-proof flags; nothing is pre-satisfied', () => {
  const c = C.extract(issue(), []);
  assert.deepEqual(c.requirements.map((r) => r.id), ['OBJ1', 'AC1', 'AC2', 'AC3', 'AC4', 'T1']);
  assert.ok(c.requirements.every((r) => ['TODO'].includes(r.status)));
  assert.equal(c.requirements.find((r) => r.id === 'AC4').requires.runtime_proof, true);
  assert.equal(c.requirements.find((r) => r.id === 'T1').requires.tests, true);
  const ev = C.evaluate(c, { requireAudit: false });
  assert.equal(ev.counts.total, 5, 'the objective is derived, not counted');
  assert.equal(ev.complete, false); assert.equal(ev.closable, false);
});

test('extract: ticked boxes and closed issues are UNCHECKED history, never evidence', () => {
  const c = C.extract(issue({ body: '## Acceptance Criteria\n- [x] done already\n- [ ] not yet\n' }), []);
  assert.equal(c.bootstrap, true);
  assert.deepEqual(c.requirements.map((r) => r.status), ['UNCHECKED', 'TODO']);
  const closed = C.extract(issue({ state: 'closed' }), []);
  assert.ok(closed.requirements.every((r) => r.status === 'UNCHECKED'));
  assert.equal(C.evaluate(closed, { requireAudit: false }).closable, false);
});

test('extract: an issue with no parseable requirements still has a (title-derived) contract', () => {
  const c = C.extract(issue({ body: 'please fix it', title: 'Fix the thing' }), []);
  assert.equal(c.requirements.length, 1);
  assert.equal(c.requirements[0].text, 'Fix the thing');
});

test('comments that explicitly amend acceptance add requirements; ordinary and machine comments do not', () => {
  const comments = [
    { id: 1, body: 'looks good, thanks' },
    { id: 2, body: '<!-- relay:claim {"x":1} -->\nUpdated acceptance:\n- sneaky' },
    { id: 3, body: '## Updated acceptance\n- [ ] also handle prospects without a list\n- [ ] report the count' },
    { id: 4, body: 'Acceptance: the CLI prints before/after counts' },
  ];
  const c = C.extract(issue(), comments);
  const texts = c.requirements.map((r) => r.text);
  assert.ok(texts.includes('also handle prospects without a list') && texts.includes('report the count') && texts.includes('the CLI prints before/after counts'));
  assert.ok(!texts.includes('sneaky'));
  assert.equal(c.requirements.find((r) => r.text === 'report the count').origin, 'comment:3');
});

test('drift: edited body/comments are detected; update adds new requirements and flags vanished ones without dropping them', () => {
  const c0 = C.extract(issue(), []);
  const body2 = BODY.replace('- [ ] legacy prospects migrated and before/after reported\n', '') + '\n- [ ] brand new acceptance\n';
  const edited = issue({ body: BODY.replace('## Validation', '- [ ] brand new acceptance\n\n## Validation') });
  assert.equal(C.hasDrifted(c0, issue(), []), false);
  assert.equal(C.hasDrifted(c0, edited, []), true);
  const { contract, added, vanished } = C.update(c0, edited, []);
  assert.equal(added.length, 1);
  assert.equal(contract.requirements.find((r) => r.id === added[0]).status, 'TODO');
  assert.deepEqual(vanished, []);
  const gone = C.update(c0, issue({ body: body2 }), []);
  assert.ok(gone.vanished.includes('AC3'), 'AC3 vanished from the text');
  assert.ok(gone.contract.requirements.find((r) => r.id === 'AC3'), 'but it is still in the contract');
  const ev = C.evaluate(gone.contract, { requireAudit: false });
  assert.ok(ev.problems.some((p) => p.code === 'DRIFT_VANISHED'));
});

test('mark: PASS needs evidence; tests and runtime proof are enforced per requirement', () => {
  let c = C.extract(issue(), []);
  assert.throws(() => C.mark(c, 'AC1', 'PASS', {}), /no evidence/);
  c = C.mark(c, 'AC1', 'PASS', { evidence: C.parseEvidence(['test:npm test → 4 pass']) });
  assert.equal(c.requirements.find((r) => r.id === 'AC1').status, 'PASS');
  // AC4 requires runtime proof: tests alone are TESTS_ONLY, never PASS
  assert.throws(() => C.mark(c, 'AC4', 'PASS', { evidence: C.parseEvidence(['test:npm test → 4 pass']) }), /runtime proof is missing.*TESTS_ONLY/);
  const t = C.mark(c, 'AC4', 'TESTS_ONLY', { evidence: C.parseEvidence(['test:npm test → 4 pass']) });
  assert.equal(C.evaluate(t, { requireAudit: false }).closable, false);
  const done = C.mark(t, 'AC4', 'PASS', { evidence: C.parseEvidence(['runtime:harness/proof/2026-10-20/main/summary.json 3/3 pass']) });
  assert.equal(done.requirements.find((r) => r.id === 'AC4').status, 'PASS');
  // T1 requires test evidence
  assert.throws(() => C.mark(c, 'T1', 'PASS', { evidence: C.parseEvidence(['manual:looked fine']) }), /required tests lack evidence/);
});

test('mark: follow-ups, deferrals and "works now, not sure why" are not dispositions', () => {
  const c = C.extract(issue(), []);
  const ev = C.parseEvidence(['manual:opened #9999']);
  assert.throws(() => C.mark(c, 'AC3', 'VALID_TERMINAL_DISPOSITION', { evidence: ev, note: 'moved to #9999 as a follow-up', cite: 'the issue says it may end without implementation' }), /follow-up/);
  assert.throws(() => C.mark(c, 'AC3', 'PASS', { evidence: ev, note: 'tracked in #9999' }), /follow-up/);
  assert.throws(() => C.mark(c, 'AC3', 'PASS', { evidence: C.parseEvidence(['test:t → pass']), note: 'works now, not sure why' }), /not proof: classify/);
  const ok = C.mark(c, 'AC3', 'PASS', { evidence: C.parseEvidence(['test:t → pass']), note: 'works now, not sure why', classification: 'independently_recovered' });
  assert.equal(ok.requirements.find((r) => r.id === 'AC3').classification, 'independently_recovered');
  assert.throws(() => C.mark(c, 'AC3', 'PASS', { evidence: C.parseEvidence(['test:t → pass']), classification: 'unexplained' }), /unexplained/);
  assert.throws(() => C.mark(c, 'AC3', 'EXPLICITLY_REMOVED_FROM_SCOPE', {}), /only by `relay-contract descope`/);
});

test('mark: reproduction cases need a classification; VALID_TERMINAL_DISPOSITION must be allowed by the issue text', () => {
  const body = '## Reproduction\n- prospect 123 never gets a next action\n\n## Acceptance Criteria\n- [ ] if the list is already attached the run may end without changes\n';
  const c = C.extract(issue({ body }), []);
  const repro = c.requirements.find((r) => r.kind === 'repro').id;
  assert.throws(() => C.mark(c, repro, 'PASS', { evidence: C.parseEvidence(['test:t → pass']) }), /needs a classification/);
  assert.throws(() => C.mark(c, repro, 'FIXED_AND_VERIFIED', { evidence: C.parseEvidence(['test:t → pass', 'pr:merged PR #4']), classification: 'independently_recovered' }), /fixed_by_change/);
  const fixed = C.mark(c, repro, 'FIXED_AND_VERIFIED', { evidence: C.parseEvidence(['test:t → pass', 'pr:merged PR #4']), classification: 'fixed_by_change' });
  assert.equal(fixed.requirements.find((r) => r.id === repro).status, 'FIXED_AND_VERIFIED');
  const ac = c.requirements.find((r) => r.kind === 'acceptance').id;
  assert.throws(() => C.mark(c, ac, 'VALID_TERMINAL_DISPOSITION', { evidence: C.parseEvidence(['runtime:log']), cite: 'we decided it is fine' , sourceText: body }), /does not appear in the issue/);
  const t = C.mark(c, ac, 'VALID_TERMINAL_DISPOSITION', { evidence: C.parseEvidence(['runtime:log shows list already attached']), cite: 'the run may end without changes', sourceText: body });
  assert.equal(t.requirements.find((r) => r.id === ac).status, 'VALID_TERMINAL_DISPOSITION');
});

test('external blockers: need an exact blocker; they park a requirement but never close the issue', () => {
  let c = C.extract(issue({ body: '## Acceptance Criteria\n- [ ] one\n- [ ] two\n' }), []);
  assert.throws(() => C.mark(c, 'AC1', 'EXTERNALLY_BLOCKED', { blocker: 'hmm' }), /exact blocker/);
  c = C.mark(c, 'AC1', 'EXTERNALLY_BLOCKED', { blocker: 'human LinkedIn verification required', needs: 'owner completes the verification' });
  let ev = C.evaluate(c, { requireAudit: false });
  assert.equal(ev.actionable, true, 'AC2 is still workable: keep going'); assert.equal(ev.next, 'implement');
  c = C.mark(c, 'AC2', 'PASS', { evidence: C.parseEvidence(['test:t → pass']) });
  ev = C.evaluate(c, { requireAudit: false });
  assert.equal(ev.actionable, false); assert.equal(ev.next, 'wait_external');
  assert.equal(ev.complete, false); assert.equal(ev.closable, false, 'waiting is allowed; completing is not');
  assert.equal(C.contractState(c, { ghState: 'open', labels: ['state:blocked'] }), 'BLOCKED_EXTERNAL');
});

test('descope is explicit and carries a reference; GitHub-closed with an incomplete contract is its own state', () => {
  let c = C.extract(issue({ body: '## Acceptance Criteria\n- [ ] one\n- [ ] two\n' }), []);
  assert.throws(() => C.descope(c, ['AC2'], { reason: 'owner said so' }), /--ref/);
  c = C.mark(c, 'AC1', 'PASS', { evidence: C.parseEvidence(['test:t → pass']) });
  c = C.descope(c, ['AC2'], { ref: 'comment:7', reason: 'owner dropped it', by: 'owner' });
  assert.equal(c.scope_changes[0].ref, 'comment:7');
  assert.equal(C.evaluate(c, { requireAudit: false }).complete, true);
  const open = C.extract(issue(), []);
  assert.equal(C.contractState(open, { ghState: 'closed', labels: [] }), 'GITHUB_CLOSED_CONTRACT_INCOMPLETE');
});

test('closure needs the final audit of the current revision; any later change invalidates it', () => {
  let c = C.extract(issue({ body: '## Acceptance Criteria\n- [ ] one\n' }), []);
  c = C.mark(c, 'AC1', 'PASS', { evidence: C.parseEvidence(['test:t → pass']) });
  let ev = C.evaluate(c);
  assert.equal(ev.closable, false); assert.ok(ev.problems.some((p) => p.code === 'AUDIT_NOT_RUN')); assert.equal(ev.next, 'audit');
  c = C.setAudit(c, { by: 'agent-1' });
  assert.equal(C.evaluate(c).closable, true);
  c = C.addRequirement(c, 'a late requirement');
  ev = C.evaluate(c);
  assert.equal(ev.closable, false); assert.equal(ev.unresolved[0].id, 'M1');
});

test('merged PR slices: coverage is recorded, unresolved stays unresolved, QA pending/failed blocks closure', () => {
  let c = C.extract(issue({ body: '## Acceptance Criteria\n- [ ] one\n- [ ] two\n' }), []);
  c = C.recordMergedPR(c, { pr: 5, coverage: { AC1: 'implemented', AC2: 'not_covered' }, completes_issue: false, qa: 'pending' });
  assert.equal(c.requirements.find((r) => r.id === 'AC1').status, 'MERGED_NOT_VERIFIED');
  assert.equal(c.requirements.find((r) => r.id === 'AC2').status, 'TODO');
  assert.equal(C.contractState(c, { ghState: 'open', labels: ['state:ready'] }), 'MERGED_AWAITING_PROOF');
  c = C.mark(c, 'AC1', 'PASS', { evidence: C.parseEvidence(['runtime:log']) });
  c = C.mark(c, 'AC2', 'PASS', { evidence: C.parseEvidence(['runtime:log']) });
  c = C.setAudit(c, { by: 'x' });
  assert.ok(C.evaluate(c).problems.some((p) => p.code === 'QA_PENDING'));
  assert.equal(C.evaluate(c).closable, false);
  c = C.setQA(c, 5, 'fail');
  assert.ok(C.evaluate(c).problems.some((p) => p.code === 'QA_FAILED'));
  c = C.setQA(c, 5, 'pass');
  c = C.setAudit(c, { by: 'x' });
  assert.equal(C.evaluate(c).closable, true);
});

test('next action: pending QA is work (prove), a failed QA is implementation, only external waits may stop', () => {
  let c = C.extract(issue({ body: '## Acceptance Criteria\n- [ ] one\n- [ ] two\n' }), []);
  c = C.recordMergedPR(c, { pr: 5, coverage: { AC1: 'implemented', AC2: 'implemented' }, qa: 'pending' });
  let ev = C.evaluate(c, { requireAudit: false });
  assert.equal(ev.next, 'prove'); assert.equal(ev.actionable, true);
  c = C.mark(C.mark(c, 'AC1', 'PASS', { evidence: C.parseEvidence(['runtime:log']) }), 'AC2', 'PASS', { evidence: C.parseEvidence(['runtime:log']) });
  ev = C.evaluate(c, { requireAudit: false });
  assert.equal(ev.complete, false, 'QA still pending'); assert.equal(ev.next, 'prove'); assert.equal(ev.actionable, true);
  c = C.setQA(c, 5, 'fail');
  assert.equal(C.evaluate(c, { requireAudit: false }).next, 'implement');
  c = C.setQA(c, 5, 'pass');
  ev = C.evaluate(c, { requireAudit: false });
  assert.equal(ev.closable, true); assert.equal(ev.next, 'close');
  assert.equal(C.evaluate(c).next, 'audit', 'complete but the final acceptance audit has not run');
});

test('PR coverage lint: every unresolved requirement is listed, completion claims are truthful, scope is not moved', () => {
  const c = C.extract(issue({ body: '## Acceptance Criteria\n- [ ] one\n- [ ] two\n- [ ] three\n' }), []);
  const good = '## Contract Coverage\nIssue: #2945\n- AC1: implemented\n- AC2: not covered by this PR\n- AC3: not covered by this PR\n\nIssue completion: NO — additional accepted requirements remain.\n';
  assert.deepEqual(C.lintPR(good, c), []);
  assert.equal(C.lintPR('Closes #2945', c)[0].rule, 'coverage-missing');
  const liar = good.replace('NO — additional', 'YES — nothing').replace('additional accepted requirements remain.', '');
  assert.ok(C.lintPR(liar, c).some((f) => f.rule === 'false-completion'));
  const partial = '## Contract Coverage\n- AC1: implemented\n\nIssue completion: NO\n';
  assert.ok(C.lintPR(partial, c).some((f) => f.rule === 'coverage-incomplete'));
  const escape = good.replace('- AC3: not covered by this PR', '- AC3: not covered, tracked in a follow-up issue');
  assert.ok(C.lintPR(escape, c).some((f) => f.rule === 'scope-escape'));
  assert.ok(C.lintPR(good.replace('Issue completion', '- AC9: implemented\nIssue completion'), c).some((f) => f.rule === 'coverage-unknown-id'));
});

test('owner decisions: only the allowed categories, with every field; permission-to-continue questions are rejected', () => {
  const ok = { question: 'Should prospects without a company be discarded or kept as leads?', options: ['discard', 'keep'], default: 'keep', category: 'product-ambiguity', contract_gap: 'The issue says "handle prospects without a company" but not whether they are kept; both are valid outcomes', evidence: 'queried 14 such prospects in dev; sales workflow differs by choice', unsafe_because: 'discarding deletes customer data; keeping changes the funnel counts' };
  assert.deepEqual(C.decisionProblems(ok), []);
  const bad = C.decisionProblems({ question: 'Should I continue with AC3 or open a follow-up issue?', options: ['continue', 'follow-up'], default: 'continue' });
  assert.ok(bad.length >= 5);
  assert.ok(bad.some((p) => /permission to continue|follow-up/.test(p)));
  assert.ok(C.decisionProblems({ ...ok, category: 'technical' }).some((p) => /--category/.test(p)));
  assert.ok(C.decisionProblems({ ...ok, question: 'Which library should we use for date parsing, luxon or dayjs?' }).some((p) => /technical implementation/.test(p)));
  assert.ok(C.decisionProblems({ ...ok, contract_gap: 'n/a' }).some((p) => /contract does not already answer/.test(p)));
  assert.ok(C.decisionProblems({ ...ok, default: 'maybe' }).some((p) => /--default must be one of/.test(p)));
});

test('schema: every persisted contract validates; unsupported versions are refused', async () => {
  const { validateAgainst } = await import('../../core/lib/schema.mjs');
  const c = C.extract(issue(), []);
  assert.deepEqual(validateAgainst('contract', c).errors, []);
  assert.equal(validateAgainst('contract', { ...c, schema_version: 2 }).ok, false);
  assert.equal(validateAgainst('contract', { ...c, requirements: [{ ...c.requirements[0], status: 'DONE' }] }).ok, false);
});
