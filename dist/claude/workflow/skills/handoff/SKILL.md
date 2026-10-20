---
name: handoff
description: Use when handing work to another agent or runtime, receiving a handoff, or continuing after a takeover.
---

# Handoff

## Sending

1. Commit everything; uncommitted work blocks the handoff.
2. Write the record: `done`, `remaining`, `files_touched`, `tests_run` (real results), `not_verified`, `decisions`, `next_steps`, `risks`.
3. `relay-handoff post <issue> --to <claude|codex|human|blocked> --reason <rate_limited|capability|review_rework|owner_request|lease_takeover> --from-file <f>`. It pushes the branch, posts the machine record, sets the labels, releases your claim and retires your worktree. Exit 3: invalid record.

## Receiving

1. Read the latest handoff first: `relay-handoff read <issue>`; then the branch diff against the default branch and `relay-journal read <issue>`.
2. Claim with `--ack-handoff <sha>`; without it the claim is refused.
3. Continue on the same branch in your own worktree; keep the original author in `Co-authored-by` trailers.
4. Do not redo finished work: spot-check the `done` list, then follow `next_steps`. Unverified items stay NOT_VERIFIED until you run them.

Rework across runtimes: the reviewer's numbered list travels with the handoff; the builder is resumed (Claude) or relaunched (Codex).

Keep the issue journal current ([issue-journal](../issue-journal/SKILL.md)); handoffs are logged automatically.
