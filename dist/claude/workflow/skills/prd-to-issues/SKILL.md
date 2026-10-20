---
name: prd-to-issues
description: Use when accepted requirements must be broken into small, traceable GitHub issues with acceptance checks.
---

# PRD to issues

Read the existing spec, architecture and tracker. Do not replace the baseline with a new requirements issue. Preserve requirement IDs.

Draft small, complete customer slices with: title, release, requirement IDs, behaviour, protected boundaries, acceptance tests, dependencies and external gates. Respect release ordering. Do not infer a capability from a registered class or mock.

Check open and closed issues for duplicates. Use the plugin's issue template and labels (`relay-labels`, `state:ready` only when dependencies are met). Create issues only when asked; otherwise return the draft breakdown. Record real issue links in the tracker after creation; never invent numbers.
