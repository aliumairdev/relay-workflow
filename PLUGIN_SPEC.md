# Plugin Specification: Relay (`workflow`)

Concrete design of the Claude Code plugin, the Codex package, the CLI installer and the MCP server, all generated from one canonical core. Companion to [PRD.md](PRD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [WORKFLOW_DIAGRAMS.md](WORKFLOW_DIAGRAMS.md), [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

Naming (working): plugin id `workflow` (commands appear as `/workflow:*`), npm package `relay-workflow`, MCP server `relay-mcp`, script prefix `relay-`. The owner may rename; names are variables in the generator.

Claude Code details used here (plugin manifest at `.claude-plugin/plugin.json`, components in `agents/`, `skills/<name>/SKILL.md`, `commands/*.md`, `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}` for script paths) follow the current plugin conventions; generator tests must be re-run against the installed Claude Code version because plugin schemas evolve.

## Table of contents

1. [Layout](#1-layout)
2. [Manifest and marketplace](#2-manifest-and-marketplace)
3. [Agents](#3-agents)
4. [Skills](#4-skills)
5. [Commands](#5-commands)
6. [Hooks](#6-hooks)
7. [Scripts overview and exit codes](#7-scripts-overview-and-exit-codes)
8. [Model routing: config, router, ledger](#8-model-routing-config-router-ledger)
9. [Script interfaces and Nexus tool mapping](#9-script-interfaces-and-nexus-tool-mapping)
10. [workflow.yaml](#10-workflowyaml)
11. [Templates](#11-templates)
12. [Runtime packages, installer CLI, doctor](#12-runtime-packages-installer-cli-doctor)
13. [MCP server](#13-mcp-server)
14. [Versioning and compatibility](#14-versioning-and-compatibility)

---

## 1. Layout

Canonical source repository (`relay/`), from which everything else is generated:

```
relay/
  core/                               runtime-neutral canonical source (hand-maintained)
    workflow.schema.json              JSON schema for workflow.yaml
    AGENTS.template.md                neutral contract (tier names only)
    briefs/                           orchestrator.md dispatch.md review.md high-risk-review.md docs.md
                                      fixmerge.md issue-update.md proof.md post-merge-qa.md handoff.md
                                      token-rules.md codex-rules.md worktree-safety.md honesty.md security.md
                                      ownership.md (issue = complete work contract; injected into every issue-facing brief)
    scripts/                          relay-* (POSIX sh / Node 20)
    resolvers/                        md-union.mjs json-deep-merge.mjs line-union.mjs keep-both.mjs
    labels.json                       full label set with colours and descriptions
    schemas/                          state.json claim.json handoff.json verdict.json ledger.json packet.json
    templates/                        issue.md pull_request.md STATE.json handoff.md decision.md
    profiles/                         shopify-theme/ rails/ nextjs/ (profile.yaml, lessons.yaml, checks/)
    adapters/
      control-plane/github.mjs        (gitlab.mjs, jira.mjs later)
      runtime/{claude,codex,gemini,cursor}/capabilities.json + dispatch/resume/status/collect
  generators/                         build-claude-plugin.mjs build-codex.mjs build-cursor.mjs
                                      build-gemini.mjs build-copilot.mjs build-npm.mjs build-mcp.mjs
  tests/                              unit, golden (generated output), sandbox end-to-end
  dist/                               generated packages (release artifacts)
```

Generated Claude Code plugin (`dist/claude/workflow/`):

```
workflow/
  .claude-plugin/
    plugin.json
  agents/
    orchestrator.md planner.md implementer.md reviewer.md senior-reviewer.md
    release-auditor.md docs-writer.md qa-post-merge.md debugger.md architect.md
  skills/
    orchestrate/SKILL.md          review-protocol/SKILL.md      handoff/SKILL.md
    real-env-proof/SKILL.md       model-routing/SKILL.md        claim-and-lease/SKILL.md
    design-before-code/SKILL.md   owner-decisions/SKILL.md      token-discipline/SKILL.md
  commands/
    init.md plan.md dispatch.md review.md merge.md status.md proof.md resume.md
    route.md mode.md doctor.md handoff.md claim.md report.md
  hooks/
    hooks.json
  scripts/                        relay-* and resolvers (copied from core)
  templates/                      copied from core
  profiles/                       copied from core
```

Project-side files created by `/workflow:init` (all managed-block safe):

```
workflow.yaml
AGENTS.md                         neutral, generated block + user content
CLAUDE.md                         "@AGENTS.md" import + Claude-only block
.claude/settings.json             effort env, hooks pointer (merged, not replaced)
.claude/agents/*.md               generated role files with model mapping from workflow.yaml
.github/ISSUE_TEMPLATE/task.md  .github/pull_request_template.md
harness/STATE.json  harness/handoffs/  harness/blockers/  harness/reports/  harness/proof/
.relay/lock.json  .relay/briefs/  .relay/ledger/usage.jsonl  .relay/backup/
```

## 2. Manifest and marketplace

`.claude-plugin/plugin.json`:

```json
{
  "name": "workflow",
  "version": "0.1.0",
  "description": "Multi-agent build workflow: GitHub control plane, model routing, claims and handoffs across Claude and Codex, merge queue, real-environment proof.",
  "author": { "name": "owner" },
  "keywords": ["multi-agent", "workflow", "github", "codex", "claude", "model-routing"]
}
```

Marketplace entry (`.claude-plugin/marketplace.json` in the distribution repo):

```json
{
  "name": "relay-marketplace",
  "owner": { "name": "owner" },
  "plugins": [
    { "name": "workflow", "source": "./dist/claude/workflow", "description": "Multi-agent build workflow", "version": "0.1.0" }
  ]
}
```

Install: `/plugin marketplace add <owner>/relay` then `/plugin install workflow@relay-marketplace`, then `/workflow:init`.

## 3. Agents

Frontmatter fields used by Nexus (Observed in `.claude/agents/*.md`): `name`, `description`, `model`, `effort`, `tools`, `color`. Agents are generated from the roster in `workflow.yaml`, with model ids resolved from tier mapping, so `AGENTS.md` stays neutral.

| Agent | Tier | Claude model (Nexus ids) | Tools | Purpose | Nexus origin |
|---|---|---|---|---|---|
| orchestrator | T1 | claude-sonnet-5-5 | Read, Grep, Glob, Bash, Agent | Main loop (usually the user's main session, not a subagent; file provided for headless use) | The "Main" session |
| planner | T2 | claude-opus-5-5 | Read, Grep, Glob, Bash, Write, Edit, WebFetch, WebSearch | Initial architecture, decomposition into issues | `planner.md` |
| implementer (per role, generated: foundation, design, commerce, tech-commerce, seo-aeo, qa; names from `roles:`) | T1 | claude-sonnet-5-5 | Read, Grep, Glob, Bash, Write, Edit | Implement one issue | six `*-implementer.md` |
| reviewer (supervisor) | T1 | claude-sonnet-5-5 | Read, Grep, Glob, Bash | Routine PR review | `supervisor.md` |
| senior-reviewer | T2 | claude-opus-5-5 | Read, Grep, Glob, Bash | High-risk PR review from a packet | `senior-reviewer.md` |
| release-auditor | T2 | claude-opus-5-5 | Read, Grep, Glob, Bash, WebFetch, WebSearch, Write | RC audits | `release-auditor.md` |
| docs-writer | T0 | claude-haiku-5-5 | Read, Grep, Glob, Bash, Write, Edit | Handoffs, changelog, merchant docs | `documentation-writer.md` |
| qa-post-merge | T1 | claude-sonnet-5-5 | Read, Grep, Glob, Bash, Write, Edit | Run proof on main; file bugs | NEW (Nexus ran ad hoc UI audits) |
| debugger | T1, escalates to T2 | claude-sonnet-5-5 / opus | Read, Grep, Glob, Bash, Edit | Root-cause-first real-env bugs | NEW |
| architect | T3 | claude-fable-5-1 | Read, Grep, Glob, Bash | Exceptional only; decision + ADR draft, no implementation | `fable-architect.md` |

Example generated agent file:

```markdown
---
name: reviewer
description: "Routine PR reviewer. Default reviewer for all PRs; escalates high-risk PRs to senior-reviewer via a compact packet. Never reviews a PR built by its own runtime when cross-review is enabled."
model: claude-sonnet-5-5        # resolved from workflow.yaml tiers.review.claude
effort: medium
tools: Read, Grep, Glob, Bash
color: blue
---
Read AGENTS.md, then run: relay-brief render review --pr $PR. Follow the rendered brief exactly. ...
```

Codex counterpart: `.relay/codex/prompts/reviewer.md` (a prompt file with the same body; model chosen by `codex exec --model <mapped model>` in `relay-codex-dispatch`).

## 4. Skills

Each skill is `skills/<name>/SKILL.md` with frontmatter `name` and `description` (trigger text) and a body that points at scripts instead of re-implementing logic.

| Skill | Trigger description (summary) | Contents |
|---|---|---|
| orchestrate | "Run the multi-agent build loop: pick ready issues, route, dispatch, review, merge" | Loop procedure, recovery order, dispatch rules, wave sizing, escalation packet usage |
| review-protocol | "Review a PR with the workflow checklist" | Review order, verdict schema, cross-review rule, delta re-review, bot reply requirements |
| claim-and-lease | "Claim, heartbeat, release, or take over an issue" | 7.1 and 7.2 procedure using `relay-claim`, `relay-lease` |
| handoff | "Hand work to another agent or runtime, or receive a handoff" | Schema, read-first rule, same-branch continuation |
| model-routing | "Choose or explain the model/tier for a task" | Task classes, risk score, thresholds, packet rules, overrides; uses `relay-route` |
| real-env-proof | "Prove behaviour on the real platform and debug harness divergence" | Root-cause-first protocol, lessons registry, proof stages, evidence format |
| design-before-code | "Before building UI, require design spec and visual review" | MASTER.md, preset and page spec, 375/768/1440 and light/dark checks, rejection traits (UI add-on pack) |
| owner-decisions | "Park a decision only the human can make" | Decision issue format, what counts, keep working |
| token-discipline | "Apply the token rules" | The rule block (also injected into briefs) |

## 5. Commands

Commands are Markdown files with frontmatter `description` and optional `allowed-tools`/`argument-hint`; the body instructs Claude to run the corresponding scripts and interpret results.

| Command | Arguments | What it does | Scripts |
|---|---|---|---|
| `/workflow:init` | `[--stack shopify-theme|rails|nextjs] [--runtime claude,codex] [--dry-run]` | Creates workflow.yaml, AGENTS.md, CLAUDE.md, templates, labels, STATE.json; merges settings | `relay-init` |
| `/workflow:plan` | `<spec path or goal>` | Decompose into milestones and issues using the issue template; routes planner tier; sets labels | `relay-gh`, `relay-route` |
| `/workflow:dispatch` | `[issue...] [--runtime claude|codex|any] [--wave N]` | Admit via governor, render brief, dispatch via adapter, record ledger | `relay-governor`, `relay-brief`, adapter |
| `/workflow:claim` | `<issue> [--ack-handoff sha]` | Claim an issue for the current agent (used by agents themselves) | `relay-claim` |
| `/workflow:handoff` | `<issue> --to claude|codex|human --reason ...` | Post handoff, set label, release claim | `relay-handoff` |
| `/workflow:review` | `<pr> [--tier auto|T1|T2]` | Route reviewer, build packet if needed, run review, post verdict | `relay-route`, `relay-packet`, `relay-verdict` |
| `/workflow:merge` | `<pr:issue>...` or `--stack ...` | Enqueue; runs gated or fast pipeline per mode | `relay-merge`, `relay-quick-merge`, `relay-merge-stack` |
| `/workflow:mode` | `gated|fast [--reason text]` | Switch policy mode; logs verbatim reason in STATE.json | `relay-state` |
| `/workflow:status` | `[--json]` | Claims, leases, PRs by state, merge queue, owner decisions, tier mix, load, last proof | `relay-status` |
| `/workflow:proof` | `[ref] [--suite quick|full]` | Run real-environment proof; file bugs | `relay-proof` |
| `/workflow:resume` | | Rebuild orchestrator context after compaction (recovery order); sweep leases; resume rate-limited agents | `relay-resume`, `relay-lease` |
| `/workflow:route` | `<issue|pr> [--explain] [--tier T] [--runtime R] [--reason text]` | Explain or override the chosen model/tier/runtime; writes label `route:T*` and ledger entry | `relay-route` |
| `/workflow:report` | `[--since 7d]` | Cost per merged PR, tier mix, rework by tier, proposals | `relay-report` |
| `/workflow:doctor` | `[--fix]` | Self-check (section 12.3) | `relay-doctor` |
| `/workflow:contract` | `show|check|update|mark|close|reconcile|sweep <issue>` | The issue contract (complete work contract of an issue) and its closure gate (section 9.3) | `relay-contract`, `relay-journal` |

## 6. Hooks

`hooks/hooks.json` (Claude Code event hooks; scripts under `${CLAUDE_PLUGIN_ROOT}/scripts`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-stop" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-destructive-gate" },
        { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-brief-lint" } ] },
      { "matcher": "Write|Edit", "hooks": [
        { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-secret-guard" },
        { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-worktree-guard" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-ledger" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/relay-hook-session-start" } ] }
    ]
  }
}
```

| Hook | Behaviour |
|---|---|
| Stop (goal loop) | Reads STATE.json and the control plane. If `release_status != COMPLETE` and there is READY work, PRs awaiting review/merge, or in-flight agents, returns a block decision with the reason "continue: N ready, M in review" so the orchestrator keeps working. Does nothing when only owner decisions remain or when the run is a subagent. Has a max-consecutive-continuations guard (default 50) and respects a `.relay/pause` file. Nexus origin: stop-hook / goal check-ins (Observed). |
| destructive-gate | Matches patterns (`push --force`, `branch -D` on shared branches, `rm -rf` outside worktree root, `reset --hard` on shared branches, store delete/publish commands). For a match: block and print the three facts required (affected files, rollback line, owner's instruction) or allow if the command is on the allow list. |
| brief-lint | Warns on `pgrep -f`, `pkill -f`, `git stash` (bare), `sleep` loops without timeout. |
| secret-guard | Scans content about to be written for `security.secret_patterns` and entropy; blocks and tells the agent to move the value to an env var or ephemeral file. |
| worktree-guard | Ensures writes target the claimed worktree and the branch equals the claim. |
| ledger | Appends tool-use summary counters for the active run (not content) for cost estimation when exact usage is unavailable. |
| session-start | Runs `relay-resume --brief` to print the 10-line recovery summary (claims, ready count, mode). |

Hooks are Claude-specific; other runtimes get the same checks as scripts called from wrappers (`relay-codex-dispatch` runs guard checks before and after) and from git hooks (`pre-commit`: secret scan, branch ownership).

## 7. Scripts overview and exit codes

Common conventions: all scripts read `workflow.yaml` (path from `RELAY_CONFIG` or discovered upward); identifiers come from config or env (never hard-coded); `--json` for machine output; `--dry-run` where mutating; logs under `.relay/logs/`; idempotent. Shared exit codes: 0 success, 1 generic error, 2 needs human (conflict, ambiguous), 3 validation failed, 4 gate failed (e.g. platform errors), 5 target unavailable, 6 render/proof errors, 7 not claimable/refused, 8 policy denied (budget, cap, mode), 9 environment error (missing worktree, fetch failure), 10 wait (retry later: load/budget), 11 deny.

## 8. Model routing: config, router, ledger

### 8.1 Routing config schema (`workflow.yaml: routing`, tiers, budgets)

```yaml
tiers:
  T0: {name: docs,        claude: claude-haiku-5-5,  codex: luna,               effort: medium, context_tokens: 200000, cost_rel: 1,  strengths: [summaries, docs]}
  T1: {name: implement,   claude: claude-sonnet-5-5, codex: sol,                effort: medium, context_tokens: 200000, cost_rel: 4,  strengths: [implementation, routine-review, git-ops]}
  T2: {name: high-risk,   claude: claude-opus-5-5,   codex: astra,              effort: medium, context_tokens: 200000, cost_rel: 20, strengths: [architecture, high-risk-review, audit]}
  T3: {name: exceptional, claude: claude-fable-5-1,  codex: astra,               effort: medium, context_tokens: 200000, cost_rel: 40, strengths: [cross-system, long-horizon]}

routing:
  allow_high_effort: false
  default_effort: medium
  packet_max_words: 500
  task_classes:
    plan:               {tier: T1, upgrade_if: {novelty: high, tier: T2}}
    implement:          {tier: T1}
    routine_review:     {tier: T1}
    high_risk_review:   {tier: T2, packet: required}
    docs:               {tier: T0}
    audit:              {tier: T2, packet: required}
    debug_real_env:     {tier: T1, escalate_after_attempts: 2, escalate_to: T2}
    conflict_resolution:{tier: T1, script_first: true}
    triage:             {tier: T0}
  risk:
    thresholds: {second_reviewer: 40, senior: 80}
    hard_senior_paths:                       # always T2 regardless of score
      - "sections/*cart*"
      - "snippets/*cart*"
    signals:
      - {kind: path,   globs: ["snippets/structured-data-*", "snippets/compat-*", "assets/nx-compat*", "config/settings_schema.json"], points: 40}
      - {kind: label,  any: ["area:accessibility"], points: 30}
      - {kind: label,  any: ["risk:high"], points: 50}
      - {kind: size,   files_gt: 15, lines_gt: 600, points: 15}
      - {kind: size,   files_gt: 40, lines_gt: 1500, points: 30}
      - {kind: rework, rounds_gte: 2, points: 20}
      - {kind: rework, rounds_gte: 3, points: 35}
      - {kind: proof_failed, points: 30}
      - {kind: paths_only, globs: ["docs/**", "tests/**"], points: -30}
  escalation:
    failed_reviews: 2        # one tier up
    failed_proof: 1
    unknown_root_cause_attempts: 2   # -> senior debugger
  deescalation: {clean_first_pass_streak: 10, propose_only: true}
  overrides:
    agents: {docs-writer: {tier: T0}}
    labels: {"route:T2": {tier: T2}}
budgets:
  tier_share_max: {T2: 0.04, T3: 0.01, top_combined: 0.05}
  tier_share_target: {T0: [0.03, 0.07], T1: [0.90, 0.95]}
  max_tokens_per_task: {T0: 150000, T1: 600000, T2: 250000, T3: 250000}
  per_pr_cost_ceiling_usd: 15.0
concurrency: {max_agents: 8, hard_max: 20, load_limit_factor: 1.5, heavy_slots: 2}
rate_limit: {max_retries: 3, backoff_s: [30, 60, 120], fallback: {tier: sibling, runtime_order: [claude, codex]}}
```

(Prices and context sizes are placeholders; `relay-doctor` warns when a tier has no price.)

### 8.2 Router script interface: `relay-route`

```
relay-route <issue|pr> [--class <task_class>] [--explain] [--json]
            [--tier T0..T3] [--runtime claude|codex|...] [--reason "text"]   # override (logged)
            [--propose]                                                       # feedback proposals from ledger
```

Output (`--json`):

```json
{
  "target": {"kind":"pr","number":315},
  "task_class": "routine_review",
  "risk": {"score": 55, "signals": [{"kind":"path","matched":"snippets/compat-fit.liquid","points":40},{"kind":"size","points":15}], "hard_rules": []},
  "decision": {"tier":"T1","model":"claude-sonnet-5-5","runtime":"codex","effort":"medium","second_reviewer":true,"reviewer_tier":"T1","packet_required":false,"max_tokens":600000},
  "reasons": ["score 55 >= 40: second reviewer", "cross-review: implementer runtime is claude"],
  "budget": {"tier_share_now": {"T2": 0.03}, "cap_ok": true, "per_pr_spent_usd": 2.1},
  "overridden": false
}
```

Exit codes: 0 decided, 3 invalid config, 8 denied by budget/cap (with `decision.fallback` suggestion). Deterministic: same inputs and config give same output; no model call.

`/workflow:route 123 --explain` prints the signals table and what would change under overrides; `--tier T2 --reason "cart"` applies a `route:T2` label and logs `override_by`.

### 8.3 Usage ledger format

File `.relay/ledger/usage.jsonl` (append-only, one JSON object per line, rotated monthly). Schema as in [ARCHITECTURE.md 6.7](ARCHITECTURE.md#67-usage-ledger-row-jsonl). Rules: never contains prompts, code or secrets; `estimated: true` when token counts come from hook counters; `relay-ledger append` takes an advisory lock; `relay-report` reads all rows. Example rows:

```json
{"ts":"2026-10-20T10:02:00Z","run_id":"r-0142","agent_id":"claude-3f","runtime":"claude","model":"claude-sonnet-5-5","tier":"T1","task_class":"implement","issue":315,"pr":null,"tokens_in":210000,"tokens_out":14000,"cost_usd":1.9,"estimated":false,"outcome":"done","rate_limit":false,"brief_hash":"9a1c"}
{"ts":"2026-10-20T10:40:00Z","run_id":"r-0150","agent_id":"claude-op1","runtime":"claude","model":"claude-opus-5-5","tier":"T2","task_class":"high_risk_review","issue":315,"pr":321,"tokens_in":38000,"tokens_out":4200,"cost_usd":1.1,"estimated":false,"outcome":"changes_requested","escalation_from":"T1"}
```

### 8.4 Cost governor interface: `relay-governor`

```
relay-governor admit --run <json>      # exit 0 admit, 10 wait (load/budget), 11 deny (ceiling), prints reason + retry_after_s
relay-governor note-rate-limit <run_id> [--retry-after S]
relay-governor sample-load             # prints load1, cores, limit, heavy slots free
relay-governor report [--since 7d]     # alias of relay-report
```

## 9. Script interfaces and Nexus tool mapping

### 9.1 Mapping

| Nexus tool (`~/.nexus-orch/tools`) | Plugin script | Generalisation |
|---|---|---|
| `merge.sh` | `relay-merge` | Config for repo/branch/labels; stale-lock; verdict check; mode aware; env refresh via profile; temp worktrees |
| `quick-merge.sh` | `relay-quick-merge` (also `relay-merge --mode fast`) | Same logic; temp worktree; resolvers via registry; ledger entry; post-merge QA enqueue |
| `merge-stack.sh` | `relay-merge-stack` | Same squash-conflict rule (child version kept when default equals parent branch for the file); no shared worktree |
| `sync-pr.sh` | `relay-sync` | Temp worktree; resolver registry; `ci.sync_steps` (validate, test) with one retry; push |
| `local-ci.sh` | `relay-ci` | `ci.steps` from profile; per-branch worktree cache with pruning; `--full`; tail on failure; log path |
| `codex-open.sh` | `relay-bot-gate` | `bot.logins` exact, inline plus review comments, non-bot reply required, severity filter |
| `store-check.sh` | `relay-env-check` (inside `relay-proof --stage pre-merge`) | Profile-defined push, probes, error signatures; unavailable target exit 5 |
| `resolve.mjs`, `resolve2.mjs` | `relay-resolve` + `resolvers/*.mjs` | Strategy registry from config/profile |
| `mk-issues.mjs` | `relay-issues-create` | Create issues from a plan JSON with labels and milestones |
| `fix-drawer-menu.mjs` | (not generalised) | One-off fix script; example of what stays in project `tools/` |
| `dispatch.txt` | `core/briefs/dispatch.md` | Variables: repo, role, issue, branch pattern, commands; runtime wrapper |
| `review.txt` | `core/briefs/review.md` | Same; order from config |
| `token-rules.txt` | `core/briefs/token-rules.md` | Auto-injected |
| `codex.txt` | `core/briefs/codex-rules.md` | Bot reply protocol, generalised to `bot.logins` |
| `fixmerge.txt` | `core/briefs/fixmerge.md` | Stack-specific hints from profile |
| `issue-update.txt` | `core/briefs/issue-update.md` | T0 batch issue updater |
| `aster-wave.txt`, `day4.txt`, `review-day4.txt` | `core/briefs/wave-template.md` | Campaign-specific waves become parameterised templates |
| `issue-triage.json/.md`, `triage-leftovers.md` | `relay-triage` outputs under `harness/` | Triage schema |
| audit/*.md, `ui-proof/` | `core/briefs/proof.md`, `post-merge-qa.md` | QA agent briefs and report template |
| `populate/*.py`, `RESULT*.md` | profile `populate/` hook + RESULT template | Idempotent environment seeding with RESULT file and undo note |
| `merge.lock` dir | `relay-lock` | PID file, mtime stale detection |
| `probe` worktree | removed | Replaced by temp worktrees |

### 9.2 Interfaces

Issue ownership (details in ARCHITECTURE 8.3 and section 9.3 below): `relay-contract extract|show|update|check|mark|descope|reconcile|followup|pr-section|lint-pr|audit|close|sweep|release-audit <issue>`. `check` exits 0 only when the whole contract is satisfied (4 = closure denied, 3 invalid, 7 refused owner-only action). `relay-pr` requires `Refs #N` plus Contract Coverage; `relay-verdict post ... --coverage ID=PASS|FAIL|NOT_COVERED --issue-complete YES|NO`; `relay-qa done <pr> --result pass|fail --map ID=PASS|FAIL|NOT_VERIFIED[:why] --proof <ref>`; `relay-journal post ... --req AC1,AC2` and `check [--final]`; `relay-decision open ... --category C --contract-gap T --evidence T --unsafe-because T [--requirement ID]`; `relay-merge` output `#pr MERGED (issue #n) — contract x/y complete, issue stays active (remaining ...)|issue closed`.

`relay-claim <issue> --agent <id> --runtime <rt> [--role N] [--owned "<glob,glob>"] [--ack-handoff <sha>] [--lease-min 30]`
Outputs claim JSON. Exit 0 claimed; 7 refused (already claimed, overlap, handoff not acknowledged, wrong owner label); 9 control-plane error.

`relay-lease sweep|heartbeat <issue>|release <issue> [--reason]` : sweep exit 0 even when nothing expired; prints expired claims.

`relay-handoff post <issue> --to <claude|codex|human|blocked> --reason <enum> [--from-file handoff.json]` : validates against schema; exit 3 invalid; 0 posted. `relay-handoff read <issue> [--latest]` prints the machine record and its sha.

`relay-worktree create <issue> --runtime <rt> [--slug s] | verify [--issue N] | remove <issue> | prune [--older 7d]` : create prints path; exit 9 when path inside main checkout or branch held by another claim; `verify` exit 0 only if pwd, branch and claim agree.

`relay-ci <branch> [--full] [--matrix]` : runs `ci.steps` on `origin/<branch>` in `.relay/ci-wt/<branch>`; prints `step: pass|FAIL` lines; final `<branch>: LOCAL CI OK|FAILED (log path)`; exit 0 green, 1 failed, 9 cannot fetch/checkout.

`relay-bot-gate <pr> [--json]` : prints count of unanswered bot top-level comments (and with `--json` their ids/severity); exit 0 when 0, 1 otherwise.

`relay-sync <branch>` : merge default branch into branch in temp worktree; resolvers; sync steps; push; exit 0 synced, 2 needs manual resolution, 3 validate/test failed after merge (log path), 9 fetch failure.

`relay-resolve [--strategy-map path]` : run inside a repo mid-merge; resolves unmerged files by registry; prints `resolved: <file>`; exit 0 all resolved, 2 leftovers (prints list).

`relay-merge <pr:issue>...` : gated pipeline; per pair prints `#pr MERGED (issue #n)` or `#pr SKIP (reason)`; exit 0 if all merged; 1 otherwise. Reasons: `sync failed`, `local CI failed`, `N unanswered bot comments`, `env check failed`, `no verdict for head sha`, `budget denied`.

`relay-quick-merge <pr:issue>...` : fast pipeline; prints `#pr MERGED` or `#pr NOT MERGED`; enqueues post-merge QA; exit 0/1.

`relay-merge-stack <pr:issue>...` : in order; per child: retarget base, sync, resolve squash-induced conflicts, merge via `relay-merge`; exit on first failure.

`relay-proof [--stage pre-merge|post-merge|release] [--ref <sha|branch>] [--suite quick|full]` : runs profile proof steps against the scoped target; writes `harness/proof/<date>/<ref>/summary.json` + logs; creates bug issues on failure (`--no-issues` to skip); exit 0 pass, 4 platform errors, 5 target unavailable, 6 render errors.

`relay-verdict post <pr> --result APPROVED|CHANGES --checklist <json> [--changes-file f]` : validates reviewer runtime != implementer when cross-review is on (exit 7 if violated); posts marker + human text; sets labels.

`relay-labels set <issue|pr> <label...> [--actor-class implementer|reviewer|orchestrator|human|merge|governor]` / `lint` : exit 8 when the transition is not allowed for the actor class; `lint --fix` repairs mutual-exclusion violations.

`relay-state get|set|rebuild|claims` : file-locked STATE.json operations.

`relay-brief render <name> [--var k=v ...]` : renders a template, injects token rules and security rules, appends runtime wrapper; prints path and hash.

`relay-packet build --pr N | --issue N [--kind review|decision]` : enforces `packet_max_words`; exit 3 if oversize with section word counts.

`relay-decision open <issue> --question ... --options a,b --default a [--deadline]` : creates `owner-decision` issue and blocks the work item.

`relay-wait --pid P | --file F | --url U | --cmd C [--timeout S]` : pidfile/condition wait without `pgrep -f`; exit 0 condition met, 1 timeout.

`relay-lock acquire|release <name> [--stale-after 900]` : exit 0 acquired, 1 busy.

`relay-doctor [--fix] [--json]` : section 12.3.

`relay-init [--stack s] [--runtime list] [--dry-run] [--yes]` : writes files; prints diff in dry-run.

`relay-report [--since D] [--json]` and `relay-loop [--runtime codex] [--interval 300]` : poller that dispatches ready issues labelled for a headless runtime.

`relay-codex-dispatch <issue>` : renders brief for runtime codex, creates worktree, runs the configured headless command (e.g. `codex exec` with the prompt file; flags from `runtimes.codex.exec_args`), captures output, appends ledger row, exits with agent status.

### 9.3 Issue contract lifecycle contract (all runtimes)

Every runtime (Claude plugin, Codex/Gemini headless via `relay-loop`, Cursor/Copilot via `AGENTS.md` rules, any MCP client) follows the same semantics because the logic lives only in `core/lib/contract.mjs` and `core/lib/contractops.mjs`:

1. Extract at claim/dispatch; include the contract in the brief (`relay-contract show <issue> --brief`).
2. PR = slice: `Refs #N`, Contract Coverage, `Issue completion: YES|NO`. Reviewer verdict states CONTRACT_COVERAGE and ISSUE_COMPLETE.
3. Merge records the slice; the issue stays active (`state:ready`, `contract:open`) while requirements remain, is parked when only external blockers remain, and is closed only by the gate (check, final audit, close).
4. QA/proof map results to requirement ids; failures reopen implementation.
5. GitHub-closed issues with incomplete contracts are reconciled (`relay-contract sweep`) and shown as `GITHUB_CLOSED_CONTRACT_INCOMPLETE`.
6. Hooks: the Stop hook blocks while unresolved non-external requirements, pending/failed QA or an unrun audit remain; the destructive gate denies `gh issue close` and `state=closed` API calls outside `relay-contract close`.

## 10. workflow.yaml

Full example for a Shopify theme project (Nexus values where known; placeholders in angle brackets):

```yaml
version: 1
project:
  name: nexus
  repo: <owner>/<repo>
  default_branch: main
  stack: shopify-theme                  # profile
  worktree_root: ~/worktrees/<repo>     # outside the main checkout
  state_file: harness/STATE.json
policy:
  mode: gated                           # gated | fast
  fast_merge:
    close_note: "Fixed by merged PR #{pr}; verification follows on main."
    post_merge_qa: required
runtimes:
  claude:
    enabled: true
    resume: send_message
    models: {T0: claude-haiku-5-5, T1: claude-sonnet-5-5, T2: claude-opus-5-5, T3: claude-fable-5-1}
    effort_env: {CLAUDE_CODE_EFFORT_LEVEL: medium}
    strengths: [orchestration, parallel-subagents, ui-design-gate, review]
  codex:
    enabled: true
    resume: relaunch
    exec_cmd: "codex exec"              # confirm flags for installed version
    exec_args: ["--sandbox", "workspace-write"]
    models: {T0: "<mini>", T1: "<default>", T2: "<top>"}
    strengths: [focused-implementation, review, long-running-refactor]
    bot: {logins: ["chatgpt-codex-connector[bot]"], severity_block: [P0, P1]}
runtime_policy:
  default: any
  rules:
    - {when: {labels_any: ["type:refactor"]}, prefer: codex}
    - {when: {labels_any: ["area:design"]}, prefer: claude}
  fallback_order: [claude, codex]
review:
  cross_runtime: true
  routine_tier: T1
  order: [acceptance, architecture, platform, responsive, editor, a11y, performance, seo_aeo, ux_visual, integration, tests]
  delta_only_rereview: true
  max_rework_rounds: 3
roles:                                   # logical roles (Nexus agent:N)
  "1": {name: foundation,      paths: ["layout/", "config/settings_schema.json", "tools/", ".github/", "package.json"]}
  "2": {name: design,          paths: ["assets/base.css", "assets/critical.css", "snippets/css-variables.liquid", "listings/"]}
  "3": {name: commerce,        paths: ["sections/header*", "sections/main-product*", "sections/main-cart*"]}
  "4": {name: tech-commerce,   paths: ["snippets/spec-*", "snippets/compare-*", "snippets/compat-*", "snippets/fit-*"]}
  "5": {name: seo-aeo,         paths: ["snippets/meta-tags.liquid", "snippets/structured-data-*"]}
  "6": {name: qa,              paths: ["tests/", "tools/preview/"]}
  "7": {name: docs,            paths: ["docs/merchant/", "docs/support/", "docs/release/", "harness/handoffs/"], tier: T0}
shared_append_only: ["locales/*.json", "layout/theme.liquid", "snippets/icon.liquid", "config/settings_schema.json"]
labels: {file: core/labels.json, aliases: {"state:ready-for-agent": "state:ready"}}
claims: {lease_minutes: 30, heartbeat_minutes: 10, branch_pattern: "agent/{runtime}/{issue}-{slug}"}
plan: {min_ready: 8, target_ready: [10, 20]}
ci:
  mode: local                            # PRs verified by script; GitHub CI on default branch only
  worktree_cache: ~/.relay/ci-wt
  steps:
    - {name: check,    cmd: "npm run -s check"}
    - {name: validate, cmd: "npm run -s validate"}
    - {name: test,     cmd: "npm run -s test"}
    - {name: budget,   cmd: "npm run -s budget"}
  full_steps: ["npm run -s preview", "npm run -s test:a11y", "npm run -s test:seo", "npm run -s test:responsive"]
  sync_steps: ["npm run -s validate", "npm test --silent"]
  retry_once_on_fail: true
  install: {cmd: "npm ci --silent", cache_key_file: package-lock.json}
bot:
  gate: true
  logins: ["chatgpt-codex-connector[bot]"]
  require_reply_from_non_bot: true
  recheck_after_push_minutes: 3
environment:                              # real-environment proof target (scoped, reversible)
  name: dev-store
  target_ref: env:DEV_STORE               # never the production store
  gate_theme_ref: env:GATE_THEME_ID
  preview_theme_ref: env:PREVIEW_THEME_ID
  secrets: env                            # credentials only from environment or ephemeral session
proof:
  pre_merge: {push: "shopify theme push --store ${DEV_STORE} --theme ${GATE_THEME_ID} --json", probe_pages: ["/", "/collections/all", "/products/${FIRST_PRODUCT}", "/search?q=a", "/cart", "/pages/contact", "/blogs/news", "/collections", "/nope-404"], error_signatures: ["Liquid error", "Liquid syntax error", "translation missing"]}
  post_merge: {suite: quick, screenshots_max: 4, viewports: [375, 1440], modes: [light, dark]}
  release: {suite: full, include: [lighthouse, theme_editor]}
resolvers:
  - {match: "**/*.md", strategy: union}
  - {match: "{templates,sections}/*.json", strategy: json-deep-merge, order_keys: [order, block_order]}
  - {match: "snippets/importmap.liquid", strategy: line-union}
  - {match: "locales/*.json", strategy: keep-both}
routing: {include: routing.yaml}           # or inline per section 8.1
security:
  secret_patterns: ["(?i)password\\s*[:=]\\s*\\S+", "shpat_[A-Za-z0-9]+", "ghp_[A-Za-z0-9]+", "sk-[A-Za-z0-9]{20,}"]
  secret_hash_list_file: ~/.relay/secret-hashes     # hashes of known secrets, outside repo
  destructive_allowlist: []
  mutation_scope: [dev-store]
telemetry: off
brief_rules: [token-rules, codex-rules, worktree-safety, honesty, security]
honesty: {require_not_verified: true, evidence_lint: true, mutation_check_paths: ["tests/fixtures/"]}
contract: {mode: enforce, closing_keywords: never, reopen_on_incomplete: true, release_blocking: false}   # mode: enforce | warn | off
notifications: {owner_decisions: status_only}
```

Schema enforcement: `core/workflow.schema.json` (JSON Schema draft 2020-12). Validation errors report YAML path and line.

## 11. Templates

| Template | Content |
|---|---|
| `AGENTS.template.md` | Neutral contract: sources of truth table, architecture rules (profile-supplied), tier routing table with tier names only, git workflow, agent workflow, validation commands, standards, handoff format, honesty rules, security rules. Target about 6 KB; doctor warns at 24 KB |
| `CLAUDE.md` template | `@AGENTS.md` line, then a short "Claude-only" block (subagent roster path, hooks, effort env, recovery order) |
| issue template | Objective, Context, Requirements, Acceptance Criteria, Owned Paths, Shared / Forbidden Paths, Dependencies, Validation, Documentation Impact, plus Design Spec (UI) and Risk |
| PR template | Runtime, Logical Role, Issue (`Closes #`), Branch, Outcome, Implementation, Validation (real results), NOT_VERIFIED, Evidence, Responsive Testing, Accessibility, SEO/AEO, Performance, Screenshots, Integration Notes, Known Limitations |
| `labels.json` | Full label set from ARCHITECTURE section 5 with colours and descriptions |
| `STATE.json` | Section 6.2 schema with defaults |
| handoff template | Section 6.4 comment and the 300-word file |
| decision template | Question, options with consequences, default, deadline, who decides |
| briefs | See section 9.1 |

## 12. Runtime packages, installer CLI, doctor

### 12.1 Install flows per runtime

| Runtime | Flow |
|---|---|
| Claude Code | `/plugin marketplace add <owner>/relay`, `/plugin install workflow@relay-marketplace`, `/workflow:init`. Alternatively `npx relay-workflow init --runtime claude` writes `.claude/` files into the repo without the plugin. |
| Codex | `npx relay-workflow init --runtime codex` → managed block in `AGENTS.md`, `.relay/codex/prompts/`, `.relay/bin/relay-codex-dispatch`, optional snippet for `~/.codex/config.toml` (printed, not written, unless `--write-user-config`). Enable the Codex GitHub bot on the repo separately. Dispatch: `relay-loop --runtime codex` or Action. |
| Cursor | `init --runtime cursor` → `.cursor/rules/relay.mdc` (AGENTS.md pointer + tier names + claim/handoff protocol; uses MCP tools if registered) |
| Gemini CLI | `init --runtime gemini` → `GEMINI.md` (imports or copies AGENTS.md) or extension manifest |
| Copilot | `init --runtime copilot` → `.github/copilot-instructions.md` |
| Any other MCP agent | Register `relay-mcp` in its MCP config; follow AGENTS.md |

### 12.2 CLI installer: `npx relay-workflow`

```
relay-workflow init     [--stack S] [--runtime list] [--dry-run] [--yes] [--version X]
relay-workflow doctor   [--fix] [--json]
relay-workflow update   [--to X] [--dry-run]          # three-way diff, managed blocks only
relay-workflow uninstall [--keep-config]              # restores from .relay/backup
relay-workflow route|status|report                    # thin wrappers over scripts
```

Guarantees: idempotent; `--dry-run` prints unified diffs and writes nothing; existing `AGENTS.md`/`CLAUDE.md`/settings content is preserved by managed blocks delimited by `<!-- relay:begin name -->` / `<!-- relay:end name -->` (JSON files use a `"_relay"` key or deep merge with recorded keys); before first write, originals are copied to `.relay/backup/<timestamp>/`; `.relay/lock.json` records version and per-file checksums so `update` detects hand edits and asks; `uninstall` removes only managed blocks and files whose checksums still match. No postinstall scripts, no telemetry, no network except fetching the package itself.

### 12.3 `/workflow:doctor` checks

| Check | Pass condition | Fix |
|---|---|---|
| CLAUDE imports AGENTS | `CLAUDE.md` contains a line `@AGENTS.md` outside code fences (when Claude runtime enabled) | insert managed import block |
| AGENTS neutral | AGENTS.md contains no model ids matching `runtimes.*.models` values or `claude-`/`gpt-`/`gemini-` patterns, no `.claude/` hook references, no `SendMessage` | report lines; `--fix` suggests tier names |
| AGENTS size | below `agents_md.max_bytes` (default 32768 fail, 24576 warn) | trim suggestions |
| Generated drift | checksums of generated blocks/files match lock | show diff |
| Labels | all labels in `labels.json` exist; no state/owner duplicates on open issues | create / lint-fix |
| Auth | `gh auth status` ok; scopes sufficient; runtime binaries present for enabled runtimes | instructions |
| Config | schema-valid; tiers priced; roles' paths exist | messages |
| Routing sanity | every task class resolves; top-tier caps within 5 percent; effort not high | |
| Scripts | executable; `shellcheck` if available | chmod |
| Secrets | repo and docs scan clean; no secret in STATE.json or ledger | block |
| Worktrees | none inside main checkout; stale worktrees listed | prune |
| Compat | versions meet matrix (section 14) | upgrade hint |
| MCP | server starts and lists every tool, including `issue_contract` and `contract_mark` (if registered) | |
| Contract | `contract.mode` is valid; labels `contract:*` exist | |

Exit 0 all pass, 1 warnings, 3 failures.

## 13. MCP server

Stdio server `relay-mcp` exposing ten tools (the contract gate included, so no runtime can bypass it); input/output schemas are the JSON schemas in `core/schemas/mcp/*.json`. Tool-to-script mapping: `claim_issue`→`relay-claim`, `release_claim`→`relay-lease release`, `handoff`→`relay-handoff post`, `route_model`→`relay-route --json`, `run_local_ci`→`relay-ci`, `enqueue_merge`→`relay-merge` or `relay-quick-merge` by mode, `record_usage`→`relay-ledger append`, `owner_decision`→`relay-decision open` (requires category, contract_gap, evidence, unsafe_because, default), `issue_contract`→`relay-contract <action>` (extract|show|update|check|reconcile|audit|close|sweep|pr_section|release_audit), `contract_mark`→`relay-contract mark`. The server is a thin wrapper (no logic of its own) so behaviour is identical across invocations. Authentication: inherits the invoking user's `gh` credentials; no tokens are stored. Registration snippet (Claude Code `.mcp.json` example):

```json
{ "mcpServers": { "relay": { "command": "npx", "args": ["-y", "relay-workflow", "mcp"] } } }
```

## 14. Versioning and compatibility

Semver. Breaking changes to `workflow.yaml` bump major and ship a `relay-workflow migrate` step. Minimums enforced by doctor (to be confirmed when R0 starts and recorded in `core/compat.json`):

| Component | Minimum (initial assumption) |
|---|---|
| node | 20 |
| git | 2.35 (worktree improvements) |
| gh | 2.40 |
| Claude Code | version supporting plugins with agents, skills, commands, hooks |
| Codex CLI | version supporting non-interactive `exec` |
| bash/zsh | POSIX sh compatible scripts |

Compatibility matrix is generated from CI runs in the sandbox suite (one row per runtime version tested).
