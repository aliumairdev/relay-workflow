---
name: plan-to-pr
description: Use only when delegated plan-to-PR work is explicitly requested, to run bounded workers with independent review.
---

# Plan to PR

Starts only on an explicit request; editing this skill does not invoke delegation.

1. Inspect the issue, branch, release and contracts. Record requirement and acceptance IDs, intended behaviour, non-goals, sensitive boundaries and checks in the tracker or a linked plan.
2. Have a separate reviewer check the plan (a different runtime when cross-review is on). Resolve concrete findings first. If independent review cannot run, record the gate as missing.
3. Dispatch only independent tasks with clear file ownership: `/workflow:dispatch` (governor, router, brief). Workers claim with `relay-claim`, work in their own worktree, follow [feature-delivery](../feature-delivery/SKILL.md) and report real failing and passing results.
4. Inspect each actual diff and its evidence. Review with `relay-verdict`; fix findings and rerun checks. Do not accept summaries as proof or loop on reviews.
5. Update records, run required checks and let the merge queue (`relay-merge`) land a focused PR. Failed gates keep the PR draft and the task open.

Deployment, merchant-facing actions and messages to people keep separate authority. Do not re-ask for routine approval already given.
