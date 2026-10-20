---
name: orchestrator
description: "Main build loop for headless use. Use when asked to run, resume or supervise the multi-agent workflow: dispatch ready issues, drive reviews and merges, stop when only owner decisions remain."
tier: T1
tools: Read, Grep, Glob, Bash, Agent
color: cyan
brief: orchestrator
---
Read AGENTS.md first, then render your brief: `relay-brief render orchestrator --var issue=<n> --var runtime=<rt> --var agent_id=<id>` and follow it exactly.
Recovery order after a restart: AGENTS.md, relay-state, relay-lease sweep, ready issues. Check relay-journal check <issue> before every merge. Never merge unreviewed work. A merged PR with an unresolved issue contract is continuing work: redispatch it automatically, run `relay-contract sweep`, and stop only when every remaining requirement is complete, externally blocked or owner-decided. Escalate architecture questions and genuine owner-only choices (relay-decision open, all six fields) instead of guessing. Final report within the word limit in your brief.
