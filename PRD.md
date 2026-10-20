# PRD: Relay, a reusable multi-agent build workflow (working name)

Status: draft v1 for owner review. Date: 2026-10-20. Author: design agent, grounded in the Nexus Shopify theme build.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md), [WORKFLOW_DIAGRAMS.md](WORKFLOW_DIAGRAMS.md), [PLUGIN_SPEC.md](PLUGIN_SPEC.md), [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

Conventions used in all five documents:

- **Observed** means it happened in the Nexus build and has evidence (a file, a PR, a log, a label count).
- **Ad hoc** means it worked but lived in the orchestrator's head, a memory note, or a one-off script.
- **NEW** means plugin design that did not exist in the Nexus build.
- "Nexus" is the worked example: the premium technology-commerce Shopify theme in `aliumairdev/nexus`. Shopify specifics are confined to the stack profile (see [ARCHITECTURE.md](ARCHITECTURE.md#13-stack-profiles)).
- Source note: the brief mentioned a master autonomous build prompt `prompt.md`. No `prompt.md` exists in the repo or the current worktree. Its role was carried by `AGENTS.md`, `docs/MASTER_BRIEF.md`, the `.claude/agents/*.md` role files and the briefs in `~/.nexus-orch/`. The plugin ships that role as `templates/briefs/orchestrator.md`.

## Table of contents

1. [Problem](#1-problem)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Headline capabilities](#3-headline-capabilities)
4. [Personas](#4-personas)
5. [User stories](#5-user-stories)
6. [Functional requirements](#6-functional-requirements)
7. [Non-functional requirements](#7-non-functional-requirements)
8. [Policy modes](#8-policy-modes)
9. [Success metrics](#9-success-metrics)
10. [Risks and mitigations](#10-risks-and-mitigations)
11. [Rollout plan and milestones](#11-rollout-plan-and-milestones)
12. [Open questions](#12-open-questions)
13. [Evidence appendix](#13-evidence-appendix)

---

## 1. Problem

The Nexus theme was built by one human owner and one orchestrator agent coordinating many short-lived subagents. By the 2026-10-20 snapshot the repository had 241 commits (72 on 10-18, 159 on 10-19, 10 on 10-20), 200 merged PRs, and 131 issues assigned to five milestones (M1 12, M2 31, M3 20, M4 49, M5 19). The approach worked: the work shipped. But the workflow itself was never packaged. It exists as:

- a repo-level contract (`AGENTS.md`, `.claude/agents/*.md`, `docs/QA_GATES.md`, `harness/STATE.json`),
- eleven shell and Node scripts in `~/.nexus-orch/tools/` with hard-coded repo name, store domain, theme IDs and absolute paths,
- plain-text briefs in `~/.nexus-orch/` (`dispatch.txt`, `review.txt`, `token-rules.txt`, `codex.txt`, `fixmerge.txt`, `issue-update.txt`, `day4.txt`, `aster-wave.txt`),
- user memory notes (`model-routing-cost.md`, `agent-token-discipline.md`, `design-before-code.md`, `codex-reviews-local-ci.md`),
- and, most importantly, the orchestrator's own judgement (when to escalate to Opus, when to cap concurrency, when a conflict needs a human).

Consequences: the owner cannot start another project with the same behaviour without re-deriving it; knowledge is lost when the orchestrator's context is compacted; failure modes are rediscovered each time; and only Claude Code agents were used for implementation while Codex participated only as a review bot, so the owner could not label an issue "codex" and have a Codex agent pick it up.

The owner asked for a plugin so that the same behaviour can be reused on other projects, across agent runtimes (Claude Code, Codex, others), with best-in-class model selection and a distribution story that installs on any agent.

## 2. Goals and non-goals

### 2.1 Goals

- G1. Reproduce the Nexus workflow on a new repo in about five minutes: plan, issues, dispatch, implement, local CI, PR, review, rework, merge queue, post-merge QA, real-environment proof, close.
- G2. Make **model selection and routing** a first-class, automated, auditable feature: Sonnet-class for most work, Haiku-class for docs, Opus-class for selected high-risk review, Fable-class for exceptional problems, all at medium effort, top tiers held to roughly 2 to 5 percent of work, with a cost governor and feedback loop (NEW; Nexus did this ad hoc).
- G3. Make the workflow **multi-runtime**: GitHub issues labelled `agent:claude`, `agent:codex`, `agent:any`, with handoff labels, claims with leases, structured handoffs and cross-runtime review so Claude and Codex (and later others) collaborate on one project (NEW; Nexus used Claude for building and the Codex GitHub bot for review).
- G4. Make it **installable on any agent** from one canonical source: Claude Code plugin, Codex package, Cursor/Gemini/Copilot rule files, an `npx` CLI installer, and an MCP server exposing neutral tools (NEW).
- G5. Codify the **coding workflow standard** (design before code, small PRs, worktree isolation, local CI gate, evidence-based reporting, real-environment proof, post-merge QA, handoffs) as machine-checkable rules where possible, otherwise as skills and briefs.
- G6. Keep GitHub as the control plane and keep gates runtime-neutral (scripts, not prompts).
- G7. Be honest by construction: NOT_VERIFIED lists, evidence per claim, mutation-checked tests, never claim "approved" or "published" without a recorded gate.
- G8. Be safe: no secrets in the repo, store and environment mutations scoped and reversible, owner-decision queue for human-only decisions.

### 2.2 Non-goals

- N1. Not a general project management tool. GitHub (or a pluggable equivalent) owns task state.
- N2. Not a replacement for human product decisions. Names, URLs, passwords, deletions, publish actions stay with the owner.
- N3. Not a model provider abstraction layer for arbitrary inference. Runtimes are agent CLIs and services, not raw model APIs.
- N4. Not a hosted service in v1. Everything runs locally plus GitHub; telemetry is off by default.
- N5. Not a CI vendor. The CI gate runs the project's own commands through a script.
- N6. Does not try to make the offline harness equal to the real platform; it adds a real-environment proof stage instead.

## 3. Headline capabilities

| # | Capability | Status in Nexus | In plugin |
|---|---|---|---|
| H1 | Model selection and routing engine | Ad hoc: `model-routing-cost.md` note, `AGENTS.md` table, `.claude/agents/*.md` frontmatter, orchestrator judgement | Automated router, risk scoring, escalation, cost governor, `/workflow:route` |
| H2 | Multi-runtime collaboration (Claude, Codex, others) | Claude builders; Codex GitHub bot review; `codex-open.sh` gate | Labels, claims, leases, handoffs, cross-review, runtime adapters |
| H3 | Cross-agent distribution | None | Generated packages, CLI installer, MCP server, `doctor` |
| H4 | Coding workflow standard | Spread across AGENTS.md, QA_GATES.md, briefs, memory notes | Playbook as rules, hooks, skills, stack profiles |
| H5 | Merge pipeline with policy modes | `merge.sh` (gated), `quick-merge.sh` (fast) | Generalised queue with mode switch |
| H6 | Real-environment proof | Emerged late, after harness/platform divergence | First-class stage with root-cause-first debugging |

## 4. Personas

| Persona | Description | Needs |
|---|---|---|
| P1 Human owner | One person who sets direction, answers owner-decision questions, can say "not production, merge now". | Low-noise status, cost visibility, a short decision queue, safe defaults, ability to switch policy mode in one line. |
| P2 Orchestrator agent | Long-running Claude (or Codex, or a human acting as such) that decomposes, dispatches, merges, keeps the loop going. Called "Main" in Nexus. | Deterministic scripts for merge, claim, route; stop-hook that keeps it working; state it can recover after compaction. |
| P3 Implementer agents | Typed subagents per logical role (Nexus: 1 Foundation, 2 Design, 3 Commerce, 4 Technology commerce, 5 SEO/AEO, 6 QA) on any runtime. | Compact brief, owned paths, token rules, worktree, claim/handoff protocol, what "done" means. |
| P4 Reviewers | Sonnet supervisor (routine), Opus senior-reviewer (high risk), Codex bot (external), human (rare). | Compact packet, checklist, verdict schema, delta-only re-review, rule that an implementer's runtime never approves its own PR. |
| P5 Auditors | Release auditor (Opus), QA agent (post-merge), UI auditor. | Independent evidence, real-environment access, report format with severity and issue creation. |
| P6 Docs agent | Haiku-class, batched. | Handoff template, merchant doc templates, no code authority. |
| P7 Plugin maintainer | Person or agent maintaining the canonical core and generators. | Golden tests, compat matrix, clear extension points. |

## 5. User stories

### Workflow and lifecycle
- US-1 (P1) I run `/workflow:init` in a new repo and get AGENTS.md, labels, templates, workflow.yaml and a first `STATE.json` so that the project is ready to plan.
- US-2 (P2) I run `/workflow:plan` to decompose a spec into issues with owned paths, acceptance criteria and dependencies so that implementers never need to ask what to do.
- US-3 (P2) I dispatch a wave of up to N agents, where N is limited by machine load, so that the machine does not overload.
- US-4 (P3) I claim an issue atomically so that no other agent works on it.
- US-5 (P4) I review a PR from a compact packet so that review cost is bounded.
- US-6 (P2) I enqueue approved PRs and they merge one at a time with sync, local CI, Codex gate and store check so that main stays green.
- US-7 (P1) I flip to fast-merge mode with one config line when the project is not production, and post-merge QA verifies on main.
- US-8 (P5) A post-merge QA agent runs against main and opens bug issues with evidence.

### Model routing and cost
- US-9 (P1) I see which model each task will use and why (`/workflow:route 123`) and can override it so that I stay in control of spend.
- US-10 (P2) A high-risk PR (cart, accessibility-critical, schema, compatibility architecture, release audit) is automatically routed to the top reviewer tier with a packet under 500 words.
- US-11 (P1) I see cost per merged PR, tier mix and rework rate by tier so that I can judge whether routing works, and the system proposes routing changes.
- US-12 (P2) When a rate limit hits, the agent is resumed with backoff and falls back to another tier or runtime rather than stalling the wave.

### Multi-runtime collaboration
- US-13 (P1) I label an issue `agent:codex` and a Codex agent claims and implements it; I label another `agent:claude` and a Claude agent does.
- US-14 (P3) I hand an issue to the other runtime mid-way with a structured handoff comment so that the receiver does not repeat work.
- US-15 (P4) A PR implemented by Codex is reviewed by Claude and vice versa; the same runtime never approves its own PR.
- US-16 (P2) If a runtime is rate-limited or down, issues relabel to another runtime with a recorded reason.
- US-17 (P2) A stale claim (no heartbeat past the lease) is taken over by another agent without human action.
- US-18 (P4) The Codex bot's inline comments are tracked; every thread gets a reply (fixed in sha, or technical reason), and the merge gate blocks on unanswered threads.

### Distribution and install
- US-19 (P1) I install the plugin in Claude Code with `/plugin install`, or run `npx relay-workflow init` for any runtime, and `doctor` tells me what is wrong.
- US-20 (P7) I change the canonical core once and all per-runtime packages regenerate; golden tests fail if a generated file drifts.
- US-21 (P3) Any MCP-capable agent can call `claim_issue`, `handoff`, `route_model` and others without runtime-specific code.
- US-22 (P1) I install on an existing repo without clobbering my current AGENTS.md or CLAUDE.md; I can preview the diff and roll back.

### Honesty, safety, real environment
- US-23 (P4) Every claim in a PR report has evidence; anything unverified is listed under NOT_VERIFIED.
- US-24 (P1) Secrets never get committed; an ephemeral password is used only in a session; store mutations are scoped and reversible.
- US-25 (P5) When the real platform disagrees with the offline harness, a proof stage captures it and a root-cause-first debugging protocol applies.
- US-26 (P1) Things only I can decide (names, URLs, passwords, deletions) land in an owner-decision queue; agents continue other work meanwhile.

## 6. Functional requirements

Each requirement is numbered and testable. Test IDs refer to [AGENT_HANDOFF.md](AGENT_HANDOFF.md#6-test-strategy).

### 6.1 Initialisation and configuration
- FR-1 `/workflow:init` creates `workflow.yaml`, `AGENTS.md`, `CLAUDE.md` (with `@AGENTS.md` import), issue and PR templates, `labels.json` applied to GitHub, `harness/STATE.json` and `harness/handoffs/`. Idempotent; a second run changes nothing. Test: T-INIT-1.
- FR-2 `workflow.yaml` is validated against a JSON schema; invalid config fails with a line-referenced error. Test: T-CFG-1.
- FR-3 Existing `AGENTS.md` and `CLAUDE.md` content is preserved; the plugin edits only inside marked managed blocks. Test: T-INIT-3.
- FR-4 `/workflow:doctor` verifies: CLAUDE.md imports AGENTS.md (`@AGENTS.md`); AGENTS.md contains no runtime-specific model ids or Claude-only hooks; AGENTS.md under the size limit (warn at 24 KB, fail at 32 KB, because the Codex default doc limit is about 32 KB; Nexus AGENTS.md is about 6 KB); labels exist; `gh` auth works; declared runtimes installed; scripts executable. Test: T-DOC-1.

### 6.2 Planning and issues
- FR-5 `/workflow:plan` produces issues using the issue template with Objective, Context, Requirements, Acceptance Criteria, Owned Paths, Shared/Forbidden Paths, Dependencies, Validation, Documentation Impact (Nexus template, observed).
- FR-6 Every issue gets exactly one owner label (`agent:*`), one priority, one area, one type, one milestone, and `state:ready` or `state:backlog`.
- FR-7 The plugin keeps 10 to 20 near-term issues READY and creates the next batch when READY falls below `plan.min_ready` (default 8; Nexus rule, observed).
- FR-8 Design-before-code gate: issues with label `type:ui` (or paths under `ui_paths`) require a design spec reference (MASTER and page spec) in the body; dispatch refuses otherwise. Test: T-GATE-2.

### 6.3 Dispatch, claim, worktree
- FR-9 Dispatch builds a brief from templates plus injected token-discipline rules plus a runtime-specific wrapper; the brief is recorded in the ledger by hash.
- FR-10 Claim is atomic: an agent posts a claim comment with agent id, runtime, branch, lease expiry, then verifies it is the earliest valid claim; only then sets `state:claimed`. Test: T-CLAIM-1 (two agents race).
- FR-11 Lease defaults to 30 minutes with heartbeat every 10 minutes; a claim with an expired lease may be taken over; takeover posts a comment naming the previous holder. Test: T-CLAIM-3.
- FR-12 One worktree per claim at `<worktree_root>/<runtime>-<issue>`; the manager refuses paths inside the main checkout, refuses reuse of another claim's branch, and verifies `pwd` and branch at start and after resume (fixes the Nexus shared-worktree collisions). Test: T-WT-1.
- FR-13 Branch naming `agent/<runtime>/<issue>-<slug>`; the numbered-role form `agent/<N>/<issue>-<slug>` stays supported through `branch.pattern`.
- FR-14 Declared file ownership: each issue lists owned paths; the claim registry rejects a second active claim with overlapping owned paths unless one is marked append-only shared (the Nexus AGENTS.md "Shared files" rule). Test: T-OWN-1.

### 6.4 Implementation and local CI
- FR-15 Local CI is a script reading `ci.steps` from workflow.yaml; it runs on `origin/<branch>` in a dedicated worktree; exit 0 only if every step passes; logs to `logs/ci-<branch>.log`; prints the tail on failure. GitHub CI on PRs is disabled by default (Nexus: PR #240).
- FR-16 PR creation requires `Closes #N`, an owner label, `review:main` (or `review:<runtime>` in multi-runtime mode), the PR template filled, a validation checklist with real results, and a NOT_VERIFIED section.
- FR-17 Agents never commit to the default branch, never use bare `git stash`, never push to the shared environment themselves (Nexus rules, observed).

### 6.5 Review pipeline
- FR-18 Default reviewer is the routine reviewer tier; escalation to the high-risk tier follows the routing policy (FR-33).
- FR-19 Review order is configurable; Nexus order: acceptance criteria, architecture and ADRs, platform compliance, responsive, editor, accessibility, performance, SEO/AEO, UX/visual, integration, tests.
- FR-20 Verdict is a structured comment (schema in [ARCHITECTURE.md](ARCHITECTURE.md#6-data-model)) plus a label change. APPROVE posts the "MAIN REVIEW" block; CHANGES posts a numbered list, sets `review:changes` and `state:changes-requested`.
- FR-21 Re-reviews inspect only the delta since the last reviewed sha.
- FR-22 Cross-review rule: reviewer runtime must differ from the implementer runtime when `review.cross_runtime: true` and more than one runtime is available; otherwise the reviewer must be a different agent instance. Test: T-XREV-1.
- FR-23 External bot gate: all top-level comments by configured bot logins (default `chatgpt-codex-connector[bot]`, generalised to a list) must have a reply before merge; generalises `codex-open.sh`. P0/P1 bot findings must be fixed unless a reply states a technical reason. Test: T-BOT-1.
- FR-24 Rework loop: on changes requested, the orchestrator resumes the original builder (Claude: `SendMessage` to the agent id; Codex: relaunch with handoff plus review list) up to `rework.max_rounds` (default 3) before escalating tier or reassigning.

### 6.6 Merge queue
- FR-25 Merge requests are serialised by a lock with stale-lock detection (fixes the bare `mkdir` lock).
- FR-26 Gated mode steps: skip if already merged; sync with the default branch if behind; run conflict resolvers; run validate and test with one retry; local CI; bot gate; environment check; approval comment and labels; squash merge; close issue with state done; refresh preview.
- FR-27 Fast-merge mode: try squash merge immediately; on failure sync with resolvers, push, retry; close the issue with the note "verification follows on main"; enqueue post-merge QA. Test: T-MERGE-2.
- FR-28 Conflict resolvers by file class: markdown union; JSON templates and sections deep-merge with order-array union; import maps union one-per-line; locale JSON keep both sides; anything else is a real conflict and escalates (resolver exit 2). Resolvers are pluggable per stack profile. Tests: T-RES-1..4.
- FR-29 Stacked PR chain merge: merge in order; for each child, sync with the default branch resolving only squash-induced conflicts (child version kept when the default branch equals the parent branch for that file); real conflicts abort (generalises `merge-stack.sh`).
- FR-30 The merge script never posts an approval it cannot back: it verifies a reviewer verdict record exists for the head sha before writing "APPROVED" (fixes Nexus `merge.sh`, which wrote the approval text itself).

### 6.7 Model selection and routing (headline)
- FR-31 Router script `relay-route` takes an issue or PR and returns `{tier, model, runtime, effort, max_tokens, reviewer_tier, packet_required, reasons[]}` using workflow.yaml `routing`.
- FR-32 Task classes: plan, implement, routine_review, high_risk_review, docs, audit, debug_real_env, conflict_resolution, triage. Each has a default tier and effort (medium unless overridden).
- FR-33 Risk score is computed from paths touched, labels, diff size, area, and previous rework count; thresholds map to tiers (default: below 40 routine; 40 to 79 routine plus second reviewer; 80 or more high-risk tier with compact packet). Table-driven tests in AGENT_HANDOFF.
- FR-34 Escalation: two failed reviews, or a failed real-environment proof, escalates the next attempt one tier; an unknown root cause after two debugging attempts escalates to a senior debugger. De-escalation: a task class with N consecutive clean first-pass results at an upper tier is proposed for downgrade (owner approves).
- FR-35 Per-agent and per-issue override via `/workflow:route <issue> --tier X` or label `route:<tier>`; overrides are logged with reason.
- FR-36 Compact packet builder produces packets under `routing.packet_max_words` (default 500) with: problem, architecture, files, constraints, attempts, options, recommendation, decision requested (Nexus escalation packet, observed). It rejects oversize packets.
- FR-37 Token-discipline rules (search before reading, line-range reads, no lockfile or generated-output dumps, file-scoped diffs, tail/grep noisy output, at most 4 screenshots, no out-of-scope work, report at most 120 words) are injected automatically into every brief from `templates/briefs/token-rules.md`, not copied by hand.
- FR-38 Cost governor records every agent run in a usage ledger (JSONL) with tokens in/out, tier, model, runtime, issue, PR, outcome; enforces `budgets.top_tier_share_max` (default 5 percent of tasks, 2 to 5 percent target), `budgets.per_pr_cost_ceiling`, and `budgets.max_tokens_per_task`. Test: T-GOV-1.
- FR-39 Load-aware concurrency: before each dispatch the governor reads machine load; above `concurrency.load_limit` new dispatch pauses (Nexus saw load 150 to 200). Default parallel cap 8, absolute max 20 (Nexus ran about 20; the owner note recommended 6 to 8).
- FR-40 Rate-limit handling: exponential backoff, resume the same agent, after `rate_limit.max_retries` fall back to another tier or runtime. Test: T-RL-1.
- FR-41 Reports: cost per merged PR, tier mix, rework rate by tier, review catch rate by tier. A feedback job proposes routing changes (never applies them without owner approval).

### 6.8 Multi-runtime collaboration (headline)
- FR-42 Runtime adapters declare capabilities (tools, context size, cost tier, strengths, resume method, headless dispatch command) in `runtimes:` of workflow.yaml and `adapters/<runtime>/capabilities.json`.
- FR-43 Label protocol exactly as in [ARCHITECTURE.md](ARCHITECTURE.md#5-label-protocol): owner (`agent:claude`, `agent:codex`, `agent:any`, numbered roles `agent:N`), handoff (`handoff:to-claude`, `handoff:to-codex`, `handoff:to-human`, `handoff:blocked`), state, review. Each label has an allowed-setter list and mutual-exclusion groups, enforced by `relay-labels` and linted by doctor.
- FR-44 Handoff comment schema (what was done, what remains, files touched, tests run, NOT_VERIFIED, decisions, next steps, risks, branch and PR links) is machine-parseable and mandatory; the receiver must read it first (the brief says so; the claim script refuses to claim a handed-off issue until the handoff sha has been echoed). Test: T-HAND-1.
- FR-45 Handoff files `harness/handoffs/<date>-<issue>.md` (at most 300 words, Nexus format) mirror final handoffs.
- FR-46 The dispatcher can be a Claude orchestrator, a Codex orchestrator, a human, or a scheduled `gh` loop / GitHub Action that runs `codex exec` for `agent:codex` + `state:ready` issues. Dispatch is idempotent (the claim protocol is the guard).
- FR-47 Fallback: a runtime that is unavailable or rate-limited past retries relabels the issue `agent:<other>` with a handoff comment containing the reason. Test: T-FAIL-RT.
- FR-48 Disagreement between reviewers: tie-break by the senior reviewer; if still split, `handoff:to-human`.
- FR-49 Shared contract: AGENTS.md is the single source of truth; CLAUDE.md contains `@AGENTS.md` plus a short Claude-only section; the generator syncs runtime files; doctor verifies neutrality (no hard-coded model ids; only tier names `implement`, `review`, `high-risk`, `docs`, `exceptional`).

### 6.9 Distribution and installation (headline)
- FR-50 One canonical source; per-runtime packages are generated by `npm run build:packages`; a golden test compares generated output against fixtures.
- FR-51 Claude Code plugin with `.claude-plugin/plugin.json`, marketplace entry, agents, skills, commands, hooks (install via `/plugin install`).
- FR-52 Codex package: AGENTS.md block, `~/.codex` or repo prompts/config snippets, `codex exec` dispatch scripts, bot integration docs.
- FR-53 Rule-file generators for Cursor (`.cursor/rules/*.mdc`), Gemini CLI (`GEMINI.md` or extension), GitHub Copilot (`.github/copilot-instructions.md`), others through an adapter interface.
- FR-54 CLI installer `npx relay-workflow init|doctor|update|uninstall`: idempotent, `--dry-run`, diff preview, version pinning (`--version`), safe merge into existing files by managed blocks, rollback (`uninstall` and `restore` from `.relay/backup/`). Tests: T-CLI-1..5.
- FR-55 MCP server exposes tools `claim_issue`, `release_claim`, `handoff`, `route_model`, `run_local_ci`, `enqueue_merge`, `record_usage`, `owner_decision` with JSON schemas, so any MCP-capable agent can participate. Test: T-MCP-1.
- FR-56 Telemetry off by default; no network calls except to GitHub (via `gh`) and the project's own checks.
- FR-57 Compatibility matrix: plugin version vs Claude Code, Codex CLI, gh, node, git minimums, enforced by `doctor`.

### 6.10 Honesty, evidence and real-environment proof
- FR-58 PR and handoff reports must contain a `NOT_VERIFIED` list (possibly empty) and an evidence line per claim (command output tail, file path, screenshot name). `relay-evidence-lint` rejects PR bodies with unevidenced claims. Test: T-HON-1.
- FR-59 Agents never claim "approved", "published", or "verified" without a recorded gate result; reviewers use PASS / N/A / NOT_VERIFIED vocabulary (AGENTS.md "Standards", QA_GATES "Definition of VERIFIED").
- FR-60 Tests that guard a rule must be mutation-checked: the PR shows the test failing against a deliberately broken fixture (Nexus: `tests/fixtures/forbidden/`, `tests/unit/validate.test.js`). `relay-mutation-check` runs configured negative fixtures.
- FR-61 Real-environment proof stage (`/workflow:proof`): after merge, run a configured proof suite against the real platform (Nexus: Shopify dev store theme preview) and record evidence. A failing proof opens a bug issue and escalates routing (FR-34).
- FR-62 Root-cause-first debugging protocol is a skill: reproduce on the real platform; capture raw output; diff against harness output; state a root cause hypothesis with evidence before editing; fix; add a harness rule or fixture that reproduces the divergence; prove on the real platform. Fixes without a stated root cause are rejected by the review checklist.
- FR-63 Post-merge QA agent runs on the default branch after fast merges (and sampled after gated merges) and files issues labelled `type:bug` with screenshots or logs.

### 6.11 Owner decisions and security
- FR-64 Owner-decision queue: agents write a decision request issue (`owner-decision` label) with options, default, deadline; they mark the work `state:blocked` with `handoff:to-human` and take other work. `/workflow:status` lists the queue.
- FR-65 Secret guard hook blocks commits and tool outputs containing patterns from `security.secret_patterns` (tokens, keys, configured passwords by hash); secrets are provided only through environment or ephemeral session files outside the repo.
- FR-66 Destructive-command gate hook requires allow-list match or owner approval for configured patterns (force push, recursive deletes outside the worktree root, store deletions, hard resets on shared branches).
- FR-67 Environment mutations (store push, data population) must be scoped (named dev target in config), idempotent, and reversible (the script records an undo note). A mutation outside the configured target is blocked.
- FR-68 Per-runtime credentials live in each runtime's own secret store; tokens are least privilege; every label change and comment records actor identity (audit trail via GitHub timeline plus ledger).

### 6.12 Observability and resumability
- FR-69 `/workflow:status` shows active claims and leases, PRs by review state, merge queue, owner-decision queue, tier mix, load, rate-limit state, last proof result.
- FR-70 `/workflow:resume` rebuilds orchestrator context after compaction. Recovery order (Nexus CLAUDE.md, observed): AGENTS.md, STATE.json, open review PRs, ready P0/P1 issues, `git log --oneline -20`.
- FR-71 Stop hook: while `STATE.json.release_status` is not `COMPLETE` and READY or review work exists, the stop hook injects a "continue" instruction so the orchestrator keeps working (Nexus goal check-ins, observed). It never blocks when only owner-decision items remain.

## 7. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-1 | Cost control | Sonnet-class at least 85 percent of tasks, top tiers (Opus-class plus Fable-class) at most 5 percent; every brief carries token rules; per-PR cost ceiling enforced. |
| NFR-2 | Safety | No secret ever written to the repo or ledger; destructive actions gated; environment mutations reversible. |
| NFR-3 | Resumability | Any agent or the orchestrator can be restarted and recover from GitHub plus STATE.json alone; no state lives only in a chat context. |
| NFR-4 | Observability | Every dispatch, claim, handoff, review, merge, proof is a ledger row and a GitHub comment or label. |
| NFR-5 | Portability | Core in POSIX shell and Node 20+ with no runtime deps beyond `gh`, `git`, `node`; stack specifics isolated in profiles; macOS and Linux. |
| NFR-6 | Determinism | Merge, sync, CI, claim, route are scripts with exit codes and tests; prompts never carry gate logic. |
| NFR-7 | Idempotency | Every script safe to re-run; installer and dispatch idempotent. |
| NFR-8 | Performance | Claim round trip under 10 s; router under 1 s offline; merge queue overhead excluding CI under 60 s. |
| NFR-9 | Privacy | Telemetry off; no repo content leaves the machine except via the chosen runtimes and GitHub. |
| NFR-10 | Maintainability | One canonical source; generated packages never hand-edited; golden tests; semantic versioning with compat matrix. |
| NFR-11 | Extensibility | New runtime, control plane, or stack = adapter plus profile; no core change. |
| NFR-12 | Resource safety | Concurrency limited by load average; CI worktrees pruned (Nexus accumulated about 57 `ci-wt-*` directories). |

## 8. Policy modes

Config key `policy.mode` in workflow.yaml. Switchable at any time by `/workflow:mode gated|fast`.

| Aspect | gated (default) | fast-merge |
|---|---|---|
| When to use | Production, customer-facing, release candidates | Not production; owner says "merge immediately and test on main afterwards" (Nexus owner directive; `quick-merge.sh`) |
| Review before merge | Reviewer verdict required; high-risk tier per routing | Reviewer optional; bot comments still answered afterwards |
| Local CI before merge | Required | Skipped; run on main after merge |
| Bot comment gate | Blocks merge | Does not block; becomes follow-up issues |
| Environment check | Required (store push plus page probes) | Skipped; post-merge proof |
| Conflict handling | sync plus resolvers plus validate/test | resolvers only |
| Issue close | After merge with state done | After merge with note "verification follows on main" |
| Post-merge QA | Sampled | Mandatory, owner-visible |
| Risk | Slower | Escaped defects reach main; mitigated by post-merge QA and quick revert |

Rule: switching from fast to gated for a release candidate requires a green full proof run on main. Mode changes are logged in STATE.json with the owner's verbatim instruction.

## 9. Success metrics

| Metric | Definition | Baseline in Nexus | Target |
|---|---|---|---|
| Cycle time | Claim to merge, median per issue | Not recorded (ad hoc) | Recorded; goal under 3 h for small issues in gated mode |
| Rework rate | Share of PRs with at least one `review:changes` round | `review:changes` still present on 3 of the last 200 merged PRs (labels are removed on approval, so the true rate is under-measured) | Measured per tier and runtime from ledger; goal under 25 percent |
| Escaped defects | Bugs found after merge that review or gates should have caught, per 10 merged PRs | UI audit 2 alone produced 10 P1 issues (#292 to #301) | Tracked; goal under 1.5 per 10 PRs after the proof stage exists |
| Token cost per merged PR | Ledger sum by PR | Not recorded | Recorded; per-PR ceiling enforced |
| Tier mix | Share of tasks per tier | Target Sonnet 90 to 95, Haiku 3 to 7, Opus plus Fable 2 to 5 percent; measured only by orchestrator estimate | Measured; alarm when top tier exceeds 5 percent |
| Evidence coverage | Share of PR claims with evidence | Not measured | At least 95 percent via evidence lint |
| Merge queue health | Merges without manual intervention | Several merge logs show retries (`merge-177.log`, `-177b`, `-177c`; `merge-179b/c`) | At least 90 percent hands-off |
| Duplicate-work incidents | Two agents on one issue | Several (shared worktree and branch collisions) | Zero via claims |
| Install time | New repo to first dispatched issue | n/a | At most 5 minutes (sandbox test) |
| Cross-runtime review rate | PRs reviewed by a different runtime than the implementer | n/a | 100 percent when two runtimes configured |

## 10. Risks and mitigations

Every row is a failure mode seen in the Nexus build or an obvious extension of it.

| # | Risk (observed unless marked NEW) | Impact | Mitigation in plugin |
|---|---|---|---|
| R1 | API rate limits during large waves; many parallel agents hit the session limit (the owner asked for token optimisation after this) | Stalled waves | Rate-limit handler: backoff, `SendMessage` resume, fallback tier/runtime; token rules in every brief; concurrency cap |
| R2 | Machine overload (load 150 to 200) causing flaky tests and Chromium kills | False failures, wasted rework | Load governor pauses dispatch; one automatic re-run of a failing test after load drops; CI step timeouts; flaky-test quarantine list |
| R3 | Agents' wait loops using `pgrep -f` matched their own command line (self-matching) | Infinite waits | `relay-wait` script using pid files and condition checks with timeout; lint briefs for `pgrep -f` patterns; hook warning |
| R4 | Shared worktree collisions: agents committing onto another agent's branch; the `probe` worktree used concurrently by `sync-pr.sh`, `store-check.sh`, `merge-stack.sh`, `quick-merge.sh` | Wrong commits, lost work, flaky merges | One worktree per claim; per-operation temporary worktrees (quick-merge already used `mktemp -d`); worktree manager verifies branch ownership; merge queue lock |
| R5 | Auto-merge conflict resolver gaps (importmap, locales, md, JSON order arrays needed `resolve.mjs`, then `resolve2.mjs`; `merge-stack.sh` for squash-induced conflicts) | Merge stalls | Resolver chain with per-file-class plugins, fixture tests, escalate unknown files, never silently take "ours" for code |
| R6 | Network blips on `git fetch`, `gh`, store push | Spurious failures | Retry 3x with backoff (as `sync-pr.sh` and `store-check.sh` already do for fetch); mark blocked after persistent failure |
| R7 | Duplicate agents / duplicate issues for the same work | Wasted cost, conflicts | Claim and lease protocol; dedupe check in triage |
| R8 | Offline harness vs real platform divergence: Shopify Liquid whitespace in `capture` output, `@theme` block types, `.shopify-block` wrappers, blank-after-filter (PRs #401/#397, #380, #248, commit `ed87271`, #392, #159, #137, #131) | Features pass harness, break on platform | Real-environment proof stage, harness rules per defect class, root-cause-first debugging skill (see [lessons](ARCHITECTURE.md#14-lessons-and-prevention-rules)) |
| R9 | Orchestrator context compaction loses routing and policy (AGENTS.md says "Preserve routing after compaction") | Routing drift | Routing in workflow.yaml and router script, not in memory; `/workflow:resume` |
| R10 | Approval comment written by the merge script rather than reflecting a real review | False assurance | FR-30: script verifies a verdict record for the head sha |
| R11 | Fast-merge mode lets defects onto main | Escaped defects | Post-merge QA mandatory; quick revert command; mode logged |
| R12 | Top-tier overuse (Opus used for every PR review before the routing directive) | Cost blowout | Cap, risk score, ledger alarm, packet discipline |
| R13 | Same-runtime self-approval (NEW) | Correlated blind spots | Cross-review rule |
| R14 | Two runtimes edit the same files (NEW) | Conflicts | Owned paths, claim registry overlap check |
| R15 | Lost claim / dead agent (NEW) | Stalled issue | Lease and heartbeat, takeover |
| R16 | Instruction drift between CLAUDE.md, AGENTS.md and rule files (Nexus CLAUDE.md says "Read AGENTS.md first" in plain text, not an import; Nexus AGENTS.md hard-codes Claude model ids) | Runtimes behave differently | Generator plus doctor lint; neutral tier names |
| R17 | Secrets leaking (storefront password, tokens) | Security incident | Secret guard hook; secrets only in env/ephemeral; scan in CI and in doctor |
| R18 | Scripts hard-code repo, store, theme IDs, `~` paths (observed in all `~/.nexus-orch/tools`) | Not reusable | All identifiers from workflow.yaml and env |
| R19 | Review-bot noise or false positives | Gate deadlock | A reply with a technical reason counts as addressed; `bot.severity_block: [P0,P1]` option |
| R20 | Plugin scope creep | Never ships | Milestones; canonical core first |

## 11. Rollout plan and milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| R0 Canonical core | workflow.yaml schema, AGENTS.md template, labels.json, STATE and handoff schemas, brief library, generalised scripts with tests | Scripts pass table-driven tests against fixture repos |
| R1 Claude Code plugin | agents, skills, commands, hooks generated from core; marketplace entry | Sandbox dry-run reproduces a full issue lifecycle in gated mode |
| R2 Router and governor | Routing engine, packet builder, ledger, load and rate-limit governor, `/workflow:route` | Table-driven routing tests pass; simulated rate-limit test passes |
| R3 Codex adapter and multi-runtime | Codex dispatch, claim/lease/handoff, cross-review, bot gate generalised | Sandbox with agent:claude and agent:codex issues passes the dry-run acceptance test |
| R4 CLI installer | `npx` init/doctor/update/uninstall | Clean-sandbox install tests per runtime |
| R5 MCP server | Eight neutral tools | A non-Claude, non-Codex client completes a lifecycle through MCP only |
| R6 Other adapters and profiles | Cursor, Gemini, Copilot generators; Rails and Next.js profiles | Install tests pass; profile smoke tests |
| R7 Pilot on a second real project | Non-Shopify project | Metrics collected; routing feedback report reviewed by owner |

Rollout stance: dogfood on a throwaway sandbox repo first, then a low-risk real project in fast-merge mode, then gated mode.

## 12. Open questions

1. Plugin and package name (working name Relay; owner to choose).
2. Codex orchestration details: exact `codex exec` flags, sandbox and approval modes, and cloud-task API availability must be confirmed against the installed Codex version before R3. The design assumes headless exec with a prompt file and a repo checkout.
3. Can Codex be resumed mid-task the way Claude subagents resume via `SendMessage`? The design assumes no: Codex rework is a relaunch with handoff plus review list.
4. Cost data: how does each runtime expose token usage for the ledger? Claude subagent results report usage; Codex CLI output may need parsing. Fallback is estimated tokens flagged `estimated: true`.
5. GitHub Project board automation: Nexus recorded `GITHUB_PROJECT_SCOPE` as a non-blocking blocker and used labels instead. Should the plugin require project scope or stay label-only? Current design: label-only, Project optional.
6. Should the stop hook be Claude-only, or should other runtimes get an equivalent loop script? Design: `relay-loop` for headless runtimes.
7. How much of the Nexus design-before-code flow (ui-ux-pro-max MASTER.md, page specs, 375/768/1440 reviews in light and dark) is generic enough for the core, versus a UI add-on? Design: add-on skill pack `ui-design-gate`.
8. Should the owner-decision queue also notify (email, push)? Default: status command only.
9. Licensing and publication of the plugin.
10. The Fable tier is specific to this owner's model access; keep it as an optional top tier configured per user.

## 13. Evidence appendix

| Claim | Evidence |
|---|---|
| 200 merged PRs, 2 closed, 2 open | `gh pr list -R aliumairdev/nexus --state all` at snapshot |
| Milestones M1 to M5 counts | `gh api repos/aliumairdev/nexus/milestones` |
| Merged-PR owner labels: agent:3 65, agent:2 36, agent:4 28, agent:6 25, agent:main 14, agent:5 12, agent:1 8, agent:7 2 | `gh pr list --state merged --limit 200` label counts |
| `review:approved` on 165 of 200 merged PRs | same query |
| Model frontmatter and effort | `.claude/agents/*.md`: Sonnet for 6 implementers and supervisor; Opus for planner, senior-reviewer, release-auditor; Haiku for documentation-writer; Fable for fable-architect; all effort medium |
| Effort enforcement | `.claude/settings.json` env `CLAUDE_CODE_EFFORT_LEVEL=medium` |
| Routing note | `model-routing-cost.md` (user directive "TOKEN-EFFICIENT MODEL ROUTING, MANDATORY", 2026-10-18) |
| PR #144 | "docs(agents): cost-efficient model routing v2" |
| Local CI instead of GitHub CI on PRs | `.github/workflows/ci.yml` triggers on push to main and workflow_dispatch; PR #240; `~/.nexus-orch/tools/local-ci.sh`; `tools/local-ci.mjs` |
| Codex gate | `~/.nexus-orch/codex.txt`, `tools/codex-open.sh`, `merge.sh` |
| Fast-merge | `~/.nexus-orch/tools/quick-merge.sh` ("owner directive: not production; test on main afterwards") |
| Family-level compatibility defect | Issue #295 (fit ignored family/platform match) found by UI audit 2 (`audit2-2026-10-19.md`), fixed in PR #309 "family and platform entries match models in that family". The owner's account is that the Opus senior review caught the family-level match; confirm reviewer attribution from PR review comments before using it in routing feedback |
| UI audit findings | `~/.nexus-orch/audit2-2026-10-19.md` (P1 #292 to #301) |
| Real-platform divergence fixes | PRs #401/#397 (`capture` whitespace killed family-scale bars), #380/#374 (metric bars never drew), #248 (carousel inside Shopify block wrappers), commit `ed87271` (`.shopify-block` grid items), #392 (selectors vs wrapper), #159 (ranges need 3 or more steps), #137 (braces in quoted Liquid), #131 (range default on step) |
| Blocker honesty | `harness/blockers/SHOPIFY_DEV_STORE_AUTH.md`, `docs/QA_GATES.md` section 1 (NOT_VERIFIED while auth is unavailable) |
| Open blocked issue | #102 "Lighthouse runs on store ... blocked on store auth" |
