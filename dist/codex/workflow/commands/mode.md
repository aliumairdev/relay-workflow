---
description: Switch the policy mode and record the reason verbatim
argument-hint: "gated|fast [--reason text]"
allowed-tools: Bash(relay-state:*)
---

Arguments: $ARGUMENTS

1. Run `relay-state set policy.mode <mode> --reason "<reason>"`. Use the owner's words for the reason, unedited.
2. Confirm with `relay-state get policy`.
3. Report the old and new mode. `fast` merges first and verifies after; say that plainly and recommend `gated` before a release.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
