---
name: issue-journal
description: Use when working on, reviewing, handing off or finishing a tracked issue, so its history and implementation notes stay current for the next agent and the owner.
---

# Issue journal

Every issue keeps one living **Implementation log** comment. You write to it with `relay-journal`; never paste long reports into the thread instead.

## When to write

| Moment | Kind | Content |
|---|---|---|
| After claiming, before code | `plan` | approach, files, checks you will run |
| Each pushed milestone | `progress` | what now works, branch head |
| A choice others must know | `decision` | decision and why |
| After each validation run | `test` | command → result line (real output only) |
| The moment you are stuck | `blocker` | exact blocker, what you tried |
| PR opened | `pr` | URL, one-line outcome |
| Each review round | `review` / `rework` | result, top findings, what you changed |
| Before your final report | `summary` | what changed, evidence, NOT_VERIFIED, follow-ups |

Claims, handoffs and lease expiry are logged automatically.

## Rules

- Command: `relay-journal post <issue> --kind <kind> --text "<up to 3 lines>"`. Entries are limited to 1200 characters; detail belongs in commits and the PR.
- Write facts, not intentions. Never log a check as passed unless you ran it; unrun items go in the `summary` under NOT_VERIFIED.
- Read before you start: `relay-journal read <issue>` shows what earlier agents did, decided and left open. After a handoff or takeover this is your first read, together with the handoff comment.
- `relay-journal check <issue>` reports missing required kinds (default `plan`, `summary`; configurable under `journal.require` in `workflow.yaml`). The merge queue refuses a PR whose issue journal is incomplete.
- Do not edit or delete other agents' entries. Correct a mistake with a new entry.
