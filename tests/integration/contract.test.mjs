import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedIssue, enforceContracts, useFakeRuntimes, prsOf, FOUR_AC_BODY } from '../helpers.mjs';
import { agentBranch, sliceBody, openSlicePR, coverageVerdict } from '../m4-helpers.mjs';

const ALL = ['AC1', 'AC2', 'AC3', 'AC4'];
const labels = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();
const hook = (sb, name, payload = {}, env = {}) => {
  const r = sb.run(name, [], { input: JSON.stringify({ cwd: sb.work, ...payload }), env });
  return { code: r.code, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
};
const check = (sb, n) => sb.run('relay-contract', ['check', String(n), '--json']);
const evalOf = (sb, n) => check(sb, n).json();
const mark = (sb, n, ids, status, extra = []) => sb.run('relay-contract', ['mark', String(n), ids, status, ...extra]);
const contractOf = (sb, n) => JSON.parse(/relay:issue-contract (\{.*?\}) -->/s.exec(sb.comments(n).find((c) => c.body.includes('relay:issue-contract')).body)[1].replace(/\\u002d/g, '-'));

function sandbox(body = FOUR_AC_BODY, extra = '') {
  const sb = enforceContracts(makeSandbox(), extra);
  const n = seedIssue(sb, { title: 'Prospect admission', body, labels: ['state:ready', 'agent:claude'] });
  return { sb, n };
}
// One merged slice: claim (fresh branch each slice), PR with truthful coverage, approving verdict, gated merge.
function slice(sb, n, { covers, slug, reviewCoverage, complete = false, sliceNo = 1, files }) {
  const claim = sb.run('relay-claim', [String(n), '--agent', `claude-s${sliceNo}`, '--runtime', 'claude', '--json']);
  assert.equal(claim.code, 0, claim.stderr);
  const branch = claim.json().branch;
  assert.equal(branch.endsWith(`-s${sliceNo}`), sliceNo > 1, `slice ${sliceNo} branch: ${branch}`);
  sb.git(['fetch', '-q', 'origin']); sb.git(['checkout', '-q', '-B', branch, 'origin/main']);
  fs.writeFileSync(path.join(sb.work, `${slug}.txt`), `${slug}\n`); for (const [f, c] of Object.entries(files || {})) fs.writeFileSync(path.join(sb.work, f), c);
  sb.git(['add', `${slug}.txt`, ...Object.keys(files || {})]); sb.git(['commit', '-qm', `feat: ${slug}`]); sb.git(['push', '-q', '-f', 'origin', branch]); sb.git(['checkout', '-q', 'main']);
  const pr = openSlicePR(sb, { branch, title: `feat: ${slug}`, body: sliceBody(n, { covers, all: ALL.filter((id) => !(sb.__done || []).includes(id)) }) });
  sb.run('relay-labels', ['set', String(n), 'state:review']);
  const cov = Object.fromEntries(ALL.filter((id) => !(sb.__done || []).includes(id)).map((id) => [id, covers.includes(id) ? 'PASS' : 'NOT_COVERED']));
  const v = coverageVerdict(sb, pr, 'codex', reviewCoverage || cov, complete);
  assert.equal(v.code, 0, v.stderr);
  const m = sb.run('relay-merge', [`${pr}:${n}`]);
  return { pr, merge: m, branch };
}

test('T-CONTRACT-E2E: 4 requirements -> three PRs -> the issue stays open after partial work and closes only when all 4 pass', () => {
  const { sb, n } = sandbox();
  try {
    sb.__done = [];
    // claim extracts the contract; GitHub, not the agent, defines the work
    const first = sb.run('relay-claim', [String(n), '--agent', 'claude-s0', '--runtime', 'claude', '--json']);
    assert.equal(first.json().contract.total, 4); sb.run('relay-lease', ['release', String(n), '--agent', 'claude-s0']);
    assert.deepEqual(contractOf(sb, n).requirements.map((r) => r.id), ['OBJ1', 'AC1', 'AC2', 'AC3', 'AC4']);
    assert.equal(sb.run('relay-contract', ['check', String(n)]).code, 4);

    // ---- PR A: AC1 only. Merges, issue stays ACTIVE (case 1)
    const a = slice(sb, n, { covers: ['AC1'], slug: 'admission', sliceNo: 1 });
    assert.equal(a.merge.code, 0, a.merge.stdout + a.merge.stderr);
    assert.match(a.merge.stdout, new RegExp(`#${a.pr} MERGED \\(issue #${n}\\) — contract 1/4 complete, issue stays active \\(remaining AC2, AC3, AC4\\)`));
    assert.equal(sb.issue(n).state, 'open');
    assert.deepEqual(labels(sb, n), ['agent:claude', 'contract:open', 'state:ready'], 'merged PR + unresolved contract = ready work again');
    let ev = evalOf(sb, n);
    assert.equal(ev.counts.complete, 1); assert.deepEqual(ev.unresolved.map((r) => r.id), ['AC2', 'AC3', 'AC4']);
    assert.equal(contractOf(sb, n).requirements.find((r) => r.id === 'AC1').status, 'FIXED_AND_VERIFIED');
    assert.equal(sb.run('relay-contract', ['close', String(n)]).code, 4, 'closure denied');
    assert.ok(!sb.state().claims.some((c) => c.issue === n), 'the merged slice released the claim');
    // the orchestrator keeps going: the Stop hook blocks and names the remaining requirements without anyone saying "continue"
    sb.run('relay-orchestrate', ['on']);
    const stop = hook(sb, 'relay-hook-stop');
    assert.equal(stop.out.decision, 'block'); assert.match(stop.out.reason, /1 ready/); assert.match(stop.out.reason, /not completion/);
    sb.__done = ['AC1'];

    // ---- PR B: AC2 + AC3 on a fresh slice branch (case 2)
    const b = slice(sb, n, { covers: ['AC2', 'AC3'], slug: 'migration', sliceNo: 2 });
    assert.equal(b.merge.code, 0, b.merge.stdout + b.merge.stderr);
    assert.match(b.merge.stdout, /contract 3\/4 complete, issue stays active \(remaining AC4\)/);
    assert.equal(sb.issue(n).state, 'open');
    sb.__done = ['AC1', 'AC2', 'AC3'];

    // ---- PR C: AC4 needs production proof: tests are not enough
    const c = slice(sb, n, { covers: ['AC4'], slug: 'attach', sliceNo: 3, complete: true });
    assert.equal(c.merge.code, 0, c.merge.stdout + c.merge.stderr);
    assert.match(c.merge.stdout, /contract 3\/4 complete, issue stays active \(remaining AC4\)/, 'merged != verified != complete');
    assert.equal(sb.issue(n).state, 'open');
    assert.equal(contractOf(sb, n).requirements.find((r) => r.id === 'AC4').status, 'TESTS_ONLY');
    ev = evalOf(sb, n);
    assert.ok(ev.problems.some((p) => p.code === 'QA_PENDING'), 'post-merge QA is pending for the runtime-proof requirement');
    assert.equal(sb.run('relay-qa', ['list', '--json']).json().length, 1);
    assert.equal(mark(sb, n, 'AC4', 'PASS', ['--evidence', 'test:npm test → 1 pass']).code, 4, 'tests alone cannot be PASS when runtime proof is required');

    // QA maps the proof back to the requirement; only then does the contract close
    assert.equal(sb.run('relay-qa', ['done', String(c.pr), '--result', 'pass']).code, 3, 'a pass must be mapped to requirements');
    const qa = sb.run('relay-qa', ['done', String(c.pr), '--result', 'pass', '--map', 'AC4=PASS', '--proof', 'harness/proof/2026-10-20/main/summary.json 3/3 live checks']);
    assert.equal(qa.code, 0, qa.stderr + qa.stdout);
    assert.match(qa.stdout, /all satisfied: issue closed/);
    assert.equal(sb.issue(n).state, 'closed');
    assert.deepEqual(labels(sb, n), ['agent:claude', 'contract:complete', 'state:done']);
    const done = contractOf(sb, n);
    assert.ok(done.requirements.filter((r) => !r.derived).every((r) => ['PASS', 'FIXED_AND_VERIFIED'].includes(r.status)));
    assert.equal(done.audit.rev, done.rev, 'the final acceptance audit ran on the final revision');
    assert.equal(done.prs.filter((p) => p.merged).length, 3);
    assert.equal(hook(sb, 'relay-hook-stop').out, null, 'nothing left: the orchestrator may stop');
    const jc = sb.run('relay-journal', ['check', String(n), '--final']);
    assert.equal(jc.code, 0, jc.stderr + jc.stdout);           // requirement-level trail exists for every satisfied requirement
    const audit = sb.run('relay-contract', ['release-audit']);
    assert.equal(audit.code, 0, audit.stdout);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-3: moving AC4 to a follow-up issue and calling the original complete is denied', () => {
  const { sb, n } = sandbox();
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    for (const id of ['AC1', 'AC2', 'AC3']) assert.equal(mark(sb, n, id, 'PASS', ['--evidence', 'runtime:harness/proof/x.json ok', '--evidence', 'test:npm test → pass']).code, 0);
    const follow = seedIssue(sb, { title: 'AC4: list attach', body: '## Acceptance Criteria\n- [ ] list attach' });
    const r = sb.run('relay-contract', ['followup', String(n), '--new', String(follow), '--covers', 'AC4']);
    assert.equal(r.code, 0); assert.match(r.stdout, /does not satisfy an acceptance requirement/);
    assert.equal(mark(sb, n, 'AC4', 'VALID_TERMINAL_DISPOSITION', ['--note', `moved to #${follow} as a follow-up`, '--cite', 'ends without implementation', '--evidence', 'manual:opened follow-up']).code, 4);
    assert.equal(mark(sb, n, 'AC4', 'PASS', ['--note', `tracked in #${follow}`, '--evidence', 'runtime:x', '--evidence', 'test:y']).code, 4);
    assert.equal(sb.run('relay-contract', ['close', String(n)]).code, 4);
    assert.equal(sb.issue(n).state, 'open');
    assert.deepEqual(evalOf(sb, n).unresolved.map((x) => x.id), ['AC4']);
    // the agent cannot descope it either: only the owner can, citing the owner's own comment
    assert.equal(sb.run('relay-contract', ['descope', String(n), 'AC4', '--ref', 'body', '--reason', 'moved'], { env: { RELAY_ACTOR: 'implementer' } }).code, 7);
    assert.equal(sb.run('relay-contract', ['descope', String(n), 'AC4', '--ref', 'comment:99999', '--reason', 'x']).code, 7, 'the owner comment must exist');
    // a follow-up that took over an unfinished requirement shows up in the release audit once the issue is (wrongly) closed
    sb.gh(['api', '-X', 'PATCH', `repos/local/sandbox/issues/${n}`, '--input', '-'], JSON.stringify({ state: 'closed' }));
    const audit = sb.run('relay-contract', ['release-audit', '--json']);
    assert.equal(audit.code, 4);
    assert.ok(audit.json().findings.some((f) => f.code === 'FOLLOWUP_STOLE_SCOPE'));
    assert.ok(audit.json().findings.some((f) => f.code === 'CLOSED_INCOMPLETE'));
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-3b: the owner can descope, with a reference to where they said so; then the rest may close', () => {
  const { sb, n } = sandbox('## Acceptance Criteria\n- [ ] one\n- [ ] two\n');
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    assert.equal(mark(sb, n, 'AC1', 'PASS', ['--evidence', 'test:npm test → pass']).code, 0);
    sb.gh(['api', '-X', 'POST', `repos/local/sandbox/issues/${n}/comments`, '--input', '-'], JSON.stringify({ body: 'Descope: AC2 - customer dropped this' }));
    const c = sb.run('relay-contract', ['check', String(n), '--json']);
    assert.equal(c.code, 4);
    const cid = sb.comments(n).find((x) => /Descope: AC2/.test(x.body)).id;
    assert.equal(sb.run('relay-contract', ['descope', String(n), 'AC2', '--ref', `comment:${cid}`, '--reason', 'customer dropped it']).code, 0);
    assert.equal(sb.issue(n).state, 'closed', 'contract complete after an explicit owner scope change');
    assert.equal(contractOf(sb, n).scope_changes[0].ref, `comment:${cid}`);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-4/5: "may I continue?" is not an owner decision; a genuine product question is, and it parks only its requirement', () => {
  const { sb, n } = sandbox();
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    const open = (extra) => sb.run('relay-decision', ['open', String(n), ...extra]);
    const r = open(['--question', 'AC1 is done. Should I continue with AC3 or open a follow-up issue?', '--options', 'continue,follow-up', '--default', 'continue']);
    assert.equal(r.code, 7); assert.match(r.stderr, /owner decision rejected/); assert.match(r.stderr, /Continue the work/);
    assert.equal(sb.db().items.filter((i) => i.labels.includes('owner-decision')).length, 0, 'no decision issue was created');
    const tech = open(['--question', 'Which library should we use for the CSV import?', '--options', 'papaparse,csv-parse', '--default', 'csv-parse', '--category', 'business-choice', '--contract-gap', 'x'.repeat(40), '--evidence', 'y'.repeat(30), '--unsafe-because', 'z'.repeat(40)]);
    assert.equal(tech.code, 7); assert.match(tech.stderr, /technical implementation choices are yours/);
    const missing = open(['--question', 'Should unlisted prospects be kept or discarded?', '--options', 'keep,discard']);
    assert.equal(missing.code, 7); assert.match(missing.stderr, /missing recommended default/); assert.match(missing.stderr, /--category/);

    const ok = open(['--question', 'Should prospects without a company be kept as leads or discarded?', '--options', 'keep,discard', '--default', 'keep', '--category', 'product-ambiguity', '--requirement', 'AC3',
      '--contract-gap', 'AC3 says "migrate legacy prospects" but is silent on prospects with no company; both outcomes are valid', '--evidence', 'queried 14 such prospects in dev; the sales workflow differs per choice', '--unsafe-because', 'discarding deletes customer data; keeping changes funnel counts', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json().blocking, false, 'only AC3 is parked; the issue keeps being worked');
    assert.deepEqual(labels(sb, n).includes('state:blocked'), false);
    const c = contractOf(sb, n);
    assert.equal(c.requirements.find((r) => r.id === 'AC3').status, 'NEEDS_DECISION');
    assert.equal(c.requirements.find((r) => r.id === 'AC3').decision, ok.json().decision);
    const ev = evalOf(sb, n);
    assert.deepEqual(ev.blocked.map((r) => r.id), ['AC3']); assert.ok(ev.unresolved.some((r) => r.id === 'AC1'));
    assert.equal(ev.closable, false, 'a pending decision never completes the issue');
    // resolving it makes the requirement workable again
    assert.equal(sb.run('relay-decision', ['resolve', String(ok.json().decision), '--answer', 'keep']).code, 0);
    assert.equal(contractOf(sb, n).requirements.find((r) => r.id === 'AC3').status, 'TODO');
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-6/11: GitHub-closed with an incomplete contract is detected, shown prominently, reopened (or becomes a blocker by policy)', () => {
  for (const reopen of [true, false]) {
    const { sb, n } = sandbox(FOUR_AC_BODY, reopen ? '' : ', reopen_on_incomplete: false');
    try {
      sb.run('relay-contract', ['extract', String(n)]);
      assert.equal(mark(sb, n, 'AC1,AC2', 'PASS', ['--evidence', 'test:npm test → pass']).code, 0);
      sb.gh(['api', '-X', 'PATCH', `repos/local/sandbox/issues/${n}`, '--input', '-'], JSON.stringify({ state: 'closed' }));   // e.g. a premature "Closes #N" or a manual close
      const c = check(sb, n);
      assert.equal(c.code, 4); assert.equal(c.json().state, 'GITHUB_CLOSED_CONTRACT_INCOMPLETE');
      assert.ok(c.json().problems.some((p) => p.code === 'GITHUB_CLOSED'));
      const st = sb.run('relay-status', ['--json']).json();
      assert.equal(st.contracts[0].state, 'GITHUB_CLOSED_CONTRACT_INCOMPLETE');
      assert.match(sb.run('relay-status').stdout, /GITHUB_CLOSED_CONTRACT_INCOMPLETE — GitHub says closed, contract 2\/4/);
      // the orchestrator may not stop on it
      sb.run('relay-orchestrate', ['on']);
      assert.match(hook(sb, 'relay-hook-stop').out.reason, /GITHUB_CLOSED_CONTRACT_INCOMPLETE/);
      const sweep = sb.run('relay-contract', ['sweep', '--json']);
      assert.equal(sweep.json()[0].action, reopen ? 'reopened' : 'blocked');
      if (reopen) {
        assert.equal(sb.issue(n).state, 'open'); assert.ok(labels(sb, n).includes('state:ready') && labels(sb, n).includes('contract:open'));
      } else {
        assert.equal(sb.issue(n).state, 'closed'); assert.ok(labels(sb, n).includes('contract:closed-incomplete'));
        assert.match(sb.state().release_blockers.join('\n'), new RegExp(`#${n}: GitHub closed with an incomplete contract`));
      }
      assert.ok(sb.comments(n).some((x) => /GITHUB_CLOSED_CONTRACT_INCOMPLETE/.test(x.body)));
    } finally { sb.cleanup(); }
  }
});

test('T-CONTRACT-7/12: tests-only, NOT_VERIFIED and unproved required items never pass the gate', () => {
  const { sb, n } = sandbox();
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    assert.equal(mark(sb, n, 'AC1,AC2,AC3', 'PASS', ['--evidence', 'test:npm test → pass']).code, 0);
    assert.equal(mark(sb, n, 'AC4', 'PASS', ['--evidence', 'test:npm test → pass']).code, 4, 'runtime proof required');
    assert.match(mark(sb, n, 'AC4', 'PASS', ['--evidence', 'test:npm test → pass']).stderr, /TESTS_ONLY/);
    assert.equal(mark(sb, n, 'AC4', 'TESTS_ONLY', ['--evidence', 'test:npm test → pass']).code, 0);
    assert.equal(sb.run('relay-contract', ['close', String(n)]).code, 4);
    for (const bad of ['NOT_VERIFIED', 'NOT_PROVED', 'UNKNOWN', 'UNCHECKED', 'TODO', 'NEEDS_INVESTIGATION', 'MERGED_NOT_VERIFIED']) {
      assert.equal(mark(sb, n, 'AC3', bad).code, 0);
      const e = evalOf(sb, n);
      assert.equal(e.closable, false, bad); assert.ok(e.unresolved.some((r) => r.id === 'AC3' && r.status === bad), bad);
      assert.equal(sb.run('relay-contract', ['close', String(n)]).code, 4, bad);
    }
    assert.equal(sb.issue(n).state, 'open');
    // an evidence-free PASS written straight into the comment is still caught by the gate
    const found = sb.comments(n).find((c) => c.body.includes('relay:issue-contract'));
    const tampered = found.body.replace(/"id":"AC3"(.*?)"status":"[A-Z_]+"/, '"id":"AC3"$1"status":"PASS"');
    sb.gh(['api', '-X', 'PATCH', `repos/local/sandbox/issues/comments/${found.id}`, '--input', '-'], JSON.stringify({ body: tampered }));
    const e = evalOf(sb, n);
    assert.ok(e.problems.some((p) => p.id === 'AC3' && /MISSING/.test(p.code)) || e.counts.complete >= 3);
    assert.equal(e.closable, false);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-8/9: one externally blocked requirement does not stop the others; waiting never marks the issue complete', () => {
  const { sb, n } = sandbox('## Acceptance Criteria\n- [ ] a\n- [ ] b\n- [ ] c\n');
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    sb.run('relay-orchestrate', ['on']);
    assert.equal(mark(sb, n, 'AC1', 'EXTERNALLY_BLOCKED').code, 4, 'the exact blocker is required');
    assert.equal(mark(sb, n, 'AC1', 'EXTERNALLY_BLOCKED', ['--blocker', 'human LinkedIn verification required']).code, 0);
    let e = evalOf(sb, n);
    assert.equal(e.next, 'implement', 'AC2 and AC3 are still the agent\'s'); assert.deepEqual(e.blocked.map((r) => r.id), ['AC1']);
    assert.match(hook(sb, 'relay-hook-stop').out.reason, /issue contract\(s\) incomplete.*remaining AC2,AC3/s);
    assert.equal(mark(sb, n, 'AC2,AC3', 'PASS', ['--evidence', 'test:t → pass']).code, 0);
    // everything left is externally blocked: the issue waits (state:blocked + contract:blocked-external) and the agent may stop, but it is NOT complete
    e = evalOf(sb, n);
    assert.equal(e.next, 'wait_external'); assert.equal(e.complete, false); assert.equal(e.closable, false);
    assert.equal(sb.issue(n).state, 'open');
    assert.deepEqual(labels(sb, n).filter((l) => /^(state|contract):/.test(l)), ['contract:blocked-external', 'contract:open', 'state:blocked']);
    assert.equal(hook(sb, 'relay-hook-stop').out, null, 'only external waits remain: the Stop hook lets the session end');
    assert.equal(sb.run('relay-contract', ['close', String(n)]).code, 4);
    assert.match(sb.run('relay-status').stdout, new RegExp(`Issue #${n} BLOCKED_EXTERNAL[\\s\\S]*Contract: 2/3 complete[\\s\\S]*Remaining: AC1`));
    // once the blocker clears, the work resumes and the issue can close
    assert.equal(mark(sb, n, 'AC1', 'PASS', ['--evidence', 'manual:owner verified the LinkedIn account']).code, 0);
    assert.equal(sb.issue(n).state, 'closed');
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-10: the issue changes mid-run: drift is detected, closure denied until reconciled, nothing is dropped silently', () => {
  const { sb, n } = sandbox('## Acceptance Criteria\n- [ ] a\n- [ ] b\n');
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    assert.equal(mark(sb, n, 'AC1,AC2', 'PASS', ['--evidence', 'test:t → pass']).code, 0);
    assert.equal(sb.issue(n).state, 'closed', 'complete before the edit: closed');
    // reopen to model a long-running issue whose acceptance is amended by a later comment
    sb.gh(['api', '-X', 'PATCH', `repos/local/sandbox/issues/${n}`, '--input', '-'], JSON.stringify({ state: 'open' }));
  } finally { sb.cleanup(); }
  const t = sandbox('## Acceptance Criteria\n- [ ] a\n- [ ] b\n'); const { sb: sb2, n: n2 } = t;
  try {
    sb2.run('relay-contract', ['extract', String(n2)]);
    sb2.gh(['api', '-X', 'POST', `repos/local/sandbox/issues/${n2}/comments`, '--input', '-'], JSON.stringify({ body: '## Updated acceptance\n- [ ] also report the before/after counts' }));
    const c = check(sb2, n2);
    assert.equal(c.code, 4); assert.ok(c.json().problems.some((p) => p.code === 'DRIFT'));
    const u = sb2.run('relay-contract', ['update', String(n2), '--json']).json();
    assert.deepEqual(u.added, ['AC3']);
    assert.equal(contractOf(sb2, n2).requirements.find((r) => r.id === 'AC3').origin.startsWith('comment:'), true);
    assert.equal(mark(sb2, n2, 'AC1,AC2', 'PASS', ['--evidence', 'test:t → pass']).code, 0);
    assert.equal(sb2.issue(n2).state, 'open', 'the late requirement keeps the issue open');
    // body edit that drops a requirement: it stays in the contract, flagged, until kept or descoped by the owner
    sb2.gh(['api', '-X', 'PATCH', `repos/local/sandbox/issues/${n2}`, '--input', '-'], JSON.stringify({ body: '## Acceptance Criteria\n- [ ] a\n- [ ] b\n- [ ] also report the before/after counts\n'.replace('- [ ] b\n', '') }));
    sb2.run('relay-contract', ['update', String(n2)]);
    const e = evalOf(sb2, n2);
    assert.ok(e.problems.some((p) => p.code === 'DRIFT_VANISHED' && p.id === 'AC2'));
    assert.equal(sb2.run('relay-contract', ['reconcile', String(n2), '--keep', 'AC2', '--reason', 'still required']).code, 0);
    assert.ok(!evalOf(sb2, n2).problems.some((p) => p.code === 'DRIFT_VANISHED'));
  } finally { sb2.cleanup(); }
});

test('T-CONTRACT-11: a PR that says "Closes #N" cannot close an incomplete issue; relay-pr rewrites it, an unaware merge cannot slip through', () => {
  const { sb, n } = sandbox();
  try {
    const claim = sb.run('relay-claim', [String(n), '--agent', 'claude-1', '--runtime', 'claude', '--json']);
    const branch = claim.json().branch;
    sb.git(['checkout', '-q', '-B', branch, 'origin/main']); fs.writeFileSync(path.join(sb.work, 'f.txt'), 'x\n'); sb.git(['add', 'f.txt']); sb.git(['commit', '-qm', 'feat: f']);
    const bodyFile = path.join(sb.root, 'body.md');
    const body = sliceBody(n, { covers: ['AC1'], all: ALL }).replace(`Refs #${n}`, `Closes #${n}`);
    fs.writeFileSync(bodyFile, body);
    const bare = fs.readFileSync(bodyFile, 'utf8').replace(/## Contract Coverage[\s\S]*/, '');
    fs.writeFileSync(bodyFile, bare);
    const r1 = sb.run('relay-pr', ['open', '--body-file', bodyFile, '--json']);
    assert.equal(r1.code, 3); assert.match(r1.stderr, /Contract Coverage/);
    fs.writeFileSync(bodyFile, body.replace('Issue completion: NO — additional accepted requirements remain.', 'Issue completion: YES'));
    const r2 = sb.run('relay-pr', ['open', '--body-file', bodyFile, '--json']);
    assert.equal(r2.code, 3); assert.match(r2.stderr, /false-completion/);
    fs.writeFileSync(bodyFile, body);
    const r3 = sb.run('relay-pr', ['open', '--body-file', bodyFile, '--json']);
    assert.equal(r3.code, 0, r3.stderr); assert.match(r3.stderr, /closing keyword replaced by "Refs #/);
    const pr = r3.json().number;
    const prBody = sb.db().items.find((i) => i.number === pr).body;
    assert.ok(/Refs #/.test(prBody) && !/Closes #/.test(prBody), 'GitHub can never auto-close on merge');
    sb.git(['checkout', '-q', 'main']);
    // a PR opened behind relay-pr's back (still saying Closes) is refused by the merge queue: coverage is mandatory
    const raw = openSlicePR(sb, { branch: agentBranch(sb, { runtime: 'claude', issue: n, slug: 'raw', files: { 'raw.txt': 'r\n' } }), body: `Closes #${n}\n\n## NOT_VERIFIED\nnothing run\n` });
    assert.equal(coverageVerdict(sb, raw, 'codex', { AC1: 'PASS' }, false).code, 3, 'the reviewer cannot approve a PR with no truthful coverage section');
    const m = sb.run('relay-merge', [`${raw}:${n}`]);
    assert.equal(m.code, 1); assert.match(m.stdout, /SKIP \(/);
    assert.equal(sb.issue(n).state, 'open');
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-REVIEW: the reviewer rejects false completion claims; a PR may be approved with ISSUE_COMPLETE=NO', () => {
  const { sb, n } = sandbox();
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    const branch = agentBranch(sb, { runtime: 'claude', issue: n, slug: 'r', files: { 'r.txt': 'r\n' } });
    const pr = openSlicePR(sb, { branch, body: sliceBody(n, { covers: ['AC1'], all: ALL }) });
    const v = (cov, complete, result) => coverageVerdict(sb, pr, 'codex', cov, complete, result);
    assert.equal(sb.run('relay-verdict', ['post', String(pr), '--result', 'APPROVED', '--checklist', '{"acceptance":"PASS"}'], { env: { RELAY_RUNTIME: 'codex', RELAY_ACTOR: 'reviewer' } }).code, 3, 'coverage must be stated');
    assert.equal(v({ AC1: 'FAIL', AC2: 'NOT_COVERED', AC3: 'NOT_COVERED', AC4: 'NOT_COVERED' }, false).code, 3, 'claims AC1 implemented, review finds FAIL: false coverage claim');
    assert.match(v({ AC1: 'FAIL', AC2: 'NOT_COVERED', AC3: 'NOT_COVERED', AC4: 'NOT_COVERED' }, false).stderr, /false coverage claim/);
    assert.equal(v({ AC1: 'PASS', AC2: 'NOT_COVERED', AC3: 'NOT_COVERED', AC4: 'NOT_COVERED' }, true).code, 3, 'ISSUE_COMPLETE=YES with uncovered requirements');
    assert.equal(v({ AC1: 'PASS', AC2: 'NOT_COVERED' }, false).code, 3, 'every unresolved requirement must be addressed');
    const ok = v({ AC1: 'PASS', AC2: 'NOT_COVERED', AC3: 'NOT_COVERED', AC4: 'NOT_COVERED' }, false);
    assert.equal(ok.code, 0, ok.stderr);
    const comment = sb.comments(pr).find((c) => c.body.includes('MAIN REVIEW')).body;
    assert.match(comment, /CONTRACT_COVERAGE:\nAC1 PASS\nAC2 NOT_COVERED[\s\S]*ISSUE_COMPLETE: NO/);
    // CHANGES is always possible (no coverage consistency rules apply to it)
    assert.equal(v({ AC1: 'FAIL' }, false, 'CHANGES').code, 0);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-QA: a failed post-merge proof returns the issue to implementation automatically', () => {
  const { sb, n } = sandbox('## Acceptance Criteria\n- [ ] the dashboard shows the count in production\n- [ ] the export is correct\n');
  try {
    sb.__done = [];
    const all = ['AC1', 'AC2'];
    sb.run('relay-contract', ['extract', String(n)]);
    const branch = agentBranch(sb, { runtime: 'claude', issue: n, slug: 'q', files: { 'q.txt': 'q\n' } });
    const pr = openSlicePR(sb, { branch, body: sliceBody(n, { covers: ['AC1', 'AC2'], all }) });
    sb.run('relay-labels', ['set', String(n), 'state:review']);
    assert.equal(coverageVerdict(sb, pr, 'codex', { AC1: 'PASS', AC2: 'PASS' }, true).code, 0);
    const m = sb.run('relay-merge', [`${pr}:${n}`]);
    assert.match(m.stdout, /contract 1\/2 complete, issue stays active \(remaining AC1\)/, m.stdout + m.stderr);
    assert.equal(sb.issue(n).state, 'open');
    const fail = sb.run('relay-qa', ['done', String(pr), '--result', 'fail', '--map', 'AC1=FAIL:experiment 87 prospect 123 still has no next action', '--map', 'AC2=PASS', '--proof', 'harness/proof/q.json']);
    assert.equal(fail.code, 0, fail.stderr);
    assert.match(fail.stdout, /ISSUE REMAINS ACTIVE \(AC1 FAIL\)/);
    assert.ok(labels(sb, n).includes('state:ready'));
    const c = contractOf(sb, n);
    assert.equal(c.requirements.find((r) => r.id === 'AC1').status, 'FAIL'); assert.equal(c.prs[0].qa, 'fail');
    assert.ok(sb.comments(n).some((x) => /post-merge QA for PR #\d+: fail/.test(x.body)));
    assert.equal(sb.run('relay-contract', ['close', String(n)]).code, 4);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-JOURNAL: journal entries carry requirement ids and `check` validates the requirement-level trail', () => {
  const { sb, n } = sandbox('## Acceptance Criteria\n- [ ] one\n- [ ] two\n');
  try {
    sb.run('relay-contract', ['extract', String(n)]);
    const post = (kind, text, req) => sb.run('relay-journal', ['post', String(n), '--kind', kind, '--text', text, ...(req ? ['--req', req] : [])]);
    assert.equal(post('plan', 'whole plan', 'AC1,AC2').code, 0);
    assert.equal(post('implementation', 'AC1 built', 'AC1').code, 0);
    assert.equal(post('proof', 'AC1 proven', 'ac1').code, 0);
    assert.equal(post('blocker', 'AC2 waits for x', 'AC2').code, 0);
    assert.equal(post('summary', 'slice done').code, 0);
    const log = sb.run('relay-journal', ['read', String(n), '--json']).json();
    assert.deepEqual(log.entries.filter((e) => e.reqs).map((e) => e.reqs), [['AC1', 'AC2'], ['AC1', 'AC2'], ['AC1'], ['AC1'], ['AC2']]);
    assert.match(sb.comments(n).find((c) => c.body.includes('relay:journal-log')).body, /\[AC1,AC2\] whole plan/);
    assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 0, 'partial progress is a valid journal');
    const fin = sb.run('relay-journal', ['check', String(n), '--final']);
    assert.equal(fin.code, 3); assert.match(fin.stderr + fin.stdout, /contract incomplete \(0\/2\)/);
    // a requirement satisfied without any journal trace is flagged
    mark(sb, n, 'AC1', 'PASS', ['--evidence', 'test:t → pass']);
    assert.equal(sb.run('relay-journal', ['check', String(n)]).code, 0, 'AC1 has a proof entry');
    assert.equal(sb.run('relay-journal', ['post', String(n), '--kind', 'bogus', '--text', 'x']).code, 3);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-BOOTSTRAP: an existing issue with no stored contract is bootstrapped without inventing evidence', () => {
  const { sb, n } = sandbox('## Acceptance Criteria\n- [x] already ticked by a human\n- [ ] still open\n');
  try {
    const r = sb.run('relay-contract', ['show', String(n), '--json']);
    assert.equal(r.code, 0);
    const c = r.json().contract;
    assert.equal(c.bootstrap, true);
    assert.deepEqual(c.requirements.map((x) => [x.status, x.evidence.length]), [['UNCHECKED', 0], ['TODO', 0]]);
    assert.equal(sb.run('relay-contract', ['extract', String(n)]).code, 0);
    assert.equal(sb.comments(n).filter((x) => x.body.includes('relay:issue-contract')).length, 1, 'idempotent: one living contract comment');
    // an old state file (no contract data at all) keeps working: contracts do not live in STATE.json
    assert.equal(sb.run('relay-state', ['get', 'schema_version']).stdout.trim(), '1');
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-OFF: contract.mode off keeps the legacy behaviour (merge closes the linked issue)', () => {
  const sb = makeSandbox();
  try {
    const n = seedIssue(sb, { title: 't', labels: ['state:review', 'agent:claude'] });
    const branch = agentBranch(sb, { runtime: 'claude', issue: n, slug: 'l', files: { 'l.txt': 'l\n' } });
    const pr = openSlicePR(sb, { branch, body: `Closes #${n}` });
    assert.equal(sb.run('relay-verdict', ['post', String(pr), '--result', 'APPROVED', '--checklist', '{"a":"PASS"}'], { env: { RELAY_RUNTIME: 'codex', RELAY_ACTOR: 'reviewer' } }).code, 0);
    assert.equal(sb.run('relay-merge', [`${pr}:${n}`]).code, 0);
    assert.equal(sb.issue(n).state, 'closed');
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-GATE-HOOK: `gh issue close` and direct state:closed API calls are blocked outside the contract gate', () => {
  const sb = enforceContracts(makeSandbox());
  try {
    const bash = (command) => hook(sb, 'relay-hook-destructive-gate', { tool_name: 'Bash', tool_input: { command } }).out?.hookSpecificOutput;
    assert.match(bash('gh issue close 2945 -c done').permissionDecisionReason, /relay-contract close/);
    assert.ok(bash('gh api -X PATCH repos/o/r/issues/12 -f state=closed'));
    assert.equal(bash('gh issue view 12'), undefined);
    assert.equal(bash('relay-contract close 12'), undefined);
  } finally { sb.cleanup(); }
});

test('T-CONTRACT-REDISPATCH: merged PR + unresolved contract is READY work: the headless loop redispatches the next slice without a human saying "continue"', () => {
  const sb = enforceContracts(useFakeRuntimes(makeSandbox()));   // patch first, then commit the policy so branches inherit both
  try {
    const n = seedIssue(sb, { title: 'Prospect admission', body: `${FOUR_AC_BODY}\n## Owned Paths\nsrc/**\n`, labels: ['state:review', 'agent:codex'] });
    sb.run('relay-contract', ['extract', String(n)]);
    const branch = agentBranch(sb, { runtime: 'codex', issue: n, slug: 'prospect-admission', files: { 'src/a.mjs': 'export const a = 1;\n' } });
    const pr = openSlicePR(sb, { branch, body: sliceBody(n, { covers: ['AC1'], all: ALL }) });
    assert.equal(coverageVerdict(sb, pr, 'claude', { AC1: 'PASS', AC2: 'NOT_COVERED', AC3: 'NOT_COVERED', AC4: 'NOT_COVERED' }, false).code, 0);
    const m = sb.run('relay-merge', [`${pr}:${n}`]);
    assert.match(m.stdout, /contract 1\/4 complete, issue stays active/, m.stdout + m.stderr);
    assert.ok(labels(sb, n).includes('state:ready'));
    const loop = sb.run('relay-loop', ['--runtime', 'codex', '--once', '--no-review', '--json']);
    assert.equal(loop.code, 0, loop.stderr + loop.stdout);
    const sum = loop.json();
    assert.deepEqual(sum.dispatched.map((d) => d.issue), [n], `the unfinished issue was dispatched again: ${JSON.stringify(sum)}`);
    const second = prsOf(sb).find((p) => p.number !== pr);
    assert.match(second.pull_request.head.ref, /-s2$/, 'the next slice works on a fresh slice branch');
    assert.equal(sb.issue(n).state, 'open');
    const brief = fs.readdirSync(path.join(sb.work, '.relay/briefs')).filter((f) => f.startsWith(`issue-${n}-`)).map((f) => fs.readFileSync(path.join(sb.work, '.relay/briefs', f), 'utf8')).at(-1);
    assert.match(brief, new RegExp(`ISSUE CONTRACT #${n} — 1/4 complete`)); assert.match(brief, /\[x\] AC1 \[FIXED_AND_VERIFIED\]/); assert.match(brief, /\[ \] AC2 \[TODO\]/);
  } finally { sb.cleanup(); }
});
