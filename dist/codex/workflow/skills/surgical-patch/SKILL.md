---
name: surgical-patch
description: Use when fixing a bug at the narrowest responsible layer with test-first regression proof.
---

# Surgical patch

Do a short [problem-finding](../problem-finding/SKILL.md) symptom check. Read local guides and existing tests. Write and run a failing regression test before changing behaviour, then make the smallest complete change and rerun the focused checks.

Preserve unrelated behaviour, other people's changes and safety gates. Cover each changed layer (unit, request or system test where relevant). Use synthetic data and stub external services. Run related tenant, auth, job or money regressions for those boundaries, and [boundary-review](../boundary-review/SKILL.md) for sensitive paths.

Keep broader cleanup and deferred features out of the fix. Update the records ([project-records](../project-records/SKILL.md)). A missing required check stays an open completion gap.
