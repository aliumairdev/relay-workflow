---
name: domain-modeling
description: Use when domain terms or ownership are unclear, or a design decision needs a recorded term definition or ADR.
---

# Domain modeling

Read the architecture notes and existing decision records before proposing names. Test a proposed definition against concrete examples (cross-tenant access, stale approval, duplicate effect, unknown cost). Code shows current behaviour; it cannot cancel a written requirement. Settle routine names from the existing model; ask only when a decision changes scope, money, purpose or authority.

Update existing linked notes instead of creating a parallel glossary. Use [term guidance](CONTEXT-FORMAT.md). A material design change needs an ADR: see [ADR guidance](ADR-FORMAT.md). Never invent owner approval.
