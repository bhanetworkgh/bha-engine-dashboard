/**
 * Backfills the engine tables from Airtable.
 *
 *   npm run backfill              every kind
 *   npm run backfill -- loops     one or more kinds
 *   npm run backfill -- --dry     read and report, write nothing
 *
 * A command, not a one-off script: it is the thing that proves dual-write is
 * correct. Run it, let n8n write for a while, run it again — if the second run
 * reports rows it had to change, the engine and Airtable disagree and the diff
 * is where to look. That is the whole purpose of the dual-write period, and it
 * needs a command that can be run on any day, not a script deleted after one
 * use.
 *
 * Idempotent twice over: the record id is unique and the upsert is an
 * ON CONFLICT DO UPDATE, so a second run over unchanged data inserts nothing,
 * updates nothing and reports `unchanged` for every row.
 *
 * It reads Airtable and writes Postgres. **It touches no Airtable data and no
 * existing dashboard table** — `records`, the read model every page still
 * renders from, is not involved.
 */
import * as airtable from './airtable';
import { assertDatabase, closePool, query } from './pg';
import { migrate } from './migrations';
import { DIGESTS, KIND_LIST, fromAirtable, isKind, upsert, type MirrorKind } from './mirror';
import {
  CLIENTS_INDEX,
  CODEX_BASE,
  CODEX_LAYER0,
  CODEX_TABLES,
  COMMERCIAL,
  LOOP_TABLES,
  LOOPS_BASE,
  NORTH_STAR,
  PATTERNS,
  RESEARCH_QUEUE,
} from './sources';

export interface TableOutcome {
  table: string;
  label: string;
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** The first few failures, with the record id and the reason. */
  errors: { record_id: string; message: string }[];
  ms: number;
}
export interface KindOutcome {
  kind: MirrorKind;
  ok: boolean;
  tables: TableOutcome[];
}

/** Extra columns a row needs that the Airtable record itself does not carry. */
type Extra = Parameters<typeof fromAirtable>[1];

interface SourceTable {
  base: string;
  table: string;
  label: string;
  extra?: Extra;
}

/**
 * The per-lane question tables, read from the index rather than hardcoded.
 *
 * Taken from the lanes this backfill has just written, so it follows exactly
 * what the index says today — the same rule the pipeline adopted on 10 Sep
 * when it dropped its own lane-to-table map: adding a client is a row, not a
 * deploy. A lane whose index row leaves Table ID empty is skipped and
 * reported, never guessed at.
 */
async function questionTables(): Promise<{ tables: SourceTable[]; skipped: string[] }> {
  const r = await query<{ lane: string | null; name: string | null; table_id: string | null }>(
    `SELECT fields->>'Lane ID' AS lane, fields->>'Lane / Client' AS name, fields->>'Table ID' AS table_id
       FROM engine_client_lanes`,
  );
  const tables: SourceTable[] = [];
  const skipped: string[] = [];
  for (const row of r.rows) {
    const label = row.name ?? row.lane ?? '(unnamed lane)';
    if (!row.table_id) {
      skipped.push(label);
      continue;
    }
    tables.push({ base: CLIENTS_INDEX.base, table: row.table_id, label, extra: { table_id: row.table_id, lane_id: row.lane } });
  }
  return { tables, skipped };
}

async function sourcesFor(kind: MirrorKind): Promise<{ tables: SourceTable[]; skipped: string[] }> {
  switch (kind) {
    case 'loops':
      // builder_id comes from the table, because the table is the owner.
      return { tables: LOOP_TABLES.map((t) => ({ base: LOOPS_BASE, table: t.table, label: t.label, extra: { table_id: t.table } })), skipped: [] };
    case 'codex':
      return { tables: CODEX_TABLES.map((t) => ({ base: CODEX_BASE, table: t.table, label: t.label, extra: { table_id: t.table } })), skipped: [] };
    case 'layer0':
      return { tables: [{ base: CODEX_LAYER0.base, table: CODEX_LAYER0.table, label: CODEX_LAYER0.label }], skipped: [] };
    case 'patterns':
      return { tables: [PATTERNS], skipped: [] };
    case 'commercial':
      return { tables: [COMMERCIAL], skipped: [] };
    case 'ns':
      return { tables: [NORTH_STAR], skipped: [] };
    case 'rt':
      return { tables: [RESEARCH_QUEUE], skipped: [] };
    case 'client_lanes':
      return { tables: [CLIENTS_INDEX], skipped: [] };
    case 'client_questions':
      return questionTables();
    case 'digests':
      return { tables: [DIGESTS], skipped: [] };
  }
}

/**
 * One table. Every record is upserted on its own, deliberately: a single
 * malformed row must not roll back the other four hundred, and the row that
 * failed has to be nameable afterwards. The count of failures is reported and
 * makes the run not-ok, so a partial backfill can never look like a clean one.
 */
async function backfillTable(kind: MirrorKind, src: SourceTable, dry: boolean): Promise<TableOutcome> {
  const t0 = Date.now();
  const out: TableOutcome = { table: src.table, label: src.label, read: 0, inserted: 0, updated: 0, unchanged: 0, failed: 0, errors: [], ms: 0 };
  let records: airtable.AtRecord[];
  try {
    records = await airtable.listAll(src.base, src.table);
  } catch (e) {
    out.failed = 1;
    out.errors.push({ record_id: '(table)', message: e instanceof Error ? e.message : String(e) });
    out.ms = Date.now() - t0;
    return out;
  }
  out.read = records.length;
  if (dry) {
    out.ms = Date.now() - t0;
    return out;
  }
  for (const rec of records) {
    try {
      // fromAirtable takes rec.fields. Reading rec's top level would store an
      // empty object and look like a clean run — the failure this engine has
      // hit three times.
      const r = await upsert(kind, fromAirtable(rec, src.extra), 'airtable');
      if (r.inserted) out.inserted++;
      else if (r.changed) out.updated++;
      else out.unchanged++;
    } catch (e) {
      out.failed++;
      if (out.errors.length < 5) out.errors.push({ record_id: rec.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  out.ms = Date.now() - t0;
  return out;
}

/**
 * One run at a time.
 *
 * A backfill is twenty-two full table reads against Airtable; two at once would
 * double that traffic for no benefit and race each other's upserts. Concurrent
 * callers share the run in flight, exactly as sync.ts does for a resync.
 */
let inflight: Promise<KindOutcome[]> | null = null;

export function isRunning(): boolean {
  return inflight !== null;
}

export function backfillOnce(kinds: MirrorKind[] = KIND_LIST, dry = false): Promise<KindOutcome[]> {
  if (inflight) return inflight;
  inflight = backfill(kinds, dry).finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function backfill(kinds: MirrorKind[] = KIND_LIST, dry = false): Promise<KindOutcome[]> {
  const results: KindOutcome[] = [];
  // client_lanes before client_questions: the index names the question tables.
  const ordered = [...kinds].sort((a, b) => (a === 'client_lanes' ? -1 : b === 'client_lanes' ? 1 : 0));
  for (const kind of ordered) {
    const { tables, skipped } = await sourcesFor(kind);
    for (const name of skipped) console.log(`backfill ${kind}: skipped ${name} — its index row names no Table ID.`);
    const outcomes: TableOutcome[] = [];
    for (const src of tables) {
      const o = await backfillTable(kind, src, dry);
      outcomes.push(o);
      console.log(
        o.failed && o.errors[0]?.record_id === '(table)'
          ? `backfill ${kind}/${o.label}: COULD NOT READ — ${o.errors[0].message}`
          : `backfill ${kind}/${o.label}: ${o.read} read → ${o.inserted} new, ${o.updated} changed, ${o.unchanged} unchanged${o.failed ? `, ${o.failed} FAILED` : ''} (${o.ms}ms)`,
      );
      for (const err of o.errors) if (err.record_id !== '(table)') console.log(`    ${err.record_id}: ${err.message}`);
    }
    results.push({ kind, ok: outcomes.every((o) => o.failed === 0), tables: outcomes });
  }
  return results;
}

/* ------------------------------------------------------------------ cli */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const named = args.filter((a) => !a.startsWith('--'));
  const unknown = named.filter((a) => !isKind(a));
  if (unknown.length) {
    console.error(`Not a kind: ${unknown.join(', ')}. One of: ${KIND_LIST.join(', ')}`);
    process.exit(1);
  }
  const kinds = named.length ? (named as MirrorKind[]) : KIND_LIST;

  if (!airtable.airtableConfigured()) {
    console.error('AIRTABLE_API_KEY is not set, so there is nothing to backfill from.');
    process.exit(1);
  }
  await assertDatabase();
  // The tables have to exist. Safe to call: migrations are idempotent and the
  // advisory lock means this cannot race a server that is booting.
  await migrate();

  console.log(`backfill: ${kinds.join(', ')}${dry ? ' (dry run — reading only)' : ''}`);
  const t0 = Date.now();
  const results = await backfill(kinds, dry);
  const total = results.flatMap((r) => r.tables).reduce(
    (acc, t) => ({ read: acc.read + t.read, inserted: acc.inserted + t.inserted, updated: acc.updated + t.updated, unchanged: acc.unchanged + t.unchanged, failed: acc.failed + t.failed }),
    { read: 0, inserted: 0, updated: 0, unchanged: 0, failed: 0 },
  );
  console.log('');
  console.log(`backfill finished in ${Math.round((Date.now() - t0) / 100) / 10}s`);
  console.log(`  ${total.read} records read across ${results.flatMap((r) => r.tables).length} tables`);
  console.log(`  ${total.inserted} inserted, ${total.updated} updated, ${total.unchanged} already current, ${total.failed} failed`);
  if (total.failed) console.log('  A failed row is named above. The run is NOT clean.');
  await closePool();
  process.exit(total.failed ? 1 : 0);
}

if (require.main === module) {
  void main().catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
