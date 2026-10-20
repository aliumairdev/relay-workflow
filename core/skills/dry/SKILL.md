---
name: dry
description: Use when duplicated rules or split state seem to cause a bug, to find the copies and recommend one owner.
---

# Find duplicated rules

Read-only analysis unless implementation is requested. Use it when duplication appears to cause a problem, not as a step for every feature.

Use [probes](references/probes.md) to find candidates. Read each copy: similar code is not proof of a shared rule. Trace readers and writers, stored state, jobs, views and history. Look for split decisions, drifted constants, repeated queries and multiple writers.

Prefer an existing model, method or module as the owner; cross-module rules keep the owner chosen in the architecture. Never merge independent safety gates or financial definitions only because they look alike.

Report the top findings with file and line evidence, the likely owner, the behaviour to protect and the proof needed. Defer unrelated findings. Stored-state changes need [migration](../migration/SKILL.md); behaviour changes need [test-driven-development](../test-driven-development/SKILL.md).
