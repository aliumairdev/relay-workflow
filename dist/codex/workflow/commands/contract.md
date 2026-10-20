---
description: Show, gate or update the issue contract (the complete work contract of an issue)
argument-hint: "show|check|update|mark|close|reconcile|sweep <issue> [...]"
allowed-tools: Bash(relay-contract:*), Bash(relay-journal:*), Bash(relay-qa:*), Read
---

Arguments: $ARGUMENTS

1. `relay-contract show <issue>` lists every accepted requirement with its disposition; `relay-contract check <issue>` exits 0 only when the WHOLE contract is satisfied (exit 4 = closure denied, with the unresolved ids).
2. Record proof: `relay-contract mark <issue> <ID> PASS|FIXED_AND_VERIFIED|... --evidence test:"cmd → result" --evidence runtime:<path>`. Required tests and runtime proof are enforced; follow-ups and "works now, not sure why" are refused.
3. Issue edited meanwhile: `relay-contract update <issue>` (new requirements become yours). Closed on GitHub but incomplete: `relay-contract reconcile <issue>` (reopens) or `relay-contract sweep`.
4. Finish: `relay-journal check <issue> --final`, then `relay-contract close <issue>` (audit, then close). Never close an issue any other way.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
