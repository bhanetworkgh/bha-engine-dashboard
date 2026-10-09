/**
 * The vFarm stage gates and 5-rack offer over MCP (2026-10-09, Destiny —
 * LOOP-1791479575963-7S0O). The store, the two hard gates, the events and the
 * alerts are all in ../vfarmGates.ts; these tools only carry a call to it.
 *
 *   `get_vfarm_gates`             — read. Every record, the last events, and which checks a person records.
 *   `write_vfarm_gate`            — create or update one record. Refused, with nothing written, when the
 *                                   contract or the order says no.
 *   `delete_vfarm_gate_fixtures`  — removes test fixtures and nothing else.
 *
 * Every write call is on engine_mcp_writes, kind vfarm_gates, refused ones included.
 */
import * as gates from '../vfarmGates';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const bare = (v: string) => v.replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

export const getVfarmGates: ToolDefinition = {
  name: 'get_vfarm_gates',
  description:
    'Read the vFarm stage gates and the 5-rack pilot offer: every VFARM_STAGE1_LAB_VALIDATION_v1, VFARM_STAGE2_PILOT_CHECKLIST_v1 and VFARM_5RACK_PILOT_OFFER_v1 record with its status, its four checks (who checked, when, manual or sensor), the Early Access leads tied to each offer, and the latest VFARM_* events. Use it to answer "where does Stage 1 stand", "can Stage 2 start", "is the offer tied to a pilot". Rows with fixture: true are test records, never real state: say so or leave them out. Three checks (root-zone moisture, airflow velocity, early disease detection) are recorded by a person, not a sensor; never describe them as automated detection. Returns {stage1, stage2, offers, fixtures, checks, gates, events, note}.',
  inputSchema: {
    type: 'object',
    properties: { events: { type: 'number', description: 'How many of the latest events to include. Default 20, at most 500.' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the vFarm stage gates and pilot offer' },
  handler: async (args) => ({ ok: true, ...(await gates.gates({ events: typeof args.events === 'number' ? args.events : 20 })) }),
};

export const writeVfarmGate: ToolDefinition = {
  name: 'write_vfarm_gate',
  description:
    'Create or update ONE vFarm gate record. kind: "stage1" (VFARM_STAGE1_LAB_VALIDATION_v1), "stage2" (VFARM_STAGE2_PILOT_CHECKLIST_v1) or "offer" (VFARM_5RACK_PILOT_OFFER_v1). Leave object_id out to create; send it to update (only the fields you send change; null clears one). fields uses the v1 contract\'s own names, status included; a name the contract does not have is refused (unknown_field). THE ORDER IS ENFORCED HERE AND CANNOT BE OVERRIDDEN: a stage2 needs stage1_ref and stays "planned" until that Stage 1 is "passed" (stage1_not_passed); an offer cannot be "offered" or "signed" without stage2_ref to a Stage 2 record (stage2_required). A check is {status: pending|passed|failed, thresholds, notes, value, source: manual|sensor, checked_by, checked_at, evidence_ref}; source "sensor" is refused for root_zone_moisture_check, airflow_velocity_check and early_disease_detection_check (no_sensor_yet). An offer\'s linked_lead_ids ties Early Access leads to it (lead id or buyer_intake_id); only clear 5-rack or pilot enquiries, never a home sign-up. Every change writes a structured event (VFARM_STAGE1_STATE_CHANGED, VFARM_STAGE2_STATE_CHANGED, VFARM_CHECK_UPDATED, VFARM_OFFER_STATE_CHANGED) and a status change or a failed check posts a Slack alert. Gates, thresholds and prices are Jason\'s: write only what a person gave you, never a value you worked out. A refusal writes nothing: report its message as it is. If the answer carries raise: true an alert did not go out: say so. Returns {ok, written, record, status_change, checks_updated, events, alerts, message}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['stage1', 'stage2', 'offer'] },
      object_id: { type: 'string', description: 'The record to update, e.g. VFS1-1791500000000-AB12. Leave out to create a new record.' },
      fields: {
        type: 'object',
        description: `The contract's fields by their own names. stage1: ${gates.fieldNames('stage1').join(', ')}. stage2: ${gates.fieldNames('stage2').join(', ')}. offer: ${gates.fieldNames('offer').join(', ')}.`,
      },
      fixture: { type: 'boolean', description: 'On create only: true marks a TEST record. It is labelled everywhere and can be deleted. Never set it on a real record.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person making the change. Required: every change names its author.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would be written, without writing, sending an event or posting an alert.' },
    },
    required: ['kind', 'fields', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Create or update a vFarm gate record' },
  handler: async (args, deps) => {
    const requester = bare(str(args, 'requester_user_id')) || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'write_vfarm_gate', args, access: deps.access, kind: 'vfarm_gates', requester, dry_run: dry });
    try {
      const r = await gates.writeGate({
        kind: str(args, 'kind'),
        object_id: str(args, 'object_id') || null,
        fields: (args.fields ?? {}) as Record<string, unknown>,
        fixture: typeof args.fixture === 'boolean' ? args.fixture : undefined,
        by: requester ?? '',
        via: `mcp${deps.agent ? `:${deps.agent}` : ''}`,
        dry_run: dry,
      });
      await auditClose(audit, {
        outcome: dry ? 'dry_run' : !r.written ? 'unchanged' : r.raise ? 'written_alert_failed' : r.created ? 'inserted' : 'updated',
        detail: r.message,
        natural_id: r.created && dry ? null : r.record.id,
        after: r.record,
        guard_result: { status_change: r.status_change, events: r.events, alerts: r.alerts },
      });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof gates.GateRefused) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, natural_id: str(args, 'object_id') || null, guard_result: { reason: e.reason, ...e.extra } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was written.`, ...e.extra, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was written.`, raise: true, audit_id: audit };
    }
  },
};

export const deleteVfarmGateFixtures: ToolDefinition = {
  name: 'delete_vfarm_gate_fixtures',
  description:
    'Delete every vFarm gate record marked as a test fixture, and nothing else: a real record cannot be removed by this tool. For cleaning up after a proof run so the Gates page starts clean. The events the fixtures produced stay in engine_events, marked fixture: true. Without confirm: true it deletes nothing and lists what it would remove. Returns {ok, deleted}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'true to delete. Without it nothing is removed.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking.' },
    },
    required: ['requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: 'Delete vFarm gate test fixtures' },
  handler: async (args, deps) => {
    const requester = bare(str(args, 'requester_user_id')) || null;
    const go = args.confirm === true;
    const audit = await auditOpen({ tool: 'delete_vfarm_gate_fixtures', args, access: deps.access, kind: 'vfarm_gates', requester, dry_run: !go });
    try {
      if (!go) {
        const all = await gates.gates({ events: 0 });
        const would = [...all.stage1, ...all.stage2, ...all.offers].filter((r) => r.fixture).map((r) => r.id);
        await auditClose(audit, { outcome: 'dry_run', detail: `${would.length} fixture(s) would be deleted` });
        return { ok: true, deleted: [], would_delete: would, message: 'Nothing was deleted. Send confirm: true to remove these.', audit_id: audit };
      }
      const r = await gates.deleteFixtures();
      await auditClose(audit, { outcome: 'deleted', detail: `${r.deleted.length} fixture(s): ${r.deleted.join(', ') || 'none'}`, before: r.deleted });
      return { ok: true, ...r, message: `${r.deleted.length} fixture record${r.deleted.length === 1 ? '' : 's'} deleted. Real records were not touched.`, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const VFARM_GATE_READ_TOOLS: ToolDefinition[] = [getVfarmGates];
export const VFARM_GATE_WRITE_TOOLS: ToolDefinition[] = [writeVfarmGate, deleteVfarmGateFixtures];
