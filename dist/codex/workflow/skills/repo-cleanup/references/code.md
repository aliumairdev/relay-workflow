# Code cleanup

Search references with `rg`, then inspect routes, autoload/registry names, scheduled jobs, dynamic loading, callbacks and event names. A missing text match does not prove code is unused. Preserve domain ownership and licensed third-party files. Run relevant tests before removal, then focused tests, the autoload/type check and style checks. Use [boundary-review](../../boundary-review/SKILL.md) when sensitive paths change.
