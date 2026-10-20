// Shared: extract and parse the {% schema %} JSON of a section file.
export function readSchema(text) {
  const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(text);
  if (!m) return null;
  const line = text.slice(0, m.index).split('\n').length;
  try { return { data: JSON.parse(m[1]), line }; } catch { return null; }
}
export const allSettings = (schema) => [...(schema.data.settings || []), ...(schema.data.blocks || []).flatMap((b) => b.settings || [])];
