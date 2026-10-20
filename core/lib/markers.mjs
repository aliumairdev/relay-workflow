// Machine markers in comments: <!-- relay:<type> {json} --> followed by human text.
const RE = /<!--\s*relay:([a-z-]+)\s+(\{[\s\S]*?\})\s*-->/g;

export function embed(type, obj, human = '') {
  const json = JSON.stringify(obj).replace(/--/g, '\\u002d\\u002d');
  return `<!-- relay:${type} ${json} -->${human ? `\n${human}` : ''}`;
}

export function extract(body, type) {
  const found = [];
  for (const m of String(body || '').matchAll(RE)) {
    if (type && m[1] !== type) continue;
    try { found.push({ type: m[1], data: JSON.parse(m[2]) }); } catch { /* ignore malformed */ }
  }
  return found;
}
