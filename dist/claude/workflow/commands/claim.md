---
description: Claim an issue for the current agent
argument-hint: "<issue> [--ack-handoff sha]"
allowed-tools: Bash(relay-claim:*), Bash(relay-worktree:*), Bash(relay-journal:*), Bash(relay-handoff:*)
---

Arguments: $ARGUMENTS

1. If the issue carries a `handoff:to-*` label, read it first: `relay-handoff read <issue>`; pass its `sha` as `--ack-handoff`.
2. Run `relay-claim $ARGUMENTS --agent "$RELAY_AGENT_ID" --runtime <your runtime>`.
3. Exit 0: run `relay-worktree create <issue> --runtime <rt>`, `cd` into the printed path, run `relay-worktree verify`, then post your plan with `relay-journal post <issue> --kind plan --text "..."`.
4. Exit 7 (refused: already claimed, overlap, handoff not acknowledged, wrong owner label): stop and report the stated reason. Do not retry in a loop.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
