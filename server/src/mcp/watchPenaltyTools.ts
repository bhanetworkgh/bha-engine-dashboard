/**
 * The Decision Watch pay penalty over MCP (23 Nov 2026, Destiny; Jason's approved rule). ../watchPenalty.ts holds the logic.
 *   read_watch_penalties    read, both connections, Genie's scope: whether the rule is on, the watches in penalty,
 *                           the overrides, and every open watch in scope grouped for Jason's 30-day Pilot 1 push.
 *   switch_watch_penalty    write connection, no agent's scope: on or off, Destiny or Jason, a reason. On only after
 *                           the announcement has gone out; only escalations after it count.
 *   override_watch_penalty  write connection, no agent's scope: Destiny or Jason, a written reason, kept on record.
 */
import * as wp from '../watchPenalty';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const readWatchPenalties: ToolDefinition = {
  name: 'read_watch_penalties',
  description: "The Decision Watch pay penalty Jason approved on 22 Nov 2026: whether it is switched on and since when, the rule in words, the watches in penalty (pending, or applied to a log, with the share taken), the overrides with their reasons, and in_scope: every open watch the rule covers, grouped for the 30-day Pilot 1 push (racks and hardware, Monitoring Twin, Stripe 2KG0 / V52V and charge gate, CAPITAL, CST, engine), with how many open watches have no lane and so sit outside it. Read only.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Decision Watch pay penalty' },
  handler: async (_args, deps) => {
    const t0 = Date.now();
    const r = await wp.read();
    await mirror.logWrite({ endpoint: 'mcp:read_watch_penalties', kind: 'watch_penalty', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `on=${r.on}`, ms: Date.now() - t0 }).catch(() => undefined);
    return { ok: true, ...r };
  },
};

export const switchWatchPenalty: ToolDefinition = {
  name: 'switch_watch_penalty',
  description: 'Switch the Decision Watch pay penalty on or off. Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) only, as requester_user_id, with a reason. Switch it on only after the announcement has been posted: only escalations after the moment it is switched on count, and nothing is applied backwards. Off stops new penalties; ones already recorded stay. Audited on engine_mcp_writes (kind watch_penalty).',
  inputSchema: { type: 'object', properties: { on: { type: 'boolean' }, reason: { type: 'string' }, requester_user_id: { type: 'string' } }, required: ['on', 'reason', 'requester_user_id'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Switch the watch pay penalty' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    if (deps.agent) return { ok: false, reason: 'not_on_agent_token', message: 'A person switches the pay penalty, never an agent.' };
    const audit = await auditOpen({ tool: 'switch_watch_penalty', args, access: deps.access, kind: 'watch_penalty', requester, dry_run: false });
    const r = await wp.setSwitch(args.on === true, requester, String(args.reason ?? ''));
    await auditClose(audit, { outcome: r.ok ? 'applied' : 'refused', detail: String(r.ok ? (args.on ? 'on' : 'off') : r.reason) });
    return { ...r, audit_id: audit };
  },
};

export const overrideWatchPenalty: ToolDefinition = {
  name: 'override_watch_penalty',
  description: 'Override one Decision Watch pay penalty (WP-...) with a written reason of 8 characters or more, kept on record. Destiny or Jason only, as requester_user_id. A pending penalty is then never applied; an applied one is marked overridden and the answer says which pay note to restore. Audited on engine_mcp_writes (kind watch_penalty).',
  inputSchema: { type: 'object', properties: { penalty_id: { type: 'string' }, reason: { type: 'string' }, requester_user_id: { type: 'string' } }, required: ['penalty_id', 'reason', 'requester_user_id'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Override a watch pay penalty' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    if (deps.agent) return { ok: false, reason: 'not_on_agent_token', message: 'A person overrides a pay penalty, never an agent.' };
    const audit = await auditOpen({ tool: 'override_watch_penalty', args, access: deps.access, kind: 'watch_penalty', requester, dry_run: false });
    const r = await wp.override(String(args.penalty_id ?? '').trim(), requester, String(args.reason ?? ''));
    await auditClose(audit, { outcome: r.ok ? 'applied' : 'refused', detail: String(r.ok ? r.overridden ?? 'unchanged' : r.reason) });
    return { ...r, audit_id: audit };
  },
};

export const WATCH_PENALTY_READ_TOOLS: ToolDefinition[] = [readWatchPenalties];
export const WATCH_PENALTY_WRITE_TOOLS: ToolDefinition[] = [switchWatchPenalty, overrideWatchPenalty];
