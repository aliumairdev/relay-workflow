---
description: Show claims, leases, PRs, merge queue, decisions, tier mix and load
argument-hint: "[--json]"
allowed-tools: Bash(relay-status:*), Bash(relay-state:*), Bash(relay-governor:*), Bash(relay-lease:*)
---

Arguments: $ARGUMENTS

1. Run `relay-status $ARGUMENTS`; if unavailable, combine `relay-state claims`, `relay-lease sweep --dry-run` and `relay-governor sample-load`.
2. Summarise in at most 15 lines: active claims with lease times, PRs by state, queue, owner decisions, issue contracts (state, `Contract: x/y complete`, PRs merged, runtime proof, remaining ids), tier mix, load, last proof. States: IN_IMPLEMENTATION, IN_REVIEW, MERGED_AWAITING_PROOF, PARTIALLY_SATISFIED, BLOCKED_EXTERNAL, CONTRACT_COMPLETE, GITHUB_CLOSED_CONTRACT_INCOMPLETE (shout about the last one: run `relay-contract reconcile <issue>`).
3. Flag expired leases, label violations and unanswered bot comments as action items.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
