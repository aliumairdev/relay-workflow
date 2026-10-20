// Minimal glob: * (no slash), ** (any depth), ? , {a,b}, [abc]. Paths use forward slashes.
export function globToRegExp(glob) {
  let re = '', i = 0, brace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i++; }
    } else if (c === '?') { re += '[^/]'; i++; }
    else if (c === '{') { re += '(?:'; brace++; i++; }
    else if (c === '}' && brace) { re += ')'; brace--; i++; }
    else if (c === ',' && brace) { re += '|'; i++; }
    else if (c === '[') { const j = glob.indexOf(']', i); if (j < 0) { re += '\\['; i++; } else { re += glob.slice(i, j + 1); i = j + 1; } }
    else { re += c.replace(/[.+^$()|\\]/g, '\\$&'); i++; }
  }
  return new RegExp(`^${re}$`);
}
const cache = new Map();
export function matches(glob, p) {
  let r = cache.get(glob); if (!r) { r = globToRegExp(glob); cache.set(glob, r); }
  return r.test(p.replace(/^\.\//, ''));
}
export const matchesAny = (globs, p) => globs.some((g) => matches(g, p));

// Static prefix up to the first wildcard (for conservative overlap tests).
export function staticPrefix(glob) {
  const m = glob.search(/[*?{[]/);
  return m < 0 ? glob : glob.slice(0, m);
}
// Could two globs match a common path? Conservative: prefix containment.
export function globsOverlap(a, b) {
  const pa = staticPrefix(a), pb = staticPrefix(b);
  if (!pa.includes('/') && pa === a && !pb.includes('/') && pb === b) return a === b;
  return pa.startsWith(pb) || pb.startsWith(pa);
}
