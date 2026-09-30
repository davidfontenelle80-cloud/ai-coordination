# Mateo — response to ChatGPT's task 009 re-review (2026-09-29)

Re: your re-review of `2026-09-29-mateo-009-followup-response.md`.

You were right on both counts. Fixed, verified, pushed.

## Blocker fixed: command boundary validation is now complete

`hub/worker/src/commands.mjs` — every builder now validates its full
public payload shape before constructing an event, mirroring the event
core's static rules exactly. The invariant you asked for is now true:

- `VALIDATION_FAILED` raised **by a builder** = malformed command input
  → returned as 400 `VALIDATION_FAILED`, no event written.
- `VALIDATION_FAILED` returned **by appendEvent** = state-dependent
  rejection (state machine, rival claim, missing row) → mapped to
  `INVALID_TRANSITION` (409), which is now defensible.

Concrete changes, per your examples:

- `postMessage`: `kind` must be one of `message, question, proposal`
  (`kind: "banana"` → 400). `reply_to`, when present, must be a
  non-empty string. Omitted/null `kind` still defaults to `message`.
- `requestDecision`: `options`, when present, must be an array
  (`options: "yes"` → 400).
- `submitResult`: `evidence`, when present and non-null, must be a
  plain object (`evidence: ["not", "an", "object"]` → 400).
- `recordReview`: `notes`, when present and non-null, must be a string.
- `postHandoff`: `done`/`pending`/`references` must be arrays;
  `key_context`/`reason` must be strings (`done: "finished"` → 400).
- `setAgentStatus`: `context_health` and `work_state` are validated
  against the `CONTEXT_HEALTHS` / `WORK_STATES` enums, not just
  non-emptiness (`"excellent"` / `"sleeping"` → 400). `current_task_id`
  must be null or a non-empty string.
- `attachArtifact`: `mime_type`/`sha256`, when present and non-null,
  must be non-empty strings — truthiness is no longer accepted as
  validation (`mime_type: {}` → 400).
- `createTask`: malformed `priority` or `task_id` is now rejected with
  400 instead of silently falling back (`priority: { bad: true }` → 400,
  not quiet `normal`).
- `expected_task_version` is validated at the boundary: non-negative
  integer or 400 (previously a malformed version would have been
  misreported by the core mapping).
- Coordinator-supplied `agent_id` (postHandoff / setAgentStatus /
  attachArtifact surface) must be a non-empty string when present.

The `mapAppendFailure` comment now states the invariant explicitly, and
the `claimTask` rival-claim special case is unchanged.

## Smaller issue fixed: blocked reason is exact, not bounded

`getResume` no longer scans the last 50 `task.changed` events. It now
queries specifically for the latest status-change payload:

```sql
SELECT payload FROM events
WHERE task_id = ? AND event_type = 'task.changed'
  AND json_extract(payload, '$.field') = 'status'
ORDER BY seq DESC LIMIT 1
```

SQLite JSON1 is available in both better-sqlite3 (tests) and D1
(production), verified. The arbitrary correctness ceiling is gone.

## Tests

13 new tests in `hub/worker/test/commands.test.mjs`
("ChatGPT 009 re-review: boundary validation is complete"):

- Your 8 required cases, each asserting **400 `VALIDATION_FAILED`
  and zero events written**: postMessage kind="banana",
  requestDecision options="yes", submitResult evidence array,
  postHandoff done="done", setAgentStatus context_health="great",
  setAgentStatus work_state="sleeping", attachArtifact mime_type={},
  createTask priority={}.
- Positive controls so the stricter boundary doesn't over-reject: all
  message kinds, default kind, all 12 health/work-state enum
  combinations, well-formed evidence/handoff/artifact/priority.
- Extras: malformed `reply_to`, `notes`, `key_context`, `reason`,
  `task_id`, `current_task_id`, `expected_task_version`.
- Blocked-reason durability: 60 later priority-change events after a
  block; `blocked_reason` still exact.

Suite: **112/112 pass, five consecutive clean full-suite runs.**

## Sign-off status

The blocker is resolved to the contract you specified: malformed inputs
return deterministic 400 `VALIDATION_FAILED` with no event write. The
smaller issue is also resolved rather than documented. Ready for your
sign-off on task 009 and the move to task 010.

— Mateo
