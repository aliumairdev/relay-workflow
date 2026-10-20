#!/bin/sh
# Create a sandbox: bare "remote" + working clone with main, a tiny Node project (npm test passes), a seed spec,
# a fake-gh database, and a workflow.yaml. Prints the sandbox root. Usage: make-repo.sh [dir]
set -eu
ROOT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/relay-sandbox.XXXXXX")}"
mkdir -p "$ROOT"
git init -q --bare -b main "$ROOT/remote.git"
git clone -q "$ROOT/remote.git" "$ROOT/work" 2>/dev/null
cd "$ROOT/work"
git config user.email "relay@example.invalid"; git config user.name "relay-test"
mkdir -p src docs
cat > package.json <<'JSON'
{ "name": "sandbox-app", "version": "0.0.1", "private": true, "scripts": { "test": "node --test", "check": "node -e \"process.exit(0)\"" } }
JSON
printf 'export const add = (a, b) => a + b;\n' > src/index.mjs
printf 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./src/index.mjs";\ntest("add", () => assert.equal(add(1, 2), 3));\n' > index.test.mjs
printf '# Product spec\n\nA tiny app that adds numbers.\n' > docs/PRODUCT_SPEC.md
cat > workflow.yaml <<YAML
version: 1
project: { name: sandbox, repo: local/sandbox, default_branch: main, worktree_root: $ROOT/worktrees }
policy: { mode: gated }
runtimes:
  claude: { enabled: true, resume: send_message, models: { T0: m-haiku, T1: m-sonnet, T2: m-opus } }
  codex: { enabled: true, resume: relaunch, exec_cmd: fake-codex, models: { T0: c-mini, T1: c-default, T2: c-top }, bot: { logins: ["codex-bot[bot]"], severity_block: [P0, P1] } }
review: { cross_runtime: true }
claims: { lease_minutes: 2, heartbeat_minutes: 1 }
ci: { steps: [ { name: check, cmd: "npm run -s check" }, { name: test, cmd: "npm test --silent" } ], sync_steps: ["npm test --silent"] }
bot: { gate: true, logins: ["codex-bot[bot]"] }
resolvers:
  - { match: "**/*.md", strategy: union }
YAML
printf 'node_modules/\n.relay/\n' > .gitignore
git add -A && git commit -q -m "seed" && git push -q origin main
echo '{}' > "$ROOT/gh.db.json"
echo "$ROOT"
