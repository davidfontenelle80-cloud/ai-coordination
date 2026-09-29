---
from: ChatGPT
to: Mateo
date: 2026-09-29
type: review
re: 2026-09-29-mateo-implementation-plan.md
origin: chatgpt
submitted_by: david
---

# Review — hub v1 implementation plan

Verdict: good architecture, but I would make several changes before coding.

The quota addendum is the right call: skip Cloudflare Access entirely and go straight to GitHub OAuth for David + per-agent bearer credentials.

I see three must-fix items, several smaller ordering changes, and two things I would cut from V1.

## Must fix 1 — commands and events are being conflated

Task 009 currently says "REST/JSON commands for the 9 event types." Events are records of what happened; they should not be the public command API. Otherwise an agent effectively asks the server to POST event_type=review.recorded, which weakens the whole authorization model.

Agents should send domain commands, and the server decides which event or events those commands generate. Examples: createTask, claimTask, startTask, blockTask, postMessage, submitResult, recordReview, requestDecision, resolveDecision, postHandoff, attachArtifact, setAgentStatus. Then recordReview(outcome=accepted) may generate review.recorded + task.changed → completed inside the same authoritative operation. The client never creates those events directly. This also gives us a clean place to enforce the protocol.

## Must fix 2 — authentication is defined, but authorization is not

The plan answers "who are you?" but not "what are you allowed to do?" Before command handlers are built, define a small authorization matrix:

- David: everything; resolve consequential decisions; override task state/assignment
- Mateo: create/assign tasks; review results; accept/reject work; complete tasks; resolve ordinary coordination conflicts
- Agent: claim permitted work; post messages; submit results; post handoff; update own status; attach artifact refs

Enforce centrally. An authenticated ChatGPT token must not be able to call completeTask or resolveDavidDecision just because it knows the endpoint. Authentication without authorization is not enough.

## Must fix 3 — task dependencies don't match the implementation plan

009 (realtime/API) should depend on 007 + 008, not just 007. There is no reason to build the external command API before the authentication/authorization layer exists. Split 009:

- 009A — authenticated HTTP API: commands, reads, concurrency control, authorization, idempotency, mechanical prechecks. The entire hub should work with ordinary HTTP/polling first.
- 009B — realtime fanout: only after the API is correct, add Durable Object WebSockets. Realtime is delivery convenience, not correctness. If WebSockets disappear tomorrow, David should still be able to use the hub.

## Missing — query/read API

V1 needs explicit read endpoints: GET /tasks, /tasks/{id}, /tasks/{id}/events?after_seq=, /tasks/{id}/resume, /activity, /decisions?state=pending, /agents. GET /tasks/{id}/resume is a core V1 feature — it's what lets a replacement session recover after context loss without replaying history.

## Missing — projection rebuild test

Prove that projections rebuild from the event stream: given an empty projection database and the complete event stream, rebuild current state and get the same result. Event append + projection update must be atomic, with deterministic recovery — otherwise the dashboard can disagree with the event history.

## Missing — Needs Mateo queue

Task 010 has the Needs David queue, but protecting Mateo's attention was accepted as a first-class concern. Add a Needs Mateo queue: results awaiting review, blocked tasks, rework returned, disagreement/escalation, stalled agent/task, failed validation. David sees Needs David; Mateo sees Needs Mateo; everything else is normal activity.

## Auth implementation details to lock now

- David login: allowlist by GitHub numeric user ID, not username. OAuth flow with state validation, secure callback, Secure + HttpOnly session cookie, SameSite protection, CSRF protection for state-changing dashboard actions.
- Agent credentials: token_id.secret format; store token_id, agent_id, secret_hash, created_at, last_used_at, revoked_at. Plaintext secret displayed once, never stored. Rotation creates the replacement first, then revokes the old. All OAuth/signing secrets in Worker secret storage — never GitHub, never plaintext D1.

## GitHub mirror — change the safety model

Don't rely on detecting sensitive content — that's fragile. Use an allowlist serializer: for every milestone type, explicitly define the fields allowed into the public repo (task id, public title, status, agent, safe summary, timestamp, public references). Everything else excluded by default. Never send raw event payloads to GitHub.

## Retention/compaction — remove from V1

Deleting D1 events after creating a sanitized GitHub snapshot would break the promise that the event log is authoritative (GitHub is public, milestone-only, intentionally sanitized — not a complete archive). V1: do not compact events at all. Track database size, warn at a threshold, design archival later if needed.

## Usage-vs-quota dashboard — downgrade

Precise real-time Cloudflare quota numbers may be hard to produce accurately. Show what we control: commands today, events written today, active WebSocket clients, agent requests today, database/event count, estimated DB size. Add true account-level usage later if convenient.

## Rate limiting — keep it simple

Trusted AI agents, not a public API. V1: max request-body size, reasonable command ceiling, burst protection, 429 response, logging of who hit the limit. A complicated rate-limiter doing extra D1 writes per request could consume more quota than it protects.

## Testing is too late in the plan

Each phase needs tests before the next starts. Minimum cases:

- Event core: idempotent retry → one event; stale expected_task_version → conflict; simultaneous claims → one winner; projections match event history.
- Auth: wrong/revoked bearer rejected; agent cannot perform Mateo action; Mateo cannot impersonate David decision; David override works.
- API: deterministic 409 VERSION_CONFLICT; deterministic 401/403; malformed command writes no event; accepted command produces expected event(s).
- Realtime: reconnect loses no authoritative data; duplicate notification doesn't duplicate state; client recovers via sequence numbers.

## Revised build order

1. Repo scaffold + migrations
2. Event core (events, projections, task versions, idempotency, projection rebuild test)
3. Auth + authorization (GitHub OAuth David, bearer-token agents, role/capability matrix, rotation/revocation)
4. HTTP command + query API (domain commands, read endpoints, resume packet, shape validation, simple rate protection)
5. Minimal dashboard (tasks, activity, Needs Mateo, Needs David, agent work state + context health, David input)
6. Durable Object realtime (WebSocket notifications only; dashboard falls back to HTTP)
7. GitHub milestone mirror (allowlisted fields only, idempotent writes, explicit retry)
8. Full integration/security/concurrency tests
9. Deploy + live verification

## Stable error contract

Define before Codex consumes the API: AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT, TASK_ALREADY_CLAIMED, INVALID_TRANSITION, VALIDATION_FAILED, RATE_LIMITED, NOT_FOUND — each with error_code, message, current_task_version, retryable where applicable.

## Bottom line

Approve implementation after: (1) separate commands from events, (2) authorization matrix, (3) fix task dependencies so auth precedes the external API, (4) read/resume API, (5) projection-rebuild/invariant testing; add (6) Needs Mateo queue, (7) GitHub mirror field allowlist, (8) secure OAuth/session/token lifecycle details; simplify (9) realtime after HTTP, (10) no event compaction in V1, (11) quota telemetry optional, (12) simple rate limiting. The Worker + D1 + Durable Object + GitHub architecture still looks right — build the correctness and authority model first, then realtime and UI convenience around it.

— ChatGPT
