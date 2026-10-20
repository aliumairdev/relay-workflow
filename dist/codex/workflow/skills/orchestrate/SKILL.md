---
name: orchestrate
description: Use when running the multi-agent build loop: picking ready issues, routing, dispatching, reviewing and merging until only owner decisions remain.
---

# Orchestrate

Recovery order after any restart: `AGENTS.md` → `relay-state get` (STATE.json) → `relay-state claims` (compare with `relay-state rebuild --dry-run`) → `relay-lease sweep` → ready issues → `relay-journal read <issue>` for each in-flight issue.

## Loop

1. `relay-lease sweep`; fix label violations with `relay-labels lint --fix`.
2. Keep `plan.min_ready` issues at `state:ready` (target range in `workflow.yaml`); plan more when below.
3. Pick a wave: start with 4, grow toward `concurrency.max_agents` only while `relay-governor sample-load` allows. Never exceed `hard_max`. Heavy jobs share `heavy_slots`.
4. Per issue: `relay-route` → `relay-governor admit` (exit 10 wait, 11 deny: report, do not bypass) → `relay-brief render dispatch` → dispatch to the chosen runtime.
5. Reviews: request a reviewer from the other runtime when cross-review is on ([review-protocol](../review-protocol/SKILL.md)).
6. Rework: resume the original builder (Claude: SendMessage; Codex: relaunch with the handoff plus the numbered list).
7. Merge: before `relay-merge` (gated) or `relay-quick-merge` (fast) run `relay-journal check <issue>`; an incomplete journal goes back to its agent ([issue-journal](../issue-journal/SKILL.md)). A merged PR with an unresolved [issue contract](../issue-contract/SKILL.md) is continuing work: the issue is `state:ready` again; redispatch it without waiting for "continue". `relay-contract sweep` reconciles issues closed outside the gate.
8. Record each policy-mode change verbatim: `relay-state set policy.mode <m> --reason "<owner words>"`.

## Stop condition

Stop only when no ready work, no PR awaiting review or merge, no in-flight agent and no unresolved non-external contract requirement, pending QA or unrun audit remains, and the only open items are owner decisions ([owner-decisions](../owner-decisions/SKILL.md)) or EXTERNALLY_BLOCKED requirements. Say so explicitly.

## Never

Merge unreviewed work; write secrets; dispatch an issue with a live claim; call merged work verified before a proof stage passed, or an issue complete before `relay-contract check` passes; report unrun checks as passed (list them as NOT_VERIFIED).
