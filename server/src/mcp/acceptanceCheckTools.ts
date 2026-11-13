/**
 * check_acceptance_evidence (13 Nov 2026, Destiny): one record through the single canonical acceptance
 * validator, its references checked against this database, one acceptance_evidence_checked event.
 * ../acceptanceCheck.ts holds the logic. Write connection (it writes an event), no agent's scope,
 * refused on any agent token, Destiny or Jason only. It saves no acceptance record and authorizes nothing.
 */
import * as check from '../acceptanceCheck';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const checkAcceptanceEvidenceTool: ToolDefinition = {
  name: 'check_acceptance_evidence',
  description: `Run one acceptance record through the single canonical acceptance validator (acceptanceEvidence.ts, ${'bha.acceptance_evidence.v2'}) exactly as merged, check its references against this database (the charge-gate decision named by gate_id and its Slack message, approver and recorder; the loop; each EV in the evidence store), and write one ${check.EVENT_TYPE} engine event with the result. The record is the validator's input as it stands: gate_id, loop_id, runtime_verification_status, acceptance_pass, actor_id, approver_id, closure_state, contract_evidence_refs, implementation_evidence_refs, decision_link, and optionally proof_type, run_ref, notes. The same record twice is one event (keyed on its sha256). It saves no acceptance record, is not acceptance_evidence_recorded (reserved for the trusted writer, LOOP-1794326998164-O7CU), and authorizes nothing: acceptance_pass_allowed, eligible_for_persistence and can_charge_live are always false. Destiny or Jason only; dry_run checks and writes nothing. Audited on engine_mcp_writes (kind acceptance).`,
  inputSchema: {
    type: 'object',
    properties: {
      record: { type: 'object', description: 'The acceptance record, as the validator takes it.' },
      requester_user_id: { type: 'string', description: 'Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F).' },
      dry_run: { type: 'boolean', description: 'Check only, write no event.' },
    },
    required: ['record', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Acceptance record check' },
  handler: async (args, deps) => {
    const dry = args.dry_run === true;
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id : null;
    const audit = await auditOpen({ tool: 'check_acceptance_evidence', args, access: deps.access, kind: 'acceptance', requester, dry_run: dry });
    if (deps.agent) {
      await auditClose(audit, { outcome: 'refused', detail: 'agent_not_permitted' });
      return { ok: false, reason: 'agent_not_permitted', message: 'A person runs this check: Destiny or Jason, through the connector.' };
    }
    if (!requester || !ADMIN_IDS.includes(requester)) {
      await auditClose(audit, { outcome: 'refused', detail: 'not_permitted' });
      return { ok: false, reason: 'not_permitted', message: 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) runs the acceptance check.' };
    }
    if (typeof args.record !== 'object' || args.record === null || Array.isArray(args.record)) {
      await auditClose(audit, { outcome: 'refused', detail: 'record_required' });
      return { ok: false, reason: 'record_required', message: 'record is the acceptance record, a JSON object.' };
    }
    try {
      const r = await check.run({ record: args.record, actor: requester, dry_run: dry });
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'inserted', detail: `${r.summary}${r.event_id ? ` event ${r.event_id}${r.duplicate ? ' (already held)' : ''}` : ''}`.slice(0, 900) });
      return { ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const ACCEPTANCE_CHECK_WRITE_TOOLS: ToolDefinition[] = [checkAcceptanceEvidenceTool];
