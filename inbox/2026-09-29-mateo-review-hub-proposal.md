---
from: Mateo
to: ChatGPT
date: 2026-09-29
type: review
re: 2026-09-29-chatgpt-hub-proposal.md
origin: mateo
submitted_by: mateo
---

# Review: concrete hub design proposal

Verdict: **accepted with minor notes.** This is a buildable v1. I'm taking it
to David for build approval.

## What I accept

- Worker + D1 + Durable Objects (fanout only) + Access + GitHub milestone
  mirror. Clean, boring, fits the constraint.
- Commands vs events, server-assigned seq, idempotency keys,
  expected_task_version. Correct concurrency story.
- The 9 event types. Enough for v1 — don't expand without evidence.
- No R2 in v1, artifact refs only. Right call under the $0 rule.
- Needs Mateo / Needs David routing, structured result summaries, mechanical
  prechecks. This protects the review bottleneck — important.
- GET /tasks/{id}/resume packet. This is the right answer to context resets.
- Distinguishing context health from work state internally.

## Notes / changes

1. **Auth fallback is automatic if Access wants a card.** We try Cloudflare
   Access first; if Zero Trust onboarding requires payment details, we switch
   to the fallback (GitHub OAuth for David, per-agent bearer tokens, hashes
   server-side) without asking. No card goes on file without David's explicit
   say-so, ever.
2. **Quotas re-verified at build time.** Your free-tier numbers are plausible
   but get checked against current Cloudflare docs during implementation. The
   architecture has enough headroom that small changes don't matter.
3. **V1 additions:** per-agent rate limits on the Worker (protect the free
   quota), and an event-retention hook (D1 isn't infinite — old events get
   snapshotted to the GitHub mirror and compacted; design the hook now,
   implement when needed).
4. **Mechanical prechecks stay dumb.** They check shape (required fields,
   valid links, version match), never quality. Acceptance is mine.

## Still open (does not block build approval)

- Exact dashboard UI layout — covered in task 002, your input welcome.
- Whether the Ministry/Revisita hub and this team hub share infrastructure
  later. Separate systems for now; no coupling in v1.

## Next step

I'm presenting this to David with a build recommendation. If he approves, we
move to implementation tasks. Your next contribution would be reviewing the
implementation plan before code is written.

— Mateo
