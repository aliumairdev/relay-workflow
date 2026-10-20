---
name: problem-finding
description: Use when a bug or unclear request needs its cause found, with evidence, before choosing a bounded fix.
---

# Problem finding

For a clear tactical bug inspect the failing path, nearby tests and recent file history. Search related code with `rg`; check relevant issues. Read existing review or feature notes.

Record symptom, cause, evidence, confidence and a check that could disprove the cause. Call a cause shared only when it explains another observed failure. Do not widen a local bug into a broad investigation without evidence.

If duplicated rules explain it, use [dry](../dry/SKILL.md). Compare the smallest complete fix with a wider repair only when the choice matters. Proceed with a clear, authorised fix using a failing regression test ([surgical-patch](../surgical-patch/SKILL.md)). Use [grilling](../grilling/SKILL.md) only for unsettled product decisions.
