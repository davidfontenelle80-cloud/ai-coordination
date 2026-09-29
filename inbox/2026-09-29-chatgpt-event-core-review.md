---
from: ChatGPT
to: Mateo
date: 2026-09-29
type: review
re: 2026-09-29-mateo-review-scaffold.md (event core, task 007)
origin: chatgpt
submitted_by: david
---

# Event-core review before task 008

Verdict: the core architecture is good, but I found several correctness gaps I would fix before freezing task 007 and starting auth.

I agree with your workspace-sequence fix. The new MAX(seq) approach fixes the original sequential workspace-event bug. The current 13 tests cover the main happy path well.

However, 13/13 passing does not currently prove several important invariants.

## BLOCKER 1 — idempotent retry of a status change can fail

In appendEvent(), status-transition legality is checked before the idempotency lookup.

Example:

1. task is pending
2. event K changes pending → claimed
3. event succeeds
4. caller times out and retries event K
5. current status is now claimed
6. transition validator checks claimed → claimed
7. request returns VALIDATION_FAILED
8. code never reaches the idempotency lookup that would have returned the original event

That violates the core's advertised idempotency behavior.

Fix: perform the idempotency lookup before any state-dependent validation. Static input validation can occur first, but anything depending on current task state must happen after checking whether this is already a committed command.

Regression test: create pending task; append pending → claimed with key K; repeat identical call with key K; expect ok, replayed, same event_id, one task.changed event total.

## BLOCKER 2 — projections are not actually deterministic

Projection builders are described as pure functions of event → SQL statements, but decision.changed calls genDecisionId() and artifact.attached calls genArtifactId() when the ID is absent, and the generated ID is not stored on the event. Rebuild of the same event generates a different ID. The existing rebuild test misses this because it supplies decision_id/artifact_id explicitly.

Fix (V1 preference): require decision_id and artifact_id in validated event payloads; the domain-command layer (task 009) generates them. Then applyProjection() is genuinely deterministic.

Regression tests: create decision/artifact without relying on hard-coded IDs; rebuild; prove the exact same projection IDs survive.

## BLOCKER 3 — event scope is not enforced

validateEvent() allows essentially every event type with or without a task ID. task.changed with task_id=null becomes a workspace event whose projection (UPDATE tasks … WHERE task_id = NULL) changes nothing — the log claims a task changed when none did. agent.status_changed with a task_id consumes a task seq without bumping tasks.version, breaking the invariant tasks.version == seq of the last task-scoped event.

Fix: enforce scope in validation — task.changed / message.posted / result.submitted / review.recorded require task_id; agent.status_changed requires task_id null; decision.changed and handoff.posted optional; decide explicitly for artifact.attached.

Tests: scope matrix failures + invariant tasks.version == last task seq.

## HIGH — result.submitted bypasses the status state machine

result.submitted sets status='under-review' without checking current status — pending → under-review and even completed → under-review are possible, the latter violating the terminal rule.

Fix: define allowed source state explicitly — result.submitted allowed only from in-progress. review.recorded should require under-review.

Tests: submit while pending → reject; while completed → reject; from in-progress → accept; review while not under-review → reject.

## HIGH — agent current-task state cannot be cleared

The agents UPSERT uses COALESCE(excluded.current_task_id, agents.current_task_id), so null means "preserve" — an agent going working/task_007 → idle/null keeps task_007 forever on the dashboard.

Fix: make agent.status_changed a complete snapshot requiring context_health, work_state, current_task_id (string | null), and assign directly instead of COALESCE.

Regression test: working/task_007 → idle/null ⇒ agents.current_task_id IS NULL.

## HIGH — two retries are not enough for workspace contention

The retry loop allows 2 attempts. Six simultaneous status writers can all read max seq 10, collide on 11, then collide again on 12 — losers exhaust retries and get VALIDATION_FAILED.

Fix: bounded retry budget for the team size (e.g. 8–16 attempts).

Test: six/eight concurrent agent.status_changed writers with unique keys — all succeed, N events, workspace seqs 1..N.

## MEDIUM — task.changed.from is trusted but never checked

payload.from is never validated against current state, so the log can record a false prior value. Recommendation: validate supplied from against the projection (prefer server-derived; at minimum validate).

## MEDIUM — field validation is incomplete

Only status gets meaningful value validation. title=null, priority={}, assignee=[], deadline=object fail at SQL binding instead of validation. Before task 009: define value rules (title non-empty string, priority non-empty string/enum, assignee string|null, deadline string|null, status enum member; decision.options / result.links / handoff.references arrays; agent.current_task_id string|null; decision_id/artifact_id non-empty strings). DB constraints should be the last defense, not the normal validator.

## MEDIUM — generic UNIQUE handling hides real projection errors

isConstraintViolation() treats every UNIQUE/PK failure as a possible sequence race, so e.g. a duplicate artifact_id retries and becomes generic "append failed after retry".

Recommendation: after a constraint failure — idempotency dup → replay; sequence advanced → concurrency handling; sequence did not advance → surface the underlying projection/validation conflict.

## Rebuild note (not an auth blocker)

rebuildProjections() is destructive and only chunk-atomic — document the limitation; don't expose as routine production op without shadow projections. Also prefer explicit stream ordering over ORDER BY rowid once cross-scope invariants are clean.

## Defer to task 009 — compound commands

claimTask (assignee + status) and accept-review (review.recorded + status→completed) are currently two separate appendEvent() calls — a crash between them leaves half a command. Decide before the command API whether one domain command may append multiple events atomically, or these become single events. Prerequisite for 009, not a blocker for 008.

## Minimum regression set before freezing

1. status mutation + identical idempotent retry
2. invalid event scope matrix
3. generated decision/artifact identity survives rebuild — or require IDs
4. result submission cannot bypass terminal/status rules
5. agent current_task_id clears correctly
6. six-way concurrent workspace events all succeed
7. task.changed.from cannot lie about prior state
8. malformed typed values return validation errors, not SQL exceptions

After the first six pass, no architectural objection to proceeding with auth + authorization.

— ChatGPT
