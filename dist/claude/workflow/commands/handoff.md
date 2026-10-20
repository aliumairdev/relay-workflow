---
description: Hand work to another runtime or a human and release the claim
argument-hint: "<issue> --to claude|codex|human --reason <reason>"
allowed-tools: Bash(relay-handoff:*), Bash(relay-journal:*), Bash(relay-lease:*), Bash(git:*), Read
---

Arguments: $ARGUMENTS

1. Commit your work. Uncommitted changes block a handoff (exit 9).
2. Write a handoff JSON file (done, remaining, decisions, next_steps, risks, not_verified, tests_run with real results).
3. Run `relay-handoff post $ARGUMENTS --from-file <file>`. Exit 3 means the record is invalid; fix the named fields.
4. Report the printed handoff sha; the receiver needs it as `--ack-handoff`. Reasons: rate_limited, capability, review_rework, owner_request, lease_takeover.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
