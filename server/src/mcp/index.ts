/**
 * An MCP server, mounted on this dashboard's own Node server.
 *
 * Built 2026-09-18, on Destiny's instruction. It exists because the page is
 * client-rendered: fetching the dashboard's URL returns an empty shell, so a
 * Claude client asked "on this page I can't do X" had no way to see the app at
 * all. These tools give it the app's structure — routes, pages, panels, which
 * data feeds which panel — and its live data.
 *
 * **Mounted, not a second service.** It hangs off the same `createServer`
 * handler as `/api`, deploys with the same commit and runs in the same process
 * against the same Postgres, so there is nothing extra to keep running or to
 * keep in step.
 *
 * **No new dependency.** CLAUDE.md section 2 caps this server's dependencies at
 * `pg`, and says in as many words that the cap is the ceiling and not a
 * precedent. The MCP SDK would have been the second one, so the transport is
 * written here instead: streamable HTTP is JSON-RPC 2.0 over a POST, which is
 * `readJson` and a switch. It answers with a single JSON object, or with one
 * SSE frame when the client asks for an event stream, because the spec allows
 * either and clients differ about which they send.
 *
 * **Why the secret is in the path and why a wrong one is a 404.** The endpoint
 * is `/mcp/:secret` with `MCP_SECRET` from the environment, and anything that
 * does not match — including no `MCP_SECRET` set at all — gets the same 404 an
 * unknown route gets. Not a 401: a 401 tells a stranger the endpoint is there
 * and that they need a credential. A 404 tells them nothing.
 *
 * **Read only.** There is no write tool, and no code path from a tool to a
 * write. See tools.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpError } from './source';
import { toolByName, toolCatalogue, sourceWarning, type ToolDeps } from './tools';

/** The protocol revisions this server knows how to speak. Newest first. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'bha-engine-dashboard', title: 'BHA Engine Dashboard', version: '1.0.0' };

export const MCP_SECRET = process.env.MCP_SECRET?.trim() || null;
export const MCP_SECRET_VAR = 'MCP_SECRET';

export function mcpConfigured(): boolean {
  return Boolean(MCP_SECRET);
}

/** The path the connector is pointed at, for the boot line. The secret is never printed. */
export function mcpMountPath(): string {
  return '/mcp/<MCP_SECRET>';
}

/* --------------------------------------------------------------- JSON-RPC */

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function result(id: RpcRequest['id'], value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function failure(id: RpcRequest['id'], code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

/* ------------------------------------------------------------------ logging */

/** Arguments are logged whole up to this, so a call can be reproduced from the log. */
const MAX_LOGGED_ARGS = 400;

function logCall(name: string, args: unknown, outcome: string, ms: number, bytes: number | null): void {
  const a = JSON.stringify(args ?? {});
  const shown = a.length > MAX_LOGGED_ARGS ? `${a.slice(0, MAX_LOGGED_ARGS)}…` : a;
  console.log(`[mcp] ${name} ${shown} — ${outcome} in ${ms}ms${bytes === null ? '' : `, ${bytes} bytes`}`);
}

/* -------------------------------------------------------------- the methods */

async function handleRpc(req: RpcRequest, deps: ToolDeps): Promise<Record<string, unknown> | null> {
  const method = typeof req.method === 'string' ? req.method : '';
  const isNotification = req.id === undefined || req.id === null;
  const params = (req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const client = params.clientInfo && typeof params.clientInfo === 'object' ? (params.clientInfo as { name?: string }).name : null;
      console.log(`[mcp] initialize — client ${client ?? 'unnamed'}, protocol ${asked ?? 'unstated'}`);
      const warn = sourceWarning();
      if (warn) console.warn(`[mcp] ${warn}`);
      return result(req.id, {
        protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'This dashboard is client-rendered, so fetching its URL returns an empty shell. Read its structure here instead. Start with list_pages, then get_page_structure for the page in question — that is the tool that says what a panel is and what feeds it. get_page_data returns what a page would render right now. Every tool is read-only, and every one of them reports what it could not answer rather than guessing.',
      });
    }

    // Notifications carry no id and get no result — just a 202 from the caller.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return result(req.id, {});

    case 'tools/list':
      return result(req.id, { tools: toolCatalogue() });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      const tool = toolByName(name);
      const t0 = Date.now();
      if (!tool) {
        logCall(name || '(unnamed)', args, 'no such tool', Date.now() - t0, null);
        return failure(req.id, INVALID_PARAMS, `There is no tool called "${name}". This server offers: ${toolCatalogue().map((t) => t.name).join(', ')}.`);
      }
      try {
        const value = await tool.handler(args, deps);
        const text = JSON.stringify(value, null, 2);
        logCall(name, args, 'ok', Date.now() - t0, Buffer.byteLength(text));
        return result(req.id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        // A tool that cannot answer says why, as the tool's own result rather
        // than a protocol error: the client is meant to read the reason and ask
        // something else, not treat the call as malformed.
        const explicit = e instanceof McpError;
        const message = e instanceof Error ? e.message : String(e);
        const code = explicit ? (e as McpError).code : 'unexpected_error';
        logCall(name, args, `failed (${code})`, Date.now() - t0, null);
        if (!explicit) console.error('[mcp] unexpected error in', name, e);
        return result(req.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: code, message, tool: name, arguments: args, answered: false }, null, 2),
            },
          ],
          isError: true,
        });
      }
    }

    // Declared in no capability, so a client should not ask. Answered properly
    // rather than with an empty list, which would read as "there are none".
    case 'resources/list':
    case 'resources/templates/list':
    case 'prompts/list':
      return isNotification ? null : failure(req.id, METHOD_NOT_FOUND, `This server offers tools only; it declares no ${method.split('/')[0]} capability.`);

    default:
      return isNotification ? null : failure(req.id, METHOD_NOT_FOUND, `Unknown method "${method}".`);
  }
}

/* ------------------------------------------------------------ the transport */

/** 1 MB. A tool call is a few hundred bytes; anything near this is not one. */
const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new Error('body could not be read')));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** One SSE frame carrying the response, then the stream closes. */
function sendEventStream(res: ServerResponse, body: unknown): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  res.end();
}

/** The 404 every miss gets, so the endpoint is not discoverable. */
function notFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, message: 'No such route.' });
}

function secretMatches(given: string): boolean {
  if (!MCP_SECRET) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(MCP_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Handles anything under `/mcp`. Returns false when the request is not for this
 * server at all, so the caller can carry on to its own routes — though in
 * practice nothing else in this app serves `/mcp`.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, deps: ToolDeps): Promise<void> {
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  // Exactly /mcp/<secret>. A deeper path is not this endpoint.
  if (parts.length !== 2 || parts[0] !== 'mcp' || !secretMatches(decodeURIComponent(parts[1]))) {
    console.log(`[mcp] rejected ${req.method ?? 'GET'} ${parts.length} path segment(s) under /mcp — ${MCP_SECRET ? 'secret did not match' : `${MCP_SECRET_VAR} is not set on this service`}; answered 404`);
    return notFound(res);
  }

  const method = req.method ?? 'GET';

  // This server never pushes to the client, so there is no stream to open.
  if (method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST, DELETE', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(failure(null, INVALID_REQUEST, 'This endpoint answers POSTed JSON-RPC only. It opens no server-initiated stream, so there is nothing to GET.')));
    return;
  }
  // Ending a session. Nothing is kept between calls, so there is nothing to end.
  if (method === 'DELETE') return sendJson(res, 200, { ok: true, message: 'Nothing is kept between calls, so there was no session to end.' });
  if (method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST, DELETE', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(failure(null, INVALID_REQUEST, `${method} is not accepted here. POST a JSON-RPC request.`)));
    return;
  }

  const accept = String(req.headers.accept ?? '');
  const wantsStream = accept.includes('text/event-stream') && !accept.includes('application/json');
  const reply = (status: number, body: unknown): void => (wantsStream && status === 200 ? sendEventStream(res, body) : sendJson(res, status, body));

  let text: string;
  try {
    text = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, failure(null, INVALID_REQUEST, e instanceof Error ? e.message : 'The request body could not be read.'));
  }

  let payload: unknown;
  try {
    payload = text.trim() ? JSON.parse(text) : null;
  } catch {
    return sendJson(res, 400, failure(null, PARSE_ERROR, 'The request body was not JSON.'));
  }
  if (!payload || typeof payload !== 'object') {
    return sendJson(res, 400, failure(null, INVALID_REQUEST, 'Expected a JSON-RPC request object, or an array of them.'));
  }

  const batch = Array.isArray(payload) ? (payload as RpcRequest[]) : [payload as RpcRequest];
  if (!batch.length) return sendJson(res, 400, failure(null, INVALID_REQUEST, 'An empty batch is not a request.'));

  const answers: Record<string, unknown>[] = [];
  for (const one of batch) {
    try {
      const answer = await handleRpc(one, deps);
      if (answer) answers.push(answer);
    } catch (e) {
      console.error('[mcp] the transport hit an error', e);
      answers.push(failure(one?.id ?? null, INTERNAL_ERROR, e instanceof Error ? e.message : 'The server hit an error handling that request.'));
    }
  }

  // Every message was a notification: accepted, with nothing to say back.
  if (!answers.length) {
    res.writeHead(202, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  return reply(200, Array.isArray(payload) ? answers : answers[0]);
}
