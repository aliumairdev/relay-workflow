// L6: braces inside a quoted string within a Liquid output/tag break parsing on the platform.
export const id = 'liquid-braces-in-strings';
export const description = 'curly brace inside a quoted string within {{ }} or {% %}';
export const globs = ['**/*.liquid'];

// Scan each tag respecting quotes (a regex stops at the very brace we are looking for).
export function check(text) {
  const out = [];
  const line = (idx) => text.slice(0, idx).split('\n').length;
  for (let i = 0; i < text.length - 1; i++) {
    const open = text.slice(i, i + 2);
    if (open !== '{{' && open !== '{%') continue;
    const close = open === '{{' ? '}}' : '%}';
    let j = i + 2, flagged = false;
    while (j < text.length) {
      const c = text[j];
      if (c === '"' || c === "'") {
        const end = text.indexOf(c, j + 1);
        if (end < 0) break;
        if (/[{}]/.test(text.slice(j + 1, end))) flagged = true;
        j = end + 1; continue;
      }
      if (text.startsWith(close, j)) break;
      j++;
    }
    if (flagged) out.push({ line: line(i), message: 'brace inside a quoted string in a Liquid tag: build the string with concat/append or move it to a snippet' });
    i = Math.max(i + 1, j);
  }
  return out;
}
