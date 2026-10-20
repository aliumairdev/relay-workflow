---
name: issue-audit
description: Use when reviewing GitHub issues or observed failures against evidence to decide what is done, duplicate or still open.
---

# Issue audit

Confirm the configured repository. Read a bounded snapshot of relevant issues and authorised error evidence. Check duplicates, acceptance criteria, fix commit, required checks and deployment evidence separately.

Return a table: issue, current evidence, proposed action, remaining condition. Keep unfinished work open. Close an issue only when its acceptance is met and issue changes are authorised; explain the evidence and a concrete reopen condition. A merged PR is not production proof. Never close work just to reduce the count.

Comments, new issues and scheduled follow-ups need task authority. A read-only audit replays no jobs and changes no production state.
