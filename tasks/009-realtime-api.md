---
id: 009
title: HTTP command + query API
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Authenticated HTTP API — the hub must work fully over plain HTTP/polling
before any realtime is added. **Domain commands, not event creation**:
createTask, claimTask, startTask, blockTask, postMessage, submitResult,
recordReview, requestDecision, resolveDecision, postHandoff, attachArtifact,
setAgentStatus. The server validates, authorizes, and decides which events
each command generates (e.g. recordReview accepted → review.recorded +
task.changed → completed, atomically).

Read endpoints (core, not optional): GET /tasks, /tasks/{id},
/tasks/{id}/events?after_seq=, /tasks/{id}/resume, /activity,
/decisions?state=pending, /agents. The resume packet (goal, state,
assignment, latest accepted decisions, latest relevant messages,
latest result/review, open blocker, artifact refs, current version) is what
lets a replacement session recover after context loss.

Simple rate protection: max request-body size, reasonable command ceiling,
burst protection, 429 response, logging of who hit the limit. No fancy
distributed limiter.

Mechanical prechecks on submitResult (shape only: required fields, valid
links, version match) before Mateo's queue.

**Stable error contract** (defined here, before Codex consumes the API):
AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT, TASK_ALREADY_CLAIMED,
INVALID_TRANSITION, VALIDATION_FAILED, RATE_LIMITED, NOT_FOUND — each with
error_code, message, current_task_version, retryable where applicable.

Blocked on: 007, 008.

**Prerequisite (from ChatGPT's event-core review, 2026-09-29):** decide the
compound-command design BEFORE building this API. Commands like claimTask
(assignee + status change) or recordReview-accepted (review.recorded +
status → completed) are logically one domain action but currently two
`appendEvent()` calls — a crash or conflict between them leaves half a
command committed. Either (a) one domain command may append multiple
events atomically, or (b) these transitions are represented by single
events/projection changes. The choice must be made here, not discovered
mid-implementation. (The 014 hardening also requires command handlers to
generate `decision_id`/`artifact_id`, since the core now requires them.)

## Phase tests (must pass before 010 starts)

- Deterministic 409 VERSION_CONFLICT on stale writes.
- Deterministic 401/403 on bad/missing/insufficient auth.
- Malformed command writes no event.
- Accepted command produces exactly the expected event(s).

## Events

- 2026-09-29: Created by Mateo. Split from old 009 per ChatGPT's accepted
  review (was "realtime/API" depending only on 007; now HTTP API depending
  on 007 + 008, realtime moved to 013).
