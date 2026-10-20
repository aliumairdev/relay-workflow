# Agent Handoff: build plan for the Relay workflow plugin

For the agent (any runtime) that will implement the plugin. Read in this order: this file, [PRD.md](PRD.md) requirements you are working on, [ARCHITECTURE.md](ARCHITECTURE.md) sections it cites, [PLUGIN_SPEC.md](PLUGIN_SPEC.md) interfaces, [WORKFLOW_DIAGRAMS.md](WORKFLOW_DIAGRAMS.md) for the flows.

Rules for you: follow token discipline (search before reading, line ranges, short reports); do not modify `~/.nexus-orch` or touch any store; never use `~/.nexus-orch/probe`; no secrets anywhere; mark anything unverified as NOT_VERIFIED; open one PR per task group; do not claim a test passes without running it.

## Table of contents

1. [Scope and success](#1-scope-and-success)
2. [Build order and milestones](#2-build-order-and-milestones)
3. [Ordered tasks with acceptance tests](#3-ordered-tasks-with-acceptance-tests)
4. [What to extract from the Nexus tooling, file by file](#4-what-to-extract-from-the-nexus-tooling-file-by-file)
5. [What to generalise](#5-what-to-generalise)
6. [Test strategy](#6-test-strategy)
7. [Dry-run acceptance test: two runtimes in a sandbox repo](#7-dry-run-acceptance-test)
8. [Checklist: reproduces the Nexus behaviours](#8-checklist-reproduces-the-nexus-behaviours)
9. [Quick-start for a human](#9-quick-start-for-a-human)
10. [Things to confirm first](#10-things-to-confirm-first)

---

## 1. Scope and success

Deliver the plugin described in [PLUGIN_SPEC.md](PLUGIN_SPEC.md): canonical core, Claude Code plugin, Codex adapter, router and governor, CLI installer, MCP server, other adapters, stack profiles (Shopify theme as the worked example; Rails and Next.js templates).

Success = (a) the sandbox dry-run in section 7 passes, (b) the checklist in section 8 passes, (c) a clean install on a sandbox repo takes at most 5 minutes for each supported runtime, (d) all table-driven router tests pass, (e) no secret is present in any file (grep gate in CI).

## 2. Build order and milestones

Order is mandatory: canonical core first, then the Claude plugin and the Codex adapter, then the CLI installer, then the MCP server, then other adapters.

| Milestone | Deliverable | Depends on | Maps to PRD |
|---|---|---|---|
| M0 Sandbox and harness | Sandbox repo generator, fake `gh` (record/replay) and fake runtime for tests | none | NFR-6 |
| M1 Canonical core: schema and templates | `workflow.schema.json`, `labels.json`, schemas, `AGENTS.template.md`, templates, briefs, token-rules injection | M0 | FR-1..5, FR-9, FR-37 |
| M2 Core scripts: state and control plane | `relay-gh` adapter, `relay-labels`, `relay-state`, `relay-lock`, `relay-worktree`, `relay-wait` | M1 | FR-6, FR-12, FR-43 |
| M3 Claim, lease, handoff | `relay-claim`, `relay-lease`, `relay-handoff` | M2 | FR-10, 11, 14, 44, 45 |
| M4 CI, sync, resolvers, bot gate, merge queue | `relay-ci`, `relay-sync`, `relay-resolve` + resolvers, `relay-bot-gate`, `relay-merge`, `relay-quick-merge`, `relay-merge-stack`, `relay-verdict` | M2 | FR-15, 20..30 |
| M5 Router and governor | `relay-route`, `relay-packet`, `relay-governor`, `relay-ledger`, `relay-report`, load and rate-limit handling | M1 | FR-31..41 |
| M6 Claude Code plugin | Generator `build-claude-plugin`, agents, skills, commands, hooks, marketplace | M3, M4, M5 | FR-51, 69..71 |
| M7 Codex adapter | `relay-codex-dispatch`, `relay-loop`, bot integration, cross-review wiring, fallback relabel | M3, M4, M5 | FR-22, 42, 46, 47, 52 |
| M8 Proof stage and honesty tooling | `relay-proof`, evidence lint, mutation check, post-merge QA brief, root-cause skill, Shopify profile proof steps | M4 | FR-58..63 |
| M9 CLI installer and doctor | `npx relay-workflow init|doctor|update|uninstall` | M6, M7 | FR-4, 50, 54, 56, 57 |
| M10 MCP server | Eight tools | M3, M4, M5 | FR-55 |
| M11 Other adapters and profiles | Cursor, Gemini, Copilot generators; Rails, Next.js profiles | M9 | FR-53 |
| M12 Pilot | Dry-run on a real second project; metrics report | all | PRD section 11 R7 |

## 3. Ordered tasks with acceptance tests

Each task lists acceptance tests (AT). Implement tests first where practical (mutation-check each guard test against a deliberately broken fixture).

### M0 Sandbox and harness
1. Script `tests/sandbox/make-repo.sh` creating a local bare "remote" and a working repo with `main`, a tiny Node project with `npm test`, and a seed spec.
2. Fake `gh` (`tests/fakes/gh`) implementing the used subset (issue list/view/edit/comment/close, pr create/view/merge/comment, api repos/.../comments, label list/create) over a JSON file; deterministic ids and timestamps; a clock override `RELAY_NOW`.
3. Fake runtime adapters `fake-claude`, `fake-codex` that execute scripted behaviours (implement = write file + commit; review = post verdict; rate-limit on demand; die silently).
- AT: `make test-harness` creates and tears down the sandbox in under 20 s; fake `gh` round-trips an issue with labels and comments.

### M1 Canonical core
1. JSON schema for `workflow.yaml` (PLUGIN_SPEC section 10 example validates; each invalid fixture fails with path).
2. `labels.json` with the full set (ARCHITECTURE 5) including aliases for Nexus labels.
3. Schemas: state, claim, handoff, verdict, ledger, packet.
4. Templates and briefs; brief renderer injects token rules, worktree safety, honesty and security blocks and the bot reply rules.
5. `AGENTS.template.md` with tier names only.
- AT: T-CFG-1, T-INIT-1, T-INIT-3; golden test: rendered `review` brief equals fixture and contains the 6 token-rule bullets; AGENTS template passes the neutrality lint (no model ids).

### M2 State and control plane
1. `relay-gh` GitHub adapter behind the `ControlPlane` interface (list/get issues, set labels with actor check, comments, PRs, PR comments with replies).
2. `relay-labels set|lint` with allowed-setter table and mutual-exclusion groups.
3. `relay-state` with file lock; `--rebuild` from claim comments.
4. `relay-lock` with stale detection; `relay-wait`; `relay-worktree`.
- AT: T-LABEL-1 (illegal transition exits 8), T-LABEL-2 (two state labels repaired by lint), T-WT-1 (path inside main checkout refused; branch held by another claim refused; verify detects wrong branch), T-LOCK-1 (stale lock taken over after threshold, live lock respected), T-WAIT-1 (relay-wait does not match its own command line; timeout exit 1).

### M3 Claim, lease, handoff
1. `relay-claim` per ARCHITECTURE 7.1 (comment ordering arbiter, nonce, overlap check, handoff ack).
2. `relay-lease heartbeat|release|sweep`.
3. `relay-handoff post|read` with schema validation, same-branch continuation, chain links.
- AT: T-CLAIM-1 (10 parallel claimers via background processes; exactly one `state:claimed`), T-CLAIM-2 (claim refused when owner label is for the other runtime), T-CLAIM-3 (expired lease swept; takeover succeeds; previous holder's heartbeat then fails), T-OWN-1 (overlapping owned paths refused; append-only shared path allowed), T-HAND-1 (claim of handed-off issue refused without `--ack-handoff`; receiver sees the handoff sha; handoff chain preserved).

### M4 CI, sync, resolvers, bot gate, merge queue
1. `relay-ci` from Nexus `local-ci.sh` (see section 4).
2. Resolver registry; port `resolve.mjs` and `resolve2.mjs` strategies; fixtures for md union, JSON order-array union, importmap union, locales keep both, unresolvable file (exit 2).
3. `relay-sync`, `relay-merge`, `relay-quick-merge`, `relay-merge-stack` using temp worktrees and `relay-lock`.
4. `relay-bot-gate` with exact logins, inline plus review comments, non-bot reply.
5. `relay-verdict` with cross-runtime check; `relay-merge` verifies a verdict for the head sha.
- AT: T-RES-1..4 (one per resolver class, byte-compared with expected), T-CI-1 (steps pass/fail reported, exit codes, log tail on failure), T-BOT-1 (comments from bot login without reply block; reply from bot does not clear; reply from agent clears; non-bot comments ignored), T-MERGE-1 (gated: behind main → sync → CI → gate → squash → issue closed with `state:done`), T-MERGE-2 (fast: merge attempted first; conflict → sync with resolvers → retry; close note text exact), T-MERGE-3 (no verdict for head sha → refused), T-STACK-1 (three stacked PRs merge in order, squash-induced conflicts resolved, real conflict aborts), T-XREV-1 (verdict by the implementer's own runtime rejected with exit 7 when cross-review on).

### M5 Router and governor
1. `relay-route` implementing task classes, risk signals, thresholds, hard rules, overrides, escalation, de-escalation proposals; deterministic, offline.
2. `relay-packet` word-limit enforcement and section builders.
3. `relay-ledger`, `relay-governor` (load sampling, admission, rate-limit backoff schedule, fallback), `relay-report`.
- AT: table-driven router tests (section 6.2) all pass; T-GOV-1 (top-tier share above cap denies a new T2 dispatch with exit 11 and suggests fallback; below cap admits); T-RL-1 (fake runtime rate-limits twice then succeeds; governor backs off per schedule using a fake clock and resumes the same run id; on exceeding retries falls back to the other runtime and relabels with reason); T-LOAD-1 (fake load above limit → exit 10 with retry_after; heavy-slot semaphore limits to 2); T-PACKET-1 (an 800-word packet is rejected naming the largest section); T-REPORT-1 (cost per merged PR and tier mix computed from fixture ledger).

### M6 Claude Code plugin
1. Generator creates `agents/*.md` from `workflow.yaml` roles and tier mapping; skills; commands; hooks.
2. Stop-hook with guard counter and `.relay/pause`; destructive-gate; secret-guard; worktree-guard; brief-lint; session-start.
3. `plugin.json` and marketplace entry.
- AT: golden tests on generated files; T-HOOK-1..5 (stop hook continues when ready work exists, stays silent when only owner decisions remain; destructive gate blocks `push --force`; secret guard blocks a fake token pattern; brief-lint flags `pgrep -f`; worktree guard blocks writes outside claimed worktree); plugin validates with `claude plugin validate` or the `plugin-dev:plugin-validator` agent if available (record result; else NOT_VERIFIED).

### M7 Codex adapter and multi-runtime
1. `relay-codex-dispatch`: render brief, create worktree, run `codex exec` (flags from config), capture result, ledger row.
2. `relay-loop --runtime codex`: poll for `state:ready` + `agent:codex`, check governor, dispatch; idempotent.
3. Cross-review wiring: reviewer runtime chosen ≠ implementer; label `review:<runtime>`.
4. Fallback relabel with handoff reason.
5. Optional GitHub Action template that runs `relay-loop --once` on `issues: labeled`.
- AT: T-CODEX-1 (with the fake codex binary, an `agent:codex` issue is claimed, implemented, PR opened, ledger row written), T-CODEX-2 (loop run twice concurrently → one claim), T-FAIL-RT (runtime binary missing → issue relabelled to other runtime with handoff reason and no duplicate), T-CROSS-1 (see section 7).

### M8 Proof stage and honesty
1. `relay-proof` with stages; Shopify profile steps wrap push + probe + error signatures (port of `store-check.sh`) but only in a profile and only against an env-configured target.
2. Evidence lint for PR bodies and handoffs; mutation-check runner.
3. Post-merge QA brief and bug-issue creation with routing escalation on proof failure.
4. Lessons registry (`lessons.yaml`) with L1..L22 from ARCHITECTURE section 14; lint rules shipped for the machine-checkable ones in the Shopify profile (capture-strip, block-wrapper child combinators, blank-after-filter guard, range steps).
- AT: T-HON-1 (PR body claiming "tests pass" without evidence or NOT_VERIFIED section fails lint; with evidence passes), T-MUT-1 (guard test must fail against the negative fixture), T-PROOF-1 (fake platform returns "Liquid error" for one page → exit 4, bug issue created, next dispatch tier raised by one), T-PROOF-2 (target unavailable → exit 5, items recorded NOT_VERIFIED, nothing claimed), T-LESSON-1 (each lint rule has a positive and a negative fixture).

### M9 CLI installer and doctor
1. `init` with `--dry-run` diff preview, managed blocks, backups, lock file.
2. `doctor` all checks in PLUGIN_SPEC 12.3.
3. `update` three-way, `uninstall` restore.
- AT: T-INIT-1 (clean repo: init creates expected files; second init no changes), T-INIT-3 (existing AGENTS.md and CLAUDE.md user content preserved byte-for-byte outside managed blocks), T-CLI-1 (dry-run writes nothing), T-CLI-2 (version pinning installs requested version), T-CLI-3 (update after hand edit inside a managed block prompts and keeps edit with `--keep`), T-CLI-4 (uninstall restores original files exactly), T-CLI-5 (runs per runtime flag: claude, codex, cursor, gemini, copilot), T-DOC-1 (doctor detects: missing `@AGENTS.md`, model id in AGENTS.md, oversize AGENTS.md, missing label, drifted generated file).

### M10 MCP server
1. Eight tools wrapping scripts with JSON schemas.
- AT: T-MCP-1 (a scripted MCP client with no Claude/Codex specifics runs: claim_issue → handoff → claim_issue (other agent) → run_local_ci → enqueue_merge → record_usage → owner_decision; resulting GitHub state equals the script-driven baseline), T-MCP-2 (schema validation rejects bad inputs).

### M11 Other adapters and profiles
1. Generators for Cursor, Gemini, Copilot; golden tests.
2. Rails and Next.js profiles with smoke tests against tiny sample projects (CI steps run, resolver fixtures pass).
- AT: T-GEN-1..3 (golden output), T-PROFILE-1 (Rails sample), T-PROFILE-2 (Next.js sample).

### M12 Pilot
1. Run on a throwaway non-Shopify project in fast-merge mode for 10 issues, then gated for 10.
2. Produce the metrics report (PRD section 9) and routing proposals.
- AT: report exists with all metrics; at least one routing proposal reviewed by the owner.

## 4. What to extract from the Nexus tooling, file by file

Read-only sources under `~/.nexus-orch/`. Copy logic, never paths or identifiers.

| Source file | Extract (behaviour) | Replace / drop |
|---|---|---|
| `tools/merge.sh` | Sequence: lock; per pair; skip merged; behind check via compare API; sync; 15 s settle; local CI; bot gate; store gate; approval comment + labels; squash merge; issue labels done + close; preview refresh | Hard-coded repo and store/theme ids; `pkill -f`; `mkdir` lock without stale detection; script-authored approval text; fixed `sleep 15` |
| `tools/quick-merge.sh` | Merge-first; on failure temp worktree, merge main, resolver, commit, push, wait, retry; close comment text; `issue 0` means no issue | Use of `probe` repo for worktree add; fixed sleep |
| `tools/merge-stack.sh` | Retarget child base to main; merge main into child; if conflict, for each unmerged file check whether main differs from parent branch for that file: if not, take child's version ("ours" in that checkout) else real conflict; then call merge; stop at first failure | `probe` worktree; `exit` inside subshell semantics |
| `tools/sync-pr.sh` | Fetch retry 3x; checkout detached; merge origin/main; on conflict resolver; install if needed; run validate + tests with one retry; push; failure summary grep list (`not ok|✖|violation|error|Error|TranslationKey|design-lint|setting-values`) | Shared worktree; project-specific grep pattern (move to profile); `sleep 20` retry rationale |
| `tools/local-ci.sh` | Dedicated worktree per branch; fetch; detach checkout; `npm ci` only when lock changed (`.lock-installed` cmp); steps loop with pass/FAIL; full mode starts preview and adds e2e scripts; log file per branch; tail 25 on failure | Worktree path pattern (use cache dir + prune); fixed step list (use config) |
| `tools/codex-open.sh` | Paginated PR comments API; top-level bot comments with no replies; awk set difference | Login substring match; ignoring review-level comments; any reply clears |
| `tools/store-check.sh` | Theme push with JSON errors summarised (first 200 chars per file), exit 4; theme-dev reachability exit 5; first product handle discovery; nine pages fetched in parallel with `curl -L`; grep for error signatures, exit 6 | Store/theme ids; port 9293; all Shopify specifics go to the profile |
| `tools/resolve.mjs`, `tools/resolve2.mjs` | resolve2: md union via `git merge-file --union` using stages 1/2/3; JSON deep merge with leading-comment preservation and order-array union; delegates others to resolve.mjs (importmap, locales). Read `resolve.mjs` for importmap and locale rules before porting | Hard-coded home path; `/tmp/r2-*` fixed temp names (race) |
| `tools/mk-issues.mjs` | Bulk issue creation from a JSON plan (read to confirm schema) | Repo constants |
| `tools/fix-drawer-menu.mjs` | Nothing (one-off) | Do not port |
| `dispatch.txt` | Brief skeleton: read order, workflow steps (branch, claim, implement, validate, PR with `Closes #`, labels, state), worktree safety, store pitfalls (move to profile lessons), design authority paragraph (move to UI add-on), final report ≤120 words | Repo names, absolute worktree paths |
| `review.txt` | Reviewer brief: scratch worktree, run CI, review order, visual gate, outcomes, do not merge/push to store | Paths; role names |
| `token-rules.txt` | Verbatim six rules | none |
| `codex.txt` | Bot reply protocol and commands | Login literal → config |
| `fixmerge.txt` | Short rework brief for post-sync failures | Stack hints → profile |
| `issue-update.txt` | Batch issue-rewrite brief for Haiku (steps, ≤45 lines, add comment) | Plan text specific to the aster wave |
| `aster-wave.txt`, `day4.txt`, `review-day4.txt` | Wave template shape: campaign context + per-issue instruction; read to extract the parameter list | Campaign content |
| `issue-triage.json`, `issue-triage.md`, `triage-leftovers.md` | Triage schema: per issue "changes" bullets, blocked-on-owner flag | Content |
| `audit-20261019.md`, `audit2-2026-10-19.md` | Audit report format: severity grouping, issue refs, pages verified OK, screenshots dir | Content |
| `populate/RESULT*.md` and scripts | RESULT file format (what was created, counts, errors, not touched, screenshots, scripts, idempotency note) | Shopify GraphQL specifics (stay in profile) |
| `ui-proof/` | Evidence layout: `real-store/`, `density/`, `announce/` subfolders, `_scripts` | Content |
| `logs/`, `merge-*.log` | Skim for failure modes only: retries, flaky causes | none |
| repo `AGENTS.md`, `CLAUDE.md` | Contract structure, recovery order, shared-files rule, approval comment format, handoff format | Model ids, Shopify rules → profile |
| repo `.claude/agents/*.md` | Frontmatter shape; role boundaries; tool lists per role | Names generated from roles |
| repo `.github/pull_request_template.md`, `workflows/ci.yml` | PR template; CI-on-main-only pattern | Shopify steps → profile |
| repo `tools/local-ci.mjs`, `tools/validate.mjs`, `tools/checks/*` | Pattern: project-owned checks invoked by CI script; negative fixtures for each rule | Rules are project-specific; keep as profile examples |
| repo `docs/QA_GATES.md` | Gate table shape (G0..G9), Definition of VERIFIED, NOT_VERIFIED vocabulary | Content |
| repo `harness/STATE.json`, `handoffs/`, `blockers/` | State fields; handoff size/format; blocker file convention | Content |
| memory notes in `/Users/mrumair/.claude/projects/-Users-mrumair-nexus/memory/` | Directives behind each rule (evidence for docs) | Do not copy user data into the plugin |

## 5. What to generalise

1. Every identifier (repo, default branch, store, theme ids, ports, paths) comes from `workflow.yaml` or env.
2. Shell scripts that parse JSON use `jq` or Node, not awk on API output, and quote all variables (Nexus scripts used unquoted variables).
3. Temporary files under `mktemp -d`, never fixed `/tmp` names.
4. Locks: pid + mtime, not bare `mkdir`.
5. No long-lived shared worktree.
6. Labels via alias map so Nexus-style labels (`state:ready-for-agent`) keep working.
7. Review artifacts are structured markers plus human text.
8. Platform facts (Liquid, theme push, `.shopify-block`) live only in `profiles/shopify-theme/`.
9. Runtime facts (SendMessage, Codex flags) live only in `adapters/runtime/*`.
10. Every script supports `--dry-run` where it mutates and `--json` output.

## 6. Test strategy

### 6.1 Layers

| Layer | Tooling | What |
|---|---|---|
| Unit | node:test, bats or shunit for sh | Router, schema validation, resolvers, label rules, packet limits, ledger math |
| Script integration | Sandbox repo + fake `gh` + fake runtimes | Claim races, merge pipelines, sync with conflicts, bot gate, handoffs |
| Golden | Fixture compare | Generated packages for each runtime, rendered briefs, AGENTS/CLAUDE blocks |
| Sandbox end-to-end | Real `git`, fake or real `gh` against a throwaway GitHub repo (optional), fake runtimes | Full lifecycle in gated and fast modes, two-runtime dry-run (section 7) |
| Install matrix | Clean temp dir per runtime | init, doctor, update, uninstall; 5-minute timing |
| Mutation | Break each rule deliberately | Each guard test must fail on the broken fixture |
| Load/chaos | Fake clock, fake load, killed processes | Rate limit, overload, dead agent, network failure injection |
| Security | grep and scanners | No secrets in package, no network calls (strace-free check: run with network disabled) |

### 6.2 Router table tests (`tests/router/cases.yaml`)

Each row: input (task class, labels, changed paths, size, rework rounds, proof failures, history) → expected output. Implement as data-driven test; add a row for every bug.

| # | Input summary | Expected |
|---|---|---|
| 1 | implement; labels `type:feature`, `area:design`; paths `assets/base.css`; 80 lines | T1 sonnet-class, medium, no packet |
| 2 | routine_review; docs-only paths `docs/merchant/x.md`; 40 lines | T1 (score −30 floors at 0) single reviewer |
| 3 | routine_review; path `snippets/compat-fit.liquid`; 120 lines | score 40 → T1 + second reviewer |
| 4 | routine_review; path `sections/main-cart.liquid` (hard senior path) | T2 senior review, packet required |
| 5 | routine_review; `area:accessibility` + path `assets/nx-modal.js` + 700 lines | 30 + 15 = 45 (+ path points if configured) → T1 + second reviewer; if modal path in hard list → T2 |
| 6 | routine_review; compat path (40) + size over 15 files (15) + rework 2 rounds (20) + `risk:high` (50) | 100 capped → T2 packet |
| 7 | docs; any | T0 |
| 8 | plan; novelty low | T1; plan; novelty high → T2 |
| 9 | debug_real_env; attempt 1 | T1; attempt 3 with no root cause → T2 |
| 10 | audit; release candidate | T2 packet |
| 11 | conflict_resolution; resolver exit 2 | T1 agent; resolver exit 0 → no agent |
| 12 | implement; `route:T2` label | T2 override; ledger notes override |
| 13 | high_risk_review requested but T2 share at 5.1 percent | exit 8 denied; suggestion fallback T1 + owner approval |
| 14 | implement; previous 2 failed reviews | tier raised one (T1 → T2) |
| 15 | any with `allow_high_effort: false` and caller asks effort high | effort medium |
| 16 | implement for `agent:codex` label, codex T1 mapping present | runtime codex, model from codex map |
| 17 | review for PR implemented by codex, cross_runtime on | runtime claude |
| 18 | same with only codex enabled | different agent instance, flag `same_runtime: true` |
| 19 | proof failed previously on issue (30) + compat path (40) | 70 → T1 + second reviewer; combined with rework 2 (20) → 90 → T2 |
| 20 | triage batch of 12 issues | T0 low effort |

### 6.3 Test IDs index

T-CFG-1, T-INIT-1, T-INIT-3, T-DOC-1, T-GATE-2, T-LABEL-1/2, T-WT-1, T-LOCK-1, T-WAIT-1, T-CLAIM-1/2/3, T-OWN-1, T-HAND-1, T-CI-1, T-RES-1..4, T-BOT-1, T-MERGE-1/2/3, T-STACK-1, T-XREV-1, T-GOV-1, T-RL-1, T-LOAD-1, T-PACKET-1, T-REPORT-1, T-HOOK-1..5, T-CODEX-1/2, T-FAIL-RT, T-CROSS-1, T-HON-1, T-MUT-1, T-PROOF-1/2, T-LESSON-1, T-CLI-1..5, T-MCP-1/2, T-GEN-1..3, T-PROFILE-1/2. T-GATE-2: UI issue without design spec reference is refused at dispatch with exit 8.

## 7. Dry-run acceptance test

Name: `T-CROSS-1`. Runs in the sandbox with fake runtimes by default; repeat with the real Claude and Codex runtimes when available (mark NOT_VERIFIED if not run).

Setup: sandbox repo with `workflow.yaml` (claude and codex enabled, cross-review on, lease 2 minutes in test time, gated mode), labels applied, two issues:

- Issue A: `agent:claude`, `state:ready`, owned paths `src/a/**`.
- Issue B: `agent:codex`, `state:ready`, owned paths `src/b/**`.

Steps and expected results:

1. Dispatch both (`relay-loop` for codex, `/workflow:dispatch` equivalent for claude). Expect: A has claim by claude agent id, B by codex agent id; branches `agent/claude/A-…` and `agent/codex/B-…`; separate worktrees; STATE.json claims registry shows both.
2. Race: start a second claimer for A. Expect refusal (exit 7); still exactly one claim.
3. Handoff Claude → Codex: claude agent partially implements A, then `handoff --to codex --reason capability`. Expect: handoff comment with all schema fields; `handoff:to-codex`; claude claim released; codex claims with `--ack-handoff <sha>` (without it refused); continues on the same branch in a new worktree; commit trailers list both authors.
4. Handoff Codex → Claude: codex agent partially implements B, hands to claude; claude continues and opens PR B.
5. PR A opened by codex: `review:claude` requested; `relay-verdict` by a codex reviewer is rejected (exit 7); claude reviewer posts CHANGES with a numbered list; labels `review:changes`, `state:changes-requested`.
6. Rework crossing runtimes: codex relaunched with handoff + list (no resume); pushes fix; claude re-reviews only the delta since the previous head sha; APPROVED.
7. PR B opened by claude: `review:codex`; codex reviewer APPROVES. A fake bot posts two inline comments on PR B; merge queue refuses (2 unanswered); the claude builder replies with fixed-in-sha and a technical reason; queue proceeds.
8. Stale-claim takeover: issue C (`agent:any`) is claimed by a fake claude agent that dies (no heartbeat); advance fake clock past lease; `relay-lease sweep` expires the claim, comment posted, label back to `state:ready`; a codex agent claims it from the existing branch; the dead agent's late heartbeat fails and it stops.
9. Rate-limit fallback: fake claude rate-limited for issue D beyond max retries; governor relabels `agent:codex`, posts handoff with reason, codex completes; ledger shows rate-limit row, fallback, no duplicate PR.
10. Merge in gated mode: all PRs merged by the queue in lock order; issues closed `state:done`; verdict markers exist for each head sha; STATE.json updated.
11. Router assertions: ledger rows for each run show tier, model, runtime; no T2 used (no high-risk paths); report computes cost per merged PR.
12. Repeat steps 10 with `policy.mode: fast` on a fresh issue: merged immediately, close note text exact, post-merge QA enqueued.

Pass = every assertion above passes and no secrets appear in any file or ledger (grep gate).

## 8. Checklist: reproduces the Nexus behaviours

Tick only with evidence (command output tail or fixture name).

- [ ] GitHub is the control plane; issues carry labels agent/state/priority/area/type; milestones M1..M5-style supported.
- [ ] Logical roles 1..7 plus `agent:main`; typed subagents generated with model and effort.
- [ ] Sonnet-class default for implementation and routine review; Haiku-class docs; Opus-class only for selected high-risk reviews with compact packet under 500 words; Fable-class rare; effort medium everywhere; Opus+Fable share alarm at 5 percent.
- [ ] Token-discipline block auto-injected into every brief.
- [ ] Worktree per claim; `pwd` check at start and after resume; never inside main checkout; no shared probe worktree.
- [ ] Claim comment `CLAIMED / Logical Agent / Branch` equivalent plus lease.
- [ ] Branch naming and PR template with `Closes #N`, labels, issue to `state:review`.
- [ ] Local CI script replaces PR CI; GitHub CI on main only (template workflow).
- [ ] Codex bot comments: listed, fixed, replied (fixed-in-sha or reason); merge blocked on unanswered; recheck ~3 minutes after push.
- [ ] Supervisor review order and MAIN REVIEW comment format; `review:main` → `review:approved`/`review:changes` equivalents.
- [ ] Rework loop: builder resumed (SendMessage on Claude), re-review delta only.
- [ ] Merge queue: lock; sync main with resolvers (md union, JSON deep merge with order union, importmap union, locales keep both); validate+test with one retry; local CI; bot gate; environment check; squash; close issue; refresh preview.
- [ ] Stacked PR merge.
- [ ] Fast-merge mode with exact close note; post-merge QA.
- [ ] Policy mode switch recorded verbatim in STATE.json.
- [ ] Rate-limit backoff and resume; load-aware concurrency; heavy-slot semaphore.
- [ ] Honesty protocol: NOT_VERIFIED lists; evidence lint; mutation-checked guard tests; no "approved/published" claims without a recorded gate.
- [ ] Owner-decision queue; secrets never committed; ephemeral password use; scoped, reversible environment mutations.
- [ ] Stop hook keeps the orchestrator working and stops when only owner decisions remain.
- [ ] Real-environment proof stage with root-cause-first skill; lessons L1..L22 in the Shopify profile with lint rules where machine-checkable.
- [ ] Handoff files ≤300 words with the six sections.
- [ ] Design-before-code gate (UI add-on): MASTER + page spec + 375/768/1440 + light/dark review.
- [ ] Multi-runtime: labels, claims, leases, handoffs, cross-review, fallback relabel; AGENTS.md neutral; CLAUDE.md imports it; doctor enforces.
- [ ] Distribution: Claude plugin, Codex package, Cursor/Gemini/Copilot rules, npx CLI, MCP server generated from one core; golden tests.
- [ ] No secret strings in any generated or source file (gate: grep for token and password patterns in CI).

## 9. Quick-start for a human

One page. "Install in 5 minutes."

### New project (empty repo)

1. Prerequisites: `git`, `gh` (logged in), `node` 20+, and at least one runtime (Claude Code and/or Codex CLI).
2. In the repo: `npx relay-workflow init --stack <shopify-theme|rails|nextjs|generic> --runtime claude,codex` (add `--dry-run` first to preview).
   Claude Code alternative: `/plugin marketplace add <owner>/relay`, `/plugin install workflow@relay-marketplace`, `/workflow:init`.
3. Edit `workflow.yaml`: repo name, CI commands (the profile fills defaults), `policy.mode` (start with `gated`), bot logins (Codex bot, if installed), budgets.
4. Run `npx relay-workflow doctor` (or `/workflow:doctor`). Fix anything red.
5. Write or paste your spec in `docs/PRODUCT_SPEC.md`, then `/workflow:plan docs/PRODUCT_SPEC.md`. Review the generated issues (labels `agent:claude`, `agent:codex`, `agent:any`).
6. Dispatch: `/workflow:dispatch --wave 4`. For Codex issues run `relay-loop --runtime codex` (or enable the Action).
7. Watch: `/workflow:status`. Answer items in the owner-decision queue when they appear.
8. Review and merge happen through `/workflow:review` and `/workflow:merge`; to go fast on a non-production project use `/workflow:mode fast --reason "not production"`; to tighten before a release use `/workflow:mode gated`.
9. After a few merges, run `/workflow:report` to see cost per merged PR and tier mix; approve or reject routing proposals by editing `workflow.yaml`.

### Existing repo

1. Create a branch. Run `npx relay-workflow init --dry-run`; read the diff. Existing `AGENTS.md` and `CLAUDE.md` are kept; the plugin adds managed blocks (`<!-- relay:begin ... -->`) and a `@AGENTS.md` import line to CLAUDE.md.
2. Run `init` for real; `doctor`; commit the result as `chore(workflow): install relay`.
3. Map your existing labels with the alias table in `workflow.yaml` (`labels.aliases`) so open issues keep working.
4. Set `ci.steps` to your real commands; run `relay-ci <branch>` once on a branch to confirm exit codes.
5. Start in `fast` mode if the repo is not production; otherwise `gated`.
6. Remove with `npx relay-workflow uninstall` (restores backups).

Safety reminders: secrets stay in environment variables or ephemeral sessions, never in the repo; the proof stage only touches the dev target named in `workflow.yaml`; the owner (you) decides names, URLs, passwords and deletions.

## 10. Things to confirm first

1. Exact `codex exec` flags, sandbox/approval modes and how the Codex GitHub bot is enabled for a repo; update `runtimes.codex` accordingly. Until confirmed, mark Codex-specific tests NOT_VERIFIED against the real binary (they run against the fake).
2. Current Claude Code plugin manifest schema, hook event names and payloads for Stop/PreToolUse, and `${CLAUDE_PLUGIN_ROOT}` support; validate generated plugin with the plugin validator.
3. How to read token usage from each runtime for the ledger; use estimates flagged `estimated: true` otherwise.
4. Whether the owner wants a different name than Relay.
5. Whether `prompt.md` (the master autonomous build prompt mentioned in the brief) exists elsewhere on the owner's machine; it was not found in the repo or worktree. If it exists, merge its content into `core/briefs/orchestrator.md`.
6. Tier pricing numbers for the cost governor.
