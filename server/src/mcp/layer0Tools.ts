/**
 * Void a parked log over MCP (2026-10-25, Destiny).
 *
 *   void_parked_log — write connection, in Bays' scope, so Bays can void one
 *                     when the builder, Jason or Destiny asks in a thread. The
 *                     same function as n8n's Void this log button
 *                     (layer0Void.voidLog): the builder, Jason or Destiny, a
 *                     reason, a parked log that is not completed. Audited on
 *                     engine_mcp_writes, refused and dry-run calls included.
 */
import * as layer0Void from '../layer0Void';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const voidParkedLogTool: ToolDefinition = {
  name: 'void_parked_log',
  description:
    "Void one parked log (a Layer 0 row the completeness check is holding for its builder) that will never be completed, for example because the builder sent the corrected log again as a new submission and that one went through. Only the builder who sent it, Jason (U0A9V97949F) or Destiny (U0AEW3TBYH1) can, and a reason is required. requester_user_id is the Slack id of the person who asked, never Bays'. Refused for a parked log already completed or already voided. The log is marked voided with who, when, why and what replaced it, stays on record (nothing is deleted), gets no more reminders, can no longer be completed, and no engine write can change it. A reply goes in its \"Log parked\" thread in #bha-log-reviews, and the builder is told in their log channel when someone else voided it. log: the row id (the number the \"Log parked\" post prints) or its Submission ID. replaced_by: the Submission ID of the newer log, when there is one; left out, the one Codex log for the same builder and recording is used. Before telling anyone there is no newer submission, call this with dry_run: same_recording_in_codex lists the Codex logs for the same recording. Returns {ok, voided, row_id, submission_id, replaced_by, posts, …}; ok is false when a Slack post did not land.",
  inputSchema: {
    type: 'object',
    properties: {
      log: { type: 'string', description: 'The parked row id (e.g. 18) or its Submission ID (e.g. U0AD1V1D65N_1792899251114).' },
      requester_user_id: { type: 'string', description: 'Slack id of the person voiding it: the builder, Jason or Destiny.' },
      reason: { type: 'string', description: 'Why it is voided, 3 to 1,000 characters. Kept on the log and shown in the review thread.' },
      replaced_by: { type: 'string', description: 'Submission ID of the Codex log that replaces it, if any.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would happen, including the Codex logs for the same recording, without voiding.' },
    },
    required: ['log', 'requester_user_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Void a parked log' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'void_parked_log', args, access: deps.access, kind: 'layer0', requester, dry_run: dry });
    try {
      const r = await layer0Void.voidLog({
        ref: typeof args.log === 'string' ? args.log : '',
        requester_user_id: requester,
        reason: typeof args.reason === 'string' ? args.reason : null,
        replaced_by: typeof args.replaced_by === 'string' ? args.replaced_by : null,
        dry_run: dry,
        actor: `mcp:${deps.access}${requester ? `:${requester}` : ''}`,
      });
      await auditClose(audit, {
        outcome: dry ? 'dry_run' : r.ok ? 'applied' : 'applied_with_errors',
        detail: 'message' in r && r.message ? String(r.message) : dry ? 'dry run' : `voided by ${r.voided_by}`,
        record_id: r.row_id,
        natural_id: r.submission_id,
        after: r,
      });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof layer0Void.VoidError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason } });
        return { ok: false, voided: false, reason: e.reason, message: `${e.message} Nothing was changed.`, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
};

export const LAYER0_WRITE_TOOLS: ToolDefinition[] = [voidParkedLogTool];
