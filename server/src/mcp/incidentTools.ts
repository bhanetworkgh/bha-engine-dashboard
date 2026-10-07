/**
 * Close ledger incidents over MCP (1 Oct 2026, Destiny).
 *
 *   close_incidents — write connection only. The Engine health page's own
 *                     close (health.closeIncidents, the same function the
 *                     button calls): each incident is closed in the BHARAG
 *                     ledger first, with its own lane key, as manually
 *                     resolved, and marked closed here only once the ledger
 *                     has accepted it. A refusal comes back per incident with
 *                     BHARAG's own reason.
 *
 * Built because three test incidents from the Monitoring Twin simulator could
 * only be closed by a person clicking the page. The page's guard is kept: the
 * caller must state how many it is closing (`confirm: "CLOSE <n>"`), and a
 * call without it, or with `dry_run`, changes nothing and says what would
 * happen. Every call is audited on engine_mcp_writes, refused and dry-run
 * ones included, like every other write tool.
 */
import { query } from '../pg';
import * as health from '../health';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const MAX = 50;

export const closeIncidentsTool: ToolDefinition = {
  name: 'close_incidents',
  description:
    'Close open incidents in the BHARAG incident ledger as manually resolved — the Engine health page\'s own close, through the same function. ids: the incident ids as the page lists them (e.g. INC-BAYS.AGENT-038), at most 50. reason: why they are being closed (required, kept on the audit line). confirm: exactly "CLOSE <n>" where n is the number of ids; without it, or with dry_run true, nothing is changed and the answer says what each id would do (already closed, not held, or would close). Each incident is closed in the ledger first with its own lane key, and marked closed on the dashboard only once the ledger accepts; a refusal comes back per id with BHARAG\'s reason. Returns {closed, failed, skipped, results, note}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Incident ids, e.g. ["INC-BAYS.AGENT-038"].' },
      reason: { type: 'string', description: 'Why these are being closed, e.g. "test noise from the Monitoring Twin simulator".' },
      confirm: { type: 'string', description: 'Exactly "CLOSE <n>", n the number of ids.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking, for the audit line.' },
      dry_run: { type: 'boolean' },
    },
    required: ['ids', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true, title: 'Close ledger incidents' },
  handler: async (args, deps) => {
    const ids = Array.isArray(args.ids) ? [...new Set(args.ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))] : [];
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const confirmed = typeof args.confirm === 'string' && args.confirm.trim() === `CLOSE ${ids.length}`;
    const dry = args.dry_run === true || !confirmed;
    const audit = await auditOpen({ tool: 'close_incidents', args, access: deps.access, kind: 'incidents', requester, dry_run: dry });

    if (!ids.length || ids.length > MAX || reason.length < 3) {
      const message = !ids.length ? 'Send ids: the incident ids to close.' : ids.length > MAX ? `${ids.length} ids is more than the ${MAX} this closes at once.` : 'Send a reason (at least 3 characters).';
      await auditClose(audit, { outcome: 'refused', detail: message });
      return { ok: false, reason: 'bad_argument', message, audit_id: audit };
    }

    if (dry) {
      const held = await query<{ natural_id: string; lane_id: string | null; open_now: boolean | null; status: string | null; wf: string | null }>(
        `SELECT natural_id, lane_id, open_now, fields->>'resolution_status' AS status, fields->'payload'->>'workflow_or_scenario' AS wf
           FROM engine_incidents WHERE natural_id = ANY($1::text[])`,
        [ids],
      );
      const by = new Map(held.rows.map((r) => [r.natural_id, r]));
      const preview = ids.map((id) => {
        const r = by.get(id);
        if (!r) return { id, would: 'skip', why: 'not held on this dashboard' };
        if (r.open_now === false || (r.status && r.status !== 'open' && r.status !== 'retrying')) return { id, would: 'skip', why: `already closed (${r.status ?? 'closed'})` };
        return { id, would: 'close', lane: r.lane_id, status: r.status, workflow: r.wf };
      });
      const note = confirmed ? 'dry_run: nothing changed.' : `Nothing changed. To close, call again with confirm "CLOSE ${ids.length}".`;
      await auditClose(audit, { outcome: 'dry_run', detail: `${preview.filter((p) => p.would === 'close').length} of ${ids.length} would close`, after: preview });
      return { ok: true, dry_run: true, preview, note, audit_id: audit };
    }

    try {
      const actor = `mcp:${deps.access}${requester ? ` (${requester})` : ''} — ${reason}`;
      const r = await health.closeIncidents(ids, actor);
      const outcome = r.failed ? (r.closed ? 'partial' : 'failed') : 'applied';
      await auditClose(audit, { outcome, detail: r.note.slice(0, 500), natural_id: ids.join(',').slice(0, 200), after: r.results });
      return { ok: r.failed === 0, ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, audit_id: audit };
    }
  },
};

/**
 * Retry now over MCP (7 Oct 2026, Destiny — LOOP-1791322278282-DC07).
 *
 *   retry_incident — write connection only. The Retries tab's own Retry now
 *                    (health.retryNow, the function the button calls): the
 *                    same cap of three, the same refusal without an execution
 *                    id, the same POST to the healer webhook with the server's
 *                    key. It hands the retry to the healer; whether the run
 *                    recovered is written to retry_attempts by the healer.
 */
export const retryIncidentTool: ToolDefinition = {
  name: 'retry_incident',
  description:
    'Retry now for one incident — the Engine health Retries tab\'s own button, through the same function. incident_id: the id as the Retries tab lists it (e.g. INC-BAYS.AGENT-038). reason: why it is being retried (required, kept on the audit line). Refused, changing nothing, when no retry row is held for the incident, when it has used all three attempts, or when the row carries no execution id. dry_run true calls nothing and answers what the row holds and whether a retry would be sent. On success the retry has been handed to the healer, not proven: the healer writes the result (Recovered or Exhausted) to retry_attempts, so read that row afterwards. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      incident_id: { type: 'string', description: 'The incident id, e.g. "INC-BAYS.AGENT-038".' },
      reason: { type: 'string', description: 'Why it is being retried.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking, for the audit line.' },
      dry_run: { type: 'boolean' },
    },
    required: ['incident_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Retry an incident now' },
  handler: async (args, deps) => {
    const id = typeof args.incident_id === 'string' ? args.incident_id.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'retry_incident', args, access: deps.access, kind: 'incidents', requester, dry_run: dry });

    if (!id || reason.length < 3) {
      const message = !id ? 'Send incident_id.' : 'Send a reason (at least 3 characters).';
      await auditClose(audit, { outcome: 'refused', detail: message });
      return { ok: false, reason: 'bad_argument', message, audit_id: audit };
    }

    try {
      if (dry) {
        const held = (await health.retries()).find((r) => r.incident_id === id);
        const would = !held ? 'refuse' : (held.attempts ?? 0) >= 3 ? 'refuse' : !held.execution_id ? 'refuse' : 'retry';
        const why = !held ? 'no retry row is held for this incident' : (held.attempts ?? 0) >= 3 ? 'all three attempts are used' : !held.execution_id ? 'the row carries no execution id' : null;
        const row = held ? { status: held.status, attempts: held.attempts ?? 0, execution_id: held.execution_id, workflow: held.workflow, failed_node: held.failed_node, lane: held.lane } : null;
        await auditClose(audit, { outcome: 'dry_run', detail: `would ${would}${why ? `: ${why}` : ''}`, natural_id: id, after: row });
        return { ok: true, dry_run: true, incident_id: id, would, why, row, note: 'dry_run: nothing was sent to the healer.', audit_id: audit };
      }
      const actor = `mcp:${deps.access}${requester ? ` (${requester})` : ''} — ${reason}`;
      const r = await health.retryNow(id, actor);
      await auditClose(audit, { outcome: r.ok ? 'applied' : 'refused', detail: r.message.slice(0, 500), natural_id: id, after: r });
      return { ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, audit_id: audit };
    }
  },
};

export const INCIDENT_WRITE_TOOLS: ToolDefinition[] = [closeIncidentsTool, retryIncidentTool];
