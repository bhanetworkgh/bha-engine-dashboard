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
 * **Nothing under `/mcp` ever answers 401** (2026-09-18, Destiny). A 401 is
 * what starts an OAuth flow, and this server deliberately has none, so a 401
 * would send a client off to discover an authorization server that does not
 * exist. The secret in the path is the whole of the authentication, and a
 * request that fails it is a request to a route that does not exist.
 *
 * **Discovery needs the GET stream, and refusing it is what broke the
 * connector** (2026-09-18, Destiny). This server sends no server-initiated
 * messages, so a 405 on `GET` was spec-legal — and it made the endpoint
 * undiscoverable in practice. Claude's connector check opens with a `GET`,
 * read the 405 as "could not connect", could not then determine how the server
 * signs in, and fell back to OAuth dynamic client registration, which fails
 * here because there is no OAuth. So `GET` now opens a real event stream and
 * holds it: it carries no messages, which is honest, but it opens, which is
 * what the client needs to see. `OPTIONS` answers the CORS preflight and
 * `DELETE` ends a session. **The secret is still checked before any of them**,
 * so none of the three tells an unauthenticated caller that the endpoint is
 * there.
 *
 * **Two tokens, two surfaces** (2026-09-24, Destiny). `/mcp/<MCP_SECRET>` is
 * the read connection, exactly as it was. `/mcp/<MCP_WRITE_TOKEN>` is the
 * write connection: every read tool **plus** the write tools in
 * writeTools.ts. On a read connection the write tools are not registered at
 * all — not listed, and a call to one is "no such tool" — rather than listed
 * and refused, because a tool a client can see is a tool a model will try.
 * Both answer a miss with the same 404, and every call is logged with which
 * token it came in on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpError } from './source';
import { toolByName, toolCatalogue, sourceWarning, type ToolDeps } from './tools';

/** The protocol revisions this server knows how to speak. Newest first. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'bha-engine-dashboard', title: 'BHA Engine Dashboard', version: '1.0.0' };

export const MCP_SECRET = process.env.MCP_SECRET?.trim() || null;
export const MCP_SECRET_VAR = 'MCP_SECRET';

/**
 * The write connection's path secret (2026-09-24). No default, on the rule the
 * read secret follows. Refused if it is the same string as the read secret:
 * one URL cannot be both, and treating it as either would be a guess about
 * which one somebody meant.
 */
const WRITE_RAW = process.env.MCP_WRITE_TOKEN?.trim() || null;
export const MCP_WRITE_TOKEN = WRITE_RAW && WRITE_RAW !== MCP_SECRET ? WRITE_RAW : null;
export const MCP_WRITE_TOKEN_VAR = 'MCP_WRITE_TOKEN';
export const MCP_WRITE_TOKEN_CLASHES = Boolean(WRITE_RAW && WRITE_RAW === MCP_SECRET);

export type McpAccess = 'read' | 'write';

export function mcpConfigured(): boolean {
  return Boolean(MCP_SECRET);
}

export function mcpWriteConfigured(): boolean {
  return Boolean(MCP_WRITE_TOKEN);
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

function logCall(access: McpAccess, name: string, args: unknown, outcome: string, ms: number, bytes: number | null): void {
  const a = JSON.stringify(args ?? {});
  const shown = a.length > MAX_LOGGED_ARGS ? `${a.slice(0, MAX_LOGGED_ARGS)}…` : a;
  console.log(`[mcp:${access}] ${name} ${shown} — ${outcome} in ${ms}ms${bytes === null ? '' : `, ${bytes} bytes`}`);
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
          [
            'This dashboard is client-rendered, so fetching its URL returns an empty shell. Read it here instead.',
            '',
            'When something looks wrong or empty on a page, start at get_health and get_mirror_status. A page showing nothing usually means an unread mirror rather than an empty system: every record kind is a copy of an upstream table, and a copy nobody has filled looks exactly like a source with nothing in it. get_mirror_status says which of the two in one call; diff_source_vs_mirror settles it against the source, at the cost of reading that source whole; resync fills it by running the page\u2019s own button.',
            '',
            'When you want to understand the app rather than debug it: list_pages, then get_page_structure for the page in question — that is the tool that says what a panel is and what feeds it. get_page_data says what a page would render right now, and takes a `fields` list of dot paths when you want two numbers rather than a whole payload.',
            '',
            'query_postgres answers anything about the held data directly, as one read-only SELECT — bind values as parameters. describe_schema gives the real column names, read from the database rather than from the repository. search_logs covers what this process has served since it booted, and says so rather than implying silence.',
            '',
            'Two things hold across every tool. Each one reports what it could not answer rather than guessing — an unconfigured source is "not configured" and never "healthy", a cut payload says it was cut, and a name that is ambiguous is refused with the candidates named. And every mutating tool previews before it acts: called without a token it changes nothing and hands back what it would do, plus a short-lived token that works once.',
            ...(deps.access === 'write'
              ? [
                  '',
                  'This is the WRITE connection. Beside the reads it carries list_writable_kinds, create_record, update_record, archive_record and delete_record. Start with list_writable_kinds: it names every writable kind, its required fields, its allowed values and which guards apply. Every write goes through the same server function n8n\u2019s POST and PATCH use, runs the same guards the Bays Tools Router runs, and is logged to engine_mcp_writes whether it lands, is refused or is a dry run. Pass dry_run: true to see exactly what would be written. A refusal — possible_duplicate, lane_owner_mismatch, not_permitted — writes nothing and says what to send to proceed.',
                ]
              : []),
          ].join('\n'),
      });
    }

    // Notifications carry no id and get no result — just a 202 from the caller.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return result(req.id, {});

    case 'tools/list':
      return result(req.id, { tools: toolCatalogue(deps.access) });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      const tool = toolByName(name, deps.access);
      const t0 = Date.now();
      if (!tool) {
        logCall(deps.access, name || '(unnamed)', args, 'no such tool', Date.now() - t0, null);
        return failure(req.id, INVALID_PARAMS, `There is no tool called "${name}". This server offers: ${toolCatalogue(deps.access).map((t) => t.name).join(', ')}.`);
      }
      try {
        const value = await tool.handler(args, deps);
        const text = JSON.stringify(value, null, 2);
        logCall(deps.access, name, args, 'ok', Date.now() - t0, Buffer.byteLength(text));
        return result(req.id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        // A tool that cannot answer says why, as the tool's own result rather
        // than a protocol error: the client is meant to read the reason and ask
        // something else, not treat the call as malformed.
        const explicit = e instanceof McpError;
        const message = e instanceof Error ? e.message : String(e);
        const code = explicit ? (e as McpError).code : 'unexpected_error';
        logCall(deps.access, name, args, `failed (${code})`, Date.now() - t0, null);
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

/* ----------------------------------------------------------------- CORS */

/**
 * The cross-origin headers every answer past the secret check carries.
 *
 * `Access-Control-Expose-Headers: Mcp-Session-Id` is the load-bearing one: a
 * browser client cannot read a response header it is not exposed, so without it
 * the session id this server issues on initialize is invisible to the very
 * client it was issued to.
 *
 * The origin is echoed where the request names one, with `Vary: Origin`, rather
 * than always `*` — that keeps the answer correct for a caller that sends
 * credentials, which `*` forbids. No origin, no echo: `*`.
 */
function cors(req: IncomingMessage, sessionId?: string | null): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': typeof origin === 'string' && origin ? origin : '*',
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, accept, last-event-id, mcp-session-id, mcp-protocol-version, x-requested-with',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

/** One SSE frame carrying the response, then the stream closes. */
function sendEventStream(res: ServerResponse, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    ...extra,
  });
  res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  res.end();
}

/** The 404 every miss gets, so the endpoint is not discoverable. */
function notFound(res: ServerResponse): void {
  // Deliberately carries no CORS and no hint of its own: byte for byte what an
  // unknown route answers, because that is what a wrong secret is.
  sendJson(res, 404, { ok: false, message: 'No such route.' });
}

function same(given: string, secret: string | null): boolean {
  if (!secret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Which connection a path secret opens, or null for a miss. Both are compared in constant time. */
function accessFor(given: string): McpAccess | null {
  const write = same(given, MCP_WRITE_TOKEN);
  const read = same(given, MCP_SECRET);
  return write ? 'write' : read ? 'read' : null;
}

/* --------------------------------------------------------------- sessions */

/**
 * The session ids this process has issued.
 *
 * Nothing per-session is actually kept — every tool reads the same source tree
 * and the same database — so this exists to answer initialize with an id, to
 * log which conversation a call belongs to, and for nothing else.
 *
 * **An id this process does not recognise is accepted, never refused.** Render
 * restarts on every deploy and after every spin-down, so a client's id
 * routinely outlives the process that issued it. Refusing it would end a
 * working conversation to defend state that does not exist; the spec's 404 for
 * an expired session would also be indistinguishable here from the 404 a wrong
 * secret gets, which is the one signal this endpoint needs to keep unambiguous.
 */
const sessions = new Map<string, { created: string; seen: number }>();
const MAX_SESSIONS = 500;

function rememberSession(id: string): void {
  if (!sessions.has(id) && sessions.size >= MAX_SESSIONS) {
    // Oldest first; Map keeps insertion order.
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }
  const held = sessions.get(id);
  if (held) held.seen = Date.now();
  else sessions.set(id, { created: new Date().toISOString(), seen: Date.now() });
}

function sessionHeader(req: IncomingMessage): string | null {
  const v = req.headers['mcp-session-id'];
  const id = Array.isArray(v) ? v[0] : v;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/* -------------------------------------------------------------- the stream */

/**
 * How often a comment goes down an idle stream. Below the 60 seconds most
 * proxies idle a connection out at, and Render's router is one of them.
 */
const KEEPALIVE_MS = 20_000;

let openStreams = 0;

/**
 * Opens an event stream and holds it.
 *
 * It carries no messages, because this server has none to push. That is the
 * whole point of what it fixes: the client needs the stream to *open*, and a
 * stream that opens and says nothing is an honest answer where a 405 was a
 * misleading one.
 *
 * The keep-alive comments are not decoration. Render's router closes an idle
 * connection, and `X-Accel-Buffering: no` plus an immediate first byte are what
 * stop a buffering proxy from holding the headers back so long that the client
 * cannot tell an open stream from a hang.
 */
function holdEventStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors(req, sessionHeader(req)),
  });
  res.write(': open\n\n');

  const socket = res.socket;
  if (socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true);
    // Node would otherwise time an idle socket out from under a live stream.
    socket.setTimeout(0);
  }

  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, KEEPALIVE_MS);
  // Never a reason to keep the process alive on its own.
  timer.unref();

  openStreams += 1;
  const opened = Date.now();
  console.log(`[mcp] GET stream opened — ${openStreams} open${sessionHeader(req) ? `, session ${sessionHeader(req)}` : ''}`);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    openStreams -= 1;
    console.log(`[mcp] GET stream closed after ${Math.round((Date.now() - opened) / 1000)}s — ${openStreams} open`);
  };
  req.on('close', close);
  req.on('aborted', close);
  res.on('close', close);
}

/* ------------------------------------------------------------ the handler */

/**
 * Handles anything under `/mcp`.
 *
 * The secret is checked first, for every method, before anything else is read —
 * so `OPTIONS`, `GET`, `POST` and `DELETE` are all equally silent to a caller
 * who does not have it.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, baseDeps: Omit<ToolDeps, 'access'>): Promise<void> {
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  // Exactly /mcp/<secret>. A deeper path is not this endpoint.
  //
  // The reason is logged as it actually is: a bare /mcp and a deeper path never
  // reach the comparison at all, and saying "secret did not match" for those
  // sends whoever is debugging this to check the wrong thing.
  const wellFormed = parts.length === 2 && parts[0] === 'mcp';
  const access = wellFormed ? accessFor(decodeURIComponent(parts[1])) : null;
  if (!access) {
    const why = !wellFormed
      ? `the path is not /mcp/<secret> (${parts.length} segment(s))`
      : MCP_SECRET || MCP_WRITE_TOKEN
        ? 'the secret did not match'
        : `neither ${MCP_SECRET_VAR} nor ${MCP_WRITE_TOKEN_VAR} is set on this service`;
    console.log(`[mcp] rejected ${method} ${url.pathname.split('/').slice(0, 2).join('/')}/… — ${why}; answered 404`);
    return notFound(res);
  }
  const deps: ToolDeps = { ...baseDeps, access };

  const given = sessionHeader(req);
  if (given) rememberSession(given);

  // The CORS preflight. A browser sends this before the real request, so it has
  // to answer before anything else can.
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0', ...cors(req, given) });
    res.end();
    return;
  }

  /**
   * The stream a client opens to discover the server. It stays open and carries
   * nothing; see holdEventStream for why that is the right answer and a 405 was
   * not.
   */
  if (method === 'GET') {
    holdEventStream(req, res);
    return;
  }

  // HEAD cannot carry a body, so it answers with the stream's own headers and
  // stops there — enough for a probe that only wants to know the route is live.
  if (method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req, given) });
    res.end();
    return;
  }

  // Ending a session. Nothing per-session is kept, so there is nothing to tear
  // down — but the client is entitled to a clean 204 rather than a body it did
  // not ask for.
  if (method === 'DELETE') {
    if (given) {
      sessions.delete(given);
      console.log(`[mcp] DELETE — session ${given} forgotten`);
    }
    res.writeHead(204, { 'Content-Length': '0', ...cors(req, given) });
    res.end();
    return;
  }

  if (method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, POST, DELETE, OPTIONS', 'Cache-Control': 'no-store', ...cors(req, given) });
    res.end(JSON.stringify(failure(null, INVALID_REQUEST, `${method} is not accepted here. POST a JSON-RPC request, or GET the event stream.`)));
    return;
  }

  let text: string;
  try {
    text = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, failure(null, INVALID_REQUEST, e instanceof Error ? e.message : 'The request body could not be read.'), cors(req, given));
  }

  let payload: unknown;
  try {
    payload = text.trim() ? JSON.parse(text) : null;
  } catch {
    return sendJson(res, 400, failure(null, PARSE_ERROR, 'The request body was not JSON.'), cors(req, given));
  }
  if (!payload || typeof payload !== 'object') {
    return sendJson(res, 400, failure(null, INVALID_REQUEST, 'Expected a JSON-RPC request object, or an array of them.'), cors(req, given));
  }

  const batch = Array.isArray(payload) ? (payload as RpcRequest[]) : [payload as RpcRequest];
  if (!batch.length) return sendJson(res, 400, failure(null, INVALID_REQUEST, 'An empty batch is not a request.'), cors(req, given));

  /**
   * A session id is issued on initialize and returned in `Mcp-Session-Id`, the
   * header the client then sends back. Minted here rather than inside
   * handleRpc, which answers in JSON-RPC and has no way to set a header.
   */
  const initialising = batch.some((one) => one?.method === 'initialize');
  let sessionId = given;
  if (initialising) {
    sessionId = randomUUID();
    rememberSession(sessionId);
    console.log(`[mcp] initialize — issued session ${sessionId}`);
  }

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

  const headers = cors(req, sessionId);

  // Every message was a notification: accepted, with nothing to say back.
  if (!answers.length) {
    res.writeHead(202, { 'Content-Length': '0', ...headers });
    res.end();
    return;
  }

  const accept = String(req.headers.accept ?? '');
  const wantsStream = accept.includes('text/event-stream') && !accept.includes('application/json');
  const body = Array.isArray(payload) ? answers : answers[0];
  return wantsStream ? sendEventStream(res, body, headers) : sendJson(res, 200, body, headers);
}
