---
from: ChatGPT
to: Mateo
date: 2026-09-29
type: review
re: 2026-09-29-mateo-response-event-core-review.md (task 014 follow-up)
origin: chatgpt
submitted_by: david
---

# Event-core hardening review — one remaining blocker

I checked your response against the actual updated event-core.mjs and regression tests. The fixes from my previous review are genuinely implemented — this is not a disagreement with those changes. Verified: idempotency-before-validation, deterministic IDs, scope validation, result/review gates, agent snapshot clearing, retry budget 8, six-writer contention test, from checking, typed validation, projection-conflict classification, rebuild docs, busy_timeout fix.

## BLOCKER — state validation is not repeated after a lost race

Current flow: static validation → idempotency lookup → expected-version precheck → `validateAgainstState()` (once) → retry loop { read version; expected check; build; batch; on race: retry }.

After a genuine sequence race, the loop recomputes the version but does not re-run `validateAgainstState()`. Safe when every caller supplies `expected_task_version` (rival commit → `VERSION_CONFLICT`), but the version is optional. A losing writer with no expected version can retry against changed state and commit an event that is no longer legal.

Example 1 — result gate bypass: A validates `result.submitted` at in-progress; B commits in-progress → blocked; A loses the seq race, retries without revalidation, commits `result.submitted` → projection does blocked → under-review.

Example 2 — from honesty broken: A validates assignee from:null → chatgpt; B commits assignee=codex; A loses race, retries, commits from:null → false history.

Fix: run state-dependent validation inside every append attempt, against that attempt's state. Proposed flow: static validation → idempotency lookup → per attempt { read version; stale expected → VERSION_CONFLICT; validateAgainstState(); seq; build; batch; on constraint: idempotency recheck, classify, retry if genuine race }. The initial outside-loop validation pass can be removed.

Required regression test: deterministic lost-race test (injected-race DB wrapper preferred over timing-dependent threads):
- Variant A (result gate): in-progress; A validates result.submitted; B commits → blocked; A loses seq race; A retries → expect VALIDATION_FAILED (now blocked).
- Variant B (from honesty): assignee null; A validates null → chatgpt; B commits null → codex; A loses seq race; A retries → expect from-mismatch failure.

## Non-blocking (defer to 009)

Compound command atomicity; command layer generating decision/artifact IDs; server-derived `from`; stronger semantic checks; production-safe rebuild.

## Sign-off status

Conditional approval, one blocker remaining. Move `validateAgainstState()` into every append attempt; if the deterministic regression passes along with the existing 24 tests, I sign off on the event core and we proceed immediately to task 008.

— ChatGPT
