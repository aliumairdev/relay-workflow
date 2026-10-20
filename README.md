# Relay: a reusable multi-agent build workflow

GitHub is the control plane. Agents (Claude Code, Codex, any MCP client) claim issues atomically, work in their own worktrees, hand work to each other, keep a per-issue implementation log, and land PRs through a merge queue with local CI, review verdicts, bot gate and real-environment proof. Models are routed by tier and risk; cost and load are governed.

**Complete issue ownership.** The GitHub issue is the complete work contract and a PR is only a slice of it. Relay extracts every accepted requirement (objective, requirements, acceptance criteria, "done when", checkboxes, required tests, runtime proof, reproduction cases, acceptance amended by later comments) into an issue contract, and an issue is complete only when every requirement has an acceptable final disposition. *PR complete != issue complete. Merged != verified. GitHub closed != contract complete.* A merged PR with an unresolved contract returns the issue to the queue; `relay-contract check` is the closure gate for every runtime (CLI, Claude plugin, MCP).

One canonical core (`core/`) generates everything else: the Claude Code plugin (`dist/claude/workflow`), the Codex/Cursor/Gemini/Copilot files written by `init`, the npm CLI and the MCP server.

## Install in 5 minutes

Prerequisites: `git`, `gh` (logged in), `node` 20+, and at least one runtime (Claude Code and/or Codex CLI).

```sh
npx relay-workflow init --dry-run --runtime claude,codex   # preview every change as diffs; writes nothing
npx relay-workflow init --runtime claude,codex             # managed blocks keep your AGENTS.md / CLAUDE.md content
npx relay-workflow doctor                                  # fix anything red
```

Claude Code plugin: `/plugin marketplace add <owner>/relay`, `/plugin install workflow@relay-marketplace`, `/workflow:init`.

Then edit `workflow.yaml` (CI commands, model ids marked `<...>`, `policy.mode`), write `docs/PRODUCT_SPEC.md`, and run `/workflow:plan`, `/workflow:dispatch`, `/workflow:status`. Codex issues: `relay-workflow loop --runtime codex`.

`npx relay-workflow update` (hand edits inside managed blocks need `--keep` or `--overwrite`) and `uninstall` (restores your original files exactly).

## What is in the box

| Area | Scripts |
|---|---|
| Claims and handoffs | `relay-claim` `relay-lease` `relay-handoff` `relay-worktree` `relay-labels` `relay-state` `relay-lock` `relay-wait` |
| Issue history | `relay-journal` (one living log per issue; the merge queue requires it; entries name requirement ids) |
| Issue ownership | `relay-contract` (extract, show, update, check, mark, descope, reconcile, audit, close, sweep, release-audit): the issue contract and the only closure gate |
| Routing and cost | `relay-route` `relay-packet` `relay-governor` `relay-ledger` `relay-report` |
| Merge pipeline | `relay-ci` `relay-sync` `relay-resolve` `relay-bot-gate` `relay-verdict` `relay-merge` `relay-quick-merge` `relay-merge-stack` |
| Honesty and proof | `relay-proof` `relay-evidence-lint` `relay-mutation-check` `relay-qa` |
| Runtimes | `relay-codex-dispatch` `relay-loop` (any runtime with `exec_cmd`), `relay-mcp` |
| Visibility | `relay-dashboard` (live local web UI: who is working on what, who is idle, waiting or stale; queue and activity), `relay-status`, `relay-pr` |
| Operations | `relay-init` `relay-doctor` `relay-update` `relay-uninstall` `relay-status` `relay-resume` `relay-decision` `relay-issues-create` |

Skills (20 stack-neutral development skills plus the workflow skills) live in `core/skills`; stack skills in `core/profiles/<stack>/skills`. Profiles: `shopify-theme` (with lint rules and lessons L1-L22), `rails`, `nextjs`, `generic`.

## Develop

```sh
npm install
npm test                                  # node:test; sandbox repo + fake gh + fake runtimes
node generators/build-claude-plugin.mjs   # rebuilds dist/claude/workflow
claude plugin validate --strict dist/claude/workflow
```

Lifecycle: `ISSUE CONTRACT → CLAIM → PLAN → IMPLEMENT SLICE → PR → REVIEW → MERGE → PROOF → CONTRACT RECONCILE → NEXT SLICE IF NEEDED → FINAL ACCEPTANCE AUDIT → CLOSE`. Configure under `contract:` in `workflow.yaml` (`mode: enforce|warn|off`, `closing_keywords`, `reopen_on_incomplete`, `release_blocking`); existing projects bootstrap contracts lazily from the live issue and never get evidence invented.

Design documents: `PRD.md`, `ARCHITECTURE.md`, `PLUGIN_SPEC.md`, `WORKFLOW_DIAGRAMS.md`, `AGENT_HANDOFF.md`.

## Known gaps (NOT_VERIFIED)

- Pilot: three issues ran end to end with real Claude agents against a sandbox control plane (see `PILOT.md`); a real GitHub repo, Codex, and a 20-issue run have not been done.
- Codex CLI flags (`exec_cmd`, `exec_args`, `prompt_mode`, `model_flag`) are configurable and tested only against a fake binary.
- Rails and Next.js profiles are templates, untested on real projects.
- Real-platform proof steps are tested against a local HTTP stand-in, not a live store or deployment.
- Issue contracts are tested end to end only against the fake `gh` and fake runtimes (including a 4-requirement, 3-PR sandbox run); real GitHub behaviour (closing-keyword auto-close, the optional `contract-guard` workflow job, comment-size limits on very large contracts) is not verified. Contract extraction is a deterministic heading/checkbox parser: free-form acceptance prose that is not a list item becomes one requirement per line, and an amending comment is recognised only by an "Updated acceptance"/"Acceptance:"-style marker.
