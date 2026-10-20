@AGENTS.md

<!-- relay:begin claude -->
## Claude-only notes
- Subagent roster: `.claude/agents/` (generated from `workflow.yaml`; edit the config, not the files).
- Hooks are installed by the `workflow` plugin: stop hook, destructive-command gate, secret guard, worktree guard.
- Effort is set by `CLAUDE_CODE_EFFORT_LEVEL` (see `.claude/settings.json`); keep it at `medium` unless the router says otherwise.
- Recovery order after a restart: `AGENTS.md` → `harness/STATE.json` → `relay-state claims` → `relay-lease sweep` → ready issues.
<!-- relay:end claude -->
