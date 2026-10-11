/**
 * `record_agent_inventory` (2 Oct 2026, Destiny — Agent Upgrade Plan step 5.2,
 * governance). Write connection only, not in any agent's scope: a person's
 * tool, used after reading an agent with the n8n MCP's `get_agent`. The whole
 * result is handed over and the server derives the row and the autonomy tier
 * (see agentInventory.ts); nothing about an agent is typed in. Audited on
 * engine_mcp_writes like every other write; the arguments column keeps the
 * config hash and the agent id, not the 100 KB of config.
 *
 * **11 Oct 2026 (Destiny): the server reads the agent itself.** Pass `agent_id`
 * (an n8n agent id, `bays`, `north_star`, `research_twin`, or `all`) and the
 * config is read from n8n's own MCP server (`n8nMcp.getAgent`) and recorded
 * whole. Handing over the `get_agent` result still works, for when n8n's MCP
 * token is not set. Nothing else about the row, the tier or the publish check
 * changes: both doors end in `inventory.record`.
 */
import * as inventory from '../agentInventory';
import * as n8nMcp from '../n8nMcp';
import { query } from '../pg';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

/** The three engine agents, by the names people use for them. */
export const KNOWN_AGENTS: Readonly<Record<string, string>> = {
  bays: 'Nw5igXu4WWrjUMWB',
  north_star: '8NQRXadH0OrKe5XV',
  research_twin: 'dDtsExaaXhlFd2dv',
};

type Dict = Record<string, unknown>;

/** `all` is the three engine agents plus any agent already held in the inventory. */
async function resolveAgentIds(raw: string): Promise<string[]> {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key !== 'all') return [Object.hasOwn(KNOWN_AGENTS, key) ? KNOWN_AGENTS[key] : raw.trim()];
  const held = await query<{ agent_id: string }>(`SELECT agent_id FROM engine_agent_inventory ORDER BY agent_id`);
  return [...new Set([...Object.values(KNOWN_AGENTS), ...held.rows.map((r) => r.agent_id)])];
}

/** Derive (dry run) or record one get_agent result, with its own audit line. */
async function recordOne(result: Dict | null, opts: { owner: string | null; requester: string | null; dry: boolean; readFrom: 'handed over' | 'n8n MCP'; askedFor?: string; fetchError?: n8nMcp.N8nMcpError | Error | null }, deps: ToolDeps): Promise<Dict> {
  const agentMeta = result && result.agent && typeof result.agent === 'object' ? (result.agent as Dict) : {};
  // The audit keeps the identity and the hash, never the whole config.
  const auditArgs = { agent_id: agentMeta.id ?? opts.askedFor ?? null, agent_name: agentMeta.name ?? null, config_hash: result?.configHash ?? null, owner: opts.owner, dry_run: opts.dry, read_from: opts.readFrom };
  const audit = await auditOpen({ tool: 'record_agent_inventory', args: auditArgs, access: deps.access, kind: 'agent_inventory', requester: opts.requester, dry_run: opts.dry });
  if (opts.fetchError) {
    const e = opts.fetchError;
    const reason = e instanceof n8nMcp.N8nMcpError ? e.reason : 'unreachable';
    await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${e.message}`.slice(0, 500), natural_id: opts.askedFor });
    // Nothing was recorded, and the row held (if any) is exactly as it was.
    return { ok: false, agent_id: opts.askedFor ?? null, reason, message: e.message, recorded: false, audit_id: audit };
  }
  if (!result) {
    await auditClose(audit, { outcome: 'refused', detail: 'agent must be the get_agent result object' });
    return { ok: false, reason: 'bad_argument', message: 'Pass agent_id to have the server read the agent from n8n, or agent as the whole get_agent result object.', audit_id: audit };
  }
  const recordedBy = `mcp:${deps.access}${opts.requester ? ` (${opts.requester})` : ''}${opts.readFrom === 'n8n MCP' ? ', read from n8n by the server' : ''}`;
  try {
    if (opts.dry) {
      const d = inventory.derive(result, { owner: opts.owner, recordedBy });
      const { raw: _raw, ...row } = d;
      await auditClose(audit, { outcome: 'dry_run', detail: `${row.name}: ${row.autonomy_tier}`, natural_id: row.agent_id, after: row });
      return { ok: true, dry_run: true, read_from: opts.readFrom, row, audit_id: audit };
    }
    const { row, outcome } = await inventory.record(result, { owner: opts.owner, recordedBy });
    const { raw: _raw, ...shown } = row as typeof row & { raw?: unknown };
    await auditClose(audit, { outcome: 'applied', detail: `${outcome}: ${row.name} — ${row.autonomy_tier}`, natural_id: row.agent_id, after: shown });
    return { ok: true, outcome, read_from: opts.readFrom, row: shown, audit_id: audit };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'refused', detail: message });
    // A handed-over result that will not derive is the caller's argument; one this server read itself is not.
    return { ok: false, agent_id: opts.askedFor ?? agentMeta.id ?? null, reason: opts.readFrom === 'n8n MCP' ? 'record_failed' : 'bad_argument', message, audit_id: audit };
  }
}

/** A row cut to what a caller recording several agents needs to read. */
function brief(r: Dict): Dict {
  const row = (r.row && typeof r.row === 'object' ? r.row : {}) as Dict;
  if (r.ok !== true) return r;
  return {
    ok: true, agent_id: row.agent_id, name: row.name, outcome: r.outcome ?? (r.dry_run ? 'dry_run' : null), active_version_id: row.active_version_id, config_hash: row.config_hash,
    autonomy_tier: row.autonomy_tier, tools: Array.isArray(row.tools) ? row.tools.length : null, skills: Array.isArray(row.skills) ? row.skills.length : null, tasks: Array.isArray(row.tasks) ? row.tasks.length : null,
    read_at: row.read_at, audit_id: r.audit_id,
  };
}

export const recordAgentInventory: ToolDefinition = {
  name: 'record_agent_inventory',
  description:
    'Record an n8n Agent in the agent inventory from its live config. **Pass `agent_id` and the server reads the agent from n8n itself**: an n8n agent id, or `bays`, `north_star`, `research_twin`, or `all` (those three plus any agent already in the inventory). Nothing has to be carried across by hand. Without the n8n MCP token on the server (N8N_MCP_TOKEN) that answers `not_configured`, and the older way still works: pass `agent`, the whole result of the n8n MCP tool get_agent (agent, config, configHash, skills, tasks). The server keeps what describes the agent — model, every tool and whether it can write, MCP scope and approvals, where its dashboard token travels (header or URL path), skills, scheduled tasks, sub-agents, memory, the credential ids it references — drops the instruction text, and derives the autonomy tier in code: T0 read only, T1 writes all behind approval, T2 writes on request, T3 scheduled and writes. Upserts on the agent id; returns the derived row and whether it was inserted, updated or unchanged (same config hash, tools, MCP scope and tasks). **Recording an agent whose active version changed starts the publish check**, which asks for one eval run about three minutes later. An agent n8n could not be read for is `ok: false` with the reason and its held row is left as it was. With `all` the answer is one short line per agent; ask for one agent to see its whole row. The Agent maturity page shows the inventory and marks a row stale after 7 days. dry_run reads and derives without writing.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Which agent the server should read from n8n: an n8n agent id, or bays, north_star, research_twin, or all.' },
      agent: { type: 'object', description: 'Only when agent_id is not used: the get_agent result, as returned: { agent: {id, name, published, activeVersionId, …}, config: {…}, configHash, skills: {…}, tasks: […] }.' },
      owner: { type: 'string', description: 'Who owns the agent (a person). Kept from the last record when omitted.' },
      dry_run: { type: 'boolean', description: 'Read and derive the row and return it without writing.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person recording, for the audit line.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Record an agent in the inventory' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const dry = args.dry_run === true;
    const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : null;
    const handed = args.agent && typeof args.agent === 'object' && !Array.isArray(args.agent) ? (args.agent as Dict) : null;
    const asked = typeof args.agent_id === 'string' ? args.agent_id.trim() : '';
    if (!asked) return recordOne(handed, { owner, requester, dry, readFrom: 'handed over' }, deps);
    const refuse = async (message: string): Promise<Dict> => {
      const audit = await auditOpen({ tool: 'record_agent_inventory', args: { agent_id: asked, owner, dry_run: dry, read_from: 'n8n MCP' }, access: deps.access, kind: 'agent_inventory', requester, dry_run: dry });
      await auditClose(audit, { outcome: 'refused', detail: message });
      return { ok: false, reason: 'bad_argument', message, audit_id: audit };
    };
    if (handed) return refuse('Pass agent_id or agent, not both: with agent_id the server reads the agent from n8n itself.');

    const ids = await resolveAgentIds(asked);
    // One owner for several agents would re-own every one of them in a single call.
    if (owner && ids.length > 1) return refuse('owner can only be set when one agent is recorded. Record the agents with agent_id "all" and no owner, then set an owner one agent at a time.');
    const results: Dict[] = [];
    // One at a time: each answer is large, and n8n is asked for nothing in parallel.
    for (const id of ids) {
      let result: Dict | null = null;
      let fetchError: Error | null = null;
      try {
        result = await n8nMcp.getAgent(id);
      } catch (e) {
        fetchError = e instanceof Error ? e : new Error(String(e));
      }
      results.push(await recordOne(result, { owner, requester, dry, readFrom: 'n8n MCP', askedFor: id, fetchError }, deps));
      // A missing token or a refused one is the same answer for every agent: say it once.
      if (fetchError instanceof n8nMcp.N8nMcpError && (fetchError.reason === 'not_configured' || fetchError.reason === 'unauthorised')) break;
    }
    if (ids.length === 1) return results[0];
    const failed = results.filter((r) => r.ok !== true);
    return {
      ok: failed.length === 0,
      asked_for: ids.length,
      recorded: results.filter((r) => r.ok === true && !r.dry_run).length,
      failed: failed.length,
      dry_run: dry || undefined,
      agents: results.map(brief),
      note: failed.length ? 'An agent that could not be read was not recorded and its held row is unchanged.' : undefined,
    };
  },
};

export const INVENTORY_WRITE_TOOLS: ToolDefinition[] = [recordAgentInventory];
