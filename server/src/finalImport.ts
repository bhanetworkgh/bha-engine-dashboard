/**
 * The last read of Airtable, and the one that must not lose anything
 * (decision 2026-09-22, Destiny).
 *
 * The engine is being cut over from Airtable to this dashboard's Postgres —
 * North Star's four workflows are already through, Bays is next, and by the
 * time Airtable's monthly cap resets these tables will hold changes Airtable
 * has never seen. But Airtable will also hold changes *this* database has never
 * seen: anything somebody typed into a base by hand between the cap hitting at
 * about 23:00 UTC on 20 Sep and the cutover finishing.
 *
 * Both sets are real and neither may be dropped, which is exactly what the
 * existing resync would do to one of them. A resync is deliberately
 * Airtable-wins — "Airtable is the source of truth for every field it owns and
 * this dashboard does not win a disagreement", section 4 — so running one after
 * the cutover would take a loop Bays closed here and reopen it, silently,
 * because the Airtable row still says Open.
 *
 * So this is a different pass with a different rule, and it is deliberately
 * **not** a flag on the resync: one function that sometimes lets Airtable win
 * and sometimes does not is one nobody can reason about at the moment they are
 * about to run it.
 *
 *   the row is not here                       -> insert it
 *   nothing has written it here since the      -> update it, exactly as a
 *     cutover, or the last write was a resync      resync would
 *   the engine or a page has written it here   -> KEEP what is here, and say so
 *     since the cutover                            with both values
 *
 * **Nothing is ever deleted.** A resync removes rows Airtable no longer has,
 * which is right while Airtable is the record and catastrophic afterwards:
 * every row the engine has created here since the cutover has no Airtable copy
 * at all, so a delete pass would remove precisely the new work. There is no
 * delete in this file.
 */
import * as airtable from './airtable';
import * as mirror from './mirror';
import { nowIso } from './db';
import { query } from './pg';
import {
  CLIENTS_INDEX,
  CLIENT_REQUESTS,
  CODEX_LAYER0,
  CODEX_TABLES,
  COMMERCIAL,
  ERROR_COUNTS,
  LOOP_TABLES,
  NORTH_STAR,
  PATTERNS,
  PAY_BUILDERS,
  PAY_SESSIONS,
  PAY_STATEMENTS,
  RESEARCH_JOBS,
  RESEARCH_TWIN,
  RETRY_ATTEMPTS,
  BUILDER_PROFILES,
  CHANNEL_TRACKING,
  DEEP_THINK_LOG,
  LANE_BACKLOG,
  PATTERN_CANDIDATES,
  REVIEW_RETURNS,
  mapClientLane,
  type AtRecord,
} from './sources';

/**
 * When the cutover began: 00:00 UTC on 21 Sep 2026, the morning after the cap
 * hit and the day the read and part-update routes shipped.
 *
 * A row this database has not been written to since then cannot be carrying a
 * decision made here, so Airtable's copy is safe to take. It is a constant
 * rather than a parameter on purpose — a caller that could move the line could
 * move it past a real change, and the whole value of this pass is that it
 * cannot silently overwrite one.
 */
export const CUTOVER_AT = '2026-09-21T00:00:00.000Z';

/** The groups, named after the resync buttons they correspond to. */
export const IMPORT_GROUPS = ['loops', 'codex', 'patterns', 'commercial', 'clients', 'ns', 'rt', 'pay', 'engine_events', 'builders', 'bays'] as const;
export type ImportGroup = (typeof IMPORT_GROUPS)[number];

export function isImportGroup(v: string): v is ImportGroup {
  return (IMPORT_GROUPS as readonly string[]).includes(v);
}

/**
 * Every Airtable-backed kind and nothing else.
 *
 * **`incidents` is deliberately absent.** It comes from BHARAG rather than
 * Airtable, so there is no Airtable copy to import and nothing for this pass to
 * do; the Engine health group covers only that page's two Airtable tables.
 * Saying so here, rather than letting it fall through as an unknown group, is
 * the difference between "not applicable" and "forgotten".
 */
interface ImportSource {
  base: string;
  table: string;
  label: string;
  kind: mirror.MirrorKind;
  /** Client questions: the lane the table belongs to, learned from the index. */
  lane_id?: string | null;
  /**
   * Key the imported rows on Airtable's record id (2026-09-23).
   *
   * For a kind whose table has no id column this dashboard can name — Review
   * Returns, Deep Think Log — that is the only stable thing an imported row
   * carries, so it goes into `natural_id` as well as `airtable_record_id`.
   * Without it those rows would come across with a null key and a second
   * import would be unable to match them.
   *
   * Only legal where `naturalField` is null, which is the same rule `prepare()`
   * enforces on the envelope.
   */
  naturalFromRecordId?: boolean;
}

function sourcesFor(group: ImportGroup): ImportSource[] {
  switch (group) {
    case 'loops':
      // The base comes from AIRTABLE_OPEN_LOOPS_BASE_ID and never from a
      // default, the same rule every other loop read follows.
      return LOOP_TABLES.map((t) => ({ base: airtable.loopsBase(), table: t.table, label: `${t.label} loops`, kind: 'loops' as const }));
    case 'codex':
      return [
        ...CODEX_TABLES.map((t) => ({ base: airtable.SUBMISSIONS_BASE_ID, table: t.table, label: t.label, kind: 'codex' as const })),
        { base: airtable.SUBMISSIONS_BASE_ID, table: CODEX_LAYER0.table, label: CODEX_LAYER0.label, kind: 'layer0' as const },
      ];
    case 'patterns':
      return [
        { base: PATTERNS.base, table: PATTERNS.table, label: PATTERNS.label, kind: 'patterns' },
        { base: PATTERN_CANDIDATES.base, table: PATTERN_CANDIDATES.table, label: PATTERN_CANDIDATES.label, kind: 'pattern_candidates', naturalFromRecordId: true },
      ];
    case 'builders':
      return [{ base: BUILDER_PROFILES.base, table: BUILDER_PROFILES.table, label: BUILDER_PROFILES.label, kind: 'builder_profiles' }];
    /**
     * The four Bays tables (2026-09-23). They are engine-only from here on —
     * nothing resyncs them and n8n writes them directly — but every one holds
     * real history in Airtable that has to come across once, which is exactly
     * what this pass is for and why they are in it without being on a resync
     * button.
     *
     * **`channel_tracking` is the one that matters.** It maps each Slack
     * channel to the capture doc it is currently writing into, and
     * `Bays — Message Capture` reads it on every message. Cut over against an
     * empty table it would start every channel from nothing and lose the
     * mapping; this is what makes it start from the existing one.
     */
    case 'bays':
      return [
        { base: CHANNEL_TRACKING.base, table: CHANNEL_TRACKING.table, label: CHANNEL_TRACKING.label, kind: 'channel_tracking' },
        { base: REVIEW_RETURNS.base, table: REVIEW_RETURNS.table, label: REVIEW_RETURNS.label, kind: 'review_returns', naturalFromRecordId: true },
        { base: LANE_BACKLOG.base, table: LANE_BACKLOG.table, label: LANE_BACKLOG.label, kind: 'lane_backlog' },
        { base: DEEP_THINK_LOG.base, table: DEEP_THINK_LOG.table, label: DEEP_THINK_LOG.label, kind: 'deep_think_log', naturalFromRecordId: true },
      ];
    case 'commercial':
      return [{ base: COMMERCIAL.base, table: COMMERCIAL.table, label: COMMERCIAL.label, kind: 'commercial' }];
    case 'ns':
      return [{ base: NORTH_STAR.base, table: NORTH_STAR.table, label: NORTH_STAR.label, kind: 'ns-asks' }];
    case 'rt':
      return [
        { base: RESEARCH_TWIN.base, table: RESEARCH_TWIN.table, label: RESEARCH_TWIN.label, kind: 'rt-asks' },
        { base: RESEARCH_JOBS.base, table: RESEARCH_JOBS.table, label: RESEARCH_JOBS.label, kind: 'rt-jobs' },
      ];
    case 'pay':
      return [
        { base: PAY_BUILDERS.base, table: PAY_BUILDERS.table, label: PAY_BUILDERS.label, kind: 'pay_builders' },
        { base: PAY_SESSIONS.base, table: PAY_SESSIONS.table, label: PAY_SESSIONS.label, kind: 'pay_sessions' },
        { base: PAY_STATEMENTS.base, table: PAY_STATEMENTS.table, label: PAY_STATEMENTS.label, kind: 'pay_statements' },
      ];
    case 'engine_events':
      return [
        { base: ERROR_COUNTS.base, table: ERROR_COUNTS.table, label: ERROR_COUNTS.label, kind: 'error_counts' },
        { base: RETRY_ATTEMPTS.base, table: RETRY_ATTEMPTS.table, label: RETRY_ATTEMPTS.label, kind: 'retry_attempts' },
      ];
    case 'clients':
      // The index and the shared requests table up front; each lane's questions
      // table is appended as the index names it, exactly as the resync does.
      return [
        { base: CLIENTS_INDEX.base, table: CLIENTS_INDEX.table, label: CLIENTS_INDEX.label, kind: 'client_lanes' },
        { base: CLIENT_REQUESTS.base, table: CLIENT_REQUESTS.table, label: CLIENT_REQUESTS.label, kind: 'client_requests' },
      ];
  }
}

/* --------------------------------------------------------------- the shapes */

export interface KeptRow {
  kind: mirror.MirrorKind;
  table: string;
  label: string;
  record_id: string;
  natural_id: string | null;
  /**
   * The field the two sides disagree about. `Status` wherever it is one of
   * them, because that is the disagreement somebody is actually worried about;
   * otherwise the first differing key, in name order so two runs name the same
   * one.
   */
  field: string | null;
  here: string | null;
  airtable: string | null;
  /** How many keys differ in total, so "one field" and "the whole row" read differently. */
  differing: number;
  /** Who wrote the row here, and when — the evidence for keeping it. */
  source: string;
  updated_at: string;
}

export interface ImportTable {
  table: string;
  label: string;
  kind: mirror.MirrorKind;
  read: boolean;
  reason: string | null;
  rows: number | null;
  inserted: number;
  updated: number;
  unchanged: number;
  kept_newer_here: number;
  refused: number;
}

export interface FinalImport {
  group: ImportGroup;
  ran: boolean;
  at: string;
  ms: number;
  cutover_at: string;
  tables: ImportTable[];
  inserted: number;
  updated: number;
  unchanged: number;
  kept_newer_here: number;
  refused: number;
  kept: KeptRow[];
  note: string;
}

/* ---------------------------------------------------------------- the pass */

const READ_TIMEOUT_MS = 20_000;
const BUDGET_MS = 120_000;

/** The text form of a stored value, for the comparison a person reads. */
function shown(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * What the two copies disagree about.
 *
 * `Status` first where it is among them: on a loop or a statement it is the
 * field the decision is about, and a report that led with `last_modified`
 * would bury it. Otherwise the first differing key in name order, so the same
 * row reports the same field on every run.
 */
function firstDifference(here: Record<string, unknown>, there: Record<string, unknown>): { field: string | null; here: string | null; airtable: string | null; differing: number } {
  const keys = [...new Set([...Object.keys(here), ...Object.keys(there)])].sort();
  const differing = keys.filter((k) => JSON.stringify(here[k] ?? null) !== JSON.stringify(there[k] ?? null));
  const field = differing.includes('Status') ? 'Status' : (differing[0] ?? null);
  return {
    field,
    here: field === null ? null : shown(here[field]),
    airtable: field === null ? null : shown(there[field]),
    differing: differing.length,
  };
}

interface HeldRow {
  id: string;
  airtable_record_id: string | null;
  natural_id: string | null;
  fields: Record<string, unknown>;
  source: string;
  updated_at: string;
}

/**
 * The row this record would land on, found the way `mirror.upsert` finds it:
 * the Airtable record id first, then the natural id among rows Airtable has not
 * claimed. Matching any other way would decide about one row and then write to
 * a different one.
 */
async function held(kind: mirror.MirrorKind, rec: AtRecord, naturalFromRecordId = false): Promise<HeldRow | null> {
  const spec = mirror.KINDS[kind];
  const byRecord = await query<HeldRow>(`SELECT id, airtable_record_id, natural_id, fields, source, updated_at FROM ${spec.table} WHERE airtable_record_id = $1`, [rec.id]);
  if (byRecord.rows[0]) return byRecord.rows[0];
  if (!spec.keyOnNatural) return null;
  /**
   * The key this row would land on: the kind's own field, or Airtable's record
   * id where the table has no id column. It has to be worked out the same way
   * the write below works it out, or the decision would be made about one row
   * and written to another.
   */
  const natural = spec.naturalField ? rec.fields?.[spec.naturalField] : naturalFromRecordId ? rec.id : null;
  if (typeof natural !== 'string' || !natural.trim()) return null;
  const byNatural = await query<HeldRow>(
    `SELECT id, airtable_record_id, natural_id, fields, source, updated_at FROM ${spec.table}
      WHERE natural_id = $1 AND airtable_record_id IS NULL ORDER BY id LIMIT 1`,
    [natural.trim()],
  );
  return byNatural.rows[0] ?? null;
}

/**
 * One group, imported.
 *
 * Runs on a button and is safe to run twice: a row it kept stays kept, and a
 * row it took stays taken, because the decision is made afresh from the row's
 * own `source` and `updated_at` every time.
 */
export async function finalImport(group: ImportGroup, actor = 'dashboard'): Promise<FinalImport> {
  const at = nowIso();
  if (!airtable.airtableConfigured()) {
    return {
      group, ran: false, at, ms: 0, cutover_at: CUTOVER_AT, tables: [],
      inserted: 0, updated: 0, unchanged: 0, kept_newer_here: 0, refused: 0, kept: [],
      note: 'AIRTABLE_TOKEN is not set on this server, so nothing was read and nothing was changed.',
    };
  }

  const started = Date.now();
  const tables: ImportTable[] = [];
  const kept: KeptRow[] = [];
  const queue = sourcesFor(group);

  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    const row = (read: boolean, reason: string | null, rows: number | null, counts: Partial<ImportTable> = {}): ImportTable => ({
      table: source.table, label: source.label, kind: source.kind, read, reason, rows,
      inserted: 0, updated: 0, unchanged: 0, kept_newer_here: 0, refused: 0, ...counts,
    });

    if (Date.now() - started > BUDGET_MS) {
      tables.push(row(false, 'not reached inside the time this is given', null));
      continue;
    }

    let records: AtRecord[];
    try {
      records = await airtable.listRecords(source.base, source.table, READ_TIMEOUT_MS);
    } catch (e) {
      const reason = e instanceof airtable.AirtableError ? e.message : e instanceof Error ? e.message : String(e);
      console.error(`final import: ${source.label} (${source.table}) could not be read — ${reason}`);
      tables.push(row(false, reason, null));
      continue;
    }

    // The index names each lane's own questions table, the same as the resync.
    if (source.kind === 'client_lanes') {
      for (const rec of records) {
        const lane = mapClientLane(rec);
        if (!lane.questions_table) continue;
        queue.push({ base: CLIENTS_INDEX.base, table: lane.questions_table, label: lane.name, kind: 'client_questions', lane_id: lane.lane_id ?? lane.id });
      }
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let keptHere = 0;
    let refused = 0;

    for (const rec of records) {
      try {
        const mine = await held(source.kind, rec, source.naturalFromRecordId === true);

        /**
         * The whole decision, in one condition.
         *
         * `source` is who wrote the row last and `updated_at` is when. A row
         * whose last write was a resync is Airtable's own copy however recent
         * it is, so taking Airtable's copy again changes nothing anybody
         * decided. A row untouched since the cutover cannot be carrying a
         * decision made here. Anything else is this dashboard's and is kept.
         */
        if (mine && mine.source !== 'airtable' && mine.updated_at >= CUTOVER_AT) {
          const diff = firstDifference(mine.fields ?? {}, rec.fields ?? {});
          keptHere++;
          kept.push({
            kind: source.kind,
            table: source.table,
            label: source.label,
            record_id: rec.id,
            natural_id: mine.natural_id,
            ...diff,
            source: mine.source,
            updated_at: mine.updated_at,
          });
          continue;
        }

        const result = await mirror.upsert(
          source.kind,
          {
            record_id: rec.id,
            created_time: rec.createdTime ?? null,
            fields: rec.fields ?? {},
            // Every kind that needs to be told its table, not only client
            // questions — the fault that had kept the Open loops resync from
            // ever storing a row. See mirror.needsTableId.
            table_id: mirror.needsTableId(source.kind) ? source.table : null,
            // Only where the kind has no id column of its own; `prepare()`
            // refuses it otherwise, which is the guard rather than a comment.
            natural_id: source.naturalFromRecordId ? rec.id : null,
            lane_id:
              source.kind === 'client_requests'
                ? (typeof rec.fields?.['Lane ID'] === 'string' ? (rec.fields['Lane ID'] as string) : null)
                : (source.lane_id ?? null),
          },
          'airtable',
        );
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else unchanged++;
      } catch (e) {
        // One row this database will not store must not abandon the table, and
        // must not vanish either: the reason goes to the log and the count comes
        // back, so "read five, stored none" can never read as "five matched".
        refused++;
        console.error(`final import: ${source.label} ${rec.id} refused — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    tables.push(row(true, null, records.length, { inserted, updated, unchanged, kept_newer_here: keptHere, refused }));
  }

  const sum = (k: 'inserted' | 'updated' | 'unchanged' | 'kept_newer_here' | 'refused') => tables.reduce((n, t) => n + t[k], 0);
  const blocked = tables.filter((t) => !t.read);
  const ms = Date.now() - started;
  console.log(
    `final import ${group} by ${actor}: ${sum('inserted')} inserted, ${sum('updated')} updated, ${sum('unchanged')} unchanged, ${sum('kept_newer_here')} kept (newer here), ${sum('refused')} refused, ${blocked.length} table(s) not read, ${ms}ms`,
  );
  for (const t of tables) {
    console.log(`  ${t.label} (${t.table}) ${t.read ? `${t.rows} row(s): +${t.inserted} ~${t.updated} =${t.unchanged} kept ${t.kept_newer_here} refused ${t.refused}` : `NOT READ — ${t.reason}`}`);
  }
  for (const k of kept) console.log(`  kept ${k.natural_id ?? k.record_id}: ${k.field ?? 'no field differs'} here ${JSON.stringify(k.here)} vs Airtable ${JSON.stringify(k.airtable)} (${k.source}, ${k.updated_at})`);

  return {
    group,
    ran: true,
    at,
    ms,
    cutover_at: CUTOVER_AT,
    tables,
    inserted: sum('inserted'),
    updated: sum('updated'),
    unchanged: sum('unchanged'),
    kept_newer_here: sum('kept_newer_here'),
    refused: sum('refused'),
    kept,
    note: blocked.length
      ? `${blocked.length} table(s) could not be read and nothing under them was imported: ${blocked.map((t) => `${t.label} (${t.reason})`).join('; ')}.`
      : 'Nothing was deleted. A row changed here since the cutover was kept as it is and is listed above with both values.',
  };
}
