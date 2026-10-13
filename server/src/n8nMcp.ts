/**
 * n8n's own MCP server, read by this server (11 Oct 2026, Destiny).
 *
 * One call, `get_agent`, and nothing else. It exists because n8n's public API
 * has no agents endpoint: an agent's config can only be read through n8n's MCP
 * server, so until now a person (or Claude) had to read it there and carry the
 * whole answer into `record_agent_inventory` by hand. Bays' answer is past
 * 160,000 characters, which is more than a tool call carries faithfully, and
 * on 11 Oct the inventory was simply not recorded after a publish because of
 * it. With this the dashboard reads the agent itself.
 *
 * It is a client, not a second dependency: streamable HTTP is JSON-RPC 2.0
 * over a POST, so this is `fetch` and nothing more (rule 5 of CLAUDE.md
 * section 2: `pg` is the ceiling).
 *
 * **Read only, plus one preview call.** `callTool` is not exported; what
 * leaves this file is `getAgent`, `readDataTableRows` and, from 13 Oct 2026,
 * `callAgentDraft` (the draft eval, `draftEval.ts`). n8n's MCP server can also
 * create, change and publish agents and workflows, and none of that is
 * reachable from here. `call_agent` runs an agent's *draft* in n8n's Preview
 * chat with its real tools, so it is only ever handed eval cases, whose
 * questions are worded so that a correct answer writes nothing.
 *
 * `N8N_MCP_TOKEN` is the access token from n8n's Settings > Instance-level MCP
 * > Connect > API key tab. It is a different credential from `N8N_API_KEY`
 * (the public REST API) and has no default: unset, nothing is asked and the
 * caller is told which variable is missing.
 */

const URL_ = (process.env.N8N_MCP_URL || `${process.env.N8N_BASE_URL || 'https://bayshorizonnetwork.app.n8n.cloud'}/mcp-server/http`).replace(/\/+$/, '');
const TOKEN = process.env.N8N_MCP_TOKEN?.trim() || null;
const TIMEOUT_MS = Math.max(1000, Number(process.env.N8N_MCP_TIMEOUT_MS) || 45_000);
const PROTOCOL = '2025-06-18';

export const N8N_MCP_VAR = 'N8N_MCP_TOKEN';

export function n8nMcpConfigured(): boolean {
  return Boolean(TOKEN);
}

export function n8nMcpUrl(): string {
  return URL_;
}

export type N8nMcpReason = 'not_configured' | 'unauthorised' | 'unreachable' | 'bad_answer' | 'tool_error' | 'not_found';

export class N8nMcpError extends Error {
  constructor(
    message: string,
    public reason: N8nMcpReason,
    public status: number | null = null,
  ) {
    super(message);
    this.name = 'N8nMcpError';
  }
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** One JSON-RPC message out of a body that is either JSON or one or more SSE frames. */
function readRpc(body: string, contentType: string, id: number | null): Dict | null {
  const pick = (v: unknown): Dict | null => {
    const list = Array.isArray(v) ? v : [v];
    for (const m of list) if (isDict(m) && (id === null || m.id === id) && ('result' in m || 'error' in m)) return m;
    return null;
  };
  if (!/text\/event-stream/i.test(contentType)) {
    try {
      return pick(JSON.parse(body));
    } catch {
      /* fall through: some servers send SSE without saying so */
    }
  }
  // SSE: an event's data may span several `data:` lines; events end at a blank line.
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const m = pick(JSON.parse(data));
      if (m) return m;
    } catch {
      /* not this frame */
    }
  }
  return null;
}

/**
 * n8n's MCP server rate-limits (HTTP 429 "Too many requests"; first seen 13 Oct 2026, when
 * the draft eval asked it three answers at a time). A 429 is waited out and the same request
 * sent again: its Retry-After where it gives one, else 10, 20, 40 and 60 seconds. Still
 * refused after that, the 429 is the answer, as before.
 */
const RETRY_WAITS_MS = [10_000, 20_000, 40_000, 60_000];

async function post(message: Dict, sessionId: string | null, version: string | null, timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: string; contentType: string; sessionId: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const r = await postOnce(message, sessionId, version, timeoutMs);
    if (r.status !== 429 || attempt >= RETRY_WAITS_MS.length) return r;
    const after = Number(r.retryAfter);
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 120_000) : RETRY_WAITS_MS[attempt];
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function postOnce(message: Dict, sessionId: string | null, version: string | null, timeoutMs: number): Promise<{ status: number; body: string; contentType: string; sessionId: string | null; retryAfter: string | null }> {
  if (!TOKEN) throw new N8nMcpError(`${N8N_MCP_VAR} is not set on this server, so n8n's MCP server could not be asked for the agent.`, 'not_configured');
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  // After initialize, the version the server agreed to, as the spec asks.
  if (version) headers['mcp-protocol-version'] = version;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  let res: Response;
  try {
    res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (e) {
    throw new N8nMcpError(`n8n's MCP server at ${URL_} could not be reached: ${e instanceof Error ? e.message : String(e)}`, 'unreachable');
  }
  // The answer's body is not quoted here: nothing an auth refusal says is worth the risk of echoing a credential.
  if (res.status === 401 || res.status === 403) {
    throw new N8nMcpError(`n8n's MCP server refused the token in ${N8N_MCP_VAR} (HTTP ${res.status}). The token was rotated, MCP access was switched off in n8n, or the variable holds the wrong value.`, 'unauthorised', res.status);
  }
  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    // A timeout or a dropped connection part-way through a large answer.
    throw new N8nMcpError(`n8n's MCP server at ${URL_} stopped answering part-way through: ${e instanceof Error ? e.message : String(e)}`, 'unreachable', res.status);
  }
  return { status: res.status, body, contentType: res.headers.get('content-type') || '', sessionId: res.headers.get('mcp-session-id') || sessionId, retryAfter: res.headers.get('retry-after') };
}

/** initialize, then one tools/call. Returns the tool's own answer, parsed. */
async function callTool(name: string, args: Dict, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'bha-engine-dashboard', version: '1' } } }, null, null);
  if (init.status < 200 || init.status >= 300) throw new N8nMcpError(`n8n's MCP server answered HTTP ${init.status} to initialize: ${init.body.slice(0, 300)}`, 'bad_answer', init.status);
  const hello = readRpc(init.body, init.contentType, 1);
  if (!hello || hello.error) throw new N8nMcpError(`n8n's MCP server did not complete initialize: ${hello ? JSON.stringify(hello.error).slice(0, 300) : init.body.slice(0, 300)}`, 'bad_answer', init.status);
  // The spec's acknowledgement. A server that keeps no session ignores it, so its answer is not read.
  const agreed = isDict(hello.result) && typeof hello.result.protocolVersion === 'string' && hello.result.protocolVersion ? hello.result.protocolVersion : PROTOCOL;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId, agreed).catch(() => undefined);
  const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, init.sessionId, agreed, timeoutMs);
  if (call.status < 200 || call.status >= 300) throw new N8nMcpError(`n8n's MCP server answered HTTP ${call.status} to ${name}: ${call.body.slice(0, 300)}`, 'bad_answer', call.status);
  const msg = readRpc(call.body, call.contentType, 2);
  if (!msg) throw new N8nMcpError(`n8n's MCP server answered ${name} with something that is not a JSON-RPC result (${call.body.length} characters).`, 'bad_answer', call.status);
  if (msg.error) {
    const err = isDict(msg.error) ? String(msg.error.message ?? JSON.stringify(msg.error)) : String(msg.error);
    throw new N8nMcpError(`n8n refused ${name}: ${err.slice(0, 400)}`, /not found|unknown tool/i.test(err) ? 'not_found' : 'tool_error', call.status);
  }
  const result = isDict(msg.result) ? msg.result : {};
  const text = Array.isArray(result.content)
    ? result.content
        .filter((c): c is Dict => isDict(c) && c.type === 'text' && typeof c.text === 'string')
        .map((c) => String(c.text))
        .join('')
    : '';
  if (result.isError === true) throw new N8nMcpError(`n8n's ${name} failed: ${text.slice(0, 400) || 'no message'}`, /not found/i.test(text) ? 'not_found' : 'tool_error', call.status);
  if (isDict(result.structuredContent)) return result.structuredContent;
  if (!text) throw new N8nMcpError(`n8n's ${name} answered with no content.`, 'bad_answer', call.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new N8nMcpError(`n8n's ${name} answered with text that is not JSON (${text.length} characters, starting "${text.slice(0, 80)}").`, 'bad_answer', call.status);
  }
}

/**
 * One agent's draft config, whole, exactly as n8n's `get_agent` gives it:
 * `{ agent, config, configHash, skills, tasks, … }`. Refuses an answer that is
 * not that agent, because a row recorded from the wrong answer would be a
 * confident statement about an agent nobody read.
 */
export async function getAgent(agentId: string): Promise<Dict> {
  const id = String(agentId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new N8nMcpError(`"${id.slice(0, 80)}" is not an n8n agent id.`, 'not_found');
  const r = await callTool('get_agent', { agentId: id });
  if (!isDict(r)) throw new N8nMcpError(`n8n's get_agent answered with something that is not an object.`, 'bad_answer');
  if (r.ok === false) {
    const why = String(r.message ?? r.error ?? r.code ?? 'no reason given').slice(0, 300);
    throw new N8nMcpError(`n8n's get_agent refused ${id}: ${why}`, /not.?found/i.test(why) ? 'not_found' : 'tool_error');
  }
  const meta = isDict(r.agent) ? r.agent : null;
  if (!meta || !isDict(r.config)) throw new N8nMcpError(`n8n's get_agent answer for ${id} has no agent or no config.`, 'bad_answer');
  if (String(meta.id) !== id) throw new N8nMcpError(`n8n's get_agent was asked for ${id} and answered about ${String(meta.id)}.`, 'bad_answer');
  return r;
}

/**
 * Every row of one n8n Data Table, through n8n's own `get_data_table_rows`,
 * paged 100 at a time (its cap). Read only. Used by the draft eval to read
 * `agent_eval_set`, the same table the eval runner reads.
 */
export async function readDataTableRows(dataTableId: string, projectId: string, maxRows = 2000): Promise<Dict[]> {
  const rows: Dict[] = [];
  for (let skip = 0; skip < maxRows; skip += 100) {
    const r = await callTool('get_data_table_rows', { dataTableId, projectId, limit: 100, skip });
    const page = isDict(r) && Array.isArray(r.rows) ? (r.rows as unknown[]).filter(isDict) : null;
    if (!page) throw new N8nMcpError(`n8n's get_data_table_rows answered for ${dataTableId} with no rows list.`, 'bad_answer');
    rows.push(...page);
    if (page.length < 100) return rows;
  }
  throw new N8nMcpError(`Data Table ${dataTableId} holds more than ${maxRows} rows; refusing to read part of it as the whole.`, 'bad_answer');
}

export interface DraftAnswer {
  status: string;
  response: string;
  execution_id: string | null;
  error: string | null;
}

/**
 * One message to an agent's **draft**, through n8n's `call_agent` (its
 * Preview chat): a fresh session each time. The draft runs with its real
 * tools. Returns the reply text and n8n's status; a reply that is not
 * `completed` (an approval it is waiting on, an error) comes back with its
 * status and no text, never as an empty success.
 */
export async function callAgentDraft(agentId: string, message: string, timeoutMs = 300_000): Promise<DraftAnswer> {
  const id = String(agentId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new N8nMcpError(`"${id.slice(0, 80)}" is not an n8n agent id.`, 'not_found');
  const r = await callTool('call_agent', { agentId: id, request: { type: 'message', message } }, timeoutMs);
  if (!isDict(r)) throw new N8nMcpError(`n8n's call_agent answered with something that is not an object.`, 'bad_answer');
  const status = String(r.status ?? (r.ok === false ? 'error' : 'unknown'));
  const response = typeof r.response === 'string' ? r.response : '';
  const execution_id = typeof r.executionId === 'string' ? r.executionId : null;
  if (r.ok === false || status !== 'completed' || !response.trim()) {
    const why = String(r.message ?? r.error ?? (status !== 'completed' ? `the draft ended with status "${status}"` : 'the draft returned no answer text')).slice(0, 400);
    return { status, response: '', execution_id, error: why };
  }
  return { status, response, execution_id, error: null };
}
