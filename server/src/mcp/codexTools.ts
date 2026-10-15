/**
 * Reject a Codex log over MCP (2026-10-15, Destiny).
 *
 *   reject_codex_log — write connection only, in no agent's scope. The Codex
 *                      entry's Reject button, through the same function
 *                      (codexReject.reject): Jason or Destiny, a reason, a log
 *                      that is not approved and not in the Codex; the Slack
 *                      cards rewritten without their buttons and the builder
 *                      told. Audited on engine_mcp_writes, refused and dry-run
 *                      calls included.
 */
import * as codexReject from '../codexReject';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const rejectCodexLogTool: ToolDefinition = {
  name: 'reject_codex_log',
  description:
    "Reject one Codex log that will never be approved (for example one sent back again and again whose work a newer log already covers). Only Jason (U0A9V97949F) or Destiny (U0AEW3TBYH1) can, and a reason is required: the builder is shown it. Refused for a log already Approved or Input Added, already rejected, or that already has a Codex Entry ID. The log is marked Rejected with who, when and why, never goes to the Codex and is never counted for pay, and from then on no engine write can change it. Jason's review card and every sent-back message in the builder's channel are rewritten without their buttons, and the builder gets one reply in the newest. log: the Submission ID, Codex Entry ID or row id. dry_run: say what would happen. Returns {ok, rejected, submission_id, cards, …}; ok is false when a Slack message could not be rewritten.",
  inputSchema: {
    type: 'object',
    properties: {
      log: { type: 'string', description: 'Submission ID (e.g. U0AC6RFNP3P_1791839498033), Codex Entry ID or row id.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person rejecting: Jason or Destiny.' },
      reason: { type: 'string', description: 'Why it is rejected, 3 to 1,000 characters. Shown to the builder.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would happen, without rejecting.' },
    },
    required: ['log', 'requester_user_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Reject a Codex log' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'reject_codex_log', args, access: deps.access, kind: 'codex', requester, dry_run: dry });
    try {
      const r = await codexReject.reject({
        ref: typeof args.log === 'string' ? args.log : '',
        requester_user_id: requester,
        reason: typeof args.reason === 'string' ? args.reason : null,
        dry_run: dry,
        actor: `mcp:${deps.access}${requester ? `:${requester}` : ''}`,
      });
      await auditClose(audit, {
        outcome: dry ? 'dry_run' : r.ok ? 'applied' : 'applied_with_errors',
        detail: 'message' in r && r.message ? String(r.message) : dry ? 'dry run' : `rejected by ${r.rejected_by}`,
        record_id: r.row_id,
        natural_id: r.submission_id,
        after: r,
      });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof codexReject.RejectError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason } });
        return { ok: false, rejected: false, reason: e.reason, message: `${e.message} Nothing was changed.`, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
};

export const CODEX_WRITE_TOOLS: ToolDefinition[] = [rejectCodexLogTool];
