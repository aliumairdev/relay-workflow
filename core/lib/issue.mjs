// Small parsers over issue/PR text (issue template sections, Closes #N).
export function section(body, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im');
  const m = re.exec(String(body || ''));
  return m ? m[1].trim() : '';
}
// Owned paths: globs from the "Owned Paths" section (bullets, commas, backticks; placeholders ignored).
export function parseOwnedPaths(body) {
  return section(body, 'Owned Paths').split(/[\n,]/).map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/[`]/g, '').trim())
    .filter((l) => l && !/^<.*>$/.test(l) && !/^\(.*\)$/.test(l) && !/^(none|n\/a)$/i.test(l));
}
export const closesIssue = (prBody) => { const m = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(prBody || '')); return m ? Number(m[1]) : null; };
export const runtimeFromBranch = (branch) => (/^agent\/([^/]+)\//.exec(branch || '') || [])[1] || null;
