---
name: model-routing
description: Use when choosing or explaining the tier, model, runtime or reviewer for a task, or when a routing override is requested.
---

# Model routing

Routing is deterministic and offline: `relay-route <issue|pr> [--class <task_class>] [--explain] [--json]`.

- Task classes map to tiers in `workflow.yaml` (`routing.task_classes`): docs and triage T0; implementation and routine review T1; high-risk review and audits T2 with a packet; T3 is exceptional.
- Risk score = sum of matching signals (paths, labels, size, rework rounds, failed proof). Thresholds: second reviewer, senior reviewer. Hard senior paths always escalate.
- Escalation: repeated failed reviews or failed proof raise one tier; unknown root cause after the configured attempts goes to a senior debugger. De-escalation is only ever proposed (`relay-route --propose`).
- Effort stays at the configured default; do not raise it yourself.
- Overrides: `route:T*` labels or `--tier/--runtime` with a `--reason`; they are logged. Exit 8 means a budget cap denied the request; use the suggested fallback or ask the owner.
- Expensive tiers get a compact packet only (`relay-packet build`, word limit enforced).
- Reviewer runtime differs from the implementer's when cross-review is on.

Never pick a model by name from memory: tiers resolve to models through `workflow.yaml`. Explain decisions with the `--explain` signals table.
