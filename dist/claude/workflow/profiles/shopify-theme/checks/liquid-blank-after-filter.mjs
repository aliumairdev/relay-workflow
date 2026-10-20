// L4: a value produced by a filter can be blank; render its wrapper only inside an `!= blank` guard.
export const id = 'liquid-blank-after-filter';
export const description = 'Filtered value rendered inside markup without an `!= blank` guard';
export const globs = ['**/*.liquid'];

export function check(text) {
  const out = [];
  const lines = text.split('\n');
  for (const m of text.matchAll(/\{%-?\s*assign\s+(\w+)\s*=\s*[^%]*\|\s*\w+[^%]*-?%\}/g)) {
    const name = m[1];
    const from = text.slice(0, m.index).split('\n').length;       // 1-based line of the assign
    const guard = new RegExp(`\\{%-?\\s*(?:if|unless)\\s+[^%]*\\b${name}\\b[^%]*(?:blank|empty|nil)`);
    for (let i = from; i < lines.length; i++) {
      const line = lines[i];
      if (new RegExp(`\\{\\{-?\\s*${name}\\b`).test(line) && /<\w[^>]*>[^<]*\{\{/.test(line)) {
        const window = lines.slice(Math.max(from - 1, i - 6), i + 1).join('\n');
        if (!guard.test(window)) out.push({ line: i + 1, message: `"${name}" comes from a filter and may be blank; wrap its markup in {% if ${name} != blank %}` });
        break;
      }
    }
  }
  return out;
}
