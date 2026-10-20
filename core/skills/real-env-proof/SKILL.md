---
name: real-env-proof
description: Use when proving behaviour on the real target platform, or debugging a failure that passes offline but fails in the real environment.
---

# Real-environment proof

Offline harnesses diverge from the real platform; only a proof stage turns "merged" into "verified".

## Stages

`relay-proof --stage pre-merge|post-merge|release [--ref <sha|branch>] [--suite quick|full]` runs the profile's steps against the configured dev target only, never production. Exit 0 pass; 4 platform errors; 5 target unavailable (record every item NOT_VERIFIED, claim nothing); 6 render errors. Results go to `harness/proof/<date>/<ref>/summary.json`; failures become bug issues routed one tier higher.

## Root cause first

1. Capture the observed error text exactly, with file, line or page.
2. Form one hypothesis; say how to disprove it.
3. Change one thing; re-run the same probe.
4. Record the cause, evidence and a prevention rule (lint or test) in the profile's lessons registry (`lessons.yaml`) when machine-checkable.
5. After the configured attempts with no root cause, stop and escalate to a senior debugger; do not try variants.

## Evidence

Real output tails, log paths, screenshots (few, at the stated viewports). Scoped, reversible environment changes only; credentials from the environment or an ephemeral session. Platform-specific steps live in the stack profile.

Keep the issue journal current with `test` and `blocker` entries ([issue-journal](../issue-journal/SKILL.md)).
