---
name: design-before-code
description: Use when an issue builds or changes user interface, before any UI code is written; requires a design spec and a visual review.
---

# Design before code

Applies only to UI issues (add-on pack). Backend-only work skips this.

1. Before coding, read the project's master design spec and the page or component spec the issue names. A UI issue without a spec reference is refused at dispatch (exit 8); ask the orchestrator to add one.
2. Build to the spec exactly. Reuse existing components and tokens; do not invent a palette or pattern.
3. Self-review at 375, 768 and 1440 px, in light and dark modes. Check focus order and visible focus, error and empty states, long content.
4. List deviations from the spec in the PR; unlisted deviations are review findings.
5. Reviewers judge functional, responsive, accessibility, UX and visual quality. Reject prototype-looking traits: a centred hero over three identical cards, repetitive grids, decorative gradient blobs, oversized rounded cards, pill overuse, placeholder copy.
6. Screenshots: only the viewports and states needed; prefer DOM and accessibility assertions as evidence.

Keep the issue journal current: `plan` names the spec sections, `test` lists the viewport and mode checks ([issue-journal](../issue-journal/SKILL.md)).
