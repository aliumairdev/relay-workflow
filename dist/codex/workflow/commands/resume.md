---
description: Rebuild orchestrator context after a restart or compaction
argument-hint: ""
allowed-tools: Bash(relay-resume:*), Bash(relay-lease:*), Bash(relay-state:*), Bash(relay-journal:*), Read
---

Recovery order, strictly:

1. Read AGENTS.md, then `harness/STATE.json` via `relay-state get`.
2. `relay-state rebuild --dry-run` and compare with the cached claims; rebuild if they differ.
3. `relay-lease sweep`.
4. List ready issues, PRs in review, owner decisions and issue contracts with unresolved requirements (a merged PR is not a finished issue); run `relay-contract sweep` for issues closed outside the gate; run `relay-resume --brief` if available.
5. For each in-flight issue read `relay-journal read <issue>` before acting. Report in 10 lines and continue the orchestrate loop.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
