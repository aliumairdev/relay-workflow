# Relay workflow

Read AGENTS.md first: it is the single contract for this repository.

- Claim an issue before editing (`relay-claim`); work on `agent/<runtime>/<issue>-<slug>` in a separate worktree.
- The issue is the complete work contract (`relay-contract show <issue>`): a merged PR is one slice; finish every requirement before the issue closes (`relay-contract check`). Use `Refs #N`, never `Closes`.
- Keep the issue history current (`relay-journal post`): plan before coding, progress, decisions, tests, proof, blockers, PR, summary.
- Hand work off explicitly (`relay-handoff post`); do not leave a claim silent.
- Tier names only; no model ids in shared docs.
- Do not claim a check passed unless you ran it; list gaps under NOT_VERIFIED.
- Never commit secrets.
