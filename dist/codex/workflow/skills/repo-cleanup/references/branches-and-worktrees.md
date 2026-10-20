# Branches and worktrees

Read `git status --short`, `git worktree list`, branch history and merge state. Confirm the configured origin is the intended repository. Preserve dirty worktrees, unpushed changes and other sessions' branches (`relay-worktree prune` skips active claims).

Remove worktrees and branches only for exact authorised targets. Do not force-delete, reset others' changes or rewrite shared history. Verify merged status against the intended base, not a similarly named remote branch. Never drop a database as part of branch cleanup; shared or production targets are excluded. Do not print credentials while inspecting configuration.
