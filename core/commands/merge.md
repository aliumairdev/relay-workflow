---
description: Run the merge queue for approved PRs (gated or fast per policy mode)
argument-hint: "<pr:issue>... | --stack <pr:issue>..."
allowed-tools: Bash(relay-merge:*), Bash(relay-quick-merge:*), Bash(relay-merge-stack:*), Bash(relay-journal:*), Bash(relay-state:*)
---

Arguments: $ARGUMENTS

1. Read the mode: `relay-state get policy.mode`.
2. For each issue run `relay-journal check <issue>`; if incomplete, have the owning agent complete it first.
3. gated: `relay-merge $ARGUMENTS`; fast: `relay-quick-merge $ARGUMENTS`; stacked PRs: `relay-merge-stack $ARGUMENTS`.
4. Output per PR is `MERGED` or `SKIP (reason)`. Reasons: sync failed, local CI failed, N unanswered bot comments, env check failed, no verdict for head sha, budget denied. Report each reason; never force a merge past a gate.
5. Merged is not verified: say so unless a proof stage passed.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
