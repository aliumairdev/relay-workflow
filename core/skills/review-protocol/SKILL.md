---
name: review-protocol
description: Use when reviewing a pull request with the workflow checklist, posting a verdict, or re-reviewing after rework.
---

# Review protocol

1. Confirm you may review: the implementer's runtime never approves its own PR when `review.cross_runtime` is on; with one runtime, use a different agent instance and role (`relay-verdict` exits 7 otherwise).
2. Read the issue, then `gh pr diff <n> --name-only`, then per-file diffs. Review in the configured order (`review.order`); profiles may add gates.
3. Check out in a scratch worktree (`relay-worktree create --scratch review-<pr>`), run `relay-ci <branch>`, remove the worktree afterwards. Do not merge or push to any environment.
4. Bot comments: `relay-bot-gate <pr>` must report 0 unanswered before approval; each needs a reply from a non-bot account.
5. Verdict: `relay-verdict post <pr> --result APPROVED|CHANGES --checklist <json> --coverage AC1=PASS|FAIL|NOT_COVERED ... --issue-complete YES|NO`. Review the PR AND the truth of its claimed [contract](../issue-contract/SKILL.md) coverage: reject false completion claims, scope moved to follow-ups, runtime claims backed by tests only. ISSUE_COMPLETE=NO can still be APPROVED (one valid slice). CHANGES carries a numbered, file-scoped list. The verdict is bound to the head sha.
6. Re-review checks only the delta since the last verdict's `head_sha` (`review.delta_only_rereview`).
7. Escalation: a risk score above the senior threshold, or `risk:high`, goes to the senior reviewer with a packet (`relay-packet build --pr <n>`, word-limited).
8. Log a `review` entry with `relay-journal post <issue> --kind review ...` ([issue-journal](../issue-journal/SKILL.md)).

Evidence rule: list what you did not run under NOT_VERIFIED; do not approve on unverified claims.
