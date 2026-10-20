---
description: Show claims, leases, PRs, merge queue, decisions, tier mix and load
argument-hint: "[--json]"
allowed-tools: Bash(relay-status:*), Bash(relay-state:*), Bash(relay-governor:*), Bash(relay-lease:*)
---

Arguments: $ARGUMENTS

1. Run `relay-status $ARGUMENTS`; if unavailable, combine `relay-state claims`, `relay-lease sweep --dry-run` and `relay-governor sample-load`.
2. Summarise in at most 15 lines: active claims with lease times, PRs by state, queue, owner decisions, tier mix, load, last proof.
3. Flag expired leases, label violations and unanswered bot comments as action items.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
