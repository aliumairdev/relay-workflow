import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { REPO } from '../helpers.mjs';
import { parseConfig, withDefaults } from '../../core/lib/config.mjs';

export function goldenConfig() {
  const { value, errors } = parseConfig(fs.readFileSync(path.join(REPO, 'tests/fixtures/golden.workflow.yaml'), 'utf8'));
  assert.deepEqual(errors, []);
  return withDefaults(value);
}
// Compare `actual` to tests/golden/<name>; UPDATE_GOLDEN=1 rewrites the fixture.
export function golden(name, actual) {
  const f = path.join(REPO, 'tests/golden', name);
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, actual); return; }
  assert.equal(actual, fs.readFileSync(f, 'utf8'), `golden mismatch: ${name} (UPDATE_GOLDEN=1 to refresh after review)`);
}
