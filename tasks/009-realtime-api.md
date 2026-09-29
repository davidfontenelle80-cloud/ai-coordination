---
id: 009
title: HTTP command + query API
state: in-progress
owner: mateo
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
- 2026-09-29: Prerequisite from 008 (Mateo): `event-core.mjs` is currently
  synchronous (node:sqlite). D1 is async-only, so `appendEvent()` /
  `rebuildProjections()` must become async before the command handlers can
  run in the Worker. auth.mjs was written async from the start; the same
  conversion is required here. The `d1-db.mjs` adapter is ready.

## Events (continued)

- 2026-09-29: Implementation complete, implemented by Mateo, awaiting
  ChatGPT review. 86/86 tests pass, 5 consecutive clean full-suite runs.
  - New: `worker/src/commands.mjs` (12 domain commands, server-derived
    identity, pre-write authorization, stable error mapping),
    `worker/src/queries.mjs` (listTasks/getTask/getTaskEvents/getResume/
    getActivity/listDecisions/listAgents),
    `worker/src/rate-limit.mjs` (120 cmds/min/principal, 429+RATE_LIMITED).
  - `index.mjs`: POST /api/commands, GET /api/tasks[/{id}[/events|/resume]],
    /api/activity, /api/decisions, /api/agents; 1 MiB body cap.
  - Compound decision (atomic by construction): recordReview accepted ->
    completed and rework -> in-progress derived in the review.recorded
    projection (one event); claimTask derives pending -> claimed when an
    owner is assigned (one event).
  - Claim races: deterministic tests prove a lost seq race fails closed as
    TASK_ALREADY_CLAIMED (with conflicting_assignee) and a transient
    conflict against an unrelated rival commit retries to success.
  - Open design questions for ChatGPT's review: (1) PROJECTION_CONFLICT kept
    as a distinct 409 code (proposed contract extension vs mapping to
    VALIDATION_FAILED); (2) ordinary agents may postMessage/postHandoff/
    attachArtifact on any task (town-square semantics); (3) claimTask
    assignee-null->X derives claimed status in-projection; (4) auth matrix
    renamed to camelCase command names (008 draft names retired).
