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
