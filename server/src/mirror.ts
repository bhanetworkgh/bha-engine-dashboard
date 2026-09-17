/**
 * The engine's own copy of every table this dashboard shows, and the only way
 * a row gets into one.
 *
 * Steps 1 and 2 of the Airtable → Postgres migration created these tables and
 * filled them (2026-09-13, Destiny); step 3, the same day, cut the pages over
 * to read them and removed the Airtable sync, the Airtable client and the
 * backfill that read it. So there is now exactly one way in:
 *
 *   /api/engine/*   n8n posts a record and calls upsert() per record
 *   the interface   a status change or an edit calls upsert() per record
 *
 * One function, so a row the engine writes and a row someone changes on a page
 * land identically and cannot drift into two shapes. store.ts reads these
 * tables directly; there is no second copy and nothing to resync.
 *
 * **Airtable's field names are kept exactly.** `fields` is the object Airtable
 * returns, stored verbatim: `What`, `Jason Status`, `Layer1 Review ` with its
 * trailing space. n8n writes those names, and a hand-written column list would
 * drop anything I forgot or anything added to a base later — silently, which
 * is the failure mode this engine has already hit three times. Columns are
 * promoted out of the blob only where something keys or filters on them, and
 * always derived from the payload, so they cannot disagree with it.
 */
import { nowIso } from './db';
import { query, withTransaction, type Queryable } from './pg';
import { CODEX_TABLES, LOOP_TABLES, type AtRecord } from './sources';

export class MirrorError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

/** engine_events. Not read before 2026-09-13; here for the delivery-health figure. */
export const DIGESTS = { base: 'appINvgEoZjuYQI2O', table: 'tblNuMju8l1kL3Sd1', label: 'digest_deliveries' };

export type MirrorKind =
  | 'loops'
  | 'codex'
  | 'layer0'
  | 'patterns'
  | 'commercial'
  | 'ns-asks'
  | 'rt-asks'
  | 'rt-jobs'
  | 'client_lanes'
  | 'client_questions'
  | 'client_requests'
  | 'digests';

interface KindSpec {
  table: string;
  label: string;
  /** The Airtable field that names the row, as Airtable spells it. */
  naturalField: string | null;
  /**
   * Whether a write may be matched on the natural id. False where the source
   * carries no id of its own — a client question and a client request both
   * have only Airtable's record id, so that is the only thing that can match.
   */
  keyOnNatural: boolean;
  /** Which builder table a row came from. The table IS the owner, never an assignee field. */
  perBuilder: boolean;
  /** Rows carry the per-lane table they were read from. */
  perLaneTable: boolean;
  /** Promoted columns beyond the common set, and how each is read off the payload. */
  promote: string[];
}

export const KINDS: Record<MirrorKind, KindSpec> = {
  loops: { table: 'engine_loops', label: 'Open Loops', naturalField: 'loop_id', keyOnNatural: true, perBuilder: true, perLaneTable: false, promote: [] },
  codex: { table: 'engine_codex_submissions', label: 'BHA Submissions & Logs', naturalField: 'Submission ID', keyOnNatural: true, perBuilder: true, perLaneTable: false, promote: [] },
  layer0: { table: 'engine_layer0_holds', label: 'Layer 0', naturalField: 'Submission ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
  patterns: { table: 'engine_build_patterns', label: 'Build Patterns', naturalField: 'pattern_id', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
  commercial: { table: 'engine_commercial_cards', label: 'Commercial Opportunities', naturalField: 'card_id', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  /**
   * The twins' own ask ledgers, and Research Twin's research queue (17 Sep
   * 2026). Every one of the three has a real unique id of its own — `Ask ID`,
   * `Job ID` — so all three key on the natural id as well as the record id.
   *
   * The queue this replaces did not: it was an attempt log whose `card_id`
   * repeated, so matching on it would have folded twenty attempts into one row.
   * A job is one row now and carries its own status, attempts and outcome.
   *
   * `lane_id` is promoted from the ledgers' `Lane` column, which is what these
   * bases call it — the old tables spelled it `lane_id`, and `prepare()` reads
   * both so neither spelling is assumed.
   */
  'ns-asks': { table: 'engine_ns_asks', label: 'North Star asks', naturalField: 'Ask ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  'rt-asks': { table: 'engine_rt_asks', label: 'Research Twin asks', naturalField: 'Ask ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  'rt-jobs': { table: 'engine_rt_jobs', label: 'Research jobs', naturalField: 'Job ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  client_lanes: { table: 'engine_client_lanes', label: 'Watched Clients index', naturalField: 'Lane ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
  client_questions: { table: 'engine_client_questions', label: 'Client questions', naturalField: null, keyOnNatural: false, perBuilder: false, perLaneTable: true, promote: ['lane_id'] },
  /**
   * One shared table, not one per lane, so `perLaneTable` is false and the
   * sweep compares Airtable record ids across the whole of it. There is no
   * natural id: `Created` is an autoNumber, which is Airtable's own counter and
   * not something the engine writes, so the record id is the key.
   */
  client_requests: { table: 'engine_client_requests', label: 'Client Requests', naturalField: null, keyOnNatural: false, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  digests: { table: 'engine_digest_deliveries', label: 'digest_deliveries', naturalField: 'session_id', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['builder_id', 'status', 'sent_at'] },
};

export const KIND_LIST = Object.keys(KINDS) as MirrorKind[];

export function isKind(v: string): v is MirrorKind {
  return Object.prototype.hasOwnProperty.call(KINDS, v);
}

const BUILDERS = new Set(LOOP_TABLES.map((t) => t.owner).concat(CODEX_TABLES.map((t) => t.owner)));
const LOOP_TABLE_IDS = new Map(LOOP_TABLES.map((t) => [t.table, t.owner]));
const CODEX_TABLE_IDS = new Map(CODEX_TABLES.map((t) => [t.table, t.owner]));

/* ------------------------------------------------------------- the write */

export interface MirrorInput {
  /** Airtable's record id. Absent when the engine writes a row Airtable does not have yet. */
  record_id?: string | null;
  /** Airtable's createdTime, when the caller has it. */
  created_time?: string | null;
  /**
   * The Airtable fields object, names exactly as Airtable spells them.
   * Typed loosely on purpose: this arrives as a parsed request body, and a
   * caller that sent the wrong shape should get prepare()'s message naming
   * what was wrong rather than a cast that pretends it was right.
   */
  fields?: unknown;
  /** Loops and Codex: whose table this row lives in. Either the builder or the table id. */
  builder_id?: string | null;
  table_id?: string | null;
  /** Client questions: which lane the table belongs to. */
  lane_id?: string | null;
}

export interface MirrorResult {
  kind: MirrorKind;
  id: number;
  airtable_record_id: string | null;
  natural_id: string | null;
  inserted: boolean;
  /** Whether the stored fields actually changed. A no-op re-send says so. */
  changed: boolean;
  matched_on: 'airtable_record_id' | 'natural_id' | 'insert';
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Airtable hands back a select as an object when read through some clients.
  if (typeof v === 'object' && v !== null && 'name' in v) return text((v as { name: unknown }).name);
  return null;
}

const REC = /^rec[A-Za-z0-9]{14}$/;
const TBL = /^tbl[A-Za-z0-9]{14}$/;

/**
 * Resolves which builder's table a loop or submission belongs to.
 *
 * The table a row sits in *is* its owner in this engine — never the assignee
 * field, which disagrees on real rows and produced a live mis-delivery on
 * 7 Sep. So this takes the table id or the builder name and never looks at
 * `Assignee Slack User ID`, even when one is sitting right there in `fields`.
 */
function resolveBuilder(kind: MirrorKind, input: MirrorInput): { builder_id: string; table_id: string | null } {
  const byTable = kind === 'loops' ? LOOP_TABLE_IDS : CODEX_TABLE_IDS;
  const table = text(input.table_id);
  if (table) {
    const owner = byTable.get(table);
    if (!owner) {
      throw new MirrorError(
        `"table_id": ${table} is not one of the ${kind === 'loops' ? 'Open Loops' : 'BHA Submissions & Logs'} builder tables. Send the table id the row lives in, or send "builder_id" instead.`,
      );
    }
    return { builder_id: owner, table_id: table };
  }
  const builder = text(input.builder_id)?.toLowerCase() ?? null;
  if (!builder) {
    throw new MirrorError(`"builder_id" is required for ${kind}: which builder's table this row lives in decides who owns it. Send "builder_id" (e.g. "destiny") or "table_id" (the tbl… id).`);
  }
  if (!BUILDERS.has(builder)) {
    throw new MirrorError(`"builder_id": "${builder}" is not a builder this engine knows. One of: ${[...BUILDERS].sort().join(', ')}.`);
  }
  const known = [...byTable.entries()].find(([, owner]) => owner === builder);
  if (!known) {
    throw new MirrorError(`"builder_id": "${builder}" has no ${kind === 'loops' ? 'Open Loops' : 'submissions'} table. ${kind === 'codex' ? 'Jason reviews logs, he does not submit them.' : ''}`.trim());
  }
  return { builder_id: builder, table_id: known[0] };
}

/** Validates the envelope and works out the columns to promote. */
function prepare(kind: MirrorKind, input: MirrorInput): {
  record_id: string | null;
  natural_id: string | null;
  created_time: string | null;
  fields: Record<string, unknown>;
  extra: Record<string, string | null>;
} {
  const spec = KINDS[kind];

  if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) {
    throw new MirrorError('"fields" is required and must be the Airtable fields object — { "fields": { "loop_id": "LOOP-…", … } }. Airtable nests the real values under .fields; sending the record\'s top level stores nothing.');
  }
  const fields = input.fields as Record<string, unknown>;

  const record_id = text(input.record_id);
  if (record_id && !REC.test(record_id)) {
    throw new MirrorError(`"record_id": "${record_id}" is not an Airtable record id (rec followed by 14 characters). Leave it out entirely if this row is not in Airtable yet.`);
  }

  const natural_id = spec.naturalField ? text(fields[spec.naturalField]) : null;
  if (!record_id && !natural_id) {
    throw new MirrorError(
      spec.naturalField
        ? `Nothing to match this row on: send "record_id" (the Airtable rec… id) or set "${spec.naturalField}" inside "fields".`
        : 'Nothing to match this row on: send "record_id" (the Airtable rec… id). This table has no natural id of its own.',
    );
  }
  if (!spec.keyOnNatural && !record_id) {
    throw new MirrorError(`"record_id" is required for ${kind}: a row of this kind carries no id of its own, so Airtable's record id is the only thing that identifies it.`);
  }

  const extra: Record<string, string | null> = {};
  if (spec.perBuilder) {
    const r = resolveBuilder(kind, input);
    extra.builder_id = r.builder_id;
    extra.table_id = r.table_id;
  }
  if (spec.perLaneTable) {
    const table = text(input.table_id);
    if (!table) throw new MirrorError('"table_id" is required for client_questions: which per-lane questions table this row lives in. The watched-clients index names it in its "Table ID" column.');
    if (!TBL.test(table)) throw new MirrorError(`"table_id": "${table}" is not an Airtable table id (tbl followed by 14 characters).`);
    extra.table_id = table;
  }
  for (const col of spec.promote) {
    // `Lane` on the twins' ledgers, `lane_id` everywhere else. Both are read
    // rather than one being assumed: a promoted column that silently comes back
    // null files every row under "(no lane)".
    if (col === 'lane_id') extra.lane_id = text(input.lane_id) ?? text(fields.lane_id) ?? text(fields.Lane);
    else if (col === 'builder_id') extra.builder_id = text(input.builder_id) ?? text(fields.builder_id);
    else if (col === 'status') extra.status = text(fields.status);
    else if (col === 'sent_at') extra.sent_at = text(fields.sent_at);
  }

  return { record_id, natural_id, created_time: text(input.created_time), fields, extra };
}

/**
 * One row in, idempotently.
 *
 * Matching order, and why: the Airtable record id first when we have one,
 * because it is the only identifier Airtable itself guarantees; then the
 * natural id, which is what matches a row the engine wrote here before
 * Airtable had it. That second case is also where the two paths meet — a row
 * the engine created by `loop_id` is *adopted* when the backfill later brings
 * the same loop with its rec id, rather than inserted a second time.
 *
 * Running this twice with the same payload changes nothing and reports
 * `changed: false`, which is what makes both the backfill and n8n's retries
 * safe to repeat.
 */
export async function upsert(kind: MirrorKind, input: MirrorInput, source: 'airtable' | 'engine' | 'ui', on?: Queryable): Promise<MirrorResult> {
  const spec = KINDS[kind];
  const p = prepare(kind, input);
  const at = nowIso();

  const run = async (db: Queryable): Promise<MirrorResult> => {
    type Row = { id: string; airtable_record_id: string | null; natural_id: string | null };

    let existing: Row | null = null;
    let matched: MirrorResult['matched_on'] = 'insert';

    if (p.record_id) {
      const r = await db.query<Row>(`SELECT id, airtable_record_id, natural_id FROM ${spec.table} WHERE airtable_record_id = $1`, [p.record_id]);
      if (r.rows[0]) {
        existing = r.rows[0];
        matched = 'airtable_record_id';
      }
    }
    if (!existing && spec.keyOnNatural && p.natural_id) {
      // Only rows Airtable has not claimed yet, so a natural id that happens to
      // repeat can never steal a row that is already bound to a record id.
      const r = await db.query<Row>(
        `SELECT id, airtable_record_id, natural_id FROM ${spec.table}
          WHERE natural_id = $1 AND (airtable_record_id IS NULL OR airtable_record_id = $2)
          ORDER BY airtable_record_id NULLS LAST, id LIMIT 2`,
        [p.natural_id, p.record_id],
      );
      if (r.rows.length > 1) {
        throw new MirrorError(
          `"${spec.naturalField}": "${p.natural_id}" matches more than one unclaimed row in ${spec.label}. Send "record_id" to say which one.`,
          409,
        );
      }
      if (r.rows[0]) {
        existing = r.rows[0];
        matched = 'natural_id';
      }
    }

    const cols = ['natural_id', 'created_time', 'fields', 'source', 'updated_at', ...Object.keys(p.extra)];
    const vals = [p.natural_id, p.created_time, JSON.stringify(p.fields), source, at, ...Object.values(p.extra)];

    if (existing) {
      // Two COALESCEs, both deliberate. A row adopted by its natural id keeps
      // the record id it already had unless this payload carries one, and
      // Airtable's createdTime is never overwritten with a null from a caller
      // that simply did not send it. Everything else is replaced outright.
      // The right-hand side is qualified with the target alias: `before` also
      // carries these columns, and an unqualified reference is ambiguous once
      // it is joined in.
      const sets = cols.map((c, i) => (c === 'created_time' ? `created_time = COALESCE($${i + 2}, t.created_time)` : `${c} = $${i + 2}`));
      sets.push(`airtable_record_id = COALESCE($${cols.length + 2}, t.airtable_record_id)`);
      /**
       * `changed` is decided by Postgres comparing the row before against the
       * row after, not by comparing JSON in this process.
       *
       * jsonb does not store key order and normalises numbers, so a round trip
       * through it reorders `{"What":…,"Status":…}` and `JSON.stringify` of the
       * two sides never matches — every re-run of the backfill reported every
       * row as changed, which is precisely the thing that has to be trustworthy
       * here. `IS DISTINCT FROM` on jsonb compares by value and gets it right.
       */
      const r = await db.query<{ id: string; airtable_record_id: string | null; natural_id: string | null; changed: boolean }>(
        `WITH before AS (SELECT id, fields, airtable_record_id FROM ${spec.table} WHERE id = $1)
         UPDATE ${spec.table} AS t SET ${sets.join(', ')}
           FROM before AS b
          WHERE t.id = b.id
         RETURNING t.id, t.airtable_record_id, t.natural_id,
                   (b.fields IS DISTINCT FROM t.fields
                    OR b.airtable_record_id IS DISTINCT FROM t.airtable_record_id) AS changed`,
        [existing.id, ...vals, p.record_id],
      );
      const row = r.rows[0];
      return { kind, id: Number(row.id), airtable_record_id: row.airtable_record_id, natural_id: row.natural_id, inserted: false, changed: row.changed, matched_on: matched };
    }

    const all = ['airtable_record_id', ...cols, 'first_seen_at'];
    const params = [p.record_id, ...vals, at];
    const placeholders = all.map((_, i) => `$${i + 1}`);
    // ON CONFLICT on the record id, so two writers racing the same new record
    // update rather than collide — and so the backfill is safe to re-run.
    const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const r = await db.query<{ id: string; airtable_record_id: string | null; natural_id: string | null }>(
      `INSERT INTO ${spec.table} (${all.join(', ')}) VALUES (${placeholders.join(', ')})
         ON CONFLICT (airtable_record_id) DO UPDATE SET ${updates}
         RETURNING id, airtable_record_id, natural_id`,
      params,
    );
    return { kind, id: Number(r.rows[0].id), airtable_record_id: r.rows[0].airtable_record_id, natural_id: r.rows[0].natural_id, inserted: true, changed: true, matched_on: 'insert' };
  };

  return on ? run(on) : withTransaction(run);
}

/** Turns an Airtable record into the shape upsert takes. `.fields`, never the top level. */
export function fromAirtable(rec: AtRecord, extra: Omit<MirrorInput, 'fields' | 'record_id' | 'created_time'> = {}): MirrorInput {
  return { record_id: rec.id, created_time: rec.createdTime, fields: rec.fields ?? {}, ...extra };
}

/* ---------------------------------------------------------- the write log */

export interface WriteLogEntry {
  endpoint: string;
  kind: string;
  method: string;
  /** Which key authenticated it — a label, never the key itself. */
  key_label: string | null;
  airtable_record_id?: string | null;
  natural_id?: string | null;
  outcome: 'inserted' | 'updated' | 'unchanged' | 'rejected' | 'unauthorised' | 'error';
  detail?: string | null;
  ms?: number;
}

/**
 * Records every write, accepted or refused.
 *
 * Never throws: a failure to write the log must not fail the write it is
 * describing. It is logged to stdout as well, so a row that never reached the
 * table is still visible in Render's logs.
 */
export async function logWrite(e: WriteLogEntry): Promise<void> {
  const line = `engine-write ${e.method} ${e.endpoint} kind=${e.kind} key=${e.key_label ?? 'none'} id=${e.airtable_record_id ?? e.natural_id ?? '-'} → ${e.outcome}${e.detail ? ` (${e.detail})` : ''}${e.ms !== undefined ? ` ${e.ms}ms` : ''}`;
  console.log(line);
  try {
    await query(
      `INSERT INTO engine_writes (at, endpoint, kind, method, key_label, airtable_record_id, natural_id, outcome, detail, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [nowIso(), e.endpoint, e.kind, e.method, e.key_label, e.airtable_record_id ?? null, e.natural_id ?? null, e.outcome, e.detail ?? null, e.ms ?? null],
    );
  } catch (err) {
    console.error(`engine-write log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------ the reads */

export interface HeldCount {
  kind: MirrorKind;
  label: string;
  table: string;
  rows: number;
  /**
   * Who wrote the row *last* — the migration backfill that read Airtable, the
   * engine posting to /api/engine, or someone changing it on a page. Not who
   * created it: a backfilled row the engine then updates counts as the
   * engine's, which is the signal wanted here.
   */
  from_airtable: number;
  from_engine: number;
  from_ui: number;
  latest: string | null;
}

/**
 * How many rows each mirror table holds, and which path put them there.
 *
 * This is the surface that says whether the engine is actually feeding a kind.
 * `from_airtable` is what the migration backfill left on 13 Sep 2026 and can
 * only shrink from here; a kind whose `from_engine` stays at zero is a kind
 * n8n is not writing yet, and its rows are frozen at that backfill.
 */
export async function held(): Promise<HeldCount[]> {
  const out: HeldCount[] = [];
  for (const kind of KIND_LIST) {
    const spec = KINDS[kind];
    const r = await query<{ rows: string; from_airtable: string; from_engine: string; from_ui: string; latest: string | null }>(
      `SELECT count(*) AS rows,
              count(*) FILTER (WHERE source = 'airtable') AS from_airtable,
              count(*) FILTER (WHERE source = 'engine')   AS from_engine,
              count(*) FILTER (WHERE source = 'ui')       AS from_ui,
              max(updated_at) AS latest
         FROM ${spec.table}`,
    );
    const row = r.rows[0];
    out.push({
      kind,
      label: spec.label,
      table: spec.table,
      rows: Number(row?.rows ?? 0),
      from_airtable: Number(row?.from_airtable ?? 0),
      from_engine: Number(row?.from_engine ?? 0),
      from_ui: Number(row?.from_ui ?? 0),
      latest: row?.latest ?? null,
    });
  }
  return out;
}

export interface WriteRow {
  seq: number;
  at: string;
  endpoint: string;
  kind: string;
  method: string;
  key_label: string | null;
  airtable_record_id: string | null;
  natural_id: string | null;
  outcome: string;
  detail: string | null;
  ms: number | null;
}

export interface WritesView {
  /** Every write ever recorded, and the window the tallies below cover. */
  total: number;
  window_hours: number;
  tally: Record<string, number>;
  recent: WriteRow[];
  first_at: string | null;
  last_at: string | null;
  held: HeldCount[];
  /** Whether the server can accept an engine write at all. */
  configured: boolean;
}

export async function writesView(limit = 50, windowHours = 24, configured = false): Promise<WritesView> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const [totals, tally, recent] = await Promise.all([
    query<{ total: string; first_at: string | null; last_at: string | null }>('SELECT count(*) AS total, min(at) AS first_at, max(at) AS last_at FROM engine_writes'),
    query<{ outcome: string; n: string }>('SELECT outcome, count(*) AS n FROM engine_writes WHERE at >= $1 GROUP BY outcome', [since]),
    query<WriteRow>('SELECT seq, at, endpoint, kind, method, key_label, airtable_record_id, natural_id, outcome, detail, ms FROM engine_writes ORDER BY seq DESC LIMIT $1', [Math.min(Math.max(limit, 1), 200)]),
  ]);
  return {
    total: Number(totals.rows[0]?.total ?? 0),
    window_hours: windowHours,
    tally: Object.fromEntries(tally.rows.map((r) => [r.outcome, Number(r.n)])),
    recent: recent.rows.map((r) => ({ ...r, seq: Number(r.seq), ms: r.ms === null ? null : Number(r.ms) })),
    first_at: totals.rows[0]?.first_at ?? null,
    last_at: totals.rows[0]?.last_at ?? null,
    held: await held(),
    configured,
  };
}

export interface DigestHealth {
  /**
   * Rows held at all. Zero is the difference between "no digest went missing"
   * and "nothing has ever been read into this table" — a zero and an unknown
   * must never look the same, so the page branches on this rather than on
   * `missing` alone.
   */
  rows: number;
  window_days: number;
  sent: number;
  delivered: number;
  missing: number;
  latest_sent_at: string | null;
}

/**
 * Digest delivery health: digests flagged `missing` in the last seven days.
 *
 * Counted on `sent_at` — the digest's own date — rather than `flagged_at`,
 * which is when the hourly check happened to notice. "Missing in the last
 * seven days" is a statement about the digests, not about the checker.
 *
 * This is the engine's only honest measure of whether builders actually
 * receive what it sends: every other signal in the stack reports that North
 * Star accepted the hand-off, which is four hops short of a builder reading it.
 */
export async function digestHealth(windowDays = 7): Promise<DigestHealth> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const r = await query<{ rows: string; sent: string; delivered: string; missing: string; latest: string | null }>(
    `SELECT count(*) AS rows,
            count(*) FILTER (WHERE sent_at >= $1) AS sent,
            count(*) FILTER (WHERE sent_at >= $1 AND status = 'delivered') AS delivered,
            count(*) FILTER (WHERE sent_at >= $1 AND status = 'missing')   AS missing,
            max(sent_at) AS latest
       FROM engine_digest_deliveries`,
    [since],
  );
  const row = r.rows[0];
  return {
    rows: Number(row?.rows ?? 0),
    window_days: windowDays,
    sent: Number(row?.sent ?? 0),
    delivered: Number(row?.delivered ?? 0),
    missing: Number(row?.missing ?? 0),
    latest_sent_at: row?.latest ?? null,
  };
}
