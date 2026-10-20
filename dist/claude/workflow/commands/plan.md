---
description: Decompose a spec or goal into milestones and labelled issues
argument-hint: "<spec path or goal>"
allowed-tools: Bash(relay-gh:*), Bash(relay-route:*), Bash(relay-issues-create:*), Bash(relay-labels:*), Bash(relay-journal:*), Read, Grep
---

Input: $ARGUMENTS

1. Read the spec (search first, read with line ranges). Run `relay-route` for the plan task class to pick the tier; use the planner agent.
2. Draft issues with the project issue template: objective, acceptance criteria, owned paths, dependencies, validation, risk. Keep each issue one reviewable slice.
3. Show the draft. Create issues only after the user agrees: `relay-issues-create <plan.json>`; labels via `relay-labels` (`agent:claude|codex|any`, `priority:*`, `area:*`, `type:*`).
4. Keep at least `plan.min_ready` issues at `state:ready`; mark blocked ones `state:backlog`.
5. Report issue numbers, dependency order, and decisions only the owner can make (see the owner-decisions skill).

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
