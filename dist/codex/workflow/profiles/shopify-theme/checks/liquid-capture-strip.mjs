// L1: a captured string must be stripped before it is compared or used in arithmetic.
export const id = 'liquid-capture-strip';
export const description = 'Liquid capture output used in a comparison or math filter without | strip';
export const globs = ['**/*.liquid'];
const MATH = '(?:plus|minus|times|divided_by|modulo|round|floor|ceil|at_least|at_most|abs)';

export function check(text) {
  const out = [];
  const lines = text.split('\n');
  const stripped = new Set();
  for (const m of text.matchAll(/\{%-?\s*assign\s+(\w+)\s*=\s*\1\s*\|\s*strip\b/g)) stripped.add(m[1]);
  for (const m of text.matchAll(/\{%-?\s*capture\s+(\w+)\s*-?%\}/g)) {
    const name = m[1];
    if (stripped.has(name)) continue;
    const startLine = text.slice(0, m.index).split('\n').length;
    const uses = [new RegExp(`\\b${name}\\b\\s*(?:==|!=|>=|<=|>|<|contains)`), new RegExp(`(?<![\\w.])${name}\\s*\\|\\s*${MATH}\\b`)];
    for (let i = startLine; i < lines.length; i++) {
      if (uses.some((re) => re.test(lines[i])) && !new RegExp(`${name}\\s*\\|\\s*strip`).test(lines[i])) {
        out.push({ line: i + 1, message: `captured "${name}" is compared or used in math without | strip (whitespace from tags is kept on the platform)` });
        break;
      }
    }
  }
  return out;
}
