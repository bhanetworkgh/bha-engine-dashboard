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
  {
    id: 2,
    name: 'system registry',
    statements: [
      /**
       * The System Registry (decision 2026-09-13, Destiny): which workflow does
       * what and who owns it, and what BHA pays for.
       *
       * These six tables are the exception to "Airtable is the source of truth".
       * Nothing upstream records any of this — there is no Airtable base holding
       * the billing owner of Otter.ai — so the dashboard is where these rows are
       * created and edited, and a resync would have nothing to read. That is why
       * they sit beside `records` rather than in it.
       *
       * Every table carries created_at, updated_at and deleted_at as text ISO
       * instants, matching the rest of this schema: the values are compared and
       * sliced as strings everywhere they are read.
       *
       * `deleted_at` is a soft delete and there is no hard one. A registry whose
       * answer to "did we ever pay for that" is a missing row is not a registry.
       *
       * NOTE on registry_credentials: there is deliberately **no column a secret
       * value could be written to**. Names, types, owners and uses only. Adding
       * one would take a migration and a decision, which is the point.
       */
      `CREATE TABLE IF NOT EXISTS registry_workflows (
         id             text PRIMARY KEY,
         name           text NOT NULL,
         system         text,
         folder         text,
         pillar         text,
         owner          text,
         trigger_type   text,
         trigger_detail text,
         status         text,
         purpose        text,
         n8n_url        text,
         notes          text,
         created_at     text NOT NULL,
         updated_at     text NOT NULL,
         deleted_at     text
       )`,
      `CREATE INDEX IF NOT EXISTS registry_workflows_system ON registry_workflows (system)`,

      `CREATE TABLE IF NOT EXISTS registry_services (
         id             text PRIMARY KEY,
         name           text NOT NULL,
         category       text,
         what_it_is_for text,
         url            text,
         managed_by     text,
         plan           text,
         billing_owner  text,
         cost_amount    double precision,
         cost_currency  text,
         billing_cycle  text,
         renewal_date   text,
         status         text,
         notes          text,
         created_at     text NOT NULL,
         updated_at     text NOT NULL,
         deleted_at     text
       )`,

      `CREATE TABLE IF NOT EXISTS registry_credentials (
         id         text PRIMARY KEY,
         name       text NOT NULL,
         type       text,
         used_by    text[],
         owner      text,
         notes      text,
         created_at text NOT NULL,
         updated_at text NOT NULL,
         deleted_at text
       )`,

      `CREATE TABLE IF NOT EXISTS registry_endpoints (
         id               text PRIMARY KEY,
         name             text NOT NULL,
         url              text NOT NULL,
         method           text,
         auth_type        text,
         owned_by_service text,
         what_calls_it    text,
         notes            text,
         created_at       text NOT NULL,
         updated_at       text NOT NULL,
         deleted_at       text
       )`,

      `CREATE TABLE IF NOT EXISTS registry_airtable_bases (
         id             text PRIMARY KEY,
         name           text NOT NULL,
         what_it_is_for text,
         url            text,
         notes          text,
         created_at     text NOT NULL,
         updated_at     text NOT NULL,
         deleted_at     text
       )`,

      `CREATE TABLE IF NOT EXISTS registry_people (
         id            text PRIMARY KEY,
         name          text NOT NULL,
         slack_user_id text,
         email         text,
         role          text,
         lanes_owned   text[],
         notes         text,
         created_at    text NOT NULL,
         updated_at    text NOT NULL,
         deleted_at    text
       )`,
    ],
  },
{
    id: 3,
    name: 'engine mirror tables and the write log',
    statements: [
      /**
       * Step 1 and 2 of the Airtable → Postgres migration (2026-09-13,
       * Destiny). One Postgres table per Airtable table the dashboard
       * actually reads — see the inventory in BUILD_LOG for the list and for
       * the four bases deliberately left out.
       *
       * **Nothing here replaces the Airtable read path.** `records` still
       * holds the read model, sync.ts still rebuilds it from Airtable, and
       * every page still reads it. These tables are filled in parallel, by a
       * backfill and by the engine writing to /api/engine/*, so that the two
       * can be compared for as long as it takes to trust them. Step 3 —
       * cutting the pages over and retiring the sync — is a separate decision
       * on a later day, and doing it now would empty the dashboard.
       *
       * **Shape.** Each row keeps Airtable's own record id, Airtable's own
       * `createdTime`, and Airtable's `fields` object stored verbatim as
       * jsonb with its field names untouched — `What`, `Jason Status`,
       * `Layer1 Review ` with its trailing space and all. That last part is
       * the whole point: n8n writes those names, and a column list of my own
       * would drop any field I forgot or that someone adds to the base later,
       * silently, which is the exact failure this engine has hit three times.
       * jsonb cannot lose a field it was never told about.
       *
       * Columns are promoted out of `fields` only where something keys, joins
       * or filters on them, and they are derived from the payload on every
       * write so they cannot drift from what is inside the blob.
       *
       * `airtable_record_id` is UNIQUE so the backfill can be a plain
       * ON CONFLICT DO UPDATE and running it twice changes nothing. It is
       * nullable, because the engine may write a row here before Airtable has
       * one — `natural_id` is what matches those, and it is indexed but NOT
       * unique: the Research Queue is an attempt log where card_id genuinely
       * repeats, and a unique constraint there would reject real rows.
       */
      `CREATE TABLE IF NOT EXISTS engine_loops (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         builder_id          text NOT NULL,
         table_id            text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_loops_natural ON engine_loops (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_loops_builder ON engine_loops (builder_id)`,

      `CREATE TABLE IF NOT EXISTS engine_codex_submissions (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         builder_id          text NOT NULL,
         table_id            text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_codex_natural ON engine_codex_submissions (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_codex_builder ON engine_codex_submissions (builder_id)`,

      `CREATE TABLE IF NOT EXISTS engine_layer0_holds (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_layer0_natural ON engine_layer0_holds (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_build_patterns (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_patterns_natural ON engine_build_patterns (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_commercial_cards (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_commercial_natural ON engine_commercial_cards (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_ns_records (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_ns_natural ON engine_ns_records (natural_id)`,

      /**
       * The Research Queue is an attempt log: one row per attempt, and
       * `card_id` repeats — one card carries twenty rows. So `natural_id`
       * holds card_id for reading and grouping, and the write path keys this
       * kind on airtable_record_id alone. Keying it on card_id would fold
       * twenty attempts into one row.
       */
      `CREATE TABLE IF NOT EXISTS engine_rt_attempts (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_rt_natural ON engine_rt_attempts (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_client_lanes (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_lanes_natural ON engine_client_lanes (natural_id)`,

      /**
       * A question carries no id of its own, so this keys on the record id.
       * `table_id` is which per-lane table it came from and `lane_id` is the
       * lane that table belongs to — the index names both, and neither is
       * hardcoded anywhere.
       */
      `CREATE TABLE IF NOT EXISTS engine_client_questions (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         table_id            text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_questions_table ON engine_client_questions (table_id)`,

      /**
       * digest_deliveries. Not read by this dashboard before today: it is
       * mirrored because the delivery-health figure on the registry reads it,
       * and that figure is the engine's only honest measure of whether a
       * builder actually received what was sent. `session_id` is the key the
       * Callback Receiver matches a delivery to a send on, so it is the
       * natural id here.
       */
      `CREATE TABLE IF NOT EXISTS engine_digest_deliveries (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         builder_id          text,
         status              text,
         sent_at             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_digests_natural ON engine_digest_deliveries (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_digests_status ON engine_digest_deliveries (status, sent_at)`,

      /**
       * Every write the engine makes, whether it succeeded or not.
       *
       * This exists for the dual-write period specifically: while both paths
       * run, the only way to know the engine's writes are landing correctly is
       * to be able to see what arrived and compare it against Airtable. A
       * rejected write is recorded too — a 422 nobody can see is the same as
       * silence, and silence is what this whole migration is trying to remove.
       */
      `CREATE TABLE IF NOT EXISTS engine_writes (
         seq                 bigserial PRIMARY KEY,
         at                  text NOT NULL,
         endpoint            text NOT NULL,
         kind                text NOT NULL,
         method              text NOT NULL,
         key_label           text,
         airtable_record_id  text,
         natural_id          text,
         outcome             text NOT NULL,
         detail              text,
         ms                  integer
       )`,
      `CREATE INDEX IF NOT EXISTS engine_writes_at ON engine_writes (at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_writes_outcome ON engine_writes (outcome, at DESC)`,

      /**
       * The registry's entry for engine_events predates digest_deliveries
       * existing. Updated here rather than in the seed, because seeding is
       * ON CONFLICT DO NOTHING and would never reach an existing row.
       *
       * Guarded on the original seeded text so an edit made in the interface
       * is never overwritten: if Destiny has already reworded this row, the
       * WHERE matches nothing and his wording stands.
       */
      `UPDATE registry_airtable_bases
          SET what_it_is_for = 'The error_counts table the three error handlers share, and digest_deliveries — the send-and-arrival record for the daily open-loops digest and the 3-day check-in.',
              notes = 'digest_deliveries (tblNuMju8l1kL3Sd1) was added on 13 Sep 2026. A row is written when a digest is handed to North Star and updated when the Callback Receiver posts it; status missing means the delivery check found one that never arrived.',
              updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'appINvgEoZjuYQI2O'
          AND what_it_is_for = 'The error_counts table the three error handlers share.'`,
    ],
  },
  {
    id: 4,
    name: 'notes move out of the records read model',
    statements: [
      /**
       * Step 3 of the Airtable → Postgres migration (2026-09-13, Destiny).
       * The pages read the `engine_*` mirror tables directly now, and the
       * Airtable sync that filled `records` is gone.
       *
       * One thing lived only in `records`: the note a person types on a loop
       * when they close it, or in the new-loop form. Airtable never carried
       * it — `mapLoop` returns `note: null` — so it was carried forward inside
       * `records.json` by every upsert and would have disappeared with the
       * read model. It gets its own table, which is also where it belonged:
       * it is this dashboard's own annotation on someone else's record, not a
       * field of that record.
       *
       * `records` itself is left exactly as it is. It stops being read, and
       * nothing drops a table here — its rows are the last state the Airtable
       * sync saw, and `events`, which is real history, references the same
       * record ids.
       */
      `CREATE TABLE IF NOT EXISTS record_notes (
         kind        text NOT NULL,
         record_id   text NOT NULL,
         note        text NOT NULL,
         updated_at  text NOT NULL,
         PRIMARY KEY (kind, record_id)
       )`,
      // Carry across every note the read model was holding. Idempotent, and a
      // note someone has since edited through the new table wins.
      `INSERT INTO record_notes (kind, record_id, note, updated_at)
       SELECT kind, id, json::jsonb->>'note', updated_at
         FROM records
        WHERE json::jsonb->>'note' IS NOT NULL AND json::jsonb->>'note' <> ''
       ON CONFLICT (kind, record_id) DO NOTHING`,
    ],
  },
  {
    id: 5,
    name: 'the loop write-back record',
    statements: [
      /**
       * What happened the last time this dashboard pushed a loop's status back
       * to Airtable through n8n (2026-09-14, Destiny).
       *
       * The dashboard holds no Airtable token and is not getting one back. But
       * the 08:00 Open Loops digest reads Airtable, so a close that does not
       * reach Airtable reappears tomorrow morning as though it never happened —
       * and the person who closed it has no way to know. One row per loop, the
       * latest attempt only: this is the current state of "did the last change
       * land", not a history, and it is read straight onto the loop so the
       * failure is on screen next to the status it contradicts.
       */
      `CREATE TABLE IF NOT EXISTS loop_writebacks (
         record_id   text PRIMARY KEY,
         loop_id     text,
         state       text NOT NULL,
         status      text NOT NULL,
         reason      text,
         http        integer,
         changed     boolean,
         at          text NOT NULL
       )`,
      // Every read of the loops page asks for the failures; the count is small
      // and the index keeps it from being a scan of the whole table to find them.
      `CREATE INDEX IF NOT EXISTS loop_writebacks_state ON loop_writebacks (state)`,
    ],
  },
  {
    id: 6,
    name: 'loop_writebacks becomes a log of every loop write',
    statements: [
      /**
       * Edits go straight to Airtable now (2026-09-14, Destiny) and the n8n
       * write-back is retired — but the table it wrote to stays and gets
       * widened rather than replaced. Its rows are the record of what this
       * dashboard has and has not managed to push, and the marker on the loops
       * page reads from it.
       *
       * Two changes. It becomes **append-only**: a move that half-lands has to
       * show where it stopped, and one row per loop overwrites exactly the
       * history that would answer that. And it carries what a move needs — the
       * source and destination table, the steps that actually completed, and
       * the record id the loop ended up under, which is a new one after a move.
       *
       * The primary key moves from record_id to a sequence. Every existing row
       * is kept; nothing here drops a table.
       */
      `ALTER TABLE loop_writebacks DROP CONSTRAINT IF EXISTS loop_writebacks_pkey`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS seq bigserial`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loop_writebacks_pkey') THEN
           ALTER TABLE loop_writebacks ADD CONSTRAINT loop_writebacks_pkey PRIMARY KEY (seq);
         END IF;
       END $$`,
      // What the write was, and what it did. `steps` is the list that
      // completed, in order — on a duplicate it is what says the create landed
      // and the delete did not.
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS action        text`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS detail        text`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS from_table    text`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS to_table      text`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS steps         text`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS new_record_id text`,
      `ALTER TABLE loop_writebacks ADD COLUMN IF NOT EXISTS actor         text`,
      // The page wants the newest write per loop, and the log will only grow.
      `CREATE INDEX IF NOT EXISTS loop_writebacks_record_seq ON loop_writebacks (record_id, seq DESC)`,
      // Rows written before today were one per loop with no action recorded.
      `UPDATE loop_writebacks SET action = 'status' WHERE action IS NULL`,
    ],
  },
  {
    id: 7,
    name: 'the loop write log becomes the record write log',
    statements: [
      /**
       * Codex entries are written to Airtable from here too now (2026-09-14,
       * Destiny), and they need exactly what loops needed: a line per write,
       * and a marker on the row when one did not land. Rather than a second
       * table with the same columns and a second marker component that drifts
       * from the first, the loop log becomes the record log.
       *
       * A rename, not a drop — every row is kept and carries `kind = 'loops'`,
       * which is what they all were.
       */
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'loop_writebacks')
            AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'record_writes') THEN
           ALTER TABLE loop_writebacks RENAME TO record_writes;
         END IF;
       END $$`,
      `CREATE TABLE IF NOT EXISTS record_writes (
         seq           bigserial PRIMARY KEY,
         record_id     text NOT NULL,
         natural_id    text,
         state         text NOT NULL,
         status        text NOT NULL,
         reason        text,
         http          integer,
         changed       boolean,
         at            text NOT NULL
       )`,
      `ALTER TABLE record_writes ADD COLUMN IF NOT EXISTS kind text`,
      // The column held a loop_id when only loops were written. It now holds a
      // Codex entry id as often as not, and a column named for one of the two
      // things it carries is how the next reader gets it wrong.
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'record_writes' AND column_name = 'loop_id')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'record_writes' AND column_name = 'natural_id') THEN
           ALTER TABLE record_writes RENAME COLUMN loop_id TO natural_id;
         END IF;
       END $$`,
      `ALTER TABLE record_writes ADD COLUMN IF NOT EXISTS natural_id text`,
      `UPDATE record_writes SET kind = 'loops' WHERE kind IS NULL`,
      `CREATE INDEX IF NOT EXISTS record_writes_kind_record_seq ON record_writes (kind, record_id, seq DESC)`,
      /**
       * Every delete made from this dashboard, kept whole.
       *
       * Deleting exists for production testing — driving a log through Layer 0,
       * Layer 1 and approval deliberately, then clearing the fixtures. A row
       * removed from Airtable and from here is gone from both, so the only
       * place it can still be read is this table, and it holds the full record
       * as it was rather than a summary of it. Append-only; nothing prunes it.
       */
      `CREATE TABLE IF NOT EXISTS record_deletions (
         seq         bigserial PRIMARY KEY,
         kind        text NOT NULL,
         record_id   text NOT NULL,
         natural_id  text,
         builder_id  text,
         table_id    text,
         reason      text NOT NULL,
         fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
         actor       text,
         at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS record_deletions_at ON record_deletions (at DESC)`,
    ],
  },
  {
    id: 8,
    name: 'the write log remembers the row a move left behind',
    statements: [
      /**
       * A move that creates the destination row and fails to delete the source
       * leaves the loop in two tables. The log said which two, but not *which
       * row* — and by then the loop's own record id is the new one, so the copy
       * could be named and not removed. This is the id of that copy, written on
       * the duplicate line and read back when the delete is retried.
       *
       * Null on every other line, including the retry that succeeds: there is
       * then no copy left to point at.
       */
      `ALTER TABLE record_writes ADD COLUMN IF NOT EXISTS from_record_id text`,
    ],
  },
  {
    id: 9,
    name: 'n8n execution counts, snapshotted forward',
    statements: [
      /**
       * Execution counts per workflow per month, accumulated.
       *
       * **n8n's execution history does not persist.** The instance holds a few
       * days: on 15 Sep 2026 it held 3,673 executions and none older than
       * 12 Sep. A monthly view that queried the API live would therefore show
       * August, July and everything before as empty — a clean past that is only
       * missing data, which is the exact failure this dashboard exists to stop.
       *
       * So this table is the record and the API is only ever the feed into it.
       * Nothing prunes it. The counts are **accumulated forward** rather than
       * recomputed: the snapshot job reads only executions above a watermark
       * and adds them, so a month whose executions have since aged out of n8n
       * keeps the count it had when they existed.
       *
       * `failed_ids` is the list of failing execution ids, kept so each failure
       * still opens in n8n while the execution is there — and so the count is
       * still explicable after it is not.
       */
      `CREATE TABLE IF NOT EXISTS engine_executions (
         period        text NOT NULL,
         workflow_id   text NOT NULL,
         workflow_name text,
         system        text,
         executions    integer NOT NULL DEFAULT 0,
         failures      integer NOT NULL DEFAULT 0,
         failed_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
         first_seen_at text NOT NULL,
         updated_at    text NOT NULL,
         PRIMARY KEY (period, workflow_id)
       )`,
      `CREATE INDEX IF NOT EXISTS engine_executions_period ON engine_executions (period DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_executions_system ON engine_executions (system, period DESC)`,
    ],
  },
  {
    id: 10,
    name: 'execution counts go to a daily grain, and carry duration',
    statements: [
      /**
       * The same snapshot, one row per **day** per workflow rather than per
       * month, and carrying how long the executions took.
       *
       * Why the grain changed (2026-09-15, Destiny): the Executions page reports
       * weekly, monthly and yearly, and a month is not divisible into weeks
       * after the fact. A day is the smallest period anyone asked for, and every
       * larger one is a sum over days, so one table answers all three and a
       * fourth would not need a migration.
       *
       * `duration_ms` is the total across `duration_counted` executions, kept as
       * a sum and a count rather than an average so that averages over any span
       * are exact. They are separate from `executions` because an execution can
       * finish without a `stoppedAt`, and an average over a different number of
       * rows than it claims is the kind of quiet wrong figure this dashboard
       * exists to avoid.
       *
       * **`engine_executions` is left in place, unread** — nothing here drops a
       * table, same as the `records` read model. Its monthly rows cannot be
       * split into days, so this starts from its own watermark and re-reads what
       * n8n still holds. That costs nothing: n8n keeps about three days of
       * history and the monthly table is hours old, so everything it could have
       * counted is still there to count again.
       */
      `CREATE TABLE IF NOT EXISTS engine_execution_days (
         day             text NOT NULL,
         workflow_id     text NOT NULL,
         workflow_name   text,
         system          text,
         executions      integer NOT NULL DEFAULT 0,
         failures        integer NOT NULL DEFAULT 0,
         duration_ms     bigint  NOT NULL DEFAULT 0,
         duration_counted integer NOT NULL DEFAULT 0,
         failed_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
         first_seen_at   text NOT NULL,
         updated_at      text NOT NULL,
         PRIMARY KEY (day, workflow_id)
       )`,
      `CREATE INDEX IF NOT EXISTS engine_execution_days_day ON engine_execution_days (day DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_execution_days_system ON engine_execution_days (system, day DESC)`,
    ],
  },
  {
    id: 11,
    name: 'executions are stored one row per execution, not as counters',
    statements: [
      /**
       * **One row per n8n execution, keyed on n8n's own id.**
       *
       * The two tables before this one stored counters — a month's total, then
       * a day's total — and every fault the live page shipped with was a fault
       * of counter arithmetic rather than of the figures themselves. Counts
       * read exactly sixty times what n8n held, because a paging bug re-read
       * the same page sixty times and each pass *added* to the running total.
       * Failures read nought, because the pages that held them were never
       * reached. Seven workflows of thirty-one appeared, for the same reason.
       * None of those can exist here: re-reading an execution is an upsert on
       * its primary key, so a second read changes nothing, a tenth changes
       * nothing, and a figure is a `count(*)` over rows that either exist or
       * do not.
       *
       * It also makes a per-workflow drill-down possible at all — individual
       * ids, start times and durations — which a counter cannot answer however
       * carefully it is kept.
       *
       * **No `system` column.** A workflow's system comes from the workflow
       * registry at read time, so re-pointing a workflow at a system is a
       * registry edit that re-files its whole history. Copying the system onto
       * each row would have frozen yesterday's answer into yesterday's rows.
       *
       * `status` is n8n's own word, kept verbatim: success, error, crashed,
       * canceled, running, waiting, new. An execution read while it is still
       * running is stored with that status and re-read later — the row is the
       * to-do list, so nothing needs a separate list of ids to come back to.
       *
       * `duration_ms` is null where the execution recorded no end, never nought:
       * a run of unknown length and a run of no length are different facts.
       *
       * Volume is not a concern. The instance runs roughly 1,300 executions a
       * day — about 40k rows a month, under half a million a year.
       *
       * `engine_execution_days` and `engine_executions` are left in place and
       * unread, like the `records` read model. Nothing here drops a table.
       */
      `CREATE TABLE IF NOT EXISTS engine_execution_runs (
         execution_id  bigint PRIMARY KEY,
         workflow_id   text NOT NULL,
         workflow_name text,
         status        text NOT NULL,
         mode          text,
         day           text NOT NULL,
         started_at    text NOT NULL,
         stopped_at    text,
         duration_ms   bigint,
         first_seen_at text NOT NULL,
         updated_at    text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_execution_runs_day ON engine_execution_runs (day DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_execution_runs_workflow ON engine_execution_runs (workflow_id, day DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_execution_runs_status ON engine_execution_runs (status)`,
      /** The poll asks for these every pass: the runs that have not finished yet. */
      `CREATE INDEX IF NOT EXISTS engine_execution_runs_open ON engine_execution_runs (execution_id) WHERE status NOT IN ('success','error','crashed','canceled')`,
    ],
  },
  {
    id: 12,
    name: 'the roster carries its work email',
    statements: [
      /**
       * Everybody's `@bhanetwork.org` address on the Builders registry
       * (2026-09-16, Destiny).
       *
       * The seed cannot do this. `seedRegistry` inserts `ON CONFLICT (id) DO
       * NOTHING`, so a row that already exists is never touched again and an
       * email added to `registrySeed.ts` would reach a fresh database and no
       * other. Every live database already has these seven rows.
       *
       * `WHERE email IS NULL` on six of them: a value somebody typed into the
       * interface is theirs, and a migration that overwrote it would be this
       * dashboard deciding it knows better than the person who typed it.
       * Destiny's is the one replacement, and only from the exact personal
       * address the seed put there — it is the work address for a work
       * roster, and he asked for it by name.
       *
       * The four Destiny spelled out are Ahad, Destiny, Jason and Jegan. The
       * other three follow the same convention he gave for "everybody's", and
       * are the ones to check first if an address bounces.
       */
      `UPDATE registry_people SET email = 'jason@bhanetwork.org',   updated_at = now() WHERE id = 'jason'   AND email IS NULL`,
      `UPDATE registry_people SET email = 'jegan@bhanetwork.org',   updated_at = now() WHERE id = 'jegan'   AND email IS NULL`,
      `UPDATE registry_people SET email = 'ahad@bhanetwork.org',    updated_at = now() WHERE id = 'ahad'    AND email IS NULL`,
      `UPDATE registry_people SET email = 'kaiqi@bhanetwork.org',   updated_at = now() WHERE id = 'kaiqi'   AND email IS NULL`,
      `UPDATE registry_people SET email = 'hardik@bhanetwork.org',  updated_at = now() WHERE id = 'hardik'  AND email IS NULL`,
      `UPDATE registry_people SET email = 'kavin@bhanetwork.org',   updated_at = now() WHERE id = 'kavin'   AND email IS NULL`,
      `UPDATE registry_people SET email = 'destiny@bhanetwork.org', updated_at = now() WHERE id = 'destiny' AND (email IS NULL OR email = 'destinyarupi@gmail.com')`,

      /**
       * Two roster corrections from the same conversation (2026-09-16,
       * Destiny): Jason owns no loop lane and the column read empty, where what
       * it should say is what he actually does — CEO. And Ahad's role named
       * North Star, which is not his; CS Twin is.
       *
       * Both are guarded on the exact value the seed wrote, so an edit somebody
       * has since made in the interface is never overwritten. Nothing happens
       * twice: `schema_migrations` sees to that, and the guard sees to it again
       * if a database is ever rebuilt from an older dump.
       */
      `UPDATE registry_people SET lanes_owned = ARRAY['CEO'], updated_at = now() WHERE id = 'jason' AND (lanes_owned IS NULL OR cardinality(lanes_owned) = 0)`,
      `UPDATE registry_people SET role = 'CS Twin', updated_at = now() WHERE id = 'ahad' AND role = 'North Star / CS Twin'`,
    ],
  },
  {
    id: 13,
    name: 'the tools registry gets its plans, its currency, and Genie its real host',
    statements: [
      /**
       * Corrections Destiny gave on 15 Sep and I had not written (2026-09-16).
       * Same shape as migration 12 and for the same reason: `seedRegistry`
       * inserts `ON CONFLICT (id) DO NOTHING`, so the seed alone reaches a
       * fresh database and no other. Every statement is guarded on the exact
       * seeded value, so an edit made in the interface survives.
       *
       * **Genie's host.** The seed carried
       * `genie-v3-migration.onrender.com`, with a note saying no live Render
       * service reports it. Slack settles it: that hostname never resolved and
       * was ruled out as either live service after reading the Render API
       * directly, and Kaiqi confirmed `genie-v3-migration-u82u` as the
       * canonical deployment before ask_genie was repointed to it. The service
       * row and the endpoint row both move, because a stale host in two places
       * is two chances to call the wrong one.
       */
      `UPDATE registry_services SET name = 'BHARAG', updated_at = now() WHERE id = 'bharag' AND name = 'BHARAG cluster'`,
      `UPDATE registry_services
          SET url = 'https://genie-v3-migration-u82u.onrender.com',
              notes = 'Host corrected on 16 Sep 2026. genie-v3-migration.onrender.com never resolved and was ruled out as either live service against the Render API; Kaiqi confirmed genie-v3-migration-u82u as the canonical deployment before ask_genie was repointed to it.',
              updated_at = now()
        WHERE id = 'genie-v3' AND url = 'https://genie-v3-migration.onrender.com'`,
      `UPDATE registry_endpoints
          SET url = 'https://genie-v3-migration-u82u.onrender.com/api/genie/messages',
              notes = 'Repointed 16 Sep 2026 to the canonical Genie deployment. The host recorded before this never resolved.',
              updated_at = now()
        WHERE id = 'ep-genie-messages' AND url = 'https://genie-v3-migration.onrender.com/api/genie/messages'`,

      /** The plans Destiny opened these accounts on. */
      `UPDATE registry_services SET plan = 'Free', updated_at = now() WHERE id = 'airtable' AND plan IS NULL`,
      `UPDATE registry_services SET plan = 'Free', updated_at = now() WHERE id = 'google-workspace' AND plan IS NULL`,
      `UPDATE registry_services SET plan = 'Pay as you go', updated_at = now() WHERE id = 'openrouter' AND plan IS NULL`,

      /**
       * AWS. Added with no cost and no cycle on purpose: Destiny said it is in
       * use, not what it costs, and a figure nobody supplied is exactly what
       * section 2 forbids. It shows as unpriced on the spend card until
       * somebody fills it in, which is the honest state.
       */
      `INSERT INTO registry_services (id, name, category, what_it_is_for, url, billing_owner, cost_currency, status, notes, created_at, updated_at)
       VALUES ('aws', 'AWS', 'hosting', 'Cloud infrastructure alongside Render.', 'https://console.aws.amazon.com', 'BHA', 'USD', 'active',
               'Added on Destiny''s instruction, 16 Sep 2026. No cost or billing cycle is recorded because none was given; it counts as unpriced on the spend card until one is.', now(), now())
       ON CONFLICT (id) DO NOTHING`,

      /**
       * "Currency for all of them is in dollars" and "who pays, just put BHA".
       * Both only where the cell is empty — a currency or an owner somebody
       * typed is theirs.
       */
      `UPDATE registry_services SET cost_currency = 'USD', updated_at = now() WHERE cost_currency IS NULL AND deleted_at IS NULL`,
      `UPDATE registry_services SET billing_owner = 'BHA', updated_at = now() WHERE billing_owner IS NULL AND deleted_at IS NULL`,
    ],
  },
  {
    id: 14,
    name: 'client requests are mirrored like every other record kind',
    statements: [
      /**
       * `Client Requests` (`tblhu29KejAPQfSuy`) appeared in the client research
       * base on 17 Sep 2026, for LOOP-1789590960971-EHF9.
       *
       * Same shape as every other mirror table: the record id is the key, the
       * whole `fields` blob is stored, and nothing is renamed. There is no
       * natural id — the table's own `Created` column is an Airtable
       * autoNumber, which belongs to Airtable rather than to the engine, so it
       * is not a key this database can rely on.
       *
       * `lane_id` is promoted out of the blob because a request names the lane
       * it belongs to and the page groups on it, the same way client questions
       * do.
       */
      `CREATE TABLE IF NOT EXISTS engine_client_requests (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         table_id            text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_client_requests_lane ON engine_client_requests (lane_id)`,
    ],
  },

  {
    id: 15,
    name: 'the twins get their own ask ledgers and a research job queue',
    statements: [
      /**
       * North Star and Research Twin write to new Airtable ledgers as of
       * 17 Sep 2026 — one row per ask in each, plus a research queue that is
       * one row per *job* rather than one per attempt.
       *
       * These are new tables rather than a reshaping of `engine_ns_records` and
       * `engine_rt_attempts`. Those two hold the legacy tables' rows, which are
       * real history: the rule is that nothing drops a table, so they stay
       * exactly where they are, unread, like the `records` read model and
       * `registry_credentials` before them. Nothing in this code reads or
       * writes them any more.
       *
       * `natural_id` is `Ask ID` / `Job ID`, which are unique per row in all
       * three — unlike the queue this replaces, where `card_id` repeated across
       * attempts and could not identify a row. `lane_id` is promoted because
       * every page here groups by lane; `card_id` because a Research Twin ask
       * and a job both name the card they are about.
       */
      `CREATE TABLE IF NOT EXISTS engine_ns_asks (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_ns_asks_natural ON engine_ns_asks (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_rt_asks (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_rt_asks_natural ON engine_rt_asks (natural_id)`,

      /**
       * A job is updated in place — its status, attempts and finding all change
       * as it is worked — so this table is written far more often than it is
       * inserted into. That is the ordinary upsert path and needs nothing
       * special; it is the reason the queue cannot be kept current by ask
       * mirrors alone, which is why the resync sweeps this table too.
       */
      `CREATE TABLE IF NOT EXISTS engine_rt_jobs (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_rt_jobs_natural ON engine_rt_jobs (natural_id)`,
    ],
  },

  {
    id: 16,
    name: 'engine health: the incident ledger, its occurrence counts and its retries',
    statements: [
      /**
       * Engine Health's three tables (2026-09-17).
       *
       * `engine_incidents` is the odd one: its rows come from **BHARAG**, not
       * Airtable, so there is no `airtable_record_id` to key on and
       * `natural_id` holds the ledger's own `entity_id`. It keeps the mirror
       * shape anyway — `fields` stored whole, names verbatim — because that is
       * the one way a row gets in, and a second shape would drift from it.
       *
       * Two columns beyond the mirror standard, and they are the sweep's rather
       * than the payload's:
       *
       *   `open_now`        whether the lane's open query still returns it.
       *   `last_seen_open`  when it was last in that answer.
       *
       * They exist because **the ledger is read with `status=open`**, so an
       * incident that has been closed simply stops appearing. Deleting those
       * would throw away every resolved incident — which is exactly the history
       * the time-to-resolve figure is computed from. So nothing is deleted:
       * a row the open read no longer returns is marked closed-since, and only
       * ever by a read that actually succeeded.
       */
      `CREATE TABLE IF NOT EXISTS engine_incidents (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL,
         open_now            boolean NOT NULL DEFAULT true,
         last_seen_open      text
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_incidents_entity ON engine_incidents (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_incidents_open ON engine_incidents (open_now, lane_id)`,

      /** One row per fault signature, shared by all three lanes. */
      `CREATE TABLE IF NOT EXISTS engine_error_counts (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_error_counts_natural ON engine_error_counts (natural_id)`,

      /**
       * One row per incident the healer has touched. `natural_id` is the
       * incident id, which is unique in this table by the healer's own
       * contract — it updates the row rather than adding one per attempt.
       */
      `CREATE TABLE IF NOT EXISTS engine_retry_attempts (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_retry_attempts_natural ON engine_retry_attempts (natural_id)`,
    ],
  },

  {
    id: 17,
    name: 'the pay ledger: builders, approved sessions and monthly statements',
    statements: [
      /**
       * The BHA Pay Ledger (2026-09-17). Three tables, all keyed on a real id
       * of their own, so all three key on the natural id as well as the record
       * id.
       *
       * Nothing here holds an amount, and nothing here should ever be asked to:
       * the ledger counts work, not money. If a rate arrives it goes on the
       * Builders row, and this schema would need a migration of its own to
       * carry it — which is the point of saying so here rather than leaving a
       * spare column somebody might fill.
       */
      `CREATE TABLE IF NOT EXISTS engine_pay_builders (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_pay_builders_natural ON engine_pay_builders (natural_id)`,

      /**
       * `natural_id` is the Codex entry id, which is one session. The rows are
       * only ever created by a session being approved — nothing writes here by
       * hand — which is what keeps the ledger in line with the session logs.
       */
      `CREATE TABLE IF NOT EXISTS engine_pay_sessions (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_pay_sessions_natural ON engine_pay_sessions (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_pay_statements (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_pay_statements_natural ON engine_pay_statements (natural_id)`,
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
