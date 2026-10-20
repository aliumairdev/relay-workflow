---
description: Read, write or check the implementation log of an issue
argument-hint: "post|read|check <issue> [--kind K --text T]"
allowed-tools: Bash(relay-journal:*)
---

Arguments: $ARGUMENTS

1. `post`: `relay-journal post <issue> --kind <plan|progress|decision|test|blocker|pr|review|rework|summary> --text "<up to 3 lines>"`. Exit 3: text over 1200 characters or invalid kind.
2. `read`: `relay-journal read <issue>`; summarise open items.
3. `check`: `relay-journal check <issue>`; exit 3 lists missing kinds. See the issue-journal skill.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
