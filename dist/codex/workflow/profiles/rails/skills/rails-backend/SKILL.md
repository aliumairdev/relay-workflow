---
name: rails-backend
description: Use when writing or reviewing Rails models, controllers, migrations, queries, jobs or domain services.
---

# Rails backend conventions

Read the project's AGENTS.md and the nearest folder guide. Inspect a nearby implementation before adding a pattern; use Rails naming, associations, resource routes and generators, then check the generated output (a scaffold is a starting point, not proof of authorisation).

- Models own record rules; use small namespaced services only for explicit cross-record workflows. No generic repositories or base-service frameworks.
- Controllers handle authentication, scope, input, the operation and the response. No money rules, provider calls or long work in controllers or views.
- Permit input with `params.expect`; roles, tenant IDs, approval state and fees are not editable input.
- Load records through the verified scope. If the app is multi-tenant, never start with an unrestricted lookup; apply tenant and permission filters before counts, sorting and pagination.
- Use validations for feedback and database constraints for integrity (foreign keys, non-null, scoped unique indexes, checks). Money uses `BigDecimal`.
- Jobs: small, resumable, primitive IDs; establish trusted context before loading. Keep external calls outside transactions and locks. A timeout can mean success: reconcile before repeating an effect.
- Rescue specific errors only; keep secrets out of logs and fixtures.

Details: [queries and migrations](references/data.md). Follow [test-driven-development](../../../../skills/test-driven-development/SKILL.md): failing test first, with request-level coverage for every changed endpoint. Run focused tests, style checks and the autoload check (`bin/rails zeitwerk:check`) when constants move.
