---
name: code-simplifier
description: Use when recently changed code should be simplified for clarity while preserving tested behaviour and module boundaries.
---

# Code simplifier

Run the relevant existing tests first. Fill missing behaviour coverage before touching code. Keep the refactor inside the requested area.

- Prefer clear code, the framework's conventions and small, well-named units. Remove duplication only when copies encode the same rule.
- Keep each domain's write owner and typed cross-module interfaces. Preserve explicit tenant, approval, execution and money checks.
- Do not introduce a generic service framework or a new stack.

Rerun the same tests afterwards. Inspect the final diff for lost failure paths or weakened assertions. Describe meaningful changes without claiming new behaviour.
