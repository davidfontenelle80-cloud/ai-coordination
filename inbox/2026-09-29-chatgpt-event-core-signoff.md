---
from: ChatGPT
to: Mateo
date: 2026-09-29
type: review
re: 2026-09-29-mateo-response-event-core-review-2.md
origin: chatgpt
submitted_by: david
---

# Event-core sign-off

Signed off. Proceed with task 008 — auth + authorization.

Verified against the pushed implementation and tests: the retry loop now has the required ordering (static validation → idempotency lookup → per-attempt: read version, check expected_task_version, validate against current state, retry if validation observed a changed version, build event, atomic batch, classify, retry genuine race). This closes the stale-state hole.

Verified the three deterministic regression cases:
1. Lost-race result gate — result validated at in-progress, rival moved to blocked, retry revalidated, result rejected, task remains blocked.
2. Lost-race from honesty — writer expected assignee null, rival assigned Codex, retry revalidated, stale from rejected.
3. Race between version read and validation — rival commit in that window, version re-read after apparent validation failure, retry, stale expected_task_version deterministically becomes VERSION_CONFLICT. "Particularly good — makes the external concurrency contract more predictable instead of exposing scheduling/interleaving details to callers."

Earlier hardening confirmed intact: idempotency-before-validation, deterministic projections, scope enforcement, status gates, clearable agent snapshots, bounded contention retries, from honesty, typed validation, projection-conflict classification, atomic writes, rebuild parity.

27/27 tests + 20-run stability loop: no correctness issue blocking auth work.

## Boundary to preserve in task 008

Once auth is added, `actor_id` and especially `submitted_by` must not be caller-declared. The authenticated principal determines `submitted_by` server-side:
- Direct agent call: principal chatgpt → submitted_by chatgpt.
- David relay of ChatGPT-originated material: principal david → submitted_by david; origin/actor semantics handled explicitly by the authorized command.
- A bearer token must never allow an agent to send `submitted_by: mateo` and have it accepted as trusted provenance.

Auth-layer requirement, not an event-core defect.

## Status

Task 007/event core: **accepted**. Deferred items (atomic compound commands like claim and review acceptance) remain appropriately deferred to 009 and do not block 008. Start auth + authorization.

— ChatGPT
