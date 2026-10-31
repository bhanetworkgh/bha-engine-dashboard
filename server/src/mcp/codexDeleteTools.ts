/**
 * Delete a Codex log over MCP, approved ones included (31 Oct 2026, Destiny:
 * "add a tool that lets you do that now ... I like orchestrating").
 *
 *   delete_codex_log — write connection only, in no agent's scope, refused on
 *                      any agent token. The Codex page's typed-id delete,
 *                      through the same function (store.deleteCodex): the
 *                      whole row goes to record_deletions first. Built for test
 *                      logs that reached approval (Q2VC's test log B), which
 *                      delete_record refuses because they carry a Codex Entry ID.
 *
 * Two things it adds to the page's delete. The log's pay rows (engine_pay_sessions
 * with the same Codex Entry ID) go with it, each copied to record_deletions, so a
 * deleted log never stays on the pay record as owed. And it refuses a log any of
 * whose pay rows say Paid: money that went out is never deleted from the record.
 * Destiny or Jason only, a written reason, and confirm "DELETE <Codex Entry ID>"
 * (the Submission ID for a log with no Codex Entry ID). dry_run says what would go.
 * Audited on engine_mcp_writes (kind codex).
 */
import { query } from '../pg';
import * as mirror from '../mirror';
import * as store from '../store';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const ALLOWED = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);

interface CodexRow { id: string; natural_id: string | null; codex_id: string | null; submission_id: string | null; status: string | null; builder: string | null; session: string | null }
interface PayRow { id: string; paid: string | null }

function isPaid(v: string | null): boolean {
  return typeof v === 'string' && ['yes', 'true'].includes(v.trim().toLowerCase());
}

export const deleteCodexLogTool: ToolDefinition = {
  name: 'delete_codex_log',
  description:
    'Hard-delete one Codex log, approved ones included, with its pay rows: the Codex page\'s typed-id delete, for test logs and duplicates delete_record refuses. Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) only, never an agent. log: the Codex Entry ID, Submission ID or row id. confirm must be exactly "DELETE <Codex Entry ID>" (the Submission ID when the log has no Codex Entry ID). reason: why, 3 to 1,000 characters. Refused when any pay row for the log is marked Paid, or when the log matches more than one row. The whole row and every pay row are copied to record_deletions before they go. dry_run: say what would be deleted. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      log: { type: 'string', description: 'Codex Entry ID, Submission ID or row id (e.g. 408).' },
      requester_user_id: { type: 'string', description: 'Slack id of the person deleting: Destiny or Jason.' },
      confirm: { type: 'string', description: 'Exactly "DELETE <Codex Entry ID>", or "DELETE <Submission ID>" for a log with no Codex Entry ID.' },
      reason: { type: 'string', description: 'Why it is deleted, 3 to 1,000 characters.' },
      dry_run: { type: 'boolean' },
    },
    required: ['log', 'requester_user_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'Delete a Codex log and its pay rows' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : '';
    const log = typeof args.log === 'string' ? args.log.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    const confirm = typeof args.confirm === 'string' ? args.confirm.trim() : '';
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'delete_codex_log', args, access: deps.access, kind: 'codex', requester: requester || null, dry_run: dry });
    const refuse = async (r: string, message: string, extra: Record<string, unknown> = {}) => {
      await auditClose(audit, { outcome: 'refused', detail: message, natural_id: log || null, guard_result: { reason: r } });
      return { ok: false, deleted: false, reason: r, message, ...extra, audit_id: audit };
    };

    if (deps.agent) return refuse('agent_not_permitted', `An agent (${deps.agent}) may not delete a Codex log: Destiny or Jason does, through the connector.`);
    if (!ALLOWED.has(requester)) return refuse('not_permitted', 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) can delete a Codex log.');
    if (!log) return refuse('log_required', 'Name the log: its Codex Entry ID, Submission ID or row id.');
    if (reason.length < 3 || reason.length > 1000) return refuse('reason_required', 'A reason of 3 to 1,000 characters is required.');

    const rowId = /^(?:row-)?(\d+)$/.exec(log)?.[1] ?? null;
    const found = await query<CodexRow>(
      `SELECT id::text, natural_id, fields->>'Codex Entry ID' AS codex_id, fields->>'Submission ID' AS submission_id,
              fields->>'Jason Status' AS status, fields->>'Builder Name' AS builder, fields->>'Session Description' AS session
         FROM engine_codex_submissions
        WHERE ($1::bigint IS NOT NULL AND id = $1::bigint) OR natural_id = $2 OR fields->>'Codex Entry ID' = $2 OR fields->>'Submission ID' = $2
        ORDER BY id`,
      [rowId, log],
    );
    if (found.rows.length === 0) return refuse('not_found', `No Codex log matches "${log}".`);
    if (found.rows.length > 1) {
      return refuse('ambiguous', `"${log}" matches ${found.rows.length} rows; name one by its row id.`, { rows: found.rows.map((r) => ({ id: r.id, codex_id: r.codex_id, submission_id: r.submission_id })) });
    }
    const row = found.rows[0];
    const identifier = (row.codex_id ?? '').trim() || (row.submission_id ?? '').trim() || (row.natural_id ?? '').trim();
    if (!identifier) return refuse('no_identifier', `Row ${row.id} carries neither a Codex Entry ID nor a Submission ID, so there is nothing to confirm it by.`);

    const pay = row.codex_id
      ? (await query<PayRow>(`SELECT id::text, fields->>'Paid' AS paid FROM engine_pay_sessions WHERE fields->>'Codex Entry ID' = $1 ORDER BY id`, [row.codex_id])).rows
      : [];
    const paid = pay.filter((p) => isPaid(p.paid));
    if (paid.length) {
      return refuse('already_paid', `${identifier} has ${paid.length} pay row(s) marked Paid; money that went out is never deleted from the record.`, { paid_rows: paid.map((p) => p.id) });
    }

    const summary = { row_id: row.id, codex_entry_id: row.codex_id, submission_id: row.submission_id, jason_status: row.status, builder: row.builder, pay_rows: pay.map((p) => p.id) };
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would delete ${identifier} and ${pay.length} pay row(s)`, record_id: `row-${row.id}`, natural_id: identifier, before: summary });
      return { ok: true, deleted: false, dry_run: true, would_delete: summary, confirm_with: `DELETE ${identifier}`, audit_id: audit };
    }
    if (confirm !== `DELETE ${identifier}`) return refuse('confirm_mismatch', `Type "DELETE ${identifier}" exactly to delete this log.`, { confirm_with: `DELETE ${identifier}` });

    const actor = `mcp:${deps.access} (${requester}) — ${reason}`;
    try {
      const r = await store.deleteCodex(`row-${row.id}`, identifier, actor);
      const payDeleted: string[] = [];
      for (const p of pay) {
        const gone = await mirror.deleteRow('pay_sessions', Number(p.id), `Codex log ${identifier} deleted: ${reason}`, actor);
        if (gone) payDeleted.push(p.id);
      }
      const after = { ...summary, codex_removed: r.removed, airtable: r.airtable.state, pay_rows_deleted: payDeleted };
      await auditClose(audit, { outcome: 'deleted', detail: `deleted ${identifier} and ${payDeleted.length} pay row(s)`, record_id: `row-${row.id}`, natural_id: identifier, before: summary, after });
      return { ok: true, deleted: true, ...after, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message, natural_id: identifier });
      return { ok: false, deleted: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const CODEX_DELETE_WRITE_TOOLS: ToolDefinition[] = [deleteCodexLogTool];
