/**
 * The missing Codex log check on demand (2026-10-22, DW-9EP8). ../codexGap.ts holds the rule and
 * runs it every hour; this runs the same check now. Write connection, no agent's scope.
 */
import * as gap from '../codexGap';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const runCodexGapCheck: ToolDefinition = {
  name: 'run_codex_gap_check',
  description: `Run the missing Codex log check now. A builder who logged on ${gap.RULE.regular_days} or more of the last ${gap.RULE.lookback_days} days and has no submission in the engine for ${gap.RULE.gap_hours} hours gets one DM as Bays, and Destiny a one-line copy; one note per gap, never repeated. dry_run defaults to true and lists who would be flagged, sending nothing. Returns {checked, gaps[{user_id, last_log_at, hours_since, outcome}]}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean', description: 'Default true: list only, send nothing.' },
      requester_user_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Missing Codex log check' },
  handler: async (args, deps) => {
    const dry = args.dry_run !== false;
    const audit = await auditOpen({ tool: 'run_codex_gap_check', args, access: deps.access, kind: 'codex_gap', requester: typeof args.requester_user_id === 'string' ? args.requester_user_id : null, dry_run: dry });
    if (deps.agent) {
      await auditClose(audit, { outcome: 'refused', detail: 'agent_not_permitted' });
      return { ok: false, reason: 'agent_not_permitted', message: 'This check is run by a person or by its own timer.' };
    }
    try {
      const r = await gap.check({ dry_run: dry });
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'inserted', detail: `${r.checked} checked; ${r.gaps.map((g) => `${g.user_id} ${g.outcome}`).join(', ') || 'no gaps'}` });
      return { ok: true, dry_run: dry, rule: gap.RULE, ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const CODEX_GAP_WRITE_TOOLS: ToolDefinition[] = [runCodexGapCheck];
