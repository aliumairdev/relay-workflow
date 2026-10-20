---
name: repo-cleanup
description: Use when removing dead code, docs, dependencies, tests, temporary files, branches or worktrees without losing data or evidence.
---

# Repository cleanup

List candidates and prove they are unused before removal. Stay in scope. Preserve unrelated changes, credentials, local runtime files, backups, retained evidence and all shared or production data.

Load only the relevant reference: [code](references/code.md), [dependencies](references/dependencies.md), [docs](references/docs.md), [tests](references/tests.md), [temporary files](references/tmp.md), [branches and worktrees](references/branches-and-worktrees.md).

Use existing authority for reversible edits and your own scratch files. Before deleting unique untracked data, unmerged work or another worktree, prepare the exact list and request only the missing authority. Run affected tests before and after refactors. Do not weaken accepted behaviour or delete useful assertions. Record removals, evidence and limits.
