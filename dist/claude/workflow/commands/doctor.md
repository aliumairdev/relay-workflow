---
description: Self-check the installation and optionally repair
argument-hint: "[--fix]"
allowed-tools: Bash(relay-doctor:*), Read
---

Arguments: $ARGUMENTS

1. Run `relay-doctor $ARGUMENTS --json`.
2. List each failing check with its fix. Without `--fix` change nothing.
3. With `--fix`, report exactly which files were changed. Checks you could not run are NOT_VERIFIED.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
