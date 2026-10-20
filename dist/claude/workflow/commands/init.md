---
description: Set up the workflow in this repository (config, contract files, labels, state)
argument-hint: "[--stack <profile>] [--runtime claude,codex] [--dry-run]"
allowed-tools: Bash(relay-init:*), Bash(relay-doctor:*), Bash(relay-labels:*), Read
---

Arguments: $ARGUMENTS

1. Run `relay-init --dry-run $ARGUMENTS` first and show the planned file diff. Existing AGENTS.md and CLAUDE.md content outside managed blocks must be preserved.
2. If the diff is acceptable (or the user asked to proceed), run `relay-init $ARGUMENTS --yes`.
3. Run `relay-labels ensure`, then `relay-doctor`.
4. Report files created, labels created, and every doctor check that is not green.

Exit codes: 0 done, 3 invalid config (fix `workflow.yaml` at the reported path/line), 9 environment problem (missing `gh` login, no git remote).

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
