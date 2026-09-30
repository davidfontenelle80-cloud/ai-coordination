/**
 * mcp.mjs — task 019 Model Context Protocol server.
 *
 * A thin, hand-rolled JSON-RPC 2.0 translation over the hub's existing
 * query and command surface (no SDK, no dependency). index.mjs owns the
 * HTTP route, authentication, and body cap; this module only sees an
 * already-authenticated agent principal and the raw request text.
 *
 * Invariants:
 * - The tool catalog is generated from QUERIES (queries.mjs) and
 *   COMMANDS/COMMAND_SCHEMAS (commands.mjs) — the same tables the REST API
 *   dispatches through — so the two surfaces cannot drift.
 * - Command tools call executeCommand(), which runs the central authorize()
 *   matrix and every builder's validation. This layer invents no
 *   permissions and relaxes none.
 * - Protocol failures are JSON-RPC errors. Hub domain failures (validation,
 *   not-found, forbidden, conflicts, rate limit) are CallToolResults with
 *   isError: true carrying the hub's { ok:false, code, message } body.
 * - Stateless: no Mcp-Session-Id, no server-side session.
 * - Token issuance / revocation / inventory are deliberately NOT tools.
 */

import { executeCommand, COMMANDS, COMMAND_SCHEMAS } from './commands.mjs';
import { QUERIES } from './queries.mjs';

// Server identity. version tracks hub/package.json (asserted by the tests).
export const MCP_SERVER_INFO = { name: 'ai-hub', version: '0.1.0' };

// Newest first. initialize echoes the client's version when supported,
// otherwise offers the newest (the client decides whether to proceed).
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

const INSTRUCTIONS = [
  'AI Hub: the team coordination hub (tasks, Team chat, decisions, activity).',
  'Read tools are safe to call any time; poll get_activity to follow the team.',
  'Every write tool requires idempotency_key: generate a fresh UUID per action and reuse it only when retrying that same action.',
  'Your identity comes from your token; write tools always act as you.',
].join(' ');

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** createTask -> create_task */
export function toolNameForCommand(command) {
  return command.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// Properties every command tool accepts (enforced by executeCommand).
const COMMON_COMMAND_PROPS = {
  idempotency_key: {
    type: 'string', minLength: 1,
    description: 'Required. A fresh UUID per action; reuse the same value only to retry that action.',
  },
  expected_task_version: {
    type: 'integer', minimum: 0,
    description: 'Optional optimistic-concurrency guard: the task version you last saw.',
  },
};

function buildTools() {
  const tools = [];
  for (const [name, def] of Object.entries(QUERIES)) {
    tools.push({
      kind: 'query', name,
      description: `${def.description} (REST: ${def.rest})`,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  }
  for (const command of COMMANDS) {
    const s = COMMAND_SCHEMAS[command];
    tools.push({
      kind: 'command', name: toolNameForCommand(command), command,
      description: `${s.description} (REST: POST /api/commands {"command":"${command}"})`,
      inputSchema: {
        type: 'object',
        properties: { ...s.properties, ...COMMON_COMMAND_PROPS },
        required: [...s.required, 'idempotency_key'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
  }
  return tools;
}

const TOOLS = buildTools();
const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/** The public tools/list payload (internal routing fields stripped). */
export function listTools() {
  return TOOLS.map(({ name, description, inputSchema, annotations }) =>
    ({ name, description, inputSchema, annotations }));
}

// Query arguments over REST are always strings from the URL; JSON-RPC can
// carry any type. Type-check against the advertised schema so a malformed
// argument is VALIDATION_FAILED, never a SQL bind error.
function checkQueryArgs(tool, args) {
  const { properties = {}, required = [] } = tool.inputSchema;
  for (const key of required) {
    if (typeof args[key] !== 'string' || args[key].length === 0) {
      return `${tool.name} requires ${key}`;
    }
  }
  for (const [key, prop] of Object.entries(properties)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (prop.type === 'string' && typeof v !== 'string') return `${tool.name} ${key} must be a string`;
    if (prop.type === 'integer' && !Number.isInteger(v)) return `${tool.name} ${key} must be an integer`;
  }
  return null;
}

async function runTool(tool, db, principal, args, { checkCommandRate }) {
  if (tool.kind === 'query') {
    const bad = checkQueryArgs(tool, args);
    if (bad) return { ok: false, code: 'VALIDATION_FAILED', message: bad, retryable: false };
    return QUERIES[tool.name].run(db, args);
  }
  // Commands share the REST command rate-limit bucket for this principal.
  const limited = checkCommandRate ? checkCommandRate(principal) : null;
  if (limited) return limited;
  // `command` is fixed by the tool, never taken from the arguments.
  return executeCommand(db, principal, { ...args, command: tool.command });
}

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: !result.ok,
  };
}

const rpcResult = (id, result) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const rpcError = (id, code, message, status = 200) =>
  ({ status, body: { jsonrpc: '2.0', id, error: { code, message } } });

/**
 * Handle one MCP JSON-RPC message from an authenticated agent.
 *
 * `text` is the raw body (string), null when unreadable, or
 * { tooLarge: true } when over the 1 MiB cap.
 * Returns { status, body } — body undefined means 202 Accepted, no body
 * (notifications and client responses).
 */
export async function handleJsonRpc(db, principal, text, { checkCommandRate, protocolVersion } = {}) {
  if (isPlainObject(text) && text.tooLarge) {
    return rpcError(null, INVALID_REQUEST, 'request body exceeds 1 MiB', 400);
  }
  let msg;
  try {
    msg = JSON.parse(text ?? '');
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error: body must be a JSON-RPC 2.0 message', 400);
  }
  if (Array.isArray(msg)) {
    return rpcError(null, INVALID_REQUEST, 'JSON-RPC batches are not supported', 400);
  }
  const validId = isPlainObject(msg) && (typeof msg.id === 'string' || Number.isInteger(msg.id));
  const id = validId ? msg.id : null;
  if (!isPlainObject(msg) || msg.jsonrpc !== '2.0') {
    return rpcError(id, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 object', 400);
  }

  // A response to a server request (we never send any) or a notification
  // needs no reply: 202 Accepted per the Streamable HTTP transport.
  if (!('method' in msg)) {
    if ('result' in msg || 'error' in msg) return { status: 202 };
    return rpcError(id, INVALID_REQUEST, 'Invalid Request: method is required', 400);
  }
  if (typeof msg.method !== 'string') {
    return rpcError(id, INVALID_REQUEST, 'Invalid Request: method must be a string', 400);
  }
  if (!('id' in msg)) return { status: 202 }; // notifications/initialized, cancelled, ...
  if (!validId) return rpcError(null, INVALID_REQUEST, 'Invalid Request: id must be a string or integer', 400);

  if (msg.params !== undefined && !isPlainObject(msg.params)) {
    return rpcError(id, INVALID_PARAMS, 'params must be an object');
  }
  const params = msg.params || {};

  // After initialize, clients send the negotiated version on every request.
  if (msg.method !== 'initialize' && protocolVersion && !MCP_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return rpcError(id, INVALID_REQUEST, `unsupported MCP-Protocol-Version ${protocolVersion}`, 400);
  }

  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: listTools() });
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(id, INVALID_PARAMS, 'tools/call requires a tool name');
      const tool = TOOL_INDEX.get(params.name);
      if (!tool) return rpcError(id, INVALID_PARAMS, `unknown tool: ${params.name}`);
      const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
      if (!isPlainObject(args)) return rpcError(id, INVALID_PARAMS, 'tools/call arguments must be an object');
      try {
        return rpcResult(id, toolResult(await runTool(tool, db, principal, args, { checkCommandRate })));
      } catch (e) {
        // Auth failures keep the REST mapping (handled by index.mjs).
        if (e && typeof e.code === 'string' && e.code.startsWith('AUTH_')) throw e;
        // Anything else is a server bug: log it, never leak it.
        console.error(`MCP tool ${tool.name} failed:`, e);
        return rpcError(id, INTERNAL_ERROR, 'internal error');
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}
