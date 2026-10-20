---
description: Route a reviewer, build a packet if needed, review a PR and post the verdict
argument-hint: "<pr> [--tier auto|T1|T2]"
allowed-tools: Bash(relay-route:*), Bash(relay-packet:*), Bash(relay-verdict:*), Bash(relay-ci:*), Bash(relay-bot-gate:*), Bash(relay-journal:*), Bash(relay-brief:*), Bash(gh:*), Read, Grep
---

Arguments: $ARGUMENTS

1. `relay-route <pr> --json`: it picks tier and a reviewer runtime different from the implementer when cross-review is on.
2. If `packet_required`, build it: `relay-packet build --pr <n>` (exit 3 = over the word limit; shorten the named section).
3. Render the review brief and review in a scratch worktree following the review-protocol skill. Run `relay-ci <branch>`.
4. Post: `relay-verdict post <pr> --result APPROVED|CHANGES --checklist <json>`. Exit 7 means you are not an allowed reviewer for this PR.
5. Log a `review` journal entry on the issue. Report result, numbered changes, NOT_VERIFIED items.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
