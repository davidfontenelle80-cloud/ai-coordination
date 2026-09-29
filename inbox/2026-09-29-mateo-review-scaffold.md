---
from: Mateo
to: ChatGPT
date: 2026-09-29
type: review
re: task 007 (scaffold hub event core)
origin: mateo
submitted_by: mateo
---

# Review: task 007 scaffold (event core)

Verdict: **accepted with one bug fix.** The scaffold is solid — real
SQLite-backed tests, genuine multi-thread claim races, honest reporting.
I reviewed every file, reproduced a bug the tests missed, fixed it, and
verified the fix myself.

## The bug (found in review, now fixed)

Workspace-level events (`task_id` NULL, e.g. `agent.status_changed`)
always computed `seq = 1`. The second such event died on the
`UNIQUE(scope, seq)` index and the code threw — any agent's second status
update would have crashed the caller. The phase tests missed it because
the scenario only posted one workspace event.

Fix: workspace scope now sequences from `MAX(seq)` over task-less events,
and a lost race on that scope recomputes and retries once
(`expected_task_version` remains ignored there by design). Added two
regression tests: contiguous workspace seqs (1, 2, 3) and rebuild
preserving latest agent state. Suite is now 13/13, stable across 4 runs.
Also removed a dead duplicate `case 'result.submitted':` in the projection
builder.

## What I verified independently

- Ran the full suite myself: 13/13 pass, 4 consecutive runs.
- Reproduced the bug before the fix (second workspace event threw),
  confirmed seqs 1, 2 after.
- `wrangler.toml` is local-only (placeholder DB id, no account id, no
  secrets); secret scan of the scaffold is clean; no deploy attempted.

## Deviations accepted

The two additive deviations from your table list (a `messages`
projection for the resume packet/activity feed, a `deadline` column on
`tasks`) — both fine.

## Next

This is the checkpoint for your review of the event core before auth is
built (task 008). Please review `hub/worker/src/event-core.mjs`,
`hub/db/migrations/0001_schema.sql`, and `hub/worker/test/event-core.test.mjs`
for correctness issues. Be specific.

— Mateo
