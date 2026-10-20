// Managed blocks: relay-owned regions inside files that also hold user content. Content outside a block is never touched.
import crypto from 'node:crypto';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const marks = (name, style) => style === 'hash'
  ? [`# relay:begin ${name}`, `# relay:end ${name}`]
  : [`<!-- relay:begin ${name} -->`, `<!-- relay:end ${name} -->`];

// Locate a block. Returns {start, end, body} where [start,end) spans from the begin marker through the end marker's line break.
export function findBlock(text, name, style = 'html') {
  const [b, e] = marks(name, style);
  const s = text.indexOf(b);
  if (s < 0) return null;
  const eIdx = text.indexOf(e, s);
  if (eIdx < 0) return null;
  let end = eIdx + e.length;
  if (text[end] === '\n') end++;
  return { start: s, end, body: text.slice(s, end) };
}

export function wrap(name, body, style = 'html') {
  const [b, e] = marks(name, style);
  const inner = body.replace(/^<!-- relay:begin [^>]*-->\n?/, '').replace(/<!-- relay:end [^>]*-->\n?$/, '').replace(/\n+$/, '');
  return `${b}\n${inner}\n${e}\n`;
}

// Insert or replace a block. Returns {text, prefix, changed}; prefix is exactly what was added before a new block
// (so removal restores the original bytes).
export function upsertBlock(text, name, body, style = 'html') {
  const block = wrap(name, body, style);
  const cur = text == null ? null : findBlock(text, name, style);
  if (cur) {
    const next = text.slice(0, cur.start) + block + text.slice(cur.end);
    return { text: next, prefix: null, changed: next !== text };
  }
  if (text == null || text === '') return { text: block, prefix: '', changed: true };
  const prefix = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: text + prefix + block, prefix, changed: true };
}

// Remove a block (and the separator we added). Returns {text, removed}.
export function removeBlock(text, name, style = 'html', prefix = '') {
  const cur = findBlock(text, name, style);
  if (!cur) return { text, removed: false };
  let start = cur.start;
  if (prefix && text.slice(start - prefix.length, start) === prefix) start -= prefix.length;
  return { text: text.slice(0, start) + text.slice(cur.end), removed: true };
}

// ---- JSON deep merge with a revert record -------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Merge patch into obj. Returns {value, record:[{path, had, previous}]} where record lets revertJson undo exactly the keys we set.
export function mergeJson(obj, patch, pathPrefix = []) {
  const value = structuredClone(obj ?? {});
  const record = [];
  const walk = (target, p, keys) => {
    for (const [k, v] of Object.entries(p)) {
      const here = [...keys, k];
      if (isObj(v) && isObj(target[k])) walk(target[k], v, here);
      else if (isObj(v) && target[k] === undefined) { target[k] = {}; record.push({ path: here, had: false, container: true }); walk(target[k], v, here); }
      else if (!eq(target[k], v)) { record.push({ path: here, had: k in target, previous: target[k] }); target[k] = v; }
    }
  };
  walk(value, patch, pathPrefix);
  return { value, record };
}

export function revertJson(obj, record) {
  const value = structuredClone(obj ?? {});
  for (const r of [...record].reverse()) {
    let t = value;
    for (const k of r.path.slice(0, -1)) { t = t?.[k]; if (t == null) break; }
    if (t == null) continue;
    const last = r.path.at(-1);
    if (r.container) { if (isObj(t[last]) && !Object.keys(t[last]).length) delete t[last]; }
    else if (r.had) t[last] = r.previous; else delete t[last];
  }
  return value;
}
