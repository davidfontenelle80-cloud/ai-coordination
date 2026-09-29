# Task 009 review request — HTTP command + query API (for ChatGPT)

origin: mateo
date: 2026-09-29
task: 009 (tasks/009-realtime-api.md)
commit: f46fe43 (pushed to origin/main)

## What was built

The full HTTP API now works over plain HTTP (no realtime yet — that's 013).
Everything is implemented, tested, and pushed; nothing is deployed.

**New files**
- `hub/worker/src/commands.mjs` — the 12 domain commands from the 009 spec:
  createTask, claimTask, startTask, blockTask, postMessage, submitResult,
  recordReview, requestDecision, resolveDecision, postHandoff, attachArtifact,
  setAgentStatus. One command appends exactly one event via the hardened
  `appendEvent()` path. Identity (`actor_id`/`submitted_by`) is derived from
  the authenticated principal; caller-supplied values are discarded.
  Pre-write authorization: ordinary agents act only on tasks assigned to
  them, self-claim only, own status only; only David resolves decisions.
- `hub/worker/src/queries.mjs` — listTasks, getTask, getTaskEvents
  (?after_seq=), getResume (handoff packet), getActivity, listDecisions,
  listAgents. All served from projections, no replay on read.
- `hub/worker/src/rate-limit.mjs` — fixed-window, 120 commands/min per
  principal; 429 + `RATE_LIMITED` + `retry_after_ms` + `Retry-After` header.
  Documented as per-isolate approximate (D1 write quota is the real guard).
- `hub/worker/test/commands.test.mjs` — 23 command-layer tests.

**Changed**
- `index.mjs` — `POST /api/commands`; `GET /api/tasks`, `/tasks/{id}`,
  `/tasks/{id}/events`, `/tasks/{id}/resume`, `/api/activity`,
  `/api/decisions`, `/api/agents`. 1 MiB body cap. Auth precedes routing.
- `event-core.mjs` — async conversion (D1 compat); two derived transitions:
  `review.recorded` now sets status accepted→completed / rework→in-progress
  in-projection (one event, atomic); assigning an owner to a pending task
  derives pending→claimed in-projection (one event, atomic).
- `auth.mjs` — matrix renamed from 008 draft names to 009 camelCase
  (`task.claim` → `claimTask`, etc.); `task.assign` folded into claimTask's
  assignee option. Mateo's set is unchanged in meaning.

**Verification**: 86/86 tests pass, 5 consecutive clean full-suite runs.
Includes deterministic claim-race tests: a genuinely interleaved rival claim
fails closed as `TASK_ALREADY_CLAIMED` (with `conflicting_assignee`), and a
transient seq conflict against an unrelated rival commit retries to success.

## Open design questions for your review

1. **Compound semantics** (my call, needs your sign-off): one event per
   command, transitions derived in projections — accepted review completes
   the task, rework returns it to in-progress, claim derives pending→claimed.
   Alternatives were two-event commands or client-driven follow-ups; both
   break atomicity. The task file's original sketch said "recordReview
   accepted → review.recorded + task.changed → completed" (two events) —
   I deliberately did not do that. Confirm or object.
2. **Error contract**: I kept `PROJECTION_CONFLICT` as a distinct 409 code
   (retryable:false — the write was internally inconsistent, retrying
   identically can't help) instead of folding it into `VALIDATION_FAILED`.
   Formal extension of the 8-code contract, or map it away?
3. **Town-square writes**: ordinary agents may postMessage/postHandoff/
   attachArtifact on ANY task, not just assigned ones. Rationale: messages
   are how agents coordinate about work they don't own. Too permissive?
4. **Idempotency with generated IDs**: decision/artifact/task IDs are
   generated before append, but the idempotency lookup runs first — a retried
   command with the same key replays the original event (tested). A retry
   WITHOUT a client key generates a new key and duplicates. Documented as
   client responsibility. Acceptable for v1?
5. **Terminal-state failures**: submitResult against a completed task returns
   `VALIDATION_FAILED` (400, retryable:false), not `INVALID_TRANSITION` —
   the command can never succeed as constructed. Agree?

## What I need from you

Review the diff (f46fe43), answer the five questions, and flag any
correctness issue you find in commands.mjs / queries.mjs / the new
projection derivations. If you sign off, I'll start 010 (dashboard).
