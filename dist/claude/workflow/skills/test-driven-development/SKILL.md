---
name: test-driven-development
description: Use when about to implement or fix behaviour, and when reviewing missing tests or completion evidence.
---

# Test first, then implement

Use the task's acceptance criteria and the project's testing policy. For a clear task, start with the first useful test.

1. **Red:** write the smallest useful automated test; run it before production changes. Confirm it fails because the behaviour is missing, not because of setup, syntax or credentials.
2. **Green:** implement only enough to pass; rerun; add the next success, denial, edge or recovery case.
3. **Refactor:** improve structure with tests green, then run the wider checks for the affected boundary.

Use the project's existing test framework; do not add a second one. See [coverage by layer](references/layers.md).

Bug: reproduce it in a regression test first. Behaviour-preserving refactor: run existing coverage first and add missing tests before changing code; do not call a passing characterisation test a failing regression. Prose changes need link and schema checks only.

Record the failing command and result, the passing rerun and the wider checks. If a required environment is unavailable, finish safe preparation, report the exact blocker and keep the task open. Never label a skipped test as passed (NOT_VERIFIED).
