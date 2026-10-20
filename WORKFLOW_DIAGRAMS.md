# Workflow Diagrams

Part of the multi-agent build workflow plugin design package. See also [PRD.md](PRD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [PLUGIN_SPEC.md](PLUGIN_SPEC.md), [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

All diagrams are Mermaid. Elements labelled "NEW" are plugin design that did not exist in the Nexus build; unlabelled elements were observed in the Nexus build (evidence in [ARCHITECTURE.md](ARCHITECTURE.md)).

## Table of contents

- [a. Agent topology and model routing](#a-agent-topology-and-model-routing)
- [b. End-to-end issue lifecycle](#b-end-to-end-issue-lifecycle)
- [c. PR review sequence](#c-pr-review-sequence)
- [d. Issue and PR label state machines](#d-issue-and-pr-label-state-machines)
- [e. Merge queue and conflict resolution, gated and fast-merge](#e-merge-queue-and-conflict-resolution)
- [f. Failure recovery](#f-failure-recovery)
- [g. Owner decisions and security gates](#g-owner-decisions-and-security-gates)
- [h. Plugin component diagram](#h-plugin-component-diagram)
- [i. Build timeline, Day 1 to Day 5](#i-build-timeline)
- [j. Multi-runtime topology](#j-multi-runtime-topology)
- [k. Claude to Codex to Claude handoff sequence](#k-claude-to-codex-to-claude-handoff-sequence)
- [l. Cross-agent label state machine](#l-cross-agent-label-state-machine)
- [m. Model routing decision flow](#m-model-routing-decision-flow)
- [n. Cost governor flow](#n-cost-governor-flow)
- [o. Install and distribution pipeline](#o-install-and-distribution-pipeline)
- [p. Runtime-neutral MCP tool architecture](#p-runtime-neutral-mcp-tool-architecture)
- [q. Issue contract: complete issue ownership](#q-issue-contract-complete-issue-ownership)

---

## a. Agent topology and model routing

Model tiers are shown on every node. In Nexus the whole mix ran at effort medium (`CLAUDE_CODE_EFFORT_LEVEL=medium` in `.claude/settings.json`).

```mermaid
flowchart TB
  OWNER["Human owner<br/>decisions and secrets"]
  ORCH["Orchestrator Main<br/>Sonnet, terse turns"]
  subgraph PLAN["Planning tier"]
    PLANNER["planner<br/>Opus, rare"]
    FABLE["fable-architect<br/>Fable, exceptional only"]
  end
  subgraph BUILD["Implementers, Sonnet, effort medium"]
    A1["1 Foundation"]
    A2["2 Design"]
    A3["3 Commerce"]
    A4["4 Tech commerce"]
    A5["5 SEO AEO"]
    A6["6 QA"]
  end
  subgraph REVIEW["Review tiers"]
    SUP["supervisor<br/>Sonnet, default reviewer"]
    SENIOR["senior-reviewer<br/>Opus, high risk only"]
    CODEXBOT["Codex bot<br/>external reviewer"]
    AUDIT["release-auditor<br/>Opus, RC audits"]
  end
  DOCS["7 Docs<br/>Haiku, batched"]
  GH["GitHub control plane<br/>issues PRs labels STATE.json"]

  OWNER --> ORCH
  ORCH -->|"decompose"| PLANNER
  ORCH -->|"packet under 500 words"| FABLE
  ORCH -->|"dispatch brief"| A1
  ORCH --> A2
  ORCH --> A3
  ORCH --> A4
  ORCH --> A5
  ORCH --> A6
  ORCH --> DOCS
  A1 --> GH
  A2 --> GH
  A3 --> GH
  A4 --> GH
  A5 --> GH
  A6 --> GH
  DOCS --> GH
  GH -->|"every PR"| SUP
  GH -->|"every PR"| CODEXBOT
  SUP -->|"risk flag"| SENIOR
  ORCH -->|"release"| AUDIT
  SUP -->|"verdict"| ORCH
  SENIOR -->|"verdict"| ORCH
  CODEXBOT -->|"comments"| GH
  ORCH -->|"merge queue"| GH
```

Tier share target from `model-routing-cost.md`: Sonnet about 90 to 95 percent, Haiku 3 to 7 percent, Opus plus Fable combined 2 to 5 percent.

## b. End-to-end issue lifecycle

```mermaid
flowchart TD
  P["Plan: spec and ADRs"] --> I["Create issues with labels<br/>agent N, state ready, priority, area"]
  I --> D["Dispatch: brief plus token rules"]
  D --> C["Claim: state in-progress<br/>CLAIMED comment"]
  C --> W["Branch and worktree<br/>agent/N/issue-slug"]
  W --> IMP["Implement"]
  IMP --> LCI{"Local CI green?<br/>check validate test budget"}
  LCI -->|no| IMP
  LCI -->|yes| PR["Open PR (one slice)<br/>Refs issue + Contract Coverage"]
  PR --> REV["Supervisor review<br/>plus Codex bot"]
  REV --> RISK{"High risk?"}
  RISK -->|yes| SEN["Senior review"]
  RISK -->|no| V
  SEN --> V{"Verdict"}
  V -->|changes| RW["Rework: resume builder<br/>SendMessage"]
  RW --> IMP
  V -->|approved| Q["Merge queue"]
  Q --> M["Squash merge: records the slice,<br/>does NOT close the issue (diagram q)"]
  M --> PM["Post-merge QA agent<br/>on main, mapped to requirements"]
  PM --> RP{"Real environment proof ok?"}
  RP -->|no| RC["Root cause first debugging<br/>new fix issue"]
  RC --> I
  RP -->|yes| CL["Evidence logged per requirement"]
  CL --> GATE{"Whole issue contract<br/>satisfied? (q)"}
  GATE -->|no| I
  GATE -->|yes| DONE["Final audit, then closed"]
```

## c. PR review sequence

```mermaid
sequenceDiagram
  participant B as Builder
  participant GH as GitHub
  participant O as Orchestrator
  participant S as Supervisor Sonnet
  participant X as Senior Opus
  participant K as Codex bot
  participant Q as Merge queue
  B->>GH: push branch, open PR, label review main
  GH-->>K: PR opened
  K->>GH: inline comments
  O->>S: review brief and PR number
  S->>GH: read diff name-only first
  S->>S: scratch worktree, run local CI
  alt high risk path or label
    S->>O: escalate with compact packet
    O->>X: packet under 500 words
    X->>O: verdict
  end
  S->>GH: MAIN REVIEW comment
  alt changes requested
    O->>B: SendMessage with numbered list
    B->>GH: fix commits and reply to each Codex thread
    O->>S: re-review delta only
  end
  S->>GH: label review approved
  O->>Q: enqueue PR and issue
  Q->>GH: count unanswered Codex comments
  Q->>GH: squash merge
  Q->>GH: close issue
```

## d. Issue and PR label state machines

Observed in Nexus: `state:*` on issues and `review:*` on PRs.

```mermaid
stateDiagram-v2
  [*] --> backlog
  backlog --> ready_for_agent: dispatched
  ready_for_agent --> in_progress: claimed
  in_progress --> review: PR opened
  review --> changes_requested: reviewer
  changes_requested --> in_progress: builder resumed
  review --> done: merged and closed
  in_progress --> blocked: dependency or owner
  blocked --> ready_for_agent: unblocked
  done --> [*]
```

```mermaid
stateDiagram-v2
  [*] --> review_main: PR opened
  review_main --> review_changes: changes requested
  review_changes --> review_main: builder pushed fixes
  review_main --> review_approved: supervisor and gates pass
  review_approved --> merged: queue squash merge
  merged --> [*]
```

## e. Merge queue and conflict resolution

```mermaid
flowchart TD
  START["merge request: PR and issue"] --> MODE{"Policy mode"}
  MODE -->|gated| LOCK["Take merge lock<br/>mkdir lock, retry every 10 s"]
  MODE -->|fast| QM["quick-merge: try squash merge"]
  LOCK --> ST{"Already merged?"}
  ST -->|yes| SKIP["Skip"]
  ST -->|no| BEH{"Behind main?"}
  BEH -->|yes| SYNC["sync-pr: merge main into branch"]
  BEH -->|no| CI
  SYNC --> CONF{"Conflicts?"}
  CONF -->|no| CI
  CONF -->|yes| RES["Resolvers by file type<br/>md union, json deep merge,<br/>importmap union, locales keep both"]
  RES --> OKR{"Resolved?"}
  OKR -->|no| MAN["Escalate: manual resolution"]
  OKR -->|yes| VT["validate and test, retry once"]
  VT --> PUSH["push branch"]
  PUSH --> CI["Local CI script"]
  CI -->|fail| REJ["SKIP and report"]
  CI -->|pass| CX{"Unanswered Codex comments?"}
  CX -->|yes| REJ
  CX -->|no| SC{"Store check passes?"}
  SC -->|no| REJ
  SC -->|yes| AP["Approve comment and labels"]
  AP --> SQ["Squash merge"]
  SQ --> CLS["Close issue, state done"]
  CLS --> RF["Refresh preview theme"]
  QM -->|merge fails| QS["Sync main with resolvers, push"]
  QS --> QM2["Retry squash merge"]
  QM2 --> QC["Close issue with note:<br/>verification follows on main"]
  QC --> PMQ["Post-merge QA on main"]
```

## f. Failure recovery

```mermaid
flowchart TD
  F["Failure detected"] --> T{"Type"}
  T -->|rate limit| RL["Backoff, record in ledger"]
  RL --> RS["Resume agent via SendMessage"]
  RS --> RL2{"Still limited?"}
  RL2 -->|yes| FB["Fall back to other tier or runtime"]
  T -->|machine overload| OV["Read load average"]
  OV --> LW["Pause new dispatch<br/>reduce concurrency"]
  LW --> RR["Re-run flaky tests once<br/>after load drops"]
  T -->|merge conflict| CF["Run resolvers"]
  CF --> CF2{"Resolved?"}
  CF2 -->|no| CFM["Resume builder to fix"]
  T -->|flaky test| FL["Re-run once, then check load"]
  FL --> FL2{"Fails again?"}
  FL2 -->|yes| FLR["Treat as real, create bug issue"]
  T -->|stuck agent| SK["Heartbeat stale"]
  SK --> SK2["Probe, then resume or kill"]
  SK2 --> SK3["Relabel ready for another agent"]
  T -->|network blip| NB["Retry with backoff, 3 tries"]
  NB --> NB2{"Persistent?"}
  NB2 -->|yes| NBO["Mark blocked, notify owner"]
  T -->|duplicate agents| DU["Lease check on claim"]
  DU --> DU2["Keep oldest claim, stop others"]
```

## g. Owner decisions and security gates

```mermaid
flowchart TD
  A["Agent needs an action"] --> C1{"Class"}
  C1 -->|"names URLs passwords deletions publish<br/>product ambiguity, scope change<br/>(all six facts recorded; never 'may I finish?')"| OD["Owner decision queue"]
  OD --> OQ["Write decision request<br/>with options and default"]
  OQ --> WAIT["Mark blocked owner<br/>agent continues other work"]
  WAIT --> ANS["Owner answers"]
  ANS --> LOGD["Record decision in ADR or STATE"]
  C1 -->|"store or env mutation"| SG{"Scoped and reversible?"}
  SG -->|no| OD
  SG -->|yes| EX["Execute with undo note"]
  C1 -->|"touches secrets"| SEC["Secret guard hook"]
  SEC --> SEC2{"Secret in diff or output?"}
  SEC2 -->|yes| BLK["Block commit and redact"]
  SEC2 -->|no| OK["Allow"]
  C1 -->|"destructive command"| DG["Destructive gate hook"]
  DG --> DG2{"Allow listed?"}
  DG2 -->|no| OD
  DG2 -->|yes| OK
  EX --> EV["Evidence recorded"]
  OK --> EV
```

## h. Plugin component diagram

```mermaid
flowchart LR
  subgraph PLUGIN["multi-agent-workflow plugin"]
    CMD["commands<br/>init plan dispatch review<br/>merge status proof resume route"]
    SK["skills<br/>orchestrate review-protocol<br/>handoff real-env-proof routing"]
    AG["agents<br/>planner implementers<br/>supervisor senior docs"]
    HK["hooks<br/>stop goal loop<br/>secret guard destructive gate"]
    SC["scripts<br/>merge sync local-ci<br/>resolvers codex-gate<br/>worktree load route ledger"]
    TP["templates<br/>AGENTS.md labels.json<br/>briefs STATE handoff"]
    CFG["workflow.yaml"]
    ADP["adapters<br/>github claude codex"]
  end
  CMD --> SK
  SK --> AG
  CMD --> SC
  HK --> SC
  SC --> ADP
  SK --> CFG
  SC --> CFG
  CMD --> TP
  ADP --> GH["GitHub"]
  ADP --> RT["Runtimes"]
```

## i. Build timeline

Dates are from `git log` on the Nexus repo: 72 commits on 2026-10-18, 159 on 2026-10-19, 10 on 2026-10-20 at snapshot. Milestone names are the real GitHub milestones (M1 12 issues, M2 31, M3 20, M4 49, M5 19 at snapshot). Calendar days are compressed; the sprint was planned as "5 Day Sprint".

```mermaid
gantt
  title Nexus build structure
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section M1 Foundation
  Specs harness foundation       :done, m1, 2026-10-18, 1d
  section M2 Core Commerce
  Header cards PDP cart           :done, m2, 2026-10-18, 1d
  section M3 Tech Differentiation
  Compare compat fit modules      :done, m3, 2026-10-19, 1d
  section M4 Presets and Hardening
  Presets QA UI audits polish     :done, m4, 2026-10-19, 2d
  section M5 Release
  Docs audits Lighthouse listing  :active, m5, 2026-10-20, 1d
  section Loops
  Design system reset plus Codex gate  :done, l1, 2026-10-18, 2d
  Fast merge directive plus post-merge QA :done, l2, 2026-10-19, 2d
```

## j. Multi-runtime topology

NEW design, generalising the Nexus use of Claude Code subagents plus the Codex GitHub bot.

```mermaid
flowchart TB
  GH["GitHub control plane<br/>labels claims handoffs STATE.json"]
  DISP["Dispatcher<br/>human or orchestrator or Action"]
  ROUTER["Router and cost governor"]
  subgraph CLAUDE["Claude Code runtime"]
    CS["Subagents<br/>Haiku Sonnet Opus Fable"]
    CR["Resume via SendMessage"]
  end
  subgraph CODEX["Codex runtime"]
    CE["codex exec CLI"]
    CC["Codex cloud tasks"]
    CB["Codex GitHub bot reviewer"]
  end
  subgraph OTHER["Extension runtimes"]
    GE["Gemini CLI"]
    CU["Cursor"]
  end
  GATES["Runtime neutral scripts<br/>local CI merge queue store check"]
  DISP --> ROUTER
  ROUTER -->|"agent claude"| CS
  ROUTER -->|"agent codex"| CE
  ROUTER -->|"agent codex cloud"| CC
  ROUTER -->|"extension"| GE
  ROUTER --> CU
  CS <--> GH
  CE <--> GH
  CC <--> GH
  CB --> GH
  GE <--> GH
  CU <--> GH
  GH --> GATES
  GATES --> GH
```

## k. Claude to Codex to Claude handoff sequence

NEW design. Review always crosses runtimes.

```mermaid
sequenceDiagram
  participant H as Human or orchestrator
  participant GH as GitHub
  participant C as Claude agent
  participant X as Codex agent
  participant R as Claude reviewer
  H->>GH: label agent claude and state ready
  C->>GH: atomic claim comment and label, lease 30 min
  C->>GH: heartbeat comment every 10 min
  C->>C: implement in worktree agent/claude/N-slug
  C->>GH: handoff comment, label handoff to-codex
  C->>GH: release claim
  X->>GH: read handoff comment first
  X->>GH: claim with new lease, label agent codex
  X->>X: continue on same branch in own worktree
  X->>GH: open PR, state review, review claude
  R->>GH: claim review, runtime differs from implementer
  R->>GH: changes requested, numbered list
  GH-->>X: handoff to-codex rework
  X->>GH: fix and push
  R->>GH: review approved
  GH->>GH: merge queue then done
```

## l. Cross-agent label state machine

NEW design. `handoff:*` labels are transient and removed when the receiver claims.

```mermaid
stateDiagram-v2
  [*] --> ready
  ready --> claimed: agent claim comment
  claimed --> in_progress: first push
  claimed --> ready: lease expired
  in_progress --> ready: lease expired
  in_progress --> handoff_pending: handoff label set
  handoff_pending --> claimed: receiver claims
  in_progress --> review: PR opened
  review --> changes_requested: reviewer from other runtime
  changes_requested --> in_progress: owner of PR resumes
  changes_requested --> handoff_pending: handoff to other runtime
  review --> approved: cross review passes
  approved --> done: merged
  in_progress --> blocked: dependency
  claimed --> blocked: owner decision
  blocked --> ready: unblocked
  done --> [*]
```

## m. Model routing decision flow

NEW automated design. In Nexus this logic lived in the orchestrator's head and in a memory note (`model-routing-cost.md`).

```mermaid
flowchart TD
  T["Task arrives with class and issue"] --> CL{"Task class"}
  CL -->|docs| H["Haiku medium"]
  CL -->|plan decompose| PL{"Major or novel architecture?"}
  PL -->|yes| OP["Opus medium"]
  PL -->|no| SO
  CL -->|implement or routine review| RS["Compute risk score"]
  RS --> SC{"Score"}
  SC -->|"below 40"| SO["Sonnet medium"]
  SC -->|"40 to 79"| SO2["Sonnet plus mandatory second review"]
  SC -->|"80 or more"| PK["Build compact packet<br/>under 500 words"]
  PK --> OP2["Opus senior review"]
  CL -->|real env bug| DB["Sonnet root cause first"]
  DB --> RC{"Root cause known after 2 attempts?"}
  RC -->|no| SDB["Escalate one tier"]
  RC -->|yes| SO
  SO --> CAP{"Top tier cap exceeded?"}
  OP2 --> CAP
  SDB --> CAP
  CAP -->|yes| DEF["Queue for owner or downgrade<br/>with warning"]
  CAP -->|no| GO["Dispatch with token rules"]
  GO --> OUT{"Outcome"}
  OUT -->|"2 failed reviews or failed proof"| ESC["Escalate one tier"]
  ESC --> PK
  OUT -->|"clean first pass"| DE["Record for de-escalation stats"]
```

## n. Cost governor flow

NEW design.

```mermaid
flowchart TD
  D["Dispatch request"] --> G1["Governor reads ledger and load"]
  G1 --> L1{"Load average above limit?"}
  L1 -->|yes| QW["Queue, retry after 30 s"]
  L1 -->|no| B1{"Per PR ceiling or tier share exceeded?"}
  B1 -->|yes| B2["Block or downgrade, notify orchestrator"]
  B1 -->|no| RUN["Run agent"]
  RUN --> LG["Append usage row to ledger"]
  LG --> RLQ{"Rate limited?"}
  RLQ -->|yes| BO["Exponential backoff"]
  BO --> RES["Resume same agent"]
  RES --> FB{"Retries over 3?"}
  FB -->|yes| ALT["Fall back to cheaper tier or other runtime"]
  FB -->|no| RUN
  RLQ -->|no| FIN["Finish"]
  FIN --> RPT["Daily report<br/>cost per merged PR, tier mix, rework by tier"]
  RPT --> FBK["Feedback: propose routing changes<br/>owner approves"]
```

## o. Install and distribution pipeline

NEW design. One canonical source; every per-runtime package is generated, never hand-maintained.

```mermaid
flowchart LR
  subgraph CANON["Canonical core, runtime neutral"]
    WY["workflow.yaml schema"]
    AM["AGENTS.md template"]
    BR["brief and prompt library"]
    SCR["scripts"]
    LB["labels.json"]
    SCH["STATE and handoff schemas"]
    PRF["stack profiles"]
  end
  GEN["Generators<br/>build step with golden tests"]
  CANON --> GEN
  GEN --> CP["Claude Code plugin<br/>plugin.json and marketplace"]
  GEN --> CX["Codex package<br/>AGENTS.md and exec scripts"]
  GEN --> CUR["Cursor rules"]
  GEN --> GM["Gemini CLI extension"]
  GEN --> CO["Copilot instructions"]
  GEN --> NPM["npm CLI installer"]
  GEN --> MCP["MCP server"]
  CP -->|"plugin install"| USER["Target repo"]
  NPM -->|"init doctor update uninstall"| USER
  CX --> USER
  CUR --> USER
  GM --> USER
  CO --> USER
  MCP -->|"tools over MCP"| USER
```

## p. Runtime-neutral MCP tool architecture

NEW design. Any MCP-capable agent can participate without runtime-specific code.

```mermaid
flowchart TB
  subgraph AGENTS["Any MCP capable agent"]
    A1["Claude Code"]
    A2["Codex"]
    A3["Gemini CLI"]
    A4["Cursor"]
  end
  SRV["workflow MCP server<br/>stdio, local"]
  subgraph TOOLS["Neutral tools"]
    T1["claim_issue"]
    T2["release_claim"]
    T3["handoff"]
    T4["route_model"]
    T5["run_local_ci"]
    T6["enqueue_merge"]
    T7["record_usage"]
    T8["owner_decision"]
    T9["issue_contract"]
    T10["contract_mark"]
  end
  subgraph CORE["Shared core"]
    SC["scripts"]
    AD["control plane adapter"]
    LG["usage ledger"]
    ST["STATE.json"]
  end
  A1 --> SRV
  A2 --> SRV
  A3 --> SRV
  A4 --> SRV
  SRV --> TOOLS
  TOOLS --> CORE
  AD --> GH["GitHub"]
```

## q. Issue contract: complete issue ownership

PR complete != issue complete. Merged != verified. GitHub closed != contract complete.

```mermaid
flowchart TD
  X["Claim / dispatch:<br/>extract the whole issue + amending comments<br/>into the issue contract"] --> PL["Plan the COMPLETE solution<br/>journal entries name requirement ids"]
  PL --> SL["Implement one slice"]
  SL --> PR["PR: Refs #N, Contract Coverage,<br/>Issue completion YES/NO"]
  PR --> RV{"Review: PR correct AND<br/>coverage claim truthful?"}
  RV -->|"false claim / scope moved"| SL
  RV -->|"approved (ISSUE_COMPLETE may be NO)"| MG["Merge queue records the slice"]
  MG --> PF["Proof: CI evidence, review evidence,<br/>post-merge QA mapped to ids"]
  PF --> RC{"Contract reconcile:<br/>every requirement has a final disposition?"}
  RC -->|"requirements remain"| RDY["Issue stays active: state:ready<br/>claim and worktree released"]
  RDY -->|"orchestrator / relay-loop / Stop hook,<br/>no human needed"| CL["Next claim on slice branch -sN"]
  CL --> SL
  RC -->|"only EXTERNALLY_BLOCKED left"| WT["state:blocked + contract:blocked-external<br/>wait, NOT complete"]
  WT -->|"blocker cleared"| RDY
  RC -->|"all complete"| AU["Final acceptance audit<br/>(rev-bound)"]
  AU --> CLS["relay-contract close<br/>state:done + contract:complete"]
  GHC["Issue closed on GitHub<br/>(manual or Closes #)"] --> CK{"Contract complete?"}
  CK -->|"no: GITHUB_CLOSED_CONTRACT_INCOMPLETE"| RO["Reopen (policy) or release blocker"]
  RO --> RDY
  ED["Issue edited mid-run"] --> DR["Drift: new requirements added as TODO,<br/>vanished ones flagged; closure denied"]
  DR --> RC
```
