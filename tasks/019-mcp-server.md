# Task 019 — MCP server for the hub API

Base: main at `4447c46`. Branch: `codex/task-019-mcp-server`.

## Objective

Claude (Anthropic app) cannot join the hub as a bearer-token agent: its tools
cannot send custom `Authorization` headers or POST bodies, it cannot persist
secrets between sessions, and it does not run continuously. Its viable path is
an MCP connector, with auth held by the connector framework instead of the
model. Claude offered to help build this.

Deliverable: a Model Context Protocol server, served by the existing hub
worker, that exposes the hub's query and command surface as MCP tools. No new
infrastructure, no new vendor, no cost. After this ships, David onboards
Claude by issuing it a normal agent bearer token (Tasks 016–018 flow) and
entering that token once in Claude's custom-connector configuration.

## Binding design decisions

- **Transport:** MCP Streamable HTTP on a single route, `POST /mcp`, implemented
  in the existing worker (`hub/worker/src/`). Stateless: every request carries
  its own `Authorization: Bearer <token>` header; the server issues no
  `Mcp-Session-Id` and keeps no session state. (SSE streaming is legacy; do
  not implement it.)
- **One auth system, not two.** The MCP route authenticates with the exact same
  `authenticate()` path as the REST API. A valid agent bearer token yields the
  same principal (`{ kind: 'agent', agent_id, role }`); a missing/invalid token
  fails the same way (`AUTH_REQUIRED` 401); a revoked token fails as revoked.
  The David GitHub-OAuth session is NOT accepted on `/mcp` — MCP clients are
  agents, and the connector framework holds their token.
- **Authorization parity.** Every tool enforces the identical principal rules as
  its REST counterpart (e.g. ordinary-agent restrictions in `commands.mjs`,
  David-only routes stay unreachable). The MCP layer is a thin translation; it
  invents no permissions.
- **No new dependencies.** Hand-roll the JSON-RPC envelope
  (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) in the
  worker. The repo's test suite is dependency-free; keep it that way. If the
  builder wants the MCP TypeScript SDK instead, it must justify the bundle-size
  and dependency cost in the task record and get David's approval first.
- **No D1 schema change.** Tools read/write through the existing
  `queries.mjs` / `commands.mjs` functions. No migration, no new table.
- **Error mapping.** Protocol failures (bad JSON-RPC, unknown method) return
  JSON-RPC errors. Hub domain failures (validation, not-found, forbidden) return
  MCP `CallToolResult` with `isError: true` carrying the hub's `{ ok:false,
  code, message }` — the agent must see the hub's message, not a bare 500.
- **Rate limiting** applies to `/mcp` exactly as it does to `/api/*`.
- **Server identity:** `name: "ai-hub"`, version matching the worker build.

## Tool catalog (must cover the full REST surface)

Read tools (from `queries.mjs`):
`list_tasks` {status?, assignee?, limit?}, `get_task` {task_id},
`get_task_events` {task_id, after_seq?, limit?}, `get_task_resume` {task_id},
`get_activity` {limit?}, `list_decisions` {state?}, `list_agents`,
`get_stats`.

Write tools (from `commands.mjs`, via `executeCommand`):
`create_task`, `claim_task`, `start_task`, `block_task`, `post_message`
(Team chat — attribution is the calling agent's `agent_id`),
`submit_result`, `record_review`, `request_decision`, `resolve_decision`,
`post_handoff`, `attach_artifact`, `set_agent_status`, `set_priority`.

Input schemas must mirror the REST validation rules (required fields, string
checks, URL checks) so a call the REST API would reject with
`VALIDATION_FAILED` fails the same way as a tool call.

Explicitly NOT exposed as tools: token issuance, revocation, and inventory
(`/auth/agents/*` — David-only, stays in the dashboard).

## Validation

- Baseline: 151/151 tests passing (`npm test` in hub).
- New dependency-free tests must cover: `initialize` handshake returns server
  info; `tools/list` returns the full catalog with input schemas;
  `tools/call get_activity` with a valid agent bearer returns activity;
  missing token → auth error; revoked token → revoked error;
  `tools/call post_message` posts attributed to the calling agent and the
  message is visible via `get_activity`; an ordinary agent attempting a
  command the REST API forbids it gets the same failure via MCP;
  malformed JSON-RPC → JSON-RPC error (not a 500, not a leak).
- No new endpoint behavior beyond `/mcp`; no migration; no dependency; no paid
  resource; no billing profile; no payment method.

## Known verification risk

Cloudflare has blocked non-browser user agents at the edge before (403 /
code 1010); the Python API client works around it with an iPhone Safari-style
`User-Agent`. Claude's connector will send its own UA — flag in the task record
whether the live `/mcp` check needed any UA accommodation; do not weaken the
edge posture to fix it.

## Explicit exclusions

- NOT modified: token issuance/revocation/inventory semantics; command/query
  API semantics; D1 schema; dashboard David-only policy; GitHub OAuth;
  tasks 011/012/013.
- NOT STARTED: realtime/notification streaming over MCP (agents poll
  `get_activity`); the Claude-side custom-connector setup (David + Claude do
  that in the Claude app after this ships); live Cloudflare deployment or live
  verification; merging to main.
- Mateo retains review, deployment, and live verification after the branch
  is ready.

---

# Build record (builder: Claude, branch `codex/task-019-mcp-server`)

## Decisions and changes
- `POST /mcp` in `hub/worker/src/index.mjs`; JSON-RPC in new `hub/worker/src/mcp.mjs`.
  Methods: `initialize`, `notifications/initialized` (and any notification →
  202, no body), `ping`, `tools/list`, `tools/call`. No `Mcp-Session-Id`, no
  server state. `GET /mcp` (or any non-POST) → 405 `allow: POST`, since no SSE
  stream is offered. JSON-RPC batches are rejected (-32600).
- Protocol versions: `2025-06-18` (preferred) and `2025-03-26`. `initialize`
  echoes a supported client version, otherwise offers `2025-06-18`. An
  unsupported `MCP-Protocol-Version` header on later requests → 400.
- Server identity `{ name: "ai-hub", version: "0.1.0" }`; a test pins it to
  `hub/package.json` so a version bump cannot drift silently.
- Auth: `/mcp` requires `Authorization: Bearer …` and then calls the same
  `authenticate()` as REST. No bearer header → `AUTH_REQUIRED` 401 before
  `authenticate()` runs, so David's session cookie is never consulted on
  `/mcp`. Bad/revoked/disabled tokens throw into the existing fetch catch:
  same 401 bodies (`AUTH_BAD_TOKEN`, `AUTH_TOKEN_REVOKED`, …) and the same
  bearer brute-force limiter. No `WWW-Authenticate` header (REST sends none).
- Single source of truth: `queries.mjs` now exports `QUERIES` (8 entries:
  schema, description, `run()` returning the hub envelope). REST
  `GET /api/*` dispatches through it (behavior unchanged; the 151 baseline
  tests pass). `commands.mjs` exports `COMMAND_SCHEMAS` beside the builders.
  `tools/list` is generated from those tables; a test asserts they cover
  `COMMANDS` and the 8 queries exactly.
- Command tools call `executeCommand(db, principal, { ...args, command })`.
  `command` is fixed by the tool, caller `actor_id`/`submitted_by` are
  discarded as over REST, and `authorize()` plus the builder rules apply
  unchanged. `idempotency_key` is required (REST parity: the server never
  generates one).
- Query tools type-check arguments against their schema (strings/integers,
  required `task_id`) → `VALIDATION_FAILED`. REST query params are always
  strings, so this adds no REST behavior; it only stops non-string JSON
  values reaching SQL binds.
- Errors: hub failures → `CallToolResult` `isError: true`, with the hub body
  as text content and `structuredContent`. Unknown tool / non-object
  arguments → -32602; unknown method → -32601; bad JSON → -32700 (400);
  bad envelope → -32600 (400); unexpected exceptions → -32603 "internal
  error" (logged, never echoed).
- Rate limiting "exactly as `/api/*`": command tools draw from the same
  per-principal 120/min bucket as `POST /api/commands` (shared across both
  surfaces); read tools are unlimited, like `GET /api/*`. A limited command
  returns `isError` with the hub `RATE_LIMITED` body (`retry_after_ms`).
  Same 1 MiB body cap (the reader was extracted and shared).
- Not tools: token issuance, revocation, inventory. Calling such a name →
  -32602 unknown tool (tested).

## Validation
- Baseline 151/151 → 179/179 passing (`npm test` in hub). 28 new
  dependency-free tests in `hub/worker/test/mcp.test.mjs`: initialize
  (server info, version pin, no session id, version negotiation),
  notifications → 202, ping, protocol-version header, GET 405; tools/list =
  exactly 21 with schemas, catalog = REST tables, no token tools;
  missing token → `AUTH_REQUIRED` (same body as REST), unauthenticated
  initialize rejected, bad/unknown token, revoked → `AUTH_TOKEN_REVOKED`,
  David cookie refused on `/mcp` (while accepted on REST), brute-force 429;
  `get_activity` happy path; `post_message` attributed to the caller and
  visible in `get_activity` (spoofed `actor_id`/`command` ignored); ordinary
  agent `create_task` → the same FORBIDDEN body as REST; Mateo
  `resolve_decision` refused; assignee rule on `start_task`; bad params →
  the same `VALIDATION_FAILED` body as REST; query tools deep-equal their REST
  responses (including not-found); shared command rate bucket; malformed
  JSON-RPC → -32700/-32600/-32601/-32602, no leak; oversized body; internal
  error → -32603 with no detail.
- `node --check` passes on every source and test file (the repo has no linter
  configured).
- No new dependency, migration, table, paid resource, billing profile, or
  payment method. REST/auth semantics unchanged.

## Open items for Mateo's review
- **Live UA check: NOT DONE** (no deploy in this task). Mateo should check
  whether Cloudflare's edge 403/1010s the Claude connector's UA on `/mcp`, and
  record any accommodation. Do not weaken edge posture.
- **Claude connector auth shape.** This build assumes Claude's custom
  connector can send a static `Authorization: Bearer <agent token>` header
  (spec's premise). If the connector only offers OAuth or no-auth, onboarding
  needs a follow-up decision. `/mcp` deliberately exposes no OAuth metadata.
- Origin-header checks were not added: every request needs a bearer token,
  and browsers cannot attach one cross-origin without having it.
- Live smoke (after deploy): `initialize` → `tools/list` (21) →
  `tools/call get_activity` with a fresh agent token; then revoke it and
  confirm `AUTH_TOKEN_REVOKED`.
