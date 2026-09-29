---
from: Mateo
to: ChatGPT
date: 2026-09-29
type: review-response
re: 2026-09-29-chatgpt-event-core-review.md (task 014)
origin: mateo
submitted_by: mateo
---

# Response: event-core hardening (task 014)

All six high-priority items and all three mediums are fixed. Suite is
24/24 passing, 15 consecutive clean runs. Item-by-item:

## 1. Idempotency before state validation — FIXED

`appendEvent()` now orders: static validation → idempotency lookup →
version check → state-dependent validation → read/compute → batch. A retry
of a committed status change replays the original event instead of failing
its own transition check (regression test added).

One addition beyond your sketch: the `expected_task_version` check now
also runs early, before state validation. Rationale: a stale expected
version can never succeed, and this keeps concurrent losers deterministically
on `VERSION_CONFLICT` instead of sometimes tripping the new `from`-match
check after a rival commit. (If expected is stale *and* the transition is
illegal, the caller now gets `VERSION_CONFLICT` rather than
`VALIDATION_FAILED` — the stale view is the more actionable error.)

## 2. Deterministic projections — FIXED

`decision_id` and `artifact_id` are now required in payloads (validation
rejects without them). `applyProjection()` no longer calls the generators —
it uses the payload IDs directly, so rebuilds reproduce identical state.
`genDecisionId`/`genArtifactId` stay exported for the task-009 command
layer, which will generate them.

## 3. Scope enforcement — FIXED

Enforced in `validateEvent()`: `task.changed`, `message.posted`,
`result.submitted`, `review.recorded` require `task_id`;
`agent.status_changed` requires `task_id` null; `task.created` generates
when absent; `decision.changed`, `handoff.posted`, `artifact.attached`
are dual-scope. Explicit decision, as you asked: **workspace artifacts are
allowed** (shared references not tied to a task are a legitimate v1 case).
Scope-matrix regression tests added, plus the invariant test
`tasks.version == MAX(seq)` per task scope.

## 4. result/review state gates — FIXED

`result.submitted` is accepted only from `in-progress` (completed stays
terminal — the `completed → under-review` hole is closed).
`review.recorded` requires `under-review`. Regression tests cover
pending-submit reject, completed-submit reject, in-progress-submit accept,
and review-outside-under-review reject.

## 5. Clearable agent task state — FIXED

`agent.status_changed` is now a complete snapshot:
`context_health`, `work_state`, and `current_task_id` (string | null) are
all required, and the projection assigns `current_task_id` directly —
no more `COALESCE`. `working/task_007 → idle/null` now yields NULL, as
your test specifies. Existing callers updated.

## 6. Retry budget + workspace contention — FIXED

Retry budget is 8 attempts (was 2). Analysis: each writer commits exactly
once, so a writer can lose at most N−1 races; 8 covers the team with margin.
New stress test: six simultaneous `agent.status_changed` writers via worker
threads — all succeed, exactly 6 events, workspace seqs 1..6.

## 7. `from` validation — FIXED

A supplied `from` is now checked against the live projection for every
`task.changed` field (status uses the status column; others use their
column). Omitted `from` stays allowed. Lying about the prior value returns
`VALIDATION_FAILED`; it can no longer silently enter the log.

## 8. Field value rules — FIXED

Typed rules across all event types: non-empty strings for title/priority
(targets), `string | null` for assignee/deadline, arrays for
`decision.options` / `result.links` / `handoff.references`, object for
`result.evidence`, string type-checks for notes/reason/key_context/agent_id,
non-empty `decision_id`/`artifact_id`. Malformed values now return
`VALIDATION_FAILED`, never a SQL binding exception (regression test).

## 9. Constraint classification — FIXED

On batch failure: idempotency dup → replay; relevant sequence advanced →
genuine race, retry; sequence did *not* advance → `PROJECTION_CONFLICT`
with the underlying message, surfaced immediately instead of retried into
a generic failure. (The invariant that every committed event in a scope
advances its sequence is what makes this classification sound.)

## Rebuild note — DOCUMENTED

Added the limitation to the `rebuildProjections()` docstring: destructive
and only chunk-atomic, re-run on partial failure, not for routine
production use without shadow projections. Kept `ORDER BY rowid` for now,
per your "not a blocker".

## Compound commands — DEFERRED TO 009 AS AGREED

Noted as a prerequisite in the task-009 file: claim (assignee + status)
and accept-review (review + status→completed) need an atomic multi-event
(or single-event) design before the command API is built.

## One more thing I found

While stress-running the suite I caught a test-harness flake (not core
logic): `sqlite-db.mjs` ran the `PRAGMA journal_mode` probe *before*
setting `busy_timeout`, so workers opening the same file simultaneously
could fail with "database is locked" (~25% of runs). Moved `busy_timeout`
first. 15/15 clean runs since.

## Test summary

24 tests, 13 suites: the original 13 (idempotent retry, stale version,
atomic batch, 8-way claim race, lifecycle + rebuild, workspace seqs) plus
11 new — status-retry replay, scope matrix, scope invariant, ID
requirements, ID rebuild determinism, result/review gates, agent clear,
agent snapshot shape, 6-way workspace contention, from-honesty, value
validation.

If you sign off on this, I'll start task 008 (auth + authorization).

— Mateo
