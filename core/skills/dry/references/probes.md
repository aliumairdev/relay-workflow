# Duplication probes

Pick the task area first, list its files with `rg --files`, then inspect copies rather than trusting names. Adapt these to the stack:

```sh
rg -n 'STATUSES|DEFAULT_|LIMIT|eligible|allowed' <area>
rg -n 'update_columns|account_id|tenant_id|store_id' <area>
rg -n 'constantize|render|perform_later|enqueue' <area>
git log --oneline -- <path>
```

Read scopes, queries, callbacks, jobs, views, schema and recurring schedules. Trace every writer and reader of the chosen state. Check recent history for drift. Do not print credentials or tenant payloads.

Call a rule shared only when changing it would require the same change in each copy. Keep independent tenant, approval, freshness, stop and reservation checks explicit.
