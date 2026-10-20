---
description: Admit, brief and launch agents on ready issues
argument-hint: "[issue...] [--runtime claude|codex|any] [--wave N]"
allowed-tools: Bash(relay-governor:*), Bash(relay-route:*), Bash(relay-brief:*), Bash(relay-claim:*), Bash(relay-codex-dispatch:*), Bash(relay-ledger:*), Bash(relay-gh:*), Bash(relay-lease:*)
---

Arguments: $ARGUMENTS

1. Run `relay-lease sweep`. Pick the named issues, or up to the wave size of `state:ready` issues with no live claim.
2. For each: `relay-route <issue> --json`, then `relay-governor admit --run <json>`. Exit 0 admit, 10 wait (report `retry_after_s`, do not loop), 11 deny (report the reason; never bypass).
3. Render the brief: `relay-brief render dispatch --var issue=<n> --var runtime=<rt> ...`.
4. Launch: Claude runtime via the matching subagent; Codex via `relay-codex-dispatch <issue>`. The agent claims the issue itself.
5. Report per issue: runtime, tier, run id, or the reason it was not dispatched. Never double-dispatch an issue with a live claim.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
