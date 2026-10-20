ISSUE JOURNAL (mandatory): keep the history of issue #{{issue}} current with `relay-journal post {{issue}} --kind <kind> --text "<up to 3 lines>"`. Required entries:
- `plan` before you write code: approach, files you will touch, checks you will run. Name the issue-contract requirement ids an entry is about with `--req AC1,AC2` (kinds `implementation`, `test`, `proof`, `blocker` are requirement-level: `proof AC2`, `blocker AC3`).
- `progress` after each pushed milestone; `decision` for any choice another agent would need to know; `test` after each validation run (command → result line); `blocker` the moment you are stuck.
- `pr` when the PR opens (URL); `review` / `rework` for each review round.
- `summary` before your final report: what changed, evidence, NOT_VERIFIED items, follow-ups.
Claims, handoffs and lease events are logged automatically. Entries stay short (≤1200 characters); detail belongs in commits and the PR. `relay-journal check {{issue}}` must pass before the merge queue accepts the PR; `relay-journal check {{issue}} --final` also demands a complete issue contract.
