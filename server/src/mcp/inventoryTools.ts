/**
 * `record_agent_inventory` (2 Oct 2026, Destiny — Agent Upgrade Plan step 5.2,
 * governance). Write connection only, not in any agent's scope: a person's
 * tool, used after reading an agent with the n8n MCP's `get_agent`. The whole
 * result is handed over and the server derives the row and the autonomy tier
 * (see agentInventory.ts); nothing about an agent is typed in. Audited on
 * engine_mcp_writes like every other write; the arguments column keeps the
 * config hash and the agent id, not the 100 KB of config.
 */
import * as inventory from '../agentInventory';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const recordAgentInventory: ToolDefinition = {
  name: 'record_agent_inventory',
  description:
    'Record one n8n Agent in the agent inventory from its live config. Pass `agent`: the whole result of the n8n MCP tool get_agent (agent, config, configHash, skills, tasks). The server keeps what describes the agent — model, every tool and whether it can write, MCP scope and approvals, where its dashboard token travels (header or URL path), skills, scheduled tasks, sub-agents, memory, the credential ids it references — drops the instruction text, and derives the autonomy tier in code: T0 read only, T1 writes all behind approval, T2 writes on request, T3 scheduled and writes. Upserts on the agent id; returns the derived row and whether it was inserted, updated or unchanged (same config hash, tools, MCP scope and tasks). The Agent maturity page shows the inventory and marks a row stale after 7 days. dry_run returns the derived row without writing.',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'object', description: 'The get_agent result, as returned: { agent: {id, name, published, activeVersionId, …}, config: {…}, configHash, skills: {…}, tasks: […] }.' },
      owner: { type: 'string', description: 'Who owns the agent (a person). Kept from the last record when omitted.' },
      dry_run: { type: 'boolean', description: 'Derive the row and return it without writing.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person recording, for the audit line.' },
    },
    required: ['agent'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Record an agent in the inventory' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const dry = args.dry_run === true;
    const result = args.agent && typeof args.agent === 'object' && !Array.isArray(args.agent) ? (args.agent as Record<string, unknown>) : null;
    const agentMeta = result && result.agent && typeof result.agent === 'object' ? (result.agent as Record<string, unknown>) : {};
    // The audit keeps the identity and the hash, never the whole config.
    const auditArgs = { agent_id: agentMeta.id ?? null, agent_name: agentMeta.name ?? null, config_hash: result?.configHash ?? null, owner: args.owner ?? null, dry_run: dry };
    const audit = await auditOpen({ tool: 'record_agent_inventory', args: auditArgs, access: deps.access, kind: 'agent_inventory', requester, dry_run: dry });
    if (!result) {
      await auditClose(audit, { outcome: 'refused', detail: 'agent must be the get_agent result object' });
      return { ok: false, reason: 'bad_argument', message: 'Pass agent as the whole get_agent result object.', audit_id: audit };
    }
    const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : null;
    const recordedBy = `mcp:${deps.access}${requester ? ` (${requester})` : ''}`;
    try {
      if (dry) {
        const d = inventory.derive(result, { owner, recordedBy });
        const { raw: _raw, ...row } = d;
        await auditClose(audit, { outcome: 'dry_run', detail: `${row.name}: ${row.autonomy_tier}`, natural_id: row.agent_id, after: row });
        return { ok: true, dry_run: true, row, audit_id: audit };
      }
      const { row, outcome } = await inventory.record(result, { owner, recordedBy });
      const { raw: _raw, ...shown } = row as typeof row & { raw?: unknown };
      await auditClose(audit, { outcome: 'applied', detail: `${outcome}: ${row.name} — ${row.autonomy_tier}`, natural_id: row.agent_id, after: shown });
      return { ok: true, outcome, row: shown, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'refused', detail: message });
      return { ok: false, reason: 'bad_argument', message, audit_id: audit };
    }
  },
};

export const INVENTORY_WRITE_TOOLS: ToolDefinition[] = [recordAgentInventory];
