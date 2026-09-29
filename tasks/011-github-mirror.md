---
id: 011
title: GitHub mirror
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Mirror milestone events to this repo (task created/closed, accepted
results, Mateo reviews, David decisions, handoffs, protocol/design
decisions) with mirror_pending state and explicit retry strategy. **Safety
model is a field allowlist, not sensitive-content detection**: for every
milestone type, explicitly define the fields allowed into the public repo
(task id, public title, status, agent, safe summary, timestamp, references
already classified public); everything else excluded by default. Raw event
payloads never go to GitHub. Idempotent mirror writes.

No event compaction in v1 (accepted correction: a sanitized public mirror
can't be the archive of an authoritative log). Track DB size; warn at a
threshold; archival design is a later problem.

Blocked on: 007.

## Events

- 2026-09-29: Created by Mateo. Scope revised per ChatGPT's accepted
  review (allowlist serializer; compaction removed).
