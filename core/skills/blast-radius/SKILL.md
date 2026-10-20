---
name: blast-radius
description: Use when you need to know what a change could break beyond its diff, and to prove the relevant safety facts rather than assume them.
---

# Blast radius

1. Read the diff, the requirement IDs and the affected callers (`rg`, version history).
2. Trace callbacks, jobs, routes, dynamic loading, database constraints, queues and external-service boundaries.
3. Name concrete failure cases and the facts that prevent them: tenant scope before counts and pagination, primitive job arguments, approval binding, reservations, stop switches, reconciliation.
4. Prove those facts with focused existing tests or safe synthetic checks. Row-level security needs a non-owner database role; concurrency needs a real database. A mock proves neither.
5. For UI changes, exercise the real local journey. Keep backend, browser and external evidence separate.

Report each risk with file and line evidence, the check run and its result, and what remains unproven. Do not turn read-only analysis into a production action, and do not add speculative frameworks to shorten the risk list.
