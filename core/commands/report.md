---
description: Report cost per merged PR, tier mix, rework and routing proposals
argument-hint: "[--since 7d]"
allowed-tools: Bash(relay-report:*), Bash(relay-route:*)
---

Arguments: $ARGUMENTS

1. Run `relay-report $ARGUMENTS --json`.
2. Present cost per merged PR, tier mix against the budget caps, rework rounds by tier, rate-limit counts.
3. Run `relay-route --propose` and list proposals; they apply only if the owner edits `workflow.yaml`. Mark estimated token counts as estimated.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
