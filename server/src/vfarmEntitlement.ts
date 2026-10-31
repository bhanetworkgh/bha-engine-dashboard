/**
 * vFarm entitlement: what a farm is entitled to, read by vFarm from the Engine
 * (31 Oct 2026, Destiny — Jason's contract in #bha-coordination 1793375674.351769,
 * thread 1792133001.785759; Jegan's vFarm side of 1793355422.648359).
 *
 * The Engine record is the only writer. vFarm reads it by farm_id on the same key
 * channel the snapshot uses (`x-dashboard-key`), keeps the last good copy with its
 * own fetched_at, and derives every feature from plan + status alone. No vFarm
 * route writes it, and there is no farm-level toggle.
 *
 * The record (`engine_vfarm_entitlements`, migration 106) is one row per farm,
 * linked to the paying-customer lead. Its fields are Jason's list: plan, status,
 * start_at, renew_at, farm_id, the pilot flag, limits (racks, devices, users) and
 * the record id. Three rules hold here, in code, not in a caller's judgement:
 *
 * - **The plan comes from an approved offer.** A plan is accepted only when it is
 *   the `plan` named in the conditions of Jason's newest real approved offer, by
 *   its offer_id. Until such an offer exists, plan stays null, and vFarm reads the
 *   farm as Monitor / pending, the floor Jason set. Nothing names a plan for him.
 * - **Status is the customer events contract's**: the newest
 *   VFARM_SUBSCRIBER_STATE_CHANGED naming this farm_id (pending, active, paused,
 *   cancelled). None recorded is `pending`, and the answer says it was not
 *   recorded. There is no trial.
 * - **The lead is the paying customer**: a real lead at Stage 5, or a team test
 *   lead (an @bhanetwork.org address), whose record is marked test. A limit
 *   nobody has set is null, and vFarm shows "not set" and enforces nothing.
 *
 * A farm with no record answers found: false (200), so vFarm can cache the floor.
 * Every set is one `vfarm_entitlement_set` event in the same transaction.
 */
import { randomBytes } from 'node:crypto';
import { query, withTransaction } from './pg';
import * as engineEvents from './engineEvents';
import * as chargeGate from './chargeGate';
import { ADMIN_IDS } from './writeGuards';
import { TEAM_TEST_SQL } from './earlyAccess';

export const ENTITLEMENT_CONTRACT = 'vfarm.entitlement.v0';
export const STATUSES = ['pending', 'active', 'paused', 'cancelled'] as const;
/** The floor Jason set: a farm with no entitlement record derives Monitor, pending. vFarm applies it. */
export const FLOOR = { plan: 'Monitor', status: 'pending' } as const;
const PLAN_MAX = 40;
const LIMIT_MAX = 100_000;

export class EntitlementError extends Error {
  constructor(
    public reason: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

interface Row {
  record_id: string;
  farm_id: string;
  lead_id: string;
  buyer_intake_id: string | null;
  plan: string | null;
  offer_id: string | null;
  pilot: boolean;
  start_at: string | null;
  renew_at: string | null;
  limit_racks: number | null;
  limit_devices: number | null;
  limit_users: number | null;
  test: boolean;
  set_by: string;
  created_at: string;
  updated_at: string;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

/** The farm's subscription status from the customer events contract, newest first. */
async function subscriberStatus(farmId: string): Promise<{ status: string; recorded: boolean; since: string | null; subscriber_id: string | null }> {
  const r = await query<{ new_state: string; at: Date; subject_id: string }>(
    `SELECT detail->>'new_state' AS new_state, at, subject_id FROM engine_events
      WHERE event_type = 'VFARM_SUBSCRIBER_STATE_CHANGED' AND detail->>'farm_id' = $1
      ORDER BY at DESC, id DESC LIMIT 1`,
    [farmId],
  );
  const hit = r.rows[0];
  if (!hit || !(STATUSES as readonly string[]).includes(hit.new_state)) return { status: 'pending', recorded: false, since: null, subscriber_id: null };
  return { status: hit.new_state, recorded: true, since: iso(hit.at), subscriber_id: hit.subject_id };
}

/** The answer vFarm reads. Exactly Jason's fields, plus where each came from. */
function shape(farmId: string, row: Row | null, st: Awaited<ReturnType<typeof subscriberStatus>>) {
  const notes: string[] = [];
  if (!row) notes.push(`No entitlement record is held for this farm. Derive ${FLOOR.plan} with status ${FLOOR.status}, the floor, not everything on.`);
  else if (!row.plan) notes.push(`No plan is on the record: no approved offer names one yet. Derive ${FLOOR.plan} until a plan is present.`);
  if (!st.recorded) notes.push('No subscriber state has been recorded for this farm (VFARM_SUBSCRIBER_STATE_CHANGED), so status is pending.');
  if (row && [row.limit_racks, row.limit_devices, row.limit_users].some((x) => x === null)) notes.push('A limit that is null is not set yet: show "not set" and enforce nothing against it.');
  if (row?.test) notes.push('This record is on a team test lead: a test of the path, never a customer.');
  return {
    contract: ENTITLEMENT_CONTRACT,
    farm_id: farmId,
    found: row !== null,
    record_id: row?.record_id ?? null,
    plan: row?.plan ?? null,
    status: st.status,
    status_recorded: st.recorded,
    status_since: st.since,
    start_at: row?.start_at ?? null,
    renew_at: row?.renew_at ?? null,
    pilot: row?.pilot ?? false,
    limits: { racks: row?.limit_racks ?? null, devices: row?.limit_devices ?? null, users: row?.limit_users ?? null },
    offer_id: row?.offer_id ?? null,
    buyer_intake_id: row?.buyer_intake_id ?? null,
    test: row?.test ?? false,
    updated_at: row?.updated_at ?? null,
    floor: FLOOR,
    read_at: new Date().toISOString(),
    notes,
  };
}

function toRow(r: Record<string, unknown>): Row {
  return {
    record_id: String(r.record_id),
    farm_id: String(r.farm_id),
    lead_id: String(r.lead_id),
    buyer_intake_id: (r.buyer_intake_id as string | null) ?? null,
    plan: (r.plan as string | null) ?? null,
    offer_id: (r.offer_id as string | null) ?? null,
    pilot: r.pilot === true,
    start_at: iso(r.start_at),
    renew_at: iso(r.renew_at),
    limit_racks: r.limit_racks === null || r.limit_racks === undefined ? null : Number(r.limit_racks),
    limit_devices: r.limit_devices === null || r.limit_devices === undefined ? null : Number(r.limit_devices),
    limit_users: r.limit_users === null || r.limit_users === undefined ? null : Number(r.limit_users),
    test: r.test === true,
    set_by: String(r.set_by),
    created_at: iso(r.created_at) as string,
    updated_at: iso(r.updated_at) as string,
  };
}

/** One farm's entitlement, as vFarm reads it. A farm_id is required. */
export async function read(farmIdRaw: unknown) {
  const farmId = typeof farmIdRaw === 'string' ? farmIdRaw.trim() : '';
  if (!farmId) throw new EntitlementError('farm_id_required', 'Send farm_id: the vFarm farm id, the one the snapshot carries.');
  const r = await query<Record<string, unknown>>(`SELECT * FROM engine_vfarm_entitlements WHERE farm_id = $1`, [farmId]);
  return shape(farmId, r.rows[0] ? toRow(r.rows[0]) : null, await subscriberStatus(farmId));
}

export interface SetInput {
  farm_id: unknown;
  buyer_intake_id: unknown;
  requester_user_id: unknown;
  plan?: unknown;
  offer_id?: unknown;
  pilot?: unknown;
  start_at?: unknown;
  renew_at?: unknown;
  limits?: unknown;
  dry_run?: boolean;
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
function dateOrNull(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new EntitlementError('bad_date', `${field} must be an ISO 8601 date or time, or left out.`);
  return d.toISOString();
}
function limitOrNull(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) throw new EntitlementError('bad_limit', `limits.${field} must be a whole number from 1 to ${LIMIT_MAX}, or left out for "not set".`);
  return n;
}

/**
 * Create or change one farm's record. Destiny or Jason only. Refused, with nothing
 * written: an unknown farm, a lead that is not the paying customer, a farm already
 * linked to another lead, or a plan that is not on Jason's newest approved offer.
 * A field not sent keeps what the record holds.
 */
export async function set(i: SetInput) {
  const requester = text(i.requester_user_id, 40);
  if (!requester) throw new EntitlementError('who_is_required', 'Send requester_user_id: the Slack id of the person setting it.');
  if (!ADMIN_IDS.includes(requester)) throw new EntitlementError('not_permitted', 'Only Destiny or Jason can set a farm\'s entitlement. The Engine record is the only writer, and it is set by a person.', 403);
  const farmId = text(i.farm_id, 200);
  if (!farmId) throw new EntitlementError('farm_id_required', 'Send farm_id: the vFarm farm id, the one the snapshot carries.');
  const buyer = text(i.buyer_intake_id, 200);
  if (!buyer) throw new EntitlementError('buyer_required', 'Send buyer_intake_id: the paying customer this farm belongs to.');

  const farm = await query<{ farm_id: string }>(`SELECT farm_id FROM engine_vfarm_farms WHERE farm_id = $1`, [farmId]);
  if (!farm.rows.length) throw new EntitlementError('unknown_farm', `No vFarm farm "${farmId}" has been sent in a snapshot. Use the farm_id vFarm reports.`, 404);

  const lead = await query<{ id: string; stage: number; closed_at: Date | null; team_test: boolean }>(
    `SELECT id, stage, closed_at, ${TEAM_TEST_SQL} AS team_test FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' = $1`,
    [buyer],
  );
  if (!lead.rows.length) throw new EntitlementError('unknown_lead', `No lead "${buyer}" is held.`, 404);
  if (lead.rows.length > 1) throw new EntitlementError('ambiguous_lead', `"${buyer}" names ${lead.rows.length} leads. Nothing was set.`, 409);
  const L = lead.rows[0];
  if (L.closed_at) throw new EntitlementError('lead_closed', `${buyer} is closed. A closed lead is not a customer.`, 409);
  if (!L.team_test && Number(L.stage) !== 5) {
    throw new EntitlementError('not_a_customer', `${buyer} is at Stage ${L.stage}. The entitlement belongs to the paying-customer record, which is Stage 5 (agreement and a live payment). Until then the farm reads ${FLOOR.plan} / ${FLOOR.status}.`, 409);
  }

  const held = await query<Record<string, unknown>>(`SELECT * FROM engine_vfarm_entitlements WHERE farm_id = $1`, [farmId]);
  const before = held.rows[0] ? toRow(held.rows[0]) : null;
  if (before && before.lead_id !== L.id) throw new EntitlementError('farm_taken', `Farm ${farmId} is already linked to ${before.buyer_intake_id ?? 'another lead'} (${before.record_id}). Nothing was changed.`, 409);

  // The plan: only the one named on Jason's newest real approved offer, by that offer's id.
  let plan = before?.plan ?? null;
  let offerId = before?.offer_id ?? null;
  if (i.plan !== undefined) {
    const want = i.plan === null || i.plan === '' ? null : text(i.plan, PLAN_MAX);
    if (want === null) {
      plan = null;
      offerId = null;
    } else {
      const askedOffer = text(i.offer_id, 200);
      if (!askedOffer) throw new EntitlementError('offer_required', 'A plan is set from the offer Jason approved: send offer_id with it.');
      let gate: chargeGate.RailStatus;
      try {
        gate = await chargeGate.status();
      } catch (e) {
        throw new EntitlementError('gate_unread', `The charge gate could not be read (${e instanceof Error ? e.message : String(e)}), so the offer cannot be checked. Nothing was set.`, 503);
      }
      const offer = gate.offer_approval;
      if (!offer || offer.verdict !== 'approved') throw new EntitlementError('no_approved_offer', 'Jason has not approved a live offer, so no plan can be set. The farm reads Monitor / pending until he does.', 409);
      if (offer.offer_id !== askedOffer) throw new EntitlementError('not_newest_offer', `Jason's newest approved offer is ${offer.offer_id ?? '(unnamed)'}, not ${askedOffer}.`, 409);
      const c = offer.conditions;
      const named = c && typeof c === 'object' && !Array.isArray(c) ? text((c as Record<string, unknown>).plan, PLAN_MAX) : null;
      if (!named) throw new EntitlementError('plan_not_on_offer', `Offer ${askedOffer} names no plan in its conditions. The plan goes on the offer Jason approves; nothing is filled in for him.`, 409);
      if (named.toLowerCase() !== want.toLowerCase()) throw new EntitlementError('plan_mismatch', `Offer ${askedOffer} names the plan "${named}", not "${want}".`, 409);
      plan = named;
      offerId = askedOffer;
    }
  }

  const lim = i.limits && typeof i.limits === 'object' && !Array.isArray(i.limits) ? (i.limits as Record<string, unknown>) : null;
  if (i.limits !== undefined && i.limits !== null && !lim) throw new EntitlementError('bad_limit', 'limits is an object: { racks, devices, users }, each a whole number or null for "not set".');
  const next = {
    plan,
    offer_id: offerId,
    pilot: i.pilot === undefined ? (before?.pilot ?? false) : i.pilot === true,
    start_at: i.start_at === undefined ? (before?.start_at ?? null) : dateOrNull(i.start_at, 'start_at'),
    renew_at: i.renew_at === undefined ? (before?.renew_at ?? null) : dateOrNull(i.renew_at, 'renew_at'),
    limit_racks: lim && 'racks' in lim ? limitOrNull(lim.racks, 'racks') : (before?.limit_racks ?? null),
    limit_devices: lim && 'devices' in lim ? limitOrNull(lim.devices, 'devices') : (before?.limit_devices ?? null),
    limit_users: lim && 'users' in lim ? limitOrNull(lim.users, 'users') : (before?.limit_users ?? null),
  };
  if (next.start_at && next.renew_at && next.renew_at <= next.start_at) throw new EntitlementError('bad_date', 'renew_at must be after start_at.');

  const recordId = before?.record_id ?? `ENT-${Date.now()}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const plannedRow = { record_id: recordId, farm_id: farmId, buyer_intake_id: buyer, test: L.team_test === true, ...next };
  if (i.dry_run) return { ok: true, dry_run: true, written: false, before, would_write: plannedRow, message: 'Dry run: nothing was written.' };

  const after = await withTransaction(async (db) => {
    const w = await db.query<Record<string, unknown>>(
      `INSERT INTO engine_vfarm_entitlements (record_id, farm_id, lead_id, buyer_intake_id, plan, offer_id, pilot, start_at, renew_at, limit_racks, limit_devices, limit_users, test, set_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (farm_id) DO UPDATE SET plan = EXCLUDED.plan, offer_id = EXCLUDED.offer_id, pilot = EXCLUDED.pilot, start_at = EXCLUDED.start_at,
         renew_at = EXCLUDED.renew_at, limit_racks = EXCLUDED.limit_racks, limit_devices = EXCLUDED.limit_devices, limit_users = EXCLUDED.limit_users,
         set_by = EXCLUDED.set_by, updated_at = now()
       RETURNING *`,
      [recordId, farmId, L.id, buyer, next.plan, next.offer_id, next.pilot, next.start_at, next.renew_at, next.limit_racks, next.limit_devices, next.limit_users, L.team_test === true, requester],
    );
    const row = toRow(w.rows[0]);
    await engineEvents.record(
      {
        event_type: 'vfarm_entitlement_set',
        subject_id: farmId,
        lane: 'VFARM',
        actor: requester,
        detail: { record_id: row.record_id, buyer_intake_id: buyer, plan: row.plan, offer_id: row.offer_id, pilot: row.pilot, start_at: row.start_at, renew_at: row.renew_at, limits: { racks: row.limit_racks, devices: row.limit_devices, users: row.limit_users }, test: row.test, created: before === null },
      },
      db,
    );
    return row;
  });
  return { ok: true, written: true, created: before === null, before, entitlement: shape(farmId, after, await subscriberStatus(farmId)) };
}
