---
name: owner-decisions
description: Use when a decision only the human owner can make blocks part of the work, such as naming, URLs, credentials, deletions or scope.
---

# Owner decisions

What counts (category): `product-ambiguity`, `destructive-production`, `external-provider`, `conflicting-requirements`, `scope-change`, `business-choice` (names, URLs, credentials, deletions, spending). Technical choices, whether to finish a requirement, write another PR, investigate, or keep an incomplete issue open are yours: the [issue contract](../issue-contract/SKILL.md) already answers them.

1. Do not guess and do not block everything. Open it with all six facts or it is rejected: `relay-decision open <issue> --question "..." --options a,b --default a --category C --contract-gap "why the contract does not answer it" --evidence "what you checked" --unsafe-because "why proceeding is unsafe" [--requirement AC3]`. With `--requirement` only that item is parked and other work continues.
2. Use the decision template: question, options with consequences, default, deadline, who decides.
3. Release your claim or hand off with reason `owner_request`, then take other ready work.
4. Post a `blocker` entry in the issue journal naming the decision ([issue-journal](../issue-journal/SKILL.md)).
5. The orchestrator keeps working on everything else and stops only when owner decisions are all that remain. Notifications are status-only unless configured otherwise.
6. When answered, record the answer verbatim in the decision issue and the journal, then unblock (`state:ready`).

Never apply the default silently after the deadline without recording that you did.
