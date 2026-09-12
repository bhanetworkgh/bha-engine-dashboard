/**
 * The record store: loops, Codex entries, build patterns and commercial cards
 * as this dashboard holds them, plus the status-change history the counts on
 * those pages are computed from.
 *
 * Decision (2026-09-09, Destiny): Airtable is the source of truth for every
 * kind. Rows here are a read model, keyed by Airtable record id, rebuilt by
 * sync.ts from the bases. Every write from the interface goes through to
 * Airtable first and is recorded here only from what Airtable sent back; if
 * Airtable refuses, nothing changes here.
 *
 * Decision (2026-09-12, Destiny): these rows live in Postgres (bha-engine-db
 * on Render), not in a SQLite file under DATA_DIR. The service has no
 * persistent disk, so that file was wiped on every deploy and every spin-down
 * — which mattered most for `events`, the only place a status change is
 * timestamped, because the loop tables carry no close date. That history now
 * accumulates instead of restarting, and `meta.history_since` says when the
 * database itself started recording. A metric the rows cannot support is
 * still null with a note.
 *
 * No fixture is seeded for these four kinds any more. With no AIRTABLE_API_KEY
 * the pages are empty and say why, which is the truth.
 */
import type { AtRecord } from './airtable';
import * as airtable from './airtable';
import type {
  BuildPattern,
  BuildPatternDetail,
  ClientLane,
  ClientQuestion,
  CodexApproval,
  CodexEntry,
  CodexEntryDetail,
  CodexMetrics,
  CodexTab,
  CommercialMetrics,
  Layer0Hold,
  Loop,
  LoopMetrics,
  LoopStatus,
  Metric,
  MetricSeries,
  NewLoop,
  NsMetrics,
  NsOutcome,
  NsRecord,
  Opportunity,
  OwnerTotals,
  PatternMetrics,
  RecordKind,
  RecordMetrics,
  RtAttempt,
  RtCard,
  RtMetrics,
  SeriesPoint,
  SyncInfo,
} from '../../src/data/types';
import { getMeta, nowIso, setMeta, setMetaIfAbsent, today } from './db';
import { getPool, withTransaction, type Queryable } from './pg';
import {
  CODEX_EDITABLE,
  CODEX_JASON_STATUS,
  CODEX_TABLES,
  COMMERCIAL,
  LOOP_LANE_TAGS,
  LOOP_STATUS_TO_AIRTABLE,
  LOOP_TABLES,
  LOOPS_BASE,
  PATTERNS,
  baseFor,
  canonicalPerson,
  codexSummary,
  codexTableById,
  isoWeek,
  loopTable,
  loopTableById,
  mapClientLane,
  mapClientQuestion,
  mapCodex,
  mapLoop,
  mapNsRecord,
  mapRtAttempt,
  mapOpportunity,
  mapPattern,
  missingLabel,
  patternSummary,
} from './sources';

export type { RecordKind, RecordMetrics, Metric };

/**
 * Read here rather than imported from sync.ts, which imports this module —
 * a cycle would leave the constant undefined at module-eval time. sync.ts
 * owns the reasoning about the number; this is the same read.
 */
const RESYNC_MINUTES = Math.max(0, Number(process.env.AIRTABLE_RESYNC_MINUTES ?? 15) || 0);
export const KINDS: RecordKind[] = ['loops', 'codex', 'patterns', 'commercial', 'ns', 'rt', 'clients', 'client_questions'];

/** Status vocabularies, in the dashboard's words. Loops and patterns and cards are the table's own selects lower-cased or verbatim. */
export const STATUSES: Record<RecordKind, readonly string[]> = {
  loops: ['open', 'in progress', 'closed'],
  // Codex: Jason Status, lower-cased. 'unset' is a state a row can be in but never one this dashboard writes.
  codex: ['approved', 'pending', 'input added'],
  patterns: ['draft', 'canonical'],
  commercial: ['INCUBATE', 'Research-First', 'Media-Ready'],
  // The three telemetry kinds are read-only: the engine writes them, this
  // dashboard reads them. No status is settable from here.
  ns: [],
  rt: [],
  clients: [],
  client_questions: [],
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

/* ----------------------------------------------------------------- boot */

/** The pool, or one client inside a caller's transaction. */
function db(on?: Queryable): Queryable {
  return on ?? getPool();
}

/**
 * Called once at boot, after migrations.
 *
 * The schema itself is migrations.ts's — forward-only, and it never drops a
 * table. This only stamps when this database began recording status changes,
 * which is what the notes on the loops page cite. `setMetaIfAbsent` so a
 * second boot, or a second instance, leaves the original stamp alone: that
 * date is now a real fact about the history rather than the time of the last
 * restart.
 */
export async function initStore(): Promise<void> {
  await setMetaIfAbsent('history_since', nowIso());
}

/* ------------------------------------------------------------------ rows */

async function rows(kind: RecordKind, table?: string, on?: Queryable): Promise<Row[]> {
  const r = table
    ? await db(on).query<Row>('SELECT * FROM records WHERE kind = $1 AND table_id = $2', [kind, table])
    : await db(on).query<Row>('SELECT * FROM records WHERE kind = $1', [kind]);
  return r.rows;
}
async function rowById(kind: RecordKind, id: string, on?: Queryable): Promise<Row | null> {
  const r = await db(on).query<Row>('SELECT * FROM records WHERE kind = $1 AND id = $2', [kind, id]);
  return r.rows[0] ?? null;
}

type Mapped =
  | { kind: 'loops'; obj: Loop }
  | { kind: 'codex'; obj: CodexEntryDetail }
  | { kind: 'patterns'; obj: BuildPatternDetail }
  | { kind: 'commercial'; obj: Opportunity }
  | { kind: 'ns'; obj: NsRecord }
  | { kind: 'rt'; obj: RtAttempt }
  | { kind: 'clients'; obj: ClientLane }
  | { kind: 'client_questions'; obj: ClientQuestion };

function statusOf(m: Mapped): string {
  switch (m.kind) {
    case 'loops':
      return m.obj.status;
    case 'codex':
      return m.obj.approval;
    case 'patterns':
      return m.obj.status;
    case 'commercial':
      return m.obj.readiness_state ?? 'unset';
    case 'ns':
      return m.obj.outcome ?? 'unclassified';
    case 'rt':
      return m.obj.status ?? 'untriaged';
    case 'clients':
      return m.obj.run_state ?? 'unset';
    case 'client_questions':
      return m.obj.movement_tag ?? 'unset';
  }
}
function keyOf(m: Mapped): string | null {
  switch (m.kind) {
    case 'loops':
      return m.obj.loop_id;
    case 'codex':
      return m.obj.codex_entry_id ?? m.obj.submission_id;
    case 'patterns':
      return m.obj.pattern_id;
    case 'commercial':
      return m.obj.card_id;
    case 'ns':
      return m.obj.trace_id;
    case 'rt':
      return m.obj.card_id;
    case 'clients':
      return m.obj.lane_id;
    case 'client_questions':
      return m.obj.lane_id;
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
    case 'ns':
      return m.obj.asked_at ? m.obj.asked_at.slice(0, 10) : null;
    case 'rt':
      return m.obj.created_at ? m.obj.created_at.slice(0, 10) : null;
    case 'clients':
      return m.obj.last_run_at ? m.obj.last_run_at.slice(0, 10) : null;
    case 'client_questions':
      return m.obj.last_updated ? m.obj.last_updated.slice(0, 10) : null;
  }
}
const TERMINAL: Partial<Record<RecordKind, string>> = { loops: 'closed' };

/**
 * Writes one mapped record over whatever is held for it. Idempotent: the same
 * record twice is one row. A status that differs from the held row is recorded
 * as an event, stamped `at` (an inbound payload's own time, else now).
 */
export async function upsert(
  m: Mapped,
  table: string,
  via: 'airtable' | 'inbound' | 'ui',
  at = nowIso(),
  on?: Queryable,
): Promise<{ changed: boolean; inserted: boolean }> {
  // The row and the event it raises are one change; without a transaction a
  // crash between them leaves a status with no record of when it changed.
  if (!on) return withTransaction((client) => upsert(m, table, via, at, client));
  const prev = await rowById(m.kind, m.obj.id, on);
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
  await on.query(
    `INSERT INTO records (kind, id, key, json, status, builder, raised_at, closed_at, updated_at, source, table_id, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (kind, id) DO UPDATE SET key = excluded.key, json = excluded.json, status = excluded.status, builder = excluded.builder,
       raised_at = excluded.raised_at, closed_at = excluded.closed_at, updated_at = excluded.updated_at, source = excluded.source,
       table_id = excluded.table_id, synced_at = excluded.synced_at`,
    [m.kind, m.obj.id, keyOf(m), JSON.stringify(obj), status, builderOf(m), raisedOf(m), closedAt, at, via, table, at],
  );
  bumpVersion();
  const changed = !prev || prev.status !== status;
  if (changed) {
    await on.query('INSERT INTO events (kind, record_id, builder, from_status, to_status, via, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      m.kind,
      m.obj.id,
      builderOf(m),
      prev?.status ?? null,
      status,
      via,
      at,
    ]);
  }
  return { changed: Boolean(prev) && prev!.status !== status, inserted: !prev };
}

/** Removes rows of one table that a full read of that table no longer contains. */
export async function purgeMissing(kind: RecordKind, table: string, keep: Set<string>, on?: Queryable): Promise<number> {
  // One statement rather than a read and a delete per row. An empty `keep`
  // removes every row of that table, as before: the caller only reaches here
  // after a successful full read, so an empty read means an empty table.
  const r = await db(on).query('DELETE FROM records WHERE kind = $1 AND table_id = $2 AND NOT (id = ANY($3::text[]))', [kind, table, [...keep]]);
  const n = r.rowCount ?? 0;
  if (n) bumpVersion();
  return n;
}

export async function mapRecord(kind: RecordKind, rec: AtRecord, table: string): Promise<Mapped> {
  switch (kind) {
    case 'loops': {
      const t = loopTableById(table);
      if (!t) throw new StoreError(`${table} is not one of the builder tables.`, 422);
      return { kind, obj: mapLoop(rec, t.owner, table) };
    }
    case 'codex': {
      const t = codexTableById(table);
      if (!t) throw new StoreError(`${table} is not one of the submission tables.`, 422);
      return { kind, obj: mapCodex(rec, t.owner, table) };
    }
    case 'patterns':
      return { kind, obj: mapPattern(rec) };
    case 'commercial':
      return { kind, obj: mapOpportunity(rec) };
    case 'ns':
      return { kind, obj: mapNsRecord(rec) };
    case 'rt':
      return { kind, obj: mapRtAttempt(rec) };
    case 'clients':
      return { kind, obj: mapClientLane(rec) };
    case 'client_questions': {
      // The lane a question belongs to is the table it was read from; the
      // sync records that mapping when it follows each index row's Table ID.
      const lane = await questionLaneFor(table);
      return { kind, obj: mapClientQuestion(rec, lane ?? table, table) };
    }
  }
}

/* ---------------------------------------------- clients: table → lane map */

/**
 * Which lane a questions table belongs to, learned from the index at sync
 * time rather than hardcoded — the same reason the pipeline dropped its own
 * lane-to-table map: adding a lane should be a row, not a deploy.
 */
export async function setQuestionTables(map: Record<string, string>): Promise<void> {
  await setMeta('clients:tables', JSON.stringify(map));
  questionTablesCache = map;
  bumpVersion();
}
export async function questionTables(): Promise<Record<string, string>> {
  if (questionTablesCache) return questionTablesCache;
  const raw = await getMeta('clients:tables');
  questionTablesCache = parseTableMap(raw);
  return questionTablesCache;
}

/**
 * Held in memory after the first read, and replaced whenever a sync writes a
 * new one. Postgres is still where it lives; this is only so that mapping a
 * few hundred question rows does not mean a query per row. It is a map of
 * four table ids, and a stale one cannot outlive the resync that wrote it.
 */
let questionTablesCache: Record<string, string> | null = null;

function parseTableMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
async function questionLaneFor(table: string): Promise<string | null> {
  return (await questionTables())[table] ?? null;
}

/* ------------------------------------------------------------------ reads */

function hydrateLoop(r: Row): Loop {
  const base = JSON.parse(r.json) as Loop;
  const end = r.closed_at ?? today();
  return { ...base, status: r.status as LoopStatus, closed_at: r.closed_at, age_days: r.raised_at ? Math.max(0, dayDiff(r.raised_at, end)) : 0 };
}
export async function loops(): Promise<Loop[]> {
  return (await rows('loops')).map(hydrateLoop);
}
export async function codexEntries(): Promise<CodexEntry[]> {
  return (await rows('codex')).map((r) => codexSummary(JSON.parse(r.json) as CodexEntryDetail));
}
export async function codexDetail(id: string): Promise<CodexEntryDetail | null> {
  const r = await rowById('codex', id);
  return r ? (JSON.parse(r.json) as CodexEntryDetail) : null;
}

/* --------------------------------------------------- layer 0 holding table */

/**
 * Submissions parked at the completeness gate. They are not records of any
 * kind — no status, no write path — so they are held in `meta` as the last
 * full read of that table rather than in the records table.
 */
export async function setLayer0Holds(holds: Layer0Hold[]): Promise<void> {
  await setMeta('codex:layer0', JSON.stringify(holds));
  bumpVersion();
}
export async function layer0Holds(): Promise<Layer0Hold[]> {
  const raw = await getMeta('codex:layer0');
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Layer0Hold[]) : [];
  } catch {
    return [];
  }
}
export async function patterns(): Promise<BuildPattern[]> {
  return (await rows('patterns')).map((r) => patternSummary(JSON.parse(r.json) as BuildPatternDetail));
}
export async function patternDetail(id: string): Promise<BuildPatternDetail | null> {
  const r = await rowById('patterns', id);
  return r ? (JSON.parse(r.json) as BuildPatternDetail) : null;
}
/** Case-insensitive search across every text field of every pattern. */
export async function searchPatterns(q: string): Promise<BuildPattern[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return patterns();
  const terms = needle.split(/\s+/).filter(Boolean);
  return (await rows('patterns'))
    .filter((r) => {
      const hay = r.json.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .map((r) => patternSummary(JSON.parse(r.json) as BuildPatternDetail));
}
export async function opportunities(): Promise<Opportunity[]> {
  return (await rows('commercial')).map((r) => JSON.parse(r.json) as Opportunity);
}
export async function nsRecords(): Promise<NsRecord[]> {
  return (await rows('ns')).map((r) => JSON.parse(r.json) as NsRecord);
}
export async function rtAttempts(): Promise<RtAttempt[]> {
  return (await rows('rt')).map((r) => JSON.parse(r.json) as RtAttempt);
}
export async function clientLanes(): Promise<ClientLane[]> {
  return (await rows('clients')).map((r) => JSON.parse(r.json) as ClientLane);
}
export async function clientQuestions(): Promise<ClientQuestion[]> {
  return (await rows('client_questions')).map((r) => JSON.parse(r.json) as ClientQuestion);
}

export async function loopsByOwner(): Promise<OwnerTotals[]> {
  const all = await loops();
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
export async function syncState(kind: RecordKind): Promise<SyncState> {
  const raw = await getMeta(`sync:${kind}`);
  return raw ? (JSON.parse(raw) as SyncState) : { synced_at: null, error: null, tables: [] };
}
export async function setSyncState(kind: RecordKind, s: SyncState): Promise<void> {
  await setMeta(`sync:${kind}`, JSON.stringify(s));
}
export async function syncInfo(kind: RecordKind): Promise<SyncInfo> {
  const s = await syncState(kind);
  return {
    kind,
    source: s.synced_at ? 'airtable' : 'none',
    synced_at: s.synced_at,
    error: s.error,
    tables: s.tables,
    write_through: airtable.airtableConfigured(),
    resync_minutes: RESYNC_MINUTES,
  };
}

export async function observe(kind: RecordKind, metric: string, value: number): Promise<void> {
  await db().query('INSERT INTO observations (kind, metric, at, value) VALUES ($1, $2, $3, $4)', [kind, metric, nowIso(), value]);
  bumpVersion();
}
export async function cardTrend(id: string): Promise<MetricSeries> {
  const obs = await observations('commercial', `unresolved:${id}`);
  const days = new Set(obs.map((o) => o.at.slice(0, 10)));
  return days.size >= 2
    ? { points: obs.map((o) => ({ label: o.at.slice(5, 10), value: Math.round(o.value) })), note: 'missing_research_count as observed at each resync, since this database started recording.' }
    : { points: null, note: obs.length ? `Seen on one day only (${[...days][0]}); a trend needs at least two.` : 'Not observed yet.' };
}
async function observations(kind: RecordKind, metric: string): Promise<{ at: string; value: number }[]> {
  const r = await db().query<{ at: string; value: number }>('SELECT at, value FROM observations WHERE kind = $1 AND metric = $2 ORDER BY at', [kind, metric]);
  return r.rows;
}

/* ----------------------------------------------------------------- writes */

function requireWrite(): void {
  if (!airtable.airtableConfigured()) {
    throw new StoreError('Airtable is the source of truth and this server has no AIRTABLE_API_KEY, so the change was not made.', 503);
  }
}

async function writeThrough(kind: RecordKind, r: Row, fields: Record<string, unknown>): Promise<Mapped> {
  requireWrite();
  const base = baseFor(kind);
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
  if (!STATUSES[kind].length) throw new StoreError(`${kind} is read-only in this dashboard: the engine writes it.`, 422);
  if (!STATUSES[kind].includes(status)) {
    throw new StoreError(`"${status}" is not a status a ${kind === 'loops' ? 'loop' : kind === 'codex' ? 'Codex entry' : kind === 'patterns' ? 'pattern' : 'card'} can have.`, 422);
  }
  const r = await rowById(kind, id);
  if (!r) throw new StoreError('That record is not held by this dashboard.', 404);
  // Codex: the status is Jason Status, written back in the table's own spelling.
  const jason = CODEX_JASON_STATUS.find((c) => c.toLowerCase() === status);
  if (kind === 'codex' && !jason) throw new StoreError(`"${status}" is not a Jason Status the submission tables define.`, 422);
  const fields: Record<string, unknown> =
    kind === 'loops'
      ? { Status: LOOP_STATUS_TO_AIRTABLE[status as LoopStatus] }
      : kind === 'codex'
        ? { 'Jason Status': jason }
        : kind === 'patterns'
          ? { pattern_status: status }
          : { readiness_state: status };
  const m = await writeThrough(kind, r, fields);
  if (note !== undefined) (m.obj as { note?: string | null }).note = note.trim() || null;
  await upsert(m, r.table_id, 'ui');
  return (await read(kind, id)) as Loop | CodexEntry | BuildPattern | Opportunity;
}

/** Edits a Codex entry's own fields. Airtable first, then the held row from what came back. */
export async function updateFields(kind: RecordKind, id: string, fields: Record<string, unknown>): Promise<CodexEntry | Opportunity | BuildPatternDetail | Loop> {
  const r = await rowById(kind, id);
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
  await upsert(m, r.table_id, 'ui');
  const out = (await rowById(kind, id))!;
  if (kind === 'loops') return hydrateLoop(out);
  if (kind === 'codex') return codexSummary(JSON.parse(out.json) as CodexEntryDetail);
  return JSON.parse(out.json) as Opportunity | BuildPatternDetail;
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
  const m = await mapRecord('loops', rec, t.table);
  if (input.note?.trim()) (m.obj as Loop).note = input.note.trim();
  await upsert(m, t.table, 'ui');
  return hydrateLoop((await rowById('loops', rec.id))!);
}

/** Applies a record n8n pushed after writing it to Airtable. Idempotent by record id. */
export async function applyInbound(kind: RecordKind, payload: { id: string; table?: string; record?: AtRecord; at?: string }): Promise<{ changed: boolean; inserted: boolean; record: unknown }> {
  const id = payload.id;
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new StoreError('An Airtable record id (rec…) is required.', 422);
  let table = payload.table ?? (await rowById(kind, id))?.table_id ?? null;
  if (kind === 'patterns') table = PATTERNS.table;
  if (kind === 'commercial') table = COMMERCIAL.table;
  if (!table) throw new StoreError(`Which builder table the ${kind === 'loops' ? 'loop' : 'submission'} lives in is required (table or builder).`, 422);
  if (kind === 'loops' && !loopTableById(table)) throw new StoreError(`${table} is not one of the builder tables.`, 422);
  if (kind === 'codex' && !codexTableById(table)) throw new StoreError(`${table} is not one of the submission tables.`, 422);
  let rec = payload.record;
  if (!rec) {
    // The payload named the record but did not carry it: read it from Airtable, the source of truth.
    requireWrite();
    const base = baseFor(kind);
    try {
      rec = await airtable.getRecord(base, table, id);
    } catch (e) {
      if (e instanceof airtable.AirtableError) throw new StoreError(`Could not read ${id} from Airtable: ${e.message}`, e.status === 404 ? 404 : 502);
      throw e;
    }
  }
  if (rec.id !== id) throw new StoreError('The record in the body does not match the id.', 422);
  const m = await mapRecord(kind, rec, table);
  const at = payload.at && Number.isFinite(Date.parse(payload.at)) ? new Date(payload.at).toISOString() : nowIso();
  const res = await upsert(m, table, 'inbound', at);
  return { ...res, record: await read(kind, id) };
}

export async function removeInbound(kind: RecordKind, id: string): Promise<boolean> {
  const r = await db().query('DELETE FROM records WHERE kind = $1 AND id = $2', [kind, id]);
  if (!r.rowCount) return false;
  bumpVersion();
  return true;
}

export async function read(
  kind: RecordKind,
  id: string,
): Promise<Loop | CodexEntry | BuildPattern | Opportunity | NsRecord | RtAttempt | ClientLane | ClientQuestion | null> {
  const r = await rowById(kind, id);
  if (!r) return null;
  switch (kind) {
    case 'loops':
      return hydrateLoop(r);
    case 'patterns':
      return patternSummary(JSON.parse(r.json) as BuildPatternDetail);
    case 'codex':
      return codexSummary(JSON.parse(r.json) as CodexEntryDetail);
    default:
      return JSON.parse(r.json) as Opportunity;
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

/** "7 Sep" from a week-start day: the week start alone, for a crowded axis. */
function shortWeekLabel(start: string): string {
  const a = new Date(`${start}T00:00:00Z`);
  return `${a.getUTCDate()} ${a.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
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
const NO_CLOSE_DATE = 'The loop tables carry no close date. Closes are timestamped only when they pass through this dashboard or are pushed by n8n, and that history starts when this database did.';

function modifiedAfterAdded(iso: string | null): boolean {
  return Boolean(iso && iso.slice(0, 10) > MODIFIED_FIELD_ADDED);
}

/** The per-builder figures are the same computation over a subset; memoised per store version. */
const metricsCache = new Map<string, { version: number; value: RecordMetrics }>();
let storeVersion = 0;
export function bumpVersion(): void {
  storeVersion++;
}

/**
 * Closes that passed through this dashboard or were pushed by n8n. Read once
 * per loopMetrics() call and handed to each pass below, rather than queried
 * again for every builder: the by-builder figures are the same computation
 * over a subset of the same rows.
 */
async function loopCloseEvents(): Promise<{ at: string; builder: string | null }[]> {
  const r = await db().query<{ at: string; builder: string | null }>(
    `SELECT at, builder FROM events WHERE kind = 'loops' AND to_status = 'closed' AND via IN ('ui', 'inbound') ORDER BY at`,
  );
  return r.rows;
}

function loopMetricsFor(all: Loop[], builder: string | null, historySince: string | null, allCloseEvents: { at: string; builder: string | null }[]): LoopMetrics {
  const openRows = all.filter((l) => l.status !== 'closed');
  const now = today();

  const byOwner = LOOP_TABLES.filter((t) => !builder || t.owner === builder)
    .map((t) => {
      const mine = all.filter((l) => l.owner === t.owner);
      const closed = mine.filter((l) => l.status === 'closed').length;
      return { owner: t.owner, closed, total: mine.length, rate: mine.length ? Math.round((closed / mine.length) * 100) : null };
    })
    .filter((o) => o.total > 0);

  const closeEvents = allCloseEvents.filter((e) => !builder || e.builder === builder);
  const closedPerDay: MetricSeries = closeEvents.length
    ? series(
        (() => {
          const days: string[] = [];
          for (let i = 13; i >= 0; i--) days.push(addDays(now, -i));
          return days.map((d) => ({ label: d.slice(5), value: closeEvents.filter((e) => e.at.slice(0, 10) === d).length }));
        })(),
        `Closes made through this dashboard or pushed by n8n since ${(historySince ?? '').slice(0, 10)}. ${NO_CLOSE_DATE}`,
      )
    : series(
        null,
        `No close has been recorded since this dashboard started keeping the history${historySince ? ` on ${historySince.replace('T', ' ').slice(0, 16)} UTC` : ''}. ${NO_CLOSE_DATE} Close a loop from this page and it appears here the same day.`,
      );

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
  // Same eight weeks as Raised per week so the two read as one pair of axes,
  // rather than one chart of eight bars beside one chart of a single bar. With
  // nothing to plot the series is null and the page prints the reason instead
  // of an axis with no bars on it.
  const closedPerWeek = realCloses.length
    ? series(
        weeks.map((w) => ({ label: weekLabel(w), value: realCloses.filter((l) => weekStart(l.last_modified!.slice(0, 10)) === w).length })),
        `Closed loops by the week of their last change, over the same eight weeks as Raised per week. A closed loop's last_modified is taken as its close, which is exact only when the close was the last edit. ${MODIFIED_NOTE}`,
      )
    : series(
        null,
        `No close has been recorded yet. A close is dated from the tables' last_modified field, added 9 Sept 2026: every loop that existed then stamps from that day, so no loop yet carries a change late enough to read as a close. The first close made after 9 Sept 2026 appears here.`,
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

  /**
   * One row per person, not one per spelling. Raised By is a free-text box and
   * the same person appears as "Jason" and "Jason Bays", "Destiny" and
   * "Destiny Arupi", "Jegan" and "Jeganathan". Those are collapsed to a single
   * identity before counting, and the spellings that were merged are carried
   * along so the merge can be seen rather than taken on trust.
   */
  const raisers = new Map<string, { label: string; n: number; variants: Set<string> }>();
  for (const l of all) {
    const person = canonicalPerson(l.raised_by);
    if (!person) continue;
    const held = raisers.get(person.key) ?? { label: person.label, n: 0, variants: new Set<string>() };
    held.n++;
    held.variants.add(l.raised_by!.trim());
    raisers.set(person.key, held);
  }
  const topRaisers = [...raisers.entries()]
    .map(([key, v]) => ({ key, label: v.label, n: v.n, variants: [...v.variants].sort() }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 8);
  const merged = topRaisers.filter((r) => r.variants.length > 1);

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
    top_raisers: topRaisers,
    top_raisers_note: merged.length
      ? `Raised By is free text, so one person is written several ways. ${merged.map((r) => `${r.label} counts ${r.variants.map((v) => `“${v}”`).join(' and ')} as one`).join('; ')}.`
      : 'Raised By is free text; spellings of the same name are counted as one person. No name in these tables is currently written more than one way.',
    modified_note: MODIFIED_NOTE,
    history_since: historySince,
  };
}

export async function loopMetrics(builder: string | null): Promise<LoopMetrics> {
  const key = `loops:${builder ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as LoopMetrics;
  const all = await loops();
  const historySince = await getMeta('history_since');
  const closes = await loopCloseEvents();
  const value: LoopMetrics = builder
    ? loopMetricsFor(all.filter((l) => l.owner === builder), builder, historySince, closes)
    : {
        ...loopMetricsFor(all, null, historySince, closes),
        // One pass per builder, computed here once and cached, so a tab change on the page needs no request.
        by_builder: Object.fromEntries(
          LOOP_TABLES.filter((t) => all.some((l) => l.owner === t.owner)).map((t) => [
            t.owner,
            loopMetricsFor(all.filter((l) => l.owner === t.owner), t.owner, historySince, closes),
          ]),
        ),
      };
  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

const LAYER0_DEFINITION =
  'Layer 0 is the completeness gate the submission pipeline runs before a log reaches review. It sets Layer0 Flagged on the row and lists what it found absent in Layer0 Missing. This is the gate\u2019s own verdict, read from the row \u2014 not a check this dashboard invents.';

const APPROVAL_LABELS: Record<CodexApproval, string> = {
  approved: 'Approved',
  pending: 'Pending',
  'input added': 'Input added',
  unset: 'Not set',
};

/** Which tab a row falls in, from the source's own fields. Nothing here is inferred. */
const TAB_RULES: { tab: CodexTab; label: string; rule: string; test: (e: CodexEntry) => boolean }[] = [
  { tab: 'approved', label: 'Approved', rule: 'Jason Status is Approved.', test: (e) => e.approval === 'approved' },
  { tab: 'pending', label: 'Pending approval', rule: 'Jason Status is Pending, or the field is empty.', test: (e) => e.approval === 'pending' || e.approval === 'unset' },
  { tab: 'incomplete', label: 'Incomplete', rule: 'Layer0 Flagged is ticked. Each row names what Layer0 Missing says it lacks.', test: (e) => e.layer0_flagged },
  { tab: 'complete', label: 'Complete', rule: 'Layer0 Flagged is not ticked and Orchestrator Layer2 Review is not empty.', test: (e) => e.complete },
];

export function codexTabRule(tab: CodexTab): (e: CodexEntry) => boolean {
  return TAB_RULES.find((r) => r.tab === tab)!.test;
}

export async function codexMetrics(builder: string | null): Promise<CodexMetrics> {
  const key = `codex:${builder ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as CodexMetrics;
  const all = (await codexEntries()).filter((e) => !builder || e.builder_id === builder);
  const holds = (await layer0Holds()).filter((h) => !builder || h.builder_id === builder);

  const flagged = all.filter((e) => e.layer0_flagged);
  const withEntry = all.filter((e) => e.has_entry).length;

  const missing = new Map<string, number>();
  for (const e of flagged) for (const m of e.layer0_missing) missing.set(m, (missing.get(m) ?? 0) + 1);

  const owners = CODEX_TABLES.filter((t) => (!builder || t.owner === builder) && all.some((e) => e.builder_id === t.owner)).map((t) => t.owner);
  const weekStarts = lastWeeks(8);
  const perBuilder = owners.map((o) => ({
    owner: o,
    weeks: weekStarts.map((w) => ({ week: isoWeek(w), start: w, label: weekLabel(w), short: shortWeekLabel(w), n: all.filter((e) => e.builder_id === o && e.week === isoWeek(w)).length })),
  }));

  const approvals: CodexApproval[] = ['approved', 'pending', 'input added', 'unset'];
  const qualities = [...new Set(all.map((e) => e.narration_quality).filter((v): v is string => Boolean(v)))].sort();
  const openHolds = holds.filter((h) => h.open).length;

  const value: CodexMetrics = {
    kind: 'codex',
    computed_at: nowIso(),
    scope: { builder, rows: all.length },
    entries: all.length,
    tabs: TAB_RULES.map((r) => ({ tab: r.tab, label: r.label, n: all.filter(r.test).length, rule: r.rule })),
    with_entry: {
      n: withEntry,
      note: `${withEntry} of ${all.length} submissions carry a completed entry in Orchestrator Layer2 Review. The rest were submitted but the orchestrator has not written one back.`,
    },
    layer0: {
      flagged: flagged.length,
      clean: all.length - flagged.length,
      definition: LAYER0_DEFINITION,
      note: `${flagged.length} of ${all.length} rows are flagged. Layer 0 and Jason Status are two different axes: a row can be approved and still carry a Layer 0 flag, and both are shown on it.`,
    },
    missing_mix: [...missing.entries()].map(([element, n]) => ({ element: missingLabel(element), n })).sort((a, b) => b.n - a.n || a.element.localeCompare(b.element)),
    holds: {
      open: openHolds,
      completed: holds.length - openHolds,
      note: holds.length
        ? `${openHolds} ${openHolds === 1 ? 'submission is' : 'submissions are'} parked at the Layer 0 gate waiting on the builder\u2019s answers, and never reached a builder table. ${holds.length - openHolds} ${holds.length - openHolds === 1 ? 'has' : 'have'} since been answered.`
        : 'Nothing is parked at the Layer 0 gate.',
    },
    approval_mix: approvals.map((a) => ({ approval: a, label: APPROVAL_LABELS[a], n: all.filter((e) => e.approval === a).length })).filter((r) => r.n > 0),
    approval_note:
      'Jason Status as the submission tables set it. "Input added" means the builder answered a question on the log; it is neither approved nor waiting. An empty field is counted as pending, because nothing distinguishes it from a log he has not reached.',
    per_builder_per_week: perBuilder,
    narration_quality_mix: qualities.map((q) => ({ quality: q, n: all.filter((e) => e.narration_quality === q).length })),
    narration_quality_note: qualities.length
      ? `From the Narration Quality field, on the ${all.filter((e) => e.narration_quality).length} of ${all.length} rows that carry one.`
      : 'No row carries a narration quality.',
    median_days_to_approval: {
      value: null,
      note: 'Needs the time Jason set the status. The tables record Processed At for the pipeline\u2019s own run, not the moment of approval, so this cannot be measured until an approved-at field exists.',
    },
  };
  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

export async function patternMetrics(): Promise<PatternMetrics> {
  const hit = metricsCache.get('patterns');
  if (hit && hit.version === storeVersion) return hit.value as PatternMetrics;
  const all = await patterns();
  const canonical = all.filter((p) => p.status === 'canonical').length;
  const draft = all.filter((p) => p.status === 'draft').length;
  const unset = all.filter((p) => p.status === 'unset').length;
  const systems = [...new Set(all.map((p) => p.system ?? '(no system in id)'))].sort();
  const weeks = lastWeeks(8);
  const created = series(
    weeks.map((w) => ({ label: weekLabel(w), value: all.filter((p) => p.created_at && weekStart(p.created_at.slice(0, 10)) === w).length })),
    'Patterns by the week of created_at, last eight weeks.',
  );

  /**
   * Why the figures on this page did not add up.
   *
   * pattern_status is a single-select with exactly two choices, draft and
   * canonical, and a sizeable minority of rows leave it empty. Every empty row
   * used to be counted as a draft, so "draft" was really "draft plus everything
   * nobody has triaged" and never squared with the total in a way a reader
   * could check. The three states are now counted separately and the sum is
   * printed beside the total.
   *
   * The second reason a count can look wrong is duplicate pattern_id values:
   * the table holds more rows than it holds distinct pattern ids, so a count of
   * rows is not a count of patterns. Both figures are given.
   */
  const byId = new Map<string, number>();
  for (const p of all) if (p.pattern_id) byId.set(p.pattern_id, (byId.get(p.pattern_id) ?? 0) + 1);
  const repeated = [...byId.entries()]
    .filter(([, n]) => n > 1)
    .map(([pattern_id, n]) => ({ pattern_id, n }))
    .sort((a, b) => b.n - a.n || a.pattern_id.localeCompare(b.pattern_id));
  const duplicateRows = repeated.reduce((n, r) => n + (r.n - 1), 0);

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
    draft,
    canonical,
    unset,
    reconciliation: {
      rows: all.length,
      draft,
      canonical,
      unset,
      sums_to: draft + canonical + unset,
      note: `${draft} draft + ${canonical} canonical + ${unset} with no status = ${draft + canonical + unset} rows. pattern_status is a single-select offering draft and canonical only; ${unset} ${unset === 1 ? 'row leaves' : 'rows leave'} it empty, and an untriaged pattern is not a draft, so it is counted on its own.`,
    },
    duplicates: {
      distinct_ids: byId.size + all.filter((p) => !p.pattern_id).length,
      duplicate_rows: duplicateRows,
      ids: repeated,
      note: repeated.length
        ? `${all.length} rows carry ${byId.size} distinct pattern ids: ${repeated.length} ${repeated.length === 1 ? 'id is' : 'ids are'} written on more than one row, ${duplicateRows} ${duplicateRows === 1 ? 'row' : 'rows'} more than there are patterns. A count of rows is not a count of patterns, which is the second reason these figures move.`
        : 'Every row carries a distinct pattern_id, so the row count is the pattern count.',
    },
    promotion_rate: {
      value: all.length ? Math.round((canonical / all.length) * 100) : null,
      note: all.length
        ? `${canonical} of ${all.length} rows are canonical today. A promotion date is not recorded, so this is the share now, not a rate of promotion.`
        : 'No patterns.',
    },
    status_legend: [
      { status: 'canonical', meaning: 'Accepted as the reference pattern other builders should follow. Promotion is the move from draft to canonical; the table records the state, not the date.' },
      { status: 'draft', meaning: 'Written up and marked draft: a pattern someone has looked at and not yet accepted as the reference way of doing it.' },
      { status: 'unset', meaning: 'pattern_status is empty. The row was written and never triaged — not the same as a draft, and the reason the draft count and the total did not previously reconcile.' },
    ],
    by_system: systems.map((sys) => ({
      system: sys,
      draft: all.filter((p) => (p.system ?? '(no system in id)') === sys && p.status === 'draft').length,
      canonical: all.filter((p) => (p.system ?? '(no system in id)') === sys && p.status === 'canonical').length,
      unset: all.filter((p) => (p.system ?? '(no system in id)') === sys && p.status === 'unset').length,
    })),
    reusability_mix: reuse.map((r) => ({ reusability: r, n: all.filter((p) => reuseKey(p) === r).length })).sort((a, b) => b.n - a.n),
    reusability_note: `reusability is a free-text field, not a select. ${all.length - prose} of ${all.length} rows use a one-word value; ${prose} explain the reach in a sentence and are grouped as \u201cwritten out in prose\u201d \u2014 open the pattern to read it.`,
    created_per_week: created,
  };
  metricsCache.set('patterns', { version: storeVersion, value });
  return value;
}

export async function commercialMetrics(): Promise<CommercialMetrics> {
  const hit = metricsCache.get('commercial');
  if (hit && hit.version === storeVersion) return hit.value as CommercialMetrics;
  const all = await opportunities();
  const lanes = [...new Set(all.map((o) => o.lane_id ?? '(no lane_id)'))];
  const withCount = all.filter((o) => o.missing_research_count !== null);
  const total = withCount.reduce((n, o) => n + (o.missing_research_count ?? 0), 0);
  const obs = await observations('commercial', 'unresolved_questions');
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
        ? series(obs.map((o) => ({ label: o.at.slice(5, 10), value: Math.round(o.value) })), 'Total unresolved research questions as observed at each resync, since this database started recording.')
        : series(null, 'A trend needs the count observed on at least two different days. Airtable keeps no history of this field, so the series starts from this dashboard’s own first observation.'),
    demand_evidence_note: 'demand_evidence is a single-select whose only choice says no external demand evidence has been collected for the lane; it is shown per card, not summed.',
  };
  metricsCache.set('commercial', { version: storeVersion, value });
  return value;
}

export async function metrics(kind: RecordKind, filter: { builder?: string | null } = {}): Promise<RecordMetrics> {
  switch (kind) {
    case 'loops':
      return loopMetrics(filter.builder ?? null);
    case 'codex':
      return codexMetrics(filter.builder ?? null);
    case 'patterns':
      return patternMetrics();
    case 'commercial':
      return commercialMetrics();
    case 'ns':
      return nsMetrics();
    case 'rt':
      return rtMetrics();
    default:
      throw new StoreError(`${kind} has no metrics of its own.`, 404);
  }
}

export async function historySince(): Promise<string | null> {
  return getMeta('history_since');
}

/** Rows held per kind, for /api/status. One grouped count, not a read per kind. */
export async function held(): Promise<Record<RecordKind, number>> {
  const r = await db().query<{ kind: RecordKind; n: string }>('SELECT kind, count(*)::text AS n FROM records GROUP BY kind');
  const counts = new Map(r.rows.map((row) => [row.kind, Number(row.n)]));
  const out = {} as Record<RecordKind, number>;
  for (const k of KINDS) out[k] = counts.get(k) ?? 0;
  return out;
}

/* ------------------------------------------------------- north star (NS) */

const NS_OUTCOME_LABELS: Record<string, string> = { answered: 'Answered', thin: 'Thin', failed: 'Failed', unclassified: 'Unclassified' };

/**
 * North Star telemetry.
 *
 * Every figure below is computed over the rows that carry an `outcome`, and
 * the count that do not is stated beside it. That distinction is the whole
 * point: a thin rate of "0%" computed over zero classified rows would be a
 * lie told in the most reassuring possible direction.
 */
export async function nsMetrics(): Promise<NsMetrics> {
  const hit = metricsCache.get('ns');
  if (hit && hit.version === storeVersion) return hit.value as NsMetrics;
  const all = await nsRecords();
  const classified = all.filter((r) => r.outcome);
  const thin = classified.filter((r) => r.outcome === 'thin').length;
  const weeks = lastWeeks(8);

  const outcomes: (NsOutcome | 'unclassified')[] = ['answered', 'thin', 'failed', 'unclassified'];
  const inWeek = (r: NsRecord, w: string) => Boolean(r.asked_at) && weekStart(r.asked_at!.slice(0, 10)) === w;

  // Tool usage: hits that came back against hits that ended up cited.
  const tools = new Map<string, { calls: number; hits: number; used: number }>();
  for (const r of all)
    for (const sch of r.searches) {
      const t = tools.get(sch.tool) ?? { calls: 0, hits: 0, used: 0 };
      t.calls++;
      t.hits += sch.hits;
      t.used += sch.used;
      tools.set(sch.tool, t);
    }

  const withConfidence = all.filter((r) => r.confidence !== null);
  const buckets: [string, (c: number) => boolean][] = [
    ['nothing cited (0)', (c) => c === 0],
    ['partly cited (0–1)', (c) => c > 0 && c < 1],
    ['fully cited (1)', (c) => c >= 1],
  ];

  const lanes = [...new Set(all.map((r) => r.lane_id ?? '(no lane_id)'))].sort();
  const newest = all.filter((r) => r.asked_at).sort((a, b) => b.asked_at!.localeCompare(a.asked_at!))[0] ?? null;
  const sinceLast = newest?.asked_at ? Math.floor((Date.now() - Date.parse(newest.asked_at)) / 86_400_000) : null;

  const value: NsMetrics = {
    kind: 'ns',
    computed_at: nowIso(),
    scope: { rows: all.length },
    classified: classified.length,
    unclassified: all.length - classified.length,
    unclassified_note:
      all.length - classified.length === 0
        ? 'Every row carries an outcome.'
        : `${all.length - classified.length} of ${all.length} rows carry no outcome. The field was added to the table on 10 Sept 2026; rows written before it, and any the agent has not classified since, are counted here and excluded from every rate below. Nothing is inferred from the answer text.`,
    thin_rate: {
      value: classified.length ? Math.round((thin / classified.length) * 100) : null,
      note: classified.length
        ? `${thin} of ${classified.length} classified asks produced an answer with no [S#] citation behind it. Computed over classified rows only; ${all.length - classified.length} rows carry no outcome and are not in this figure.`
        : `No row carries an outcome yet, so this cannot be computed. It is the share of classified asks whose answer cites nothing — the measure of answers that look real and are not. It fills the moment North Star starts writing the outcome field.`,
    },
    outcome_mix: outcomes
      .map((o) => ({ outcome: o, label: NS_OUTCOME_LABELS[o], n: o === 'unclassified' ? all.length - classified.length : all.filter((r) => r.outcome === o).length }))
      .filter((r) => r.n > 0),
    asks_per_week: series(
      weeks.map((w) => ({ label: weekLabel(w), value: all.filter((r) => inWeek(r, w)).length })),
      'Asks by the week of their timestamp, last eight weeks.',
    ),
    outcome_per_week: weeks.map((w) => {
      const mine = all.filter((r) => inWeek(r, w));
      return {
        label: weekLabel(w),
        week: w,
        answered: mine.filter((r) => r.outcome === 'answered').length,
        thin: mine.filter((r) => r.outcome === 'thin').length,
        failed: mine.filter((r) => r.outcome === 'failed').length,
        unclassified: mine.filter((r) => !r.outcome).length,
      };
    }),
    research_required_rate: (() => {
      const known = all.filter((r) => r.research_required !== null);
      const yes = known.filter((r) => r.research_required).length;
      return {
        value: known.length ? Math.round((yes / known.length) * 100) : null,
        note: known.length
          ? `${yes} of ${known.length} asks were flagged as needing research. ${all.length - known.length ? `${all.length - known.length} rows record neither Yes nor No.` : ''}`.trim()
          : 'No row records research_required.',
      };
    })(),
    tool_usage: [...tools.entries()]
      .map(([tool, t]) => ({ tool, calls: t.calls, hits: t.hits, used: t.used, cited_rate: t.hits ? Math.round((t.used / t.hits) * 100) : null }))
      .sort((a, b) => b.calls - a.calls),
    tool_note:
      tools.size === 0
        ? 'No ask records a tool call in its evidence blob.'
        : 'From each ask’s own searches blob: calls made, hits returned, and how many of those hits ended up behind an [S#] citation. A tool with hits and no cited uses is being called and ignored.',
    confidence_mix: buckets.map(([bucket, test]) => ({ bucket, n: withConfidence.filter((r) => test(r.confidence!)).length })).filter((b) => b.n > 0),
    confidence_note: withConfidence.length
      ? `Citation coverage as the agent computed it on ${withConfidence.length} of ${all.length} asks — the share of tool calls that produced a traceable citation. It is not a model-reported probability.`
      : 'No ask records a confidence figure.',
    by_lane: lanes
      .map((lane_id) => {
        const mine = all.filter((r) => (r.lane_id ?? '(no lane_id)') === lane_id);
        return { lane_id, asks: mine.length, thin: mine.filter((r) => r.outcome === 'thin').length, unclassified: mine.filter((r) => !r.outcome).length };
      })
      .sort((a, b) => b.asks - a.asks),
    last_ask: {
      at: newest?.asked_at ?? null,
      trace_id: newest?.trace_id ?? null,
      note: newest?.asked_at
        ? sinceLast === 0
          ? 'North Star was asked something today.'
          : `North Star has not been asked anything for ${sinceLast} ${sinceLast === 1 ? 'day' : 'days'}. Silence here is itself a signal: it means nothing is routing questions to it.`
        : 'No ask carries a timestamp.',
    },
  };
  metricsCache.set('ns', { version: storeVersion, value });
  return value;
}

/* ---------------------------------------------------- research twin (RT) */

/**
 * Collapse the attempt log into one row per card.
 *
 * The Research Queue holds one row per research *attempt*, and `card_id`
 * repeats — a single card can carry twenty rows. Queue depth, run counts and
 * days stuck are all per-card questions, so they are answered against this
 * collapse; the page prints both figures so the shape is never hidden.
 *
 * The newest attempt decides the card's current state. `run_count` takes the
 * highest seen, and `first_stuck_at` the earliest, because that field is
 * deliberately not re-stamped and the earliest stamp is the real watermark.
 */
export async function rtCards(): Promise<RtCard[]> {
  const byCard = new Map<string, RtAttempt[]>();
  for (const a of await rtAttempts()) {
    const key = a.card_id ?? a.id;
    const held = byCard.get(key) ?? [];
    held.push(a);
    byCard.set(key, held);
  }
  const now = today();
  return [...byCard.entries()]
    .map(([card_id, attempts]) => {
      const ordered = [...attempts].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
      const latest = ordered[ordered.length - 1];
      const stuckStamps = ordered.map((a) => a.first_stuck_at).filter((v): v is string => Boolean(v)).sort();
      const firstStuck = stuckStamps[0] ?? null;
      const runs = ordered.map((a) => a.run_count ?? 0);
      return {
        card_id,
        lane_id: latest.lane_id,
        hypothesis: ordered.find((a) => a.hypothesis)?.hypothesis ?? null,
        status: latest.status,
        status_label: latest.status ?? 'untriaged',
        confidence_level: latest.confidence_level,
        gap_classification: ordered.reverse().find((a) => a.gap_classification)?.gap_classification ?? null,
        missing_elements: latest.missing_elements,
        target_source_types: latest.target_source_types,
        research_summary: latest.research_summary,
        run_count: runs.length ? Math.max(...runs) : 0,
        requires_human: attempts.some((a) => a.requires_human),
        first_stuck_at: firstStuck,
        days_stuck: firstStuck ? Math.max(0, dayDiff(firstStuck.slice(0, 10), now)) : null,
        source_system: latest.source_system,
        created_at: ordered[0]?.created_at ?? null,
        last_attempt_at: latest.created_at,
        attempts: attempts.length,
        source: latest.source,
        airtable: latest.airtable,
      };
    })
    .sort((a, b) => (b.last_attempt_at ?? '').localeCompare(a.last_attempt_at ?? ''));
}

export async function rtMetrics(): Promise<RtMetrics> {
  const hit = metricsCache.get('rt');
  if (hit && hit.version === storeVersion) return hit.value as RtMetrics;
  const attempts = await rtAttempts();
  const cards = await rtCards();
  const needsHuman = cards.filter((c) => c.requires_human);
  const untriaged = cards.filter((c) => !c.status);
  const stuck = cards.filter((c) => c.days_stuck !== null);
  const weeks = lastWeeks(8);

  const statuses = [...new Set(cards.map((c) => c.status_label))].sort();
  const gaps = [...new Set(cards.map((c) => c.gap_classification).filter((v): v is string => Boolean(v)))].sort();
  const levels = [...new Set(cards.map((c) => c.confidence_level).filter((v): v is string => Boolean(v)))].sort();
  const stuckBuckets: [string, (d: number) => boolean][] = [
    ['0–2 days', (d) => d <= 2],
    ['3–7 days', (d) => d > 2 && d <= 7],
    ['8–14 days', (d) => d > 7 && d <= 14],
    ['over 14 days', (d) => d > 14],
  ];
  const oldest = [...stuck].sort((a, b) => (b.days_stuck ?? 0) - (a.days_stuck ?? 0))[0] ?? null;
  const runBuckets = ['0', '1', '2', '3 (capped)', 'over 3'];
  const runBucket = (n: number) => (n >= 4 ? 'over 3' : n === 3 ? '3 (capped)' : String(n));
  const overCap = cards.filter((c) => c.run_count > 3).length;

  const value: RtMetrics = {
    kind: 'rt',
    computed_at: nowIso(),
    scope: { rows: attempts.length, cards: cards.length },
    requires_human: {
      n: needsHuman.length,
      note: needsHuman.length
        ? `${needsHuman.length} ${needsHuman.length === 1 ? 'card has' : 'cards have'} requires_human ticked — the hard stop the queue sets once a card has had three attempts. These need a person; nothing else in the queue will move them.`
        : 'No card has reached the hard stop.',
    },
    by_status: statuses.map((st) => ({ status: st, label: st === 'untriaged' ? 'Untriaged' : st.charAt(0).toUpperCase() + st.slice(1), n: cards.filter((c) => c.status_label === st).length })).sort((a, b) => b.n - a.n),
    status_note: `Queue depth by the status on each card’s newest attempt. ${untriaged.length ? `A blank status is a real state — a card migrated in and not yet triaged — and is shown as “untriaged”, not as an error.` : ''}`.trim(),
    days_stuck: stuckBuckets.map(([bucket, test]) => ({ bucket, n: stuck.filter((c) => test(c.days_stuck!)).length })),
    days_stuck_note: stuck.length
      ? `${stuck.length} of ${cards.length} cards have ever been stuck. Counted from first_stuck_at — when the card FIRST went stuck, which the queue deliberately does not re-stamp on later attempts, so this is the true age of the problem rather than the age of the last retry.`
      : 'No card carries a first_stuck_at, so nothing has been recorded as stuck.',
    oldest_stuck: {
      card_id: oldest?.card_id ?? null,
      days: oldest?.days_stuck ?? null,
      note: oldest ? `Longest-standing stuck card, ${oldest.days_stuck} days since it first went stuck.` : 'Nothing is stuck.',
    },
    run_count_mix: runBuckets.map((runs) => ({ runs, n: cards.filter((c) => runBucket(c.run_count) === runs).length })).filter((r) => r.n > 0),
    run_count_note: `Attempts per card, taking the highest run_count on any of its rows. The queue caps at three and sets requires_human there.${overCap ? ` ${overCap} ${overCap === 1 ? 'card is' : 'cards are'} above the cap, which the cap alone does not explain.` : ''}`,
    gap_mix: gaps.map((gap) => ({ gap: gap.replace(/_/g, ' '), n: cards.filter((c) => c.gap_classification === gap).length })).sort((a, b) => b.n - a.n),
    confidence_mix: levels.map((level) => ({ level, n: cards.filter((c) => c.confidence_level === level).length })),
    created_per_week: series(
      weeks.map((w) => ({ label: weekLabel(w), value: cards.filter((c) => c.created_at && weekStart(c.created_at.slice(0, 10)) === w).length })),
      'Cards by the week they first entered the queue, last eight weeks.',
    ),
    untriaged: {
      n: untriaged.length,
      note: untriaged.length
        ? `${untriaged.length} ${untriaged.length === 1 ? 'card carries' : 'cards carry'} no status. Blank is a real state here: these were migrated in and have not been triaged.`
        : 'Every card carries a status.',
    },
  };
  metricsCache.set('rt', { version: storeVersion, value });
  return value;
}
