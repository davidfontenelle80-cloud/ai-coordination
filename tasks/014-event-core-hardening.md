state: completed
owner: Mateo
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Harden the event core per ChatGPT's review
(`inbox/2026-09-29-chatgpt-event-core-review.md`) before it is frozen and
task 008 (auth) begins. All six high-priority items plus the three mediums.

## Scope

1. Idempotency lookup before any state-dependent validation (blocker).
2. Deterministic projections: require `decision_id` / `artifact_id` in
   payloads; no randomness inside applyProjection (blocker).
3. Scope enforcement in validateEvent: task.changed, message.posted,
   result.submitted, review.recorded require task_id; agent.status_changed
   requires task_id null; decision.changed / handoff.posted /
   artifact.attached optional (blocker).
4. result.submitted allowed only from in-progress; review.recorded requires
   under-review (high).
5. agent.status_changed is a complete snapshot (context_health, work_state,
   current_task_id string|null); assign directly, no COALESCE (high).
6. Bounded retry budget (8 attempts) + concurrent workspace stress test (high).
7. Validate task.changed `from` against current state when supplied (medium).
8. Value rules for typed fields; DB constraints as last defense (medium).
9. Constraint-failure classification: idempotency dup → replay; sequence
   advanced → concurrency path; not advanced → PROJECTION_CONFLICT (medium).

Deferred (not blockers for 008):
- rebuildProjections: document destructive/chunk-atomic limitation; prefer
  explicit stream ordering later.
- Compound commands (claim = assignee+status, accept = review+completed):
  prerequisite for 009 — see task 009 notes.

## Phase tests (all must pass)

ChatGPT's 8-item regression set:
1. status mutation + identical idempotent retry
2. invalid event scope matrix
3. decision/artifact IDs required; identity survives rebuild
4. result submission cannot bypass terminal/status rules
5. agent current_task_id clears correctly
6. six-way concurrent workspace events all succeed
7. task.changed.from cannot lie about prior state
8. malformed typed values return validation errors, not SQL exceptions

Plus the existing 13 tests must keep passing.

## Events

- 2026-09-29: Created by Mateo from ChatGPT's event-core review. Hardening
  underway; 008 stays blocked until this is done.
- 2026-09-29: Completed. All 6 high-priority + 3 medium items fixed; 24/24
  tests, 15 consecutive clean runs (also fixed a test-harness open race:
  busy_timeout now set before the journal_mode probe in sqlite-db.mjs).
  Response to ChatGPT: inbox/2026-09-29-mateo-response-event-core-review.md.
  Event core frozen pending ChatGPT sign-off; 008 unblocked on sign-off.
