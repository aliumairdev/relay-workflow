import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderBrief, briefNames } from '../../core/lib/brief.mjs';
import { modelIds, isNeutral } from '../../core/lib/neutrality.mjs';
import { golden, goldenConfig } from '../golden/helpers.mjs';
import { REPO } from '../helpers.mjs';

const REVIEW_VARS = { runtime: 'codex', pr: '12', issue: '7', branch: 'agent/codex/7-x', tier_name: 'routine', main_checkout: '/repo/main' };

test('golden: rendered review brief equals fixture and has the six token-rule bullets', () => {
  const { text } = renderBrief('review', REVIEW_VARS, goldenConfig());
  golden('review-brief.md', text);
  const block = text.split('TOKEN DISCIPLINE (mandatory):')[1].split('\n\n')[0];
  const bullets = block.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 6);
  assert.match(bullets[0], /^- Search before reading/);
  assert.match(bullets[5], /^- No out-of-scope work/);
});

test('golden: dispatch brief for claude (no bot rules without logins)', () => {
  const cfg = goldenConfig(); cfg.runtimes.codex.bot.logins = []; cfg.bot.logins = [];
  const { text } = renderBrief('dispatch', { runtime: 'claude', issue: '5', branch: 'agent/claude/5-y', tier_name: 'implement', role_name: 'backend', agent_id: 'claude-ab', review_runtime: 'codex', main_checkout: '/repo/main' }, cfg);
  golden('dispatch-brief.md', text);
  assert.ok(!text.includes('BOT REVIEW'));
  assert.ok(text.includes('RUNTIME: Claude Code'));
});

test('brief rendering is deterministic', () => {
  const a = renderBrief('review', REVIEW_VARS, goldenConfig()); const b = renderBrief('review', REVIEW_VARS, goldenConfig());
  assert.equal(a.hash, b.hash);
});

test('missing variables fail loudly with their names', () => {
  assert.throws(() => renderBrief('review', { runtime: 'codex' }, goldenConfig()), /missing variables: .*issue.*pr|missing variables: .*pr/);
});

test('every brief is free of repo-specific leftovers', () => {
  for (const n of briefNames()) {
    const t = fs.readFileSync(path.join(REPO, 'core/briefs', `${n}.md`), 'utf8');
    assert.ok(!/aliumairdev|nexus|\/Users\/|shopify|\.paseo/i.test(t), `${n} contains project-specific text`);
  }
});

test('AGENTS template passes the neutrality lint and stays small', () => {
  const t = fs.readFileSync(path.join(REPO, 'core/templates/AGENTS.template.md'), 'utf8');
  assert.deepEqual(modelIds(t), []);
  assert.ok(Buffer.byteLength(t) < 24 * 1024);
});

test('neutrality lint catches model ids', () => {
  assert.ok(!isNeutral('use claude-sonnet-5-5 here'));
  assert.ok(!isNeutral('model gpt-5 default'));
  assert.ok(isNeutral('Tier T1 (implement)'));
});
