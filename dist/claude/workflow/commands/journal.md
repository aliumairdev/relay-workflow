---
description: Read, write or check the implementation log of an issue
argument-hint: "post|read|check <issue> [--kind K --text T]"
allowed-tools: Bash(relay-journal:*)
---

Arguments: $ARGUMENTS

1. `post`: `relay-journal post <issue> --kind <plan|implementation|progress|decision|test|proof|blocker|pr|review|rework|summary> [--req AC1,AC2] --text "<up to 3 lines>"`. Exit 3: text over 1200 characters or invalid kind.
2. `read`: `relay-journal read <issue>`; summarise open items.
3. `check`: `relay-journal check <issue> [--final]`; exit 3 lists missing kinds and contract problems (`--final` also requires a complete issue contract). See the issue-journal skill.

Report only results you observed. Anything not run or not observable goes under NOT_VERIFIED with the reason.
