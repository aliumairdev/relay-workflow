---
description: Explain or override the tier, model and runtime for an issue or PR
argument-hint: "<issue|pr> [--explain] [--tier T] [--runtime R] [--reason text]"
allowed-tools: Bash(relay-route:*), Bash(relay-labels:*)
---

Arguments: $ARGUMENTS

1. Run `relay-route $ARGUMENTS --json` (add `--explain` for the signals table).
2. Show tier, runtime, effort, second-reviewer and packet flags with the reasons.
3. An override needs `--tier`/`--runtime` and a `--reason`; it adds the `route:T*` label and is logged. Exit 8 means a budget cap denied it; show the suggested fallback instead of forcing.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
