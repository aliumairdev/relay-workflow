import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sh } from './exec.mjs';
import { matches } from './glob.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STRATEGIES = ['union', 'json-deep-merge', 'line-union', 'keep-both'];
const FILE = { union: 'md-union', 'json-deep-merge': 'json-deep-merge', 'line-union': 'line-union', 'keep-both': 'keep-both' };
export const DEFAULT_RESOLVERS = [{ match: '**/*.md', strategy: 'union' }];

async function load(strategy) {
  return (await import(pathToFileURL(path.join(here, '..', 'resolvers', `${FILE[strategy]}.mjs`)).href)).resolve;
}
const stage = (cwd, n, f) => { const r = sh('git', ['show', `:${n}:${f}`], { cwd }); return r.code === 0 ? r.stdout : ''; };

// Resolve unmerged files in `cwd` (mid-merge) by registry order; first matching rule wins.
// Returns {resolved:[files], leftovers:[files]}; resolved files are written and `git add`ed.
export async function resolveConflicts({ cwd = process.cwd(), resolvers = [] } = {}) {
  const rules = resolvers.length ? resolvers : DEFAULT_RESOLVERS;
  const files = sh('git', ['diff', '--name-only', '--diff-filter=U'], { cwd }).stdout.split('\n').filter(Boolean);
  const resolved = [], leftovers = [];
  for (const f of files) {
    const rule = rules.find((r) => matches(r.match, f));
    if (!rule || !STRATEGIES.includes(rule.strategy)) { leftovers.push(f); continue; }
    const fn = await load(rule.strategy);
    const out = fn({ file: f, base: stage(cwd, 1, f), ours: stage(cwd, 2, f), theirs: stage(cwd, 3, f), opts: rule });
    if (out == null) { leftovers.push(f); continue; }
    fs.writeFileSync(path.join(cwd, f), out);
    sh('git', ['add', '--', f], { cwd });
    resolved.push(f);
  }
  return { resolved, leftovers };
}
