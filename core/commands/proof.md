---
description: Run real-environment proof and file bugs for failures
argument-hint: "[ref] [--suite quick|full]"
allowed-tools: Bash(relay-proof:*), Bash(relay-route:*), Bash(relay-journal:*), Read
---

Arguments: $ARGUMENTS

1. Follow the real-env-proof skill. Run `relay-proof --stage <pre-merge|post-merge|release> --ref <ref> --suite <suite>`.
2. Exit 0 pass. 4 platform errors, 6 render errors: bug issues are filed unless `--no-issues`; diagnose root cause first. 5 target unavailable: record every item NOT_VERIFIED and claim nothing.
3. Report the `summary.json` path, failures with observed error text, and issues created.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
