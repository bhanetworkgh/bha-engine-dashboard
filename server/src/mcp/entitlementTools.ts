/**
 * vFarm entitlement over MCP (31 Oct 2026, Destiny — Jason's contract in
 * #bha-coordination 1793375674.351769). One function each, the same ones the
 * `GET /api/engine/vfarm-entitlement` route vFarm reads calls.
 *
 *   read_vfarm_entitlement — read only, both connections: one farm's record as
 *                            vFarm sees it.
 *   set_vfarm_entitlement  — write connection, in no agent's scope: Destiny or
 *                            Jason create or change one farm's record. Audited on
 *                            engine_mcp_writes (kind vfarm_entitlement).
 */
import * as ent from '../vfarmEntitlement';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const readVfarmEntitlementTool: ToolDefinition = {
  name: 'read_vfarm_entitlement',
  description:
    `One vFarm farm's entitlement as vFarm reads it from the Engine (${ent.ENTITLEMENT_CONTRACT}): plan, status, start_at, renew_at, farm_id, pilot, limits (racks, devices, users) and the record id. The Engine record is the only writer. plan comes only from Jason's approved offer and is null until one names it; status is the newest VFARM_SUBSCRIBER_STATE_CHANGED for the farm, pending when none is recorded (no trial). A null limit is "not set". found: false means no record: vFarm derives Monitor / pending, the floor. Read only.`,
  inputSchema: {
    type: 'object',
    properties: { farm_id: { type: 'string', description: 'The vFarm farm id, the one the snapshot carries.' } },
    required: ['farm_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read a vFarm farm\'s entitlement' },
  handler: async (args) => {
    try {
      return { ok: true, ...(await ent.read(args.farm_id)) };
    } catch (e) {
      if (e instanceof ent.EntitlementError) return { ok: false, reason: e.reason, message: e.message };
      throw e;
    }
  },
};

export const setVfarmEntitlementTool: ToolDefinition = {
  name: 'set_vfarm_entitlement',
  description:
    `Create or change one vFarm farm's entitlement record, the only writer of what vFarm switches on. Destiny or Jason only (requester_user_id). farm_id: a farm vFarm has sent in a snapshot. buyer_intake_id: the paying customer, a real lead at Stage 5 or a team test lead (marked test). plan with offer_id: accepted only when it is the plan named in the conditions of Jason's newest approved offer; plan: null clears it. pilot (boolean), start_at, renew_at (ISO), limits { racks, devices, users } (whole numbers, null for "not set"). A field not sent keeps what the record holds. Refused, nothing written: unknown farm or lead, not a customer, farm linked to another lead, no approved offer, plan not on the offer. dry_run says what would be written. One vfarm_entitlement_set event per write. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      farm_id: { type: 'string' },
      buyer_intake_id: { type: 'string' },
      requester_user_id: { type: 'string', description: 'Slack id of the person setting it: Destiny or Jason.' },
      plan: { type: ['string', 'null'], description: "The plan named on Jason's approved offer; null clears it." },
      offer_id: { type: 'string', description: 'The approved offer the plan comes from. Required with a plan.' },
      pilot: { type: 'boolean' },
      start_at: { type: ['string', 'null'] },
      renew_at: { type: ['string', 'null'] },
      limits: { type: ['object', 'null'], description: '{ racks, devices, users }: whole numbers, null for "not set".' },
      dry_run: { type: 'boolean' },
    },
    required: ['farm_id', 'buyer_intake_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Set a vFarm farm\'s entitlement' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const farm = typeof args.farm_id === 'string' ? args.farm_id.trim() : null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'set_vfarm_entitlement', args, access: deps.access, kind: 'vfarm_entitlement', requester, dry_run: dry });
    try {
      const r = await ent.set({ ...args, dry_run: dry } as ent.SetInput);
      const rid = r.written ? r.entitlement?.record_id ?? null : (r.would_write as { record_id?: string } | undefined)?.record_id ?? null;
      await auditClose(audit, { outcome: dry ? 'dry_run' : r.created ? 'created' : 'updated', detail: `${dry ? 'would set' : 'set'} the entitlement for farm ${farm}`, record_id: rid, natural_id: farm, before: r.before, after: r.written ? r.entitlement : r.would_write });
      return { ...r, audit_id: audit };
    } catch (e) {
      const refusal = e instanceof ent.EntitlementError;
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: refusal ? 'refused' : 'failed', detail: message, natural_id: farm, guard_result: refusal ? { reason: (e as ent.EntitlementError).reason } : null });
      return { ok: false, written: false, reason: refusal ? (e as ent.EntitlementError).reason : 'error', message: `${message}${refusal ? '' : ' Nothing was written.'}`, ...(refusal ? {} : { raise: true }), audit_id: audit };
    }
  },
};

export const ENTITLEMENT_READ_TOOLS: ToolDefinition[] = [readVfarmEntitlementTool];
export const ENTITLEMENT_WRITE_TOOLS: ToolDefinition[] = [setVfarmEntitlementTool];
