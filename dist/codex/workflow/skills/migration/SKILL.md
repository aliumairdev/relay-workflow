---
name: migration
description: Use when changing schema, stored data, an API contract or a dependency version and you must preserve data and plan recovery.
---

# Migration

Inspect the current representation, callers, lockfiles, deployed-data assumptions and related ADRs. State what is preserved, the compatibility period, changed contracts and recovery limits.

- Use expand, backfill, validate, contract steps for deployed data. Bound backfill batches and consider locks.
- New tenant-owned tables need a required tenant key, same-tenant foreign keys and database-level isolation where the app is multi-tenant; test with a non-owner role.
- Run real migrations on a disposable database. Loading a schema file is not migration proof.
- Write failing contract tests first ([test-driven-development](../test-driven-development/SKILL.md)). Test old and new paths during the transition, partial failure and idempotent retries.
- Keep money precision, source facts and immutable history. Never rewrite issued evidence to hide a correction, and never edit an applied migration.
- For dependency changes check official support and the exact pinned version.

Record rollback limits and run affected regression checks before marking complete.
