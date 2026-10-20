---
name: project-records
description: Use when an implementation or documentation change is done and you must keep the task tracker, changelog, notes and verification evidence current.
---

# Keep project records current

File names come from the project's AGENTS.md (defaults: `TODO.md`, `CHANGELOG.md`, `docs/`). Read the documentation guide and the relevant notes first. Keep technical names and requirement IDs exact.

1. **Tracker:** add or update the task ID, state, requirement IDs, next step and evidence. Tick a box only when its stated acceptance is met; a blocked external gate stays open.
2. **Changelog:** completed changes under `Unreleased`, grouped Added / Changed / Fixed / Security. No planned work, invented releases, log dumps or private data.
3. **Notes:** update the existing feature, decision or runbook note; create one only if it has no home, and link it from a reachable page.
4. **Evidence:** record the failing test before and the passing rerun after, with command, result, environment and date. Label local, CI, sandbox and production evidence separately. Write "not run" for missing checks.
5. **Issue history:** every issue worked on keeps its journal current: [issue-journal](../issue-journal/SKILL.md).

Do not rewrite the product baseline during navigation or formatting work; a baseline change needs its version, traceability and decision record updated together. Planned commands stay labelled as planned.

Check links, anchors, IDs and duplicates, and review for secrets and personal data. For read-only tasks check whether records need changes but create no empty entries. Documentation explains controls; it does not prove they exist at runtime.
