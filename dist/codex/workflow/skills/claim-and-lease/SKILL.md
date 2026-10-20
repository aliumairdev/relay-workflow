---
name: claim-and-lease
description: Use when claiming, heartbeating, releasing or taking over an issue, or when a lease may have expired.
---

# Claim and lease

- Claim: `relay-claim <issue> --agent <id> --runtime <rt> [--owned "<globs>"] [--ack-handoff <sha>]`. The earliest live claim comment wins; a loser is refused (exit 7) and posts nothing lasting. Reasons for refusal: already claimed, owned-path overlap, handoff not acknowledged, wrong owner label.
- Then: `relay-worktree create <issue> --runtime <rt>`, enter the path, `relay-worktree verify`.
- Heartbeat: `relay-lease heartbeat <issue> --agent <id>` at least every `claims.heartbeat_minutes`. Exit 7 means the claim is lost: stop work and report; never keep pushing.
- Release: `relay-lease release <issue> --agent <id> --reason "..."` when you stop without a handoff.
- Takeover is legal only after expiry. The orchestrator runs `relay-lease sweep`; the next claimant continues from the existing branch and reads the previous agent's handoff and journal first (`relay-journal read <issue>`).
- Long runs (CI over ten minutes) heartbeat from the wrapper script, not from the model.
- Shared files are append-only; owned-path conflicts go to the orchestrator.

Keep the issue journal current: post `plan` after claiming, then progress ([issue-journal](../issue-journal/SKILL.md)). Claim and lease events are logged automatically.
