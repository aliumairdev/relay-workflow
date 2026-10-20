---
name: feature-delivery
description: Use when implementing or fixing a product feature that needs requirement mapping, tests and release checks.
---

# Deliver a product change

Read the project's AGENTS.md and the applicable folder guides. This skill follows the authorised task; it does not start the next release or grant live access. For a clear task start after one short update.

**Define the work.** Find the task in the tracker (or add one with a stable ID, expected behaviour, requirement IDs and acceptance checks). Read the related spec sections. Inspect existing code and tests before choosing a design; do not assume planned classes exist. Identify the module that owns the write. If a missing decision affects money, rights or authority, record the blocker and continue independent work.

**Build the smallest complete change.**
1. Write and run a failing test first ([test-driven-development](../test-driven-development/SKILL.md)), including the relevant denial or failure case.
2. Implement with the existing patterns; keep external effects behind their owner.
3. Schema work: enforce tenant and money constraints in the database and plan a safe rollout ([migration](../migration/SKILL.md)).
4. Provider work: check current official docs, pin the version, use synthetic fixtures until the capability is certified.
5. Rerun, refactor green, run the wider checks for the boundary.

Never use model output as policy, money arithmetic, SQL or code. Do not hold database locks across network calls; a timeout means reconcile, not a second mutation.

**Finish.** Review the diff and failure paths, apply [boundary-review](../boundary-review/SKILL.md) when sensitive, update records ([project-records](../project-records/SKILL.md)). Report behaviour, checks, results and limits. A tested local change does not prove certification or a release.
