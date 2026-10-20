---
name: token-discipline
description: Use when starting any task, to keep reading, tool output and reports small and in scope.
---

# Token discipline

TOKEN DISCIPLINE (mandatory):
- Search before reading: `rg -n <pattern>` / `rg --files`; read files with line ranges — never cat whole large files, lockfiles, generated output (tools/preview/out, test-results), or full git history.
- Read only AGENTS.md + your issue + the specific doc section it links; don't re-read files already in context.
- Diffs: `gh pr diff <n> --name-only` first, then per-file diffs only.
- Pipe noisy output through `tail -20` / `grep -E 'fail|error|pass'`; run `npm ci` once per worktree; don't re-run passing checks unless code changed.
- Screenshots: only 1–4 needed viewports/states; prefer DOM/axe assertions.
- No out-of-scope work. Reports ≤120 words, no pasted code/diffs.


These rules are injected into every rendered brief. Apply them in review too: read diffs by name first, then per file. Reports stay within the word limit given in your brief.
