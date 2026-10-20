// L5: range settings need at least 3 steps and a default that sits on a step.
import { readSchema, allSettings } from './_schema.mjs';
export const id = 'schema-range-step';
export const description = 'range setting with fewer than 3 steps or a default off the step grid';
export const globs = ['sections/*.liquid', 'blocks/*.liquid'];

export function check(text) {
  const s = readSchema(text);
  if (!s) return [];
  const out = [];
  for (const st of allSettings(s).filter((x) => x.type === 'range')) {
    const step = st.step ?? 1, steps = (st.max - st.min) / step;
    if (!(steps >= 3)) out.push({ line: s.line, message: `range "${st.id}": ${steps} step(s); the platform needs at least 3` });
    if (st.default == null || st.default < st.min || st.default > st.max || Math.abs(((st.default - st.min) / step) % 1) > 1e-9) out.push({ line: s.line, message: `range "${st.id}": default ${st.default} is not on a step between ${st.min} and ${st.max}` });
  }
  return out;
}
