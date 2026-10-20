# M12 pilot runbook (NOT DONE: needs a real second project and real runtimes)

Status: NOT_VERIFIED. Everything below the sandbox level (fake `gh`, fake runtimes, local HTTP stand-in) has been tested; nothing has run against a real GitHub repo with real Claude/Codex.

1. Pick a throwaway non-production project (not Shopify). `npx relay-workflow init --dry-run`, then `init --runtime claude,codex`, then `doctor` until it has no FAIL.
2. Confirm the Codex CLI first (AGENT_HANDOFF section 10): set `runtimes.codex.exec_cmd`, `exec_args`, `prompt_mode` (arg|stdin), `model_flag`, real model ids; enable the Codex GitHub bot; record the result here.
3. `relay-issues-create` a plan of 20 small issues. First 10 in `policy.mode: fast`, next 10 in `gated`.
4. Run `relay-workflow loop --runtime codex` and an orchestrator session (`relay-orchestrate on`, `/workflow:dispatch`).
5. After the run: `relay-report` (cost per merged PR, tier mix, rework, rate limits), `relay-route --propose`, `relay-doctor`. Review at least one routing proposal and record the owner's decision.
6. Record findings (what broke, which lesson to add to the profile's `lessons.yaml`) below.

Acceptance: a metrics report exists with all PRD section 9 metrics, and one routing proposal was reviewed by the owner.

---

## Pilot result: real Claude runtime, sandbox control plane (2026-10-20)

Setup: single-runtime (Claude only, `claude -p`, real model ids), 3 small issues, sandbox git repo with a local remote and the fake `gh` control plane (no GitHub repo was created, nothing was published). Cross-review was off (one runtime), so each reviewer was a different agent instance.

| Step | Result |
|---|---|
| Dispatch (claim, worktree, brief, run) | 3 of 3 agents implemented, tested and opened a PR via `relay-pr open` |
| Review | 2 of 3 reviewers approved with a verdict for the current head; 1 reviewer exited without posting a verdict, the dispatcher recorded `failed` and left the issue in `state:review` |
| Gated merge | 2 PRs merged in queue order after sync, local CI, journal check and verdict check; issues `state:done` |
| Journal | plan, test, pr, summary, review entries present on merged issues |
| Ledger/report | 8 rows, 2 merged PRs; token counts are estimates and cost is 0 because no tier prices are configured |

First attempt (before fixes) found three plugin gaps, all fixed: issue text was not in the brief (agents tried `gh issue view`), no `gh`-free way to open a PR (`relay-pr`), and a handoff to a disabled runtime was accepted.

Still NOT_VERIFIED: real GitHub control plane, the Codex runtime, cross-runtime review with real agents, bot review, real-platform proof, 20-issue scale, tier prices and real cost numbers, and why one reviewer exited without a verdict (not investigated).
