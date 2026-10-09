/**
 * The vFarm stage gates and the 5-rack pilot offer, as real records
 * (2026-10-09, Destiny — LOOP-1791479575963-7S0O).
 *
 * Three objects, locked by Jason on 8 Oct as the v1 contracts (Codex Architect
 * Answer 6120a262-8609-40ae-9a8f-eec180f8cf46):
 *
 *   stage1  VFARM_STAGE1_LAB_VALIDATION_v1    (LOOP-…-TU4O)
 *   stage2  VFARM_STAGE2_PILOT_CHECKLIST_v1   (LOOP-…-TU4O)
 *   offer   VFARM_5RACK_PILOT_OFFER_v1        (LOOP-…-L2KO)
 *
 * **One function writes them: `writeGate`.** The MCP tool, the engine route
 * and the tests all call it, so the order is enforced whoever is writing:
 *
 *   - a Stage 2 row needs a Stage 1 row (`stage1_ref`), and cannot be
 *     in_progress, passed or failed until that Stage 1 row is `passed`
 *     (refused: `stage1_not_passed`);
 *   - an offer cannot be `offered` or `signed` without a Stage 2 row tied by
 *     `stage2_ref` (refused: `stage2_required`).
 *
 * **Every change is an event as well as a row**, written in the same
 * transaction to `engine_events` (engine.event.v1), so the two land together
 * or not at all: `VFARM_STAGE1_STATE_CHANGED`, `VFARM_STAGE2_STATE_CHANGED`,
 * `VFARM_CHECK_UPDATED`, `VFARM_OFFER_STATE_CHANGED`. The events carry the
 * crop and growth-stage tags, and an offer's event carries its Stage 2 row.
 *
 * **Slack hears about it after the commit**: one post as Bays for a status
 * change and one for a check that failed. A post Slack refuses is not silent:
 * the answer says `raise: true` and a `VFARM_GATE_ALERT_FAILED` event is kept.
 *
 * **What this does not claim.** Three of the four checks have no sensor behind
 * them yet (root-zone moisture, airflow velocity, early disease detection), so
 * `source: "sensor"` is refused on them (`no_sensor_yet`) and they are recorded
 * by a person with who and when. When a sensor lands, its name moves into
 * SENSOR_BACKED and it feeds the same field: no schema change.
 *
 * **Fixtures.** `fixture: true` on create marks a test row. It is labelled in
 * every read, alert and event, a real row may not point at one, and
 * `deleteFixtures` removes fixtures and nothing else. The events they produced
 * stay (the table is append-only) with `detail.fixture: true`.
 *
 * Nothing here fills in a gate, a threshold or a price. Those are Jason's.
 */
import { query, withTransaction, type Queryable } from './pg';
import * as engineEvents from './engineEvents';
import * as events from './events';
import * as slack from './slack';

export type GateKind = 'stage1' | 'stage2' | 'offer';
export const KINDS: readonly GateKind[] = ['stage1', 'stage2', 'offer'];

export const CONTRACT: Record<GateKind, string> = {
  stage1: 'VFARM_STAGE1_LAB_VALIDATION_v1',
  stage2: 'VFARM_STAGE2_PILOT_CHECKLIST_v1',
  offer: 'VFARM_5RACK_PILOT_OFFER_v1',
};
const PREFIX: Record<GateKind, string> = { stage1: 'VFS1', stage2: 'VFS2', offer: 'VFOF' };
const LABEL: Record<GateKind, string> = { stage1: 'Stage 1 lab validation', stage2: 'Stage 2 pilot checklist', offer: '5-rack pilot offer' };
const STATE_EVENT: Record<GateKind, string> = { stage1: 'VFARM_STAGE1_STATE_CHANGED', stage2: 'VFARM_STAGE2_STATE_CHANGED', offer: 'VFARM_OFFER_STATE_CHANGED' };

export const STATUSES: Record<GateKind, readonly string[]> = {
  stage1: ['planned', 'in_progress', 'passed', 'failed'],
  stage2: ['planned', 'in_progress', 'passed', 'failed'],
  offer: ['draft', 'under_review', 'final', 'offered', 'signed'],
};
const FIRST_STATUS: Record<GateKind, string> = { stage1: 'planned', stage2: 'planned', offer: 'draft' };

export const CHECKS = ['canopy_climate_check', 'root_zone_moisture_check', 'airflow_velocity_check', 'early_disease_detection_check'] as const;
export type CheckName = (typeof CHECKS)[number];
const CHECK_LABEL: Record<CheckName, string> = {
  canopy_climate_check: 'Canopy climate',
  root_zone_moisture_check: 'Root-zone moisture',
  airflow_velocity_check: 'Airflow velocity',
  early_disease_detection_check: 'Early disease detection',
};
/** The checks a sensor can feed today. The other three are recorded by a person (Jason, 8 Oct). */
export const SENSOR_BACKED: readonly CheckName[] = ['canopy_climate_check'];
export const MANUAL_ONLY: readonly CheckName[] = CHECKS.filter((c) => !SENSOR_BACKED.includes(c));
/** The contract names the check's fields and not its status values; these three are this store's (logged in docs/contracts/vfarm-gates.md). */
export const CHECK_STATUSES = ['pending', 'passed', 'failed'] as const;
const CHECK_FIELDS = ['status', 'thresholds', 'notes', 'value', 'source', 'checked_by', 'checked_at', 'evidence_ref'];

type FieldType = 'text' | 'number' | 'date' | 'json' | 'tag' | 'check' | 'leads';
/** The contract's own field names, per object. status, the refs, id and the two timestamps are columns. */
const FIELDS: Record<GateKind, Record<string, FieldType>> = {
  stage1: {
    loop_ref: 'text',
    target_cabinet_config_hash: 'text',
    cad_revision: 'text',
    substrate_config: 'json',
    lighting_config: 'json',
    irrigation_config: 'json',
    climate_band: 'json',
    canopy_climate_check: 'check',
    root_zone_moisture_check: 'check',
    airflow_velocity_check: 'check',
    early_disease_detection_check: 'check',
    evidence_links: 'json',
    owner_slack_id: 'text',
    target_date: 'date',
    // Added by Jason on 8 Oct (thread 1791497202.119269), for the twins.
    crop_profile: 'tag',
    growth_stage: 'tag',
  },
  stage2: {
    loop_ref: 'text',
    pilot_site_profile_id: 'text',
    rack_count: 'number',
    cabinet_config_hashes: 'json',
    crop_profile: 'tag',
    maintenance_time_budget_min_per_week: 'number',
    alert_volume_budget_per_week: 'number',
    yield_target_per_rack_per_cycle: 'json',
    uptime_target_pct: 'number',
    uptime_window: 'text',
    failure_modes_covered: 'json',
    pass_fail_rationale: 'text',
    owner_slack_id: 'text',
    target_date: 'date',
    growth_stage: 'tag',
  },
  offer: {
    loop_ref: 'text',
    target_customer_profile: 'json',
    rack_count: 'number',
    upfront_price_band_min: 'number',
    upfront_price_band_max: 'number',
    subscription_price_per_rack_min: 'number',
    subscription_price_per_rack_max: 'number',
    final_upfront_price: 'number',
    final_subscription_price_per_rack: 'number',
    term_length_months: 'number',
    grandfathering_rules: 'json',
    underperformance_clause: 'json',
    included_support_scope: 'json',
    exit_conditions: 'json',
    owner_slack_id: 'text',
    target_date: 'date',
    // The Early Access tie (Jason, 8 Oct): the 5-rack enquiries this offer is for.
    linked_lead_ids: 'leads',
  },
};

export function fieldNames(kind: GateKind): string[] {
  return ['status', ...(kind === 'stage2' ? ['stage1_ref'] : kind === 'offer' ? ['stage2_ref'] : []), ...Object.keys(FIELDS[kind])];
}

/** A refusal: nothing was written. `reason` is the stable word, `message` the sentence. */
export class GateRefused extends Error {
  constructor(
    public reason: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Row {
  object_id: string;
  kind: GateKind;
  status: string;
  stage1_ref: string | null;
  stage2_ref: string | null;
  fields: Record<string, unknown>;
  is_fixture: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
const COLS = `object_id, kind, status, stage1_ref, stage2_ref, fields, is_fixture, created_by, updated_by,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

/** The record as the contract words it, with this store's own facts beside it. */
export function show(r: Row) {
  return {
    id: r.object_id,
    contract: CONTRACT[r.kind],
    kind: r.kind,
    fixture: r.is_fixture,
    status: r.status,
    ...(r.kind === 'stage2' ? { stage1_ref: r.stage1_ref } : {}),
    ...(r.kind === 'offer' ? { stage2_ref: r.stage2_ref } : {}),
    ...r.fields,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  };
}
export type Shown = ReturnType<typeof show>;

const newId = (kind: GateKind, fixture: boolean, now = Date.now()) =>
  `${fixture ? 'FIXTURE-' : ''}${PREFIX[kind]}-${now}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function cleanCheck(name: CheckName, raw: unknown, before: Record<string, unknown> | null, by: string, now: string): Record<string, unknown> {
  if (!isObj(raw)) throw new GateRefused('bad_check', `${name} must be an object: { status, thresholds, notes, value, source, checked_by, checked_at, evidence_ref }.`);
  const unknown = Object.keys(raw).filter((k) => !CHECK_FIELDS.includes(k));
  if (unknown.length) throw new GateRefused('unknown_field', `${name} does not have ${unknown.map((k) => `"${k}"`).join(', ')}. A check carries: ${CHECK_FIELDS.join(', ')}.`, { unknown_fields: unknown.map((k) => `${name}.${k}`) });
  const next: Record<string, unknown> = { ...(before ?? {}) };
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === '') delete next[k];
    else next[k] = v;
  }
  const status = next.status === undefined ? 'pending' : String(next.status);
  if (!(CHECK_STATUSES as readonly string[]).includes(status)) throw new GateRefused('bad_check_status', `${name}.status "${status}" is not one of ${CHECK_STATUSES.join(', ')}.`);
  next.status = status;
  const source = next.source === undefined ? 'manual' : String(next.source);
  if (source !== 'manual' && source !== 'sensor') throw new GateRefused('bad_check_source', `${name}.source is "manual" (a person checked it) or "sensor".`);
  if (source === 'sensor' && !SENSOR_BACKED.includes(name)) {
    throw new GateRefused('no_sensor_yet', `${name} has no sensor behind it yet, so it cannot be recorded as a sensor reading. Record it as source "manual" with who checked and when.`, { manual_only_checks: MANUAL_ONLY });
  }
  next.source = source;
  if (status !== 'pending') {
    // Provenance (the contract's rule): a verdict always says who and when.
    const who = typeof next.checked_by === 'string' && next.checked_by.trim() ? next.checked_by.trim() : by;
    next.checked_by = who;
    const statusMoved = !before || before.status !== status;
    const given = typeof raw.checked_at === 'string' && raw.checked_at.trim() ? raw.checked_at.trim() : null;
    if (given) {
      const d = new Date(given);
      if (Number.isNaN(d.getTime())) throw new GateRefused('bad_time', `${name}.checked_at "${given}" is not an ISO 8601 time.`);
      next.checked_at = d.toISOString();
    } else if (statusMoved || !next.checked_at) next.checked_at = now;
  }
  return next;
}

function cleanField(name: string, type: FieldType, v: unknown): unknown {
  const bad = (want: string) => new GateRefused('bad_value', `${name} must be ${want}.`, { field: name });
  switch (type) {
    case 'text': {
      if (typeof v !== 'string' || !v.trim()) throw bad('text');
      return v.trim().slice(0, 4000);
    }
    case 'tag': {
      if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(v.trim())) throw bad('a lower-case tag such as "tomatoes" or "tomato_flower" (letters, digits and underscores)');
      return v.trim();
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n) || n < 0) throw bad('a number, zero or more');
      return n;
    }
    case 'date': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) || Number.isNaN(Date.parse(v.trim()))) throw bad('a date as YYYY-MM-DD');
      return v.trim();
    }
    case 'leads': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw bad('a list of Early Access lead ids (the lead id or its buyer_intake_id)');
      return [...new Set((v as string[]).map((x) => x.trim()))];
    }
    case 'json': {
      if (typeof v === 'string') {
        if (!v.trim()) throw bad('text, a list or an object');
        return v.trim().slice(0, 8000);
      }
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      if (typeof v === 'object') {
        if (JSON.stringify(v).length > 32_000) throw bad('smaller than 32 KB');
        return v;
      }
      throw bad('text, a list or an object');
    }
    default:
      throw bad('a value');
  }
}

async function readRow(db: Queryable, id: string, lock: '' | 'FOR UPDATE' | 'FOR SHARE' = ''): Promise<Row | null> {
  const r = await db.query<Row>(`SELECT ${COLS} FROM engine_vfarm_gates WHERE object_id = $1 ${lock}`, [id]);
  return r.rows[0] ?? null;
}

/** Lead ids as stored, from either the row id or the tracker's buyer_intake_id. Unknown ones are named. */
async function resolveLeads(db: Queryable, given: string[]): Promise<string[]> {
  if (!given.length) return [];
  const r = await db.query<{ id: string; buyer: string | null }>(
    `SELECT id::text AS id, form_a->>'buyer_intake_id' AS buyer FROM engine_vfarm_leads WHERE id::text = ANY($1::text[]) OR form_a->>'buyer_intake_id' = ANY($1::text[])`,
    [given],
  );
  const out: string[] = [];
  const missing: string[] = [];
  for (const g of given) {
    const hit = r.rows.find((x) => x.id === g || x.buyer === g);
    if (hit) out.push(hit.id);
    else missing.push(g);
  }
  if (missing.length) throw new GateRefused('unknown_lead', `No Early Access lead has the id ${missing.map((m) => `"${m}"`).join(', ')}. Use the lead's id or its buyer_intake_id from the Early Access tab.`, { unknown_leads: missing });
  return [...new Set(out)];
}

export interface WriteInput {
  kind: string;
  /** Absent: create. Present: update that record. */
  object_id?: string | null;
  /** The contract's fields, by their own names; status and the refs among them. null clears a field. */
  fields: Record<string, unknown>;
  /** On create only: a test row. */
  fixture?: boolean;
  /** Who is making the change: a Slack id or a name. Required. */
  by: string;
  /** What carried the write: "mcp", "engine", "test". */
  via?: string;
  dry_run?: boolean;
}

export interface AlertResult {
  about: string;
  ok: boolean;
  channel: string | null;
  ts?: string;
  error?: string;
}

export interface WriteResult {
  ok: true;
  written: boolean;
  dry_run: boolean;
  created: boolean;
  changed: boolean;
  record: Shown;
  status_change: { from: string | null; to: string } | null;
  checks_updated: string[];
  events: string[];
  alerts: AlertResult[];
  /** True when a Slack alert that should have gone out did not. */
  raise?: boolean;
  message: string;
}

interface Planned {
  row: Row;
  created: boolean;
  changed: boolean;
  statusChange: { from: string | null; to: string } | null;
  checksUpdated: CheckName[];
  checksFailed: CheckName[];
  stage2: Row | null;
  events: engineEvents.EngineEvent[];
}

const PAGE = 'https://dashboard.bhanetwork.org/vfarm?tab=gates';

function checkSummary(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of CHECKS) {
    const v = isObj(fields[c]) ? (fields[c] as Record<string, unknown>) : null;
    out[c] = v ? { status: v.status ?? 'pending', source: v.source ?? 'manual', checked_by: v.checked_by ?? null, checked_at: v.checked_at ?? null, evidence_ref: v.evidence_ref ?? null } : { status: 'pending' };
  }
  return out;
}

async function plan(db: Queryable, input: WriteInput, now: string): Promise<Planned> {
  const kind = input.kind as GateKind;
  if (!KINDS.includes(kind)) throw new GateRefused('unknown_kind', `kind is one of: stage1 (${CONTRACT.stage1}), stage2 (${CONTRACT.stage2}), offer (${CONTRACT.offer}).`);
  const by = typeof input.by === 'string' ? input.by.trim().slice(0, 200) : '';
  if (!by) throw new GateRefused('who_is_required', 'Say who is making this change (a Slack user id or a name). Every change to a gate record names its author.');
  if (!isObj(input.fields)) throw new GateRefused('bad_fields', 'fields must be an object of the contract\'s own field names.');

  const id = typeof input.object_id === 'string' && input.object_id.trim() ? input.object_id.trim() : null;
  const before = id ? await readRow(db, id, 'FOR UPDATE') : null;
  if (id && !before) throw new GateRefused('not_found', `There is no vFarm gate record "${id}".`);
  if (before && before.kind !== kind) throw new GateRefused('kind_mismatch', `${id} is a ${LABEL[before.kind]} (${before.kind}), not ${kind}.`);
  if (before && input.fixture !== undefined && input.fixture !== before.is_fixture) throw new GateRefused('fixture_is_fixed', 'Whether a record is a fixture is set when it is created and does not change.');
  const fixture = before ? before.is_fixture : input.fixture === true;

  const spec = FIELDS[kind];
  const sent = { ...input.fields };
  for (const k of ['id', 'created_at', 'updated_at', 'contract', 'kind', 'fixture', 'created_by', 'updated_by']) delete sent[k];
  const allowed = new Set(fieldNames(kind));
  const unknown = Object.keys(sent).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new GateRefused('unknown_field', `${CONTRACT[kind]} has no field ${unknown.map((k) => `"${k}"`).join(', ')}. The v1 contract is fixed; its fields are: ${fieldNames(kind).join(', ')}.`, { unknown_fields: unknown });
  }

  // Status.
  let status = before ? before.status : FIRST_STATUS[kind];
  if (sent.status !== undefined && sent.status !== null) {
    status = String(sent.status).trim();
    if (!STATUSES[kind].includes(status)) throw new GateRefused('bad_status', `"${status}" is not a ${LABEL[kind]} status. One of: ${STATUSES[kind].join(', ')}.`);
  }

  // The refs.
  let stage1Ref = before?.stage1_ref ?? null;
  let stage2Ref = before?.stage2_ref ?? null;
  const refOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (kind === 'stage2' && sent.stage1_ref !== undefined) {
    const r = refOf(sent.stage1_ref);
    if (before && r !== before.stage1_ref) throw new GateRefused('ref_is_fixed', `${before.object_id} is tied to ${before.stage1_ref}. A Stage 2 row's stage1_ref does not change; a different Stage 1 means a new Stage 2 row.`);
    stage1Ref = r;
  }
  if (kind === 'offer' && sent.stage2_ref !== undefined) {
    const r = refOf(sent.stage2_ref);
    if (before?.stage2_ref && r !== before.stage2_ref) throw new GateRefused('ref_is_fixed', `${before.object_id} is tied to ${before.stage2_ref}. An offer's stage2_ref is set once; a different pilot means a new offer.`);
    stage2Ref = r;
  }

  // The hard gates.
  let stage2: Row | null = null;
  const mustBeSameWorld = (ref: Row, what: string) => {
    if (ref.is_fixture && !fixture) throw new GateRefused('fixture_ref', `${ref.object_id} is a test fixture. A real ${LABEL[kind]} cannot be tied to a fixture ${what}.`);
    if (!ref.is_fixture && fixture) throw new GateRefused('fixture_ref', `${ref.object_id} is a real record. A fixture can only be tied to another fixture.`);
  };
  if (kind === 'stage2') {
    if (!stage1Ref) throw new GateRefused('stage1_required', 'A Stage 2 pilot checklist needs stage1_ref: the id of the Stage 1 lab validation it follows.');
    const s1 = await readRow(db, stage1Ref, 'FOR SHARE');
    if (!s1 || s1.kind !== 'stage1') throw new GateRefused('stage1_required', `stage1_ref "${stage1Ref}" is not a Stage 1 lab validation record.`);
    mustBeSameWorld(s1, 'Stage 1');
    if (status !== 'planned' && s1.status !== 'passed') {
      throw new GateRefused('stage1_not_passed', `Stage 2 cannot be ${status} yet: Stage 1 (${s1.object_id}) is ${s1.status}, not passed. Stage 2 stays planned until Stage 1 has passed.`, {
        stage1_ref: s1.object_id,
        stage1_status: s1.status,
      });
    }
  }
  if (kind === 'offer') {
    if (stage2Ref) {
      stage2 = await readRow(db, stage2Ref, 'FOR SHARE');
      if (!stage2 || stage2.kind !== 'stage2') throw new GateRefused('stage2_required', `stage2_ref "${stage2Ref}" is not a Stage 2 pilot checklist record.`);
      mustBeSameWorld(stage2, 'Stage 2');
    }
    if ((status === 'offered' || status === 'signed') && !stage2) {
      throw new GateRefused('stage2_required', `An offer cannot be ${status} without a Stage 2 pilot checklist tied to it. Set stage2_ref to the Stage 2 record first.`);
    }
  }

  // The fields.
  const fields: Record<string, unknown> = { ...(before?.fields ?? {}) };
  const checksUpdated: CheckName[] = [];
  const checksFailed: CheckName[] = [];
  for (const [name, type] of Object.entries(spec)) {
    if (!(name in sent)) continue;
    const v = sent[name];
    if (type === 'check') {
      const c = name as CheckName;
      const prev = isObj(fields[c]) ? (fields[c] as Record<string, unknown>) : null;
      if (v === null) throw new GateRefused('bad_check', `${c} cannot be cleared: a check that was recorded stays on the record. Set its status back to "pending" instead.`);
      const next = cleanCheck(c, v, prev, by, now);
      if (!same(prev, next)) {
        fields[c] = next;
        checksUpdated.push(c);
        if (next.status === 'failed' && prev?.status !== 'failed') checksFailed.push(c);
      }
      continue;
    }
    if (v === null || v === '') {
      delete fields[name];
      continue;
    }
    fields[name] = type === 'leads' ? await resolveLeads(db, cleanField(name, type, v) as string[]) : cleanField(name, type, v);
  }

  const statusChange = !before || before.status !== status ? { from: before ? before.status : null, to: status } : null;
  const changed = !before || !!statusChange || stage1Ref !== (before.stage1_ref ?? null) || stage2Ref !== (before.stage2_ref ?? null) || !same(before.fields, fields);
  const objectId = before ? before.object_id : newId(kind, fixture);
  const row: Row = {
    object_id: objectId,
    kind,
    status,
    stage1_ref: stage1Ref,
    stage2_ref: stage2Ref,
    fields,
    is_fixture: fixture,
    created_at: before?.created_at ?? now,
    updated_at: changed ? now : (before?.updated_at ?? now),
    created_by: before?.created_by ?? by,
    updated_by: changed ? by : (before?.updated_by ?? by),
  };

  // The events, one per thing that moved.
  const tags = { crop_profile: fields.crop_profile ?? null, growth_stage: fields.growth_stage ?? null };
  const base = {
    subject_id: objectId,
    lane: 'VFARM_HARDWARE',
    actor: by,
    at: now,
    source_ref: PAGE,
  };
  const common = { contract: CONTRACT[kind], object_id: objectId, loop_ref: fields.loop_ref ?? null, fixture, changed_by: by, changed_at: now, via: input.via ?? null };
  const out: engineEvents.EngineEvent[] = [];
  if (statusChange) {
    const detail: Record<string, unknown> = { ...common, old_status: statusChange.from, new_status: statusChange.to };
    if (kind === 'stage1') Object.assign(detail, tags, { target_cabinet_config_hash: fields.target_cabinet_config_hash ?? null, cad_revision: fields.cad_revision ?? null, checks: checkSummary(fields) });
    if (kind === 'stage2') {
      const s1 = stage1Ref ? await readRow(db, stage1Ref) : null;
      Object.assign(detail, tags, {
        stage1_ref: stage1Ref,
        stage1_status: s1?.status ?? null,
        pilot_site_profile_id: fields.pilot_site_profile_id ?? null,
        rack_count: fields.rack_count ?? null,
        cabinet_config_hashes: fields.cabinet_config_hashes ?? null,
        checks_ref: stage1Ref,
        checks: s1 ? checkSummary(s1.fields) : null,
      });
    }
    if (kind === 'offer') {
      Object.assign(detail, {
        stage2_ref: stage2Ref,
        stage2: stage2
          ? { id: stage2.object_id, status: stage2.status, stage1_ref: stage2.stage1_ref, pilot_site_profile_id: stage2.fields.pilot_site_profile_id ?? null, rack_count: stage2.fields.rack_count ?? null, crop_profile: stage2.fields.crop_profile ?? null, growth_stage: stage2.fields.growth_stage ?? null }
          : null,
        rack_count: fields.rack_count ?? null,
        linked_lead_ids: fields.linked_lead_ids ?? [],
      });
    }
    out.push({ ...base, event_type: STATE_EVENT[kind], detail });
  }
  for (const c of checksUpdated) {
    const v = fields[c] as Record<string, unknown>;
    out.push({
      ...base,
      event_type: 'VFARM_CHECK_UPDATED',
      detail: {
        ...common,
        ...tags,
        check: c,
        outcome: v.status,
        value: v.value ?? null,
        thresholds: v.thresholds ?? null,
        source: v.source,
        checked_by: v.checked_by ?? null,
        checked_at: v.checked_at ?? null,
        evidence_ref: v.evidence_ref ?? null,
        notes: v.notes ?? null,
        stage1_status: status,
        target_cabinet_config_hash: fields.target_cabinet_config_hash ?? null,
      },
    });
  }
  return { row, created: !before, changed, statusChange, checksUpdated, checksFailed, stage2, events: out };
}

/* ------------------------------------------------------------------ alerts */

export const CHANNEL_VARS = ['VFARM_GATE_ALERT_CHANNEL', 'QUOTA_ALERT_CHANNEL'] as const;
export function alertChannel(): string | null {
  for (const v of CHANNEL_VARS) {
    const c = process.env[v]?.trim();
    if (c) return c;
  }
  return null;
}

const who = (by: string) => (/^[UW][A-Z0-9]{6,}$/.test(by) ? `<@${by}>` : by);

function alertTexts(p: Planned): { about: string; text: string }[] {
  const r = p.row;
  const mark = r.is_fixture ? ':test_tube: *TEST FIXTURE, not a real record.* ' : '';
  const out: { about: string; text: string }[] = [];
  if (p.statusChange) {
    const from = p.statusChange.from ? `${p.statusChange.from} → ` : 'created as ';
    const tied = r.kind === 'stage2' ? ` Follows Stage 1 \`${r.stage1_ref}\`.` : r.kind === 'offer' ? (r.stage2_ref ? ` Tied to Stage 2 \`${r.stage2_ref}\`.` : ' No Stage 2 tied yet.') : '';
    out.push({
      about: `status:${r.object_id}`,
      text: `${mark}*vFarm ${LABEL[r.kind]}* \`${r.object_id}\`: ${from}*${p.statusChange.to}*, by ${who(r.updated_by ?? '')}.${tied} <${PAGE}|Open the gates page>`,
    });
  }
  for (const c of p.checksFailed) {
    const v = r.fields[c] as Record<string, unknown>;
    const how = v.source === 'sensor' ? 'sensor reading' : 'checked by a person';
    const val = v.value !== undefined && v.value !== null ? ` Value: ${typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value)}.` : '';
    const notes = typeof v.notes === 'string' && v.notes ? ` Notes: ${v.notes.slice(0, 300)}` : '';
    out.push({
      about: `check:${r.object_id}:${c}`,
      text: `${mark}:red_circle: *vFarm Stage 1 check failed: ${CHECK_LABEL[c]}* on \`${r.object_id}\` (${how}, by ${who(String(v.checked_by ?? ''))}).${val}${notes} <${PAGE}|Open the gates page>`,
    });
  }
  return out;
}

async function sendAlerts(p: Planned): Promise<AlertResult[]> {
  const msgs = alertTexts(p);
  if (!msgs.length) return [];
  const channel = alertChannel();
  const results: AlertResult[] = [];
  for (const m of msgs) {
    let res: AlertResult;
    if (!channel) res = { about: m.about, ok: false, channel: null, error: `no channel: neither ${CHANNEL_VARS.join(' nor ')} is set` };
    else {
      const r = await slack.botCall('chat.postMessage', { channel, text: m.text, unfurl_links: false, unfurl_media: false });
      res = r.ok ? { about: m.about, ok: true, channel, ts: String(r.ts ?? '') } : { about: m.about, ok: false, channel, error: r.error ?? 'unknown' };
    }
    results.push(res);
    if (!res.ok) {
      console.error(`[vfarm-gates] alert not delivered for ${m.about}: ${res.error}`);
      try {
        await engineEvents.record({
          event_type: 'VFARM_GATE_ALERT_FAILED',
          subject_id: p.row.object_id,
          lane: 'VFARM_HARDWARE',
          actor: 'the dashboard (vFarm gate alerts)',
          source_ref: PAGE,
          detail: { about: m.about, channel, error: res.error, fixture: p.row.is_fixture, text: m.text.slice(0, 1000) },
        });
      } catch (e) {
        console.error(`[vfarm-gates] could not record the failed alert: ${(e as Error).message}`);
      }
    }
  }
  return results;
}

/* ------------------------------------------------------------------- write */

/**
 * Creates or updates one record. Throws GateRefused with nothing written when
 * the contract or the order says no.
 */
export async function writeGate(input: WriteInput): Promise<WriteResult> {
  const now = new Date().toISOString();
  const dry = input.dry_run === true;
  const p = await withTransaction(async (db) => {
    const planned = await plan(db, input, now);
    if (dry || !planned.changed) return planned;
    const r = planned.row;
    if (planned.created) {
      await db.query(
        `INSERT INTO engine_vfarm_gates (object_id, kind, status, stage1_ref, stage2_ref, fields, is_fixture, created_at, updated_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $8::timestamptz, $9, $9)`,
        [r.object_id, r.kind, r.status, r.stage1_ref, r.stage2_ref, JSON.stringify(r.fields), r.is_fixture, now, r.updated_by],
      );
    } else {
      await db.query(`UPDATE engine_vfarm_gates SET status = $2, stage1_ref = $3, stage2_ref = $4, fields = $5::jsonb, updated_at = $6::timestamptz, updated_by = $7 WHERE object_id = $1`, [
        r.object_id,
        r.status,
        r.stage1_ref,
        r.stage2_ref,
        JSON.stringify(r.fields),
        now,
        r.updated_by,
      ]);
    }
    for (const e of planned.events) await engineEvents.record(e, db);
    events.changed('vfarm_gates', r.object_id, db);
    return planned;
  });

  const written = !dry && p.changed;
  const alerts = written ? await sendAlerts(p) : [];
  const failed = alerts.filter((a) => !a.ok);
  const what = dry
    ? `Dry run: nothing was written. This would ${p.created ? `create a ${LABEL[p.row.kind]}` : p.changed ? `update ${p.row.object_id}` : `change nothing on ${p.row.object_id}`}.`
    : !p.changed
      ? `${p.row.object_id} already holds exactly this, so nothing was written and no event was sent.`
      : `${p.created ? 'Created' : 'Updated'} ${p.row.object_id}${p.statusChange ? ` (${p.statusChange.from ?? 'new'} → ${p.statusChange.to})` : ''}; ${p.events.length} event${p.events.length === 1 ? '' : 's'} written.`;
  return {
    ok: true,
    written,
    dry_run: dry,
    created: p.created,
    changed: p.changed,
    record: show(p.row),
    status_change: p.statusChange,
    checks_updated: p.checksUpdated,
    events: p.events.map((e) => e.event_type),
    alerts,
    ...(failed.length ? { raise: true } : {}),
    message: failed.length ? `${what} BUT ${failed.length} Slack alert${failed.length === 1 ? ' was' : 's were'} not delivered (${failed.map((f) => f.error).join('; ')}). The record and its events are saved; tell Destiny the alert did not go out.` : what,
  };
}

/* -------------------------------------------------------------------- read */

export interface GatesData {
  stage1: Shown[];
  stage2: Shown[];
  offers: (Shown & { linked_leads: { id: string; full_name: string; organization_name: string | null; stage: number; status: string }[] })[];
  fixtures: number;
  contracts: Record<GateKind, string>;
  checks: { name: CheckName; label: string; recorded_by: 'sensor or a person' | 'a person' }[];
  gates: string[];
  alert_channel_configured: boolean;
  events: { id: number; event_type: string; at: string; subject_id: string; actor: string | null; detail: Record<string, unknown> }[];
  note: string;
}

/** Everything the Gates tab and get_vfarm_gates show. Fixtures are included and labelled, never mixed in unmarked. */
export async function gates(opts: { events?: number } = {}): Promise<GatesData> {
  const rows = (await query<Row>(`SELECT ${COLS} FROM engine_vfarm_gates ORDER BY created_at, id`)).rows;
  const offers = rows.filter((r) => r.kind === 'offer');
  const leadIds = [...new Set(offers.flatMap((o) => (Array.isArray(o.fields.linked_lead_ids) ? (o.fields.linked_lead_ids as string[]) : [])))];
  const leads = leadIds.length
    ? (await query<{ id: string; full_name: string; organization_name: string | null; stage: number; status: string }>(`SELECT id::text AS id, full_name, organization_name, stage, status FROM engine_vfarm_leads WHERE id::text = ANY($1::text[])`, [leadIds])).rows
    : [];
  const ev = await query<{ id: string; event_type: string; at: string; subject_id: string; actor: string | null; detail: Record<string, unknown> }>(
    `SELECT id, event_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, subject_id, actor, detail
       FROM engine_events WHERE event_type IN ('VFARM_STAGE1_STATE_CHANGED', 'VFARM_STAGE2_STATE_CHANGED', 'VFARM_CHECK_UPDATED', 'VFARM_OFFER_STATE_CHANGED', 'VFARM_GATE_ALERT_FAILED')
      ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(opts.events ?? 50, 0), 500)],
  );
  return {
    stage1: rows.filter((r) => r.kind === 'stage1').map(show),
    stage2: rows.filter((r) => r.kind === 'stage2').map(show),
    offers: offers.map((o) => ({
      ...show(o),
      linked_leads: (Array.isArray(o.fields.linked_lead_ids) ? (o.fields.linked_lead_ids as string[]) : []).map((id) => leads.find((l) => l.id === id)).filter((l): l is (typeof leads)[number] => !!l),
    })),
    fixtures: rows.filter((r) => r.is_fixture).length,
    contracts: CONTRACT,
    checks: CHECKS.map((c) => ({ name: c, label: CHECK_LABEL[c], recorded_by: SENSOR_BACKED.includes(c) ? 'sensor or a person' : 'a person' })),
    gates: ['Stage 2 stays planned until its Stage 1 record is passed.', 'An offer cannot be offered or signed without a Stage 2 record tied by stage2_ref.'],
    alert_channel_configured: !!alertChannel(),
    events: ev.rows.map((e) => ({ ...e, id: Number(e.id) })),
    note: 'Root-zone moisture, airflow velocity and early disease detection have no sensor behind them yet: they are recorded by a person, with who and when. Nothing here is automated detection for those three.',
  };
}

/** The offers each lead is tied to, real offers only, for the Early Access tab. */
export async function offersByLead(): Promise<Map<string, { id: string; status: string }[]>> {
  const r = await query<{ object_id: string; status: string; lead_id: string }>(
    `SELECT g.object_id, g.status, l.lead_id
       FROM engine_vfarm_gates g, jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.fields->'linked_lead_ids') = 'array' THEN g.fields->'linked_lead_ids' ELSE '[]'::jsonb END) AS l(lead_id)
      WHERE g.kind = 'offer' AND g.is_fixture IS NOT TRUE
      ORDER BY g.created_at`,
  );
  const out = new Map<string, { id: string; status: string }[]>();
  for (const row of r.rows) out.set(row.lead_id, [...(out.get(row.lead_id) ?? []), { id: row.object_id, status: row.status }]);
  return out;
}

/** Removes every fixture row and nothing else. The events they produced stay, marked fixture. */
export async function deleteFixtures(): Promise<{ deleted: string[] }> {
  const r = await query<{ object_id: string }>(`DELETE FROM engine_vfarm_gates WHERE is_fixture IS TRUE RETURNING object_id`);
  if (r.rows.length) events.changed('vfarm_gates', null);
  return { deleted: r.rows.map((x) => x.object_id) };
}
