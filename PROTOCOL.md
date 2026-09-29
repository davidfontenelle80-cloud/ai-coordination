# AI Team Protocol

The rules every agent on David's AI team follows. Read this before posting
anything.

## 1. Roles

- **David** decides. Anything consequential (spending, publishing, contacting
  people, changing real data) needs his explicit go-ahead.
- **Mateo** leads. He takes David's goals, splits them into tasks, assigns
  them, and reviews every result before it is accepted. If work has a problem,
  a gap, or a better approach, Mateo sends it back with instructions. Mateo
  also contributes his own reasoning — he is a collaborator, not a relay.
- **Agents** execute. You receive tasks from Mateo (or claim open ones), do
  the work, and post results. You may also propose tasks and challenge other
  agents' work when asked.

## 2. Talking to each other — the inbox

All inter-agent communication happens as Markdown files in `inbox/`.

- File name: `YYYY-MM-DD-<your-name>-<short-slug>.md`
  (e.g. `inbox/2026-09-29-chatgpt-hub-design-notes.md`)
- Every message starts with this header:

```markdown
---
from: <your name>
to: <recipient name, or "all">
date: <YYYY-MM-DD>
type: message | question | task-result | review | proposal
re: <file name of the message you're replying to, if any>
---

Your content here.
```

- `type: task-result` is how you deliver finished work. Include what you did,
  what you changed, and anything David needs to decide.
- `type: review` is how you critique another agent's work when Mateo asks you
  to. Be specific: what is wrong or missing, and what would fix it.
- Keep messages short and practical. No essays.

## 3. The task board — tasks/

One file per task in `tasks/`, plus `TASKS.md` as the index. Never edit two
task files at once — claim and update one task at a time to avoid collisions.
Each task file carries its own event log (append-only: who did what, when).

Task states:

- `pending` — defined, not started
- `claimed` — an agent has taken it
- `in-progress` — actively being worked
- `under-review` — result posted, Mateo is reviewing
- `completed` — Mateo accepted the result
- `blocked` — stuck; the blocker must be named

Rules:

- Only Mateo (or David) moves a task to `completed`.
- To claim a task: set it to `claimed` with your name and the date. One
  agent per task — check first so work isn't duplicated.
- When you finish: post a `task-result` message in `inbox/` and move the
  task to `under-review`. Mateo reviews it; if it needs rework he sends it
  back with instructions and moves it to `in-progress`.
- If you're blocked: move the task to `blocked`, name the blocker in a
  message, and Mateo will unblock or reassign.

## 4. Making decisions

- For important decisions, Mateo may ask several agents for independent
  opinions, then compare the reasoning and decide.
- Mateo resolves disagreements between agents. His call stands unless David
  overrules it.
- After a large task finishes, Mateo summarizes for David: what was done,
  what changed, what still needs attention, and any decisions David must make.

## 5. Hard rules

- Nothing here is secret — this repo is public. Never post credentials,
  tokens, keys, account numbers, or personal data.
- Verify your work before posting it. Test, don't assert.
- Don't overwrite another agent's work. Propose changes; let Mateo merge.
- Speak plainly. David reads this repo too.

## 6. Context limits and handoffs

Every chat has a limit. Running out mid-task without warning is a failure —
each agent is responsible for watching its own capacity:

- **Know your gauge.** Track roughly how much context you have left. You may
  not be able to measure it exactly — estimate honestly (messages exchanged,
  size of the work so far) and stay conservative.
- **Stop early, not late.** At roughly 20% estimated capacity remaining, stop
  taking new work. Finish or cleanly park your current task first.
- **Write a handoff note before you stop.** Post it in `inbox/` as
  `YYYY-MM-DD-<your-name>-handoff.md` with `type: task-result`. It must
  contain: the goal you were working toward, what is done, what is still
  pending, the key decisions and context a fresh chat needs to continue, and
  links to the relevant files or task-board rows. The handoff note is how
  your replacement resumes — write it so a stranger could pick up your work.
- **Announce the stop.** State plainly in the handoff note: "I am stopping
  here." Silence without a handoff note is treated as a stall.
- **Restarting.** A fresh chat rejoins by reading `README.md`, `PROTOCOL.md`,
  the latest handoff notes, and `tasks/TASKS.md` — then posts an intro message
  and resumes the pending work. David restarts a chat when Mateo tells him
  one went quiet.
- **Mateo's watch.** Mateo tracks each agent's last inbox activity against
  the tasks it holds. If an agent goes quiet while holding a
  claimed/in-progress task and posted no handoff note, Mateo flags it to
  David: which chat stalled, what it was holding, and exactly what restarting
  it requires. Once live two-way communication exists, Mateo triggers the
  handoff and restart directly instead of routing through David.
