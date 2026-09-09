/**
 * The record store: loops, Codex entries, build patterns and commercial cards
 * as this dashboard holds them, plus the status-change history the counts on
 * those pages are computed from.
 *
 * Decision (2026-09-09, Destiny): the service runs on Render's free instance
 * type, which has no persistent disk. DATA_DIR is ephemeral — this SQLite file
 * is wiped on every deploy and every spin-down after inactivity. So:
 *
 *   - Airtable is the source of truth for every kind. Rows here are a read
 *     model, keyed by Airtable record id, rebuilt by sync.ts from the bases.
 *   - Every write from the interface goes through to Airtable first and is
 *     recorded here only from what Airtable sent back. If Airtable refuses,
 *     nothing changes here. Nothing is designed to survive a restart.
 *   - The events table is the only place a status change is timestamped
 *     (the loop tables carry no close date). It is real from the moment this
 *     instance booted and resets with it; every metric derived from it says
 *     so, and one the rows cannot support is null with a note.
 *
 * No fixture is seeded for these four kinds any more. With no AIRTABLE_API_KEY
 * the pages are empty and say why, which is the truth.
 */
import type { AtRecord } from './airtable';
import * as airtable from './airtable';
import type {
  BuildPattern,
  BuildPatternDetail,
  CodexEntry,
  CodexMetrics,
  CommercialMetrics,
  Loop,
  LoopMetrics,
  LoopStatus,
  Metric,
  MetricSeries,
  NewLoop,
  Opportunity,
  OwnerTotals,
  PatternMetrics,
  RecordKind,
  RecordMetrics,
  SeriesPoint,
  SyncInfo,
} from '../../src/data/types';
import { getMeta, nowIso, openDb, setMeta, today } from './db';
import {
  CODEX,
  CODEX_EDITABLE,
  COMMERCIAL,
  LOOP_LANE_TAGS,
  LOOP_STATUS_TO_AIRTABLE,
  LOOP_TABLES,
  LOOPS_BASE,
  PATTERNS,
  codexBucket,
  isoWeek,
  loopTable,
  loopTableById,
  mapCodex,
  mapLoop,
  mapOpportunity,
  mapPattern,
  patternSummary,
} from './sources';

export type { RecordKind, RecordMetrics, Metric };
export const KINDS: RecordKind[] = ['loops', 'codex', 'patterns', 'commercial'];

/** Status vocabularies, in the dashboard's words. Loops and patterns and cards are the table's own selects lower-cased or verbatim. */
export const STATUSES: Record<RecordKind, readonly string[]> = {
  loops: ['open', 'in progress', 'closed'],
  codex: ['jason', 'destiny', 'builder', 'other', 'none'],
  patterns: ['draft', 'canonical'],
  commercial: ['INCUBATE', 'Research-First', 'Media-Ready'],
};

export interface Row {
  kind: RecordKind;
  id: string;
  key: string | null;
  json: string;
  status: string;
  builder: string | null;
  raised_at: string | null;
  closed_at: string | null;
  updated_at: string;
  source: string;
  table_id: string;
  synced_at: string;
}

export class StoreError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ dates */

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}
function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastWeeks(n: number): string[] {
  const out: string[] = [];
  let w = weekStart(today());
  for (let i = 0; i < n; i++) {
    out.unshift(w);
    w = addDays(w, -7);
  }
  return out;
}

/* ---------------------------------------------------------------- schema */

/** Bumped when the row shape changes; the store is ephemeral so a rebuild is the honest migration. */
const SCHEMA_VERSION = '2';

export function ensureSchema(): void {
  const db = openDb();
  if (getMeta('schema_version') !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS snapshots; DROP TABLE IF EXISTS observations;');
    db.exec(`DELETE FROM meta WHERE key NOT IN ('history_since')`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      key TEXT,
      json TEXT NOT NULL,
      status TEXT NOT NULL,
      builder TEXT,
      raised_at TEXT,
      closed_at TEXT,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,
      table_id TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS records_kind_table ON records (kind, table_id);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      builder TEXT,
      from_status TEXT,
      to_status TEXT NOT NULL,
      via TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at);
    CREATE TABLE IF NOT EXISTS observations (
      kind TEXT NOT NULL,
      metric TEXT NOT NULL,
      at TEXT NOT NULL,
      value REAL NOT NULL
    );
  `);
  if (!getMeta('history_since')) setMeta('history_since', nowIso());
  setMeta('schema_version', SCHEMA_VERSION);
}

/* ------------------------------------------------------------------ rows */

function rows(kind: RecordKind, table?: string): Row[] {
  const db = openDb();
  return (table
    ? db.prepare('SELECT * FROM records WHERE kind = ? AND table_id = ?').all(kind, table)
    : db.prepare('SELECT * FROM records WHERE kind = ?').all(kind)) as unknown as Row[];
}
function rowById(kind: RecordKind, id: string): Row | null {
  return (openDb().prepare('SELECT * FROM records WHERE kind = ? AND id = ?').get(kind, id) as unknown as Row | undefined) ?? null;
}

type Mapped =
  | { kind: 'loops'; obj: Loop }
  | { kind: 'codex'; obj: CodexEntry }
  | { kind: 'patterns'; obj: BuildPatternDetail }
  | { kind: 'commercial'; obj: Opportunity };

function statusOf(m: Mapped): string {
  switch (m.kind) {
    case 'loops':
      return m.obj.status;
    case 'codex':
      return codexBucket(m.obj.action_required);
    case 'patterns':
      return m.obj.status;
    case 'commercial':
      return m.obj.readiness_state ?? 'unset';
  }
}
function keyOf(m: Mapped): string | null {
  switch (m.kind) {
    case 'loops':
      return m.obj.loop_id;
    case 'codex':
      return m.obj.card_id;
    case 'patterns':
      return m.obj.pattern_id;
    case 'commercial':
      return m.obj.card_id;
  }
}
function builderOf(m: Mapped): string | null {
  return m.kind === 'loops' ? m.obj.owner : m.kind === 'codex' ? m.obj.builder_id : null;
}
function raisedOf(m: Mapped): string | null {
  switch (m.kind) {
    case 'loops':
      return m.obj.raised_at;
    case 'codex':
      return m.obj.logged_at ? m.obj.logged_at.slice(0, 10) : null;
    case 'patterns':
      return m.obj.created_at ? m.obj.created_at.slice(0, 10) : null;
    case 'commercial':
      return m.obj.created_at ? m.obj.created_at.slice(0, 10) : null;
  }
}
const TERMINAL: Partial<Record<RecordKind, string>> = { loops: 'closed' };

/**
 * Writes one mapped record over whatever is held for it. Idempotent: the same
 * record twice is one row. A status that differs from the held row is recorded
 * as an event, stamped `at` (an inbound payload's own time, else now).
 */
export function upsert(m: Mapped, table: string, via: 'airtable' | 'inbound' | 'ui', at = nowIso()): { changed: boolean; inserted: boolean } {
  const db = openDb();
  const prev = rowById(m.kind, m.obj.id);
  const status = statusOf(m);
  const terminal = TERMINAL[m.kind];
  let closedAt = prev?.closed_at ?? null;
  if (terminal) {
    if (status === terminal && prev && prev.status !== terminal) closedAt = at.slice(0, 10);
    if (status !== terminal) closedAt = null;
  }
  const obj: Record<string, unknown> = { ...m.obj, closed_at: closedAt };
  if (prev) {
    const held = JSON.parse(prev.json) as { note?: string | null };
    if (held.note && obj.note == null) obj.note = held.note;
  }
  db.prepare(
    `INSERT INTO records (kind, id, key, json, status, builder, raised_at, closed_at, updated_at, source, table_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET key = excluded.key, json = excluded.json, status = excluded.status, builder = excluded.builder,
       raised_at = excluded.raised_at, closed_at = excluded.closed_at, updated_at = excluded.updated_at, source = excluded.source,
       table_id = excluded.table_id, synced_at = excluded.synced_at`,
  ).run(m.kind, m.obj.id, keyOf(m), JSON.stringify(obj), status, builderOf(m), raisedOf(m), closedAt, at, via, table, at);
  bumpVersion();
  const changed = !prev || prev.status !== status;
  if (changed) {
    db.prepare('INSERT INTO events (kind, record_id, builder, from_status, to_status, via, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      m.kind,
      m.obj.id,
      builderOf(m),
      prev?.status ?? null,
      status,
      via,
      at,
    );
  }
  return { changed: Boolean(prev) && prev!.status !== status, inserted: !prev };
}

/** Removes rows of one table that a full read of that table no longer contains. */
export function purgeMissing(kind: RecordKind, table: string, keep: Set<string>): number {
  const db = openDb();
  const held = rows(kind, table);
  let n = 0;
  for (const r of held) {
    if (!keep.has(r.id)) {
      db.prepare('DELETE FROM records WHERE kind = ? AND id = ?').run(kind, r.id);
      n++;
    }
  }
  if (n) bumpVersion();
  return n;
}

export function mapRecord(kind: RecordKind, rec: AtRecord, table: string): Mapped {
  switch (kind) {
    case 'loops': {
      const t = loopTableById(table);
      if (!t) throw new StoreError(`${table} is not one of the builder tables.`, 422);
      return { kind, obj: mapLoop(rec, t.owner, table) };
    }
    case 'codex':
      return { kind, obj: mapCodex(rec) };
    case 'patterns':
      return { kind, obj: mapPattern(rec) };
    case 'commercial':
      return { kind, obj: mapOpportunity(rec) };
  }
}

/* ------------------------------------------------------------------ reads */

function hydrateLoop(r: Row): Loop {
  const base = JSON.parse(r.json) as Loop;
  const end = r.closed_at ?? today();
  return { ...base, status: r.status as LoopStatus, closed_at: r.closed_at, age_days: r.raised_at ? Math.max(0, dayDiff(r.raised_at, end)) : 0 };
}
export function loops(): Loop[] {
  return rows('loops').map(hydrateLoop);
}
export function codexEntries(): CodexEntry[] {
  return rows('codex').map((r) => JSON.parse(r.json) as CodexEntry);
}
export function patterns(): BuildPattern[] {
  return rows('patterns').map((r) => patternSummary(JSON.parse(r.json) as BuildPatternDetail));
}
export function patternDetail(id: string): BuildPatternDetail | null {
  const r = rowById('patterns', id);
  return r ? (JSON.parse(r.json) as BuildPatternDetail) : null;
}
/** Case-insensitive search across every text field of every pattern. */
export function searchPatterns(q: string): BuildPattern[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return patterns();
  const terms = needle.split(/\s+/).filter(Boolean);
  return rows('patterns')
    .filter((r) => {
      const hay = r.json.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .map((r) => patternSummary(JSON.parse(r.json) as BuildPatternDetail));
}
export function opportunities(): Opportunity[] {
  return rows('commercial').map((r) => JSON.parse(r.json) as Opportunity);
}

export function loopsByOwner(): OwnerTotals[] {
  const all = loops();
  return LOOP_TABLES.map((t) => {
    const mine = all.filter((l) => l.owner === t.owner);
    const open = mine.filter((l) => l.status !== 'closed');
    return {
      owner: t.owner,
      open: mine.filter((l) => l.status === 'open').length,
      in_progress: mine.filter((l) => l.status === 'in progress').length,
      closed: mine.filter((l) => l.status === 'closed').length,
      oldest_days: open.length ? Math.max(...open.map((l) => l.age_days)) : 0,
    };
  }).filter((o) => o.open + o.in_progress + o.closed > 0);
}

/* ------------------------------------------------------------------- sync */

export interface SyncState {
  synced_at: string | null;
  error: string | null;
  tables: { table: string; label: string; n: number }[];
}
export function syncState(kind: RecordKind): SyncState {
  const raw = getMeta(`sync:${kind}`);
  return raw ? (JSON.parse(raw) as SyncState) : { synced_at: null, error: null, tables: [] };
}
export function setSyncState(kind: RecordKind, s: SyncState): void {
  setMeta(`sync:${kind}`, JSON.stringify(s));
}
export function syncInfo(kind: RecordKind): SyncInfo {
  const s = syncState(kind);
  return {
    kind,
    source: s.synced_at ? 'airtable' : 'none',
    synced_at: s.synced_at,
    error: s.error,
    tables: s.tables,
    write_through: airtable.airtableConfigured(),
  };
}

export function observe(kind: RecordKind, metric: string, value: number): void {
  openDb().prepare('INSERT INTO observations (kind, metric, at, value) VALUES (?, ?, ?, ?)').run(kind, metric, nowIso(), value);
  bumpVersion();
}
export function cardTrend(id: string): MetricSeries {
  const obs = observations('commercial', `unresolved:${id}`);
  const days = new Set(obs.map((o) => o.at.slice(0, 10)));
  return days.size >= 2
    ? { points: obs.map((o) => ({ label: o.at.slice(5, 10), value: Math.round(o.value) })), note: 'missing_research_count as observed at each resync. Observations reset with the instance on the free plan.' }
    : { points: null, note: obs.length ? `Seen on one day only (${[...days][0]}); a trend needs at least two.` : 'Not observed yet.' };
}
function observations(kind: RecordKind, metric: string): { at: string; value: number }[] {
  return openDb().prepare('SELECT at, value FROM observations WHERE kind = ? AND metric = ? ORDER BY at').all(kind, metric) as unknown as { at: string; value: number }[];
}

/* ----------------------------------------------------------------- writes */

function requireWrite(): void {
  if (!airtable.airtableConfigured()) {
    throw new StoreError('Airtable is the source of truth and this server has no AIRTABLE_API_KEY, so the change was not made.', 503);
  }
}

async function writeThrough(kind: RecordKind, r: Row, fields: Record<string, unknown>): Promise<Mapped> {
  requireWrite();
  const base = kind === 'loops' ? LOOPS_BASE : kind === 'codex' ? CODEX.base : kind === 'patterns' ? PATTERNS.base : COMMERCIAL.base;
  let rec: AtRecord;
  try {
    rec = await airtable.updateRecord(base, r.table_id, r.id, fields);
  } catch (e) {
    if (e instanceof airtable.AirtableError) throw new StoreError(`Airtable did not accept the change: ${e.message}`, e.status === 0 ? 502 : e.status >= 500 ? 502 : e.status);
    throw e;
  }
  return mapRecord(kind, rec, r.table_id);
}

/**
 * Changes one record's status. Airtable first; the held row is then replaced
 * by what Airtable returned, and the change is recorded as an event.
 */
export async function setStatus(kind: RecordKind, id: string, status: string, note?: string): Promise<Loop | CodexEntry | BuildPattern | Opportunity> {
  if (!STATUSES[kind].includes(status)) {
    throw new StoreError(`"${status}" is not a status a ${kind === 'loops' ? 'loop' : kind === 'codex' ? 'Codex entry' : kind === 'patterns' ? 'pattern' : 'card'} can have.`, 422);
  }
  const r = rowById(kind, id);
  if (!r) throw new StoreError('That record is not held by this dashboard.', 404);
  if (kind === 'codex') throw new StoreError('A Codex entry has no status of its own; change its action_required instead.', 422);
  const fields: Record<string, unknown> =
    kind === 'loops' ? { Status: LOOP_STATUS_TO_AIRTABLE[status as LoopStatus] } : kind === 'patterns' ? { pattern_status: status } : { readiness_state: status };
  const m = await writeThrough(kind, r, fields);
  if (note !== undefined) (m.obj as { note?: string | null }).note = note.trim() || null;
  upsert(m, r.table_id, 'ui');
  return read(kind, id)!;
}

/** Edits a Codex entry's own fields. Airtable first, then the held row from what came back. */
export async function updateFields(kind: RecordKind, id: string, fields: Record<string, unknown>): Promise<CodexEntry | Opportunity | BuildPatternDetail | Loop> {
  const r = rowById(kind, id);
  if (!r) throw new StoreError('That record is not held by this dashboard.', 404);
  const allowed = kind === 'codex' ? CODEX_EDITABLE : kind === 'loops' ? new Set(['What', 'lane_tag', 'raised_in', 'Raised By']) : new Set<string>();
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) throw new StoreError(`"${k}" is not a field this dashboard edits.`, 422);
    if (k === 'lane_tag' && v !== null && !(LOOP_LANE_TAGS as string[]).includes(String(v))) throw new StoreError('That lane_tag is not one the loop tables define.', 422);
    clean[k] = typeof v === 'string' ? v.trim() || null : v;
  }
  if (!Object.keys(clean).length) throw new StoreError('Nothing to change.', 422);
  const m = await writeThrough(kind, r, clean);
  upsert(m, r.table_id, 'ui');
  const out = rowById(kind, id)!;
  return kind === 'loops' ? hydrateLoop(out) : (JSON.parse(out.json) as CodexEntry | Opportunity | BuildPatternDetail);
}

export async function createLoop(input: NewLoop): Promise<Loop> {
  requireWrite();
  const title = (input.title ?? '').trim();
  if (!title) throw new StoreError('A loop needs a title.', 422);
  const t = loopTable(input.owner);
  if (!t) throw new StoreError('The owner must be one of the builders with a loops table.', 422);
  if (!(LOOP_LANE_TAGS as string[]).includes(input.lane_tag)) throw new StoreError('That lane_tag is not one the loop tables define.', 422);
  const fields: Record<string, unknown> = {
    What: title,
    Status: 'Open',
    'Date Raised': today(),
    lane_tag: input.lane_tag,
    loop_id: `LOOP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    raised_in: 'bha-engine-dashboard',
  };
  if (input.raised_by?.trim()) fields['Raised By'] = input.raised_by.trim();
  let rec: AtRecord;
  try {
    rec = await airtable.createRecord(LOOPS_BASE, t.table, fields);
  } catch (e) {
    if (e instanceof airtable.AirtableError) throw new StoreError(`Airtable did not accept the new loop: ${e.message}`, e.status === 0 ? 502 : e.status >= 500 ? 502 : e.status);
    throw e;
  }
  const m = mapRecord('loops', rec, t.table);
  if (input.note?.trim()) (m.obj as Loop).note = input.note.trim();
  upsert(m, t.table, 'ui');
  return hydrateLoop(rowById('loops', rec.id)!);
}

/** Applies a record n8n pushed after writing it to Airtable. Idempotent by record id. */
export async function applyInbound(kind: RecordKind, payload: { id: string; table?: string; record?: AtRecord; at?: string }): Promise<{ changed: boolean; inserted: boolean; record: unknown }> {
  const id = payload.id;
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new StoreError('An Airtable record id (rec…) is required.', 422);
  let table = payload.table ?? rowById(kind, id)?.table_id ?? null;
  if (kind !== 'loops') table = kind === 'codex' ? CODEX.table : kind === 'patterns' ? PATTERNS.table : COMMERCIAL.table;
  if (!table) throw new StoreError('Which builder table the loop lives in is required (table or builder).', 422);
  if (kind === 'loops' && !loopTableById(table)) throw new StoreError(`${table} is not one of the builder tables.`, 422);
  let rec = payload.record;
  if (!rec) {
    // The payload named the record but did not carry it: read it from Airtable, the source of truth.
    requireWrite();
    const base = kind === 'loops' ? LOOPS_BASE : kind === 'codex' ? CODEX.base : kind === 'patterns' ? PATTERNS.base : COMMERCIAL.base;
    try {
      rec = await airtable.getRecord(base, table, id);
    } catch (e) {
      if (e instanceof airtable.AirtableError) throw new StoreError(`Could not read ${id} from Airtable: ${e.message}`, e.status === 404 ? 404 : 502);
      throw e;
    }
  }
  if (rec.id !== id) throw new StoreError('The record in the body does not match the id.', 422);
  const m = mapRecord(kind, rec, table);
  const at = payload.at && Number.isFinite(Date.parse(payload.at)) ? new Date(payload.at).toISOString() : nowIso();
  const res = upsert(m, table, 'inbound', at);
  return { ...res, record: read(kind, id) };
}

export function removeInbound(kind: RecordKind, id: string): boolean {
  const r = rowById(kind, id);
  if (!r) return false;
  openDb().prepare('DELETE FROM records WHERE kind = ? AND id = ?').run(kind, id);
  bumpVersion();
  return true;
}

export function read(kind: RecordKind, id: string): Loop | CodexEntry | BuildPattern | Opportunity | null {
  const r = rowById(kind, id);
  if (!r) return null;
  switch (kind) {
    case 'loops':
      return hydrateLoop(r);
    case 'patterns':
      return patternSummary(JSON.parse(r.json) as BuildPatternDetail);
    default:
      return JSON.parse(r.json) as CodexEntry | Opportunity;
  }
}

/* ---------------------------------------------------------------- metrics */

function series(points: SeriesPoint[] | null, note: string | null): MetricSeries {
  return { points, note };
}

/** "7–13 Sep" from a week-start day. */
function weekLabel(start: string): string {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(a);
  b.setUTCDate(a.getUTCDate() + 6);
  const mon = (d: Date) => d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${mon(a)}` : `${a.getUTCDate()} ${mon(a)}–${b.getUTCDate()} ${mon(b)}`;
}

/**
 * last_modified (a LAST_MODIFIED_TIME() formula) was added to the loop tables
 * on 9 Sept 2026. Every loop that existed then stamps from that day, so a
 * stamp on or before it says nothing about when the loop really changed.
 * Only stamps strictly after that day are treated as real changes.
 */
const MODIFIED_FIELD_ADDED = '2026-09-09';
const MODIFIED_MEANINGFUL_FROM = '2026-09-23'; // fourteen days on
const MODIFIED_NOTE = `Derived from the tables' last_modified field, added ${MODIFIED_FIELD_ADDED.slice(8)} Sept 2026. Every loop that existed that day stamps from it, so this is only meaningful for changes after 9 Sept 2026 and is not history before then.`;
const NO_CLOSE_DATE = 'The loop tables carry no close date. Closes are timestamped only when they pass through this dashboard or are pushed by n8n, and that history resets with the instance on the free plan.';

function modifiedAfterAdded(iso: string | null): boolean {
  return Boolean(iso && iso.slice(0, 10) > MODIFIED_FIELD_ADDED);
}

/** The per-builder figures are the same computation over a subset; memoised per store version. */
const metricsCache = new Map<string, { version: number; value: RecordMetrics }>();
let storeVersion = 0;
export function bumpVersion(): void {
  storeVersion++;
}

function loopMetricsFor(all: Loop[], builder: string | null, historySince: string | null): LoopMetrics {
  const openRows = all.filter((l) => l.status !== 'closed');
  const now = today();

  const byOwner = LOOP_TABLES.filter((t) => !builder || t.owner === builder)
    .map((t) => {
      const mine = all.filter((l) => l.owner === t.owner);
      const closed = mine.filter((l) => l.status === 'closed').length;
      return { owner: t.owner, closed, total: mine.length, rate: mine.length ? Math.round((closed / mine.length) * 100) : null };
    })
    .filter((o) => o.total > 0);

  const closeEvents = (openDb()
    .prepare(`SELECT at, builder FROM events WHERE kind = 'loops' AND to_status = 'closed' AND via IN ('ui', 'inbound') ORDER BY at`)
    .all() as unknown as { at: string; builder: string | null }[]).filter((e) => !builder || e.builder === builder);
  const closedPerDay: MetricSeries = closeEvents.length
    ? series(
        (() => {
          const days: string[] = [];
          for (let i = 13; i >= 0; i--) days.push(addDays(now, -i));
          return days.map((d) => ({ label: d.slice(5), value: closeEvents.filter((e) => e.at.slice(0, 10) === d).length }));
        })(),
        `Closes made through this dashboard or pushed by n8n since ${(historySince ?? '').slice(0, 10)}. ${NO_CLOSE_DATE}`,
      )
    : series(null, NO_CLOSE_DATE);

  const dated = openRows.filter((l) => l.raised_at);
  // Newest first, oldest last.
  const buckets: [string, (d: number) => boolean][] = [
    ['0–7 days', (d) => d <= 7],
    ['8–14 days', (d) => d > 7 && d <= 14],
    ['15–30 days', (d) => d > 14 && d <= 30],
    ['31–60 days', (d) => d > 30 && d <= 60],
    ['over 60 days', (d) => d > 60],
  ];
  const undated = openRows.length - dated.length;
  const ageDistribution = buckets.map(([bucket, test]) => ({ bucket, n: dated.filter((l) => test(l.age_days)).length }));
  if (undated) ageDistribution.push({ bucket: 'no date raised', n: undated });

  const weeks = lastWeeks(8);
  const raisedPerWeek = series(
    weeks.map((w) => ({ label: weekLabel(w), value: all.filter((l) => l.raised_at && weekStart(l.raised_at) === w).length })),
    `Loops by the week they were raised (Date Raised), last eight weeks.`,
  );

  // Closes by week of last_modified: a closed loop's last change is taken as its close. Only stamps
  // after the field was added count; the backfill stamp on 9 Sept is not a close.
  const realCloses = all.filter((l) => l.status === 'closed' && modifiedAfterAdded(l.last_modified));
  const fromWeek = weekStart(MODIFIED_FIELD_ADDED);
  const modWeeks = weeks.filter((w) => w >= fromWeek);
  const closedPerWeek = series(
    modWeeks.map((w) => ({ label: weekLabel(w), value: realCloses.filter((l) => weekStart(l.last_modified!.slice(0, 10)) === w).length })),
    `Closed loops by the week of their last change. A closed loop's last_modified is taken as its close, which is exact only when the close was the last edit. ${MODIFIED_NOTE}`,
  );
  const netPerWeek = series(
    modWeeks.map((w) => ({
      label: weekLabel(w),
      value: all.filter((l) => l.raised_at && weekStart(l.raised_at) === w).length - realCloses.filter((l) => weekStart(l.last_modified!.slice(0, 10)) === w).length,
    })),
    `Raised (Date Raised) minus closed (last_modified) per week, from the week the field was added. Weeks before it have no close count and are not shown. ${MODIFIED_NOTE}`,
  );

  const cutoff = addDays(now, -14);
  const staleRows = openRows.filter((l) => l.last_modified && l.last_modified.slice(0, 10) < cutoff);
  const stale = {
    count: staleRows.length,
    meaningful_from: MODIFIED_MEANINGFUL_FROM,
    note:
      now < MODIFIED_MEANINGFUL_FROM
        ? `Open loops whose last_modified is more than fourteen days ago. Every loop stamps from 9 Sept 2026, so nothing can read as stale before 23 Sept 2026; this figure is not yet meaningful. ${MODIFIED_NOTE}`
        : `Open loops whose last_modified is more than fourteen days ago. ${MODIFIED_NOTE}`,
  };

  const laneTags = [...LOOP_LANE_TAGS, null];
  const openByLane = laneTags
    .map((t) => ({ lane_tag: t ?? '(no lane_tag)', n: openRows.filter((l) => l.lane_tag === t).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const raisers = new Map<string, number>();
  for (const l of all) if (l.raised_by) raisers.set(l.raised_by, (raisers.get(l.raised_by) ?? 0) + 1);
  const topRaisers = [...raisers.entries()]
    .map(([raised_by, n]) => ({ raised_by, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  return {
    kind: 'loops',
    computed_at: nowIso(),
    scope: { builder, rows: all.length },
    open: all.filter((l) => l.status === 'open').length,
    in_progress: all.filter((l) => l.status === 'in progress').length,
    closed: all.filter((l) => l.status === 'closed').length,
    close_rate_by_builder: byOwner,
    close_rate_note: 'Closed as a share of every loop in the builder’s table today. It is a state, not a rate over time: nothing records when a loop closed.',
    closed_per_day: closedPerDay,
    age_distribution: ageDistribution,
    raised_per_week: raisedPerWeek,
    net_per_week: netPerWeek,
    closed_per_week: closedPerWeek,
    stale,
    open_by_lane_tag: openByLane,
    top_raisers: topRaisers,
    modified_note: MODIFIED_NOTE,
    history_since: historySince,
  };
}

export function loopMetrics(builder: string | null): LoopMetrics {
  const key = `loops:${builder ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as LoopMetrics;
  const all = loops();
  const historySince = getMeta('history_since');
  const value: LoopMetrics = builder
    ? loopMetricsFor(all.filter((l) => l.owner === builder), builder, historySince)
    : {
        ...loopMetricsFor(all, null, historySince),
        // One pass per builder, computed here once and cached, so a tab change on the page needs no request.
        by_builder: Object.fromEntries(
          LOOP_TABLES.filter((t) => all.some((l) => l.owner === t.owner)).map((t) => [t.owner, loopMetricsFor(all.filter((l) => l.owner === t.owner), t.owner, historySince)]),
        ),
      };
  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

const LAYER0_DEFINITION = 'A log counts as complete when the row carries a builder, a session link, a session type, a verdict, and the architecture-fit, engine-movement and needle-moved-evidence fields. This is the dashboard’s own check; the Codex Log has no completeness field.';

export function codexMetrics(builder: string | null): CodexMetrics {
  const key = `codex:${builder ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as CodexMetrics;
  const all = codexEntries().filter((e) => !builder || e.builder_id === builder);
  const attributed = all.filter((e) => e.builder_id);
  const complete = all.filter((e) => e.complete).length;
  const pending = all.filter((e) => codexBucket(e.action_required) === 'jason').length;
  const evaluated = all.filter((e) => e.verdict || e.narration_quality).length;
  const owners = [...new Set(attributed.map((e) => e.builder_id as string))].sort();
  const weekStarts = lastWeeks(8);
  const perBuilder = owners.map((o) => ({
    owner: o,
    weeks: weekStarts.map((w) => ({ week: isoWeek(w), start: w, label: weekLabel(w), n: attributed.filter((e) => e.builder_id === o && e.week === isoWeek(w)).length })),
  }));
  const verdicts = [...new Set(all.map((e) => e.verdict).filter((v): v is string => Boolean(v)))];
  const qualities = [...new Set(all.map((e) => e.narration_quality).filter((v): v is string => Boolean(v)))];
  const pay = all.length ? Math.round((all.filter((e) => e.pay_eligible).length / all.length) * 100) : null;
  const value: CodexMetrics = {
    kind: 'codex',
    computed_at: nowIso(),
    scope: { builder, rows: all.length },
    entries: all.length,
    unattributed: all.length - attributed.length,
    unattributed_note: `${all.length - attributed.length} ${all.length - attributed.length === 1 ? 'row has' : 'rows have'} no builder recorded in the source — builder_id and builder_name are empty, or name a test value — so they cannot be attributed to anyone. They are counted in the totals and shown under “No builder”.`,
    layer0: { complete, incomplete: all.length - complete, rate: all.length ? Math.round((complete / all.length) * 100) : null, definition: LAYER0_DEFINITION, note: `${complete} of ${all.length} rows pass the check.` },
    pending: { n: pending, note: 'Rows whose action_required is JASON_SPOTCHECK. That is the nearest thing the log records to “awaiting Jason”; it is a request for a spot-check, not a formal pending-approval state.' },
    approved: { n: null, note: 'The Codex Log records no approval: no approved flag, no approver, no approval time. An entry with no action_required could be approved or never reviewed, and the data cannot tell those apart. This section fills the day the table has an approval field (for example an approved_at date).' },
    evaluated: { n: evaluated, note: 'Rows carrying a verdict or a narration quality. Evaluated is not approved; it says a judgement was written, not that Jason cleared the entry.' },
    per_builder_per_week: perBuilder,
    verdict_mix: verdicts.map((v) => ({ verdict: v, n: all.filter((e) => e.verdict === v).length })),
    verdict_note: verdicts.length === 2 ? 'The log’s verdict field defines two tiers, not three. Both are shown; a third would have to be added to the table first.' : `The verdict field holds ${verdicts.length} distinct ${verdicts.length === 1 ? 'value' : 'values'}.`,
    narration_quality_mix: qualities.map((q) => ({ quality: q, n: all.filter((e) => e.narration_quality === q).length })),
    pay_eligible_rate: { value: pay, note: all.length ? `${all.filter((e) => e.pay_eligible).length} of ${all.length} entries have pay_eligible checked. An unchecked box counts as not eligible.` : 'No entries.' },
    median_days_to_approval: { value: null, note: 'Needs an approval time. The log records none, so this cannot be measured until a field exists.' },
  };
  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

export function patternMetrics(): PatternMetrics {
  const hit = metricsCache.get('patterns');
  if (hit && hit.version === storeVersion) return hit.value as PatternMetrics;
  const all = patterns();
  const canonical = all.filter((p) => p.status === 'canonical').length;
  const systems = [...new Set(all.map((p) => p.system ?? '(no system in id)'))].sort();
  const weeks = lastWeeks(8);
  const created = series(
    weeks.map((w) => ({ label: weekLabel(w), value: all.filter((p) => p.created_at && weekStart(p.created_at.slice(0, 10)) === w).length })),
    'Patterns by the week of created_at, last eight weeks.',
  );
  // reusability is a free-text field. Most rows use a one-word value; the rest explain in prose,
  // which is counted as one group rather than shown as a bar per sentence.
  const reuseKey = (p: BuildPattern): string => {
    const v = p.reusability?.trim();
    if (!v) return '(not set)';
    return v.length > 24 || /\s/.test(v) ? '(written out in prose)' : v;
  };
  const reuse = [...new Set(all.map(reuseKey))];
  const prose = all.filter((p) => reuseKey(p) === '(written out in prose)').length;
  const value: PatternMetrics = {
    kind: 'patterns',
    computed_at: nowIso(),
    scope: { rows: all.length },
    draft: all.length - canonical,
    canonical,
    promotion_rate: { value: all.length ? Math.round((canonical / all.length) * 100) : null, note: all.length ? `${canonical} of ${all.length} patterns are canonical today. A promotion date is not recorded, so this is the share now, not a rate of promotion.` : 'No patterns.' },
    status_legend: [
      { status: 'draft', meaning: 'Written up but not yet accepted as the reference way of doing it. Most patterns are here.' },
      { status: 'canonical', meaning: 'Accepted as the reference pattern other builders should follow. Promotion is the move from draft to canonical; the table records the state, not the date.' },
    ],
    by_system: systems.map((s) => ({ system: s, draft: all.filter((p) => (p.system ?? '(no system in id)') === s && p.status === 'draft').length, canonical: all.filter((p) => (p.system ?? '(no system in id)') === s && p.status === 'canonical').length })),
    reusability_mix: reuse.map((r) => ({ reusability: r, n: all.filter((p) => reuseKey(p) === r).length })).sort((a, b) => b.n - a.n),
    reusability_note: `reusability is a free-text field, not a select. ${all.length - prose} of ${all.length} rows use a one-word value; ${prose} explain the reach in a sentence and are grouped as “written out in prose” — open the pattern to read it.`,
    created_per_week: created,
  };
  metricsCache.set('patterns', { version: storeVersion, value });
  return value;
}

export function commercialMetrics(): CommercialMetrics {
  const hit = metricsCache.get('commercial');
  if (hit && hit.version === storeVersion) return hit.value as CommercialMetrics;
  const all = opportunities();
  const lanes = [...new Set(all.map((o) => o.lane_id ?? '(no lane_id)'))];
  const withCount = all.filter((o) => o.missing_research_count !== null);
  const total = withCount.reduce((n, o) => n + (o.missing_research_count ?? 0), 0);
  const obs = observations('commercial', 'unresolved_questions');
  const distinctDays = new Set(obs.map((o) => o.at.slice(0, 10)));
  const readiness = [...new Set(all.map((o) => o.readiness_state ?? '(unset)'))];
  const confidence = [...new Set(all.map((o) => o.confidence ?? '(unset)'))];
  const value: CommercialMetrics = {
    kind: 'commercial',
    computed_at: nowIso(),
    scope: { rows: all.length },
    cards: all.length,
    by_lane: lanes.map((lane) => {
      const mine = all.filter((o) => (o.lane_id ?? '(no lane_id)') === lane);
      const counted = mine.filter((o) => o.missing_research_count !== null);
      return { lane_id: lane, n: mine.length, unresolved: counted.length ? counted.reduce((n, o) => n + (o.missing_research_count ?? 0), 0) : null, blocked: mine.filter((o) => Boolean(o.lane_state_blocked_reason)).length };
    }),
    by_readiness: readiness.map((r) => ({ readiness_state: r, n: all.filter((o) => (o.readiness_state ?? '(unset)') === r).length })),
    confidence_mix: confidence.map((c) => ({ confidence: c, n: all.filter((o) => (o.confidence ?? '(unset)') === c).length })),
    unresolved_questions: {
      value: withCount.length ? total : null,
      note: withCount.length
        ? `Sum of missing_research_count over the ${withCount.length} of ${all.length} cards that carry it. ${all.length - withCount.length} ${all.length - withCount.length === 1 ? 'card has' : 'cards have'} no count; their listed questions are shown on the card.`
        : 'No card carries a missing_research_count.',
    },
    unresolved_trend:
      distinctDays.size >= 2
        ? series(obs.map((o) => ({ label: o.at.slice(5, 10), value: Math.round(o.value) })), 'Total unresolved research questions as observed at each resync. Observations reset with the instance on the free plan.')
        : series(null, 'A trend needs the count observed on at least two different days. Airtable keeps no history of this field, and this dashboard’s own observations reset with the instance on the free plan.'),
    demand_evidence_note: 'demand_evidence is a single-select whose only choice says no external demand evidence has been collected for the lane; it is shown per card, not summed.',
  };
  metricsCache.set('commercial', { version: storeVersion, value });
  return value;
}

export function metrics(kind: RecordKind, filter: { builder?: string | null } = {}): RecordMetrics {
  switch (kind) {
    case 'loops':
      return loopMetrics(filter.builder ?? null);
    case 'codex':
      return codexMetrics(filter.builder ?? null);
    case 'patterns':
      return patternMetrics();
    case 'commercial':
      return commercialMetrics();
  }
}

export function historySince(): string | null {
  return getMeta('history_since');
}

/** Rows held per kind, for /api/status. */
export function held(): Record<RecordKind, number> {
  const out = {} as Record<RecordKind, number>;
  for (const k of KINDS) out[k] = rows(k).length;
  return out;
}
