// JSON (optionally with a leading /* comment */ header): objects deep-merged, ours wins scalars,
// order arrays (opts.order_keys, default order/block_order) unioned keeping ours order, theirs-only ids
// inserted after their nearest preceding id from theirs.
const HEADER = /^\s*\/\*[\s\S]*?\*\/\s*/;
export const strip = (s) => s.replace(HEADER, '');
export const header = (s) => (s.match(HEADER) || [''])[0];

export function unionOrder(a = [], b = []) {
  const out = [...a];
  b.forEach((id, i) => {
    if (out.includes(id)) return;
    let j = i - 1;
    while (j >= 0 && !out.includes(b[j])) j--;
    out.splice(j >= 0 ? out.indexOf(b[j]) + 1 : out.length, 0, id);
  });
  return out;
}

export function deepMerge(a, b, orderKeys) {
  if (Array.isArray(a) || Array.isArray(b)) return a ?? b;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const o = { ...a };
    for (const k of Object.keys(b)) {
      if (!(k in a)) o[k] = b[k];
      else if (orderKeys.includes(k) && Array.isArray(a[k]) && Array.isArray(b[k])) o[k] = unionOrder(a[k], b[k]);
      else o[k] = deepMerge(a[k], b[k], orderKeys);
    }
    return o;
  }
  return a ?? b;
}

export function resolve({ ours, theirs, opts = {} }) {
  const orderKeys = opts.order_keys || ['order', 'block_order'];
  try {
    const merged = deepMerge(JSON.parse(strip(ours)), JSON.parse(strip(theirs)), orderKeys);
    return (header(ours) || header(theirs)) + JSON.stringify(merged, null, 2) + '\n';
  } catch { return null; }
}
