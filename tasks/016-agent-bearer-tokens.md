# Task 016 — Per-agent bearer tokens (David-approved 2026-09-30)

## Goal
ChatGPT and Claude get their own hub credentials so they can pull tasks and post
updates themselves (no more David relaying), and Mateo's Team-chat watcher can
read the hub. David approved: "each agent gets its own token, like a password
only the hub recognizes."

## Decisions (recorded during build)
1. **No migration 0003.** `db/migrations/0002_auth.sql` already defines
   `agent_identities` + `agent_tokens` with hash-only secret storage
   (`secret_hash` = SHA-256 of the secret; the plaintext is returned ONCE at
   issuance and never persisted). The brief's `token_hash`-PRIMARY-KEY design
   is superseded by this existing, tested schema — creating a second
   `agent_tokens` table would collide. Verified `issueAgentToken` stores only
   the hash.
2. **Issuance is David-only.** `POST /auth/agents` previously allowed David OR
   Mateo-role agents (via `authorize(principal, 'agent.issue')`). Tightened:
   the route now requires `principal.kind === 'david'`. Removed
   `'agent.issue'` / `'agent.revoke'` from `MATEO_COMMANDS` — they were never
   domain commands; issuance/revocation are auth-admin routes.
3. **Revocation route added.** `revokeAgentToken()` existed in auth.mjs with no
   HTTP route. New: `POST /auth/agents/revoke` (David-only, body
   `{token_id}`).
4. **iPhone issuance = dashboard slash menu.** New "Issue agent token" menu
   entry → second step lists the three team agents (ChatGPT, Claude,
   Mateo watcher) → tap one → token is minted and placed in the composer box
   for David to copy. ≤2 steps after opening `/`, zero typing. Plaintext is
   shown once; the status line warns it won't be shown again.
5. **No D1 seeding needed.** `issueAgentToken` auto-creates the
   `agent_identities` row on first issuance. The `agents` status registry
   upserts on first status change (event-core). All D1 writes go through the
   worker itself — the Cloudflare API token available here 403s on the D1
   API (code 7403), so direct D1 writes were never an option.
6. **Brute-force protection.** Per-IP failure limiter on bearer attempts:
   20 failed bearer auths / 60s → 429. Keyed by `cf-connecting-ip`
   (fallback `'unknown'`). Only failed bearer attempts count
   (`AUTH_BAD_TOKEN`, `AUTH_TOKEN_REVOKED`, `AUTH_AGENT_DISABLED` with a
   Bearer header present); successful auths and session-cookie auth are
   unaffected. 20/min is far above any legitimate client (polling agents
   authenticate successfully, which never increments the counter).
7. **Roles:** chatgpt / claude / mateo-watcher are issued role `'agent'`
   (least privilege). Queries (`/api/activity`, `/api/tasks`) need only
   authentication, so the watcher can read everything it needs.
8. **Role defaults to 'agent'.** `POST /auth/agents` defaults an omitted
   `role` to `'agent'` (previously a missing role was a 400) so David's
   iPhone flow needs no role choice — he just taps the agent.

## David's iPhone steps (to mint a token)
1. Open the hub dashboard → tap `/` → tap **Issue agent token**.
2. Tap the agent (ChatGPT, Claude, or Mateo watcher).
3. Long-press the token that appears in the typing box → Copy. Send it to
   that agent. It is never shown again.

## Files changed
- `hub/worker/src/auth.mjs` — matrix cleanup (removed agent.issue/agent.revoke
  from MATEO_COMMANDS; issuance is David-only by route check).
- `hub/worker/src/index.mjs` — David-only `POST /auth/agents`; new David-only
  `POST /auth/agents/revoke`; bearer brute-force limiter in the error path.
- `hub/worker/src/dashboard.mjs` — slash-menu "Issue agent token" entry,
  agent-picker step, sendChat issuance flow (token placed in composer to copy).
- `hub/worker/test/routes.test.mjs` — new tests (see below).

## Tests
New route tests: Mateo-role agent refused issuance (403); David revokes via
`/auth/agents/revoke` → token then 401; revoke unknown token_id → 400;
non-David cannot revoke (403); >20 bad bearer attempts from one IP → 429;
dashboard JS contains the issue-token affordance. Existing 133 tests must
stay green.

## Explicitly NOT modified
- GitHub OAuth flow (login/callback/session) — untouched.
- Command/query API semantics — untouched (issuance is not a domain command).
- D1 schema — no new migration; 0001/0002 unchanged.
- Dashboard David-only policy — agents still get 403 on dashboard/assets.
