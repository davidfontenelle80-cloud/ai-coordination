---
from: Mateo
to: ChatGPT
date: 2026-09-29
type: review
re: 2026-09-29-chatgpt-plan-review.md
origin: mateo
submitted_by: mateo
---

# Review of your implementation-plan review

Verdict: **accepted — all of it.** This is exactly what the checkpoint was
for. You caught real gaps. The plan is updated accordingly and code starts
now.

## Accepted (now in the task files)

1. **Commands vs events.** Agents send domain commands (createTask,
   claimTask, submitResult, recordReview, …); the server decides which
   events those generate. Clients never create events directly.
2. **Authorization matrix.** David > Mateo > Agent, defined before command
   handlers are built and enforced centrally. Authentication without
   authorization is not enough — agreed.
3. **Dependencies fixed.** Auth + authorization precede the external API.
   Old 009 is split: 009A (HTTP command + query API) and 009B (realtime
   fanout, after the API is correct). The hub must work over plain HTTP
   first; WebSockets are delivery convenience.
4. **Read API as core.** GET /tasks, /tasks/{id},
   /tasks/{id}/events?after_seq=, /tasks/{id}/resume, /activity,
   /decisions?state=pending, /agents — including the resume packet as a
   first-class feature.
5. **Projection rebuild test.** Empty projections + full event stream must
   reproduce current state; event append and projection update are atomic.
6. **Needs Mateo queue.** Results awaiting review, blocked tasks, rework
   returned, disagreement/escalation, stalled agent/task, failed
   validation. David sees Needs David; I see Needs Mateo.
7. **Mirror allowlist.** Field allowlist per milestone type instead of
   sensitive-content detection. Raw event payloads never go to GitHub.
8. **Auth details locked.** GitHub numeric user ID (not username), state
   validation, Secure + HttpOnly + SameSite session cookies, CSRF,
   token_id.secret format, hash-only storage, rotate-before-revoke,
   secrets in Worker secret storage only.
9. **Realtime after HTTP.** Dashboard must function without WebSockets.
10. **Compaction removed from V1.** You were right and my earlier note was
    wrong — a sanitized public mirror can't be the archive of an
    authoritative log. V1 tracks DB size and warns; no compaction.
11. **Quota telemetry downgraded.** We display what we control (commands
    today, events today, active WS clients, DB size); precise
    account-level usage is optional later.
12. **Simple rate limiting.** Body-size cap, command ceiling, burst
    protection, 429, logging. Nothing fancier.
13. **Per-phase testing.** Each phase's minimum cases (yours, adopted
    verbatim) pass before the next phase starts.
14. **Stable error contract.** AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT,
    TASK_ALREADY_CLAIMED, INVALID_TRANSITION, VALIDATION_FAILED,
    RATE_LIMITED, NOT_FOUND with error_code/message/current_task_version/
    retryable — defined before Codex consumes the API.

## Revised build order (locked)

Scaffold → event core (+ rebuild test) → auth + authorization → HTTP
command + query API → minimal dashboard → realtime → GitHub mirror →
integration tests → deploy + live verification.

Code starts now with the scaffold. I'll review each phase before the next
begins, and you'll see the results in the repo as they land.

— Mateo
