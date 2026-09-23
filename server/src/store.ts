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
import * as airtable from './airtable';
import * as codex_ from './codex';
import * as loops_ from './loops';
import * as mirror from './mirror';
import { getPool, withTransaction, type Queryable } from './pg';
import * as events from './events';
import type {
  BuildPattern,
  BuildPatternDetail,
  ClientLane,
  HeldStamp,
  ClientQuestion,
  ClientRequest,
  CodexApproval,
  CodexEntry,
  CodexEntryDetail,
  CodexMetrics,
  CodexTab,
  CommercialMetrics,
  Freshness,
  Layer0Hold,
  CodexReconciliation,
  Resync,
  ResyncTable,
  Loop,
  LoopMetrics,
  LoopStatus,
  RecordWrite,
  Metric,
  MetricSeries,
  NewLoop,
  NsAsk,
  NsMetrics,
  Opportunity,
  OwnerTotals,
  PatternMetrics,
  RecordKind,
  RecordMetrics,
  RtAsk,
  RtJob,
  RtJobMetrics,
  RtMetrics,
  SeriesPoint,
  Share,
  Slice,
  Percentiles,
  Cohort,
  Handoffs,
} from '../../src/data/types';
import {
  LAYER0_PENDING,
  CLIENT_REQUESTS,
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
  NS_DELIVERED,
  NS_OUTCOMES,
  NS_PRIORITY_TIERS,
  NS_QUESTION_TYPES,
  CONFIDENCE_STATED,
  JOB_ATTEMPT_CAP,
  JOB_GAP_TYPES,
  JOB_OPENED_BY,
  JOB_RESOLVED,
  JOB_STATUSES,
  PATTERNS,
  RESEARCH_JOBS,
  RESEARCH_TWIN,
  RT_ASK_TYPES,
  RT_BHARAG,
  RT_DELIVERED,
  RT_OUTCOMES,
  type AtRecord,
  canonicalPerson,
  codexSummary,
  codexTableById,
  incompleteFields,
  isoWeek,
  loopTable,
  loopTableById,
  BUILDER_PROFILES,
  PATTERN_CANDIDATES,
  mapClientLane,
  mapClientQuestion,
  mapClientRequest,
  mapCodex,
  mapLayer0,
  mapLoop,
  mapNsAsk,
  mapOpportunity,
  mapPattern,
  mapRtAsk,
  mapRtJob,
  missingLabel,
  patternSummary,
} from './sources';

export type { RecordKind, RecordMetrics, Metric };

export const KINDS: RecordKind[] = ['loops', 'codex', 'patterns', 'commercial', 'ns', 'rt', 'rt_jobs', 'clients', 'client_questions', 'client_requests'];

/** Status vocabularies, in the dashboard's words. Loops and patterns and cards are the table's own selects lower-cased or verbatim. */
export const STATUSES: Record<RecordKind, readonly string[]> = {
  loops: ['open', 'in progress', 'closed'],
  // Codex: Jason Status, lower-cased. 'unset' is a state a row can be in but never one this dashboard writes.
  codex: ['approved', 'pending', 'input added'],
  // Patterns are read-only from here (2026-09-15, Destiny): pattern_status was
  // deleted from the Build Patterns base, so there is no status to set and a
  // write would be to a column that no longer exists.
  patterns: [],
  commercial: ['INCUBATE', 'Research-First', 'Media-Ready'],
  // The three telemetry kinds are read-only: the engine writes them, this
  // dashboard reads them. No status is settable from here.
  ns: [],
  rt: [],
  rt_jobs: [],
  clients: [],
  client_questions: [],
  /** Airtable owns the status here; nothing in this dashboard writes one. */
  client_requests: [],
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

/**
 * Whole days from a to b. The two parses are two template literals (fixed
 * 2026-09-22): a commit on 17 Sep ran them into one string, `Date.parse`
 * answered NaN, and every loop's age went out as null — "nulld" on every row
 * of Open loops and an age chart that said nothing was open.
 */
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
/**
 * Every week that touches a month, oldest first. A week straddling the boundary
 * belongs to both months it touches, which is a fact about weeks rather than a
 * rounding decision: a bar labelled "31 Aug–6 Sep" is exactly that.
 */
function weeksIn(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${String(lastDay).padStart(2, '0')}`;
  const out: string[] = [];
  let w = weekStart(first);
  const end = weekStart(last);
  while (w <= end) {
    out.push(w);
    w = addDays(w, 7);
  }
  return out;
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
  ns: { table: 'engine_ns_asks', base: NORTH_STAR.base, at_table: NORTH_STAR.table },
  rt: { table: 'engine_rt_asks', base: RESEARCH_TWIN.base, at_table: RESEARCH_TWIN.table },
  rt_jobs: { table: 'engine_rt_jobs', base: RESEARCH_JOBS.base, at_table: RESEARCH_JOBS.table },
  clients: { table: 'engine_client_lanes', base: CLIENTS_INDEX.base, at_table: CLIENTS_INDEX.table },
  client_questions: { table: 'engine_client_questions', base: CLIENTS_INDEX.base, at_table: null },
  client_requests: { table: 'engine_client_requests', base: CLIENT_REQUESTS.base, at_table: CLIENT_REQUESTS.table },
};

/** Which kind is which in mirror.ts's vocabulary, for the write path. */
const MIRROR_KIND: Record<RecordKind, mirror.MirrorKind> = {
  loops: 'loops',
  codex: 'codex',
  patterns: 'patterns',
  commercial: 'commercial',
  ns: 'ns-asks',
  rt: 'rt-asks',
  rt_jobs: 'rt-jobs',
  clients: 'client_lanes',
  client_questions: 'client_questions',
  client_requests: 'client_requests',
};

const HAS_BUILDER = new Set<RecordKind>(['loops', 'codex']);
const HAS_TABLE = new Set<RecordKind>(['loops', 'codex', 'client_questions']);
const HAS_LANE = new Set<RecordKind>(['commercial', 'ns', 'rt', 'rt_jobs', 'client_questions']);

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
  | { kind: 'ns'; obj: NsAsk }
  | { kind: 'rt'; obj: RtAsk }
  | { kind: 'rt_jobs'; obj: RtJob }
  | { kind: 'clients'; obj: ClientLane }
  | { kind: 'client_questions'; obj: ClientQuestion }
  | { kind: 'client_requests'; obj: ClientRequest };

/**
 * What a mapper needs that is not on the record itself. Today that is one
 * thing: which submissions are parked at `pending_builder_input` in the Layer 0
 * table, which is what places a Codex log at Needs input. It is optional, and
 * the paths that only want a record's status (the events ledger) leave it off.
 */
export interface MapContext {
  layer0Pending: ReadonlySet<string>;
}

export function mapRecord(kind: RecordKind, rec: AtRecord, table: string, lane?: string | null, ctx?: MapContext): Mapped {
  switch (kind) {
    case 'loops': {
      const t = loopTableById(table);
      if (!t) throw new StoreError(`${table} is not one of the builder tables.`, 422);
      return { kind, obj: mapLoop(rec, t.owner, table) };
    }
    case 'codex': {
      const t = codexTableById(table);
      if (!t) throw new StoreError(`${table} is not one of the submission tables.`, 422);
      return { kind, obj: mapCodex(rec, t.owner, table, ctx?.layer0Pending) };
    }
    case 'patterns':
      return { kind, obj: mapPattern(rec) };
    case 'commercial':
      return { kind, obj: mapOpportunity(rec) };
    case 'ns':
      return { kind, obj: mapNsAsk(rec) };
    case 'rt':
      return { kind, obj: mapRtAsk(rec) };
    case 'rt_jobs':
      return { kind, obj: mapRtJob(rec) };
    case 'clients':
      return { kind, obj: mapClientLane(rec) };
    case 'client_questions':
      // The lane a question belongs to is carried on the row: the index names
      // the per-lane table and the lane it belongs to, and the write path
      // records both. Nothing is hardcoded and nothing is inferred.
      return { kind, obj: mapClientQuestion(rec, lane ?? table, table) };
    case 'client_requests':
      // One shared table, and the row names its own lane and client, so there
      // is nothing to be told from outside it.
      return { kind, obj: mapClientRequest(rec) };
  }
}

function statusOf(m: Mapped): string {
  switch (m.kind) {
    case 'loops':
      return m.obj.status;
    case 'codex':
      return m.obj.approval;
    case 'patterns':
      // pattern_status is gone from the base, so a pattern has no state to move
      // between. The ledger still records the one fact left — that this
      // database has seen the row — and never writes a second event for it.
      return 'held';
    case 'commercial':
      return m.obj.readiness_state ?? 'unset';
    case 'ns':
    case 'rt':
      // The ledgers' own Outcome select. Every new row carries one, so there is
      // no "unclassified" bucket any more; a row without one predates nothing
      // and is simply a row the agent failed to finish writing.
      return m.obj.outcome ?? 'no outcome';
    case 'rt_jobs':
      // A job's own Status, which is the whole point of the table: Pending,
      // In Progress, Resolved, or capped and waiting on a person.
      return m.obj.status ?? 'no status';
    case 'clients':
      return m.obj.run_state ?? 'unset';
    case 'client_questions':
      return m.obj.movement_tag ?? 'unset';
    case 'client_requests':
      // Airtable's own Status, which is the whole point of the table: a request
      // stays Requested until every open check clears.
      return m.obj.status ?? 'unset';
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
    case 'rt':
      return m.obj.asked_at ? m.obj.asked_at.slice(0, 10) : null;
    case 'rt_jobs':
      return m.obj.opened_at ? m.obj.opened_at.slice(0, 10) : null;
    case 'clients':
      return m.obj.last_run_at ? m.obj.last_run_at.slice(0, 10) : null;
    case 'client_questions':
      return m.obj.last_updated ? m.obj.last_updated.slice(0, 10) : null;
    case 'client_requests':
      return m.obj.date_requested ? m.obj.date_requested.slice(0, 10) : null;
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
  events.changed(MIRROR_KIND[kind]);
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
  const ctx = kind === 'codex' ? { layer0Pending: await layer0PendingIds(on) } : undefined;

  const out: Row[] = [];
  for (const mr of r.rows) {
    const id = idOf(mr);
    let m: Mapped;
    try {
      m = mapRecord(kind, asRecord(mr), tableOf(kind, mr), mr.lane_id, ctx);
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
  const ctx = kind === 'codex' ? { layer0Pending: await layer0PendingIds(on) } : undefined;
  const m = mapRecord(kind, asRecord(mr), tableOf(kind, mr), mr.lane_id, ctx);
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
  const days = r.raised_at ? dayDiff(r.raised_at, end) : 0;
  // A Date Raised that does not parse is age 0 rather than NaN: NaN leaves as
  // null and every figure built on it falls over quietly.
  return { ...base, status: r.status as LoopStatus, closed_at: r.closed_at, age_days: Number.isFinite(days) ? Math.max(0, days) : 0 };
}
/**
 * The one definition of "open loops" (2026-09-23, Destiny). Home, the Open
 * loops page and the API all count through this, so no two of them can print a
 * different total.
 *
 * **A loop is its `loop_id`, not a row.** One row per `loop_id` is kept — the
 * most recently written, so a move that left a copy behind in its old table is
 * one loop, and the copy's stale status cannot count it twice or keep a closed
 * loop open — and then counted where its `Status` is `Open` or `In Progress`.
 * A row with no `loop_id` is still one loop, by its own row id, rather than
 * silently dropped.
 *
 * **There is no archived or deleted state to exclude**: the loop tables carry
 * neither field (checked across all 984 rows on 23 Sep — the only keys are
 * loop_id, What, Status, Date Raised, Raised By, Assignee Slack User ID,
 * Source Link, lane_tag, raised_in and last_modified), and a deleted loop is a
 * row that is no longer in `engine_loops` at all.
 *
 * `by_builder` is counted from the same kept rows, so it always sums to
 * `total` — a builder column that added up to something else would be two
 * definitions again.
 */
export interface OpenLoopCount {
  total: number;
  open: number;
  in_progress: number;
  by_builder: { builder_id: string; open: number; in_progress: number }[];
}
export async function countOpenLoops(on?: Queryable): Promise<OpenLoopCount> {
  const r = await db(on).query<{ builder_id: string | null; open: string; in_progress: string }>(
    `WITH one AS (
       SELECT DISTINCT ON (COALESCE(natural_id, 'row:' || id)) builder_id, fields->>'Status' AS status
         FROM engine_loops
        ORDER BY COALESCE(natural_id, 'row:' || id), updated_at DESC, id DESC
     )
     SELECT builder_id,
            count(*) FILTER (WHERE status = 'Open')::text        AS open,
            count(*) FILTER (WHERE status = 'In Progress')::text AS in_progress
       FROM one
      WHERE status IN ('Open', 'In Progress')
      GROUP BY builder_id
      ORDER BY count(*) DESC, builder_id`,
  );
  const by_builder = r.rows.map((x) => ({ builder_id: x.builder_id ?? '(no builder)', open: Number(x.open), in_progress: Number(x.in_progress) }));
  const open = by_builder.reduce((n, b) => n + b.open, 0);
  const in_progress = by_builder.reduce((n, b) => n + b.in_progress, 0);
  return { total: open + in_progress, open, in_progress, by_builder };
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

/**
 * The Codex entry behind one pay session (2026-09-23, Destiny). The session
 * row carries `Codex Entry ID` and `Codex Link`; the Codex rows are keyed by
 * Submission ID, and only 67 of 211 carry a `Codex Entry ID` at all, so the id
 * alone reaches 67 of the 78 sessions held. The other 11 resolve by recording:
 * the session's `Codex Link` is the same Otter URL as the entry's `Session Url`
 * (checked on 23 Sep: 67 by id, 11 by url, none ambiguous, none unresolved).
 *
 * Id first, then url, and each only when it names exactly one row — two
 * matches is a conflict to report, never a pick. Nothing found is null, and
 * the page says "No Codex entry is held for this session" rather than opening
 * an empty dialog.
 */
export class AmbiguousCodex extends Error {}
export async function codexForPaySession(sessionId: string): Promise<{ entry: CodexEntryDetail; matched_by: 'codex_entry_id' | 'session_url' } | null> {
  const s = await db().query<{ cid: string | null; link: string | null }>(
    `SELECT fields->>'Codex Entry ID' AS cid, fields->>'Codex Link' AS link
       FROM engine_pay_sessions
      WHERE natural_id = $1 OR fields->>'Codex Entry ID' = $1
      ORDER BY updated_at DESC LIMIT 1`,
    [sessionId],
  );
  const cid = s.rows[0]?.cid ?? sessionId;
  const link = s.rows[0]?.link ?? null;
  const key = (r: { airtable_record_id: string | null; pk: string }) => r.airtable_record_id ?? `row-${r.pk}`;
  const tryBy = async (sql: string, v: string) => (await db().query<{ airtable_record_id: string | null; pk: string }>(sql, [v])).rows;
  const byId = await tryBy(`SELECT airtable_record_id, id::text AS pk FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1`, cid);
  if (byId.length > 1) throw new AmbiguousCodex(`${byId.length} Codex rows carry the Codex Entry ID ${cid}: ${byId.map(key).join(', ')}.`);
  if (byId.length === 1) {
    const entry = await codexDetail(key(byId[0]));
    if (entry) return { entry, matched_by: 'codex_entry_id' };
  }
  if (!link) return null;
  const byUrl = await tryBy(`SELECT airtable_record_id, id::text AS pk FROM engine_codex_submissions WHERE fields->>'Session Url' = $1`, link);
  if (byUrl.length > 1) throw new AmbiguousCodex(`${byUrl.length} Codex rows share this session's recording link: ${byUrl.map(key).join(', ')}.`);
  if (byUrl.length === 1) {
    const entry = await codexDetail(key(byUrl[0]));
    if (entry) return { entry, matched_by: 'session_url' };
  }
  return null;
}

/* --------------------------------------------------- layer 0 holding table */

/**
 * Submissions parked at the completeness gate. They are not records of any
 * kind — no status, no write path — so they are read straight off their own
 * mirror table rather than going through the row machinery above.
 */
/**
 * The `Submission ID`s waiting on their builder, read in one query.
 *
 * `fields->>'Status'` is Airtable's own value, kept verbatim like every other
 * field, and the comparison names `pending_builder_input` literally rather than
 * taking "not completed" to mean the same thing — it does not, and reading it
 * that way is the class of bug this replaced.
 */
export async function layer0PendingIds(on?: Queryable): Promise<ReadonlySet<string>> {
  const r = await db(on).query<{ submission_id: string | null }>(
    `SELECT fields->>'Submission ID' AS submission_id FROM engine_layer0_holds
      WHERE lower(coalesce(fields->>'Status', '')) = $1`,
    [LAYER0_PENDING],
  );
  return new Set(r.rows.map((x) => x.submission_id).filter((x): x is string => Boolean(x)));
}

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
export async function nsAsks(): Promise<NsAsk[]> {
  return (await rows('ns')).map((r) => JSON.parse(r.json) as NsAsk);
}
export async function rtAsks(): Promise<RtAsk[]> {
  return (await rows('rt')).map((r) => JSON.parse(r.json) as RtAsk);
}
export async function rtJobs(): Promise<RtJob[]> {
  return (await rows('rt_jobs')).map((r) => JSON.parse(r.json) as RtJob);
}
/** Where a held row's last change came from, in the page's words. */
function heldOf(r: Row): HeldStamp {
  return { updated_at: r.updated_at, via: r.source === 'engine' ? 'engine' : r.source === 'ui' ? 'page' : 'resync' };
}
export async function clientLanes(): Promise<ClientLane[]> {
  return (await rows('clients')).map((r) => ({ ...(JSON.parse(r.json) as ClientLane), held: heldOf(r) }));
}
export async function clientQuestions(): Promise<ClientQuestion[]> {
  return (await rows('client_questions')).map((r) => ({ ...(JSON.parse(r.json) as ClientQuestion), held: heldOf(r) }));
}
export async function clientRequests(): Promise<ClientRequest[]> {
  return (await rows('client_requests')).map((r) => ({ ...(JSON.parse(r.json) as ClientRequest), held: heldOf(r) }));
}

/**
 * The newest write n8n itself made to a kind, from `engine_writes` — lookups and
 * refusals excluded. A resync overwrites a row's own `source`, so this is the
 * only place "the engine last wrote this on …" survives.
 */
export async function lastEngineWrite(kind: string): Promise<string | null> {
  const r = await db().query<{ at: string | null }>(
    `SELECT max(at) AS at FROM engine_writes WHERE kind = $1 AND outcome NOT IN ('read', 'refused')`,
    [kind],
  );
  return r.rows[0]?.at ?? null;
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

/**
 * The live figures beside a person on the Builders registry.
 *
 * Read from the record tables, never from a fixture. The distinction that
 * matters here is between a zero and an absence: Jason has an Open Loops table
 * but no submissions table — he reviews logs, he does not write them — so his
 * entries this week is **null**, not 0, and the page says so rather than
 * printing a zero that reads as "wrote nothing". Anyone with no table of a kind
 * at all gets null for that figure for the same reason.
 *
 * `oldest_loop_days` is null when nothing is open: the oldest of nothing is not
 * zero days.
 */
export interface BuilderFigures {
  id: string;
  open_loops: number | null;
  oldest_loop_days: number | null;
  entries_this_week: number | null;
}

export async function builderFigures(): Promise<BuilderFigures[]> {
  const owners = await loopsByOwner();
  const entries = await codexEntries();
  const week = isoWeek(today());
  const ids = [...new Set([...LOOP_TABLES.map((t) => t.owner), ...CODEX_TABLES.map((t) => t.owner)])];
  return ids.map((id) => {
    const hasLoops = LOOP_TABLES.some((t) => t.owner === id);
    const hasCodex = CODEX_TABLES.some((t) => t.owner === id);
    const o = owners.find((x) => x.owner === id);
    const open = o ? o.open + o.in_progress : 0;
    return {
      id,
      open_loops: hasLoops ? open : null,
      oldest_loop_days: hasLoops && open > 0 ? (o?.oldest_days ?? null) : null,
      entries_this_week: hasCodex ? entries.filter((e) => e.builder_id === id && e.week === week).length : null,
    };
  });
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

/**
 * The figures a trend needs history for. Observed once a boot, after reconcile.
 *
 * The canonical-share series that stood here is gone with `pattern_status`
 * (2026-09-15). The `observations` rows it already wrote are left in the table
 * — nothing here drops history — they are simply neither added to nor read.
 */
export async function recordObservations(): Promise<void> {
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
  const ctx = kind === 'codex' ? { layer0Pending: await layer0PendingIds() } : undefined;
  return mapRecord(kind, { id: idOf(mr), createdTime: mr.created_time ?? '', fields }, move?.table_id ?? tableOf(kind, mr), mr.lane_id, ctx);
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
  /**
   * With the write-back off (AIRTABLE_WRITEBACK, 2026-09-21) Airtable is not
   * the arbiter of which table a row sits in, because nothing is asking it:
   * these tables are the record, and the move lands here or it does not happen
   * at all. Holding it back would leave the save doing nothing with nothing on
   * screen saying so, which is the exact failure the paragraph above describes
   * in the other direction.
   *
   * With the write-back on, the rule stands unchanged: the move is claimed
   * only once Airtable has made it.
   */
  const airtableDecidesTheMove = airtable.writebackEnabled();
  let nowId = id;
  if (destination && (r.state === 'ok' || r.state === 'duplicate' || !airtableDecidesTheMove)) {
    // The assignee moves with the table here too, so the row this dashboard
    // shows never names one builder while sitting in another's.
    const moved = await mirrorRowById('loops', id);
    if (moved) await writeFields('loops', moved, { [loops_.FIELD.assignee]: SLACK_TO_BUILDER_ID[destination.owner] ?? null }, { builder_id: destination.owner, table_id: destination.table });
  }
  if (r.record_id && r.record_id !== mr.airtable_record_id) {
    await db().query('UPDATE engine_loops SET airtable_record_id = $1 WHERE id = $2', [r.record_id, mr.pk]);
    events.changed('loops', Number(mr.pk));
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
    throw new StoreError(`"${status}" is not a status a ${kind === 'codex' ? 'Codex entry' : 'card'} can have.`, 422);
  }
  const mr = await mirrorRowById(kind, id);
  if (!mr) throw new StoreError('That record is not held by this dashboard.', 404);
  // Codex: the status is Jason Status, written in the table's own spelling.
  const jason = CODEX_JASON_STATUS.find((c) => c.toLowerCase() === status);
  if (kind === 'codex' && !jason) throw new StoreError(`"${status}" is not a Jason Status the submission tables define.`, 422);
  const patch: Record<string, unknown> = kind === 'codex' ? { 'Jason Status': jason } : { readiness_state: status };
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
        ${kind ? 'WHERE kind = $1' : "WHERE kind IS DISTINCT FROM 'incidents'"}
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
  if (!identifier) throw new StoreError('This submission carries neither a Codex entry id nor a submission id, so there is nothing to confirm it by, and it cannot be deleted from here.', 422);
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
  events.changed('codex', Number(mr.pk));
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
export async function resyncCodex(actor = 'dashboard'): Promise<Resync> {
  const started = Date.now();
  const at = nowIso();
  const live = await codex_.liveRecords();
  const tables: ResyncTable[] = [];

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
        refused: 0,
      })),
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      refused: 0,
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
        refused: 0,
      });
      continue;
    }

    const kind: mirror.MirrorKind = t.owner ? 'codex' : 'layer0';
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let refused = 0;

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
        // One row this database will not store must not abandon the other 164,
        // and must not vanish either: the reason goes to the log and the count
        // comes back on the table.
        refused++;
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
      events.changed('layer0');
      bumpVersion();
    }

    tables.push({ table: t.table, label: t.label, read: true, reason: null, rows: records.length, inserted, updated, unchanged, deleted: gone.length, refused });
  }

  const sum = (k: 'inserted' | 'updated' | 'unchanged' | 'deleted' | 'refused') => tables.reduce((n, t) => n + t[k], 0);
  const blocked = tables.filter((t) => !t.read);
  const note = [
    `${sum('inserted')} inserted, ${sum('updated')} updated, ${sum('deleted')} deleted, ${sum('unchanged')} already matching.`,
    sum('refused') ? `${sum('refused')} ${sum('refused') === 1 ? 'row was' : 'rows were'} read from Airtable and refused by this database; the server log names each one and why.` : '',
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

  return { ran: true, at, ms: Date.now() - started, tables, inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), deleted: sum('deleted'), refused: sum('refused'), overwritten, note };
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
      events.changed('codex', Number(g.pk), client);
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

/* ------------------------------------- resync: patterns, commercial, clients */

/**
 * The three pages that resync one base each, in the same shape the Codex page
 * has resynced seven tables since 14 Sep.
 *
 * **Airtable is the source of truth for every field it owns and this dashboard
 * does not win a disagreement.** Insert what Airtable has and we do not, update
 * what changed there, delete what is gone. A pass that only deleted is the bug
 * that put the Codex page permanently behind its own base; it is not repeated
 * here.
 *
 * The rule that makes the delete safe is the same one: **a table that could not
 * be read is never treated as an emptied table.** Nothing under it is touched,
 * it is named in the result and in the log with what Airtable said, and the run
 * reads as a failure rather than folding into a zero.
 *
 * Manual only — not on load, not on a schedule — because it reads every field
 * of every row and it deletes.
 */
/**
 * `builders` (2026-09-23) has **no button on any page**, deliberately: nothing
 * in the interface reads Builder Profiles yet — the Builders registry tab is
 * `registry_people`, a different list — and a control that filled a table no
 * screen shows would be a button nobody could check the result of. It is
 * reachable from the MCP `resync` tool and from the final import, and
 * `get_mirror_status` names it, which is where somebody looking at that kind
 * actually is.
 */
export type ResyncKind = 'patterns' | 'commercial' | 'clients' | 'loops' | 'ns' | 'rt' | 'builders';

interface ResyncSource {
  base: string;
  table: string;
  label: string;
  kind: mirror.MirrorKind;
  /** Client questions only: the lane whose index row named this table. */
  lane_id?: string | null;
}

/**
 * A read on this path is allowed to take the time a whole table takes, unlike
 * the bounded pass that used to run on the Codex page's load: somebody pressed
 * a button and is waiting for the answer. The budget is checked between tables,
 * so the worst case is the budget plus one read.
 */
const SWEEP_READ_TIMEOUT_MS = 20_000;
const SWEEP_BUDGET_MS = 120_000;

/** Which mirror table a kind's rows live in, and whether the sweep is scoped to one Airtable table. */
function sweepScope(source: ResyncSource): { table: string; perTable: boolean } {
  // Loops and client questions both live one Airtable table per row-group — a
  // builder's table, a lane's questions — so a sweep of one must only compare
  // against, and only delete from, the rows that came out of that table.
  return { table: mirror.KINDS[source.kind].table, perTable: source.kind === 'client_questions' || source.kind === 'loops' };
}

/**
 * Rows this database holds that Airtable no longer has.
 *
 * The whole row goes to `record_deletions` before it goes: Airtable has already
 * let go of it, so once this row is deleted that log is the only place it can
 * be read. Same rule as a Codex delete, for the same reason.
 */
async function removeMirrorRows(source: ResyncSource, recordKind: RecordKind, gone: { pk: string; record: string }[], reason: string, actor: string, at: string): Promise<void> {
  if (!gone.length) return;
  const { table } = sweepScope(source);
  await withTransaction(async (client) => {
    for (const g of gone) {
      const r = await client.query<{ fields: Record<string, unknown> | null; natural_id: string | null }>(`SELECT fields, natural_id FROM ${table} WHERE id = $1`, [g.pk]);
      const row = r.rows[0];
      await client.query(
        `INSERT INTO record_deletions (kind, record_id, natural_id, builder_id, table_id, reason, fields, actor, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [recordKind, g.record, row?.natural_id ?? null, null, source.table, reason, JSON.stringify(row?.fields ?? {}), actor, at],
      );
      await client.query(`DELETE FROM ${table} WHERE id = $1`, [g.pk]);
      events.changed(source.kind, Number(g.pk), client);
    }
  });
  bumpVersion();
}

function whyAirtable(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The record ids whose last write came from this interface rather than from
 * Airtable or the engine.
 *
 * A change made here that Airtable never learned about is the one thing a
 * resync can quietly undo, and reverting it is correct — Airtable owns the
 * field — but it is never silent. These three kinds write no line to
 * `record_writes` (only loops and Codex go to Airtable from here), so the
 * signal is the mirror row's own `source` column, which is exactly what it
 * records.
 */
async function uiWritten(source: ResyncSource): Promise<Map<string, string | null>> {
  const { table, perTable } = sweepScope(source);
  const r = await db().query<{ airtable_record_id: string; natural_id: string | null }>(
    `SELECT airtable_record_id, natural_id FROM ${table} WHERE source = 'ui' AND airtable_record_id IS NOT NULL ${perTable ? 'AND table_id = $1' : ''}`,
    perTable ? [source.table] : [],
  );
  return new Map(r.rows.map((row) => [row.airtable_record_id, row.natural_id]));
}

/** Where each kind reads from. Clients is the only one that learns its tables while it runs. */
function firstSources(kind: ResyncKind): ResyncSource[] {
  /**
   * Loops are seven tables, one per builder, and every one is swept
   * (2026-09-16, Destiny). The page had no resync at all, so a loop closed or
   * raised in Airtable by hand never reached this database and the two drifted
   * quietly — the same fault the other four pages got a button for on 14 and
   * 15 Sep. The base comes from `AIRTABLE_OPEN_LOOPS_BASE_ID`, never from a
   * default: a guess about which base holds real loops is the one thing that
   * must not be guessed.
   */
  if (kind === 'loops') return LOOP_TABLES.map((t) => ({ base: airtable.loopsBase(), table: t.table, label: `${t.label} loops`, kind: 'loops' as const }));
  /**
   * Build patterns is **two** tables from 2026-09-23 — the patterns and the
   * candidates flagged against them — swept by the page's one button, the way
   * Research Twin's one button sweeps its ask ledger and its job queue. Same
   * base, so no new grant on the token.
   */
  if (kind === 'patterns')
    return [
      { base: PATTERNS.base, table: PATTERNS.table, label: PATTERNS.label, kind: 'patterns' },
      { base: PATTERN_CANDIDATES.base, table: PATTERN_CANDIDATES.table, label: PATTERN_CANDIDATES.label, kind: 'pattern_candidates' },
    ];
  if (kind === 'builders') return [{ base: BUILDER_PROFILES.base, table: BUILDER_PROFILES.table, label: BUILDER_PROFILES.label, kind: 'builder_profiles' }];
  if (kind === 'commercial') return [{ base: COMMERCIAL.base, table: COMMERCIAL.table, label: COMMERCIAL.label, kind: 'commercial' }];
  /**
   * The two twins, one table each (2026-09-16, Destiny), so that a row changed
   * or deleted in Airtable reaches this database the same way it does on the
   * other five pages.
   *
   * **This widens what the token has to read.** It was five bases; it is seven
   * now — North Star's ask log and Research Twin's queue, read only, nothing
   * written to either. A token that cannot read them authenticates and then
   * refuses, which is exactly the failure the submissions base had on 14 Sep,
   * so the refusal names the base rather than reading as an empty table.
   *
   * Since 17 Sep both twins write to their own ledgers, one row per ask, each
   * carrying a unique `Ask ID`. The attempt log this replaced did not: its
   * `card_id` repeated, and comparing on it would have read four attempts on
   * one card as three rows Airtable no longer had, and deleted them. The sweep
   * still compares Airtable record ids, which are unique everywhere.
   */
  if (kind === 'ns') return [{ base: NORTH_STAR.base, table: NORTH_STAR.table, label: NORTH_STAR.label, kind: 'ns-asks' }];
  /**
   * Research Twin is **two** tables, swept together (2026-09-17): its ask
   * ledger and its research queue.
   *
   * The queue has to be in the sweep rather than left to the mirror, because a
   * job is *updated in place* — its status, attempts and finding all change as
   * it is worked — and the agent only mirrors on an ask write. A queue kept
   * current by ask mirrors alone would show every job at the state it was in
   * when it was opened.
   */
  if (kind === 'rt')
    return [
      { base: RESEARCH_TWIN.base, table: RESEARCH_TWIN.table, label: RESEARCH_TWIN.label, kind: 'rt-asks' },
      { base: RESEARCH_JOBS.base, table: RESEARCH_JOBS.table, label: RESEARCH_JOBS.label, kind: 'rt-jobs' },
    ];
  /**
   * Clients sweeps three things: the index, every questions table the index
   * names, and the shared **Client Requests** table (2026-09-17). The requests
   * table is fixed rather than learned — it is one table for every client, not
   * one per lane — so it is queued up front beside the index.
   */
  return [
    { base: CLIENTS_INDEX.base, table: CLIENTS_INDEX.table, label: CLIENTS_INDEX.label, kind: 'client_lanes' },
    { base: CLIENT_REQUESTS.base, table: CLIENT_REQUESTS.table, label: CLIENT_REQUESTS.label, kind: 'client_requests' },
  ];
}

export async function resync(kind: ResyncKind, actor = 'dashboard'): Promise<Resync> {
  if (!airtable.airtableConfigured()) {
    return {
      ran: false,
      at: nowIso(),
      ms: 0,
      tables: [],
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      refused: 0,
      overwritten: [],
      note: 'AIRTABLE_TOKEN is not set on this server, so nothing was read and nothing was changed.',
    };
  }

  const started = Date.now();
  const at = nowIso();
  const tables: ResyncTable[] = [];
  const overwritten: { record_id: string; natural_id: string | null }[] = [];
  /** Appended to while it is walked: the clients index names the rest. */
  const queue = firstSources(kind);
  /** Every questions table the index named, so an orphan table's rows can be removed once. */
  const namedQuestionTables: string[] = [];
  let indexRead = false;

  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    if (Date.now() - started > SWEEP_BUDGET_MS) {
      tables.push({ table: source.table, label: source.label, read: false, reason: 'not reached inside the time this is given', rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }

    let records: AtRecord[];
    try {
      records = await airtable.listRecords(source.base, source.table, SWEEP_READ_TIMEOUT_MS);
    } catch (e) {
      const reason = whyAirtable(e);
      console.error(`${kind} resync: ${source.label} (${source.table}) could not be read — ${reason}`);
      tables.push({ table: source.table, label: source.label, read: false, reason, rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }

    // The index names every lane's own questions table in `Table ID`, and only
    // the index does. A questions table with no index row is an orphan — it is
    // being deleted upstream — and is never followed, so it can never appear.
    if (source.kind === 'client_lanes') {
      indexRead = true;
      for (const rec of records) {
        const lane = mapClientLane(rec);
        if (!lane.questions_table) continue;
        namedQuestionTables.push(lane.questions_table);
        queue.push({ base: CLIENTS_INDEX.base, table: lane.questions_table, label: lane.name, kind: 'client_questions', lane_id: lane.lane_id ?? lane.id });
      }
    }

    const ui = await uiWritten(source);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let refused = 0;
    for (const rec of records) {
      try {
        const result = await mirror.upsert(
          source.kind,
          {
            record_id: rec.id,
            created_time: rec.createdTime ?? null,
            fields: rec.fields ?? {},
            /**
             * The table the row came out of, for every kind that needs one —
             * not only client questions (fixed 2026-09-22).
             *
             * **This is why the Open loops resync had never stored a row.** It
             * was built on 2026-09-16 passing `table_id` for client questions
             * and null for everything else, and `loops` is a per-builder kind:
             * the table a row sits in *is* its owner, so `prepare()` refused
             * every one of them. All seven tables were read in full and
             * `refused: 7` came back on every run — visible in the toast, and
             * plainly never acted on. Measured again here against a replay of
             * the seven tables before the fix: 0 inserted, 0 updated,
             * 0 unchanged, 7 refused.
             */
            table_id: mirror.needsTableId(source.kind) ? source.table : null,
            // A request names its own lane in the row; a question is told which
            // lane by the table it came out of.
            lane_id: source.kind === 'client_requests' ? (typeof rec.fields?.['Lane ID'] === 'string' ? (rec.fields['Lane ID'] as string) : null) : (source.lane_id ?? null),
            // `prepare()` reads `Lane` off the payload for the twins, so
            // nothing needs to be told here; the sweep passes what it knows.
          },
          'airtable',
        );
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else unchanged++;
        if (result.inserted || result.changed) {
          // Dated 'mirror', never 'engine': this database learned of the change
          // when it looked, and has no idea when it happened in Airtable.
          await recordEngineWrite(source.kind, result.id, at, 'mirror');
          if (result.changed && ui.has(rec.id)) overwritten.push({ record_id: rec.id, natural_id: ui.get(rec.id) ?? null });
        }
      } catch (e) {
        // One row this database will not store must not abandon the rest of the
        // table — and must not vanish either. The reason goes to the log, the
        // count comes back on the table, so "read five, stored none" can never
        // read as "five already matched".
        refused++;
        console.error(`${kind} resync: ${source.label} ${rec.id} refused — ${whyAirtable(e)}`);
      }
    }

    // Only inside a table that was actually read. Not read is never empty.
    const { table: mirrorTable, perTable } = sweepScope(source);
    const held = await db().query<{ id: string; airtable_record_id: string }>(
      `SELECT id, airtable_record_id FROM ${mirrorTable} WHERE airtable_record_id IS NOT NULL ${perTable ? 'AND table_id = $1' : ''}`,
      perTable ? [source.table] : [],
    );
    const live = new Set(records.map((r) => r.id));
    const gone = held.rows.filter((row) => !live.has(row.airtable_record_id)).map((row) => ({ pk: row.id, record: row.airtable_record_id }));
    await removeMirrorRows(source, RECORD_KIND[source.kind] ?? (kind as RecordKind), gone, 'removed in Airtable; found missing by a resync', actor, at);

    tables.push({ table: source.table, label: source.label, read: true, reason: null, rows: records.length, inserted, updated, unchanged, deleted: gone.length, refused });
  }

  /**
   * Questions held against a table the index does not name any more. They are
   * orphans — the lane was removed from the index, or the table never had a row
   * there — and the page renders what the index holds, so they have nowhere to
   * appear. Guarded on the index having actually been read: without that, this
   * would empty the whole kind the first time Airtable refused one request.
   */
  let orphaned = 0;
  if (kind === 'clients' && indexRead) {
    const r = await db().query<{ id: string; airtable_record_id: string; table_id: string | null }>(
      `SELECT id, airtable_record_id, table_id FROM engine_client_questions WHERE airtable_record_id IS NOT NULL AND NOT (table_id = ANY($1::text[]))`,
      [namedQuestionTables],
    );
    if (r.rows.length) {
      const byTable = new Map<string, { pk: string; record: string }[]>();
      for (const row of r.rows) byTable.set(row.table_id ?? '', [...(byTable.get(row.table_id ?? '') ?? []), { pk: row.id, record: row.airtable_record_id }]);
      for (const [table, rows] of byTable) {
        await removeMirrorRows(
          { base: CLIENTS_INDEX.base, table, label: table, kind: 'client_questions' },
          'client_questions',
          rows,
          'the watched-clients index names no lane for this table, so its questions belong to no lane',
          actor,
          at,
        );
        orphaned += rows.length;
        console.log(`clients resync: removed ${rows.length} question row(s) held against ${table}, which the index does not name`);
      }
    }
  }

  const sum = (k: 'inserted' | 'updated' | 'unchanged' | 'deleted' | 'refused') => tables.reduce((n, t) => n + t[k], 0);
  const blocked = tables.filter((t) => !t.read);
  const ran = tables.some((t) => t.read);
  const deleted = sum('deleted') + orphaned;
  const refused = sum('refused');
  const note = [
    ran ? '' : 'Nothing was read, so nothing was changed.',
    ran ? `${sum('inserted')} inserted, ${sum('updated')} updated, ${deleted} deleted, ${sum('unchanged')} already matching.` : '',
    orphaned ? `${orphaned} of those deletions were questions held against a table the index does not name.` : '',
    refused ? `${refused} ${refused === 1 ? 'row was' : 'rows were'} read from Airtable and refused by this database; the server log names each one and why.` : '',
    overwritten.length ? `${overwritten.length} of those updates overwrote a change made here that Airtable never had — ${overwritten.map((o) => o.natural_id ?? o.record_id).join(', ')}.` : '',
    blocked.length
      ? `${blocked.length} ${blocked.length === 1 ? 'table' : 'tables'} could not be read (${blocked.map((b) => b.label).join(', ')}), so nothing under ${blocked.length === 1 ? 'it' : 'them'} was touched. ${reasonsOf(blocked.map((b) => ({ label: b.label, reason: b.reason ?? 'no reason given' })))}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  // The per-table breakdown goes to the log in full; the page gets the totals.
  console.log(
    `${kind} resync by ${actor}: ${note} | ` + tables.map((t) => `${t.label} ${t.read ? `${t.rows} rows +${t.inserted}/~${t.updated}/-${t.deleted}` : `UNREAD (${t.reason})`}`).join(' · '),
  );

  return { ran, at, ms: Date.now() - started, tables, inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), deleted, refused, overwritten, note };
}

async function runReconcile(): Promise<CodexReconciliation> {
  const at = nowIso();
  /**
   * Retired first, and this one matters more than the buttons (2026-09-22).
   *
   * This pass runs on **every load of the Codex page** and its job is to
   * *delete* rows Airtable no longer has. Once Airtable is retired it is not
   * the record any more, and a table it answers about with nothing is not an
   * emptied table — it is a base nobody maintains. Left running, the first
   * page load after the cutover would quietly delete every Codex entry the
   * engine had written since.
   *
   * Caught in a browser rather than by reading: with the rest of the
   * retirement in place, a replay that answered the six builder tables with no
   * records took the page from six entries to none on one load.
   */
  if (airtable.retired()) {
    return { ran: false, checked: 0, removed: 0, removed_ids: [], blocked: [], at, note: `${airtable.RETIRED_REASON} Nothing was compared and nothing was removed.` };
  }
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
  'ns-asks': 'ns',
  'rt-asks': 'rt',
  'rt-jobs': 'rt_jobs',
  client_lanes: 'clients',
  client_questions: 'client_questions',
  client_requests: 'client_requests',
  /**
   * Engine Health's three are not record kinds. They have no monthly rollup,
   * no status ledger and no record page, so — like `layer0` and `digests` —
   * they map to nothing here and `recordEngineWrite` no-ops for them. They are
   * read by `health.ts`, which owns their queries the way `executions.ts` owns
   * its own.
   */
  incidents: null,
  error_counts: null,
  retry_attempts: null,
  /** The pay ledger's three, read by `pay.ts` the way health.ts reads its own. */
  pay_builders: null,
  pay_sessions: null,
  pay_statements: null,
  digests: null,
  /**
   * The four Bays tables (2026-09-22). None of them is a record kind: there is
   * no page reading them and no status ledger to date, so nothing here maps
   * them onto one. Null is the statement, not an omission — this map is a
   * Record<MirrorKind, …> precisely so a new kind cannot skip the question.
   */
  channel_tracking: null,
  review_returns: null,
  lane_backlog: null,
  deep_think_log: null,
  /**
   * Nor these two. Neither is a record kind: no page reads them and there is no
   * status ledger to date. Null is the statement, not an omission.
   */
  builder_profiles: null,
  pattern_candidates: null,
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
): Promise<Loop | CodexEntry | BuildPattern | Opportunity | NsAsk | RtAsk | RtJob | ClientLane | ClientQuestion | null> {
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

/** "Sep 2026" from `2026-09`. Spelled the same way stats.ts and the pages spell one. */
function monthName(month: string): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m] = month.split('-');
  return `${names[Number(m) - 1] ?? month} ${y}`;
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
// Any write this process announces — an engine POST, a PATCH, a pay row the
// sync wrote — makes every memoised figure stale, not only the writes that
// happen to pass through this file.
events.onChange(() => bumpVersion());

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
  /**
   * Seven buckets (2026-09-16, Destiny), so this card and Close rate by builder
   * beside it — which has one row per builder, and there are seven — read as
   * one set rather than two lists of different lengths.
   *
   * An empty bucket is still drawn: "nothing has been open longer than ninety
   * days" is a fact worth seeing, and a bucket that vanishes when it empties
   * makes the card change shape every time the backlog does.
   */
  const buckets: [string, (d: number) => boolean][] = [
    ['0–7 days', (d) => d <= 7],
    ['8–14 days', (d) => d > 7 && d <= 14],
    ['15–30 days', (d) => d > 14 && d <= 30],
    ['31–60 days', (d) => d > 30 && d <= 60],
    ['61–90 days', (d) => d > 60 && d <= 90],
    ['91–180 days', (d) => d > 90 && d <= 180],
    ['over 180 days', (d) => d > 180],
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
    // "In view" rather than "in the builder's table": these rows are narrowed
    // to the month the page is showing (2026-09-16), and a note that claims
    // all time over a month's figures is the kind of quiet lie this dashboard
    // exists to stop.
    close_rate_note: 'Closed as a share of the loops in view. A state, not a rate over time: nothing records when a loop closed.',
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

/**
 * The figures across Open loops, scoped to a month (2026-09-16, Destiny) by
 * `Date Raised` — the same field the statistics tab groups by, so the two
 * cannot disagree about which loops belong to September.
 *
 * Everything follows the month, the status counts included (2026-09-16,
 * Destiny — replacing the all-time strip of earlier the same day). All-time was
 * defensible alone but did not reconcile with the statistics tab beside it, and
 * two answers to one question is worse than one narrower answer. All time is
 * reached by choosing it in the month picker, which scopes the whole page.
 */
export async function loopMetrics(builder: string | null, month?: string | null): Promise<LoopMetrics> {
  const key = `loops:${builder ?? '*'}:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as LoopMetrics;
  const everything = await loops();
  const inMonth = (l: Loop) => !month || l.raised_at?.slice(0, 7) === month;
  const all = everything.filter(inMonth);
  const historySince = await getMeta('history_since');
  const closes = await loopCloseEvents();
  const value: LoopMetrics = builder
    ? loopMetricsFor(all.filter((l) => l.owner === builder), builder, historySince, closes)
    : {
        ...loopMetricsFor(all, null, historySince, closes),
        // One pass per builder, computed here once and cached, so a tab change on the page needs no request.
        by_builder: Object.fromEntries(
          LOOP_TABLES.filter((t) => everything.some((l) => l.owner === t.owner)).map((t) => [
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
 * Mutually exclusive by one rule, applied in `mapCodex`: a Layer 0 row at
 * `pending_builder_input` wins, and otherwise Jason Status decides. So every
 * submission is in exactly one stage and the three sum to the total — which the
 * row that came before did not, because it asked two different questions at
 * once.
 *
 * Ordered approved first (decision 2026-09-14, Destiny), which is where almost
 * every log ends up and so where a reader starts. The card that shows the split
 * reads the same order, so the page states one order rather than two. The
 * `layer` beside each is the step's name, not its number — "Layer 0" told a
 * reader nothing.
 *
 * Each rule used to be carried here as a paragraph the page printed under the
 * tabs. They are gone from the screen (decision 2026-09-14, Destiny): the tab
 * label carries the meaning, and three paragraphs restating it are furniture.
 * The rules live in CLAUDE.md §4, where they are the spec rather than a caption.
 */
const TAB_RULES: { tab: CodexTab; label: string; layer: string; test: (e: CodexEntry) => boolean }[] = [
  { tab: 'approved', label: 'Approved', layer: 'Builder codex', test: (e) => e.stage === 'approved' },
  { tab: 'awaiting', label: 'Awaiting approval', layer: 'Pending review', test: (e) => e.stage === 'awaiting' },
  { tab: 'needs_input', label: 'Needs input', layer: 'Completeness check', test: (e) => e.stage === 'needs_input' },
];

export function codexTabRule(tab: CodexTab): (e: CodexEntry) => boolean {
  return TAB_RULES.find((r) => r.tab === tab)!.test;
}

/**
 * The figures on a record page, scoped to a month (2026-09-16, Destiny).
 *
 * The pages opened on an all-time view, so "submissions" was every submission
 * BHA has ever logged and the figure never moved. Scoped to the month in view
 * it answers the question somebody actually has — what happened this month —
 * and the month picker changes it.
 *
 * **The per-builder weekly grid is deliberately not scoped.** It is an
 * eight-week strip by design; narrowing it to one month would blank most of its
 * columns, and Destiny asked for it to stay as it is. So it is computed over
 * the whole history while everything else follows the month.
 */
export async function codexMetrics(builder: string | null, month?: string | null): Promise<CodexMetrics> {
  const key = `codex:${builder ?? '*'}:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as CodexMetrics;
  const everything = (await codexEntries()).filter((e) => !builder || e.builder_id === builder);
  const all = month ? everything.filter((e) => e.logged_at?.slice(0, 7) === month) : everything;
  const holds = (await layer0Holds()).filter(
    (h) => (!builder || h.builder_id === builder) && (!month || h.created_at?.slice(0, 7) === month),
  );

  const flagged = all.filter((e) => e.layer0_flagged);
  const withEntry = all.filter((e) => e.has_entry).length;

  const missing = new Map<string, number>();
  for (const e of flagged) for (const m of e.layer0_missing) missing.set(m, (missing.get(m) ?? 0) + 1);

  const owners = CODEX_TABLES.filter((t) => (!builder || t.owner === builder) && everything.some((e) => e.builder_id === t.owner)).map((t) => t.owner);
  const weekStarts = lastWeeks(8);
  const perBuilder = owners.map((o) => ({
    owner: o,
    // `everything`, not `all`: the eight-week strip keeps the whole history
    // even when the rest of the page is scoped to one month.
    weeks: weekStarts.map((w) => ({ week: isoWeek(w), start: w, label: weekLabel(w), short: shortWeekLabel(w), n: everything.filter((e) => e.builder_id === o && e.week === isoWeek(w)).length })),
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
    tabs: TAB_RULES.map((r) => ({ tab: r.tab, label: r.label, layer: r.layer, n: all.filter(r.test).length })),
    stage_reconciliation: (() => {
      const sums = TAB_RULES.reduce((n, r) => n + all.filter(r.test).length, 0);
      return {
        rows: all.length,
        sums_to: sums,
        note:
          sums === all.length
            ? `${TAB_RULES.map((r) => all.filter(r.test).length).join(' + ')} = ${all.length}, in the order above and each log in exactly one: a Layer 0 row at pending_builder_input decides, then Jason Status.`
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

export async function patternMetrics(month?: string | null): Promise<PatternMetrics> {
  const key = `patterns:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as PatternMetrics;
  const everything = await patterns();
  /**
   * The month in view, chosen beside the search box (2026-09-16, Destiny). The
   * figures, the reusability mix and the duplicate arithmetic are all about the
   * rows on screen, so they are all computed over the same scoped set — a
   * strip that answered all time while the list answered one month is the
   * reconciliation bug the loops page had.
   */
  const all = month ? everything.filter((p) => p.created_at?.slice(0, 7) === month) : everything;
  const weeks = month ? weeksIn(month) : lastWeeks(8);
  const created = series(
    weeks.map((w) => ({ label: weekLabel(w), value: everything.filter((p) => p.created_at && weekStart(p.created_at.slice(0, 10)) === w).length })),
    month ? `Patterns by the week of created_at, the weeks covering ${monthName(month)}. A week that straddles the boundary counts every pattern in it.` : 'Patterns by the week of created_at, last eight weeks.',
  );

  /**
   * Why a count of rows is not a count of patterns: the table holds more rows
   * than distinct pattern ids. Both figures are given rather than one passed
   * off as the other.
   *
   * The draft / canonical / no-status reconciliation that stood here is gone
   * with the field it counted — `pattern_status` was deleted from the base
   * (2026-09-15, Destiny), so there is nothing left to reconcile.
   */
  const byId = new Map<string, number>();
  for (const p of all) if (p.pattern_id) byId.set(p.pattern_id, (byId.get(p.pattern_id) ?? 0) + 1);
  const repeated = [...byId.entries()]
    .filter(([, n]) => n > 1)
    .map(([pattern_id, n]) => ({ pattern_id, n }))
    .sort((a, b) => b.n - a.n || a.pattern_id.localeCompare(b.pattern_id));
  const duplicateRows = repeated.reduce((n, r) => n + (r.n - 1), 0);

  // reusability is a free-text field. Most rows use one of Narrow / Moderate /
  // Broad; the rest explain the reach in a sentence, which is counted as one
  // group rather than drawn as a bar per sentence.
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
    scope: { rows: all.length, month: month ?? null },
    /**
     * The figure and the sentence have to agree, so `distinct_ids` is the count
     * of distinct pattern ids and nothing else: rows carrying no pattern_id at
     * all are named separately rather than folded in as one id each, which is
     * what made the card read 4 beside a note that said 3.
     *
     * rows = distinct ids + duplicate rows + rows with no id, and the note
     * prints that arithmetic so a reader can check it on the page.
     */
    duplicates: {
      distinct_ids: byId.size,
      duplicate_rows: duplicateRows,
      ids: repeated,
      note: (() => {
        const noId = all.filter((p) => !p.pattern_id).length;
        if (!repeated.length && !noId) return 'Every row carries a distinct pattern_id, so the row count is the pattern count.';
        const parts = [`${byId.size} distinct pattern ${byId.size === 1 ? 'id' : 'ids'}`];
        if (duplicateRows) parts.push(`${duplicateRows} duplicate ${duplicateRows === 1 ? 'row' : 'rows'} (${repeated.map((r) => r.pattern_id).join(', ')})`);
        if (noId) parts.push(`${noId} ${noId === 1 ? 'row carrying' : 'rows carrying'} no pattern_id`);
        return `${all.length} rows: ${parts.join(' + ')}. A count of rows is not a count of patterns.`;
      })(),
    },
    reusability_mix: reuse.map((r) => ({ reusability: r, n: all.filter((p) => reuseKey(p) === r).length })).sort((a, b) => b.n - a.n),
    /**
     * The fourth figure on the strip (2026-09-16, Destiny), so this page reads
     * with the same density as the other record pages rather than three wide
     * cells. It is real: the system segment of each pattern's own id, which is
     * the same source the row's own `system` column already prints.
     */
    systems: (() => {
      const names = [...new Set(all.map((p) => p.system).filter((v): v is string => Boolean(v)))].sort();
      const unfiled = all.filter((p) => !p.system).length;
      return {
        n: names.length,
        names,
        unfiled,
        note: names.length
          ? `From the system segment of each pattern_id: ${names.join(', ')}.${unfiled ? ` ${unfiled} ${unfiled === 1 ? 'row does' : 'rows do'} not follow that shape and are filed under none.` : ''}`
          : 'No pattern_id follows the BP-SYSTEM-nnn shape, so no system can be read off one.',
      };
    })(),
    reusability_note: `reusability is free text rather than a select. ${all.length - prose} of ${all.length} rows answer in one word; ${prose} explain the reach in a sentence and are grouped as \u201cwritten out in prose\u201d \u2014 open the pattern to read it.`,
    created_per_week: created,
  };
  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

/**
 * High before Medium before Low, and anything else — an unset value, a word
 * this list does not know — last rather than first, which is where a bare
 * indexOf of -1 would have put it.
 */
export const LEVEL_ORDER = ['High', 'Medium', 'Low'];
function levelRank(v: string): number {
  const i = LEVEL_ORDER.findIndex((l) => l.toLowerCase() === v.trim().toLowerCase());
  return i === -1 ? LEVEL_ORDER.length : i;
}

export async function commercialMetrics(month?: string | null): Promise<CommercialMetrics> {
  const key = `commercial:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as CommercialMetrics;
  const everything = await opportunities();
  /**
   * The month in view, chosen beside the search box (2026-09-16, Destiny), the
   * same way Build patterns scopes itself. `unresolved_trend` is the one figure
   * here that is deliberately not scoped: it is this dashboard's own
   * observations of the whole corpus at each resync, and cutting that to a
   * month would be cutting a history by when it was written down.
   */
  const all = month ? everything.filter((o) => o.created_at?.slice(0, 7) === month) : everything;
  const withCount = all.filter((o) => o.open_questions !== null);
  const total = withCount.reduce((n, o) => n + (o.open_questions ?? 0), 0);
  const zeroButListed = all.filter((o) => o.missing_research_count === 0 && o.missing_research_questions.length > 0).length;
  const obs = await observations('commercial', 'unresolved_questions');
  const distinctDays = new Set(obs.map((o) => o.at.slice(0, 10)));
  const confidence = [...new Set(all.map((o) => o.confidence ?? '(unset)'))];
  const mediaMix = [...new Set(all.map((o) => o.media_readiness ?? '(unset)'))];
  const incomplete = all.map((o) => ({ id: o.id, card_id: o.card_id, missing: incompleteFields(o) })).filter((c) => c.missing.length > 0);
  const weeks = month ? weeksIn(month) : lastWeeks(8);
  const created = series(
    weeks.map((w) => ({ label: weekLabel(w), value: everything.filter((o) => o.created_at && weekStart(o.created_at.slice(0, 10)) === w).length })),
    month
      ? `Cards by the week of created_at, the weeks covering ${monthName(month)}. A week that straddles the boundary counts every card in it.`
      : 'Cards by the week of created_at, last eight weeks. Card creation stopped on 9 Sep 2026, so a run of empty weeks after that is the outage, not a fall in output.',
  );

  /**
   * There is deliberately nothing here grouped by lane, readiness, pilot state,
   * routing state, media gate or lane state (2026-09-15, Destiny). Every one of
   * those was checked against all 21 records: lane_id is 1:1 with the card, the
   * other four are a single hardcoded value on every row, and readiness_state
   * is 19 Research-First to 1 Media-Ready to 1 blank. A bucket that holds
   * everything, or one that holds exactly one card, sorts nothing.
   */
  const value: CommercialMetrics = {
    kind: 'commercial',
    computed_at: nowIso(),
    scope: { rows: all.length, month: month ?? null },
    cards: all.length,
    // Nothing listed and a count of 0: a card with neither says nothing, and is not clear.
    clear: all.filter((o) => o.open_questions === 0).length,
    media_ready: all.filter((o) => o.readiness_state === 'Media-Ready').length,
    // Both mixes read strongest first, which is what their cards say they do.
    confidence_mix: confidence
      .map((c) => ({ confidence: c, n: all.filter((o) => (o.confidence ?? '(unset)') === c).length }))
      .sort((a, b) => levelRank(a.confidence) - levelRank(b.confidence) || a.confidence.localeCompare(b.confidence)),
    media_readiness_mix: mediaMix
      .map((m) => ({ media_readiness: m, n: all.filter((o) => (o.media_readiness ?? '(unset)') === m).length }))
      .sort((a, b) => levelRank(a.media_readiness) - levelRank(b.media_readiness) || a.media_readiness.localeCompare(b.media_readiness)),
    created_per_week: created,
    unresolved_questions: {
      value: withCount.length ? total : null,
      note: withCount.length
        ? `Open research questions over the ${withCount.length} of ${all.length} cards that state any: each card's missing_research_count, except where it is 0 or missing while the card lists questions in missing_research_questions — there the listed questions are counted. The extractor posts missing_research_count as a literal 0 on every new card${zeroButListed ? `, and ${zeroButListed} ${zeroButListed === 1 ? 'card says' : 'cards say'} 0 while listing questions` : ''}.${all.length - withCount.length ? ` ${all.length - withCount.length} ${all.length - withCount.length === 1 ? 'card states' : 'cards state'} neither and ${all.length - withCount.length === 1 ? 'is' : 'are'} not counted.` : ''}`
        : 'No card lists a question or carries a missing_research_count.',
    },
    unresolved_trend:
      distinctDays.size >= 2
        ? series(obs.map((o) => ({ label: o.at.slice(5, 10), value: Math.round(o.value) })), 'Total unresolved research questions as observed at each resync, since this database started recording.')
        : series(null, 'A trend needs the count observed on at least two different days. Nothing kept a history of this field before, so the series starts from this dashboard\u2019s own first observation.'),
    incomplete: {
      n: incomplete.length,
      cards: incomplete,
      note: incomplete.length
        ? `${incomplete.length} ${incomplete.length === 1 ? 'card is' : 'cards are'} missing fields a complete extractor run writes. That is a malformed record, not a state: it is not counted as a readiness of its own.`
        : 'Every card carries the fields a complete extractor run writes.',
    },
  };
  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

export async function metrics(kind: RecordKind, filter: { builder?: string | null; month?: string | null } = {}): Promise<RecordMetrics> {
  switch (kind) {
    case 'loops':
      return loopMetrics(filter.builder ?? null, filter.month ?? null);
    case 'codex':
      return codexMetrics(filter.builder ?? null, filter.month ?? null);
    case 'patterns':
      return patternMetrics(filter.month ?? null);
    case 'commercial':
      return commercialMetrics(filter.month ?? null);
    case 'ns':
      return nsMetrics(filter.month ?? null);
    case 'rt':
      return rtMetrics(filter.month ?? null);
    case 'rt_jobs':
      return rtJobMetrics(filter.month ?? null);
    default:
      throw new StoreError(`${kind} has no metrics of its own.`, 404);
  }
}

/** Which mirror table a kind's rows live in, for a reader that needs the raw row. */
export function mirrorTable(kind: RecordKind): string | null {
  return MIRROR[kind]?.table ?? null;
}

/**
 * Every loop close this database can date, as a transition rather than a first
 * sighting.
 *
 * The same rule the close-rate figures already use: an event with no
 * `from_status` is the first time this database saw the loop at all, and a loop
 * that was already closed when it arrived has no close date anywhere, because
 * the loop tables carry none. Counting those would date the whole backfill to
 * the day of the backfill.
 */
export async function loopCloses(): Promise<{ record_id: string; at: string }[]> {
  const r = await db().query<{ record_id: string; at: string }>(
    `SELECT DISTINCT ON (record_id) record_id, at FROM events
      WHERE kind = 'loops' AND to_status = 'closed' AND from_status IS NOT NULL
      ORDER BY record_id, at DESC, seq DESC`,
  );
  return r.rows;
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

/* ------------------------------------------------------------ the twins */

/**
 * North Star and Research Twin, computed from the ledgers they have written to
 * since 17 Sep 2026.
 *
 * Four rules run through every figure below, and they are the reason this file
 * is longer than the arithmetic needs:
 *
 *   - **A percentage always carries its denominator.** `Share` holds `n` and
 *     `of` as well as the rate, and a rate over nought rows is null with a
 *     sentence rather than 0%.
 *   - **No duration is ever a mean.** p50 and p95, over the rows that actually
 *     carried a duration, with how many did stated beside them. A mean hides
 *     the tail, and the tail is what people feel.
 *   - **Every figure says what it excludes**, in the note the tile prints.
 *   - **Nothing is inferred from answer text.** A missing field is missing.
 *
 * And the fifth, which shapes what is *not* here: these ledgers started empty
 * on 17 September. September holds a handful of rows and October is the first
 * clean month, so no figure here is smoothed, averaged across months, or
 * projected. A sparse month reads as a sparse month.
 */

/** A rate with the denominator it is over. Null where there is nothing to divide by. */
function share(n: number, of: number, note: (n: number, of: number) => string): Share {
  return { n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null, note: note(n, of) };
}

/**
 * A distribution over a select, in the vocabulary's own order.
 *
 * `vocab` is the base's list, so the bars keep a stable order rather than
 * reordering as counts change; anything the rows carry that the vocabulary does
 * not know is appended rather than dropped, because a value Airtable has added
 * and this code has not heard of is a real answer.
 */
function slices<T>(items: T[], of: (x: T) => string | null, vocab: readonly string[], blank: string): Slice[] {
  const counts = new Map<string, number>();
  for (const x of items) {
    const key = of(x) ?? blank;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known = vocab.filter((v) => counts.has(v)).map((v) => ({ key: v, label: v, n: counts.get(v)! }));
  const rest = [...counts.entries()]
    .filter(([k]) => !vocab.includes(k))
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, label: key, n }));
  return [...known, ...rest];
}

/**
 * p50 and p95 of a set of numbers, over the rows that carry one.
 *
 * Nearest-rank, which for two values gives a real observation rather than an
 * interpolation between them — on a ledger holding four asks that matters, and
 * an interpolated p95 of a fortnight's data is a number nobody measured.
 */
function percentiles(values: number[], of: number, note: (n: number, of: number) => string): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(at(50)), p95: round(at(95)), n: s.length, of, note: note(s.length, of) };
}

/** An asking system or a lane, with its own rates rather than the aggregate's. */
function cohorts<T>(items: T[], key: (x: T) => string | null, blank: string, answered: (x: T) => boolean, delivered: (x: T) => boolean, external?: (x: T) => boolean): Cohort[] {
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x) ?? blank;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.entries()]
    .map(([k, mine]) => ({
      key: k,
      label: k,
      asks: mine.length,
      answered: mine.filter(answered).length,
      delivered: mine.filter(delivered).length,
      external: external ? mine.filter(external).length : null,
    }))
    .sort((a, b) => b.asks - a.asks);
}

function inMonth(at: string | null, month: string | null | undefined): boolean {
  return !month || at?.slice(0, 7) === month;
}

function weekOf(at: string | null): string | null {
  return at ? weekStart(at.slice(0, 10)) : null;
}

const NO_LANE = '(no lane)';
const NO_SYSTEM = '(no system named)';
const NO_OUTCOME = '(no outcome)';
const NOT_STATED = '(not stated)';

/** How long since the newest ask, in the same words on both twins. */
function lastAskOf(asks: { asked_at: string | null; ask_id: string | null }[], twin: string): { at: string | null; ask_id: string | null; note: string } {
  const newest = asks.filter((a) => a.asked_at).sort((a, b) => b.asked_at!.localeCompare(a.asked_at!))[0] ?? null;
  if (!newest?.asked_at) return { at: null, ask_id: null, note: `No ask in this month carries a timestamp, so there is nothing to date. Silence here is itself the signal.` };
  const days = Math.floor((Date.now() - Date.parse(newest.asked_at)) / 86_400_000);
  return {
    at: newest.asked_at,
    ask_id: newest.ask_id,
    note: days === 0 ? `${twin} was asked something today, so the routing into it is working.` : `Nothing has reached ${twin} for ${days} ${days === 1 ? 'day' : 'days'}. Silence here is itself the signal.`,
  };
}

/**
 * Twin-to-twin handoffs, counted across both ledgers.
 *
 * **The `Linked Twin Ask` field is the real answer and it may be empty on early
 * rows**, because the front doors do not yet pass it through. Until that is
 * fixed this also counts an ask whose `Asked By System` names the other twin,
 * and an Ask ID that appears in a research job's `Linked Asks`. Every one of
 * those three is stated in the note rather than folded into one number, because
 * a count that quietly changes definition when a field starts being written is
 * worse than a smaller one that says what it is.
 */
function handoffsOf(ns: NsAsk[], rt: RtAsk[], jobs: RtJob[]): Handoffs {
  const nsById = new Map(ns.filter((a) => a.ask_id).map((a) => [a.ask_id!, a]));
  const rtById = new Map(rt.filter((a) => a.ask_id).map((a) => [a.ask_id!, a]));
  const inJobs = new Set(jobs.flatMap((j) => j.linked_asks));

  const nsHandoffs = ns.filter((a) => a.linked_twin_ask || a.asked_by_system === 'Research Twin');
  const rtHandoffs = rt.filter((a) => a.linked_twin_ask || a.asked_by_system === 'North Star' || (a.ask_id && inJobs.has(a.ask_id)));
  const n = nsHandoffs.length + rtHandoffs.length;
  const of = ns.length + rt.length;

  /**
   * **A direction is only asserted where the row states one.**
   *
   * `Asked By System` naming the other twin says who asked whom. `Linked Twin
   * Ask` on its own says the two rows are one exchange and nothing about which
   * end started it — an ask in North Star's ledger carrying it could be North
   * Star consulting Research Twin just as easily as the reverse. Those are
   * `linked`, because an arrow this code picked would be a fact nobody
   * recorded, printed with the same confidence as one that was.
   */
  const pairs: Handoffs['pairs'] = [];
  for (const a of nsHandoffs) {
    const other = a.linked_twin_ask ? (rtById.get(a.linked_twin_ask) ?? null) : null;
    pairs.push({
      ask_id: a.ask_id ?? a.id,
      ask_at: a.asked_at,
      ask_question: a.question,
      reply_id: other?.ask_id ?? a.linked_twin_ask ?? null,
      reply_at: other?.asked_at ?? null,
      reply_summary: other?.answer_summary ?? null,
      direction: a.asked_by_system === 'Research Twin' ? 'rt→ns' : 'linked',
      ledger: 'North Star',
    });
  }
  for (const a of rtHandoffs) {
    const other = a.linked_twin_ask ? (nsById.get(a.linked_twin_ask) ?? null) : null;
    pairs.push({
      ask_id: a.ask_id ?? a.id,
      ask_at: a.asked_at,
      ask_question: a.question,
      reply_id: other?.ask_id ?? a.linked_twin_ask ?? null,
      reply_at: other?.asked_at ?? null,
      reply_summary: other?.answer_summary ?? null,
      direction: a.asked_by_system === 'North Star' ? 'ns→rt' : 'linked',
      ledger: 'Research Twin',
    });
  }
  pairs.sort((a, b) => (b.ask_at ?? '').localeCompare(a.ask_at ?? ''));

  const linked = nsHandoffs.filter((a) => a.linked_twin_ask).length + rtHandoffs.filter((a) => a.linked_twin_ask).length;
  return {
    n,
    of,
    pct: of ? Math.round((n / of) * 1000) / 10 : null,
    pairs: pairs.slice(0, 12),
    note:
      of === 0
        ? 'Neither ledger holds an ask yet, so there is nothing to count. Until 17 Sep 2026 the twins could not reach each other at all; every handoff went through a person or through Bays.'
        : `${n} of ${of} asks across both ledgers are a twin consulting the other. ${linked} of those carry Linked Twin Ask; the rest are counted from Asked By System naming the other twin, or from an Ask ID appearing in a research job's Linked Asks. That fallback exists because the front doors do not yet pass Linked Twin Ask through, so early rows leave it empty — when they do, this figure will be exact rather than larger.`,
  };
}

export async function twinHandoffs(): Promise<Handoffs> {
  return handoffsOf(await nsAsks(), await rtAsks(), await rtJobs());
}

/* ----------------------------------------------------------- north star */

export async function nsMetrics(month?: string | null): Promise<NsMetrics> {
  const key = `ns:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as NsMetrics;

  const everything = await nsAsks();
  /**
   * The month the page is showing, chosen beside the search box. The strip and
   * the list answer the same question, which is the reconciliation fault the
   * loops page had and every record page has been held to since.
   */
  const all = everything.filter((r) => inMonth(r.asked_at, month));
  const weeks = lastWeeks(8);

  const delivered = all.filter((r) => r.delivered === 'Delivered');
  const answered = all.filter((r) => r.outcome === 'Answered');
  const timed = all.filter((r) => r.response_seconds !== null);
  const undelivered = all.filter((r) => r.delivered && r.delivered !== 'Delivered');
  const withCoverage = all.filter((r) => r.citation_coverage !== null);

  const tools = new Map<string, { calls: number; hits: number | null; cited: number | null }>();
  for (const r of all)
    for (const t of r.tools) {
      const held = tools.get(t.tool) ?? { calls: 0, hits: null, cited: null };
      held.calls++;
      // Null plus a number is that number; null plus null stays null. A tool
      // whose lines never carried counts must not read as nought hits.
      if (t.hits !== null) held.hits = (held.hits ?? 0) + t.hits;
      if (t.cited !== null) held.cited = (held.cited ?? 0) + t.cited;
      tools.set(t.tool, held);
    }

  const coverageBuckets: [string, (c: number) => boolean][] = [
    ['nothing cited', (c) => c <= 0],
    ['partly cited', (c) => c > 0 && c < 1],
    ['fully cited', (c) => c >= 1],
  ];

  const lanes = [...new Set(all.map((r) => r.lane ?? NO_LANE))];
  const criticalWeeks = (lane: string) =>
    new Set(all.filter((r) => (r.lane ?? NO_LANE) === lane && r.claimed_priority_tier === 'Critical').map((r) => weekOf(r.asked_at)).filter((w): w is string => Boolean(w)));

  const architectLanes = [...new Set(all.filter((r) => r.architect_attention).map((r) => r.lane ?? NO_LANE))].map((lane) => {
    const mine = all.filter((r) => r.architect_attention && (r.lane ?? NO_LANE) === lane);
    return { lane, n: mine.length, last_at: mine.map((r) => r.asked_at).filter(Boolean).sort().reverse()[0] ?? null };
  });

  const value: NsMetrics = {
    kind: 'ns',
    computed_at: nowIso(),
    scope: { rows: all.length, month: month ?? null },
    delivery_rate: share(delivered.length, all.length, (n, of) =>
      of
        ? `${n} of ${of} asks reached someone. Delivery is recorded after the answer is sent, so this is what actually arrived, not what was attempted. "No target" (nowhere to reply) counts against it. Caution: the agent never writes "Not delivered" — a Slack post that is refused stops the run before the ask is logged — so a failed delivery leaves no row here at all, and 100% cannot on its own prove every post arrived. Failed runs are on Executions. North Star once ran green for six days while Slack rejected every post.`
        : 'No ask is held for this month, so there is nothing whose delivery could be recorded.',
    ),
    answered_rate: share(answered.length, all.length, (n, of) =>
      of
        ? `${n} of ${of} asks came back Answered — an answer carrying at least one [S#] citation marker. Thin, Refused and Failed are the other three and are counted separately. The outcome is set by the agent from its own answer text at the end of the run; this dashboard only counts it.`
        : 'No ask is held for this month.',
    ),
    asks: all.length,
    response: percentiles(timed.map((r) => r.response_seconds!), all.length, (n, of) =>
      n
        ? `Seconds from question to answer, over the ${n} of ${of} asks that recorded a duration. p50 and p95, never a mean — a mean hides the slow tail, and the tail is what people feel.`
        : of
          ? `None of this month's ${of} asks recorded a response time, so there is no figure — not a figure of nought.`
          : 'No ask is held for this month.',
    ),
    last_ask: lastAskOf(all, 'North Star'),
    asks_per_week: series(
      weeks.map((w) => ({ label: weekLabel(w), value: all.filter((r) => weekOf(r.asked_at) === w).length })),
      'Asks by the week they were asked, over the last eight weeks. The ledger opened on 17 Sep 2026, so weeks before it were not quiet — they were not recorded.',
    ),
    outcome_per_week: weeks.map((w) => {
      const mine = all.filter((r) => weekOf(r.asked_at) === w);
      return {
        week: w,
        label: weekLabel(w),
        total: mine.length,
        counts: Object.fromEntries([...NS_OUTCOMES, NO_OUTCOME].map((o) => [o, mine.filter((r) => (r.outcome ?? NO_OUTCOME) === o).length])),
      };
    }),
    outcome_mix: slices(all, (r) => r.outcome, NS_OUTCOMES, NO_OUTCOME),
    outcome_note:
      'Answered = an answer with at least one [S#] citation marker · Thin = an answer with no [S#] marker (an uncited refusal lands here too) · Refused = a cited answer saying the question is Bays’ or Research Twin’s · Failed = no answer text, or the research step failed. Set by the agent at the end of the run, from its own answer text. Every row in this ledger carries one, so there is no unclassified bucket; a row that carries none is a run that did not finish writing itself.',
    delivery_mix: slices(all, (r) => r.delivered, NS_DELIVERED, '(not recorded)'),
    failed_targets: [...new Map(undelivered.map((r) => [`${r.delivery_target ?? '(no target named)'}|${r.delivered}`, r])).values()].map((r) => ({
      target: r.delivery_target ?? '(no target named)',
      outcome: r.delivered ?? '(not recorded)',
      n: undelivered.filter((x) => (x.delivery_target ?? '(no target named)') === (r.delivery_target ?? '(no target named)') && x.delivered === r.delivered).length,
    })),
    delivery_note:
      'Where the answer went, as recorded after it was sent. "No target" is a correct outcome — an ask arrived with nowhere to reply to — and is counted apart from a delivery that was attempted and refused. Any target that appears under a failure is named, because a quietly failing channel is invisible in the aggregate.',
    by_system: cohorts(all, (r) => r.asked_by_system, NO_SYSTEM, (r) => r.outcome === 'Answered', (r) => r.delivered === 'Delivered'),
    by_system_note:
      'Each caller with its own answered and delivery rates rather than the aggregate’s. This is the card that catches a quietly failing Slack path: the total is dominated by the scheduled sweep, which will keep it looking healthy while a human asking in Slack gets nothing back.',
    question_types: slices(all, (r) => r.question_type, NS_QUESTION_TYPES, '(no type set)'),
    question_type_note:
      'What people actually ask for, over the rows carrying a Question Type. A shift here is a shift in what North Star is being used for; a row with no type is counted on its own rather than filed under Other, which is a real category.',
    citation: {
      mean: withCoverage.length ? Math.round((withCoverage.reduce((n, r) => n + r.citation_coverage!, 0) / withCoverage.length) * 100) / 100 : null,
      n: withCoverage.length,
      of: all.length,
      buckets: coverageBuckets.map(([key, test]) => ({ key, label: key, n: withCoverage.filter((r) => test(r.citation_coverage!)).length })),
      note: withCoverage.length
        ? `The share of tool calls that produced a traceable citation, as the agent computed it — not a model-reported confidence. Over the ${withCoverage.length} of ${all.length} asks that recorded one; the rest are excluded rather than counted as nought.`
        : `No ask this month records a citation coverage figure, so there is nothing to average. It is the share of tool calls that produced a traceable citation, as the agent computes it.`,
    },
    tools: [...tools.entries()]
      .map(([tool, t]) => ({ tool, calls: t.calls, hits: t.hits, cited: t.cited, cited_rate: t.hits ? Math.round(((t.cited ?? 0) / t.hits) * 100) : null }))
      .sort((a, b) => b.calls - a.calls),
    tools_note:
      tools.size === 0
        ? 'No ask this month records a tool call in its evidence. A run that called nothing answered from what the agent already had.'
        : 'Parsed from each ask’s own Evidence Used: calls made, rows returned, and how many of those ended up cited. A tool with hits and no cited uses is being called and ignored. A call whose line records no counts shows its calls and leaves the other two blank rather than nought.',
    response_trend: weeks.map((w) => {
      const mine = all.filter((r) => weekOf(r.asked_at) === w && r.response_seconds !== null);
      const p = percentiles(mine.map((r) => r.response_seconds!), mine.length, () => '');
      return { week: w, label: weekLabel(w), p50: p.p50, p95: p.p95, n: mine.length };
    }),
    priority: {
      mix: slices(all, (r) => r.claimed_priority_tier, NS_PRIORITY_TIERS, '(none claimed)'),
      by_lane: lanes
        .map((lane) => {
          const mine = all.filter((r) => (r.lane ?? NO_LANE) === lane);
          const crit = [...criticalWeeks(lane)].sort();
          return {
            lane,
            asks: mine.length,
            critical_weeks: crit.length,
            last_critical: crit[crit.length - 1] ?? null,
            mix: slices(mine, (r) => r.claimed_priority_tier, NS_PRIORITY_TIERS, '(none claimed)'),
          };
        })
        .sort((a, b) => b.critical_weeks - a.critical_weeks || b.asks - a.asks),
      note:
        'The tier the answer itself claimed, by lane and by week. A lane called Critical three weeks running is the pattern this card exists to make visible — the tier is what North Star said, not a judgement this dashboard makes, and an ask that claimed none is counted as claiming none.',
    },
    architect: {
      n: all.filter((r) => r.architect_attention).length,
      of: all.length,
      lanes: architectLanes.sort((a, b) => b.n - a.n),
      note: all.filter((r) => r.architect_attention).length
        ? `Asks whose answer called for the Architect's attention, with the lane and the date of the most recent. It is a checkbox the answer sets, so an unticked box means the answer did not ask — never that somebody looked and decided it was not needed.`
        : `No ask this month asked for the Architect's attention. It is a checkbox the answer sets; an unticked box means the answer did not ask for it.`,
    },
    by_lane: cohorts(all, (r) => r.lane, NO_LANE, (r) => r.outcome === 'Answered', (r) => r.delivered === 'Delivered'),
    by_lane_note:
      'Asks by the lane they were about. Lane is often empty on this ledger and that is a fact about the routing rather than an error, so those asks are counted under "(no lane)" rather than dropped.',
    handoffs: handoffsOf(all, (await rtAsks()).filter((r) => inMonth(r.asked_at, month)), await rtJobs()),
  };

  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

/* -------------------------------------------------------- research twin */

export async function rtMetrics(month?: string | null): Promise<RtMetrics> {
  const key = `rt:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as RtMetrics;

  const all = (await rtAsks()).filter((r) => inMonth(r.asked_at, month));
  const weeks = lastWeeks(8);

  const external = all.filter((r) => r.used_web_search);
  const answered = all.filter((r) => r.outcome === 'Answered');
  const needsHuman = all.filter((r) => r.outcome === 'Needs human');
  const timed = all.filter((r) => r.response_seconds !== null);
  const withCoverage = all.filter((r) => r.citation_coverage !== null);
  const withSources = all.filter((r) => r.sources_count !== null);
  const noSources = withSources.filter((r) => r.sources_count === 0);
  const degraded = all.filter((r) => r.bharag_reachable === 'No (degraded)');

  const sourceBuckets: [string, (n: number) => boolean][] = [
    ['none', (n) => n === 0],
    ['1–2', (n) => n >= 1 && n <= 2],
    ['3–5', (n) => n >= 3 && n <= 5],
    ['6 or more', (n) => n >= 6],
  ];
  const coverageBuckets: [string, (c: number) => boolean][] = [
    ['nothing cited', (c) => c <= 0],
    ['partly cited', (c) => c > 0 && c < 1],
    ['fully cited', (c) => c >= 1],
  ];

  const byOutcome: { confidence: string; outcome: string; n: number }[] = [];
  for (const c of [...CONFIDENCE_STATED, NOT_STATED])
    for (const o of [...RT_OUTCOMES, NO_OUTCOME]) {
      const n = all.filter((r) => (r.confidence_stated ?? NOT_STATED) === c && (r.outcome ?? NO_OUTCOME) === o).length;
      if (n) byOutcome.push({ confidence: c, outcome: o, n });
    }

  const highNoSources = all.filter((r) => r.confidence_stated === 'High' && r.sources_count === 0).length;

  const value: RtMetrics = {
    kind: 'rt',
    computed_at: nowIso(),
    scope: { rows: all.length, month: month ?? null },
    external_rate: share(external.length, all.length, (n, of) =>
      of
        ? `${n} of ${of} asks went outside BHA. Research Twin's job is the outside world: Bays and North Star can both query BHARAG directly, so a low number here means it is being used as a lookup either of them could have done themselves. Read from the run's own checkbox, never from the answer text.`
        : 'No ask is held for this month, so there is nothing that could have gone outside.',
    ),
    answered_rate: share(answered.length, all.length, (n, of) =>
      of ? `${n} of ${of} asks came back Answered. Read beside "needs a human" below it: correctly escalating is a better outcome than a confident wrong answer.` : 'No ask is held for this month.',
    ),
    needs_human_rate: share(needsHuman.length, all.length, (n, of) =>
      of
        ? `${n} of ${of} asks were handed to a person. This is not coloured, because it is not bad news on its own — an escalation is Research Twin declining to guess, which is the behaviour that was asked of it. It is worth reading against the answered rate beside it.`
        : 'No ask is held for this month.',
    ),
    asks: all.length,
    response: percentiles(timed.map((r) => r.response_seconds!), all.length, (n, of) =>
      n
        ? `Seconds from request to answer, over the ${n} of ${of} asks that recorded a duration. p50 and p95, never a mean.`
        : of
          ? `None of this month's ${of} asks recorded a response time, so there is no figure — not a figure of nought.`
          : 'No ask is held for this month.',
    ),
    last_ask: lastAskOf(all, 'Research Twin'),
    asks_per_week: series(
      weeks.map((w) => ({ label: weekLabel(w), value: all.filter((r) => weekOf(r.asked_at) === w).length })),
      'Asks by the week they were asked, over the last eight weeks. The ledger opened on 17 Sep 2026, so weeks before it were not quiet — they were not recorded.',
    ),
    outcome_per_week: weeks.map((w) => {
      const mine = all.filter((r) => weekOf(r.asked_at) === w);
      return {
        week: w,
        label: weekLabel(w),
        total: mine.length,
        counts: Object.fromEntries([...RT_OUTCOMES, NO_OUTCOME].map((o) => [o, mine.filter((r) => (r.outcome ?? NO_OUTCOME) === o).length])),
      };
    }),
    outcome_mix: slices(all, (r) => r.outcome, RT_OUTCOMES, NO_OUTCOME),
    outcome_note:
      'Research Twin’s own five outcomes, with Needs human as a slice of its own rather than folded into a failure. Answered = an answer with at least one [S#] citation marker · Thin = an answer with no [S#] marker · Needs human = the answer says it needs a person (capped, flagged for a human) · Refused = a cited answer saying it belongs to North Star or Bays · Failed = no answer text. Set by the agent from its own answer text.',
    external_per_week: weeks.map((w) => {
      const mine = all.filter((r) => weekOf(r.asked_at) === w);
      return { week: w, label: weekLabel(w), used: mine.filter((r) => r.used_web_search).length, total: mine.length };
    }),
    external_note:
      'The share of each week’s asks that went outside BHA — the single most important trend on this page, because an internal-only Research Twin is a BHARAG lookup with extra steps. A week with no asks has no rate and is drawn as no bar, not as nought.',
    bharag: {
      mix: slices(all, (r) => r.bharag_reachable, RT_BHARAG, '(not recorded)'),
      degraded: degraded.length,
      of: all.length,
      note: `Whether the evidence store answered on each run, recorded per run and never inferred from a thin answer. A degraded evidence store is not the same as a lane having no evidence, which is why it is its own value rather than a missing source count. ${
        degraded.length ? `${degraded.length} of ${all.length} runs found it degraded, and any at all is worth acting on.` : 'Nothing this month found it degraded.'
      } "Not used" is a correct outcome: the ask did not need it.`,
    },
    sources: {
      buckets: sourceBuckets.map(([key, test]) => ({ key, label: key, n: withSources.filter((r) => test(r.sources_count!)).length })),
      none: noSources.length,
      of: withSources.length,
      mean: withSources.length ? Math.round((withSources.reduce((n, r) => n + r.sources_count!, 0) / withSources.length) * 10) / 10 : null,
      note: withSources.length
        ? `How many sources backed each answer, over the ${withSources.length} of ${all.length} asks that recorded a count. ${noSources.length} cited nothing at all. An ask with no recorded count is excluded rather than counted as nought — the two are different facts.`
        : `No ask this month records a source count, so there is nothing to distribute. It is how many sources backed the answer, as the run counted them.`,
    },
    citation: {
      mean: withCoverage.length ? Math.round((withCoverage.reduce((n, r) => n + r.citation_coverage!, 0) / withCoverage.length) * 100) / 100 : null,
      n: withCoverage.length,
      of: all.length,
      buckets: coverageBuckets.map(([key, test]) => ({ key, label: key, n: withCoverage.filter((r) => test(r.citation_coverage!)).length })),
      note: withCoverage.length
        ? `The share of tool calls that produced a traceable citation, as the agent computed it — not a model-reported confidence. The same definition North Star's card uses. Over the ${withCoverage.length} of ${all.length} asks that recorded one.`
        : 'No ask this month records a citation coverage figure. It is the share of tool calls that produced a traceable citation, as the agent computes it — not a model-reported confidence.',
    },
    confidence: {
      mix: slices(all, (r) => r.confidence_stated, CONFIDENCE_STATED, NOT_STATED),
      by_outcome: byOutcome,
      high_no_sources: highNoSources,
      note: highNoSources
        ? `The confidence the answer stated, cut against what it actually came back with. ${highNoSources} ${highNoSources === 1 ? 'ask is' : 'asks are'} High confidence with no sources at all, which is the combination worth catching: the agent is sure and cannot show why. "Not stated" is a real value in this select and is counted as itself.`
        : 'The confidence the answer stated, cut against its outcome. High confidence with zero sources is the combination worth catching — the agent sure of something it cannot show — and nothing this month is in it. "Not stated" is a real value in this select and is counted as itself.',
    },
    ask_types: slices(all, (r) => r.ask_type, RT_ASK_TYPES, '(no type set)'),
    ask_type_note:
      'What kind of work each request was. The base carries an External web search type the original spec for this page did not list, so it is here: a vocabulary this code invented would file real rows under a name the engine never writes.',
    by_system: cohorts(all, (r) => r.asked_by_system, NO_SYSTEM, (r) => r.outcome === 'Answered', (r) => r.delivered === 'Delivered' || r.delivered === 'Self-delivered', (r) => r.used_web_search),
    by_system_note:
      'Each caller with its own answered rate, external-search rate and delivery rate. The aggregate mixes the weekly clock with people asking in Slack, and a failure in either is invisible inside it. Self-delivered counts as delivered here, because it is.',
    delivery_mix: slices(all, (r) => r.delivered, RT_DELIVERED, '(not recorded)'),
    delivery_note:
      'Self-delivered is a correct outcome, not a failure: the weekly Watched Clients report posts its own file during the run, so there is nothing left for the tail to send. "No target" means the ask arrived with nowhere to reply to, which is also not a failure. Only "Not delivered" is one.',
    response_trend: weeks.map((w) => {
      const mine = all.filter((r) => weekOf(r.asked_at) === w && r.response_seconds !== null);
      const p = percentiles(mine.map((r) => r.response_seconds!), mine.length, () => '');
      return { week: w, label: weekLabel(w), p50: p.p50, p95: p.p95, n: mine.length };
    }),
    handoffs: handoffsOf((await nsAsks()).filter((r) => inMonth(r.asked_at, month)), all, await rtJobs()),
  };

  metricsCache.set(key, { version: storeVersion, value });
  return value;
}

/* --------------------------------------------------------- research jobs */

/**
 * The research queue, as jobs.
 *
 * **One row per job**, carrying its own status, attempts and outcome — which is
 * the semantic change from the queue this replaces. That one held a row per
 * *attempt*, with a second table for outcomes, so "attempts" and "cards" were
 * different counts of different things and every figure had to collapse on
 * `card_id` first. Nothing here does, and nothing here should: `Attempts` is a
 * number on the job.
 */
export async function rtJobMetrics(month?: string | null): Promise<RtJobMetrics> {
  const key = `rt_jobs:${month ?? '*'}`;
  const hit = metricsCache.get(key);
  if (hit && hit.version === storeVersion) return hit.value as RtJobMetrics;

  const everything = await rtJobs();
  const all = everything.filter((j) => inMonth(j.opened_at, month));
  const weeks = lastWeeks(8);

  const capped = all.filter((j) => j.capped);
  const pending = all.filter((j) => j.status === 'Pending');
  const inProgress = all.filter((j) => j.status === 'In Progress');
  const open = all.filter((j) => j.open);
  const resolved = all.filter((j) => j.status === JOB_RESOLVED);
  /**
   * Resolved *this month* is dated by `Resolved At`, not by `Opened At`, so it
   * counts jobs finished in the month rather than jobs opened in it. Everything
   * else on this page is scoped by when the job was opened, which is what the
   * month picker selects, and the two are deliberately different questions.
   */
  const resolvedThisMonth = everything.filter((j) => j.resolved_at && inMonth(j.resolved_at, month));
  const timed = all.filter((j) => j.days_to_resolve !== null);
  const oldest = [...open].sort((a, b) => (b.days_open ?? 0) - (a.days_open ?? 0))[0] ?? null;
  const terminal = all.filter((j) => j.status === JOB_RESOLVED || j.capped);

  const attemptKey = (n: number | null) => (n === null ? '(not recorded)' : n >= JOB_ATTEMPT_CAP ? `${JOB_ATTEMPT_CAP} (the cap)` : String(n));
  const attemptVocab = ['0', '1', '2', `${JOB_ATTEMPT_CAP} (the cap)`, '(not recorded)'];

  /** Gap types are set where research hit a wall, so they are counted there and the note says so. */
  const stuck = all.filter((j) => j.capped || j.confidence === 'Low');

  const value: RtJobMetrics = {
    kind: 'rt_jobs',
    computed_at: nowIso(),
    scope: { rows: all.length, month: month ?? null },
    capped: share(capped.length, all.length, (n, of) =>
      of
        ? `${n} of ${of} jobs reached three passes without a usable answer and are waiting on a person. Any number above nought needs attention: nothing else in the engine will move these. It is a real outcome the queue records, not a failure it is hiding.`
        : 'No job is held for this month, so nothing can be waiting on a person.',
    ),
    open: open.length,
    in_progress: inProgress.length,
    pending: pending.length,
    resolved_this_month: resolvedThisMonth.length,
    time_to_resolve: percentiles(timed.map((j) => j.days_to_resolve!), resolved.length, (n, of) =>
      n
        ? `Whole days from Opened At to Resolved At, over the ${n} of ${of} resolved jobs that carry both stamps. p50 with p95 beside it, never a mean. Open jobs are excluded — they have not finished, so they have no duration.`
        : of
          ? `${of} ${of === 1 ? 'job was' : 'jobs were'} resolved but none carries both stamps, so there is no figure. Open jobs are excluded either way.`
          : 'No job opened this month has been resolved yet.',
    ),
    oldest_open: {
      job_id: oldest?.job_id ?? null,
      days: oldest?.days_open ?? null,
      note: oldest
        ? `The oldest job still Pending or In Progress, counted from Opened At. Resolved and capped jobs are not open and are excluded.`
        : all.length
          ? 'No job opened this month is still open.'
          : 'No job is held for this month.',
    },
    status_mix: slices(all, (j) => j.status, JOB_STATUSES, '(no status set)'),
    status_note:
      'Where the queue actually stands. Pending and In Progress are open work; Resolved and Capped are the two terminal states. A job with no status at all is counted as itself rather than assumed to be pending — nothing here guesses at a blank.',
    attempts_mix: slices(all, (j) => attemptKey(j.attempts), attemptVocab, '(not recorded)'),
    attempts_note:
      'Passes made per job, against the cap of three. Three attempts without a usable answer caps the job and hands it to a person. That is a real outcome, not a failure to hide. A job with no recorded count is shown as not recorded rather than as nought passes.',
    gap_mix: slices(stuck, (j) => j.gap_type, JOB_GAP_TYPES, '(no gap type set)'),
    gap_note: stuck.length
      ? `Why research kept hitting a wall, over the ${stuck.length} of ${all.length} jobs that are capped or came back Low confidence. Jobs that resolved cleanly carry no gap type and are excluded rather than counted under a gap of their own.`
      : `No job this month is capped or came back Low confidence, so there is no wall to classify. This counts Gap Type over exactly those jobs.`,
    resolve_trend: weeks.map((w) => {
      const mine = everything.filter((j) => j.resolved_at && weekOf(j.resolved_at) === w && j.days_to_resolve !== null);
      const p = percentiles(mine.map((j) => j.days_to_resolve!), mine.length, () => '');
      return { week: w, label: weekLabel(w), p50: p.p50, p95: p.p95, n: mine.length };
    }),
    opened_by: slices(all, (j) => j.opened_by, JOB_OPENED_BY, '(not recorded)'),
    opened_by_note:
      'Which system generates the research load. The extractor opens jobs off commercial cards, Research Twin opens its own follow-ups, and a person opens one by hand — three quite different kinds of work in one queue.',
    resolution_rate: share(resolved.length, terminal.length, (n, of) =>
      of
        ? `${n} of ${of} jobs that reached a terminal state were resolved; the rest were capped. Open jobs are excluded, because a job still being worked is not yet either one and counting it as unresolved would make a busy week look like a failing one.`
        : all.length
          ? `None of this month's ${all.length} jobs has reached a terminal state yet, so there is no rate — not a rate of nought.`
          : 'No job is held for this month.',
    ),
  };

  metricsCache.set(key, { version: storeVersion, value });
  return value;
}
