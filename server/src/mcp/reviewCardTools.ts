/**
 * `rewrite_approved_card` (11 Nov 2026, Destiny): an approved log's review card rewritten to say whose log it
 * was, the session, when, and who approved it (../reviewCard.ts markApproved, the function Submit Actions calls
 * at the Approve click). For cards approved before that went in. Write connection, no agent's scope, refused on
 * any agent token, Destiny or Jason. Audited on engine_mcp_writes, kind codex.
 */
import * as reviewCard from '../reviewCard';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const ADMINS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
const str = (a: Record<string, unknown>, k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');

export const rewriteApprovedCard: ToolDefinition = {
  name: 'rewrite_approved_card',
  description: "Rewrite an approved log's review card in Jason's review channel so it says whose log it was: builder and approver tagged, the session title and link, the session date, when it was approved, and its Submission or Codex ID. The same card Approve now draws. For cards approved before 11 Nov 2026's fix. The card is found from the log's Review Card Channel and TS. approver_user_id is who approved it (the pay note's decided_by). dry_run builds it and sends nothing. HELD HERE: Destiny or Jason; refused on any agent token. Audited.",
  inputSchema: {
    type: 'object',
    properties: {
      submission_id: { type: 'string' },
      approver_user_id: { type: 'string' },
      approved_at: { type: 'string', description: 'ISO time; defaults to the row\'s Jason Reviewed At.' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['submission_id', 'approver_user_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: "Rewrite an approved log's review card" },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id');
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'rewrite_approved_card', args, access: deps.access, kind: 'codex', requester: requester || null, dry_run: dry });
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message: `${message} Nothing was changed.`, audit_id: audit };
    };
    if (deps.agent) return refuse('agent_not_permitted', `An agent (${deps.agent}) may not rewrite a review card.`);
    if (!ADMINS.has(requester)) return refuse('not_permitted', 'Only Destiny or Jason may rewrite a review card.');
    try {
      const r = await reviewCard.markApproved({ submission_id: args.submission_id, approver_user_id: args.approver_user_id, approved_at: args.approved_at, dry_run: dry });
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'updated', detail: `${r.submission_id}: ${dry ? 'would rewrite' : 'rewrote'} its card as approved`, natural_id: String(r.submission_id) });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof reviewCard.CardError) return refuse(e.reason, e.message);
      await auditClose(audit, { outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
};

export const REVIEW_CARD_WRITE_TOOLS: ToolDefinition[] = [rewriteApprovedCard];
