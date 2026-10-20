---
name: adversarial-review
description: Use when a substantial plan or diff needs a hostile read for concrete failures, missing evidence and unsafe boundaries before it is called done.
---

# Adversarial review

Review the accepted requirements, the final diff and the test evidence. Hunt for concrete failures: cross-tenant access, stale approvals, duplicate effects, unknown outcomes, money errors, privacy gaps and incorrect completion claims. Use [boundary-review](../boundary-review/SKILL.md) for sensitive paths.

1. Give the reviewer requirement IDs, allowed scope, the diff and the checks that ran. Keep secrets and customer data out of the hand-off.
2. Ask for findings with file and line evidence. If an independent reviewer is required, use `relay-verdict` with a reviewer from a different runtime when cross-review is on.
3. Resolve each finding with a fix and a rerun, or an evidence-based reason. Bound repeat reviews to material changes.
4. Report confirmed findings, cleared risks and remaining limits.

Never claim a review ran if it did not. When a required review is unavailable, record it as missing evidence (NOT_VERIFIED). Delegate to another agent only when explicitly requested.
