// L5: only one link_list setting per section schema.
import { readSchema, allSettings } from './_schema.mjs';
export const id = 'schema-link-list-once';
export const description = 'more than one link_list setting in a section schema';
export const globs = ['sections/*.liquid'];

export function check(text) {
  const s = readSchema(text);
  if (!s) return [];
  const n = allSettings(s).filter((x) => x.type === 'link_list').length;
  return n > 1 ? [{ line: s.line, message: `${n} link_list settings in one section; the platform allows one` }] : [];
}
