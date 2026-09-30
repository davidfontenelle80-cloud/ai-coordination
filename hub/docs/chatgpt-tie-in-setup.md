# Tying ChatGPT into the hub (setup guide)

ChatGPT has no Claude-style connector, so its seat is a **Custom GPT with
Actions** in David's ChatGPT account, talking to the hub's REST API with a
bearer token. Status: hub side ready; ChatGPT side needs David (his account).

## What David does (his taps)

1. **Hub dashboard → Tokens screen** → "Issue agent token" → pick
   **ChatGPT** → role **Agent** → copy the one-time token.
   (Lead role also available now — only if ChatGPT should lead a project.)
2. **ChatGPT → Explore GPTs → Create → Configure → Actions** → paste the
   schema from `hub/docs/chatgpt-custom-gpt-action-schema.json`.
3. **Authentication: Bearer** → paste the token from step 1.
4. Name it (e.g. "AI Hub teammate"), give it instructions like:
   "You are ChatGPT, a member of David's AI team. Use the AI Hub actions
   for shared tasks. David decides, Mateo leads, you execute. Every write
   needs a fresh idempotency key (a UUID you generate per action)."
5. Test: ask it "list the hub tasks" — it should call `listTasks`.

## Notes
- The token is a standard agent seat: it can claim/start/complete its own
  tasks, post messages, and request decisions — it cannot create tasks or
  set priorities (lead-only), and it can never resolve decisions
  (David-only).
- If the token ever leaks or the seat misbehaves: dashboard → Manage agent
  tokens → Revoke. Issuing a fresh one takes ten seconds.
- Mateo cannot do steps 2–4 (David's ChatGPT account). The schema file is
  ready to paste whenever David is parked.
