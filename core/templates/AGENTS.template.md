<!-- relay:begin agents -->
# Agent contract

This file is the single, runtime-neutral contract for every agent working in this repository. It names model **tiers**, never model ids; the mapping from tier to model lives in `workflow.yaml`.

## Sources of truth

| Question | Source |
|---|---|
| What to build | `docs/PRODUCT_SPEC.md` and the issue body |
| Who owns what, current claims | GitHub issue labels and `relay:claim` comments; cached in `harness/STATE.json` |
| How the workflow is configured | `workflow.yaml` |
| What was decided and why | `docs/` ADRs, handoff comments, `harness/handoffs/` |
| What is true of the real environment | `harness/proof/` results, never memory |

## Architecture rules

{{architecture_rules}}

## Tier routing (names only)

| Tier | Name | Used for |
|---|---|---|
| T0 | docs | summaries, docs, batch issue updates, triage |
| T1 | implement | implementation, routine review, git operations, conflict help |
| T2 | high-risk | architecture, high-risk review, audits (packet required, rare) |
| T3 | exceptional | cross-system or long-horizon work (rarest) |

Effort stays at the configured default. Do not raise effort or tier yourself: ask the router (`relay-route`) or the orchestrator.

## Git workflow

- Branches are `agent/<runtime>/<issue>-<slug>`, created from the default branch in your own worktree under the configured worktree root, never inside the main checkout.
- Conventional Commits. A PR is one slice of an issue and references it with `Refs #<N>` (never `Closes`: Relay closes the issue itself, after the contract gate). Hand-off keeps the same branch.
- CI runs locally through `relay-ci`; the merge queue (`relay-merge`) is the only thing that merges.

## Issue ownership (the issue is the complete work contract)

- Relay extracts a contract from the full issue (objective, requirements, acceptance criteria, "done when", checkboxes, required tests, runtime proof, reproduction cases, acceptance amended by later comments): `relay-contract show <issue>`. You own every requirement in it until each has an acceptable final disposition: PASS, FIXED_AND_VERIFIED, VALID_TERMINAL_DISPOSITION, EXPLICITLY_REMOVED_FROM_SCOPE (owner only) or EXTERNALLY_BLOCKED (exact blocker; keep working the rest).
- PR complete != issue complete. Merged != verified. GitHub closed != contract complete. A passing test, a deployed fix, a follow-up issue or a receipt that lists NOT_VERIFIED required items is not completion. Several PRs per issue are normal; after a merge the issue returns to the queue while requirements remain.
- The gate is `relay-contract check <issue>` (exit 0 only when complete); `relay-contract close <issue>` audits and closes. Never close an issue by hand, never move an accepted requirement to a follow-up, never ask the owner whether to finish.

## Agent workflow

1. Claim with `relay-claim`; heartbeat while working; release or hand off, never go silent.
2. Verify `pwd` and branch (`relay-worktree verify`) at start, after any resume, and before every commit.
3. Implement only inside your owned paths. Shared files are append-only. Escalate conflicts.
4. Keep the issue history current with `relay-journal` (plan before coding, progress, decisions, tests, blockers, PR, summary); `relay-journal check` must pass before merge.
5. Run the validation commands from `workflow.yaml`. Open the PR from the template with evidence, a NOT_VERIFIED section and its Contract Coverage (which requirements it implements; `Issue completion: YES|NO`).
6. Reviewers are never the implementer's own runtime when cross-review is on. Answer every bot review comment.

## Validation commands

{{validation_commands}}

## Standards

- Search before reading; read with line ranges; keep reports short.
- No out-of-scope work. No speculative abstractions.
- Tests prove behaviour; a guard test must be shown to fail against a broken fixture.

## Handoff format

Machine record: `relay:handoff` comment (done, remaining, files touched, tests run, not verified, decisions, next steps, risks, links). Durable human file: `harness/handoffs/<date>-<issue>.md`, at most 300 words, sections Implemented, Files changed, Validation, Integration notes, Known risks, Next dependency.

## Plain English

- Write everything a person will read (issue comments, journal entries, PR descriptions, handoffs, replies) in plain, simple English: short sentences, everyday words, the answer first.
- Explain any technical term or acronym the first time you use it. Keep exact commands, paths and error text as they are, with a plain sentence saying what they mean.

## Honesty rules

- Never claim a check passed without running it and quoting the result.
- Anything unrun or unobservable is listed as NOT_VERIFIED with the reason.
- "Verified" means a recorded proof stage passed; merged is not verified, and merged is not issue complete.

## Security rules

- Never commit secrets; credentials come from the environment or an ephemeral session.
- No destructive commands without an explicit owner request. Environment mutations stay inside the configured dev target and are reversible.
- Owner decisions (names, URLs, passwords, deletions, product choices) are the owner's: open one with `relay-decision` (question, why the contract does not answer it, evidence, options, recommended default, why proceeding is unsafe) and keep working on everything else. Technical choices and "may I finish this issue?" are never owner decisions.
<!-- relay:end agents -->
