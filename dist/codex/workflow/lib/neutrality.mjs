// Neutrality lint: the shared AGENTS.md contract names tiers, never concrete model ids.
const MODEL_ID = [
  /\bclaude-(?:haiku|sonnet|opus|fable|instant|\d)[\w.-]*/gi,
  /\b(?:gpt|o[1-9])-?[\w.-]*\d[\w.-]*/gi,
  /\bgemini-[\w.-]*\d[\w.-]*/gi,
  /\b(?:codex|gpt)-(?:mini|max|high|low)[\w.-]*/gi,
];
export function modelIds(text) {
  const found = new Set();
  for (const re of MODEL_ID) for (const m of text.matchAll(re)) found.add(m[0]);
  return [...found];
}
export const isNeutral = (text) => modelIds(text).length === 0;
