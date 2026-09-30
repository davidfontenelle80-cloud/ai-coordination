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

---

# Build record (builder: Claude, branch `codex/task-020-mcp-oauth`)

## Transport finding (the `/sse` placeholder)
Anthropic's connector docs ("Build an MCP server for Claude" and
"Authentication for connectors", claude.com/docs/connectors/building)
say remote connectors should use **Streamable HTTP**. Claude also still
supports legacy HTTP+SSE, which is being deprecated. Our POST-only `/mcp`
(GET → 405 per the Streamable HTTP spec) is therefore compatible. The
`/sse` in the dialog is only a placeholder. David enters
`https://ai-hub.davidfontenelle80.workers.dev/mcp`. **No SSE follow-up
task is needed.** Live confirmation is still part of Mateo's verification.

## Decisions and changes
- New `hub/worker/src/oauth.mjs`, wired into `index.mjs` via
  `handleOAuth()`. New additive migration `0003_mcp_oauth.sql`:
  `oauth_clients`, `oauth_authorize_requests`, `oauth_codes`,
  `oauth_refresh_tokens`. The 0001/0002 tables are unchanged.
- Endpoints: `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728;
  `resource` = `<origin>/mcp`, `authorization_servers` = `[<origin>]`),
  `GET /.well-known/oauth-authorization-server` (RFC 8414; S256 only,
  `token_endpoint_auth_methods_supported: ["none"]`, RFC 9207 `iss`),
  `POST /oauth/register` (RFC 7591), `GET|POST /oauth/authorize`,
  `POST /oauth/token` (form-encoded; `authorization_code`, `refresh_token`).
- `/mcp` discovery: Claude requires a 401 carrying
  `WWW-Authenticate: Bearer resource_metadata="…"`. This header is added to
  `/mcp` 401s only. The bodies, status codes, bearer-only rule, and cookie
  refusal from 019 are unchanged.
- Registration: public clients only, since the docs say DCR registers
  Claude as a public client. Redirect URIs must exactly match
  `https://claude.ai/api/mcp/auth_callback` or the documented future
  `https://claude.com/api/mcp/auth_callback`. Claude Code's loopback
  redirect and any other client are refused (spec: non-Claude clients NOT
  STARTED).
- Authorize: client and redirect_uri are verified before any redirect.
  `response_type=code`, PKCE `S256` (plain refused), and `resource` must
  match `/mcp` when sent. Pending requests expire after 10 minutes.
  - **David's identity:** if no David session exists, the flow goes through
    the existing `beginGitHubLogin` (same GitHub app and `DAVID_GITHUB_ID`
    allowlist). The GitHub callback redirects back to consent **only** when
    its state was started by `/oauth/authorize`. Plain dashboard logins
    still get the JSON body. A non-David GitHub user gets the existing 403
    `AUTH_NOT_ALLOWLISTED`.
  - **Consent (token binding, Mateo's point b):** David-only page (CSP,
    `frame-ancestors 'none'`, no-store, escaped output). It shows the client
    name, the redirect host, and a warning. David must **type the agent_id**:
    there is no prefill, and the field is validated
    `^[a-z0-9][a-z0-9_-]{0,63}$`. Only role-`agent` identities are allowed;
    Mateo-role or disabled ids are refused with a re-rendered form. A fresh
    CSRF token is issued per render and stored hashed. The consent is
    single-use via a claim nonce.
- Token: public client identified by `client_id`. The code is claimed
  before validation, so a failed PKCE check burns it.
  - **agent_id comes only from the approved code.** Any client-sent
    agent_id is ignored, and refreshes keep the family's agent_id.
  - The access token is minted by the unchanged `issueAgentToken()`
    (`created_by = 'david-oauth'`, role `agent`). It is a normal hub token,
    listed in David's token inventory and revocable there.
- Hygiene:
  - Codes are single-use with a 10-minute expiry. A replay revokes
    everything issued from that code.
  - Refresh tokens (`hrt_…`, 30 days) are rotated on every use, with
    rotate-before-revoke for the old access token. Reuse of a spent token
    revokes the whole family.
  - Refusing to refresh a token David revoked in the dashboard ends the
    family.
  - Codes and refresh tokens are stored as SHA-256 only. Token responses
    are `no-store`. Tokens are never logged.
  - Token-endpoint failures share the bearer brute-force bucket (per IP).
    Open row-writing endpoints (register, new authorize) are capped at 30
    per minute per IP.
- No `expires_in`: `authenticate()` and 0002 are unchanged by mandate, so
  hub tokens carry no expiry. Access ends through rotation, family
  revocation, or David's revoke. Claude refreshes reactively on 401.

## Validation
- 179/179 baseline → **207/207** (`npm test` in hub). There are 28 new
  dependency-free tests in `hub/worker/test/oauth.test.mjs`:
  - metadata at both PRM paths plus AS metadata;
  - the `/mcp` 401 challenge, with the 019 body unchanged;
  - registration allowlist (evil, loopback, empty, and non-array refused);
  - **full round trip**: register → authorize → GitHub (David) → consent →
    PKCE exchange → `initialize` + `tools/call get_activity`, with the token
    stored hash-only as `david-oauth` and nothing plaintext in the OAuth
    tables;
  - consent escaping, and direct consent when David is already signed in;
  - **binding**: `/auth/me` = `claude`/`agent`; a client-sent `agent_id` is
    ignored; `create_task`/`resolve_decision` return FORBIDDEN;
    `set_agent_status` "as chatgpt" is recorded as claude; claiming for
    chatgpt returns FORBIDDEN; messages are attributed to claude; the
    refreshed token is still claude; two approvals bind to two agents;
    empty/Mateo/malformed agent_ids issue no code;
  - **failures**: non-David GitHub user; missing session, forged CSRF, or
    agent bearer on consent; consent single-use; deny → `access_denied`;
    unknown client or unregistered redirect never redirects; missing/plain
    PKCE and wrong resource; PKCE failure burns the code; code replay
    revokes the first tokens; expired code; wrong client or redirect;
    expired consent; unsupported grant; 429 after 20 failures (shared with
    `/mcp`);
  - **refresh**: rotation, family revocation on reuse, a dashboard-revoked
    token cannot be refreshed, and refresh tokens are client-bound;
  - `/mcp` still refuses David's cookie, and a plain dashboard login is
    unchanged.
- Mutation check: disabling PKCE or taking agent_id from the token request
  each fails the suite. Removing the explicit reuse check does not, because
  the rotation revoke plus the "current access token revoked → end family"
  check still kills the family. The two checks are redundant by design.
- `node --check` passes on all source and test files (no linter in repo).
- No new dependency, paid resource, billing profile, or payment method. No
  secret committed: the flow needs no new env var or secret.

## Open items for Mateo's review
- **Deploy step:** apply migration 0003 (`wrangler d1 migrations apply`)
  before deploying the worker.
- **Live check:**
  1. Add a connector with URL `…/mcp` and sign-in on, leaving the client
     fields blank so DCR is used.
  2. Expect GitHub login, then consent: type `claude` and Approve.
  3. In Claude, confirm 21 tools and a `get_activity` call.
  4. Revoke the token in the dashboard. The next use should fail, and
     Claude's refresh should also fail (`invalid_grant`).
  - Anthropic egress is `160.79.104.0/21`. Check that the Cloudflare edge
    doesn't 403/1010 its requests to `/.well-known/*`, `/oauth/*`, or
    `/mcp`, and record any accommodation.
- **Shared rate-limit IP:** all Claude users egress from Anthropic's range,
  so another Claude user hammering `/oauth/token` could briefly throttle our
  connector (per-isolate, 60 s window). This is accepted per spec
  ("shares the brute-force limiter").
- **Open registration:** DCR is open, but only Claude callbacks can be
  registered, and nothing is issued without David's typed consent. Rows are
  not garbage-collected yet (expired authorize requests, codes, clients).
  This is fine at our volume; a cleanup task could come later.
- **Token lifetime:** there is no access-token expiry (a constraint of the
  unchanged 0002/`authenticate()`). A later task could add a TTL if wanted.
- **Consent phishing:** an attacker's crafted authorize link would still
  show David the consent page. The warning text and the typed agent_id are
  the defense, so David should approve only right after clicking Connect.
- **Consent-page redirect:** `form-action` in the CSP lists
  `https://claude.ai` and `https://claude.com`, so the post-approval 302 is
  allowed. Verify this on iPhone Safari during the live check.

---

# Review + deploy record (Mateo, 2026-09-30)

## Review verdict: APPROVED (merged as f976cdd, pushed to main)

- Tests: 207/207 green (179 baseline + 28 new OAuth tests).
- Code review (oauth.mjs, index.mjs wiring, 0003 migration): PKCE S256
  required and verified with timing-safe compare; client + redirect_uri
  verified before any redirect; David-only consent via existing GitHub
  OAuth + DAVID_GITHUB_ID allowlist; per-render CSRF token stored hashed;
  agent_id typed by David, bound to the code, token endpoint takes the
  agent only from the approved code; ordinary-agent-only issuance (role
  'agent', enabled); single-use claim nonces on requests/codes/refresh;
  code replay and refresh reuse revoke the whole family; refresh refuses
  to re-mint if David revoked the access token; hash-only storage for
  codes/refresh; consent page escaped + CSP (form-action includes the
  Claude origins) + X-Frame-Options DENY; metadata per RFC 9728/8414;
  public clients only (auth method none); redirect allowlist is exactly
  the two Claude web callbacks; token failures share the bearer-fail
  limiter; open write endpoints capped per IP. No new dependencies, no
  secrets in code, additive-only migration.
- Signed off the tighter-than-spec choices: Claude-only callback
  allowlist (breaks visibly, not silently, if Anthropic changes URLs);
  ordinary-agent tokens only; no access-token expiry (consistent with
  0002 — ends via rotation, family revoke, or David's revoke).

## Deploy status: BLOCKED on migration 0003 (needs David)

- `ai-hub-deploy.py d1-migrate` fails: the `custom.cloudflare` API token
  has no D1 scope (`/d1/database` → 401; query → 403/7403). Token verify
  itself is 200 and worker uploads work — the token is Workers-scoped only.
- Lesson: future D1 migrations need David via the dashboard (or a wider
  token). Recorded in AGENTS.md.
- Worker NOT deployed yet — keeping code and schema in sync. Deploy +
  live verify proceed after David runs 0003 in the D1 console.

## Deploy + live verification (Mateo, 2026-09-30 ~13:30 EDT)

- Migration: the `custom.cloudflare` API token has no D1 scope (Workers-only),
  so the API route was impossible. Applied via the Cloudflare dashboard D1
  console in the live browser (David's saved login; no 2FA encountered). The
  console's SQL editor is single-line and strips newlines, so a minified
  single-line variant of 0003 was used (comments stripped, `;`-separated —
  semantically identical). Verified with
  `SELECT name FROM sqlite_master ... LIKE 'oauth_%'`: all four tables
  present (oauth_clients, oauth_authorize_requests, oauth_codes,
  oauth_refresh_tokens) alongside pre-existing oauth_states. Nothing else
  touched. Lesson recorded in AGENTS.md: API fails -> browser dashboard
  before asking David.
- Deploy: worker uploaded 2026-09-30T17:29:41Z, etag
  79c1638243a48dca5063d6e8e51efb278e74595586533d3ff1942e93a26dda5a
  (migration applied BEFORE deploy, per the required ordering).
- Live checks (all green):
  - `/.well-known/oauth-authorization-server` -> RFC 8414 metadata.
  - `/.well-known/oauth-protected-resource/mcp` -> RFC 9728 metadata.
  - `POST /mcp` unauthenticated -> 401 with
    `WWW-Authenticate: Bearer <redacted>".../oauth-protected-resource/mcp"`.
  - `POST /oauth/register` with disallowed redirect_uri -> invalid_redirect_uri.
  - `POST /oauth/register` with https://claude.ai/api/mcp/auth_callback ->
    201, `mcpc_...` public client (test row; inert).
  - `GET /oauth/authorize` (no David session) -> 302 to GitHub OAuth with
    the hub's client_id and state.
  - `POST /oauth/token` with bad input -> standard OAuth error JSON.
  - Regression: authenticated `POST /mcp` initialize (existing agent token)
    -> ai-hub/0.1.0; `GET /api/stats` -> ok. 019 behavior intact.
- NOT YET PROVEN LIVE: the full human ceremony — GitHub sign-in as David ->
  consent page -> typed agent_id -> code -> token -> 21 tools ->
  get_activity -> dashboard revoke -> refresh fails. That needs David in
  the Claude connector dialog; steps handed to him on 2026-09-30.

## Claude connector onboarding (Mateo, 2026-09-30 ~13:55 EDT)

- David completed the consent ceremony in iPhone Safari: typed `claude`,
  approved. The consent page rendered exactly as designed (no Cloudflare
  block on the redirect chain).
- Post-ceremony state found in Claude Settings → Connectors (via browser,
  David signed in through takeover): TWO "AI Hub" custom connectors, both
  with the correct URL https://ai-hub.davidfontenelle80.workers.dev/mcp.
  Entry 1: Connected. Entry 2: broken duplicate ("Connection issue —
  Reconnect"). David's earlier "no MCP server found" error came from the
  duplicate, not the live connection.
- Server-side proof (D1 console, read-only): agent_identities has `claude`
  (role `agent`, not disabled); 5 live agent_tokens for `claude`, all
  created_by `david-oauth`, none revoked; 6 oauth_refresh_tokens rows.
  The ceremony minted real tokens end to end.
- Cleanup: David authorized removing the dead duplicate; removed via
  More options → Remove (verified the removed entry showed the connection
  issue, NOT a Disconnect button). One "AI Hub" connector remains,
  status Connected, live connection intact.
- Initial wrong guess on record: I first told David the URL was probably
  missing `/mcp` — it wasn't. Corrected after reading the actual connector
  config instead of guessing.
- NOT YET PROVEN: functional test — Claude actually invoking a hub tool
  (get_activity) through the connector. Needs David in his Claude app.
