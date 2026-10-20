---
name: feature-manager
description: Use when coordinating one bounded feature end to end: scope, tests, records and a focused PR.
---

# Feature manager

Read the current task and its boundary. Map the feature to requirement and acceptance IDs. Identify the smallest complete change and its focused checks. Preserve unrelated working changes.

- Ordinary task: implement serially with [feature-delivery](../feature-delivery/SKILL.md) and [test-driven-development](../test-driven-development/SKILL.md).
- Explicitly requested delegation: use [plan-to-pr](../plan-to-pr/SKILL.md). Keep one writer per file and inspect real diffs and test output, not summaries.

Finish with the checks, a self-review and any required [boundary-review](../boundary-review/SKILL.md). Update the project records ([project-records](../project-records/SKILL.md)). Use a feature branch and a focused PR; failed required gates keep the PR draft and the task open. Do not deploy or message other people without separate authority.
