# Data, queries, migrations

- Use explicit string mappings for workflow states; protect transitions.
- Allowlist sort keys, bind SQL values, avoid loading a whole relation to count it. Check query shape on realistic data; add indexes and eager loading for proven repeated queries.
- If the app uses a per-request tenant database context, materialise permitted data inside it; do not return lazy relations that load after it ends.
- Deployed schemas change by expand, backfill, validate, contract. Bound batches, consider locks, test the real migration, and never edit an applied migration.
- Optional starter scoping is not enough for tenant isolation; test row-level security with a non-owner role.
