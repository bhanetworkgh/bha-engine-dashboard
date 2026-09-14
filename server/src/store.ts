/**
 * The record store: loops, Codex entries, build patterns, commercial cards and
 * the three telemetry kinds as this dashboard holds them, plus the
 * status-change history the counts on those pages are computed from.
 *
 * Decision (2026-09-13, Destiny): **this reads the mirror tables directly.**
 * Step 3 of the Airtable → Postgres migration. Until today the rows on every
 * page were a read model in `records`, rebuilt from Airtable every fifteen
 * minutes by sync.ts. The engine now writes into the `engine_*` tables through
 * /api/engine/:kind, those tables were backfilled from Airtable on 13 Sep, and
 * so the sync, the Airtable client and the AIRTABLE_API_KEY are gone. There is
 * no Airtable read path left in this server.
 *
 * What that changes here, and what it does not:
 *
 *   - A mirror row is `{ airtable_record_id, created_time, fields }` — exactly
 *     the shape Airtable's REST API returns, with Airtable's own field names
 *     kept verbatim inside `fields`. So the mappers in sources.ts are unchanged
 *     and still read `What`, `Jason Status`, `Layer1 Review ` and the rest by
 *     the names the engine writes. A rename here would break the engine's
 *     writes silently, which is the one thing this migration must not do.
 *   - There is no second copy and nothing to resync: a page reads the same row
 *     the engine wrote, in the same database, in the same request. `records`
 *     is left in place, unread — nothing drops a table — and `events` and
 *     `observations` carry on as they were.
 *   - `events` is now the whole status ledger. The previous status of a record
 *     is the last event recorded for it, not a column on a read-model row, and
 *     reconcile() below is what notices a status that changed while this
 *     process was not looking.
 *   - Writes from the interface go to the mirror table first, and a loop's
 *     edit then goes straight to Airtable — see loops.ts. Postgres is the
 *     write; Airtable is a second system being told, and a write there that
 *     fails is recorded on the loop, never rolled back.
 */
import { getMeta, nowIso, setMetaIfAbsent, today } from './db';
import * as codex_ from './codex';
import * as loops_ from './loops';
import * as mirror from './mirror';
import { getPool, withTransaction, type Queryable } from './pg';
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
  Freshness,
  Layer0Hold,
  CodexReconciliation,
  CodexResync,
  CodexResyncTable,
  Loop,
  LoopMetrics,
  LoopStatus,
  RecordWrite,
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
} from '../../src/data/types';
import {
  CLIENTS_INDEX,
  SLACK_TO_BUILDER,
  CODEX_BASE,
  CODEX_EDITABLE,
  CODEX_JASON_STATUS,
  CODEX_TABLES,
  COMMERCIAL,
  LOOP_LANE_TAGS,
  LOOP_STATUS_TO_AIRTABLE,
  LOOP_TABLES,
  LOOPS_BASE,
  NORTH_STAR,
  PATTERNS,
  RESEARCH_QUEUE,
  type AtRecord,
  canonicalPerson,
  codexSummary,
  codexTableById,
  isoWeek,
  loopTable,
  loopTableById,
  mapClientLane,
  mapClientQuestion,
  mapCodex,
  mapLayer0,
  mapLoop,
  mapNsRecord,
  mapOpportunity,
  mapPattern,
  mapRtAttempt,
  missingLabel,
  patternSummary,
} from './sources';

export type { RecordKind, RecordMetrics, Metric };

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

/**
 * One record as the pages want it: the mapped object as JSON, plus the few
 * things that are not in the record itself — the status ledger's view of its
 * state, and this dashboard's own note on it.
 */
export interface Row {
  kind: RecordKind;
  id: string;
  json: string;
  status: string;
  builder: string | null;
  raised_at: string | null;
  closed_at: string | null;
  table_id: string;
  /** When the mirror row last changed. */
  updated_at: string;
  /** Who wrote it last: 'airtable' (the migration backfill), 'engine', or 'ui'. */
  source: string;
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

/* ------------------------------------------------------- the mirror tables */

/**
 * Which mirror table holds each kind, and where its rows live in Airtable so
 * every row can still link back to its source.
 *
 * `table` is null where the kind spans several Airtable tables — loops and
 * Codex entries are one table per builder, client questions one per lane — and
 * the row carries its own `table_id` in that case. The table a row sits in is
 * its owner in this engine, which is why it is stored per row rather than
 * derived from a field.
 */
const MIRROR: Record<RecordKind, { table: string; base: string; at_table: string | null }> = {
  loops: { table: 'engine_loops', base: LOOPS_BASE, at_table: null },
  codex: { table: 'engine_codex_submissions', base: CODEX_BASE, at_table: null },
  patterns: { table: 'engine_build_patterns', base: PATTERNS.base, at_table: PATTERNS.table },
  commercial: { table: 'engine_commercial_cards', base: COMMERCIAL.base, at_table: COMMERCIAL.table },
  ns: { table: 'engine_ns_records', base: NORTH_STAR.base, at_table: NORTH_STAR.table },
  rt: { table: 'engine_rt_attempts', base: RESEARCH_QUEUE.base, at_table: RESEARCH_QUEUE.table },
  clients: { table: 'engine_client_lanes', base: CLIENTS_INDEX.base, at_table: CLIENTS_INDEX.table },
  client_questions: { table: 'engine_client_questions', base: CLIENTS_INDEX.base, at_table: null },
};

/** Which kind is which in mirror.ts's vocabulary, for the write path. */
const MIRROR_KIND: Record<RecordKind, mirror.MirrorKind> = {
  loops: 'loops',
  codex: 'codex',
  patterns: 'patterns',
  commercial: 'commercial',
  ns: 'ns',
  rt: 'rt',
  clients: 'client_lanes',
  client_questions: 'client_questions',
};

const HAS_BUILDER = new Set<RecordKind>(['loops', 'codex']);
const HAS_TABLE = new Set<RecordKind>(['loops', 'codex', 'client_questions']);
const HAS_LANE = new Set<RecordKind>(['commercial', 'ns', 'rt', 'client_questions']);

interface MirrorRow {
  pk: string;
  airtable_record_id: string | null;
  created_time: string | null;
  fields: Record<string, unknown> | null;
  table_id: string | null;
  builder_id: string | null;
  lane_id: string | null;
  source: string;
  first_seen_at: string;
  updated_at: string;
}

/**
 * The same nine things from every mirror table, whether or not that table has
 * the column. Only the ones something keys or groups on were promoted out of
 * the payload, so the missing ones are selected as null rather than guessed at.
 */
function selectFor(kind: RecordKind): string {
  return `SELECT id::text AS pk, airtable_record_id, created_time, fields,
                 ${HAS_TABLE.has(kind) ? 'table_id' : 'NULL::text AS table_id'},
                 ${HAS_BUILDER.has(kind) ? 'builder_id' : 'NULL::text AS builder_id'},
                 ${HAS_LANE.has(kind) ? 'lane_id' : 'NULL::text AS lane_id'},
                 source, first_seen_at, updated_at
            FROM ${MIRROR[kind].table}`;
}

/**
 * The id the rest of the dashboard knows a record by.
 *
 * Airtable's record id where there is one — every row the backfill brought has
 * one, and so does every engine write that names it. A row the engine created
 * here before Airtable had it has none, and gets this database's own key
 * instead, so that a detail page, a status change and a note can still address
 * it. It is stable: the primary key never changes, and adopting the row when
 * Airtable's id arrives is the one case where a record's id moves.
 */
function idOf(mr: MirrorRow): string {
  return mr.airtable_record_id ?? `row-${mr.pk}`;
}

/** Which Airtable table this row is from: its own where the kind spans several, the kind's otherwise. */
function tableOf(kind: RecordKind, mr: MirrorRow): string {
  if (mr.table_id) return mr.table_id;
  if (kind === 'loops') return loopTable(mr.builder_id ?? '')?.table ?? '';
  if (kind === 'codex') return CODEX_TABLES.find((t) => t.owner === mr.builder_id)?.table ?? '';
  return MIRROR[kind].at_table ?? '';
}

function asRecord(mr: MirrorRow): AtRecord {
  return { id: idOf(mr), createdTime: mr.created_time ?? '', fields: mr.fields ?? {} };
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

export function mapRecord(kind: RecordKind, rec: AtRecord, table: string, lane?: string | null): Mapped {
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
    case 'client_questions':
      // The lane a question belongs to is carried on the row: the index names
      // the per-lane table and the lane it belongs to, and the write path
      // records both. Nothing is hardcoded and nothing is inferred.
      return { kind, obj: mapClientQuestion(rec, lane ?? table, table) };
  }
}

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

/** The status that means a record is done. Only loops have one. */
const TERMINAL: Partial<Record<RecordKind, string>> = { loops: 'closed' };

/* --------------------------------------------------------- status ledger */

interface LastEvent {
  record_id: string;
  from_status: string | null;
  to_status: string;
  at: string;
}

/** The newest event for one record — its state as this database last saw it. */
async function lastEventFor(kind: RecordKind, id: string, on?: Queryable): Promise<LastEvent | undefined> {
  const r = await db(on).query<LastEvent>('SELECT record_id, from_status, to_status, at FROM events WHERE kind = $1 AND record_id = $2 ORDER BY at DESC, seq DESC LIMIT 1', [kind, id]);
  return r.rows[0];
}

/** The newest event for every record of a kind — which is that record's state as this database last saw it. */
async function lastEvents(kind: RecordKind, on?: Queryable): Promise<Map<string, LastEvent>> {
  const r = await db(on).query<LastEvent>(
    `SELECT DISTINCT ON (record_id) record_id, from_status, to_status, at
       FROM events WHERE kind = $1 ORDER BY record_id, at DESC, seq DESC`,
    [kind],
  );
  return new Map(r.rows.map((e) => [e.record_id, e]));
}

/**
 * When a record reached its terminal status, where the ledger can say.
 *
 * Only a *transition* dates a close: an event with no `from_status` is the
 * first time this database saw the record at all, and a loop that was already
 * closed when it arrived has no close date anywhere — the loop tables carry
 * none. That is the same rule the read model applied before the cut, kept
 * deliberately, so a backfill date never reads as a close date.
 */
function terminalDates(kind: RecordKind, last: Map<string, LastEvent>): Map<string, string> {
  const terminal = TERMINAL[kind];
  const out = new Map<string, string>();
  if (!terminal) return out;
  for (const [id, e] of last) if (e.to_status === terminal && e.from_status !== null) out.set(id, e.at.slice(0, 10));
  return out;
}

/** This dashboard's own note on someone else's record. Airtable never carried it; see migration 4. */
async function notesFor(kind: RecordKind, on?: Queryable): Promise<Map<string, string>> {
  const r = await db(on).query<{ record_id: string; note: string }>('SELECT record_id, note FROM record_notes WHERE kind = $1', [kind]);
  return new Map(r.rows.map((n) => [n.record_id, n.note]));
}

type WritebackRow = RecordWrite & { record_id: string; from_record_id: string | null };

const WB_COLS = 'record_id, state, status, reason, http, action, detail, from_table, to_table, from_record_id, steps, at';

/**
 * The write as the page reads it: the stranded copy's record id stays on the
 * server, and the builder whose table still holds it comes out instead, because
 * that is what an action on the row has to be able to name.
 */
function asWrite({ record_id: _id, from_record_id: _copy, ...w }: WritebackRow): RecordWrite {
  return { ...w, from_builder: w.state === 'duplicate' && w.from_table ? (loopTableById(w.from_table)?.owner ?? null) : null };
}

/** The two kinds this dashboard writes to Airtable, and so the two that can fail to land. */
const WRITES_TO_AIRTABLE = new Set<RecordKind>(['loops', 'codex']);

/**
 * The newest write per record, so a list can say which changes did not reach
 * Airtable. The table is a log and only grows; this is the latest line of each
 * record's own history, which is what the row has to show.
 */
async function writebacksFor(kind: RecordKind, on?: Queryable): Promise<Map<string, RecordWrite>> {
  if (!WRITES_TO_AIRTABLE.has(kind)) return new Map();
  const r = await db(on).query<WritebackRow>(`SELECT DISTINCT ON (record_id) ${WB_COLS} FROM record_writes WHERE kind = $1 ORDER BY record_id, seq DESC`, [kind]);
  return new Map(r.rows.map((row) => [row.record_id, asWrite(row)]));
}

async function writebackFor(kind: RecordKind, id: string, on?: Queryable): Promise<RecordWrite | null> {
  const r = await db(on).query<WritebackRow>(`SELECT ${WB_COLS} FROM record_writes WHERE kind = $1 AND record_id = $2 ORDER BY seq DESC LIMIT 1`, [kind, id]);
  const row = r.rows[0];
  return row ? asWrite(row) : null;
}

/** The same line with the stranded copy's id still on it, for the retry that deletes it. */
async function lastWriteRow(kind: RecordKind, id: string): Promise<WritebackRow | null> {
  const r = await db().query<WritebackRow>(`SELECT ${WB_COLS} FROM record_writes WHERE kind = $1 AND record_id = $2 ORDER BY seq DESC LIMIT 1`, [kind, id]);
  return r.rows[0] ?? null;
}

export interface RecordWriteLog {
  kind: RecordKind;
  record_id: string;
  /** The record's own id in its source — a loop_id, a Codex entry id. */
  natural_id: string | null;
  state: RecordWrite['state'];
  status: string;
  action: string;
  detail: string | null;
  reason: string | null;
  http: number | null;
  steps: string[];
  from_table: string | null;
  to_table: string | null;
  /** The source row a half-landed move left behind, so the delete can be retried against it. */
  from_record_id?: string | null;
  new_record_id: string | null;
  actor: string;
}

/**
 * One line per write, kept. A loop move that half-lands is the case this was
 * built for — `steps` says the create landed and the delete did not, and
 * nothing later overwrites that — and a Codex write uses the same shape rather
 * than a second table that would drift from this one.
 */
export async function logRecordWrite(e: RecordWriteLog): Promise<void> {
  await db().query(
    `INSERT INTO record_writes (kind, record_id, natural_id, state, status, reason, http, action, detail, from_table, to_table, from_record_id, steps, new_record_id, actor, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [e.kind, e.record_id, e.natural_id, e.state, e.status, e.reason, e.http, e.action, e.detail, e.from_table, e.to_table, e.from_record_id ?? null, e.steps.join(' · ') || null, e.new_record_id, e.actor, nowIso()],
  );
  const where = `${e.kind} ${e.natural_id ?? e.record_id} ${e.action}`;
  if (e.state === 'ok' || e.state === 'skipped') console.log(`${where}: ${e.state}${e.detail ? ` — ${e.detail}` : ''}${e.steps.length ? ` (${e.steps.join(', ')})` : ''}`);
  else console.error(`${where}: ${e.state.toUpperCase()}${e.http ? ` (HTTP ${e.http})` : ''} — ${e.reason ?? 'no reason given'}${e.steps.length ? ` · completed: ${e.steps.join(', ')}` : ' · nothing completed'}`);
  bumpVersion();
}

export async function setNote(kind: RecordKind, id: string, note: string | null): Promise<void> {
  const text = (note ?? '').trim();
  if (!text) await db().query('DELETE FROM record_notes WHERE kind = $1 AND record_id = $2', [kind, id]);
  else {
    await db().query(
      `INSERT INTO record_notes (kind, record_id, note, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, record_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      [kind, id, text.slice(0, 2000), nowIso()],
    );
  }
  bumpVersion();
}

/**
 * Records a status this database had not seen for a record.
 *
 * The previous status is the last event, not a column: `events` is the ledger
 * now. `via` says how we learned of the change and is what the close-rate
 * figures filter on — 'engine' and 'ui' are changes with a real timestamp,
 * 'mirror' is one reconcile() noticed after the fact and cannot date.
 */
async function recordState(kind: RecordKind, m: Mapped, via: 'engine' | 'ui' | 'mirror', at: string, prev: LastEvent | undefined, on?: Queryable): Promise<{ changed: boolean; inserted: boolean }> {
  const status = statusOf(m);
  if (prev && prev.to_status === status) return { changed: false, inserted: false };
  await db(on).query('INSERT INTO events (kind, record_id, builder, from_status, to_status, via, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    kind,
    m.obj.id,
    builderOf(m),
    prev?.to_status ?? null,
    status,
    via,
    at,
  ]);
  bumpVersion();
  return { changed: Boolean(prev), inserted: !prev };
}

/* ------------------------------------------------------------------ rows */

/**
 * Mapped rows are memoised for three seconds, keyed by the store version.
 *
 * A page asks for the same kind several times over one request — the list, the
 * metrics, the by-builder pass — and mapping a few hundred records each time is
 * work for nothing. Every write in this process bumps the version and drops the
 * memo immediately; the three seconds is the ceiling on how long a write made
 * somewhere else could take to appear. It is a cache of this process's own
 * reads, never a store: there is one row for a record and it is in Postgres.
 */
const rowsCache = new Map<string, { version: number; at: number; value: Row[] }>();
const ROWS_TTL_MS = 3_000;

async function rows(kind: RecordKind, table?: string, on?: Queryable): Promise<Row[]> {
  const key = `${kind}:${table ?? '*'}`;
  const hit = rowsCache.get(key);
  if (!on && hit && hit.version === storeVersion && Date.now() - hit.at < ROWS_TTL_MS) return hit.value;

  const sql = table ? `${selectFor(kind)} WHERE table_id = $1` : selectFor(kind);
  const r = await db(on).query<MirrorRow>(sql, table ? [table] : []);
  const last = await lastEvents(kind, on);
  const closes = terminalDates(kind, last);
  const notes = await notesFor(kind, on);
  const writebacks = await writebacksFor(kind, on);

  const out: Row[] = [];
  for (const mr of r.rows) {
    const id = idOf(mr);
    let m: Mapped;
    try {
      m = mapRecord(kind, asRecord(mr), tableOf(kind, mr), mr.lane_id);
    } catch (e) {
      // A row whose table this server does not recognise cannot be mapped. It
      // is named rather than swallowed, and the other rows still render.
      console.log(`store: skipped ${kind} ${id} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const closed_at = closes.get(id) ?? null;
    const note = notes.get(id) ?? null;
    const wb = writebacks.get(id) ?? null;
    out.push({
      kind,
      id,
      json: JSON.stringify(WRITES_TO_AIRTABLE.has(kind) ? { ...m.obj, closed_at, note, writeback: wb } : { ...m.obj, closed_at, note }),
      status: statusOf(m),
      builder: builderOf(m),
      raised_at: raisedOf(m),
      closed_at,
      table_id: tableOf(kind, mr),
      updated_at: mr.updated_at,
      source: mr.source,
    });
  }
  if (!on) rowsCache.set(key, { version: storeVersion, at: Date.now(), value: out });
  return out;
}

/** The mirror row behind one record id, by Airtable's id or by this database's own. */
async function mirrorRowById(kind: RecordKind, id: string, on?: Queryable): Promise<MirrorRow | null> {
  const local = /^row-(\d+)$/.exec(id);
  const r = local
    ? await db(on).query<MirrorRow>(`${selectFor(kind)} WHERE id = $1`, [local[1]])
    : await db(on).query<MirrorRow>(`${selectFor(kind)} WHERE airtable_record_id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function rowById(kind: RecordKind, id: string, on?: Queryable): Promise<Row | null> {
  const mr = await mirrorRowById(kind, id, on);
  if (!mr) return null;
  const m = mapRecord(kind, asRecord(mr), tableOf(kind, mr), mr.lane_id);
  const last = (await lastEvents(kind, on)).get(id);
  const closed_at = last && last.to_status === TERMINAL[kind] && last.from_status !== null ? last.at.slice(0, 10) : null;
  const n = await db(on).query<{ note: string }>('SELECT note FROM record_notes WHERE kind = $1 AND record_id = $2', [kind, id]);
  const note = n.rows[0]?.note ?? null;
  const wb = WRITES_TO_AIRTABLE.has(kind) ? await writebackFor(kind, id, on) : null;
  return {
    kind,
    id,
    json: JSON.stringify(WRITES_TO_AIRTABLE.has(kind) ? { ...m.obj, closed_at, note, writeback: wb } : { ...m.obj, closed_at, note }),
    status: statusOf(m),
    builder: builderOf(m),
    raised_at: raisedOf(m),
    closed_at,
    table_id: tableOf(kind, mr),
    updated_at: mr.updated_at,
    source: mr.source,
  };
}

/* ------------------------------------------------------------ reconcile */

export interface ReconcileResult {
  kind: RecordKind;
  rows: number;
  first_seen: number;
  changed: number;
}

/**
 * Brings the status ledger up to date with the mirror tables.
 *
 * Every status change this dashboard can date has to be written down at the
 * moment it is learned, because nothing upstream keeps a status-change history
 * — the loop tables carry no close date at all. A write through
 * /api/engine/:kind or through the interface records its own event as it lands.
 * This is for everything else: rows the backfill brought, and anything that
 * changed in the database while this process was not running.
 *
 * Idempotent — a second run writes nothing — and cheap, because it is one read
 * of tables that are in this same database. Runs at boot.
 */
export async function reconcile(only?: RecordKind): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];
  for (const kind of only ? [only] : KINDS) {
    const all = await rows(kind);
    const last = await lastEvents(kind);
    let first_seen = 0;
    let changed = 0;
    await withTransaction(async (client) => {
      for (const row of all) {
        const prev = last.get(row.id);
        if (prev && prev.to_status === row.status) continue;
        // A record seen for the first time is stamped when this database first
        // held it, not when this reconcile ran — otherwise every restart would
        // date the whole history to the restart.
        await client.query('INSERT INTO events (kind, record_id, builder, from_status, to_status, via, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
          kind,
          row.id,
          row.builder,
          prev?.to_status ?? null,
          row.status,
          'mirror',
          prev ? nowIso() : row.updated_at,
        ]);
        if (prev) changed++;
        else first_seen++;
      }
    });
    if (first_seen || changed) bumpVersion();
    out.push({ kind, rows: all.length, first_seen, changed });
  }
  return out;
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
 * kind — no status, no write path — so they are read straight off their own
 * mirror table rather than going through the row machinery above.
 */
export async function layer0Holds(): Promise<Layer0Hold[]> {
  const r = await db().query<MirrorRow>(
    `SELECT id::text AS pk, airtable_record_id, created_time, fields, NULL::text AS table_id, NULL::text AS builder_id,
            NULL::text AS lane_id, source, first_seen_at, updated_at FROM engine_layer0_holds`,
  );
  return r.rows.map((mr) => mapLayer0(asRecord(mr)));
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

/* ------------------------------------------------------------- freshness */

/**
 * How old the rows on a page are, and where they came from.
 *
 * There is no sync any more, so there is no "last synced" to report and
 * nothing that could be behind a source. What a page can honestly say is when
 * one of its rows last changed in this database, how many there are, and how
 * many of them the engine has written since the migration — which is the one
 * number that says whether this kind is still being fed.
 */
export async function freshness(kind: RecordKind): Promise<Freshness> {
  const m = MIRROR[kind];
  const grouped = HAS_TABLE.has(kind);
  const r = await db().query<{ table_id: string | null; n: string; changed_at: string | null; from_engine: string }>(
    grouped
      ? `SELECT table_id, count(*)::text AS n, max(updated_at) AS changed_at,
                count(*) FILTER (WHERE source <> 'airtable')::text AS from_engine
           FROM ${m.table} GROUP BY table_id`
      : `SELECT NULL::text AS table_id, count(*)::text AS n, max(updated_at) AS changed_at,
                count(*) FILTER (WHERE source <> 'airtable')::text AS from_engine
           FROM ${m.table}`,
  );
  const tables = r.rows
    .filter((row) => Number(row.n) > 0)
    .map((row) => ({ table: row.table_id ?? (m.at_table ?? m.table), label: labelForTable(kind, row.table_id), n: Number(row.n) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const total = r.rows.reduce((n, row) => n + Number(row.n), 0);
  const changed_at = r.rows.reduce<string | null>((a, row) => (row.changed_at && (!a || row.changed_at > a) ? row.changed_at : a), null);
  return {
    kind,
    source: total ? 'engine' : 'none',
    changed_at,
    rows: total,
    from_engine: r.rows.reduce((n, row) => n + Number(row.from_engine), 0),
    tables,
    note: total ? null : 'Nothing of this kind is held. The engine writes these rows to /api/engine/' + MIRROR_KIND[kind] + '; nothing has arrived yet.',
  };
}

function labelForTable(kind: RecordKind, table: string | null): string {
  if (kind === 'loops') return loopTableById(table ?? '')?.label ?? table ?? 'Unknown table';
  if (kind === 'codex') return codexTableById(table ?? '')?.label ?? table ?? 'Unknown table';
  if (kind === 'client_questions') return table ?? 'Unknown table';
  return mirror.KINDS[MIRROR_KIND[kind]].label;
}

export async function observe(kind: RecordKind, metric: string, value: number): Promise<void> {
  await db().query('INSERT INTO observations (kind, metric, at, value) VALUES ($1, $2, $3, $4)', [kind, metric, nowIso(), value]);
  bumpVersion();
}
export async function cardTrend(id: string): Promise<MetricSeries> {
  const obs = await observations('commercial', `unresolved:${id}`);
  const days = new Set(obs.map((o) => o.at.slice(0, 10)));
  return days.size >= 2
    ? { points: obs.map((o) => ({ label: o.at.slice(5, 10), value: Math.round(o.value) })), note: 'missing_research_count as observed at each boot, since this database started recording.' }
    : { points: null, note: obs.length ? `Seen on one day only (${[...days][0]}); a trend needs at least two.` : 'Not observed yet.' };
}
async function observations(kind: RecordKind, metric: string): Promise<{ at: string; value: number }[]> {
  const r = await db().query<{ at: string; value: number }>('SELECT at, value FROM observations WHERE kind = $1 AND metric = $2 ORDER BY at', [kind, metric]);
  return r.rows;
}

/** The two figures a trend needs history for. Observed once a boot, after reconcile. */
export async function recordObservations(): Promise<void> {
  const p = await patternMetrics();
  if (p.scope.rows) await observe('patterns', 'canonical_share', (p.canonical / p.scope.rows) * 100);
  const c = await commercialMetrics();
  if (c.unresolved_questions.value !== null) await observe('commercial', 'unresolved_questions', c.unresolved_questions.value);
  for (const o of await opportunities()) if (o.missing_research_count !== null) await observe('commercial', `unresolved:${o.id}`, o.missing_research_count);
}

/* ----------------------------------------------------------------- writes */

/**
 * Writes one record's own fields, keeping every field it already had.
 *
 * Airtable's PATCH left untouched fields alone and this keeps that behaviour,
 * which matters more now than it did: `fields` is stored whole, so replacing it
 * with the two keys the interface knows about would drop every other field on
 * the row — the exact silent data loss this migration was meant to end.
 *
 * Decision (2026-09-13, Destiny): this is the write, not a write-through. A
 * change made here is in the mirror table the engine reads and writes; if n8n
 * later pushes the same record carrying Airtable's copy of these fields, that
 * push wins, because a push is the newer statement about the record.
 *
 * Decision (2026-09-14, Destiny): a loop's *status* is additionally pushed to
 * Airtable, through n8n rather than from here — see writeback.ts and
 * pushStatus. That is not a return to write-through: Postgres is still written
 * first and is still what this dashboard shows. It exists because the 08:00
 * Open Loops digest reads Airtable, so a close that stops here comes back
 * tomorrow morning as though it never happened.
 */
async function writeFields(kind: RecordKind, mr: MirrorRow, patch: Record<string, unknown>, move?: { builder_id: string; table_id: string }): Promise<Mapped> {
  const fields = { ...(mr.fields ?? {}), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete fields[k];
  try {
    await mirror.upsert(
      MIRROR_KIND[kind],
      {
        record_id: mr.airtable_record_id,
        created_time: mr.created_time,
        fields,
        builder_id: move?.builder_id ?? mr.builder_id,
        table_id: move?.table_id ?? mr.table_id,
        lane_id: mr.lane_id,
      },
      'ui',
    );
  } catch (e) {
    // mirror.upsert's refusals name the field that was wrong. Passing that
    // through beats "the server hit an error handling that request", which is
    // what a row whose builder the engine no longer recognises used to get.
    if (e instanceof mirror.MirrorError) throw new StoreError(e.message, e.status);
    throw e;
  }
  bumpVersion();
  return mapRecord(kind, { id: idOf(mr), createdTime: mr.created_time ?? '', fields }, move?.table_id ?? tableOf(kind, mr), mr.lane_id);
}

/**
 * Saves an edit to one loop: its What, status, lane, and which builder's table
 * it lives in — the last of which is a move, not a field.
 *
 * **Postgres first, then Airtable.** By the time Airtable is touched the change
 * is already this dashboard's own record. The Airtable half never throws,
 * never rolls anything back, and every outcome — including a move that created
 * the new row and failed to delete the old — is stored on the loop and shown
 * on it.
 *
 * A move and an edit in the same save are one operation, not two: the edits are
 * folded into the fields the new row is created with, so there is no window
 * where the row has moved but still holds the old text.
 */
export async function editLoop(id: string, patch: loops_.LoopPatch, actor = 'dashboard'): Promise<Loop> {
  loops_.validate(patch);
  const mr = await mirrorRowById('loops', id);
  if (!mr) throw new StoreError('That loop is not held by this dashboard.', 404);

  const fields = loops_.asFields(patch);
  const fromBuilder = mr.builder_id;
  const fromTable = tableOf('loops', mr);
  const moveTo = patch.builder && patch.builder !== fromBuilder ? patch.builder : null;
  const destination = moveTo ? loopTable(moveTo) : null;
  if (!Object.keys(fields).length && !destination) throw new StoreError('Nothing to change.', 422);

  const loopId = typeof mr.fields?.loop_id === 'string' ? mr.fields.loop_id : null;
  // What changed, in one sentence, for the log.
  const changed = Object.keys(fields);
  if (destination) changed.push(`builder ${fromBuilder} → ${destination.owner}`);

  // 1. Postgres takes the field edits first, and they stand whatever Airtable
  //    does next. The builder is deliberately not among them — see step 3.
  const m = await writeFields('loops', mr, fields);
  if (patch.status !== undefined) await recordState('loops', m, 'ui', nowIso(), await lastEventFor('loops', id));

  // 2. Airtable.
  const r = await loops_.apply({
    record_id: mr.airtable_record_id,
    table: fromTable,
    loop_id: loopId,
    fields,
    moveTo,
  });

  /**
   * 3. The move lands in Postgres only once Airtable has actually made it.
   *
   * Which table a row sits in is not a field this dashboard owns — it is a fact
   * about Airtable, and the one thing here that cannot be asserted ahead of it.
   * Writing the destination before the create succeeded left this database
   * saying Ahad while the row was still in Kaiqi's, with nothing left that knew
   * where it really was: the next save would look in Ahad's table, find
   * nothing, and the loop would be stuck there. Nothing is rolled back by this
   * — the field edits from step 1 stand either way — the move simply is not
   * claimed until it is true.
   *
   * A new Airtable record id comes with it, and everything this database keys
   * on the old one has to follow: the status events, the note, and this loop's
   * own write log.
   */
  let nowId = id;
  if (destination && (r.state === 'ok' || r.state === 'duplicate')) {
    // The assignee moves with the table here too, so the row this dashboard
    // shows never names one builder while sitting in another's.
    const moved = await mirrorRowById('loops', id);
    if (moved) await writeFields('loops', moved, { [loops_.FIELD.assignee]: SLACK_TO_BUILDER_ID[destination.owner] ?? null }, { builder_id: destination.owner, table_id: destination.table });
  }
  if (r.record_id && r.record_id !== mr.airtable_record_id) {
    await db().query('UPDATE engine_loops SET airtable_record_id = $1 WHERE id = $2', [r.record_id, mr.pk]);
    await rekey('loops', id, r.record_id);
    nowId = r.record_id;
    bumpVersion();
  }

  await logRecordWrite({
    kind: 'loops',
    record_id: nowId,
    natural_id: loopId,
    state: r.state,
    status: LOOP_STATUS_TO_AIRTABLE[(patch.status ?? (m.kind === 'loops' ? m.obj.status : 'open')) as LoopStatus],
    action: destination ? 'move' : 'edit',
    detail: changed.join(', ') || null,
    reason: r.reason,
    http: r.http,
    steps: r.steps,
    from_table: r.from_table,
    to_table: r.to_table,
    from_record_id: r.from_record_id ?? null,
    new_record_id: r.record_id && r.record_id !== mr.airtable_record_id ? r.record_id : null,
    actor,
  });

  const out = await rowById('loops', nowId);
  if (!out) throw new StoreError('The loop was saved but could not be read back.', 500);
  return hydrateLoop(out);
}

/**
 * Removes the copy a half-landed move left in the source table.
 *
 * The one repair this dashboard can make to a duplicate, and deliberately the
 * whole of it: it deletes the source row the move read from, by the id the move
 * recorded, and does nothing else. The destination row is where the loop lives,
 * Postgres already says so, and nothing here re-creates or re-moves anything —
 * a retry that re-ran the move would turn two copies into three.
 *
 * Airtable only. There is no Postgres change to make: this database has held
 * one row for this loop all along, pointing at the destination record.
 */
export async function resolveDuplicate(id: string, actor = 'dashboard'): Promise<Loop> {
  const mr = await mirrorRowById('loops', id);
  if (!mr) throw new StoreError('That loop is not held by this dashboard.', 404);

  const last = await lastWriteRow('loops', id);
  if (!last || last.state !== 'duplicate') {
    throw new StoreError('This loop is not in two tables, so there is no copy to remove.', 422);
  }
  if (!last.from_table || !last.from_record_id) {
    // Only a move logged before migration 8 can be here: it named the table but
    // not the row. Said plainly rather than deleting a guess.
    throw new StoreError('This loop was left in two tables before this dashboard recorded which row the copy was, so it has to be deleted in Airtable by hand.', 422);
  }

  const before = await rowById('loops', id);
  const r = await loops_.retryDelete({ table: last.from_table, record_id: last.from_record_id, to_table: last.to_table });
  const loopId = typeof mr.fields?.loop_id === 'string' ? mr.fields.loop_id : null;

  await logRecordWrite({
    kind: 'loops',
    record_id: id,
    natural_id: loopId,
    state: r.state,
    status: LOOP_STATUS_TO_AIRTABLE[(before?.status ?? 'open') as LoopStatus],
    action: 'remove duplicate',
    detail: `${r.state === 'ok' ? 'removed' : 'tried to remove'} the copy left in ${loopTableById(last.from_table)?.label ?? last.from_table}`,
    reason: r.reason,
    http: r.http,
    steps: r.steps,
    from_table: r.from_table,
    to_table: r.to_table,
    from_record_id: r.from_record_id ?? null,
    new_record_id: null,
    actor,
  });

  const out = await rowById('loops', id);
  if (!out) throw new StoreError('The copy was removed but the loop could not be read back.', 500);
  return hydrateLoop(out);
}

/** The Slack id that belongs to each builder's table, for the assignee this dashboard holds. */
const SLACK_TO_BUILDER_ID: Record<string, string> = Object.fromEntries(Object.entries(SLACK_TO_BUILDER).map(([slack, builder]) => [builder, slack]));

/** Changes one record's status, and records the change in the ledger. */
export async function setStatus(kind: RecordKind, id: string, status: string, note?: string, actor = 'dashboard'): Promise<Loop | CodexEntry | BuildPattern | Opportunity> {
  if (!STATUSES[kind].length) throw new StoreError(`${kind} is read-only in this dashboard: the engine writes it.`, 422);
  // A loop's status is one of the things the panel edits, so it goes the same
  // way as the rest of them. Two paths writing the same field is what this
  // avoids; the row actions and the panel are now the same call.
  if (kind === 'loops') {
    if (note !== undefined) await setNote('loops', id, note);
    try {
      return await editLoop(id, { status: status as LoopStatus }, actor);
    } catch (e) {
      if (e instanceof loops_.LoopError) throw new StoreError(e.message, e.status);
      throw e;
    }
  }
  if (!STATUSES[kind].includes(status)) {
    throw new StoreError(`"${status}" is not a status a ${kind === 'codex' ? 'Codex entry' : kind === 'patterns' ? 'pattern' : 'card'} can have.`, 422);
  }
  const mr = await mirrorRowById(kind, id);
  if (!mr) throw new StoreError('That record is not held by this dashboard.', 404);
  // Codex: the status is Jason Status, written in the table's own spelling.
  const jason = CODEX_JASON_STATUS.find((c) => c.toLowerCase() === status);
  if (kind === 'codex' && !jason) throw new StoreError(`"${status}" is not a Jason Status the submission tables define.`, 422);
  const patch: Record<string, unknown> =
    kind === 'codex' ? { 'Jason Status': jason } : kind === 'patterns' ? { pattern_status: status } : { readiness_state: status };
  const m = await writeFields(kind, mr, patch);
  await recordState(kind, m, 'ui', nowIso(), await lastEventFor(kind, id));
  if (note !== undefined) await setNote(kind, id, note);
  return (await read(kind, id)) as Loop | CodexEntry | BuildPattern | Opportunity;
}

/** Edits a record's own fields, by the names the source spells them. */
export async function updateFields(kind: RecordKind, id: string, fields: Record<string, unknown>): Promise<CodexEntry | Opportunity | BuildPatternDetail | Loop> {
  const mr = await mirrorRowById(kind, id);
  if (!mr) throw new StoreError('That record is not held by this dashboard.', 404);
  const allowed = kind === 'codex' ? CODEX_EDITABLE : kind === 'loops' ? new Set(['What', 'lane_tag', 'raised_in', 'Raised By']) : new Set<string>();
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) throw new StoreError(`"${k}" is not a field this dashboard edits.`, 422);
    if (k === 'lane_tag' && v !== null && !(LOOP_LANE_TAGS as string[]).includes(String(v))) throw new StoreError('That lane_tag is not one the loop tables define.', 422);
    clean[k] = typeof v === 'string' ? v.trim() || null : v;
  }
  if (!Object.keys(clean).length) throw new StoreError('Nothing to change.', 422);
  const m = await writeFields(kind, mr, clean);
  await recordState(kind, m, 'ui', nowIso(), await lastEventFor(kind, id));
  const out = (await rowById(kind, id))!;
  if (kind === 'loops') return hydrateLoop(out);
  if (kind === 'codex') return codexSummary(JSON.parse(out.json) as CodexEntryDetail);
  return JSON.parse(out.json) as Opportunity | BuildPatternDetail;
}

export async function createLoop(input: NewLoop, actor = 'dashboard'): Promise<Loop> {
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
  // No Airtable record id: this loop exists here first. `loop_id` is what the
  // engine matches on when it writes the same loop back with Airtable's id,
  // and mirror.upsert adopts the row rather than inserting a second one.
  const r = await mirror.upsert('loops', { fields, builder_id: t.owner, table_id: t.table }, 'ui');
  bumpVersion();
  const id = r.airtable_record_id ?? `row-${r.id}`;
  const m = mapRecord('loops', { id, createdTime: nowIso(), fields }, t.table);
  await recordState('loops', m, 'ui', nowIso(), undefined);
  if (input.note?.trim()) await setNote('loops', id, input.note);
  // Recorded like every other loop write, and as a skip: Airtable has no row
  // for a loop opened here, so there is nothing to create against. It stops
  // being a skip the moment the engine writes it to Airtable and pushes it
  // back, and the next edit goes through for real.
  await logRecordWrite({
    kind: 'loops',
    record_id: id,
    natural_id: String(fields.loop_id),
    state: 'skipped',
    status: 'Open',
    action: 'create',
    detail: `opened in ${t.label}’s table`,
    reason: 'Opened in the dashboard, so Airtable has no row for it yet. It gets one when the engine writes the loop and pushes it back.',
    http: null,
    steps: [],
    from_table: t.table,
    to_table: null,
    new_record_id: null,
    actor,
  });
  const row = await rowById('loops', id);
  if (!row) throw new StoreError('The loop was written but could not be read back.', 500);
  return hydrateLoop(row);
}

/**
 * How many loops this dashboard changed and could not get into Airtable —
 * counted over the newest write per loop, since the log keeps every attempt and
 * a failure someone has since fixed is history, not a live problem.
 *
 * A half-landed move counts: it is not a failed save, but it does leave the
 * loop in two tables and somebody has to remove one.
 */
export async function writebackFailures(kind?: RecordKind): Promise<number> {
  const r = await db().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT DISTINCT ON (kind, record_id) state FROM record_writes
        ${kind ? 'WHERE kind = $1' : ''}
        ORDER BY kind, record_id, seq DESC
     ) latest WHERE state IN ('failed', 'duplicate')`,
    kind ? [kind] : [],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------- codex */

/**
 * Sets Jason Status on one submission.
 *
 * Postgres first, then Airtable, and the Airtable write never throws — same
 * arrangement as a loop edit, and recorded in the same log so the row marks
 * itself the same way when it does not land.
 */
export async function setJasonStatus(id: string, status: string, actor = 'dashboard'): Promise<CodexEntry> {
  const want = codex_.asJasonStatus(status);
  const mr = await mirrorRowById('codex', id);
  if (!mr) throw new StoreError('That submission is not held by this dashboard.', 404);
  const table = tableOf('codex', mr);
  const codexId = typeof mr.fields?.[codex_.FIELD.codexEntryId] === 'string' ? (mr.fields[codex_.FIELD.codexEntryId] as string) : null;

  const m = await writeFields('codex', mr, { [codex_.FIELD.jasonStatus]: want });
  await recordState('codex', m, 'ui', nowIso(), await lastEventFor('codex', id));

  const r = await codex_.setStatus(table, mr.airtable_record_id, want);
  await logRecordWrite({
    kind: 'codex',
    record_id: id,
    natural_id: codexId ?? (typeof mr.fields?.[codex_.FIELD.submissionId] === 'string' ? (mr.fields[codex_.FIELD.submissionId] as string) : null),
    state: r.state,
    status: want,
    action: 'status',
    detail: `${codex_.FIELD.jasonStatus} → ${want}`,
    reason: r.reason,
    http: r.http,
    steps: r.steps,
    from_table: table,
    to_table: null,
    new_record_id: null,
    actor,
  });
  const out = await rowById('codex', id);
  if (!out) throw new StoreError('The submission was saved but could not be read back.', 500);
  return codexSummary(JSON.parse(out.json) as CodexEntryDetail);
}

/**
 * Deletes one submission from Airtable and from here.
 *
 * This exists for production testing: driving a log through Layer 0, Layer 1
 * and approval deliberately, then clearing the fixtures. Two guards, both
 * deliberate. The caller has to type the Codex entry id back — mid-test there
 * are several near-identical rows on screen and the id is the only thing that
 * tells them apart, which a yes/no dialog would not ask about. And the whole
 * row is written to `record_deletions` first: once Airtable and Postgres have
 * both let go, that log is the only place it can still be read.
 */
export async function deleteCodex(id: string, confirm: string, actor = 'dashboard'): Promise<{ removed: boolean; airtable: codex_.CodexWriteResult; identifier: string }> {
  const mr = await mirrorRowById('codex', id);
  if (!mr) throw new StoreError('That submission is not held by this dashboard.', 404);
  const fields = mr.fields ?? {};
  const codexId = typeof fields[codex_.FIELD.codexEntryId] === 'string' ? (fields[codex_.FIELD.codexEntryId] as string).trim() : '';
  const submissionId = typeof fields[codex_.FIELD.submissionId] === 'string' ? (fields[codex_.FIELD.submissionId] as string).trim() : '';
  // The id to type back. A row with no Codex entry id yet — one still at
  // Layer 0 — is identified by its submission id instead, so the guard is
  // never something nobody can satisfy.
  const identifier = codexId || submissionId;
  if (!identifier) throw new StoreError('This submission carries neither a Codex entry id nor a submission id, so there is nothing to confirm it by. Delete it in Airtable.', 422);
  if (confirm.trim() !== identifier) {
    throw new StoreError(`That does not match. Type ${identifier} exactly to delete this submission.`, 422);
  }

  const table = tableOf('codex', mr);
  await db().query(
    `INSERT INTO record_deletions (kind, record_id, natural_id, builder_id, table_id, reason, fields, actor, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    ['codex', id, identifier, mr.builder_id, table, 'deleted from the dashboard', JSON.stringify(fields), actor, nowIso()],
  );

  const r = await codex_.remove(table, mr.airtable_record_id);
  // The Postgres row goes whether or not Airtable let go. If it did not, the
  // next reconciliation would find the Airtable row still there and nothing
  // here to match it — which is visible in the log, and the alternative is a
  // row nobody can delete from either side.
  await db().query(`DELETE FROM ${MIRROR.codex.table} WHERE id = $1`, [mr.pk]);
  bumpVersion();
  // The next page load asks Airtable again rather than answering out of a pass
  // taken before this row existed on neither side.
  forgetReconcile();

  await logRecordWrite({
    kind: 'codex',
    record_id: id,
    natural_id: identifier,
    state: r.state,
    status: 'deleted',
    action: 'delete',
    detail: `${identifier} removed from ${codexTableById(table)?.label ?? table}`,
    reason: r.reason,
    http: r.http,
    steps: [...r.steps, 'removed the row held here'],
    from_table: table,
    to_table: null,
    new_record_id: null,
    actor,
  });
  console.log(`codex ${identifier}: deleted by ${actor} from ${table} — airtable ${r.state}${r.reason ? ` (${r.reason})` : ''}`);
  return { removed: true, airtable: r, identifier };
}

/**
 * Removes rows Airtable no longer has.
 *
 * A row deleted by hand in Airtable notifies nothing, so this dashboard would
 * go on showing it. One pass over the seven tables' record ids — ids only, a
 * few kilobytes — comparing against what is held here.
 *
 * **Only rows genuinely absent are removed.** A table whose read failed is not
 * in `byTable` at all and nothing under it is touched: a failed fetch and a
 * table someone emptied look identical from here, and treating one as the
 * other would clear the page. Rows with no Airtable record id are skipped for
 * the same reason — there is nothing to compare them against.
 *
 * Single-flight: two page loads at once share one pass rather than running
 * fourteen table reads between them.
 */
let reconciling: Promise<CodexReconciliation> | null = null;

/**
 * The last pass, and how long one stands for.
 *
 * Seven Airtable reads on every page load is seven reads for every refresh —
 * five loads in half an hour was thirty-five of them, to answer a question
 * whose answer changes when somebody deletes a row by hand. Two minutes is
 * short enough that a hand-deleted row goes on the next look, and long enough
 * that reading the page is not a load test.
 *
 * A write or a delete made here drops it, so this dashboard's own delete is
 * never answered out of a pass that predates it.
 */
const RECONCILE_TTL_MS = 120_000;
/**
 * A pass that failed is held for far less time. Holding it as long as a good
 * one would mean a token fixed at 10:00 still reading as broken at 10:02, and
 * a failure is the state somebody is actively trying to clear.
 */
const RECONCILE_FAILED_TTL_MS = 20_000;
let lastReconcile: { at: number; value: CodexReconciliation } | null = null;

export function forgetReconcile(): void {
  lastReconcile = null;
}

export function reconcileCodex(): Promise<CodexReconciliation> {
  const ttl = lastReconcile?.value.ran ? RECONCILE_TTL_MS : RECONCILE_FAILED_TTL_MS;
  if (lastReconcile && Date.now() - lastReconcile.at < ttl) return Promise.resolve(lastReconcile.value);
  reconciling ??= runReconcile()
    .then((v) => {
      lastReconcile = { at: Date.now(), value: v };
      return v;
    })
    .finally(() => {
      reconciling = null;
    });
  return reconciling;
}

/**
 * The tables the pass ran out of time before asking. Not a failure — nothing
 * was asked of them — but it has to be said, because rows under them were not
 * checked and a reader would otherwise read "checked" as "all of them".
 */
function unreachedNote(unreached: string[]): string {
  if (!unreached.length) return '';
  return ` ${unreached.length} ${unreached.length === 1 ? 'table was' : 'tables were'} not reached inside the time this check is given (${unreached.map((t) => codex_.tableLabel(t)).join(', ')}); ${unreached.length === 1 ? 'it is' : 'they are'} checked on the next pass.`;
}

/**
 * Pulls every Codex row from Airtable and makes this database match it.
 *
 * The thing this dashboard has never had. The reconciliation on page load only
 * ever *removed* rows: nothing inserted a submission Airtable had and we did
 * not, and nothing picked up a field changed there. A log approved in Airtable
 * stayed "awaiting approval" here for as long as nobody re-pushed it, and one
 * created without the engine pushing it never arrived at all.
 *
 * **Airtable wins every disagreement** (decision 2026-09-14, Destiny). It owns
 * every field on these rows; this dashboard does not get to keep a value
 * Airtable contradicts. The one case worth naming is a row whose own change
 * never landed in Airtable — approved here while Airtable refused the write —
 * because resyncing reverts it. Those are counted and named rather than
 * quietly undone, and the write log keeps the original failure.
 *
 * Manual only, on a button. Not on load, not on a schedule: it reads every
 * field of every row, transcripts included, and it deletes.
 */
export async function resyncCodex(actor = 'dashboard'): Promise<CodexResync> {
  const started = Date.now();
  const at = nowIso();
  const live = await codex_.liveRecords();
  const tables: CodexResyncTable[] = [];

  if (!live.read.length) {
    const blocked = live.failed.map((f) => ({ label: codex_.tableLabel(f.table), reason: f.reason }));
    const note = `Nothing was read, so nothing was changed. ${reasonsOf(blocked)}`;
    console.error(`codex resync: no table could be read — ${[...new Set(blocked.map((b) => b.reason))].join(' · ')}`);
    return {
      ran: false,
      at,
      ms: Date.now() - started,
      tables: codex_.allTables().map((t) => ({
        table: t.table,
        label: t.label,
        read: false,
        reason: live.failed.find((f) => f.table === t.table)?.reason ?? 'not reached',
        rows: null,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
      })),
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      overwritten: [],
      note,
    };
  }

  /**
   * Rows carrying a change of our own that never reached Airtable, read before
   * anything is written. After the resync their newest write line is this pass,
   * so asking afterwards would find nothing.
   */
  const unlanded = new Map<string, string | null>();
  {
    const r = await db().query<{ record_id: string; natural_id: string | null }>(
      `SELECT DISTINCT ON (record_id) record_id, natural_id, state FROM record_writes WHERE kind = 'codex' ORDER BY record_id, seq DESC`,
    );
    for (const row of r.rows as unknown as { record_id: string; natural_id: string | null; state: string }[]) {
      if (row.state === 'failed' || row.state === 'duplicate') unlanded.set(row.record_id, row.natural_id);
    }
  }

  const overwritten: { record_id: string; natural_id: string | null }[] = [];

  for (const t of codex_.allTables()) {
    const records = live.byTable.get(t.table);
    if (!records) {
      tables.push({
        table: t.table,
        label: t.label,
        read: false,
        reason: live.failed.find((f) => f.table === t.table)?.reason ?? 'not reached inside the time this is given',
        rows: null,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
      });
      continue;
    }

    const kind: mirror.MirrorKind = t.owner ? 'codex' : 'layer0';
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (const rec of records) {
      try {
        const result = await mirror.upsert(
          kind,
          { record_id: rec.id, created_time: rec.createdTime ?? null, fields: rec.fields ?? {}, table_id: t.owner ? t.table : null, builder_id: t.owner },
          'airtable',
        );
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else unchanged++;
        if (result.inserted || result.changed) {
          // Dated as 'mirror', not 'engine': this database learned of the
          // change when it looked, and has no idea when it actually happened
          // in Airtable. The same honesty the boot reconcile uses.
          await recordEngineWrite(kind, result.id, at, 'mirror');
          if (result.changed && unlanded.has(rec.id)) overwritten.push({ record_id: rec.id, natural_id: unlanded.get(rec.id) ?? null });
        }
      } catch (e) {
        // One unreadable row must not abandon the other 164. Named in the log.
        console.error(`codex resync: ${t.label} ${rec.id} refused — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Only within a table that was actually read: not read is never empty.
    const held = await db().query<{ id: string; airtable_record_id: string }>(
      `SELECT id, airtable_record_id FROM ${kind === 'codex' ? MIRROR.codex.table : 'engine_layer0_holds'}
        WHERE airtable_record_id IS NOT NULL ${kind === 'codex' ? 'AND table_id = $1' : ''}`,
      kind === 'codex' ? [t.table] : [],
    );
    const liveIdSet = new Set(records.map((r) => r.id));
    const gone = held.rows.filter((row) => !liveIdSet.has(row.airtable_record_id)).map((row) => ({ pk: row.id, record: row.airtable_record_id }));
    if (kind === 'codex') await removeCodexRows(gone, 'removed in Airtable; found missing by a resync', actor, at);
    else if (gone.length) {
      await db().query(`DELETE FROM engine_layer0_holds WHERE id = ANY($1::bigint[])`, [gone.map((g) => g.pk)]);
      bumpVersion();
    }

    tables.push({ table: t.table, label: t.label, read: true, reason: null, rows: records.length, inserted, updated, unchanged, deleted: gone.length });
  }

  const sum = (k: 'inserted' | 'updated' | 'unchanged' | 'deleted') => tables.reduce((n, t) => n + t[k], 0);
  const blocked = tables.filter((t) => !t.read);
  const note = [
    `${sum('inserted')} inserted, ${sum('updated')} updated, ${sum('deleted')} deleted, ${sum('unchanged')} already matching.`,
    overwritten.length ? `${overwritten.length} of those updates overwrote a change made here that never reached Airtable — ${overwritten.map((o) => o.natural_id ?? o.record_id).join(', ')}.` : '',
    blocked.length ? `${blocked.length} ${blocked.length === 1 ? 'table' : 'tables'} could not be read (${blocked.map((b) => b.label).join(', ')}), so nothing under ${blocked.length === 1 ? 'it' : 'them'} was touched. ${reasonsOf(blocked.map((b) => ({ label: b.label, reason: b.reason ?? 'no reason given' })))}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  forgetReconcile();

  /**
   * The whole outcome in one line, including what the two sides now hold.
   * Deliberate: the person who can press this button and the person reading
   * the logs are not always the same, and "do they agree now" has to be
   * answerable from the log alone.
   */
  const after = await codexEntries();
  const byStage = (stage: string) => after.filter((e) => e.stage === stage).length;
  const byJason = (v: string) => after.filter((e) => (e.jason_status ?? '').trim().toLowerCase() === v).length;
  console.log(
    `codex resync by ${actor}: ${note} | after: ${after.length} submissions (Layer 0 counted separately above) — ${byStage('approved')} approved, ${byStage('awaiting')} awaiting, ${byStage('needs_input')} needs input; ` +
      `Jason Status ${byJason('approved')} Approved, ${byJason('input added')} Input Added, ${byJason('pending')} Pending, ${after.filter((e) => !e.jason_status).length} empty | ` +
      tables.map((t) => `${t.label} ${t.read ? `${t.rows} rows +${t.inserted}/~${t.updated}/-${t.deleted}` : `UNREAD (${t.reason})`}`).join(' · '),
  );

  return { ran: true, at, ms: Date.now() - started, tables, inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), deleted: sum('deleted'), overwritten, note };
}

/**
 * Removes rows Airtable no longer has, keeping each one whole first.
 *
 * The reconciliation on page load and the resync both end here, so a row can
 * only ever leave this table one way and the deletion log has one shape. The
 * record goes to `record_deletions` before the delete, in the same
 * transaction: once both sides have let go, that log is the only place it can
 * still be read.
 */
async function removeCodexRows(gone: { pk: string; record: string }[], reason: string, actor: string, at: string): Promise<void> {
  if (!gone.length) return;
  await withTransaction(async (client) => {
    for (const g of gone) {
      const r = await client.query<{ fields: Record<string, unknown>; builder_id: string; table_id: string | null }>(
        `SELECT fields, builder_id, table_id FROM ${MIRROR.codex.table} WHERE id = $1`,
        [g.pk],
      );
      const row = r.rows[0];
      await client.query(
        `INSERT INTO record_deletions (kind, record_id, natural_id, builder_id, table_id, reason, fields, actor, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          'codex',
          g.record,
          (row?.fields?.[codex_.FIELD.codexEntryId] as string) ?? (row?.fields?.[codex_.FIELD.submissionId] as string) ?? null,
          row?.builder_id ?? null,
          row?.table_id ?? null,
          reason,
          JSON.stringify(row?.fields ?? {}),
          actor,
          at,
        ],
      );
      await client.query(`DELETE FROM ${MIRROR.codex.table} WHERE id = $1`, [g.pk]);
    }
  });
  bumpVersion();
}

/**
 * What Airtable actually said — once per distinct reason, commonest first, and
 * bounded.
 *
 * These tables share one base and one token, so they usually fail for one
 * reason and it is worth saying plainly. When they do not, two reasons is as
 * much as a line under a heading can carry; the rest are counted. A reason that
 * covers every table is not followed by a list of all seven.
 */
function reasonsOf(blocked: { label: string; reason: string }[], total = blocked.length): string {
  const byReason = new Map<string, string[]>();
  for (const b of blocked) byReason.set(b.reason, [...(byReason.get(b.reason) ?? []), b.label]);
  const ranked = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  const said = ranked
    .slice(0, 2)
    // Airtable's own messages sometimes end in a full stop and sometimes do
    // not; one is added here, so neither shape gives us two.
    .map(([reason, labels]) => `Airtable answered: ${reason.replace(/\.$/, '')}${labels.length === total ? '' : ` (${labels.join(', ')})`}`)
    .join('. ');
  const rest = ranked.length - 2;
  return `${said}.${rest > 0 ? ` And ${rest} other ${rest === 1 ? 'reason' : 'reasons'} across the remaining tables.` : ''}`;
}

async function runReconcile(): Promise<CodexReconciliation> {
  const at = nowIso();
  if (!codex_.CODEX_TABLES.length) return { ran: false, checked: 0, removed: 0, removed_ids: [], blocked: [], at, note: 'No submission tables are configured.' };
  let live: Awaited<ReturnType<typeof codex_.liveIds>>;
  try {
    live = await codex_.liveIds();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ran: false, checked: 0, removed: 0, removed_ids: [], blocked: [], at, note: `Airtable could not be reached, so nothing was removed and the page is showing what this database holds. ${reason}` };
  }
  if (!live.read.length) {
    const blocked = live.failed.map((f) => ({ table: f.table, label: codex_.tableLabel(f.table), reason: f.reason }));
    /**
     * Say what Airtable said.
     *
     * This branch used to print "no submission table could be read" and stop,
     * with the reason sitting in `blocked` unread and nothing in the logs —
     * which is a sentence that cannot be acted on. Every table here shares one
     * base and one token, so they nearly always fail for the same reason and
     * it is worth saying once.
     */
    const note = `Every submission table refused this check, so nothing was removed. ${reasonsOf(blocked)} The list below is complete and unaffected; the one thing this misses is a submission deleted in Airtable by hand, which would still be shown here.`;
    console.error(`codex reconcile: no table could be read (${blocked.length} of ${blocked.length + live.unreached.length}) — ${[...new Set(blocked.map((b) => b.reason))].join(' · ')}`);
    return { ran: false, checked: 0, removed: 0, removed_ids: [], blocked, at, note };
  }

  const held = await db().query<{ id: string; airtable_record_id: string | null; table_id: string | null }>(
    `SELECT id, airtable_record_id, table_id FROM ${MIRROR.codex.table} WHERE airtable_record_id IS NOT NULL`,
  );
  const gone: { pk: string; record: string }[] = [];
  let checked = 0;
  for (const row of held.rows) {
    const table = row.table_id ?? '';
    const ids = live.byTable.get(table);
    // Not read, or in a table this pass could not see: left alone.
    if (!ids) continue;
    checked++;
    if (!ids.has(row.airtable_record_id!)) gone.push({ pk: row.id, record: row.airtable_record_id! });
  }

  if (gone.length) {
    await removeCodexRows(gone, 'removed in Airtable; found missing by the reconciliation on page load', 'reconciliation', at);
    console.log(`codex reconcile: ${gone.length} row(s) no longer in Airtable, removed — ${gone.map((g) => g.record).join(', ')}`);
  }

  const blocked = live.failed.map((f) => ({ table: f.table, label: codex_.tableLabel(f.table), reason: f.reason }));
  return {
    ran: true,
    checked,
    removed: gone.length,
    removed_ids: gone.map((g) => g.record),
    blocked,
    at,
    note:
      (blocked.length
        ? `Checked ${checked} of the rows held here against Airtable and removed ${gone.length}. ${blocked.length} ${blocked.length === 1 ? 'table' : 'tables'} could not be read (${blocked.map((b) => b.label).join(', ')}), so nothing held under ${blocked.length === 1 ? 'it' : 'them'} was touched. ${reasonsOf(blocked)}`
        : `Checked ${checked} rows against Airtable${gone.length ? ` and removed ${gone.length} that no longer exist there` : '; every one is still there'}.`) + unreachedNote(live.unreached),
  };
}

/**
 * The record kinds the interface can write, for /api/status. Read-only kinds
 * are read-only because the engine owns them, not because a key is missing.
 */
export function writable(): RecordKind[] {
  return KINDS.filter((k) => STATUSES[k].length > 0);
}

/** Which record kind a mirror kind is. Null for the two that are not records: Layer 0 holds and digest deliveries. */
const RECORD_KIND: Record<mirror.MirrorKind, RecordKind | null> = {
  loops: 'loops',
  codex: 'codex',
  layer0: null,
  patterns: 'patterns',
  commercial: 'commercial',
  ns: 'ns',
  rt: 'rt',
  client_lanes: 'clients',
  client_questions: 'client_questions',
  digests: null,
};

/**
 * Records the status a write from the engine left a row in.
 *
 * The engine write itself lands in mirror.ts, which knows nothing about
 * statuses — it stores Airtable's fields and nothing else. This is what turns
 * that into a dated line in the ledger, and it is the only place a status
 * change gets a timestamp anyone can stand behind: nothing upstream keeps a
 * status-change history, and the loop tables carry no close date at all.
 *
 * Never throws into the write path. A row that arrived is a row that arrived;
 * failing the engine's POST because the ledger could not be updated would turn
 * a bookkeeping problem into lost data.
 */
/**
 * Moves everything this database keys on a record id onto a different one.
 *
 * Two things do that. A loop opened on this dashboard is addressed by this
 * database's own key until the engine writes it to Airtable and pushes it back,
 * and mirror.upsert then adopts the row on its `loop_id`. And a move to another
 * builder's table creates a new Airtable record, which has a new id.
 *
 * Either way the status events that date its close, the note someone typed, and
 * its own write log have to come with it. Missing this would not error — the
 * next edit would simply look for a record that is not there — which is exactly
 * why it is done here rather than left to be noticed.
 */
async function rekey(kind: RecordKind, old: string, recordId: string): Promise<void> {
  if (old === recordId) return;
  const e = await db().query('UPDATE events SET record_id = $1 WHERE kind = $2 AND record_id = $3', [recordId, kind, old]);
  // A note already under the new id wins: it is the later statement of the two.
  await db().query(
    `INSERT INTO record_notes (kind, record_id, note, updated_at)
     SELECT kind, $1, note, updated_at FROM record_notes WHERE kind = $2 AND record_id = $3
     ON CONFLICT (kind, record_id) DO NOTHING`,
    [recordId, kind, old],
  );
  const n = await db().query('DELETE FROM record_notes WHERE kind = $1 AND record_id = $2', [kind, old]);
  // The write-back record moves with it for the same reason: it is keyed by the
  // id the row is addressed by, and the loop that was skipped as "not in
  // Airtable yet" is exactly the loop this adoption is about.
  let w = 0;
  if (WRITES_TO_AIRTABLE.has(kind)) {
    // Every line of the loop's history follows it, not just the newest: the log
    // is append-only and the point of it is being able to read back what
    // happened, including under the id the loop used to have.
    const r = await db().query('UPDATE record_writes SET record_id = $1 WHERE kind = $2 AND record_id = $3', [recordId, kind, old]);
    w = r.rowCount ?? 0;
  }
  if (e.rowCount || n.rowCount || w)
    console.log(`store: ${old} is now ${recordId} — carried ${e.rowCount ?? 0} event(s), ${n.rowCount ?? 0} note(s) and ${w} write log line(s) across`);
}

export async function recordEngineWrite(kind: mirror.MirrorKind, pk: number, at = nowIso(), via: 'engine' | 'mirror' = 'engine'): Promise<void> {
  const rk = RECORD_KIND[kind];
  if (!rk) return;
  try {
    const r = await db().query<MirrorRow>(`${selectFor(rk)} WHERE id = $1`, [String(pk)]);
    const mr = r.rows[0];
    if (!mr) return;
    if (mr.airtable_record_id) await rekey(rk, `row-${pk}`, mr.airtable_record_id);
    const m = mapRecord(rk, asRecord(mr), tableOf(rk, mr), mr.lane_id);
    await recordState(rk, m, via, at, await lastEventFor(rk, idOf(mr)));
    bumpVersion();
  } catch (e) {
    console.log(`store: could not record the status of ${kind} row ${pk} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A record n8n pushed, in the Airtable envelope the older /api/inbound route
 * takes. Kept working after the cut by writing to the same mirror table
 * /api/engine/:kind writes to; there is no Airtable to read from any more, so
 * the record itself has to be in the body.
 */
export async function applyInbound(kind: RecordKind, payload: { id: string; table?: string; record?: AtRecord; at?: string }): Promise<{ changed: boolean; inserted: boolean; record: unknown }> {
  const id = payload.id;
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new StoreError('An Airtable record id (rec…) is required.', 422);
  if (!payload.record) {
    throw new StoreError('"record" is required: this server no longer reads Airtable, so the record must be in the body — { "id": "rec…", "record": { "id": "rec…", "fields": { … } } }.', 422);
  }
  if (payload.record.id !== id) throw new StoreError('The record in the body does not match the id.', 422);
  let table = payload.table ?? (await mirrorRowById(kind, id))?.table_id ?? null;
  if (kind === 'patterns') table = PATTERNS.table;
  if (kind === 'commercial') table = COMMERCIAL.table;
  if (kind === 'loops' && table && !loopTableById(table)) throw new StoreError(`${table} is not one of the builder tables.`, 422);
  if (kind === 'codex' && table && !codexTableById(table)) throw new StoreError(`${table} is not one of the submission tables.`, 422);
  const at = payload.at && Number.isFinite(Date.parse(payload.at)) ? new Date(payload.at).toISOString() : nowIso();
  try {
    const r = await mirror.upsert(MIRROR_KIND[kind], { record_id: id, created_time: payload.record.createdTime, fields: payload.record.fields, table_id: table, lane_id: null }, 'engine');
    bumpVersion();
    const m = mapRecord(kind, payload.record, table ?? MIRROR[kind].at_table ?? '');
    const state = await recordState(kind, m, 'engine', at, await lastEventFor(kind, id));
    return { changed: state.changed, inserted: r.inserted, record: await read(kind, id) };
  } catch (e) {
    if (e instanceof mirror.MirrorError) throw new StoreError(e.message, e.status);
    throw e;
  }
}

export async function removeInbound(kind: RecordKind, id: string): Promise<boolean> {
  const local = /^row-(\d+)$/.exec(id);
  const r = local
    ? await db().query(`DELETE FROM ${MIRROR[kind].table} WHERE id = $1`, [local[1]])
    : await db().query(`DELETE FROM ${MIRROR[kind].table} WHERE airtable_record_id = $1`, [id]);
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
const NO_CLOSE_DATE = 'The loop tables carry no close date. Closes are timestamped only when they pass through this dashboard or are pushed by the engine, and that history starts when this database did.';

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
    // Closes with a real timestamp: made here, or pushed by the engine when it
    // made them. A 'mirror' event is one reconcile() noticed afterwards and
    // cannot date, so it is left out rather than counted on the day we looked.
    `SELECT at, builder FROM events WHERE kind = 'loops' AND to_status = 'closed' AND via IN ('ui', 'inbound', 'engine') ORDER BY at`,
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
        `Closes are dated only when made here or pushed by the engine, so this starts with this database, on ${(historySince ?? '').slice(0, 10)}.`,
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
    `Every loop by the week of its Date Raised — open and closed alike — over the last eight weeks.`,
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
        `Closed loops by last_modified, added 9 Sept 2026 and read as the close; earlier weeks carry no closes.`,
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
    `Date Raised minus last_modified per week, from 9 Sept 2026: before that there are no closes to subtract.`,
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

/**
 * Short on purpose. It is one of three footnotes that have to sit at the same
 * height, and the long version said three times over that this is the gate's
 * verdict rather than ours.
 */
const LAYER0_DEFINITION =
  'The check\u2019s own verdict, from Layer0 Flagged and Layer0 Missing.';

const APPROVAL_LABELS: Record<CodexApproval, string> = {
  approved: 'Approved',
  pending: 'Pending',
  'input added': 'Input added',
  unset: 'Not set',
};

/**
 * The three stages, one per layer.
 *
 * Mutually exclusive by one rule, applied in `mapCodex`: Layer0 Flagged wins,
 * and otherwise Jason Status decides. So every submission is in exactly one
 * stage and the three sum to the total — which the row that came before did
 * not, because it asked two different questions at once.
 *
 * Ordered approved first (decision 2026-09-14, Destiny), which is where almost
 * every log ends up and so where a reader starts. The card that shows the split
 * reads the same order, so the page states one order rather than two. The
 * `layer` beside each is the step's name, not its number — "Layer 0" told a
 * reader nothing.
 */
const TAB_RULES: { tab: CodexTab; label: string; layer: string; rule: string; test: (e: CodexEntry) => boolean }[] = [
  {
    tab: 'approved',
    label: 'Approved',
    layer: 'Builder codex',
    rule: 'The completeness check did not flag it and Jason Status is Approved. Through, and the builder codex stands.',
    test: (e) => e.stage === 'approved',
  },
  {
    tab: 'awaiting',
    label: 'Awaiting approval',
    layer: 'Pending review',
    rule: 'Not flagged by the completeness check, and Jason Status is not Approved. "Input Added" sits here too — Jason asking a question happens while the log waits, and the builder answers in thread. An empty status sits here as well: nothing distinguishes it from a log he has not reached.',
    test: (e) => e.stage === 'awaiting',
  },
  {
    tab: 'needs_input',
    label: 'Needs input',
    layer: 'Completeness check',
    rule: 'Layer0 Flagged is ticked: the completeness check found something missing and the builder has to fill it in. This wins over Jason Status, because that check runs first. Each row names what Layer0 Missing says it lacks.',
    test: (e) => e.stage === 'needs_input',
  },
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
  /**
   * The pipeline's three tiers, highest to lowest. Not sorted: sorting gave
   * Excellent, Good, Great — alphabetical, which reads as Good outranking
   * Great. "Good" is the lowest tier; it replaced an older "Weak". Anything a
   * table carries that is not one of the three is appended rather than
   * dropped, so a value nobody planned for is still visible.
   */
  const TIERS = ['Excellent', 'Great', 'Good'];
  const present = new Set(all.map((e) => e.narration_quality).filter((v): v is string => Boolean(v)));
  const qualities = [...TIERS.filter((t) => present.has(t)), ...[...present].filter((q) => !TIERS.includes(q)).sort()];
  const openHolds = holds.filter((h) => h.open).length;

  const value: CodexMetrics = {
    kind: 'codex',
    computed_at: nowIso(),
    scope: { builder, rows: all.length },
    entries: all.length,
    tabs: TAB_RULES.map((r) => ({ tab: r.tab, label: r.label, layer: r.layer, n: all.filter(r.test).length, rule: r.rule })),
    stage_reconciliation: (() => {
      const sums = TAB_RULES.reduce((n, r) => n + all.filter(r.test).length, 0);
      return {
        rows: all.length,
        sums_to: sums,
        note:
          sums === all.length
            ? `${TAB_RULES.map((r) => all.filter(r.test).length).join(' + ')} = ${all.length}, in the order above and each log in exactly one: Layer0 Flagged decides, then Jason Status.`
            : `${sums} across the three stages against ${all.length} submissions — they should be equal, and this is a bug rather than a fact about the data.`,
      };
    })(),
    with_entry: {
      n: withEntry,
      note: `${all.length - withEntry} of ${all.length} ${all.length - withEntry === 1 ? 'has' : 'have'} none: Orchestrator Layer2 Review is empty.`,
    },
    layer0: {
      flagged: flagged.length,
      clean: all.length - flagged.length,
      definition: LAYER0_DEFINITION,
      note: `${flagged.length} of ${all.length} rows are flagged. The check and Jason Status are two different axes: a row can be approved and still carry a flag, and both are shown on it.`,
    },
    missing_mix: [...missing.entries()].map(([element, n]) => ({ element: missingLabel(element), n })).sort((a, b) => b.n - a.n || a.element.localeCompare(b.element)),
    holds: {
      open: openHolds,
      completed: holds.length - openHolds,
      /**
       * Said plainly, because the number it is not part of is the one every
       * other figure on this page uses. The Layer 0 parking table is a separate
       * table with a different schema — no Jason Status, no Layer 2 review, no
       * Codex Entry ID — holding submissions that never reached a builder
       * table. They are counted here and nowhere else.
       */
      note: openHolds
        ? `${openHolds} more ${openHolds === 1 ? 'is' : 'are'} parked, not counted here.`
        : 'Nothing is parked; parked rows are never counted here.',
    },
    approval_mix: approvals.map((a) => ({ approval: a, label: APPROVAL_LABELS[a], n: all.filter((e) => e.approval === a).length })).filter((r) => r.n > 0),
    approval_note:
      'Jason Status as the submission tables set it. "Input added" means the builder answered a question on the log; it is neither approved nor waiting. An empty field is counted as pending, because nothing distinguishes it from a log he has not reached.',
    per_builder_per_week: perBuilder,
    narration_quality_mix: qualities.map((q) => ({ quality: q, n: all.filter((e) => e.narration_quality === q).length })),
    narration_quality_note: qualities.length
      ? `From the Narration Quality field, on the ${all.filter((e) => e.narration_quality).length} of ${all.length} rows carrying one. Best first: Excellent, Great, Good.`
      : 'No row carries a narration quality. The field is set by the review step, so an empty one means no review has run.',
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
  // One statement across the eight mirror tables rather than a query per kind.
  const sql = KINDS.map((k) => `SELECT '${k}' AS kind, count(*)::text AS n FROM ${MIRROR[k].table}`).join(' UNION ALL ');
  const r = await db().query<{ kind: RecordKind; n: string }>(sql);
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
