import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CORE } from './config.mjs';
import { globToRegExp } from './glob.mjs';

export const profileDir = (stack) => path.join(CORE, 'profiles', stack);
export const listProfiles = () => fs.readdirSync(path.join(CORE, 'profiles'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(CORE, 'profiles', e.name, 'profile.yaml'))).map((e) => e.name).sort();

export function loadProfile(stack) {
  if (!stack) return null;
  const f = path.join(profileDir(stack), 'profile.yaml');
  return fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8')) : null;
}
export function loadLessons(stack) {
  const p = loadProfile(stack);
  if (!p?.lessons) return [];
  const f = path.join(profileDir(stack), p.lessons);
  return fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8')).lessons || [] : [];
}

// Lint rule modules for a profile: checks/*.mjs exporting {id, description, globs, check(text, file)}.
export async function loadRules(stack) {
  const dir = path.join(profileDir(stack), 'checks');
  if (!fs.existsSync(dir)) return [];
  const rules = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.startsWith('_')).sort()) {
    const m = await import(path.join(dir, f));
    if (m.id && m.check) rules.push(m);
  }
  return rules;
}

// Run rules over a directory tree. Returns [{rule, file, line, message}].
export async function runRules(stack, root, { only = null } = {}) {
  const rules = (await loadRules(stack)).filter((r) => !only || only.includes(r.id));
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'))
    .filter((f) => !/(^|\/)(node_modules|\.git|\.relay)\//.test(f));
  const out = [];
  for (const r of rules) {
    const res = (r.globs || ['**/*']).map(globToRegExp);
    for (const f of files.filter((x) => res.some((re) => re.test(x)))) {
      let text; try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
      for (const v of r.check(text, f)) out.push({ rule: r.id, file: f, line: v.line, message: v.message });
    }
  }
  return out;
}
