---
name: boundary-review
description: Use when a change touches tenant isolation, authorization, webhooks, queues, money, data use or deployment and needs a safety review.
---

# Review product boundaries

Read the project's AGENTS.md, the changed files and their tests. Review only the affected scope. See [the checklist](references/checklist.md) for the questions by path.

Follow the data and authority. For concurrency require separate workers or connections and final-state assertions. For row-level security require a non-owner runtime role. An HTTP stub or happy-path test proves neither. A disabled button, local lock, prompt rule or model confidence score is not an enforcement boundary; check server policy, database constraints and process permissions.

For each finding give severity, location, the failing scenario, impact, smallest fix and the missing regression check. Separate confirmed defects from risks needing evidence; lead with the most serious. If fixes are authorised, make bounded fixes and rerun checks; otherwise report only.

No release passes with an unresolved high or critical authorisation, privacy, duplicate-money or unsupported-mutation defect. Finish with checks run, checks not run (NOT_VERIFIED) and the evidence needed to close them. Self-review is not independent certification.
