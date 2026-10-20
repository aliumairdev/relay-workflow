// Packet builder: bounded context for expensive tiers (ARCHITECTURE 3.4).
import { RelayError, EXIT } from './exit.mjs';

export const SECTIONS = {
  decision: ['Problem', 'Relevant architecture', 'Files', 'Constraints', 'What was tried', 'Options', 'Recommendation', 'Exact decision requested'],
  review: ['PR', 'Diff stat', 'Risky hunks', 'Acceptance criteria', 'Evidence', 'NOT_VERIFIED'],
};
export const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

export function countSections(sections) {
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, words(v)]));
}

// Returns {text, words, counts}; throws RelayError(EXIT.INVALID) naming the largest section when oversize.
export function buildPacket({ kind = 'decision', target = '', sections }, maxWords = 500) {
  const order = SECTIONS[kind];
  if (!order) throw new RelayError(`unknown packet kind ${kind}`, EXIT.INVALID);
  const unknown = Object.keys(sections).filter((k) => !order.includes(k));
  if (unknown.length) throw new RelayError(`unknown packet section(s): ${unknown.join(', ')} (allowed: ${order.join(', ')})`, EXIT.INVALID);
  const missing = order.filter((k) => !words(sections[k]));
  if (missing.length) throw new RelayError(`packet is missing section(s): ${missing.join(', ')}`, EXIT.INVALID, { missing });
  const counts = countSections(sections);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > maxWords) {
    const [big, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    throw new RelayError(`packet is ${total} words, limit ${maxWords}; cut "${big}" (${n} words). Sections: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`, EXIT.INVALID, { total, counts, largest: big });
  }
  const text = order.map((k) => `## ${k}\n${String(sections[k]).trim()}`).join('\n\n') + '\n';
  return { text, words: total, counts };
}
