/**
 * Migrations. Forward-only, numbered, run on boot, idempotent.
 *
 * Each migration runs once, inside its own transaction, and is recorded in
 * `schema_migrations`. Running the server twice against the same database
 * applies nothing the second time. Two instances booting at once are
 * serialised by a session advisory lock, so neither sees a half-applied
 * schema.
 *
 * The rule that replaces the old one: **nothing here drops a table.** While
 * the store was a SQLite file on an ephemeral disk, a shape change was
 * handled by dropping the tables and letting the next resync rebuild them —
 * honest then, because the file was wiped on every deploy anyway. It is not
 * honest now. `events` and `observations` are the only record of when a
 * status changed and what a figure was on a given day, and after this move
 * they are the first thing in this system that actually survives a restart.
 * A change to the read model's shape is a new migration that alters it, or
 * one that truncates `records` on purpose and lets sync.ts refill it from
 * Airtable, which is still the source of truth for every record kind.
 */
import { getPool, type Queryable } from './pg';

interface Migration {
  id: number;
  name: string;
  /** Statements applied in order, in one transaction. */
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    statements: [
      /**
       * Small key/value state that has no shape worth a table of its own:
       * `history_since` (when this database started recording status changes),
       * `sync:<kind>` (each kind's last successful resync, its error and its
       * per-table row counts), `clients:tables` (the questions-table → lane
       * map the clients index names at sync time) and `codex:layer0` (the
       * Layer 0 holding table, held whole because those rows are not records
       * of any kind — no status, no write path).
       */
      `CREATE TABLE IF NOT EXISTS meta (
         key   text PRIMARY KEY,
         value text NOT NULL
       )`,

      /**
       * The record read model: one row per Airtable record, keyed by its
       * Airtable id, for all eight kinds. Airtable stays the source of truth;
       * sync.ts rebuilds this from the bases and every write goes there first.
       *
       * `json` is text, not jsonb, and the timestamps are text, not
       * timestamptz, deliberately. The column values are the exact strings
       * Airtable returned — 'YYYY-MM-DD' day stamps in raised_at/closed_at,
       * full ISO instants elsewhere — and the metrics compare and slice them
       * as strings. Storing them as native types would reformat them on the
       * way back out and quietly change what every one of those comparisons
       * means. `json` stays text for the same reason plus one more: the
       * pattern search matches against the raw record text, and jsonb does
       * not preserve it.
       */
      `CREATE TABLE IF NOT EXISTS records (
         kind       text NOT NULL,
         id         text NOT NULL,
         key        text,
         json       text NOT NULL,
         status     text NOT NULL,
         builder    text,
         raised_at  text,
         closed_at  text,
         updated_at text NOT NULL,
         source     text NOT NULL,
         table_id   text NOT NULL,
         synced_at  text NOT NULL,
         PRIMARY KEY (kind, id)
       )`,
      `CREATE INDEX IF NOT EXISTS records_kind_table ON records (kind, table_id)`,
      `CREATE INDEX IF NOT EXISTS records_kind_builder ON records (kind, builder)`,

      /**
       * Status changes, with the time they happened. The loop tables carry no
       * close date and nothing upstream keeps a status-change history, so this
       * is the only place a close is dated. Until this move it reset with the
       * instance; from here it accumulates, and the notes on the pages that
       * read it say so from `meta.history_since`.
       */
      `CREATE TABLE IF NOT EXISTS events (
         seq         bigserial PRIMARY KEY,
         kind        text NOT NULL,
         record_id   text NOT NULL,
         builder     text,
         from_status text,
         to_status   text NOT NULL,
         via         text NOT NULL,
         at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at)`,
      `CREATE INDEX IF NOT EXISTS events_kind_to_status ON events (kind, to_status)`,

      /**
       * A figure as it stood at one resync. Airtable keeps no history of
       * fields like missing_research_count, so a trend needs the dashboard to
       * have written down what it saw. Two observations on two different days
       * make a trend; one does not, and the page says which it has.
       */
      `CREATE TABLE IF NOT EXISTS observations (
         kind   text NOT NULL,
         metric text NOT NULL,
         at     text NOT NULL,
         value  double precision NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS observations_kind_metric_at ON observations (kind, metric, at)`,
    ],
  },
];

/** Postgres advisory-lock key. Arbitrary, constant, this application's own. */
const LOCK_KEY = 8_134_207_611;

async function applied(db: Queryable): Promise<Set<number>> {
  const r = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  return new Set(r.rows.map((row) => Number(row.id)));
}

/**
 * Brings the database up to date. Safe to call on every boot, and safe when
 * two instances boot at the same moment — Render overlaps the old and new
 * instance on a deploy, so that is the normal case rather than the unusual one.
 *
 * The lock covers the whole run, `schema_migrations` included, on one session.
 * `CREATE TABLE IF NOT EXISTS` reads as concurrency-safe and is not: two
 * sessions issuing it together race in the catalogue and one of them dies with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
 * Measured, not assumed — five racing migrators against a fresh database
 * killed one of them before the lock was moved above the bootstrap.
 *
 * Each migration still commits in its own transaction, so a failure leaves the
 * ones before it applied and itself not applied at all.
 */
export async function migrate(): Promise<{ applied: number[]; already: number }> {
  const client = await getPool().connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
                          id         integer PRIMARY KEY,
                          name       text NOT NULL,
                          applied_at timestamptz NOT NULL DEFAULT now()
                        )`);

    const have = await applied(client);
    const done: number[] = [];
    let already = 0;

    for (const m of MIGRATIONS.slice().sort((a, b) => a.id - b.id)) {
      if (have.has(m.id)) {
        already++;
        continue;
      }
      await client.query('BEGIN');
      try {
        for (const sql of m.statements) await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${m.id} (${m.name}) failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
      }
      done.push(m.id);
    }
    return { applied: done, already };
  } finally {
    // A session lock outlives its transaction, so it must be released by hand;
    // releasing the client would also drop it, but not if the pool keeps it.
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export const MIGRATION_COUNT = MIGRATIONS.length;
