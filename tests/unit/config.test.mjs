import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../../core/lib/config.mjs';
import { REPO } from '../helpers.mjs';

const fx = (...p) => path.join(REPO, 'tests/fixtures', ...p);

test('T-CFG-1: PLUGIN_SPEC section 10 example validates', () => {
  const { errors } = parseConfig(fs.readFileSync(fx('workflow.shopify.yaml'), 'utf8'));
  assert.deepEqual(errors, []);
});

const EXPECT = {
  'missing-repo.yaml': 'project',
  'bad-mode.yaml': 'policy.mode',
  'bad-version.yaml': 'version',
  'step-missing-cmd.yaml': 'ci.steps.0',
  'unknown-key.yaml': 'surprise',
  'bad-tier.yaml': 'tiers',
};
for (const [file, where] of Object.entries(EXPECT)) {
  test(`T-CFG-1: invalid fixture ${file} fails with path ${where}`, () => {
    const { errors } = parseConfig(fs.readFileSync(fx('config-invalid', file), 'utf8'));
    assert.ok(errors.length > 0, 'must fail');
    assert.ok(errors.some((e) => e.path === where || e.path.startsWith(where)), `expected path ${where}, got ${JSON.stringify(errors)}`);
    assert.ok(errors.every((e) => typeof e.message === 'string'));
  });
}

test('T-CFG-1: YAML syntax errors report a line', () => {
  const { errors } = parseConfig('version: 1\nproject: [unclosed\n');
  assert.ok(errors.length > 0);
  assert.equal(typeof errors[0].line, 'number');
});

test('errors carry a line number for nested keys', () => {
  const { errors } = parseConfig('version: 1\nproject:\n  name: x\n  repo: a/b\npolicy:\n  mode: turbo\n');
  assert.equal(errors[0].line, 6);
});
