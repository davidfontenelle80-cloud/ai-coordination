# Task 020 — OAuth 2.1 for the MCP server

Base: main at `207179b`. Branch: `codex/task-020-mcp-oauth`.

## What we learned (2026-09-30, David's screenshot of the ground truth)

Claude's "Add custom connector" dialog offers: Name, URL, and a
"Requires sign-in" toggle whose help text says "You can enter OAuth client
details below." There is NO field for an API key, static bearer token, or
custom header. Modes are OAuth or no-auth. Therefore the static-bearer
design of task 019 cannot be used by Claude's connector, and NO static
agent token is issued for Claude in the meantime.

Objective: add a standards-based OAuth 2.1 authorization layer in front of
`/mcp` so Claude's custom connector can complete its "Requires sign-in"
flow. The existing REST API, the bearer-token system (016), and the
bearer-only `/mcp` path from 019 stay exactly as they are.

## Binding design decisions

- **Standards:** OAuth 2.1 authorization code flow with PKCE (S256, required),
  following the MCP authorization spec: RFC 7591 dynamic client registration
  for the connector, RFC 9728 protected-resource metadata.
- **Where it runs:** the existing worker, existing D1, no new vendor, $0.
- **The elegant core:** OAuth is only the *issuance ceremony*. What the
  connector ends up with is a normal hub agent bearer token (same 256-bit
  format, same hash-only storage in `agent_tokens`), sent as
  `Authorization: Bearer` into the UNCHANGED `authenticate()` path. No second
  auth system on the wire: `/mcp` keeps requiring a bearer and keeps refusing
  the David session cookie.
- **Who authorizes:** David, the human, in his browser. The authorize step
  reuses the existing GitHub OAuth app and the DAVID_GITHUB_ID allowlist —
  a non-David GitHub user is refused. At authorize time David confirms which
  `agent_id` the token is for (first use: `claude`). The issued token is bound
  to that agent_id; the agent cannot escalate or rebind it.
- **Authorization parity:** an OAuth-issued token yields
  `{ kind: 'agent', agent_id, role }` — ordinary-agent rules apply exactly as
  with a dashboard-issued token. David-only operations stay unreachable.
- **Token hygiene:** authorization codes single-use, ~10 minute expiry;
  refresh tokens with rotation and reuse detection (reuse revokes the family);
  PKCE enforced on every code exchange; the token endpoint shares the
  brute-force limiter; tokens never logged, never returned except once to the
  registered client.
- **Metadata endpoints (required):**
  `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource` (pointing at `/mcp`).
- **Schema:** a new D1 migration is acceptable for OAuth state
  (oauth_clients, authorization_codes, refresh_tokens, or equivalent) —
  019's no-migration rule does not carry over. Migration must be additive
  only; existing tables untouched.
- **No SSE scope creep:** the dialog's URL placeholder shows `/sse`, but our
  server is Streamable HTTP only (GET /mcp → 405 by design, task 019). The
  builder must confirm with Claude whether its connector speaks Streamable
  HTTP; if it requires SSE, that is a SEPARATE task — do not bundle it here.

## Validation

- Baseline: 179/179 tests passing (`npm test` in hub).
- New tests must cover the full round trip: metadata endpoints →
  authorize (David GitHub identity) → code → PKCE exchange → token →
  authenticated `tools/call` on `/mcp`; plus PKCE failure, code replay
  (single-use), expired code, non-David GitHub user refused, refresh
  rotation and reuse detection, and agent_id binding (a token issued for
  `claude` cannot act as another agent).
- No new dependency without justification; no paid resource; no billing
  profile; no payment method.

## Explicit exclusions

- NOT modified: REST command/query semantics; bearer-token issuance,
  revocation, and inventory flows; dashboard David-only policy; the
  bearer-only `/mcp` transport from 019; D1 tables from 0002.
- NOT STARTED: SSE transport; any non-Claude OAuth client; live deployment
  or live verification; merging to main.
- Mateo retains review, deployment, and live verification after the branch
  is ready. This is a security-sensitive build — expect a hard review.
