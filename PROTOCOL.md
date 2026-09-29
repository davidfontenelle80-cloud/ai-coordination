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

## 3. The task board — tasks/TASKS.md

One shared board. Task states:

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
