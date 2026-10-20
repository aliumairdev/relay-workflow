// One-entry-per-line files (module lists, import maps): union of lines, ours order kept, theirs-only lines
// inserted after their nearest preceding shared line; a line deleted by either side relative to base stays deleted.
import { unionOrder } from './json-deep-merge.mjs';

export function resolve({ base, ours, theirs }) {
  const split = (s) => s.split('\n');
  const [o, t, b] = [split(ours), split(theirs), split(base)];
  const dropped = new Set(b.filter((l) => l.trim() && (!o.includes(l) || !t.includes(l))));
  const merged = unionOrder(o, t).filter((l) => !dropped.has(l));
  return merged.join('\n');
}
