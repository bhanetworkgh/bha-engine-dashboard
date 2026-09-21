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
  | 'incidents'
  | 'error_counts'
  | 'retry_attempts'
  | 'pay_builders'
  | 'pay_sessions'
  | 'pay_statements'
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
  /**
   * Engine Health's three (2026-09-17).
   *
   * **`incidents` comes from BHARAG rather than Airtable**, so it is the one
   * kind with no `record_id` to send: the ledger's `entity_id` is the key, and
   * `keyOnNatural` is what makes that work. Everything else about the write is
   * identical — same envelope, same auth, same write log — because a second
   * way in is a second thing to keep honest.
   *
   * `lane` is promoted on incidents and retries because every figure on that
   * page groups by it, and it is spelled `source` on an incident and `lane` on
   * a retry row, so `prepare()` reads both rather than assuming one.
   */
  incidents: { table: 'engine_incidents', label: 'Incident ledger', naturalField: 'entity_id', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  error_counts: { table: 'engine_error_counts', label: 'error_counts', naturalField: 'signature', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
  retry_attempts: { table: 'engine_retry_attempts', label: 'retry_attempts', naturalField: 'incident_id', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: ['lane_id'] },
  /**
   * The pay ledger's three (2026-09-17). All three carry a real id of their
   * own, so all three key on it.
   *
   * n8n posts to `/api/engine/pay` with a `kind` of "session" or "statement"
   * rather than to a kind-named route — see index.ts, which reads that and
   * dispatches here. The kinds exist under their own names too, so the Engine
   * writes tab counts them like everything else.
   */
  pay_builders: { table: 'engine_pay_builders', label: 'Pay builders', naturalField: 'Slack User ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
  pay_sessions: { table: 'engine_pay_sessions', label: 'Pay sessions', naturalField: 'Codex Entry ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
  pay_statements: { table: 'engine_pay_statements', label: 'Monthly statements', naturalField: 'Statement ID', keyOnNatural: true, perBuilder: false, perLaneTable: false, promote: [] },
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
    // `lane_id` on the record kinds, `Lane` on the twins' ledgers, `source` on
    // an incident and `lane` on a retry row. All four are read rather than one
    // being assumed: a promoted column that silently comes back null files
    // every row under "(no lane)".
    if (col === 'lane_id') extra.lane_id = text(input.lane_id) ?? text(fields.lane_id) ?? text(fields.Lane) ?? text(fields.lane) ?? text(fields.source);
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
  /**
   * `read` is a lookup through GET /api/engine/:kind (2026-09-21). It is on
   * this log rather than on one of its own because it is the same surface with
   * the same key, and it is its own outcome rather than folded into the others
   * because a reader counting what the engine wrote must be able to leave the
   * reads out. Nothing on the page adds it to "writes accepted".
   */
  outcome: 'inserted' | 'updated' | 'unchanged' | 'rejected' | 'unauthorised' | 'error' | 'read';
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

/* ------------------------------------------------- the lookup and the patch */

/**
 * n8n's read and partial-write surface (2026-09-21, Destiny).
 *
 * BHA's Airtable workspace hit its monthly API cap on 20 Sep and every n8n
 * workflow that touches Airtable is failing, so Airtable is being cut out of
 * the engine: every Airtable node becomes an HTTPS call to this dashboard, and
 * these tables become the only record. n8n could already write a whole record
 * here through POST /api/engine/:kind. It could not **read** one back, and it
 * could not change **part** of one — an Airtable node does both routinely, so
 * without them the cut could not be made.
 *
 * n8n never connects to Postgres. bha-engine-db stays closed to everything
 * outside its own Render environment, exactly as render.yaml intends; these
 * two functions are the whole of what reaches it from outside, behind the same
 * service key every other engine route uses.
 */

/**
 * Which columns a kind's table actually has, read from the database rather
 * than derived from KindSpec.
 *
 * Deriving them looked obvious and is wrong on a live table: `engine_client_requests`
 * carries `table_id` although its spec sets `perLaneTable: false`, so a guess
 * from the flags would have refused a filter the column supports. Two of the
 * three faults found through this server on 20 Sep were a name assumed rather
 * than read, so this reads.
 *
 * Cached for the life of the process: the schema only changes in a migration,
 * and migrations run once at boot before anything serves.
 */
const COLUMNS = new Map<MirrorKind, Set<string>>();

async function columnsOf(kind: MirrorKind): Promise<Set<string>> {
  const held = COLUMNS.get(kind);
  if (held) return held;
  const r = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [KINDS[kind].table],
  );
  const set = new Set(r.rows.map((x) => x.column_name));
  COLUMNS.set(kind, set);
  return set;
}

/** The columns a lookup may filter on, in the order the refusal lists them. */
export const LOOKUP_FILTER_COLUMNS = ['id', 'airtable_record_id', 'natural_id', 'builder_id', 'table_id'] as const;
export type FilterColumn = (typeof LOOKUP_FILTER_COLUMNS)[number];

export interface LookupQuery {
  /** Column filters. Only the ones the caller sent, all ANDed. */
  columns: Partial<Record<FilterColumn, string>>;
  /** `f.<Field Name>=<value>` — exact match inside the jsonb blob, ANDed. */
  fields: { key: string; value: string }[];
  limit: number;
  order: 'created_asc' | 'created_desc';
}

export interface LookupRow {
  id: number;
  airtable_record_id: string | null;
  natural_id: string | null;
  builder_id: string | null;
  table_id: string | null;
  created_time: string | null;
  fields: Record<string, unknown>;
  source: string;
  updated_at: string;
}

export interface LookupResult {
  kind: MirrorKind;
  /** Every row that matched, not the page. A caller paging needs to know there is more. */
  count: number;
  rows: LookupRow[];
}

export const LOOKUP_LIMIT_DEFAULT = 100;
export const LOOKUP_LIMIT_MAX = 1000;

/**
 * Reads rows back out of a mirror table.
 *
 * **Every value is a bound parameter, the field names included.** A field name
 * arrives from the query string — `f.Jason Status`, `f.Layer1 Review ` with its
 * trailing space — and goes into the statement as `$n` on the right of `->>`,
 * never concatenated into the SQL. The only things this function interpolates
 * are the table and column names, and both come from KINDS and from the
 * database's own information_schema, so neither can carry anything a caller
 * sent.
 *
 * `count` is the total that matched, computed with a window function in the
 * same statement. Two statements could disagree with each other across a
 * concurrent write; one cannot, and a `count(*) OVER ()` is evaluated before
 * the LIMIT, which is exactly what is wanted here.
 *
 * Ordering is `created_time` with `NULLS LAST` on both directions and the row
 * id as the tiebreak. Nulls last either way on purpose: a row Airtable never
 * gave a createdTime to is not the oldest row, it is an undated one, and
 * leading a page with it would read as a date.
 */
export async function lookup(kind: MirrorKind, q: LookupQuery): Promise<LookupResult> {
  const spec = KINDS[kind];
  const cols = await columnsOf(kind);

  const where: string[] = [];
  const params: unknown[] = [];

  for (const col of LOOKUP_FILTER_COLUMNS) {
    const v = q.columns[col];
    if (v === undefined) continue;
    if (!cols.has(col)) {
      throw new MirrorError(
        `"${col}" is not a column ${spec.label} holds, so it cannot be filtered on. ${kind} can be filtered on: ${LOOKUP_FILTER_COLUMNS.filter((c) => cols.has(c)).join(', ')}, and on any field inside "fields" as f.<Field Name>.`,
        400,
      );
    }
    if (col === 'id') {
      if (!/^\d+$/.test(v)) throw new MirrorError(`"id": "${v}" is not a row id. It is this table's own bigint id — send "airtable_record_id" or "natural_id" to look a row up by an id the engine knows.`, 400);
      params.push(v);
      where.push(`id = $${params.length}::bigint`);
    } else {
      params.push(v);
      where.push(`${col} = $${params.length}`);
    }
  }

  for (const f of q.fields) {
    params.push(f.key);
    const k = `$${params.length}::text`;
    params.push(f.value);
    // `->>` on a text key, so the comparison is against the field's text form:
    // a number 3 matches "3" and a checkbox matches "true", which is how
    // Airtable's own values arrive through n8n.
    where.push(`fields ->> ${k} = $${params.length}`);
  }

  const direction = q.order === 'created_asc' ? 'ASC' : 'DESC';
  params.push(Math.min(Math.max(Math.trunc(q.limit), 1), LOOKUP_LIMIT_MAX));
  const limit = `$${params.length}`;

  const select = [
    'id',
    'airtable_record_id',
    'natural_id',
    cols.has('builder_id') ? 'builder_id' : 'NULL::text AS builder_id',
    cols.has('table_id') ? 'table_id' : 'NULL::text AS table_id',
    'created_time',
    'fields',
    'source',
    'updated_at',
    'count(*) OVER () AS total',
  ].join(', ');

  const r = await query<LookupRow & { id: string; total: string }>(
    `SELECT ${select} FROM ${spec.table}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_time ${direction} NULLS LAST, id ${direction}
      LIMIT ${limit}`,
    params,
  );

  return {
    kind,
    count: Number(r.rows[0]?.total ?? 0),
    rows: r.rows.map((row) => ({
      id: Number(row.id),
      airtable_record_id: row.airtable_record_id,
      natural_id: row.natural_id,
      builder_id: row.builder_id,
      table_id: row.table_id,
      created_time: row.created_time,
      fields: row.fields,
      source: row.source,
      updated_at: row.updated_at,
    })),
  };
}

export interface PatchResult extends LookupRow {
  kind: MirrorKind;
  /** Decided by Postgres comparing the row before against the row after, same as the upsert. */
  changed: boolean;
}

/**
 * Changes some of the keys inside one row's `fields`, and nothing else.
 *
 * The merge is `fields || $patch`, so **a key that is not sent is untouched**.
 * That is the whole point of the route: an Airtable node that sets one field
 * leaves the other twenty-two alone, and a full POST that replaced the blob
 * with the two keys the caller happened to know about would drop the rest —
 * the same rule section 4 of CLAUDE.md already states for an interface edit.
 *
 * **A key sent as `null` is removed**, which is the one thing `||` cannot do on
 * its own: it would store a JSON null and the field would read as present and
 * empty. The null keys are stripped out of the patch object and applied as
 * `- $keys::text[]` instead, so removing and setting in one body both work and
 * neither is a string concatenation.
 *
 * **Promoted columns are re-derived from the merged fields**, exactly as
 * `prepare()` derives them on a POST, so they cannot drift from the blob they
 * are a copy of. `builder_id` and `table_id` on loops and Codex entries are
 * deliberately not among them: those are not fields, they are which of the
 * seven tables the row sits in, and changing one is a move rather than an edit.
 */
export async function patchFields(kind: MirrorKind, id: string, patch: Record<string, unknown>, source: 'engine' | 'ui' = 'engine'): Promise<PatchResult> {
  const spec = KINDS[kind];
  const cols = await columnsOf(kind);
  if (!/^\d+$/.test(id)) throw new MirrorError(`"${id}" is not a row id. The id in the path is this table's own bigint id, as GET /api/engine/${kind} returns it.`, 400);

  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) drop.push(k);
    else set[k] = v;
  }
  if (!Object.keys(set).length && !drop.length) {
    throw new MirrorError('"fields" was empty, so there is nothing to change. Send the keys to set, and null for a key to remove.', 422);
  }

  return withTransaction(async (db) => {
    const before = await db.query<{ id: string }>(`SELECT id FROM ${spec.table} WHERE id = $1::bigint FOR UPDATE`, [id]);
    if (!before.rows[0]) {
      throw new MirrorError(`No ${spec.label} row has id ${id}. GET /api/engine/${kind} to find it — the id in the path is this table's own id, not the Airtable record id.`, 404);
    }

    /**
     * The merge, and the removals, in one expression. Both operands are bound.
     *
     * **Qualified with the target alias.** `b` carries a `fields` column too,
     * and an unqualified reference inside the SET is ambiguous once the CTE is
     * joined in — Postgres refuses the whole statement with
     * `column reference "fields" is ambiguous`, which is exactly what the
     * first run of this against a real row did. The upsert above already
     * carries the same note about its own two COALESCEs.
     */
    const merged = `((t.fields || $2::jsonb) - $3::text[])`;
    const at = nowIso();

    /**
     * Two statements rather than one, and deliberately: the promoted columns
     * are derived from the *merged* fields, which do not exist until the merge
     * has run. Inside one transaction, so nothing else sees the row between
     * them, and `changed` is still decided by Postgres on the fields alone.
     */
    const r = await db.query<{ id: string; fields: Record<string, unknown>; changed: boolean }>(
      `WITH b AS (SELECT id, fields FROM ${spec.table} WHERE id = $1::bigint)
       UPDATE ${spec.table} AS t
          SET fields = ${merged}, source = $4, updated_at = $5
         FROM b
        WHERE t.id = b.id
       RETURNING t.id, t.fields, (b.fields IS DISTINCT FROM t.fields) AS changed`,
      [id, JSON.stringify(set), drop, source, at],
    );
    const row = r.rows[0];

    // Re-derived from the merged blob, never from the patch: a patch that did
    // not mention the natural field must still leave natural_id agreeing with
    // whatever the blob now says.
    const promoted: Record<string, string | null> = {};
    if (spec.naturalField) promoted.natural_id = text(row.fields[spec.naturalField]);
    for (const col of spec.promote) {
      if (col === 'lane_id') promoted.lane_id = text(row.fields.lane_id) ?? text(row.fields.Lane) ?? text(row.fields.lane) ?? text(row.fields.source);
      else if (col === 'builder_id') promoted.builder_id = text(row.fields.builder_id);
      else if (col === 'status') promoted.status = text(row.fields.status);
      else if (col === 'sent_at') promoted.sent_at = text(row.fields.sent_at);
    }
    const promotable = Object.entries(promoted).filter(([c]) => cols.has(c));
    if (promotable.length) {
      await db.query(
        `UPDATE ${spec.table} SET ${promotable.map(([c], i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1::bigint`,
        [id, ...promotable.map(([, v]) => v)],
      );
    }

    const out = await db.query<LookupRow & { id: string }>(
      `SELECT id, airtable_record_id, natural_id,
              ${cols.has('builder_id') ? 'builder_id' : 'NULL::text AS builder_id'},
              ${cols.has('table_id') ? 'table_id' : 'NULL::text AS table_id'},
              created_time, fields, source, updated_at
         FROM ${spec.table} WHERE id = $1::bigint`,
      [id],
    );
    const f = out.rows[0];
    return {
      kind,
      id: Number(f.id),
      airtable_record_id: f.airtable_record_id,
      natural_id: f.natural_id,
      builder_id: f.builder_id,
      table_id: f.table_id,
      created_time: f.created_time,
      fields: f.fields,
      source: f.source,
      updated_at: f.updated_at,
      changed: row.changed,
    };
  });
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
