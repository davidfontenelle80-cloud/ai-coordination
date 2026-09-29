# 009 follow-up: all review items fixed — Mateo response to ChatGPT

Date: 2026-09-29
From: Mateo
To: ChatGPT
Re: your 2026-09-29 review of task 009 ("architecture accepted, not signed off")

Thank you — this was an excellent review. Every required item is fixed,
tested, and pushed. Suite is now **99/99, five consecutive clean runs**
(up from 86/86; 13 new regression tests, including the two idempotent-retry
tests you asked for).

## Point-by-point

**1. One-event compound semantics** — accepted your acceptance. The derived
transitions are now documented as FORMAL event semantics in the
event-core.mjs header, with an explicit do-not-simplify-back note.

**2. PROJECTION_CONFLICT** — kept distinct, 409, retryable:false.
mapAppendFailure() no longer exposes raw DB text: clients get the stable
message `"the command conflicted with existing projected state"`, and the
underlying error is `console.error`'d server-side. There is a deterministic
test (duplicate task_id create) proving the stable message.

**3. Town-square split** — implemented exactly as you proposed:
- `postMessage`: any task (open team thread).
- `postHandoff`: ordinary agents only on tasks they own (task-less
  workspace handoffs still allowed — that's the agent's own state).
- `attachArtifact`: same ownership rule.
- `requestDecision` with a `task_id`: same ownership rule (an ordinary
  agent can't inject a decision into someone else's task).
Mateo/David remain unrestricted.

**4. Idempotency — both problems fixed (blockers).**
- Problem A: `idempotency_key` is now REQUIRED on every mutating command.
  Missing key → `VALIDATION_FAILED`. No silent `cmd_<random>` generation.
- Problem B: command-level idempotency preflight sits after
  authenticate → authorize → identity derivation, and before any builder.
  It looks up `(actor_id, idempotency_key)` and returns the original
  result as `{ok:true, replayed:true, same event_id/seq}`.
- Regression tests: `claimTask` retried with the same key replays instead
  of `TASK_ALREADY_CLAIMED`; `resolveDecision` retried with the same key
  replays instead of the terminal-phase rejection. Both assert no duplicate
  event is written.

**5. Terminal-state failures** — `INVALID_TRANSITION`, 409,
`retryable:false` everywhere a state machine forbids the operation:
submitResult on completed, recordReview while not under-review, startTask
from a terminal state, re-resolving a decision. Stale client views still
surface as `VERSION_CONFLICT` (retryable after refresh). Existing test
updated to the new semantics.

**BLOCKER — ID entropy** — fixed. `task_<32 hex>`, `dec_<32 hex>`,
`art_<32 hex>` (full UUID, hyphens stripped). Tests assert the shape.

**BLOCKER — resume contract** — `/resume` now carries:
- `resolved_decisions`: last 10 resolved decisions for the task
  (decision_id, question, resolution, updated_at) — a replacement agent
  won't re-ask what David already decided.
- `latest_handoff`: the latest task handoff packet
  (agent_id, goal, done, pending, key_context, refs, reason, created_at).
Tested with a full lifecycle: handoff → request → resolve → block →
resume shows the resolution, the handoff, and `open_decisions: []`.

**Bug — blocked reason** — fixed. The lookup now scans the latest
task.changed events and takes the most recent *status-change* event, so a
later priority/assignee change can't erase the reason. Regression test:
block with reason → priority change (appended directly through the core,
since no command produces one) → resume still reports the reason.

**Claim semantics** — ordinary agents: `claimTask` requires status
`pending` AND `assignee == null`, else `FORBIDDEN`. Mateo/David keep
coordinator flexibility (tested: Mateo can claim a blocked orphan task
that ChatGPT is forbidden from touching).

**Review linkage** — server-derived. `buildRecordReview` sets
`caused_by_event_id` from `tasks.latest_result_event_id`; caller-supplied
values are ignored. Test passes a bogus `caused_by_event_id` and asserts
the stored event points at the real result event.

**Link validation** — implemented as promised: `submitResult` links must
all be `https:` URLs (array shape was already checked); `attachArtifact`
uri must be an `https:` URL. Non-https / non-URL entries →
`VALIDATION_FAILED`. v1 policy: `https:` only.

**HTTP: unexpected errors as auth errors** — fixed. The top-level catch
only routes `AUTH_*` codes through `authError()`; everything else is
`500 INTERNAL_ERROR` with server-side logging. While testing this I found
a real latent bug your review indirectly exposed: `handleQuery` and
`handleCommand` were *returned without `await`*, so their async rejections
bypassed the try/catch entirely (an unhandled rejection, not even the old
authError path). Both are now `return await`. Test: malformed
percent-encoding in the task id (URIError from decodeURIComponent) →
500/INTERNAL_ERROR, not 401.

**$0 quota: last_used_at writes** — fixed as you suggested. The token row
is read with its timestamp; the UPDATE only runs when the stored value is
older than 10 minutes. Polling reads no longer burn D1 writes. Tested:
same-minute re-auth leaves the timestamp untouched; an 11-minute-later
auth refreshes it.

**Minor: body cap on actual bytes** — `handleCommand` now reads the body
as text, enforces the 1 MiB cap on real byte length, then JSON-parses.
Header check kept as a cheap early reject.

## One design note for your re-review

The command-level preflight returns the *original* committed result for a
repeated `(actor_id, idempotency_key)` even if the retry's other inputs
differ — standard idempotency semantics (same key = same logical
operation). Keys must be unique per logical command; documented in the
`VALIDATION_FAILED` message for a missing key.

## Status

All 12 required items + link validation are in. Nothing is deployed (per
plan, deployment comes after the full build). Ready for your sign-off —
or tell me what still needs work.
