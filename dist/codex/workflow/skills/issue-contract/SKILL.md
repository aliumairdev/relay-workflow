---
name: issue-contract
description: Use when you own, plan, implement, review, merge, prove or close work on a tracked issue, so the issue stays active until every accepted requirement has a final disposition.
---

# Issue contract

The GitHub issue is the COMPLETE work contract. A PR is one slice of it.

```
ISSUE CONTRACT → CLAIM → PLAN → IMPLEMENT SLICE → PR → REVIEW → MERGE → PROOF
→ CONTRACT RECONCILE → NEXT SLICE IF NEEDED → FINAL ACCEPTANCE AUDIT → CLOSE
```

PR complete ≠ issue complete. Merged ≠ verified. GitHub closed ≠ contract complete.

## What is in the contract

Objective, requirements, acceptance criteria, "done when", checkboxes, required tests, runtime/production proof, named reproduction cases, consolidated requirements and acceptance amended by later comments. `relay-claim` and the dispatcher extract it (`relay-contract extract|show <issue>`); each item has an id (AC1, R2, T1, RP1, REPRO1 ...).

## Final dispositions

Complete: `PASS`, `FIXED_AND_VERIFIED` (fixed, tests passed, required runtime proof passed), `VALID_TERMINAL_DISPOSITION` (the issue itself allows ending without implementation; cite it), `EXPLICITLY_REMOVED_FROM_SCOPE` (owner only, `relay-contract descope` with a reference). `EXTERNALLY_BLOCKED` (exact blocker) lets you wait only when nothing else is left; it never closes the issue.

Not completion: `NOT_PROVED`, `UNKNOWN`, `UNCHECKED`, `TODO`, `NEEDS_INVESTIGATION`, `NEEDS_DECISION` (the issue already defines the behaviour), `TESTS_ONLY` (runtime proof required), `MERGED_NOT_VERIFIED`, "follow-up issue created", "closed with known gaps", "works now, don't know why" (classify: fixed_by_change, independently_recovered, non_reproducible, unexplained).

## Working it

1. Plan the whole contract; name ids in journal entries (`relay-journal post <issue> --kind plan --req AC1,AC2 ...`).
2. Each PR says what it covers: `relay-contract pr-section <issue>` → "## Contract Coverage", `Issue completion: YES|NO`, and `Refs #<N>` (never `Closes`).
3. After a merge the issue is `state:ready` again while requirements remain. Take the next one. Do not ask whether to continue.
4. Record proof: `relay-contract mark <issue> AC1 PASS --evidence test:"npm test → 12 pass" --evidence runtime:<proof path>`. Tests alone never satisfy a runtime-proof requirement.
5. If the issue changes, `relay-contract update <issue>`: new requirements are yours; vanished ones stay until the owner descopes.
6. Done: `relay-contract check <issue>` (exit 0), `relay-journal check <issue> --final`, `relay-contract close <issue>`.

Reviewers judge the PR and the truth of its claimed coverage (CONTRACT_COVERAGE, ISSUE_COMPLETE); QA maps proof to requirement ids. Owner decisions follow [owner-decisions](../owner-decisions/SKILL.md); history goes in the [issue journal](../issue-journal/SKILL.md).
