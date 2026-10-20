// Locale-style JSON: keep every key from both sides (ours first, then theirs-only); ours wins a scalar clash.
import { deepMerge, strip, header } from './json-deep-merge.mjs';

export function resolve({ ours, theirs }) {
  try {
    return (header(ours) || header(theirs)) + JSON.stringify(deepMerge(JSON.parse(strip(ours)), JSON.parse(strip(theirs)), []), null, 2) + '\n';
  } catch { return null; }
}
