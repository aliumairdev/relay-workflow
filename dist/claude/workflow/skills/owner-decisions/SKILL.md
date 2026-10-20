---
name: owner-decisions
description: Use when a decision only the human owner can make blocks part of the work, such as naming, URLs, credentials, deletions or scope.
---

# Owner decisions

What counts: names, public URLs, passwords and secrets, deletions, spending, scope or policy changes. Technical choices within the issue are yours to make and journal.

1. Do not guess and do not block everything. Open the decision: `relay-decision open <issue> --question "..." --options a,b --default a [--deadline D]`. It creates an `owner-decision` issue and blocks only the affected work item.
2. Use the decision template: question, options with consequences, default, deadline, who decides.
3. Release your claim or hand off with reason `owner_request`, then take other ready work.
4. Post a `blocker` entry in the issue journal naming the decision ([issue-journal](../issue-journal/SKILL.md)).
5. The orchestrator keeps working on everything else and stops only when owner decisions are all that remain. Notifications are status-only unless configured otherwise.
6. When answered, record the answer verbatim in the decision issue and the journal, then unblock (`state:ready`).

Never apply the default silently after the deadline without recording that you did.
