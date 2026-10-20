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
- Conventional Commits. One PR per issue, with `Closes #<N>`. Hand-off keeps the same branch.
- CI runs locally through `relay-ci`; the merge queue (`relay-merge`) is the only thing that merges.

## Agent workflow

1. Claim with `relay-claim`; heartbeat while working; release or hand off, never go silent.
2. Verify `pwd` and branch (`relay-worktree verify`) at start, after any resume, and before every commit.
3. Implement only inside your owned paths. Shared files are append-only. Escalate conflicts.
4. Keep the issue history current with `relay-journal` (plan before coding, progress, decisions, tests, blockers, PR, summary); `relay-journal check` must pass before merge.
5. Run the validation commands from `workflow.yaml`. Open the PR from the template with evidence and a NOT_VERIFIED section.
6. Reviewers are never the implementer's own runtime when cross-review is on. Answer every bot review comment.

## Validation commands

{{validation_commands}}

## Standards

- Search before reading; read with line ranges; keep reports short.
- No out-of-scope work. No speculative abstractions.
- Tests prove behaviour; a guard test must be shown to fail against a broken fixture.

## Handoff format

Machine record: `relay:handoff` comment (done, remaining, files touched, tests run, not verified, decisions, next steps, risks, links). Durable human file: `harness/handoffs/<date>-<issue>.md`, at most 300 words, sections Implemented, Files changed, Validation, Integration notes, Known risks, Next dependency.

## Honesty rules

- Never claim a check passed without running it and quoting the result.
- Anything unrun or unobservable is listed as NOT_VERIFIED with the reason.
- "Verified" means a recorded proof stage passed; merged is not verified.

## Security rules

- Never commit secrets; credentials come from the environment or an ephemeral session.
- No destructive commands without an explicit owner request. Environment mutations stay inside the configured dev target and are reversible.
- Owner decisions (names, URLs, passwords, deletions) are the owner's: open one with `relay-decision` and keep working on everything else.
<!-- relay:end agents -->
