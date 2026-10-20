import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../helpers.mjs';

const ROOTS = ['core/skills', 'core/profiles/rails/skills'].map((r) => path.join(REPO, r));
const FORBIDDEN = /opertide|jumpstart|ecommerce|shopify|action gateway|\btrd\b|prd_|b2[- ]level|\.\.\/\.\.\/\.\.\/docs|\/Users\//i;

function skillFiles(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) out.push(path.join(dir, d.name, 'SKILL.md'));
  }
  return out;
}
function allMarkdown(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...allMarkdown(p)); else if (d.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap(skillFiles);

test('skills library has the expected skills', () => {
  const names = files.map((f) => path.basename(path.dirname(f)));
  for (const n of ['adversarial-review', 'blast-radius', 'feature-manager', 'code-simplifier', 'domain-modeling', 'dry', 'migration', 'problem-finding', 'surgical-patch', 'test-driven-development', 'feature-delivery', 'boundary-review', 'project-records', 'issue-audit', 'prd-to-issues', 'write-a-prd', 'plan-to-pr', 'repo-cleanup', 'grilling', 'grill-with-docs', 'rails-backend', 'hotwire-frontend', 'tailwind-ui']) {
    assert.ok(names.includes(n), `missing skill ${n}`);
  }
});

for (const f of files) {
  const rel = path.relative(REPO, f);
  const text = fs.readFileSync(f, 'utf8');
  test(`skill ${rel}: frontmatter, size`, () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, 'frontmatter');
    const fm = Object.fromEntries(m[1].split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'name']);
    assert.equal(fm.name, path.basename(path.dirname(f)));
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.description.startsWith('Use when') || fm.description.startsWith('Use only when'), 'description starts with "Use when"');
    assert.ok(Buffer.byteLength(text) < 6 * 1024, 'size < 6 KB');
  });
}

for (const dir of ROOTS) {
  for (const f of allMarkdown(dir)) {
    const rel = path.relative(REPO, f);
    const text = fs.readFileSync(f, 'utf8');
    test(`skill file ${rel}: no project terms, links resolve`, () => {
      assert.ok(!FORBIDDEN.test(text), `forbidden term: ${FORBIDDEN.exec(text)?.[0]}`);
      for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target)) continue;
        assert.ok(fs.existsSync(path.resolve(path.dirname(f), target)), `broken link ${target}`);
      }
    });
  }
}
