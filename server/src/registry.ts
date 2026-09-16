/**
 * The System Registry: workflows, services and their billing, credentials,
 * endpoints, Airtable bases and people.
 *
 * Decision (2026-09-13, Destiny): **these six tables live in Postgres and this
 * dashboard is their system of record.** That is deliberately unlike every
 * other record kind in this app, which is a read model over Airtable — there is
 * no upstream table holding "what does BHA pay for and who manages it", so a
 * read model would have nothing to read. A row is created, edited and
 * soft-deleted here and nowhere else, and nothing syncs it anywhere.
 *
 * Two rules this module exists to hold:
 *
 *   1. **No secret value is ever stored.** The credentials table carries names,
 *      types, owners and what uses them. There is no column a value could go
 *      in, and adding one needs a migration and a decision, not a patch. As of
 *      2026-09-14 (Destiny) it is not served or shown either: there is no
 *      credentials registry, and there is not to be one. The table stays, and
 *      keeps its rows, because nothing drops a table.
 *   2. **A field nobody has filled in stays null.** Null renders as "—" and is
 *      counted separately from zero everywhere it matters — above all in the
 *      monthly spend total, which states how many services carry no cost so an
 *      incomplete figure can never read as a complete one.
 *
 * Every column this module will touch is declared in KINDS below. SQL is built
 * from that declaration and never from a caller's field names, so a request
 * naming a column that is not in the spec is a 422 rather than a query.
 */
import { query, withTransaction, type Queryable } from './pg';
import { nowIso, today } from './db';
import * as seed from './registrySeed';

export class RegistryError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

export type RegistryKind = 'workflows' | 'services' | 'credentials' | 'endpoints' | 'bases' | 'people';

type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'array' | 'select' | 'url';

interface Field {
  name: string;
  type: FieldType;
  /** The only accepted values, for a select. Lower-cased comparison, stored as given. */
  options?: readonly string[];
  /** Refused as empty on create. */
  required?: boolean;
  max?: number;
  /**
   * Written on create when the caller names no value. Only ever a *stated*
   * default, never an inferred one: a service being added to a registry is
   * active until someone says otherwise, and leaving it null would make it
   * count toward the spend denominator while displaying as "not recorded".
   */
  defaultOnCreate?: string;
}

interface KindSpec {
  table: string;
  label: string;
  /** What a new row's id is called, and whether the caller supplies it. */
  idLabel: string;
  idFromCaller: boolean;
  /** Sort key for the list, applied after the newest-first rule where there is no better one. */
  order: string;
  fields: readonly Field[];
  seed: seed.SeedRow[];
}

const STATUS_WORKFLOW = ['production', 'experimental', 'retired'] as const;
const STATUS_SERVICE = ['active', 'trial', 'retired'] as const;
const CATEGORIES = ['hosting', 'automation', 'data', 'ai', 'comms', 'storage', 'other'] as const;
const CYCLES = ['monthly', 'quarterly', 'yearly', 'one-off'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const KINDS: Record<RegistryKind, KindSpec> = {
  workflows: {
    table: 'registry_workflows',
    label: 'workflow',
    idLabel: 'n8n workflow id',
    idFromCaller: true,
    order: 'system NULLS LAST, folder NULLS LAST, name',
    seed: seed.WORKFLOWS,
    fields: [
      { name: 'name', type: 'text', required: true, max: 200 },
      { name: 'system', type: 'text', max: 80 },
      { name: 'folder', type: 'text', max: 120 },
      { name: 'pillar', type: 'text', max: 60 },
      { name: 'owner', type: 'text', max: 80 },
      { name: 'trigger_type', type: 'text', max: 60 },
      { name: 'trigger_detail', type: 'text', max: 400 },
      { name: 'status', type: 'select', options: STATUS_WORKFLOW, defaultOnCreate: 'production' },
      { name: 'purpose', type: 'longtext', max: 600 },
      { name: 'n8n_url', type: 'url', max: 500 },
      { name: 'notes', type: 'longtext', max: 2000 },
    ],
  },
  services: {
    table: 'registry_services',
    label: 'service',
    idLabel: 'id',
    idFromCaller: false,
    order: 'name',
    seed: seed.SERVICES,
    fields: [
      { name: 'name', type: 'text', required: true, max: 120 },
      { name: 'category', type: 'select', options: CATEGORIES },
      { name: 'what_it_is_for', type: 'longtext', max: 600 },
      { name: 'url', type: 'url', max: 500 },
      { name: 'managed_by', type: 'text', max: 80 },
      { name: 'plan', type: 'text', max: 120 },
      { name: 'billing_owner', type: 'text', max: 80 },
      { name: 'cost_amount', type: 'number' },
      { name: 'cost_currency', type: 'text', max: 8 },
      { name: 'billing_cycle', type: 'select', options: CYCLES },
      { name: 'renewal_date', type: 'date' },
      { name: 'status', type: 'select', options: STATUS_SERVICE, defaultOnCreate: 'active' },
      { name: 'notes', type: 'longtext', max: 2000 },
    ],
  },
  credentials: {
    table: 'registry_credentials',
    label: 'credential',
    idLabel: 'id',
    idFromCaller: false,
    order: 'name',
    seed: seed.CREDENTIALS,
    fields: [
      { name: 'name', type: 'text', required: true, max: 120 },
      { name: 'type', type: 'text', max: 80 },
      { name: 'used_by', type: 'array' },
      { name: 'owner', type: 'text', max: 80 },
      { name: 'notes', type: 'longtext', max: 2000 },
      // There is no value column here, and there is not to be one.
    ],
  },
  endpoints: {
    table: 'registry_endpoints',
    label: 'endpoint',
    idLabel: 'id',
    idFromCaller: false,
    order: 'owned_by_service NULLS LAST, name',
    seed: seed.ENDPOINTS,
    fields: [
      { name: 'name', type: 'text', required: true, max: 120 },
      { name: 'url', type: 'url', required: true, max: 500 },
      { name: 'method', type: 'select', options: METHODS },
      { name: 'auth_type', type: 'text', max: 80 },
      { name: 'owned_by_service', type: 'text', max: 120 },
      { name: 'what_calls_it', type: 'longtext', max: 600 },
      { name: 'notes', type: 'longtext', max: 2000 },
    ],
  },
  bases: {
    table: 'registry_airtable_bases',
    label: 'Airtable base',
    idLabel: 'base id',
    idFromCaller: true,
    order: 'name',
    seed: seed.AIRTABLE_BASES,
    fields: [
      { name: 'name', type: 'text', required: true, max: 120 },
      { name: 'what_it_is_for', type: 'longtext', max: 600 },
      { name: 'url', type: 'url', max: 500 },
      { name: 'notes', type: 'longtext', max: 2000 },
    ],
  },
  people: {
    table: 'registry_people',
    label: 'person',
    idLabel: 'id',
    idFromCaller: false,
    order: 'name',
    seed: seed.PEOPLE,
    fields: [
      { name: 'name', type: 'text', required: true, max: 120 },
      { name: 'slack_user_id', type: 'text', max: 40 },
      { name: 'email', type: 'text', max: 200 },
      { name: 'role', type: 'text', max: 120 },
      { name: 'lanes_owned', type: 'array' },
      { name: 'notes', type: 'longtext', max: 2000 },
    ],
  },
};

export const KIND_LIST = Object.keys(KINDS) as RegistryKind[];

export function isKind(v: string): v is RegistryKind {
  return Object.prototype.hasOwnProperty.call(KINDS, v);
}

/* ----------------------------------------------------------- validation */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Ids are slugs we generate or ids an upstream system already owns (rec…, app…, an n8n id). */
const ID = /^[A-Za-z0-9._-]{1,64}$/;

function fieldOf(kind: RegistryKind, name: string): Field {
  const f = KINDS[kind].fields.find((x) => x.name === name);
  if (!f) throw new RegistryError(`"${name}" is not a field a ${KINDS[kind].label} has.`);
  return f;
}

/**
 * One value, checked and normalised. An empty string is null, deliberately:
 * clearing a cell in the interface has to mean "nobody has filled this in"
 * rather than storing a blank that then reads as a real answer.
 */
function clean(field: Field, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;

  if (field.type === 'array') {
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(',')
        : null;
    if (list === null) throw new RegistryError(`"${field.name}" must be a list.`);
    const out = list.map((v) => String(v).trim()).filter(Boolean).slice(0, 200);
    return out;
  }

  if (field.type === 'number') {
    if (raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[, ]/g, ''));
    if (!Number.isFinite(n)) throw new RegistryError(`"${field.name}" must be a number.`);
    if (n < 0) throw new RegistryError(`"${field.name}" cannot be negative.`);
    return n;
  }

  const s = String(raw).trim();
  if (!s) return null;

  if (field.type === 'date') {
    if (!DATE.test(s)) throw new RegistryError(`"${field.name}" must be a date as YYYY-MM-DD.`);
    return s;
  }
  if (field.type === 'select') {
    const match = field.options?.find((o) => o.toLowerCase() === s.toLowerCase());
    if (!match) throw new RegistryError(`"${s}" is not one of: ${field.options?.join(', ')}.`);
    return match;
  }
  if (field.type === 'url' && !/^https?:\/\//i.test(s)) {
    throw new RegistryError(`"${field.name}" must start with http:// or https://.`);
  }
  return s.slice(0, field.max ?? 500);
}

/** Turns a caller's object into the columns and values to write. */
function values(kind: RegistryKind, input: Record<string, unknown>): { columns: string[]; params: unknown[] } {
  const columns: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'id' || k === 'created_at' || k === 'updated_at' || k === 'deleted_at') continue;
    const field = fieldOf(kind, k);
    columns.push(field.name);
    params.push(clean(field, v));
  }
  return { columns, params };
}

/** A readable, stable id from a name: "Google Workspace" → "google-workspace". */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || `row-${Date.now().toString(36)}`;
}

/* ---------------------------------------------------------------- reads */

export interface RegistryRow {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [field: string]: unknown;
}

export async function list(kind: RegistryKind, includeDeleted = false, on?: Queryable): Promise<RegistryRow[]> {
  const spec = KINDS[kind];
  const cols = ['id', ...spec.fields.map((f) => f.name), 'created_at', 'updated_at', 'deleted_at'].join(', ');
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const db = on ?? { query };
  const r = await db.query<RegistryRow>(`SELECT ${cols} FROM ${spec.table} ${where} ORDER BY ${spec.order}`);
  return r.rows;
}

async function one(kind: RegistryKind, id: string): Promise<RegistryRow> {
  const spec = KINDS[kind];
  const cols = ['id', ...spec.fields.map((f) => f.name), 'created_at', 'updated_at', 'deleted_at'].join(', ');
  const r = await query<RegistryRow>(`SELECT ${cols} FROM ${spec.table} WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new RegistryError(`No ${spec.label} with that id.`, 404);
  return r.rows[0];
}

/* --------------------------------------------------------------- writes */

export async function create(kind: RegistryKind, input: Record<string, unknown>): Promise<RegistryRow> {
  const spec = KINDS[kind];

  for (const f of spec.fields) {
    if (f.required && !String(input[f.name] ?? '').trim()) {
      throw new RegistryError(`A ${spec.label} needs a ${f.name.replace(/_/g, ' ')}.`);
    }
  }

  const given = String(input.id ?? '').trim();
  if (spec.idFromCaller && !given) throw new RegistryError(`A ${spec.label} needs its ${spec.idLabel}.`);
  if (given && !ID.test(given)) throw new RegistryError(`That ${spec.idLabel} has characters an id cannot hold.`);
  const id = given || slug(String(input.name ?? ''));

  // A declared default fills in only where the caller said nothing at all.
  const withDefaults = { ...input };
  for (const f of spec.fields) {
    if (f.defaultOnCreate !== undefined && (withDefaults[f.name] === undefined || withDefaults[f.name] === null || withDefaults[f.name] === '')) {
      withDefaults[f.name] = f.defaultOnCreate;
    }
  }

  const { columns, params } = values(kind, withDefaults);
  const at = nowIso();
  const all = ['id', ...columns, 'created_at', 'updated_at'];
  const placeholders = all.map((_, i) => `$${i + 1}`).join(', ');
  const cols = ['id', ...spec.fields.map((f) => f.name), 'created_at', 'updated_at', 'deleted_at'].join(', ');

  try {
    const r = await query<RegistryRow>(
      `INSERT INTO ${spec.table} (${all.join(', ')}) VALUES (${placeholders}) RETURNING ${cols}`,
      [id, ...params, at, at],
    );
    return r.rows[0];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A soft-deleted row still holds its id, so this is the likely collision.
    if (/duplicate key/i.test(message)) {
      throw new RegistryError(`A ${spec.label} with the id "${id}" already exists. It may be one you deleted — show deleted rows to restore it.`, 409);
    }
    throw e;
  }
}

/** Edits whichever fields were sent. Anything not named is left alone. */
export async function update(kind: RegistryKind, id: string, input: Record<string, unknown>): Promise<RegistryRow> {
  const spec = KINDS[kind];
  const { columns, params } = values(kind, input);
  if (!columns.length) throw new RegistryError('Nothing to change.');

  const sets = columns.map((c, i) => `${c} = $${i + 2}`);
  sets.push(`updated_at = $${columns.length + 2}`);
  const cols = ['id', ...spec.fields.map((f) => f.name), 'created_at', 'updated_at', 'deleted_at'].join(', ');

  const r = await query<RegistryRow>(
    `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING ${cols}`,
    [id, ...params, nowIso()],
  );
  if (!r.rows[0]) throw new RegistryError(`No ${spec.label} with that id.`, 404);
  return r.rows[0];
}

/**
 * Soft delete, and its undo. The row keeps its id and its history; it simply
 * stops being listed. Nothing here deletes a row outright — the whole point of
 * a registry is that "we used to pay for this" is an answer too.
 */
export async function setDeleted(kind: RegistryKind, id: string, deleted: boolean): Promise<RegistryRow> {
  const spec = KINDS[kind];
  const cols = ['id', ...spec.fields.map((f) => f.name), 'created_at', 'updated_at', 'deleted_at'].join(', ');
  const r = await query<RegistryRow>(
    `UPDATE ${spec.table} SET deleted_at = $2, updated_at = $3 WHERE id = $1 RETURNING ${cols}`,
    [id, deleted ? nowIso() : null, nowIso()],
  );
  if (!r.rows[0]) throw new RegistryError(`No ${spec.label} with that id.`, 404);
  return r.rows[0];
}

export { one as read };

/* ---------------------------------------------------------------- spend */

export interface SpendTotal {
  currency: string;
  monthly: number;
  services: number;
}

export interface Spend {
  /** One total per currency. Two currencies are never added together. */
  totals: SpendTotal[];
  /** Active services altogether, and how many of them carry a cost. */
  active: number;
  priced: number;
  /** Active services with no cost_amount. The reason a total is not the whole bill. */
  unpriced: number;
  /** Priced, but with no billing cycle or a one-off one, so not part of a monthly figure. */
  not_monthly: number;
  /**
   * Which ones (2026-09-16, Destiny). A cost typed onto a row with no billing
   * cycle is correctly left out of a monthly total — sixty dollars is not
   * sixty dollars a month until somebody says so — but the card only said how
   * many, which reads as "I entered a cost and nothing happened". Naming them
   * turns a count into the one thing left to fill in.
   */
  not_monthly_ids: string[];
  /** Ids renewing within thirty days, and any already past. */
  renewing_soon: string[];
  overdue: string[];
  with_renewal_date: number;
  today: string;
}

const PER_MONTH: Record<string, number | null> = {
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
  'one-off': null,
};

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * What the interface is actually paying for, per month, computed from the rows
 * rather than typed in anywhere.
 *
 * The counts beside the total are the point of this function. A total built
 * from two of eleven services is not a monthly spend, and the page has to be
 * able to say so in the same breath as the number — which it can only do if
 * the server hands it both.
 */
export function spendOf(services: RegistryRow[]): Spend {
  const now = today();
  const active = services.filter((s) => s.status !== 'retired' && !s.deleted_at);

  const byCurrency = new Map<string, { monthly: number; services: number }>();
  let priced = 0;
  const notMonthlyIds: string[] = [];

  for (const s of active) {
    const amount = typeof s.cost_amount === 'number' ? s.cost_amount : s.cost_amount === null ? null : Number(s.cost_amount);
    if (amount === null || !Number.isFinite(amount)) continue;
    priced++;
    const cycle = typeof s.billing_cycle === 'string' ? s.billing_cycle : null;
    const factor = cycle ? PER_MONTH[cycle] : null;
    if (factor === null || factor === undefined) {
      notMonthlyIds.push(s.id);
      continue;
    }
    // A cost with no currency is still a real cost; it is grouped under the
    // dash rather than silently folded into whatever else is there.
    const currency = (typeof s.cost_currency === 'string' && s.cost_currency.trim()) || '—';
    const at = byCurrency.get(currency) ?? { monthly: 0, services: 0 };
    at.monthly += amount * factor;
    at.services++;
    byCurrency.set(currency, at);
  }

  const withRenewal = active.filter((s) => typeof s.renewal_date === 'string' && DATE.test(s.renewal_date));
  const renewing: string[] = [];
  const overdue: string[] = [];
  for (const s of withRenewal) {
    const d = days(now, s.renewal_date as string);
    if (d < 0) overdue.push(s.id);
    else if (d <= 30) renewing.push(s.id);
  }

  return {
    totals: [...byCurrency.entries()]
      .map(([currency, v]) => ({ currency, monthly: Math.round(v.monthly * 100) / 100, services: v.services }))
      .sort((a, b) => b.monthly - a.monthly),
    active: active.length,
    priced,
    unpriced: active.length - priced,
    not_monthly: notMonthlyIds.length,
    not_monthly_ids: notMonthlyIds,
    renewing_soon: renewing,
    overdue,
    with_renewal_date: withRenewal.length,
    today: now,
  };
}

/* ----------------------------------------------------------------- seed */

/**
 * Puts the opening contents in, once. `ON CONFLICT DO NOTHING` is the whole
 * mechanism: a row that exists is left exactly as it is, including one that was
 * edited and one that was soft-deleted, because a soft-deleted row still holds
 * its id and must not be resurrected by a restart.
 */
export async function seedRegistry(): Promise<Record<RegistryKind, number>> {
  const inserted = {} as Record<RegistryKind, number>;
  await withTransaction(async (db) => {
    for (const kind of KIND_LIST) {
      const spec = KINDS[kind];
      let n = 0;
      for (const row of spec.seed) {
        const { columns, params } = values(kind, row as Record<string, unknown>);
        const at = nowIso();
        const all = ['id', ...columns, 'created_at', 'updated_at'];
        const placeholders = all.map((_, i) => `$${i + 1}`).join(', ');
        const r = await db.query(
          `INSERT INTO ${spec.table} (${all.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          [row.id, ...params, at, at],
        );
        n += r.rowCount ?? 0;
      }
      inserted[kind] = n;
    }
  });
  return inserted;
}
