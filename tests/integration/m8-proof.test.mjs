import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { makeSandbox, seedIssue, ledgerRows } from '../helpers.mjs';

function platform(pages) {
  const srv = http.createServer((req, res) => { const p = pages[req.url.split('?')[0]] || { status: 404, body: 'not found page' }; res.writeHead(p.status ?? 200, { 'content-type': 'text/html' }); res.end(p.body ?? ''); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(c)) })));
}
const proofCfg = (push = "echo '{}'") => `
security: { mutation_scope: [dev-target] }
environment: { name: dev-target, target_ref: "env:DEV_TARGET", base_url_ref: "env:DEV_URL" }
proof:
  pre_merge:
    push: ${JSON.stringify(push)}
    probe_pages: ["/", "/cart", "/nope-404"]
    error_signatures: ["Liquid error", "translation missing"]
`;
const OK_PAGES = { '/': { body: '<h1>home</h1>' }, '/cart': { body: '<h1>cart</h1>' }, '/nope-404': { status: 404, body: '<h1>not found</h1>' } };
const items = (sb) => sb.db().items || [];
const labels = (sb, n) => sb.issue(n).labels.map((l) => l.name).sort();

test('relay-proof passes against a healthy platform and writes the summary', async () => {
  const sb = makeSandbox(); const srv = await platform(OK_PAGES);
  try {
    sb.patchConfig((t) => t + proofCfg());
    const r = await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'abc123', '--json'], { env: { DEV_TARGET: 'dev', DEV_URL: srv.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const res = r.json();
    assert.ok(res.items.length === 4 && res.items.every((i) => i.status === 'pass'));
    const s = JSON.parse(fs.readFileSync(res.summary, 'utf8'));
    assert.equal(s.exit, 0); assert.match(res.summary, /harness\/proof\/2026-10-20\/abc123\/summary\.json$/);
    assert.equal(items(sb).length, 0, 'no bug issues on a pass');
  } finally { await srv.close(); sb.cleanup(); }
});

test('T-PROOF-1: an error signature on one page -> exit 4, a bug issue is filed and routed one tier higher', async () => {
  const sb = makeSandbox(); const srv = await platform({ ...OK_PAGES, '/cart': { body: '<div>Liquid error (sections/cart line 4): undefined method</div>' } });
  try {
    sb.patchConfig((t) => t + proofCfg());
    const work = seedIssue(sb, { title: 'Cart upsell', labels: ['state:done', 'agent:codex'] });
    fs.mkdirSync(path.join(sb.work, '.relay/ledger'), { recursive: true });
    fs.writeFileSync(path.join(sb.work, '.relay/ledger/usage.jsonl'), JSON.stringify({ ts: '2026-10-20T09:00:00Z', run_id: 'r-1', runtime: 'codex', tier: 'T1', task_class: 'implement', issue: work, outcome: 'done' }) + '\n');

    const env = { DEV_TARGET: 'dev', DEV_URL: srv.url };
    const r = await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'deadbeef', '--issue', String(work), '--json'], { env });
    assert.equal(r.code, 4, r.stdout + r.stderr);
    const res = r.json();
    const failed = res.items.filter((i) => i.status === 'fail');
    assert.deepEqual(failed.map((i) => i.name), ['page /cart']);
    assert.match(failed[0].evidence, /Liquid error/);
    assert.equal(res.items.filter((i) => i.status === 'pass').length, 3, 'the other pages still pass, including the expected 404');

    assert.equal(res.bug_issues.length, 1);
    const bug = res.bug_issues[0].number;
    assert.deepEqual(labels(sb, bug).filter((l) => /^(type|route|state):/.test(l)), ['route:T2', 'state:ready', 'type:bug']);
    assert.match(sb.issue(bug).body, /Liquid error/); assert.match(sb.issue(bug).body, /real-env-proof|Root cause/i);
    assert.ok(sb.comments(work).some((c) => c.body.includes(`#${bug}`)), 'the introducing issue is told');
    assert.ok(sb.run('relay-journal', ['read', String(work), '--json']).json().entries.some((e) => e.kind === 'blocker' && e.text.includes(`#${bug}`)));

    // the next dispatch is routed one tier higher (T1 -> T2)
    const route = sb.run('relay-route', [String(bug), '--json']);
    assert.equal(route.json().decision.tier, 'T2');

    // idempotent: a repeat proof does not file a duplicate
    const again = await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'deadbeef', '--issue', String(work), '--json'], { env });
    assert.equal(again.code, 4);
    assert.equal(again.json().bug_issues[0].duplicate, true);
    assert.equal(items(sb).filter((i) => i.labels.includes('type:bug')).length, 1);
    // --no-issues files nothing
    const before = items(sb).length;
    await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'other', '--no-issues'], { env });
    assert.equal(items(sb).length, before);
  } finally { await srv.close(); sb.cleanup(); }
});

test('relay-proof: render errors (status/empty) -> exit 6; push errors from the platform CLI -> exit 4 with the file', async () => {
  const sb = makeSandbox(); const srv = await platform({ ...OK_PAGES, '/': { status: 500, body: 'oops' }, '/cart': { body: '   ' } });
  try {
    sb.patchConfig((t) => t + proofCfg());
    const env = { DEV_TARGET: 'dev', DEV_URL: srv.url };
    const r = await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'r6', '--no-issues', '--json'], { env });
    assert.equal(r.code, 6, r.stdout);
    assert.deepEqual(r.json().items.filter((i) => i.status === 'fail').map((i) => i.name).sort(), ['page /', 'page /cart']);

    fs.writeFileSync(path.join(sb.work, 'workflow.yaml'), fs.readFileSync(path.join(sb.work, 'workflow.yaml'), 'utf8').replace(/\nsecurity:[\s\S]*$/, '') + proofCfg(`echo '{"errors":{"sections/x.liquid":"Liquid syntax error: Unknown tag foo"}}'`));
    const p = await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'r4', '--no-issues', '--json'], { env });
    assert.equal(p.code, 4, p.stdout + p.stderr);
    const push = p.json().items.find((i) => i.name === 'push');
    assert.equal(push.status, 'fail'); assert.match(push.evidence, /sections\/x\.liquid: Liquid syntax error/);
  } finally { await srv.close(); sb.cleanup(); }
});

test('T-PROOF-2: target unavailable -> exit 5, every item NOT_VERIFIED, nothing claimed, no bug issues', async () => {
  const sb = makeSandbox();
  try {
    sb.patchConfig((t) => t + proofCfg());
    const unset = sb.run('relay-proof', ['--stage', 'pre-merge', '--ref', 'n1', '--json'], { env: { DEV_TARGET: '', DEV_URL: '' } });
    assert.equal(unset.code, 5, unset.stdout + unset.stderr);
    const res = unset.json();
    assert.ok(res.items.length >= 3 && res.items.every((i) => i.status === 'not_verified'), JSON.stringify(res.items));
    assert.match(res.note, /nothing is claimed/);
    assert.equal(items(sb).length, 0);
    assert.ok(fs.existsSync(res.summary));

    // reachable config but the platform is down
    const down = sb.run('relay-proof', ['--stage', 'pre-merge', '--ref', 'n2', '--json'], { env: { DEV_TARGET: 'dev', DEV_URL: 'http://127.0.0.1:1' } });
    assert.equal(down.code, 5);
    assert.ok(down.json().items.filter((i) => i.name !== 'push').every((i) => i.status === 'not_verified'), 'pages stay NOT_VERIFIED; the push that really ran keeps its recorded result');
    assert.equal(down.json().items.filter((i) => i.name === 'push').length, 1, 'push recorded once');
    assert.match(down.json().items.map((i) => i.evidence).join(' '), /unreachable/);

    // missing variable in a page template
    fs.writeFileSync(path.join(sb.work, 'workflow.yaml'), fs.readFileSync(path.join(sb.work, 'workflow.yaml'), 'utf8').replace('"/cart"', '"/products/${FIRST_PRODUCT}"'));
    const srv = await platform(OK_PAGES);
    const miss = await sb.spawnScript('relay-proof', ['--stage', 'pre-merge', '--ref', 'n3', '--json'], { env: { DEV_TARGET: 'dev', DEV_URL: srv.url } });
    await srv.close();
    assert.equal(miss.code, 5); assert.match(miss.json().items.find((i) => i.status === 'not_verified').evidence, /FIRST_PRODUCT/);
  } finally { sb.cleanup(); }
});

test('relay-proof refuses to mutate a target that is not in security.mutation_scope', () => {
  const sb = makeSandbox();
  try {
    sb.patchConfig((t) => t + proofCfg().replace('mutation_scope: [dev-target]', 'mutation_scope: [some-other-target]'));
    const r = sb.run('relay-proof', ['--stage', 'pre-merge', '--ref', 'x', '--json'], { env: { DEV_TARGET: 'dev', DEV_URL: 'http://127.0.0.1:1' } });
    assert.equal(r.code, 8); assert.match(r.json().items[0].evidence, /mutation_scope/);
  } finally { sb.cleanup(); }
});

test('T-MUT-1: a guard test must fail against the broken guard; vacuous guards and no-op mutations are caught', () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.work, 'src/guard.mjs'), "export function guard(x) { if (x < 0) throw new Error('negative'); return x; }\n");
    fs.writeFileSync(path.join(sb.work, 'guard.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; import { guard } from './src/guard.mjs';\ntest('rejects negatives', () => assert.throws(() => guard(-1)));\n");
    fs.writeFileSync(path.join(sb.work, 'vacuous.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; import { guard } from './src/guard.mjs';\ntest('passes through', () => assert.equal(guard(1), 1));\n");
    sb.git(['add', '-A']); sb.git(['commit', '-qm', 'guard']);
    const mutate = "sed -i.bak 's/x < 0/x < -999/' src/guard.mjs";
    const cfg = (checks) => sb.patchConfig((t) => t.replace(/\nhonesty:[\s\S]*$/, '') + `\nhonesty: { mutation_checks: ${JSON.stringify(checks)} }\n`);

    cfg([{ name: 'negatives-rejected', test: 'node --test guard.test.mjs', mutate }]);
    const ok = sb.run('relay-mutation-check', ['--json']);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(ok.json().results[0].status, 'killed');

    cfg([{ name: 'negatives-rejected', test: 'node --test guard.test.mjs', mutate }, { name: 'vacuous-guard', test: 'node --test vacuous.test.mjs', mutate }]);
    const bad = sb.run('relay-mutation-check', ['--json']);
    assert.equal(bad.code, 4);
    const by = Object.fromEntries(bad.json().results.map((r) => [r.name, r]));
    assert.equal(by['negatives-rejected'].status, 'killed');
    assert.equal(by['vacuous-guard'].status, 'survived'); assert.match(by['vacuous-guard'].detail, /does not guard anything/);

    cfg([{ name: 'noop', test: 'node --test guard.test.mjs', mutate: 'true' }]);
    assert.equal(sb.run('relay-mutation-check', ['--json']).json().results[0].status, 'error');
    cfg([{ name: 'broken-baseline', test: 'node --test does-not-exist.test.mjs', mutate }]);
    assert.equal(sb.run('relay-mutation-check', ['--json']).json().results[0].status, 'baseline-failed');
    assert.equal(sb.git(['worktree', 'list']).stdout.trim().split('\n').length, 1, 'temp worktrees are cleaned up');
    assert.equal(sb.run('relay-mutation-check', ['--only', 'nope']).code, 3);
  } finally { sb.cleanup(); }
});

test('relay-evidence-lint CLI: PR bodies, handoffs and journal summaries; handoff post enforces evidence', () => {
  const sb = makeSandbox();
  try {
    const bad = sb.run('relay-evidence-lint', ['--text', 'All tests pass.']);
    assert.equal(bad.code, 3); assert.match(bad.stdout, /claim-without-evidence/);
    assert.equal(sb.run('relay-evidence-lint', ['--text', 'All tests pass.\n\n## NOT_VERIFIED\nnone\n\n`npm test` → 9 pass']).code, 0);
    assert.equal(sb.run('relay-evidence-lint').code, 3, 'usage');

    const n = seedIssue(sb, { title: 'Handoff honesty', labels: ['state:ready', 'agent:claude'] });
    sb.run('relay-claim', [String(n), '--agent', 'c1', '--runtime', 'claude']);
    const wt = sb.run('relay-worktree', ['create', String(n), '--runtime', 'claude', '--json']).json().path;
    const f = path.join(sb.root, 'h.json');
    fs.writeFileSync(f, JSON.stringify({ done: ['x'], tests_run: [{ cmd: 'npm test', result: 'pass' }] }));
    const h = sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'capability', '--from-file', f], { cwd: wt });
    assert.equal(h.code, 3); assert.match(h.stderr, /without evidence/);
    fs.writeFileSync(f, JSON.stringify({ done: ['x'], tests_run: [{ cmd: 'npm test', result: 'pass', evidence: '1 pass' }] }));
    assert.equal(sb.run('relay-handoff', ['post', String(n), '--to', 'codex', '--reason', 'capability', '--from-file', f], { cwd: wt }).code, 0);

    sb.run('relay-journal', ['post', String(n), '--kind', 'summary', '--text', 'Everything verified and working correctly.']);
    const j = sb.run('relay-evidence-lint', ['--issue', String(n)]);
    assert.equal(j.code, 3); assert.match(j.stdout, /journal #\d+ \(summary\)/);
  } finally { sb.cleanup(); }
});
