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

  {
    id: 18,
    name: 'vfarm early access leads',
    statements: [
      /**
       * The receiving end of the vFarm Early Access funnel (2026-09-20).
       *
       * **This table is not a mirror and does not look like one.** Every other
       * `engine_*` table here holds `{ airtable_record_id, created_time, fields }`
       * because the engine owns those rows and this dashboard copies them. These
       * rows are born here: the static site posts to this server, this server
       * writes them, and nothing upstream has a copy. So the columns are real
       * columns rather than a jsonb blob — there is no Airtable field name to
       * keep verbatim, and section 4's rule about not renaming what the engine
       * writes does not apply to a row the engine never wrote.
       *
       * **`email` is deliberately not unique.** A person may express interest
       * twice, and the second time is a fact about them worth seeing. A unique
       * constraint would either reject the submission — losing the signal and
       * telling a stranger their address is already on file — or silently drop
       * it. Repeats are stored and flagged at read time instead.
       *
       * **What this table records is an expression of interest and nothing
       * else.** There is no subscriber, payment, entitlement, reservation or
       * delivery column, and none should be added here: a state like that
       * belongs to whatever system actually owns it. `status` is this
       * dashboard's own note to itself about whether anyone has replied.
       *
       * `ip_hash` is a salted digest, never an address. It exists for the rate
       * limiter and for telling one flood apart from twenty real people; it
       * cannot be turned back into who somebody is.
       */
      `CREATE TABLE IF NOT EXISTS engine_vfarm_leads (
         id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         full_name                   text NOT NULL,
         email                       text NOT NULL,
         organization_name           text,
         source_surface              text NOT NULL,
         source_page                 text,
         source_campaign             text,
         page_contract_version       text,
         mechanics_contract_version  text,
         claim_state                 text,
         status                      text NOT NULL DEFAULT 'new',
         notes                       text,
         notified_at                 timestamptz,
         submitted_at                timestamptz,
         created_at                  timestamptz NOT NULL DEFAULT now(),
         user_agent                  text,
         ip_hash                     text
       )`,

      /** The repeat-email flag is computed over this index on every read. */
      `CREATE INDEX IF NOT EXISTS engine_vfarm_leads_email ON engine_vfarm_leads (email)`,
      /** Newest first is the only order this list is ever shown in. */
      `CREATE INDEX IF NOT EXISTS engine_vfarm_leads_created ON engine_vfarm_leads (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_leads_status ON engine_vfarm_leads (status)`,
    ],
  },

  {
    id: 19,
    name: 'the MCP write audit log',
    statements: [
      /**
       * Every write that goes through the MCP write gate, before it returns
       * (2026-09-20).
       *
       * **The whole premise of this dashboard is that the record cannot lie,
       * and a write path with no record of itself undercuts that.** So the row
       * is written by the gate rather than by each tool, and it is written for
       * the refusals too: an expired token, a replay and a record that changed
       * underneath a preview are all outcomes worth being able to count later.
       *
       * `before` and `after` are stored whole rather than as a summary. A diff
       * computed at read time can be recomputed; a diff stored instead of its
       * operands cannot be checked.
       *
       * Append-only by convention and by having nothing that updates it. It is
       * a log, and a log somebody can edit is a draft.
       */
      `CREATE TABLE IF NOT EXISTS engine_mcp_writes (
         id          bigserial PRIMARY KEY,
         at          timestamptz NOT NULL DEFAULT now(),
         tool        text NOT NULL,
         arguments   jsonb NOT NULL DEFAULT '{}'::jsonb,
         digest      text NOT NULL,
         token       text,
         idempotency_key text,
         target      text,
         before      jsonb,
         after       jsonb,
         outcome     text NOT NULL,
         detail      text,
         actor       text
       )`,
      `CREATE INDEX IF NOT EXISTS engine_mcp_writes_at ON engine_mcp_writes (at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_mcp_writes_tool ON engine_mcp_writes (tool)`,
      /**
       * An idempotency key is claimed once per tool. The unique index is what
       * makes the claim atomic — two identical creates racing cannot both
       * insert, so the loser reads the winner's row and returns its result
       * rather than acting twice.
       */
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_mcp_writes_idem ON engine_mcp_writes (tool, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    ],
  },

  {
    id: 20,
    name: 'the repair record: one row per automated repair attempt',
    statements: [
      /**
       * Every repair the bridge attempts, whatever came of it (2026-09-20).
       *
       * **Not a mirror table**, for the same reason `engine_vfarm_leads` is
       * not: these rows are born of this engine's own repair loop rather than
       * copied out of Airtable, so there is no upstream field name to keep
       * verbatim and the columns are real columns.
       *
       * **`repair_id` is unique because the bridge may report twice.** It
       * posts once when a run finishes, and n8n retries a failed HTTP node, so
       * the same result arriving again must update the row rather than add a
       * second one. The read model is keyed on the bridge's own id for exactly
       * the reason the execution table is keyed on n8n's: a counter cannot
       * notice it is being told the same thing twice, and a primary key cannot
       * fail to.
       *
       * **`outcome` is the whole truth of a repair and nothing else is.** A
       * repair counts as done only where the bridge says `repaired` *and* a
       * `version_after` came back — the bridge having been called is not a
       * repair, and a run that could not report its own result is recorded as
       * needing a person rather than assumed to have worked.
       *
       * **`payload` holds what the bridge sent, whole.** The named columns are
       * the read model; the blob is the record. A field the bridge adds before
       * this dashboard reads it is kept rather than dropped, on the same rule
       * that keeps `retries_attempted` inside the incident blob with no way
       * onto the page. It is also where a pre-repair workflow snapshot lives if
       * the bridge sends one — see `server/src/repairs.ts` for why a revert
       * needs the nodes and not only the version id.
       *
       * **`reverted_at` and `reverted_by` are this dashboard's own.** The
       * bridge never writes them: a revert is something a person did here, and
       * it is stamped only once n8n has actually taken the older version back.
       */
      `CREATE TABLE IF NOT EXISTS engine_repairs (
         id             bigserial PRIMARY KEY,
         repair_id      text NOT NULL UNIQUE,
         outcome        text NOT NULL,
         workflow_id    text,
         workflow_name  text,
         failed_node    text,
         error_class    text,
         error_message  text,
         execution_id   text,
         root_cause     text,
         change_summary text,
         nodes_changed  jsonb NOT NULL DEFAULT '[]'::jsonb,
         human_action   text,
         version_before text,
         version_after  text,
         duration_ms    integer,
         report_channel text,
         payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
         started_at     timestamptz,
         finished_at    timestamptz,
         reverted_at    timestamptz,
         reverted_by    text,
         created_at     timestamptz NOT NULL DEFAULT now()
       )`,
      /** Newest first is the only order this list is ever shown in. */
      `CREATE INDEX IF NOT EXISTS engine_repairs_created ON engine_repairs (created_at DESC)`,
      /** Every repair of one workflow, which is how a workflow being repaired repeatedly becomes visible. */
      `CREATE INDEX IF NOT EXISTS engine_repairs_workflow ON engine_repairs (workflow_id)`,
      `CREATE INDEX IF NOT EXISTS engine_repairs_outcome ON engine_repairs (outcome)`,
    ],
  },
  {
    id: 21,
    name: 'four tables Bays reads that were never mirrored',
    statements: [
      /**
       * Four Airtable tables the Bays workflows use that this dashboard has
       * never held a copy of (2026-09-22). They are being mirrored now because
       * Bays is the second system to come off Airtable — ~19 workflows and
       * 100+ Airtable nodes — and a node with nowhere to point cannot be cut
       * over.
       *
       * **These four are engine-only.** Nothing resyncs them, there is no page
       * that reads them, and after the cutover Airtable holds no newer copy —
       * n8n writes here and reads here. `SOURCE_OF` in mcp/inventory.ts says so
       * explicitly for each, because a kind that quietly has no way to be
       * refreshed is exactly the fault that module exists to stop.
       *
       * Same shape as every other mirror table: Airtable's own field names
       * verbatim inside `fields`, `airtable_record_id` unique and nullable
       * because most of these rows will never have one, `natural_id` indexed
       * and not unique.
       */

      /**
       * `channel_tracking` (apprzpppxE2yV0q84 / tblboJRTsFSkHW0ra) — one row
       * per tracked Slack channel and the capture doc it is currently writing
       * into. `Bays — Message Capture` looks this up on **every Slack message**,
       * which is why it is first: that workflow has been failing since the
       * Airtable cap hit at about 23:00 UTC on 20 Sep, so no Slack message has
       * been archived since. `channel_id` is the natural id and is what the
       * lookup will be keyed on.
       */
      `CREATE TABLE IF NOT EXISTS engine_channel_tracking (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_channel_tracking_natural ON engine_channel_tracking (natural_id)`,

      /**
       * `review_returns` (appEmdKshNVTl64Zf / tblStfkeUZH7n2vmt) — the
       * send-back rounds on a submitted log, one row per round. It carries no
       * id of its own that this dashboard can name, so **n8n supplies the
       * natural id in the envelope**; see `natural_id` on MirrorInput.
       */
      `CREATE TABLE IF NOT EXISTS engine_review_returns (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_review_returns_natural ON engine_review_returns (natural_id)`,

      /**
       * `lane_backlog` and `deep_think_log`, both in the Bays Tools Router base
       * (appMNvZsFRb9isRRq). Their table ids are not written down here: nothing
       * in this server reads Airtable for either, so a table id would be a
       * constant with no caller, and a constant with no caller is one nobody
       * notices going stale. The base is named in the System Registry.
       */
      `CREATE TABLE IF NOT EXISTS engine_lane_backlog (
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
      `CREATE INDEX IF NOT EXISTS engine_lane_backlog_natural ON engine_lane_backlog (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_lane_backlog_lane ON engine_lane_backlog (lane_id)`,

      `CREATE TABLE IF NOT EXISTS engine_deep_think_log (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_deep_think_natural ON engine_deep_think_log (natural_id)`,

      /**
       * The three bases these tables live in are already registry rows, seeded
       * with no notes. Filled in here rather than in the seed, because seeding
       * is ON CONFLICT DO NOTHING and would never reach a row that exists.
       *
       * Guarded on the notes still being empty, the same way migration 4 guards
       * the engine_events row: if Destiny has already written something there,
       * the WHERE matches nothing and his wording stands.
       */
      `UPDATE registry_airtable_bases
          SET notes = 'Channel Tracking (tblboJRTsFSkHW0ra) is one row per tracked Slack channel and the capture doc it is currently writing into. Bays — Message Capture reads it on every Slack message. Mirrored to this dashboard at POST /api/engine/channel_tracking from 22 Sep 2026, keyed on channel_id; after the Bays cutover that mirror is the record and this base is history.',
              updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'apprzpppxE2yV0q84' AND (notes IS NULL OR notes = '')`,
      `UPDATE registry_airtable_bases
          SET notes = 'Lane Backlog and Deep Think Log, both read and written by the Bays Tools Router. Mirrored to this dashboard at POST /api/engine/lane_backlog and POST /api/engine/deep_think_log from 22 Sep 2026. Neither carries an id this dashboard can derive, so n8n supplies "natural_id" in the envelope. Nothing here resyncs them and no table id is recorded: this server never reads this base.',
              updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'appMNvZsFRb9isRRq' AND (notes IS NULL OR notes = '')`,
      `UPDATE registry_airtable_bases
          SET notes = 'Codex entries and the Layer 0 completeness gate, one table per builder, plus Review Returns (tblStfkeUZH7n2vmt) — the send-back rounds on a submitted log, mirrored at POST /api/engine/review_returns from 22 Sep 2026 with the natural id supplied by n8n. The token needs read and write here for the Codex page''s own edits.',
              updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'appEmdKshNVTl64Zf' AND (notes IS NULL OR notes = '')`,
    ],
  },
  {
    id: 22,
    name: 'builder profiles and pattern candidates',
    statements: [
      /**
       * Two more Airtable-backed kinds (2026-09-23), and unlike migration 21's
       * four these are **not** engine-only: both hold real rows in Airtable
       * today, both are swept by a resync, and both are in the final import.
       *
       * **`builder_profiles` (app6wGosV52Ur4mIF / tblsgl1O3iskbrR8t) is the
       * one that unblocks onboarding.** Loops and Codex entries resolve their
       * owner from the seven fixed tables in `sources.ts`, and
       * `Bays — Onboarding` creates a new builder's table through Airtable's
       * Meta API — which stops working the moment Airtable is retired, and
       * would need a code change and a deploy either way. With a profile row,
       * a new builder's loops and Codex entries are accepted on their Slack id
       * with no table at all. `user_id` is the Slack id and is the natural id.
       *
       * **`pattern_candidates` (app5ni3E8r7Lvxk22 / tblqTkT6hEWESdd1y)** sits
       * in the Build Patterns base and is swept by that page's resync, the way
       * Research Twin's one button sweeps its ask ledger and its job queue.
       * Its ids are minted by n8n as `CAND-<ms>-<4>` and are not a column this
       * dashboard can name, so they arrive as `natural_id` in the envelope.
       */
      `CREATE TABLE IF NOT EXISTS engine_builder_profiles (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      /**
       * Unique, unlike every other mirror table's `natural_id`, and
       * deliberately: a Slack id names one person, two profile rows for one id
       * is a fault rather than a state, and this table is about to decide who
       * owns a loop. The other tables leave it non-unique because a row the
       * engine wrote before Airtable had one can legitimately sit beside the
       * Airtable copy until the two are adopted; a profile has no such phase.
       */
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_builder_profiles_natural ON engine_builder_profiles (natural_id)`,

      `CREATE TABLE IF NOT EXISTS engine_pattern_candidates (
         id                  bigserial PRIMARY KEY,
         airtable_record_id  text UNIQUE,
         natural_id          text,
         lane_id             text,
         builder_id          text,
         created_time        text,
         fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
         source              text NOT NULL,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_pattern_candidates_natural ON engine_pattern_candidates (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_pattern_candidates_lane ON engine_pattern_candidates (lane_id)`,

      /**
       * The profiles base is new to the registry; the Build Patterns base is
       * already a row and gains a mention of its second table. Both guarded on
       * the notes still being what they are now, so a wording Destiny has
       * since written by hand stands — the rule migration 21 follows.
       */
      `INSERT INTO registry_airtable_bases (id, name, what_it_is_for, url, notes, created_at, updated_at)
       VALUES ('app6wGosV52Ur4mIF', 'BHA Builder Profiles',
               'One row per builder: name, pronouns, lane, role and Slack user id.',
               'https://airtable.com/app6wGosV52Ur4mIF',
               'Builder Profiles (tblsgl1O3iskbrR8t), keyed on user_id — the Slack id. Mirrored at POST /api/engine/builder_profiles from 23 Sep 2026, and it is what makes onboarding a row rather than a deploy: a loop or Codex entry is accepted on a builder_id this table knows, with no Airtable table of their own. Bays — Onboarding should write the profile first and everything else follows.',
               to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       ON CONFLICT (id) DO NOTHING`,
      `UPDATE registry_airtable_bases
          SET notes = 'Build Patterns (tblaMXSMjmz30OvcU) and Pattern Candidates (tblqTkT6hEWESdd1y) — a candidate is a pattern somebody flagged and an architect has not yet turned into one. Both are swept by the Build patterns page''s one Resync from Airtable, and both are in the final import. Candidate ids are minted by n8n as CAND-<ms>-<4> and arrive as "natural_id" in the envelope, because they are not a column this dashboard can name.',
              updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'app5ni3E8r7Lvxk22' AND (notes IS NULL OR notes = '')`,
    ],
  },

  {
    id: 23,
    name: 'attribution on a vFarm Early Access lead',
    statements: [
      /**
       * Where a lead actually came from (2026-09-22, Subscription Mechanics
       * v0.2.2 §3 and §17.1).
       *
       * Every clip between now and 31 Oct points at /vfarm, and until now a
       * row could not say which clip. These eight columns are what the site
       * captures from the URL it was opened with, plus the two the contract
       * fixes: `source_campaign` (already present) and `contract_version`.
       *
       * They default to '' rather than NULL because the site stores an empty
       * string for a value the URL did not carry — and "the URL did not say"
       * is a different fact from "nobody has looked", which is what NULL means
       * on the rows written before this migration. Existing rows keep their
       * NULLs for exactly that reason.
       */
      `ALTER TABLE engine_vfarm_leads
         ADD COLUMN IF NOT EXISTS utm_source      text,
         ADD COLUMN IF NOT EXISTS utm_medium      text,
         ADD COLUMN IF NOT EXISTS utm_campaign    text,
         ADD COLUMN IF NOT EXISTS asset_id        text,
         ADD COLUMN IF NOT EXISTS source_channel  text,
         ADD COLUMN IF NOT EXISTS landing_variant text,
         ADD COLUMN IF NOT EXISTS contract_version text`,

      /** The two a person actually filters a campaign report by. */
      `CREATE INDEX IF NOT EXISTS engine_vfarm_leads_campaign ON engine_vfarm_leads (source_campaign)`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_leads_asset ON engine_vfarm_leads (asset_id)`,
    ],
  },
  {
    id: 24,
    name: 'registry workflows brought in step with n8n',
    statements: [
      /**
       * Three workflow rows the live n8n list contradicts (2026-09-22). Each
       * update fires only while the row still holds the value the seed gave
       * it, so an edit made on the page is never overwritten.
       */
      `UPDATE registry_workflows SET name = 'Bays — Builder Chasers', notes = concat_ws(' ', notes, 'Renamed in n8n from Bays — Parked Log Reminder; name brought in step 2026-09-22.'), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'lEyirYDareupAmlB' AND name = 'Bays — Parked Log Reminder'`,
      `UPDATE registry_workflows SET name = 'vFarm Early Access Lead → Buyer Link [MIGRATED]', notes = concat_ws(' ', notes, 'n8n marks this [MIGRATED]; the live notifier is vFarm Early Access — Lead Notifier. Name brought in step 2026-09-22.'), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'fhQNvRFdh1H6Li0E' AND name = 'vFarm Early Access Lead → Buyer Link'`,
      `UPDATE registry_workflows SET status = 'retired', notes = concat_ws(' ', notes, 'Not in the live n8n workflow list on 2026-09-22 — deleted or archived there.'), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'aPP4AMtcB4xmOSCW' AND status = 'production'`,
    ],
  },  {
    id: 25,
    name: 'registry: folder, trigger and owner for the rows added on 22 Sep',
    statements: [
      /**
       * The 13 workflow rows seeded on 2026-09-22 with folder, owner and
       * trigger left null (Destiny's brief, item 5). Folder is each
       * workflow's parentFolderId resolved through the project's folders;
       * trigger is its own trigger nodes; owner is the convention every BHA
       * Engine row follows, since n8n records no owner on a team-project
       * workflow. What n8n could not say stays null and the note says which.
       * Each update fires only while the row still carries the seeded note,
       * so a row edited on the page is left alone.
       */
      `UPDATE registry_workflows SET folder = $v$Engine Self-Healing$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$sub-workflow + webhook$v$, trigger_detail = $v$Handed every failure by the three error handlers; POST /webhook/engine-heal (Retry now, moved here 22 Sep)$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'oOAZaW1aQaRP2arc' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Engine Self-Healing$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/repair-result$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'wZpWp9ov6exxoez0' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = NULL, owner = $v$Destiny Arupi$v$, trigger_type = $v$schedule + webhook$v$, trigger_detail = $v$Every 5 minutes; POST /webhook/engine-heal$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow. Archived in n8n, so its folder cannot be read. Its /webhook/engine-heal trigger moved to BHA — Self Healer on 22 Sep, which is what Retry now reaches.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = '3Pzm0DlJZSNu6DU4' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated. Inactive in n8n. Its webhook /webhook/engine-heal is what this dashboard's Retry now posts to, so Retry now is not live while it is off.$v$`,
      `UPDATE registry_workflows SET folder = $v$Sandbox (For Testing & One-Off Builds)$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/heal-test-bays-0921$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'MtjakyCf90lgah7S' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Sandbox (For Testing & One-Off Builds)$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/heal-test-ns-0921$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'xIVt2cO0VHDJ7jT6' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Sandbox (For Testing & One-Off Builds)$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/heal-test-rt-0921$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = '4beRTMIlgJ0njPna' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Pay$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$schedule + sub-workflow$v$, trigger_detail = $v$Called by Bays — Submit Actions on each approval; 1st of the month 09:00; Mondays 10:00$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'LR7M1POhHvJ0j7Vm' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Pay$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$schedule$v$, trigger_detail = $v$Every 30 minutes$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 't79s1mXSHink3dAM' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Open Loops$v$, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/dashboard-loop-writeback (X-N8N-API-KEY header)$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'GES8UIM3dJRbrLSx' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$vFarm$v$, owner = NULL, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/vfarm-early-access-lead, called by this dashboard on a new Early Access lead$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow. Owner left blank: the one comparable row, the vFarm lead workflow it replaced, is Hardik Bhatt's, while this one was built for the dashboard — two conventions, so no owner is assumed.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'xxME1VLRkPdlLpaV' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = NULL, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/geniecontexttest-20260918220730-a7k9m2$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow. In Destiny Arupi's personal n8n project, at its root, not in the BHA Engine project — so no folder, and the owner is that project's.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'rt2oje925OyiSttf' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      `UPDATE registry_workflows SET folder = $v$Sandbox (For Testing & One-Off Builds)$v$, owner = $v$Destiny Arupi$v$, trigger_type = NULL, trigger_detail = NULL, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow. Trigger not read: MCP access is turned off on this workflow in n8n. A one-off job, inactive; n8n carries no description for it.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'N9kIvHF8Vohy8OeM' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated. A one-off job, inactive; n8n carries no description for it.$v$`,
      `UPDATE registry_workflows SET folder = NULL, owner = $v$Destiny Arupi$v$, trigger_type = $v$webhook$v$, trigger_detail = $v$POST /webhook/oneoff-vfarm-clip-patterns-d565$v$, notes = $v$Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow's own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow. At the root of the BHA Engine project, in no folder.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'PEdHH8OZuplhTidg' AND notes = $v$Added 2026-09-22 from the live n8n workflow list. System chosen from the workflow name; folder, owner and trigger were not read unless stated.$v$`,
      /*
       * The engine-heal endpoint: its webhook moved to BHA — Self Healer on
       * 22 Sep, so it is live again, and the old note said it was not.
       */
      `UPDATE registry_endpoints SET notes = $v$Owned by BHA — Self Healer since 22 Sep, when the webhook moved there from Engine — Self-Healing Retry (archived in n8n).$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'ep-engine-heal' AND notes = $v$Owned by Engine — Self-Healing Retry, which is inactive in n8n, so this production webhook is not live.$v$`,
    ],
  },  {
    id: 26,
    name: 'vFarm leads: every Form A answer, and the buyer_intake_id upsert key',
    statements: [
      /**
       * Every Early Access lead now arrives through Hardik's Form A, pushed by
       * his n8n tracker to POST /api/engine/vfarm-leads (2026-09-23, Destiny).
       * Name, email and organisation keep their columns; everything else Form A
       * asked, and the tracker's identifiers, go in one jsonb blob, stored as
       * sent — twenty-three answers are what a person said, and a column per
       * question would be a migration every time Hardik edits the form.
       *
       * Rows written by the old public route have no blob and keep NULL, which
       * reads as "this lead predates Form A", not as a lead who answered
       * nothing.
       */
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS form_a jsonb`,
      /**
       * The upsert key. The tracker's buyer_intake_id is derived from the
       * normalised email and the Form A timestamp, so the same submission
       * posted twice — an n8n retry, a re-run — carries the same id and must
       * land on one row. Partial, because the public route's rows have none.
       */
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_vfarm_leads_buyer_intake
         ON engine_vfarm_leads ((form_a->>'buyer_intake_id'))
         WHERE form_a ? 'buyer_intake_id'`,
    ],
  },  {
    id: 27,
    name: 'registry: Airtable is a retired service',
    statements: [
      /**
       * Airtable was retired from the engine on 21 Sep 2026 (AIRTABLE_RETIRED),
       * and the registry still called it active with "ten bases in use". Kept as
       * a registry entry — it is a tool BHA paid for — marked retired. Only
       * while the row still holds the seeded values, so a page edit wins.
       */
      `UPDATE registry_services
          SET status = 'retired',
              what_it_is_for = 'Was the system of record for open loops, submissions, the research queue, build patterns, commercial cards and lane state.',
              notes = 'Retired 21 Sep 2026: every record now lives in this dashboard, written by n8n through /api/engine. Its bases are kept as history on the Endpoints tab.',
              updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'airtable' AND status = 'active' AND notes = 'Ten bases are in use; they are listed on the Endpoints tab.'`,
    ],
  },
  {
    id: 28,
    name: 'engine recovery: one row per waiting incident, one per batch, and a replay policy per workflow',
    statements: [
      /**
       * The recovery watcher (2026-09-23, Destiny). **The ledger is the queue**:
       * nothing here holds a payload to replay — n8n still holds each failed
       * run's input, and the healer resumes it from the failed step. This table
       * is only what the watcher decided about each incident and what came of
       * it, so the page and the Slack summary can say so.
       *
       * One row per incident, keyed on the ledger's own id, so an incident is
       * recovered at most once: a failed_again row stays failed_again and is
       * never picked up a second time — a person owns it from there.
       */
      `CREATE TABLE IF NOT EXISTS engine_recovery (
         incident_id        text PRIMARY KEY,
         lane               text,
         workflow           text,
         workflow_id        text,
         execution_id       text,
         failed_node        text,
         error_class        text,
         error_message      text,
         failed_at          text,
         dependency         text NOT NULL,
         dependency_from    text,
         status             text NOT NULL,
         batch_id           text,
         retry_execution_id text,
         note               text,
         replay_started_at  text,
         first_seen_at      text NOT NULL,
         updated_at         text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_recovery_status ON engine_recovery (status)`,
      `CREATE INDEX IF NOT EXISTS engine_recovery_batch ON engine_recovery (batch_id)`,
      /**
       * One row per batch — the dependency that came back, who or what started
       * it, and the one summary it sent. `summary_sent_at` is what makes the
       * summary go **once**: it is set in the same statement that claims it.
       */
      `CREATE TABLE IF NOT EXISTS engine_recovery_batches (
         batch_id        text PRIMARY KEY,
         dependency      text NOT NULL,
         started_by      text NOT NULL,
         probe           jsonb,
         started_at      text NOT NULL,
         settled_at      text,
         summary_sent_at text,
         summary_http    integer,
         summary_detail  text,
         runs            jsonb
       )`,
      /**
       * Replay policy per workflow. `never` for the chat replies: re-running one
       * hours later answers a person who has long since moved on, in a thread
       * that has moved on too. Everything else re-runs.
       */
      `ALTER TABLE registry_workflows ADD COLUMN IF NOT EXISTS replay text NOT NULL DEFAULT 'auto'`,
      `UPDATE registry_workflows SET replay = 'never', updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE name IN ('Bays — Conversational Agent', 'Bays — Front Door', 'Bays — Dashboard Agent', 'North Star — Conversational Agent', 'North Star — Front Door')`,
    ],
  },
  {
    id: 29,
    name: 'engine_mcp_writes: the MCP write tools\' audit columns',
    statements: [
      /**
       * The MCP write tools (2026-09-24, Destiny) audit into the table the
       * write gate already made on 20 Sep rather than a second one with the
       * same name: one log of what MCP changed, whichever path changed it.
       *
       * `access` is the brief's "token" column — `read` or `write`, which MCP
       * URL the call came in on. It cannot be called `token`: that column
       * already holds the gate's one-use preview token and means something
       * else. `digest` stays NOT NULL; the write tools fill it with a hash of
       * the call, so two identical calls are visibly identical on the log.
       */
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS access text`,
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS kind text`,
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS record_id text`,
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS natural_id text`,
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS guard_result jsonb`,
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false`,
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS requester_user_id text`,
      `CREATE INDEX IF NOT EXISTS engine_mcp_writes_kind ON engine_mcp_writes (kind, at DESC)`,
    ],
  },
  {
    id: 30,
    name: 'registry: Bays moves to the n8n Agent — four workflows retired, Agent Delivery serves Ask Bays',
    statements: [
      /**
       * 24 Sep 2026, Destiny. Bays is the n8n Agent Nw5igXu4WWrjUMWB behind
       * Bays — Front Door → Bays — Agent Delivery (5AFqtZQaeKFFiGqe), which the
       * seed adds on boot. The Conversational Agent, Tools Router, Extra Tools
       * and Dashboard Agent are unpublished. Each update fires only while the
       * row is still in production, so an edit made on the page is kept.
       */
      `UPDATE registry_workflows SET status = 'retired', notes = concat_ws(' ', notes, $v$Unpublished in n8n on 24 Sep 2026 when Bays moved to the n8n Agent (Nw5igXu4WWrjUMWB) behind Bays — Front Door → Bays — Agent Delivery.$v$), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id IN ('rKRnxHhKSJUd4Q6M', 'WjWzhVRq566A60fJ', 'WZHZJ0PXEhswCvxD', 'GjNtBQQvVSJvsPNI') AND status = 'production'`,
      `UPDATE registry_endpoints SET notes = concat_ws(' ', $v$Served by Bays — Agent Delivery (5AFqtZQaeKFFiGqe) since 24 Sep 2026, credential "BHARAG - Codex"; Bays — Dashboard Agent, which served it until then, is retired. ASK_BAYS_URL is unchanged.$v$, notes), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'ep-dashboard-ask-bays' AND coalesce(notes, '') NOT LIKE '%Agent Delivery%'`,
    ],
  },
  {
    id: 31,
    name: 'registry: North Star — Tools Router retired; Agent Delivery names its MCP tools',
    statements: [
      /**
       * 24 Sep 2026, Destiny. The North Star Agent was re-tested on the three
       * dashboard MCP tools after 3954e59 — each called once, no loop — and
       * published on them, and the Tools Router (G6Myypk64kpcaVhz) was
       * unpublished. Each update fires only while the row still holds what the
       * seed gave it, so an edit made on the page is kept.
       */
      `UPDATE registry_workflows SET status = 'retired', notes = concat_ws(' ', notes, $v$Unpublished in n8n on 24 Sep 2026 and retired by Destiny, once the North Star Agent behind North Star — Agent Delivery was re-tested on read_slack, read_open_loops and get_priority_evidence on the dashboard MCP, which replace its RS, ROL and PE branches.$v$), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'G6Myypk64kpcaVhz' AND status = 'production'`,
      `UPDATE registry_workflows SET notes = $v$Added 24 Sep 2026 (id confirmed by Destiny). The North Star Agent's tools are read_slack, read_open_loops and get_priority_evidence on the dashboard MCP (live 24 Sep, 3954e59: re-tested with each called once — 19,882 / 13,438 / 19,974 chars — and no loop); the Tools Router (G6Myypk64kpcaVhz) that held them is retired.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'cnOz6iomtnWVXjso' AND notes = $v$Added 24 Sep 2026 (id confirmed by Destiny). Its tools are read_slack, read_open_loops and get_priority_evidence on the dashboard MCP, plus the Tools Router until that is retired.$v$`,
    ],
  },
  {
    id: 32,
    name: 'registry: North Star — Conversational Agent retired',
    statements: [
      /**
       * 24 Sep 2026, Destiny. seK3we7pTurvZmqe is unpublished (active:false)
       * and filed in RETIRED / NORTH STAR in n8n; North Star — Agent Delivery
       * (cnOz6iomtnWVXjso) replaced it behind the Front Door. Retired the way
       * migration 31 retired the Tools Router: only while the row is still
       * production, so an edit made on the page is kept.
       */
      `UPDATE registry_workflows SET status = 'retired', notes = concat_ws(' ', notes, $v$Unpublished (active:false) and filed in RETIRED / NORTH STAR in n8n on 24 Sep 2026, and retired by Destiny. Replaced by North Star — Agent Delivery (cnOz6iomtnWVXjso) behind the Front Door.$v$), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'seK3we7pTurvZmqe' AND status = 'production'`,
    ],
  },
  {
    id: 33,
    name: 'registry: Research Twin — Conversational Agent and the RT self-healing test retired; Tools Router noted',
    statements: [
      /**
       * 24 Sep 2026, Destiny, the way migrations 31 and 32 retired North Star's.
       * u2jfe2eRQYIEtuZQ is unpublished and filed in RETIRED / RESEARCH TWIN,
       * replaced by Research Twin (Agent) through Research Twin — Agent
       * Delivery; 4beRTMIlgJ0njPna is archived. The Tools Router keeps its
       * status and gains a note: no callers left, retired after Monday's runs.
       * Each update fires only while the row still holds what the seed gave
       * it. The two new rows — Research Twin — Agent Delivery and Bays — Slack
       * Request — arrive through the seed, replay never.
       */
      `UPDATE registry_workflows SET status = 'retired', notes = concat_ws(' ', notes, $v$Unpublished (active:false) and filed in RETIRED / RESEARCH TWIN in n8n on 24 Sep 2026, and retired by Destiny. Replaced by Research Twin (Agent) (dDtsExaaXhlFd2dv) through Research Twin — Agent Delivery (w4SdZjjpokMuWPkV).$v$), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'u2jfe2eRQYIEtuZQ' AND status = 'production'`,
      `UPDATE registry_workflows SET status = 'retired', notes = concat_ws(' ', notes, $v$Archived in n8n and retired on 24 Sep 2026 (Destiny): the Research Twin self-healing lane test is done.$v$), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = '4beRTMIlgJ0njPna' AND status = 'experimental'`,
      `UPDATE registry_workflows SET notes = $v$No remaining callers since 24 Sep 2026: all six of Research Twin's write tools are on the dashboard MCP. Still published; to be retired after Monday's Research Queue — Weekly Sweep and Watched Clients runs pass.$v$, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = 'zikfpO0wvqzPCQuz' AND notes IS NULL`,
    ],
  },
  {
    id: 34,
    name: 'engine_agent_scorecard: the agent maturity scorecard, seeded with the 27 Sep baseline',
    statements: [
      /**
       * 28 Sep 2026, Destiny — Agent Upgrade Plan Phase 0. One row per quality
       * dimension per scoring. The 27 Sep formal score is the first scoring;
       * every later one is a re-score written with its own evidence, never a
       * number typed onto the page.
       */
      `CREATE TABLE IF NOT EXISTS engine_agent_scorecard (
         scored_on   date    NOT NULL,
         dimension   integer NOT NULL,
         name        text    NOT NULL,
         score       numeric NOT NULL,
         floor       numeric NOT NULL,
         goal        numeric NOT NULL,
         evidence    text    NOT NULL,
         source      text    NOT NULL,
         recorded_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (scored_on, dimension)
       )`,
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-09-27', 1, $v$Governance and inventory$v$, 4, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 2, $v$Agent identity and secrets$v$, 3, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 3, $v$Tool privilege$v$, 5, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 4, $v$Runtime controls and injection defense$v$, 3, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 5, $v$Human oversight$v$, 4, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 6, $v$Evaluation and testing$v$, 2, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 7, $v$Observability$v$, 6, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 8, $v$Incident response and recovery$v$, 6, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 9, $v$Change and rollback$v$, 4, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 10, $v$Reliability and handoffs$v$, 5, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 11, $v$Cost and capacity$v$, 6, 8, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline'),
        ('2026-09-27', 12, $v$Data governance and retention$v$, 3, 7, 10, $v$Formal 12-dimension score, 27 Sep 2026 (claude/Agent_Maturity_Score_Sept_27.md in the BHA Agent project).$v$, 'baseline')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    id: 35,
    name: 'engine_mcp_writes.agent: which agent token a write came in on',
    statements: [
      /**
       * 28 Sep 2026, Destiny — Agent Upgrade Plan step 1.4. Each agent connects
       * with its own token, and the token decides the name written here. Null
       * means the shared MCP_SECRET / MCP_WRITE_TOKEN (Claude's connector), never
       * a guess about who that was.
       */
      `ALTER TABLE engine_mcp_writes ADD COLUMN IF NOT EXISTS agent text`,
    ],
  },
  {
    id: 36,
    name: 'engine_bays_asks: Bays ask ledger, the same shape as the twins',
    statements: [
      /**
       * 28 Sep 2026, Destiny — Agent Upgrade Plan step 2.5. One row per Bays
       * turn, written by Bays — Agent Delivery after the reply is posted, so it
       * can say whether the reply reached anyone. Same columns as
       * engine_ns_asks and engine_rt_asks, so every ledger reads one way.
       */
      `CREATE TABLE IF NOT EXISTS engine_bays_asks (
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
      `CREATE INDEX IF NOT EXISTS engine_bays_asks_natural ON engine_bays_asks (natural_id)`,
    ],
  },
  {
    id: 37,
    name: 'engine_eval_runs: agent eval results, one row per case per repeat',
    statements: [
      /**
       * 28 Sep 2026, Destiny — Agent Upgrade Plan steps 3.2–3.4. Written by
       * the n8n eval runner; read by the scorecard's eval pass rate. Same
       * mirror columns as every engine table so mirror.upsert writes it.
       */
      `CREATE TABLE IF NOT EXISTS engine_eval_runs (
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
      `CREATE INDEX IF NOT EXISTS engine_eval_runs_natural ON engine_eval_runs (natural_id)`,
      `CREATE INDEX IF NOT EXISTS engine_eval_runs_run ON engine_eval_runs ((fields->>'Run ID'))`,
    ],
  },
  {
    id: 38,
    name: 'engine_lane_profiles: the tags North Star’s weighted ranking reads',
    statements: [
      /**
       * 28 Sep 2026, Destiny and Jason (#bha-north-star-twin 1790611246.825499).
       * North Star ranks lanes on six weighted factors and code does the maths
       * (laneRanking.ts). Three factors can be computed from the records; the
       * rest are tags a person sets, because nothing records them yet — which
       * lane gates Oct 31, which blocks other people, which is engine leverage,
       * and the owner's effort estimate. They live here, one row per lane, and
       * a lane with no row still ranks: every missing tag scores 0 and is named.
       * Real columns rather than a blob: this table is born here, not mirrored.
       */
      `CREATE TABLE IF NOT EXISTS engine_lane_profiles (
         lane_id            text PRIMARY KEY,
         kind               text NOT NULL CHECK (kind IN ('work', 'commercial')),
         gates_oct31        smallint CHECK (gates_oct31 BETWEEN 0 AND 5),
         blocks_others      smallint CHECK (blocks_others BETWEEN 0 AND 5),
         engine_leverage    smallint CHECK (engine_leverage BETWEEN 0 AND 5),
         commercial_impact  smallint CHECK (commercial_impact BETWEEN 0 AND 5),
         effort             text CHECK (effort IN ('small', 'medium', 'large')),
         anchors            text[] NOT NULL DEFAULT '{}',
         note               text,
         updated_by         text,
         updated_at         timestamptz NOT NULL DEFAULT now()
       )`,
      /**
       * Seeded only with what Jason named in that thread — nothing else is
       * guessed. Blocks-others, effort and work-lane commercial impact stay
       * empty until someone sets them, and the ranking says so.
       * MONITORING_TWIN is not a loop lane; it carries his "Monitoring Twin
       * visibility" and "monitoring/dashboard paths" so they are ranked at all.
       */
      `INSERT INTO engine_lane_profiles (lane_id, kind, gates_oct31, engine_leverage, anchors, note, updated_by) VALUES
        ('VFARM_HARDWARE', 'work', 5, 5, ARRAY['P1.0 burn-ins', 'first strawberry cycle', 'LOOP-1790341118240-66R6', 'VFARM_ARCHITECTURE_CONTRACT', 'P1.0 build path'], $n$Seeded 28 Sep from Jason's ranking thread (C0B5JHVAXCM 1790611710.499749). Review.$n$, 'seed'),
        ('CST', 'work', 5, 5, ARRAY['CST health', 'CST fixes'], $n$Seeded 28 Sep from Jason's ranking thread (C0B5JHVAXCM 1790611710.499749). Review.$n$, 'seed'),
        ('RT', 'work', NULL, 5, ARRAY['Research Twin auto-research wiring'], $n$Seeded 28 Sep from Jason's ranking thread (C0B5JHVAXCM 1790611710.499749). Review.$n$, 'seed'),
        ('BAYS', 'work', NULL, 5, ARRAY['Logstream autopay rules'], $n$Seeded 28 Sep from Jason's ranking thread (C0B5JHVAXCM 1790611710.499749). Review.$n$, 'seed'),
        ('MONITORING_TWIN', 'work', 5, 5, ARRAY['Monitoring Twin visibility', 'monitoring/dashboard paths'], $n$Seeded 28 Sep from Jason's ranking thread. Not a loop lane: no loop can carry this tag yet, so its days-since-moved reads as not recorded.$n$, 'seed')
       ON CONFLICT (lane_id) DO NOTHING`,
    ],
  },
  {
    id: 39,
    name: 'engine_lane_profiles.linked_lanes: which research lanes a work lane draws on',
    statements: [
      /**
       * 28 Sep 2026, Jason (#bha-north-star-twin): research gleanings must live
       * with the lane. Research Twin's jobs carry commercial LANE-… ids and never
       * a work-lane tag, so a work lane such as VFARM_HARDWARE reaches its
       * research only through the commercial lanes it is linked to. Empty until
       * somebody links them: a guessed link would attach the wrong findings.
       */
      `ALTER TABLE engine_lane_profiles ADD COLUMN IF NOT EXISTS linked_lanes text[] NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    id: 40,
    name: 'Genie events and vFarm alerts and state, pushed by the two systems themselves',
    statements: [
      /**
       * 29 Sep 2026, Destiny (D3 / HMJV). Genie and vFarm post to this server as
       * things happen; nothing here polls them. Their payloads arrive in their
       * own shapes — Genie's service-callback envelope, vFarm's
       * `vfarm.alert.v1` webhook and a `vfarm.snapshot.v1` state push — so these
       * are real columns for what the pages read plus the payload whole, like
       * `engine_repairs`, not Airtable-shaped mirror rows. See systemFeeds.ts.
       */
      `CREATE TABLE IF NOT EXISTS engine_genie_events (
         event_id       text PRIMARY KEY,
         event_type     text NOT NULL,
         request_id     text,
         run_id         text,
         session_id     text,
         builder_id     text,
         correlation_id text,
         thread_id      text,
         lane           text,
         status         text,
         source         text,
         question       text,
         duration_ms    integer,
         handoff        text,
         occurred_at    timestamptz NOT NULL,
         received_at    timestamptz NOT NULL DEFAULT now(),
         payload        jsonb NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_genie_events_occurred ON engine_genie_events (occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_genie_events_request ON engine_genie_events (request_id)`,
      `CREATE TABLE IF NOT EXISTS engine_vfarm_alert_events (
         event_id    text PRIMARY KEY,
         kind        text,
         rule_id     text,
         rule_name   text,
         severity    text,
         metric      text,
         device_id   text,
         value       double precision,
         farm_id     text,
         farm        text,
         place_path  text,
         fired_at    timestamptz NOT NULL,
         received_at timestamptz NOT NULL DEFAULT now(),
         payload     jsonb NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_alert_events_fired ON engine_vfarm_alert_events (fired_at DESC)`,
      `CREATE TABLE IF NOT EXISTS engine_vfarm_farms (
         farm_id         text PRIMARY KEY,
         code            text,
         name            text,
         status          text,
         device_count    integer,
         online_count    integer,
         offline_count   integer,
         unhealthy_count integer,
         fields          jsonb NOT NULL,
         snapshot_at     timestamptz NOT NULL,
         updated_at      timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS engine_vfarm_devices (
         device_id       text PRIMARY KEY,
         farm_id         text,
         place           text,
         device_type     text,
         model           text,
         status          text,
         health_score    double precision,
         last_seen_at    timestamptz,
         last_reading_at timestamptz,
         latest          jsonb,
         fields          jsonb NOT NULL,
         snapshot_at     timestamptz NOT NULL,
         gone_at         timestamptz,
         updated_at      timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS engine_vfarm_open_alerts (
         alert_id      text PRIMARY KEY,
         rule_id       text,
         device_id     text,
         farm_id       text,
         farm_name     text,
         place         text,
         severity      text,
         title         text,
         detail        text,
         last_value    double precision,
         opened_at     timestamptz,
         fields        jsonb NOT NULL,
         first_seen_at timestamptz NOT NULL DEFAULT now(),
         last_seen_at  timestamptz NOT NULL,
         closed_at     timestamptz
       )`,
      `CREATE TABLE IF NOT EXISTS engine_vfarm_snapshots (
         id          bigserial PRIMARY KEY,
         taken_at    timestamptz NOT NULL,
         received_at timestamptz NOT NULL DEFAULT now(),
         farms       integer NOT NULL,
         devices     integer NOT NULL,
         open_alerts integer NOT NULL,
         pipeline    jsonb
       )`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_snapshots_taken ON engine_vfarm_snapshots (taken_at DESC)`,
    ],
  },
  {
    id: 41,
    name: 'Customer Service Twin turns, pushed by CST itself',
    statements: [
      /**
       * 29 Sep 2026, Destiny. One row per customer turn — one message in (SMS,
       * voice or web) and CST's reply to it — keyed on CST's own turn id, the
       * `correlation_id` its envelope already carries. The reply's delivery
       * lands on the same row from a second event, so the two can arrive in
       * either order: each write touches only its own columns. `occurred_at` is
       * nullable only because a delivery can arrive before its turn; such a row
       * is shown as "turn not received", never dropped. Destiny's call: the
       * dashboard keeps the whole record, message text and number included.
       */
      `CREATE TABLE IF NOT EXISTS engine_cst_turns (
         turn_id             text PRIMARY KEY,
         conversation_id     text,
         tenant_id           text,
         project_id          text,
         channel             text,
         customer_ref        text,
         person_id           text,
         phone_e164          text,
         customer_name       text,
         role                text,
         is_known            boolean,
         message             text,
         reply               text,
         intent              text,
         status              text,
         reason              text,
         incident_id         text,
         duration_ms         integer,
         occurred_at         timestamptz,
         received_at         timestamptz NOT NULL DEFAULT now(),
         turn_payload        jsonb,
         delivery_status     text,
         delivery_error      text,
         delivery_attempts   integer,
         delivery_at         timestamptz,
         delivery_payload    jsonb
       )`,
      `CREATE INDEX IF NOT EXISTS engine_cst_turns_occurred ON engine_cst_turns (occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_cst_turns_conversation ON engine_cst_turns (conversation_id)`,
    ],
  },
  {
    id: 42,
    name: 'data governance: when personal text was cleared, and every BHARAG write-back decision',
    statements: [
      /**
       * 29 Sep 2026, Destiny (Agent Upgrade Plan 5.4 and 5.5). Retention clears
       * personal text and keeps the row; this column says when, so a blank
       * message reads "cleared" rather than "never sent". Mirror tables mark it
       * inside `fields` instead ('Retention Cleared At'), because their columns
       * belong to the mirror. See dataGovernance.ts.
       */
      `ALTER TABLE engine_cst_turns ADD COLUMN IF NOT EXISTS retention_cleared_at timestamptz`,
      `ALTER TABLE engine_genie_events ADD COLUMN IF NOT EXISTS retention_cleared_at timestamptz`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS retention_cleared_at timestamptz`,
      /** One row per write-back decision, from the dashboard's own ingests and from n8n's. */
      `CREATE TABLE IF NOT EXISTS engine_bharag_guard (
         id             bigserial PRIMARY KEY,
         at             timestamptz NOT NULL DEFAULT now(),
         workspace      text,
         source         text,
         run_id         text,
         kind           text NOT NULL,
         answer_outcome text,
         outcome        text NOT NULL CHECK (outcome IN ('allowed', 'redacted', 'refused')),
         reason         text,
         redactions     jsonb,
         title          text,
         via            text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_bharag_guard_at ON engine_bharag_guard (at DESC)`,
    ],
  },
  {
    id: 43,
    name: "Media Twin doctrine: Hardik's doctrine and contract changes, pushed as they are made",
    statements: [
      /**
       * 30 Sep 2026, Destiny (HMJV, third section). One row per change to a
       * doctrine or contract Hardik owns (B93H, TSNR, OWLG, ...), keyed on the
       * sender's own change_id. A version is a version: (doctrine_id, version)
       * is unique, so the same version cannot be restated with different
       * content — a correction is a new version that supersedes it, never a
       * silent edit, which is OWLG's own rule. `claims` holds the claim-level
       * maturity states the change sets, as sent. See systemFeeds.ts.
       */
      `CREATE TABLE IF NOT EXISTS engine_media_doctrine (
         change_id         text PRIMARY KEY,
         doctrine_id       text NOT NULL,
         doctrine_name     text,
         version           text NOT NULL,
         previous_version  text,
         change_type       text NOT NULL,
         summary           text NOT NULL,
         contract_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
         default_patterns  jsonb NOT NULL DEFAULT '[]'::jsonb,
         claims            jsonb NOT NULL DEFAULT '[]'::jsonb,
         approved_by       text,
         approved_at       timestamptz,
         changed_at        timestamptz NOT NULL,
         loop_id           text,
         doc_url           text,
         posted_by         text,
         received_at       timestamptz NOT NULL DEFAULT now(),
         payload           jsonb NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_media_doctrine_version ON engine_media_doctrine (doctrine_id, version)`,
      `CREATE INDEX IF NOT EXISTS engine_media_doctrine_changed ON engine_media_doctrine (changed_at DESC)`,
    ],
  },
  {
    id: 44,
    name: 'Monitoring Twin: crop profiles, cycles, device states and incidents; simulated vFarm snapshots',
    statements: [
      /**
       * 1 Oct 2026, Destiny (Jason's tomato-first memo; UN9D's runtime half).
       * See monitoringTwin.ts. Profiles are versioned and never edited in place:
       * (profile_id, version) is unique and a change is the next version with
       * its reason. One open incident per fault, enforced by a partial unique
       * index, so a fault that persists is one incident, not one a minute.
       */
      `CREATE TABLE IF NOT EXISTS engine_monitoring_profiles (
         profile_id       text NOT NULL,
         version          integer NOT NULL,
         previous_version integer,
         crop             text NOT NULL,
         reason           text NOT NULL,
         changed_by       text,
         content          jsonb NOT NULL,
         created_at       timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (profile_id, version)
       )`,
      `CREATE TABLE IF NOT EXISTS engine_monitoring_cycles (
         farm_id         text PRIMARY KEY,
         profile_id      text NOT NULL,
         profile_version integer NOT NULL,
         transplanted_at timestamptz NOT NULL,
         time_scale      numeric NOT NULL DEFAULT 1,
         synthetic       boolean NOT NULL DEFAULT false,
         note            text,
         updated_at      timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS engine_monitoring_watch (
         farm_id           text PRIMARY KEY,
         first_watched_at  timestamptz NOT NULL DEFAULT now(),
         last_evaluated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS engine_monitoring_device_state (
         device_id    text PRIMARY KEY,
         farm_id      text NOT NULL,
         state        text NOT NULL,
         since        timestamptz NOT NULL DEFAULT now(),
         age_s        integer,
         checks       jsonb NOT NULL DEFAULT '[]'::jsonb,
         evaluated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS engine_monitoring_incidents (
         incident_id  text PRIMARY KEY,
         farm_id      text NOT NULL,
         device_id    text,
         kind         text NOT NULL,
         metric       text,
         severity     text NOT NULL,
         detail       text NOT NULL,
         first_value  double precision,
         last_value   double precision,
         range_min    double precision,
         range_max    double precision,
         stage        text,
         synthetic    boolean NOT NULL DEFAULT false,
         opened_at    timestamptz NOT NULL DEFAULT now(),
         last_seen_at timestamptz NOT NULL DEFAULT now(),
         closed_at    timestamptz,
         close_reason text
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_monitoring_incidents_one_open
         ON engine_monitoring_incidents (farm_id, coalesce(device_id, ''), kind, coalesce(metric, '')) WHERE closed_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS engine_monitoring_incidents_opened ON engine_monitoring_incidents (opened_at DESC)`,
      // A simulated snapshot is ordered only against other simulated ones, so a
      // test can never make vFarm's real snapshot arrive "older than the newest".
      `ALTER TABLE engine_vfarm_snapshots ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false`,
    ],
  },
  {
    id: 45,
    name: 'engine_agent_scorecard: the 28 Sep independent re-score',
    statements: [
      /**
       * 1 Oct 2026, Destiny: the Agent maturity page still showed the 27 Sep
       * baseline (4.3). The independent re-score of 28 Sep (4.8) was written to
       * the project but never stored here, so the page had nothing newer to
       * read. These rows are that re-score as written, dimension for
       * dimension, with its evidence — not a new judgement.
       */
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-09-28', 1, $v$Governance and inventory$v$, 4, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): 3 credentials still in personal projects; Admin Airtable still in BHA Engine.$v$, 'rescore'),
        ('2026-09-28', 2, $v$Agent identity and secrets$v$, 4, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): engine_mcp_writes rows carry agent bays / research_twin; BHARAG still allowUnauthorizedCerts.$v$, 'rescore'),
        ('2026-09-28', 3, $v$Tool privilege$v$, 6, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): "out_of_scope: research_twin may not call create_record", refused by the server.$v$, 'rescore'),
        ('2026-09-28', 4, $v$Runtime controls and injection defense$v$, 4, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Untrusted-content rule in all three agents; no x-slack-signature check at any door.$v$, 'rescore'),
        ('2026-09-28', 5, $v$Human oversight$v$, 5, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Bays approval set: delete_record, share_doc, grant_drive_access.$v$, 'rescore'),
        ('2026-09-28', 6, $v$Evaluation and testing$v$, 4, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Last complete run 16 of 18 pass^k; both failures core North Star cases.$v$, 'rescore'),
        ('2026-09-28', 7, $v$Observability$v$, 6, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Bays ask ledger: 13 rows, first today.$v$, 'rescore'),
        ('2026-09-28', 8, $v$Incident response and recovery$v$, 6, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Time to resolve over n=2; 66 of 68 closed incidents still say resolution_status open.$v$, 'rescore'),
        ('2026-09-28', 9, $v$Change and rollback$v$, 4, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): 0 of 33 repairs reverted; one author per version.$v$, 'rescore'),
        ('2026-09-28', 10, $v$Reliability and handoffs$v$, 6, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Handoff Contract Gate on all three doors.$v$, 'rescore'),
        ('2026-09-28', 11, $v$Cost and capacity$v$, 6, 8, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): Quota 24.5%; no per-agent spend.$v$, 'rescore'),
        ('2026-09-28', 12, $v$Data governance and retention$v$, 3, 7, 10, $v$Independent re-score, 28 Sep 2026 (claude/Agent_Maturity_Rescore_Sept_28.md in the BHA Agent project): No retention rule; BHARAG write-back unvalidated.$v$, 'rescore')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    id: 46,
    name: 'engine_agent_scorecard: the 1 Oct independent re-score',
    statements: [
      /**
       * 1 Oct 2026, Destiny: an independent agent that had not seen the work
       * re-scored the engine from live evidence only (read-only), on the same
       * rubric. Stored as it reported, dimension for dimension, with its evidence.
       */
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-10-01', 1, $v$Governance and inventory$v$, 4, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): Admin Airtable credential is gone and AIRTABLE_TOKEN reads configured:false, but 3 credentials remain in personal projects (Hardik x2, Kaiqi x1) and no autonomy-tier inventory exists.$v$, 'rescore'),
        ('2026-10-01', 2, $v$Agent identity and secrets$v$, 4, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): allowUnauthorizedCerts:true is still set on 5 Bays BHARAG tools, RT Search_Research_Twin_Workspace and NS Query_North_Star_Cluster, though each agent now has its own scoped dashboard token and Slack signing secret.$v$, 'rescore'),
        ('2026-10-01', 3, $v$Tool privilege$v$, 6, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): The server refuses out-of-scope agent calls (9 refused by agent token in 4 days), but the Bays agent still holds 33 node tools including Slack_Request for any Slack API method.$v$, 'rescore'),
        ('2026-10-01', 4, $v$Runtime controls and injection defense$v$, 5, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): A Slack Signature Gate with MODE='enforce' runs on all three front doors and RT has a Card Key Gate, but a forged event without type:event_callback or a signature header skips the gate.$v$, 'rescore'),
        ('2026-10-01', 5, $v$Human oversight$v$, 5, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): Bays approval covers only delete_record, share_doc and grant_drive_access; button payloads are now signature-checked but outbound Slack posts are not gated.$v$, 'rescore'),
        ('2026-10-01', 6, $v$Evaluation and testing$v$, 5, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): EVAL-202610011437 passed 26 of 27 cases with repeats and 10 of 11 injection cases, but NS-03 failed the last two runs and agents were published before the complete run.$v$, 'rescore'),
        ('2026-10-01', 7, $v$Observability$v$, 6, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): All three agents now keep per-ask ledgers (Bays 308 rows since 28 Sep) but no quality alert exists in server code.$v$, 'rescore'),
        ('2026-10-01', 8, $v$Incident response and recovery$v$, 6, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): Time to resolve is measured at p50 3 min over n=14, but 0 of 80 incidents carry resolved_at or resolved_by and 75 closed incidents still say resolution_status open.$v$, 'rescore'),
        ('2026-10-01', 9, $v$Change and rollback$v$, 5, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): The repair bridge automatically reverted 9 failed repairs on production workflow Bays — Builder Chasers on 29-30 Sep, but no eval run is required before publish.$v$, 'rescore'),
        ('2026-10-01', 10, $v$Reliability and handoffs$v$, 6, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): 98.7% of 7,694 runs succeeded in 7 days with the handoff contract enforced at all doors, but Research Twin Agent Delivery is still at 73.7%.$v$, 'rescore'),
        ('2026-10-01', 11, $v$Cost and capacity$v$, 6, 8, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): Quota is tracked at 1.3% with 70/85/95/100 alerts, but the OpenRouter floor is still USD 1 (last probed 27 Sep) and there is no per-agent spend.$v$, 'rescore'),
        ('2026-10-01', 12, $v$Data governance and retention$v$, 5, 7, 10, $v$Independent re-score, 1 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_1.md in the BHA Agent project): Retention periods for 6 stores are written and enforced by a weekly scheduler in dataGovernance.ts (last run 29 Sep, 0 cleared), and a BHARAG write guard has logged 96 allowed writes with no refusal yet.$v$, 'rescore')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    id: 47,
    name: 'engine_lane_profiles.blocked_by: the loops a lane is waiting on',
    statements: [
      /**
       * 2 Oct 2026, Jason (#bha-coordination, UN9D thread): VFARM_HARDWARE's
       * health should name GWTH and QFCU as its blockers, so North Star and
       * Research Twin see the same truth. Loop ids only, set by a person with
       * set_lane_profile; lane_health reads each one's live status, so a closed
       * blocker stops counting without anyone editing the list.
       */
      `ALTER TABLE engine_lane_profiles ADD COLUMN IF NOT EXISTS blocked_by text[] NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    id: 48,
    name: 'engine_incidents.resolved_at / resolved_by: every close is dated and signed',
    statements: [
      /**
       * 2 Oct 2026, Destiny — Agent Upgrade Plan step 5.1, after the 1 Oct
       * re-score: 0 of 80 incidents carried resolved_at or resolved_by, and 75
       * closed ones still said "open", because `open_now` went false while the
       * ledger's own `resolution_status` in the blob was never re-read. The
       * blob stays the ledger's copy, untouched. These two columns are this
       * dashboard's own record of the close: when, and by whom — a person
       * through the page or MCP, the recovery watcher, or "the ledger" where a
       * successful read simply stopped returning it (closed upstream by the
       * healer or a person, dated by the last read that still saw it open).
       * The backfill dates the 75 by that last read and says the resolver was
       * not recorded, rather than inventing one.
       */
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS resolved_at text`,
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS resolved_by text`,
      `UPDATE engine_incidents
          SET resolved_at = COALESCE(fields->'payload'->>'resolved_at', fields->>'resolved_at', last_seen_open, updated_at),
              resolved_by = COALESCE(fields->'payload'->>'resolved_by', 'not recorded (closed before 2 Oct 2026)')
        WHERE open_now = false AND resolved_at IS NULL`,
    ],
  },
  {
    id: 49,
    name: 'engine_agent_inventory: one row per n8n Agent, read from its live config',
    statements: [
      /**
       * 2 Oct 2026, Destiny — Agent Upgrade Plan step 5.2 (governance). The
       * 1 Oct re-score scored governance 4 of 10 for having no inventory of the
       * agents with autonomy tiers. One row per agent, keyed on its n8n id,
       * holding what `get_agent` returned — model, tools and which can write,
       * MCP scope and approvals, skills, scheduled tasks, sub-agents, memory,
       * the credential ids it references — plus the autonomy tier this server
       * derives from that config in code, never typed. `read_at` and
       * `config_hash` say how fresh the row is; the page marks a row stale
       * after seven days rather than presenting it as current.
       */
      `CREATE TABLE IF NOT EXISTS engine_agent_inventory (
         agent_id            text PRIMARY KEY,
         name                text NOT NULL,
         published           boolean,
         active_version_id   text,
         config_hash         text,
         model               text,
         reasoning           text,
         max_iterations      integer,
         memory              jsonb,
         tools               jsonb NOT NULL DEFAULT '[]'::jsonb,
         mcp_servers         jsonb NOT NULL DEFAULT '[]'::jsonb,
         skills              jsonb NOT NULL DEFAULT '[]'::jsonb,
         tasks               jsonb NOT NULL DEFAULT '[]'::jsonb,
         sub_agents          jsonb NOT NULL DEFAULT '[]'::jsonb,
         credentials         jsonb NOT NULL DEFAULT '[]'::jsonb,
         autonomy_tier       text NOT NULL,
         tier_reason         text NOT NULL,
         owner               text,
         read_from           text NOT NULL,
         read_at             text NOT NULL,
         recorded_by         text,
         raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
         first_seen_at       text NOT NULL,
         updated_at          text NOT NULL
       )`,
    ],
  },
  {
    id: 50,
    name: 'engine_monitoring_incidents: the BHARAG ledger copy of each incident',
    statements: [
      /**
       * 3 Oct 2026, Destiny — UN9D close-out (Jason, 1 Oct): Monitoring Twin
       * incidents must be durable engine records in BHARAG, not only rows here.
       * Each incident now carries the ledger's own id once BHARAG accepts it,
       * where it stands there, and the last refusal word for word. New rows
       * start `pending`; the four simulator incidents from 1 Oct closed before
       * this wiring existed and are marked `not_sent` so they are never sent
       * late as if they were new.
       */
      `ALTER TABLE engine_monitoring_incidents
         ADD COLUMN IF NOT EXISTS ledger_id        text,
         ADD COLUMN IF NOT EXISTS ledger_state     text NOT NULL DEFAULT 'pending',
         ADD COLUMN IF NOT EXISTS ledger_error     text,
         ADD COLUMN IF NOT EXISTS ledger_attempts  integer NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS ledger_synced_at timestamptz`,
      `UPDATE engine_monitoring_incidents SET ledger_state = 'not_sent', ledger_error = 'closed on 1 Oct 2026, before incidents were written to BHARAG' WHERE closed_at IS NOT NULL AND ledger_id IS NULL`,
      `CREATE INDEX IF NOT EXISTS engine_monitoring_incidents_ledger ON engine_monitoring_incidents (ledger_state) WHERE ledger_state IN ('pending', 'open')`,
    ],
  },
  {
    id: 51,
    name: 'engine_vfarm_leads: Stage 1 / Stage 2, with every move kept',
    statements: [
      /**
       * 3 Oct 2026, Destiny — LOOP-1790429563108-VFIG (Jason, 26 Sep): Stage 1
       * (Form A, interest only) and Stage 2 (serious buyer, the
       * VFARM_BUYER_INTAKE.v1 follow-up) are separate segments. A lead moves
       * to Stage 2 when it enters the follow-up path; its Stage 1 answers stay
       * on the row and every move is appended to `stage_history`, never
       * overwritten, so BHA can reach back if priorities change.
       */
      `ALTER TABLE engine_vfarm_leads
         ADD COLUMN IF NOT EXISTS stage            smallint NOT NULL DEFAULT 1,
         ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz,
         ADD COLUMN IF NOT EXISTS stage_history    jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engine_vfarm_leads_stage_check') THEN
           ALTER TABLE engine_vfarm_leads ADD CONSTRAINT engine_vfarm_leads_stage_check CHECK (stage IN (1, 2));
         END IF;
       END $$`,
    ],
  },
  {
    id: 52,
    name: 'engine_agent_scorecard: the 3 Oct independent re-score',
    statements: [
      /**
       * 3 Oct 2026, Destiny: an independent agent that had not seen the work
       * re-scored the engine from live evidence only (read-only), on the same
       * rubric. Stored as it reported, dimension for dimension, with its evidence.
       */
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-10-03', 1, $v$Governance and inventory$v$, 5, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): engine_agent_inventory holds 3 rows read from live config on 2 Oct, with tiers (Bays T3, North Star T2, Research Twin T2) and owner; 3 credentials still sit in personal projects (Hardik x2, Kaiqi x1).$v$, 'rescore'),
        ('2026-10-03', 2, $v$Agent identity and secrets$v$, 5, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): No allowUnauthorizedCerts on any of the 7 BHARAG tools and each agent sends its own bearer credential to /mcp/agent; the BHARAG Cluster and OpenRouter keys are still shared by all three and nothing rotates.$v$, 'rescore'),
        ('2026-10-03', 3, $v$Tool privilege$v$, 6, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): The server refused 34 calls in 7 days, including 6 Bays creates (possible_duplicate) and 1 update (not_permitted) since 30 Sep; Bays still holds 33 non-MCP tools and 25 write tools without approval, Slack_Request included.$v$, 'rescore'),
        ('2026-10-03', 4, $v$Runtime controls and injection defense$v$, 6, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): A forged app_mention with no signature was refused 401 at Bays Front Door (execution 24613, INC-BAYS.AGENT-042, 2 Oct) and injection evals passed 11 of 11 in EVAL-202610030802; only the Bays door has a logged refusal.$v$, 'rescore'),
        ('2026-10-03', 5, $v$Human oversight$v$, 5, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): Approval is still only on delete_record, share_doc and grant_drive_access; Slack_Send_Message, Slack_Request, send_nudge and post_file are ungated, and Bays runs 12 scheduled tasks with 25 unapproved write tools.$v$, 'rescore'),
        ('2026-10-03', 6, $v$Evaluation and testing$v$, 6, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): Two full passes in a row, EVAL-202610021812 and EVAL-202610030802, each 33 of 33 results; the runner is manual and North Star was published on 2 Oct before its run began, so nothing gates a publish.$v$, 'rescore'),
        ('2026-10-03', 7, $v$Observability$v$, 7, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): A quality alert checks every 15 minutes over eval, delivery and thin rates (last check 3 Oct 14:20 UTC, no error) and the Bays ask ledger holds 406 rows; the alert has never posted for real.$v$, 'rescore'),
        ('2026-10-03', 8, $v$Incident response and recovery$v$, 7, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): 82 of 82 incidents carry resolved_at and resolved_by, with time to resolve p50 3 min and p95 269 min over n=16; 77 of the 82 are backfilled as not recorded and the window is under a week.$v$, 'rescore'),
        ('2026-10-03', 9, $v$Change and rollback$v$, 6, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): North Star's version history shows 95d3b6de published 3 Oct 08:02:05 and 49a9b575 active again, then a clean eval run, beside 9 bridge auto-reverts; still one author and no eval gate before publish.$v$, 'rescore'),
        ('2026-10-03', 10, $v$Reliability and handoffs$v$, 6, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): 98.7% of 7,047 runs succeeded in 7 days; Research Twin Agent Delivery is at 68.2% (n=22), Builder Chasers 84.6% (n=123) and the Monitoring Twin Simulator 53.3% (n=30); no durable resume.$v$, 'rescore'),
        ('2026-10-03', 11, $v$Cost and capacity$v$, 6, 8, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): Engine — OpenRouter Credit Alert has run 20 times on its 3-hour schedule and the quota is at 1,607 of 50,000 (3.2%); no per-agent spend and no real credit alert posted yet.$v$, 'rescore'),
        ('2026-10-03', 12, $v$Data governance and retention$v$, 5, 7, 10, $v$Independent re-score, 3 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_3.md in the BHA Agent project): The BHARAG guard logged 182 allowed, 0 refused and 0 redacted; retention last ran 29 Sep and cleared 0 rows; no Research Twin guard rows, 1 North Star row against 68 asks, and n8n agent memory is not covered.$v$, 'rescore')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    id: 53,
    name: 'engine_events: the engine\'s own structured events, append-only',
    statements: [
      /**
       * 3 Oct 2026, Destiny — LOOP-1791015066302-MG0X. engine.event.v1:
       * { event_type, at, subject_id, lane, actor, source_ref, detail }. For
       * digest dispatches (posted by n8n) and lane blockers clearing (written
       * here). `dedupe_key` is unique so a retried post or a repeated sweep is
       * one event; a NULL key is never a conflict, so an event without one is
       * always stored.
       */
      `CREATE TABLE IF NOT EXISTS engine_events (
         id          bigserial PRIMARY KEY,
         event_type  text NOT NULL,
         at          timestamptz NOT NULL DEFAULT now(),
         subject_id  text NOT NULL,
         lane        text,
         actor       text,
         source_ref  text,
         detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
         dedupe_key  text UNIQUE,
         recorded_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS engine_events_type_at ON engine_events (event_type, at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_events_subject ON engine_events (subject_id)`,
    ],
  },
  {
    id: 54,
    name: 'engine_approvals: a person decides before an agent shares, grants or deletes',
    statements: [
      /**
       * 4 Oct 2026, Destiny — LOOP-1790969736142-8185. n8n's own tool approval
       * suspends the agent, and an agent run inside a workflow cannot be
       * suspended, so share_doc, grant_drive_access and delete_record failed
       * with nobody asked (execution 24683). The gate is held here instead:
       * one row per request, the card it was asked on, who decided and when,
       * and what the action answered once it ran. `attempts` keeps every click
       * by somebody who is not an approver. One live request per identical
       * call: the partial unique index is what stops a retry stacking cards.
       */
      `CREATE TABLE IF NOT EXISTS engine_approvals (
         id                bigserial PRIMARY KEY,
         approval_id       text NOT NULL UNIQUE,
         tool              text NOT NULL,
         arguments         jsonb NOT NULL,
         args_digest       text NOT NULL,
         summary           text NOT NULL,
         target            text,
         agent             text,
         requester_user_id text,
         origin_channel    text,
         origin_thread_ts  text,
         card_channel      text,
         card_ts           text,
         card_thread_ts    text,
         card_error        text,
         status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'card_failed')),
         decided_by        text,
         decided_at        timestamptz,
         executed_at       timestamptz,
         result_ok         boolean,
         result            jsonb,
         attempts          jsonb NOT NULL DEFAULT '[]'::jsonb,
         created_at        timestamptz NOT NULL DEFAULT now(),
         expires_at        timestamptz NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_approvals_one_pending ON engine_approvals (args_digest) WHERE status = 'pending'`,
      `CREATE INDEX IF NOT EXISTS engine_approvals_status ON engine_approvals (status, created_at DESC)`,
    ],
  },
  {
    id: 55,
    name: 'engine_monitoring_recurrences: a repeating incident becomes one Research Twin job',
    statements: [
      /**
       * 4 Oct 2026, Destiny. The rule from the 3 Oct Twin alignment note: the
       * same incident class 3 or more times in 7 days on the same device or
       * farm is a pattern and opens one Research Twin job, never one per
       * incident. One row per pattern per window: what recurred, how often,
       * which incidents, and the job it opened (or why it did not: a
       * simulated farm, or a write that failed and is being retried).
       */
      `CREATE TABLE IF NOT EXISTS engine_monitoring_recurrences (
         id           bigserial PRIMARY KEY,
         pattern_key  text NOT NULL,
         farm_id      text NOT NULL,
         device_id    text,
         kind         text NOT NULL,
         metric       text,
         synthetic    boolean NOT NULL DEFAULT false,
         incidents    integer NOT NULL,
         incident_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
         first_at     timestamptz NOT NULL,
         last_at      timestamptz NOT NULL,
         detected_at  timestamptz NOT NULL DEFAULT now(),
         job_state    text NOT NULL CHECK (job_state IN ('pending', 'opened', 'not_opened_simulated', 'failed')),
         job_id       text,
         job_error    text,
         job_attempts integer NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS engine_monitoring_recurrences_key ON engine_monitoring_recurrences (pattern_key, detected_at DESC)`,
    ],
  },
  {
    id: 56,
    name: 'engine_monitoring_recurrences: a pattern is subsystem + place + incident class (Canon v1)',
    statements: [
      /**
       * 4 Oct 2026, Destiny. Jason's Canon decision of the same day groups a
       * pattern by subsystem + place (the farm) + incident class, not by
       * device, so the row gains the subsystem and every device the pattern
       * touched. Rows already held are re-keyed to the new shape so the next
       * pass updates them rather than detecting the same pattern twice.
       * `device_id` stays, and holds the device only where the pattern sits on
       * exactly one.
       */
      `ALTER TABLE engine_monitoring_recurrences ADD COLUMN IF NOT EXISTS subsystem text NOT NULL DEFAULT 'MONITORING'`,
      `ALTER TABLE engine_monitoring_recurrences ADD COLUMN IF NOT EXISTS device_ids jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `UPDATE engine_monitoring_recurrences
          SET device_ids = CASE WHEN device_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(device_id) END,
              pattern_key = subsystem || '|' || farm_id || '|' || kind || CASE WHEN metric IS NULL THEN '' ELSE ':' || metric END
        WHERE pattern_key NOT LIKE 'MONITORING|%'`,
    ],
  },
  {
    id: 57,
    name: 'engine_monitoring_recurrences: remove the rows the old instance wrote during the migration 56 deploy',
    statements: [
      /**
       * 4 Oct 2026. While migration 56's deploy was going live, the instance
       * still running the old code swept once more (19:14:57 UTC), did not
       * find its old-format keys because 56 had just re-keyed them, and
       * recorded both simulated patterns a second time under the old key
       * (farm|device|kind|metric: three bars, where the Canon key has two).
       * They are duplicates of rows that exist, on a simulated farm, with no
       * job. Removed so the read shows each pattern once. Their two
       * `monitoring_recurrence_detected` events stay: that table is
       * append-only.
       */
      `DELETE FROM engine_monitoring_recurrences WHERE pattern_key ~ '^[^|]*[|][^|]*[|][^|]*[|][^|]*$'`,
    ],
  },  {
    id: 58,
    name: 'engine_agent_scorecard: the 4 Oct independent re-score',
    statements: [
      /**
       * 4 Oct 2026, Destiny: a second independent agent that had not seen the
       * work re-scored the engine from live evidence only (read-only), on the
       * same rubric. 6.0, from 5.8. Stored as it reported, dimension for
       * dimension, with its evidence; it was not told what score was hoped for.
       */
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-10-04', 1, $v$Governance and inventory$v$, 5, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): engine_agent_inventory holds 3 rows re-read on 4 Oct with tiers and owner, and Bays' row names its three server-gated tools; 3 credentials still sit in personal projects (Hardik x2, Kaiqi x1) and North Star's row was recorded from its unpublished draft.$v$, 'rescore'),
        ('2026-10-04', 2, $v$Agent identity and secrets$v$, 5, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): Each agent sends its own bearer credential and the four Bays ingest nodes now verify TLS; the BHARAG Cluster and OpenRouter credentials are still shared by all three, and the dashboard inbound key is still sent from $vars in several workflows and has not been rotated.$v$, 'rescore'),
        ('2026-10-04', 3, $v$Tool privilege$v$, 6, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): The server refused 28 calls in 7 days and each agent has its own allow-list; Bays still holds 53 tools, 25 of them write tools with no approval.$v$, 'rescore'),
        ('2026-10-04', 4, $v$Runtime controls and injection defense$v$, 7, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): A forged app_mention with no signature is refused 401 on all three doors in webhook mode (executions 24613, 25851, 25853), and injection evals passed 16 of 16 in EVAL-202610041950; the two new refusals were deliberate tests, and nothing yet stops a run that read untrusted content from sending Slack.$v$, 'rescore'),
        ('2026-10-04', 5, $v$Human oversight$v$, 6, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): share_doc, grant_drive_access and delete_record are held by a server-side approval card that works from an agent run: APR-1791137762510-DO1Z approved by click, execution 25816, engine_mcp_writes 1047 and 1050; it is one test approval where requester and approver were the same person, deny and expiry have no production evidence, and outbound Slack is ungated (74 send_nudge calls in 7 days).$v$, 'rescore'),
        ('2026-10-04', 6, $v$Evaluation and testing$v$, 6, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): EVAL-202610041950 stored 62 results over 32 cases, 61 passed, every Bays case 3 of 3, with five new red-team cases; the Monday schedule has not fired yet, the RT-02 fix has not been re-run, and Bays 3001dbe5 was published before its eval began, so nothing gates a publish.$v$, 'rescore'),
        ('2026-10-04', 7, $v$Observability$v$, 7, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): The quality alert posted to #bha-engine-alerts for real (EVAL-202610041950, RT-02) at 20:14 UTC and a fix followed; there is still no thin-rate grade for Bays and no per-ask tool-call trace.$v$, 'rescore'),
        ('2026-10-04', 8, $v$Incident response and recovery$v$, 7, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): 87 incidents, 86 closed, all dated, 9 signed since 2 Oct, time to resolve p50 2 min and p95 84 min over n=20; Monitoring Twin incidents reach the ledger and Engine health, but all ten held are simulated, and one test incident (AGENT-043) was left open for two hours.$v$, 'rescore'),
        ('2026-10-04', 9, $v$Change and rollback$v$, 6, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): Version history carries a restore point for every change made on 4 Oct; Bays was published before its eval run, North Star's draft differs from what is published, and there is still one author and no eval gate.$v$, 'rescore'),
        ('2026-10-04', 10, $v$Reliability and handoffs$v$, 6, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): The front doors succeeded on 2,696 of 2,707 and 1,650 of 1,659 runs in 7 days; Research Twin Agent Delivery is 11 of 17, Builder Chasers 105 of 124, the Monitoring Twin Simulator 28 of 42 and North Star Front Door 7 of 15, with manual runs and deliberate refusals counted as errors.$v$, 'rescore'),
        ('2026-10-04', 11, $v$Cost and capacity$v$, 6, 8, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): The quota is at 4.0% of 50,000 and the credit alert has run 30 times; no ask ledger carries a token or cost field, so there is no per-agent spend, and no real credit alert has posted.$v$, 'rescore'),
        ('2026-10-04', 12, $v$Data governance and retention$v$, 5, 7, 10, $v$Independent re-score, 4 Oct 2026 (claude/Agent_Maturity_Rescore_Oct_4.md in the BHA Agent project): The BHARAG guard logged 228 allowed, 0 refused and 0 redacted; retention last ran 29 Sep and has never cleared a row; Research Twin has no guard rows and North Star one.$v$, 'rescore')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    id: 59,
    name: 'engine_scheduled_posts: reminder posts Slack holds and sends as Bays',
    statements: [
      /**
       * 5 Oct 2026, Destiny. One row per reminder scheduled through the
       * schedule_reminder tool. Slack holds the message (slack_scheduled_id is
       * its handle) and posts it; this row is the record of who asked for what,
       * where and when, and is what list_reminders and the Bays page read.
       */
      `CREATE TABLE IF NOT EXISTS engine_scheduled_posts (
        id BIGSERIAL PRIMARY KEY,
        reminder_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        thread_ts TEXT,
        text TEXT NOT NULL,
        post_at TIMESTAMPTZ NOT NULL,
        slack_scheduled_id TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled',
        requested_by TEXT,
        agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        cancelled_at TIMESTAMPTZ,
        cancelled_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS engine_scheduled_posts_post_at ON engine_scheduled_posts (post_at)`,
    ],
  },
  {
    id: 60,
    name: 'engine_build_patterns: doc_id and doc_link backfilled from the create audit line',
    statements: [
      /**
       * 6 Oct 2026, Destiny. create_record has made every dashboard-created
       * pattern's Google Doc since 24 Sep and reported the id in its answer and
       * on its engine_mcp_writes line ("doc: created <id>"), but never on the
       * row, so nothing reading the pattern could find its Doc. From today the
       * handler writes doc_id and doc_link onto the row; this copies the id
       * across for the patterns created before then (17 on the day it was
       * written). The newest audit line for a pattern wins; a row that already
       * carries doc_id is left alone; a pattern whose Doc was made inside n8n
       * by the extractor has no such line and is not touched.
       */
      `UPDATE engine_build_patterns p
          SET fields = p.fields || jsonb_build_object('doc_id', w.doc_id, 'doc_link', 'https://docs.google.com/document/d/' || w.doc_id || '/edit')
         FROM (
           SELECT DISTINCT ON (natural_id) natural_id, substring(detail from 'doc: created ([A-Za-z0-9_-]+)') AS doc_id
             FROM engine_mcp_writes
            WHERE tool = 'create_record' AND kind = 'patterns' AND dry_run IS NOT TRUE AND detail ~ 'doc: created [A-Za-z0-9_-]+'
            ORDER BY natural_id, id DESC
         ) w
        WHERE w.natural_id = p.natural_id AND w.doc_id IS NOT NULL AND NOT (p.fields ? 'doc_id')`,
    ],
  },
  {
    id: 61,
    name: 'the registry carries BHARAG at rag.bhanetwork.org',
    statements: [
      /**
       * 7 Oct 2026. Jegan moved BHARAG2 from bharag2.duckdns.org to
       * rag.bhanetwork.org (#bha-coordination, 1791363777.901259); the old
       * host stopped answering the same morning. Same shape as migrations 12
       * and 13: the seed inserts ON CONFLICT DO NOTHING, so only a migration
       * reaches rows that already exist. Each statement rewrites the host
       * only where the row still carries the old one, so an edit made in the
       * interface survives.
       */
      `UPDATE registry_services
          SET url = replace(url, 'https://bharag2.duckdns.org', 'https://rag.bhanetwork.org'), updated_at = now()
        WHERE url LIKE 'https://bharag2.duckdns.org%'`,
      `UPDATE registry_endpoints
          SET url = replace(url, 'https://bharag2.duckdns.org', 'https://rag.bhanetwork.org'), updated_at = now()
        WHERE url LIKE 'https://bharag2.duckdns.org%'`,
    ],
  },
  {
    id: 62,
    name: 'engine_vfarm_gates: the vFarm Stage 1, Stage 2 and 5-rack offer records',
    statements: [
      /**
       * 9 Oct 2026, Destiny (LOOP-1791479575963-7S0O). One table for the three
       * v1 objects Jason locked on 8 Oct (Codex 6120a262): kind 'stage1' is
       * VFARM_STAGE1_LAB_VALIDATION_v1, 'stage2' is
       * VFARM_STAGE2_PILOT_CHECKLIST_v1, 'offer' is VFARM_5RACK_PILOT_OFFER_v1.
       * status and the two refs are columns because the hard gates read them;
       * every other contract field is in `fields`, under the contract's own
       * name. is_fixture marks a test row: it is labelled wherever it is shown,
       * a real row may not point at one, and only fixtures can be deleted.
       * The order (Stage 1 passed before Stage 2 starts; a Stage 2 row before
       * an offer is offered or signed) is enforced in vfarmGates.ts, the one
       * function every writer goes through.
       */
      `CREATE TABLE IF NOT EXISTS engine_vfarm_gates (
        id BIGSERIAL PRIMARY KEY,
        object_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('stage1', 'stage2', 'offer')),
        status TEXT NOT NULL,
        stage1_ref TEXT,
        stage2_ref TEXT,
        fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_fixture BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by TEXT,
        updated_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_gates_kind ON engine_vfarm_gates (kind, created_at)`,
    ],
  },
  {
    id: 63,
    name: 'engine_vfarm_gate_prompts: the cards Bays sends so nobody has to remember a gate',
    statements: [
      /**
       * 9 Oct 2026, Destiny (7S0O, second pass). One row per card the gate
       * sweep sends: kind 'check' asks a record's owner whether a check no
       * sensor covers passed or failed; kind 'status' asks whether a Stage 1
       * whose four checks have all passed should be marked passed. The answer
       * is a button, and the click writes through vfarmGates.writeGate like
       * every other change. `may_answer` is who is allowed to click.
       */
      `CREATE TABLE IF NOT EXISTS engine_vfarm_gate_prompts (
        id BIGSERIAL PRIMARY KEY,
        prompt_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('check', 'status')),
        object_id TEXT NOT NULL,
        check_name TEXT,
        asked_user TEXT NOT NULL,
        may_answer TEXT[] NOT NULL DEFAULT '{}',
        channel TEXT,
        ts TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'expired', 'card_failed', 'superseded')),
        answer TEXT,
        answered_by TEXT,
        answered_at TIMESTAMPTZ,
        result JSONB,
        error TEXT,
        is_fixture BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_gate_prompts_object ON engine_vfarm_gate_prompts (object_id, kind, check_name, created_at DESC)`,
    ],
  },
  {
    id: 64,
    name: 'engine_logstream and engine_logstream_triggers: Logstream v0, the read and analysis spine',
    statements: [
      /**
       * 10 Oct 2026, Destiny (Jason's go-ahead of 9 Oct). One append-only row
       * per state an incident reaches (observed, closed, research_opened), in
       * the field list of docs/design/logstream-v0.md section 5. person_confirmed
       * and autopay_enabled default false and nothing sets or reads them: pay
       * is not wired. The second table is one row per threshold crossing.
       */
      `CREATE TABLE IF NOT EXISTS engine_logstream (
        id BIGSERIAL PRIMARY KEY,
        logstream_row_id TEXT NOT NULL UNIQUE,
        incident_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('observed', 'closed', 'research_opened')),
        written_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lane_id TEXT,
        linked_lanes JSONB NOT NULL DEFAULT '[]'::jsonb,
        signature TEXT NOT NULL,
        workflow TEXT,
        failed_node TEXT,
        error_class TEXT,
        excluded_reason TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        pattern_ids_applied JSONB NOT NULL DEFAULT '[]'::jsonb,
        pattern_adherence JSONB NOT NULL DEFAULT '{}'::jsonb,
        objective_outcomes JSONB NOT NULL DEFAULT '{}'::jsonb,
        research_trigger JSONB NOT NULL DEFAULT '{}'::jsonb,
        commercial_relevance JSONB NOT NULL DEFAULT '{}'::jsonb,
        audit JSONB NOT NULL DEFAULT '{}'::jsonb,
        evaluated_by TEXT,
        evaluated_at TIMESTAMPTZ,
        person_confirmed BOOLEAN NOT NULL DEFAULT false,
        autopay_enabled BOOLEAN NOT NULL DEFAULT false
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_logstream_incident_state ON engine_logstream (incident_id, state)`,
      `CREATE INDEX IF NOT EXISTS engine_logstream_signature ON engine_logstream (signature, occurred_at DESC)`,
      `CREATE TABLE IF NOT EXISTS engine_logstream_triggers (
        id BIGSERIAL PRIMARY KEY,
        trigger_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('signature_research', 'signature_escalation', 'workflow_rate', 'shared_outage')),
        key TEXT NOT NULL,
        workflow TEXT,
        failed_node TEXT,
        lane_id TEXT,
        n INTEGER NOT NULL,
        runs INTEGER,
        failures INTEGER,
        incident_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        workflows JSONB NOT NULL DEFAULT '[]'::jsonb,
        first_at TIMESTAMPTZ,
        last_at TIMESTAMPTZ,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        action TEXT NOT NULL CHECK (action IN ('research_job', 'alert_person')),
        action_state TEXT NOT NULL CHECK (action_state IN ('pending', 'job_opened', 'alerted', 'suppressed_shared_outage', 'failed')),
        job_id TEXT,
        alert_channel TEXT,
        alert_ts TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        acted_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS engine_logstream_triggers_key ON engine_logstream_triggers (kind, key, detected_at DESC)`,
    ],
  },
  {
    id: 65,
    name: 'engine_logstream: the patterns_evaluated state; triggers: the guidance step',
    statements: [
      /** 10 Oct 2026, second pass: one row per closed incident saying which pattern applied, and whether North Star was asked once research resolved. */
      `ALTER TABLE engine_logstream DROP CONSTRAINT IF EXISTS engine_logstream_state_check`,
      `ALTER TABLE engine_logstream ADD CONSTRAINT engine_logstream_state_check CHECK (state IN ('observed', 'closed', 'research_opened', 'patterns_evaluated'))`,
      `ALTER TABLE engine_logstream_triggers ADD COLUMN IF NOT EXISTS guidance_state TEXT CHECK (guidance_state IN ('asked', 'failed', 'no_finding'))`,
      `ALTER TABLE engine_logstream_triggers ADD COLUMN IF NOT EXISTS guidance_error TEXT`,
      `ALTER TABLE engine_logstream_triggers ADD COLUMN IF NOT EXISTS guidance_at TIMESTAMPTZ`,
    ],
  },
  {
    id: 66,
    name: 'engine_logstream_triggers: a withdrawn state, and the one crossing a refused test ask caused',
    statements: [
      /**
       * 10 Oct 2026. LST-1791636805191-N642 opened a research job on North
       * Star — Front Door at 3 failures of 13 runs. Two of the three were the
       * door refusing an ask, which is a guard working, and one of those was a
       * test ask sent while proving the guidance path. The rate rule now leaves
       * such runs out; this crossing is marked withdrawn, with the reason, and
       * its row is kept.
       */
      `ALTER TABLE engine_logstream_triggers DROP CONSTRAINT IF EXISTS engine_logstream_triggers_action_state_check`,
      `ALTER TABLE engine_logstream_triggers ADD CONSTRAINT engine_logstream_triggers_action_state_check CHECK (action_state IN ('pending', 'job_opened', 'alerted', 'suppressed_shared_outage', 'failed', 'withdrawn'))`,
      `UPDATE engine_logstream_triggers SET action_state = 'withdrawn', error = 'Withdrawn 10 Oct 2026: two of the three failures were the Front Door refusing an ask (a guard working), one of them a test ask. The rate rule now leaves refused-ask, test and simulator runs out. The research job it opened was removed.' WHERE trigger_id = 'LST-1791636805191-N642'`,
    ],
  },
  {
    id: 67,
    name: 'engine_agent_scorecard: the 10 Oct evening independent re-score',
    statements: [
      /**
       * 10 Oct 2026, Destiny: an independent agent that had not seen the work
       * re-scored the engine read-only on the same rubric, in the evening,
       * after the day's changes. 6.1, from 6.0 that afternoon and 6.0 on 4 Oct.
       * Stored as it reported, dimension for dimension. The three credentials
       * in personal projects are out of scope by the owner's ruling.
       */
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-10-10', 1, $v$Governance and inventory$v$, 6, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): Three inventory rows read at 19:33 to 19:34 UTC, after the last publish, each matching n8n's active version; registry_services holds 12 vendor rows. The inventory is recorded by hand and will drift on the next publish.$v$, 'rescore'),
        ('2026-10-10', 2, $v$Agent identity and secrets$v$, 5, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): Each agent sends its own bearer credential to /mcp/agent; the BHARAG Cluster and OpenRouter credentials are still shared by all three and no rotation was seen.$v$, 'rescore'),
        ('2026-10-10', 3, $v$Tool privilege$v$, 6, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): 23 create_record refusals in 7 days; four gated tools and two destination-gated; the DM guard has never fired live, channel posts are ungated and Bays holds 66 tools, 29 of them writes with no approval.$v$, 'rescore'),
        ('2026-10-10', 4, $v$Runtime controls and injection defense$v$, 7, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): All 14 injection cases pass, the twins' now at three repeats, on one run; no independent red-team pass.$v$, 'rescore'),
        ('2026-10-10', 5, $v$Human oversight$v$, 6, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): 12 approvals on record, unchanged since 12:18 UTC; the DM guard is built and tested in process only; no refused non-approver click on record.$v$, 'rescore'),
        ('2026-10-10', 6, $v$Evaluation and testing$v$, 6, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): EVAL-202610101933: 96 of 96 results over 32 cases, pass^3 on all three agents; one run, no publish gate, and a version went live with a failing eval the same day.$v$, 'rescore'),
        ('2026-10-10', 7, $v$Observability$v$, 7, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): Token and tool-call fields are on 2 ask rows (none for Research Twin); 12 scheduled tasks wrote start lines; no agent has read Logstream on its own token.$v$, 'rescore'),
        ('2026-10-10', 8, $v$Incident response and recovery$v$, 7, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): 109 incidents, 108 dated; 28 closes since 2 Oct, all signed; INC-GENIE.CONTEXT-002 still open.$v$, 'rescore'),
        ('2026-10-10', 9, $v$Change and rollback$v$, 6, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): Restore points on all three agents and one rollback drill on Research Twin that left no readable record; one author throughout and no eval gate.$v$, 'rescore'),
        ('2026-10-10', 10, $v$Reliability and handoffs$v$, 6, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): Bays Front Door 2,832 of 2,835 and Research Twin Front Door 1,633 of 1,635 in 7 days; Research Twin Agent Delivery 17 of 21 and Scheduled Run Watch 7 of 14.$v$, 'rescore'),
        ('2026-10-10', 11, $v$Cost and capacity$v$, 5, 8, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): Quota at 13.1% of 50,000 and the credit check runs hourly; no credit alert has ever posted and the spend tool has two rows to add up.$v$, 'rescore'),
        ('2026-10-10', 12, $v$Data governance and retention$v$, 6, 7, 10, $v$Independent re-score, 10 Oct 2026 evening (claude/Agent_Maturity_Rescore_Oct_10_Evening.md in the BHA Agent project): BHARAG guard: North Star 9 allowed and 3 refused, Research Twin 15 and 3; retention last ran 6 Oct and cleared 0 rows; 0 redactions.$v$, 'rescore')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    id: 68,
    name: 'engine_research_signals: one job per signal, the daily budget, and held states on the two older openers',
    statements: [
      /**
       * 11 Oct 2026, Destiny (LOOP-1788310653393-Q9CR; the guards and triggers
       * BP-CONTRACT-005 marks NOT YET WIRED). One row per signal key: what
       * asked for research, the job it got, and why it is waiting when it is.
       * Logstream's and the Monitoring Twin's openers go through the same
       * guard, so each gains a held state and a "not reopened" one.
       */
      `CREATE TABLE IF NOT EXISTS engine_research_signals (
        id BIGSERIAL PRIMARY KEY,
        signal_id TEXT NOT NULL UNIQUE,
        signal_key TEXT NOT NULL UNIQUE,
        trigger_code TEXT NOT NULL CHECK (trigger_code IN ('T4', 'T5', 'T6', 'T8', 'MONITORING')),
        source TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1,
        lane TEXT,
        card_id TEXT,
        question TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        occurrences INTEGER NOT NULL DEFAULT 1,
        rearm_days INTEGER,
        state TEXT NOT NULL CHECK (state IN ('opening', 'job_opened', 'held_budget', 'held_credit', 'not_reopened', 'failed')),
        reason TEXT,
        job_id TEXT,
        previous_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
        attempts INTEGER NOT NULL DEFAULT 0,
        fixture BOOLEAN NOT NULL DEFAULT false,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        opened_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS engine_research_signals_opened ON engine_research_signals (opened_at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_research_signals_state ON engine_research_signals (state, priority, detected_at)`,
      `ALTER TABLE engine_logstream_triggers DROP CONSTRAINT IF EXISTS engine_logstream_triggers_action_state_check`,
      `ALTER TABLE engine_logstream_triggers ADD CONSTRAINT engine_logstream_triggers_action_state_check CHECK (action_state IN ('pending', 'job_opened', 'alerted', 'suppressed_shared_outage', 'failed', 'withdrawn', 'held', 'not_reopened'))`,
      `ALTER TABLE engine_monitoring_recurrences DROP CONSTRAINT IF EXISTS engine_monitoring_recurrences_job_state_check`,
      `ALTER TABLE engine_monitoring_recurrences ADD CONSTRAINT engine_monitoring_recurrences_job_state_check CHECK (job_state IN ('pending', 'opened', 'not_opened_simulated', 'failed', 'held', 'not_reopened'))`,
    ],
  },
  {
    id: 69,
    name: 'tomato profile v2: cabinet cycle 1 starts at first flower (IMFX)',
    statements: [
      // Jason's locking message of 4 Oct 2026 (LOOP-1790871612769-IMFX): single variety PKM 1; cycle 1
      // starts at first-flower entry; cabinet-relative timing: fruit set about 7 to 10 days after entry,
      // first pick about 40 to 45 days, last pick about 75 to 85 days; nursery and vegetative stages
      // happen at the supplier and are reference only. The ranges are v1's own, stage for stage: only
      // the days and the boundary change. Each stage ends at the upper end of Jason's range, so a
      // stage's targets are never applied early. Only where v1 is held and v2 is not.
      `INSERT INTO engine_monitoring_profiles (profile_id, version, previous_version, crop, reason, changed_by, content)
       SELECT p.profile_id, 2, 1, p.crop,
              'Cabinet cycle 1 starts at first-flower entry, not at transplant (Jason, 4 Oct 2026, LOOP-1790871612769-IMFX). Day 0 is entry at first flower: fruit set about 7 to 10 days after entry, first pick about 40 to 45 days, last pick about 75 to 85 days. Nursery and vegetative stages happen at the supplier this cycle and are reference only. Target ranges are unchanged from v1.',
              'Destiny (IMFX wiring)',
              jsonb_build_object(
                'crop', p.content->'crop',
                'day0', 'first_flower_entry',
                'reference_only_stages', jsonb_build_array(
                  jsonb_build_object('stage', 'nursery', 'where', 'supplier', 'note', 'Sowing to transplant-ready sapling. Not run in the cabinet this cycle.'),
                  jsonb_build_object('stage', 'vegetative', 'where', 'supplier', 'note', 'Up to first flower. Not run in the cabinet this cycle; v1 holds its ranges for reference.')
                ),
                'stages', jsonb_build_array(
                  (SELECT s || jsonb_build_object('from_day', 0, 'to_day', 9) FROM jsonb_array_elements(p.content->'stages') s WHERE s->>'stage' = 'flowering'),
                  (SELECT s || jsonb_build_object('from_day', 10, 'to_day', 44) FROM jsonb_array_elements(p.content->'stages') s WHERE s->>'stage' = 'fruit_set'),
                  (SELECT s || jsonb_build_object('from_day', 45, 'to_day', 85) FROM jsonb_array_elements(p.content->'stages') s WHERE s->>'stage' = 'harvest')
                ),
                'sources', (p.content->'sources') || jsonb_build_array(
                  'Cabinet-relative timing and the first-flower boundary: Jason Bays, locking message of 4 Oct 2026 (thread C0ASMPYQLG3/1790779143.330719), on LOOP-1790871612769-IMFX. These timings are an agronomy reference, never cabinet proof.'
                )
              )
         FROM engine_monitoring_profiles p
        WHERE p.profile_id = 'tomato-dwarf-determinate' AND p.version = 1
          AND (SELECT count(*) FROM jsonb_array_elements(p.content->'stages') s WHERE s->>'stage' IN ('flowering', 'fruit_set', 'harvest')) = 3
          AND NOT EXISTS (SELECT 1 FROM engine_monitoring_profiles q WHERE q.profile_id = p.profile_id AND q.version = 2)`,
    ],
  },
  {
    id: 70,
    name: 'engine_agent_versions: one row per agent version change, and what the eval run after it said',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_agent_versions (
         id bigserial PRIMARY KEY,
         agent_id text NOT NULL,
         name text NOT NULL,
         version_id text NOT NULL,
         previous_version_id text,
         config_hash text,
         is_rollback boolean NOT NULL DEFAULT false,
         seen_at timestamptz NOT NULL DEFAULT now(),
         eval_state text NOT NULL DEFAULT 'pending',
         requested_at timestamptz,
         eval_run_id text,
         eval_detail text,
         settled_at timestamptz,
         alert_state text,
         alert_detail text,
         alert_text text
       )`,
      `CREATE INDEX IF NOT EXISTS engine_agent_versions_agent ON engine_agent_versions (agent_id, id DESC)`,
    ],
  },
  {
    /**
     * Decision Watch (2026-10-11, Destiny — LOOP-1791743584778-5YQA): one row
     * per decision waiting on one named person. Its own table, not a loop: a
     * loop is a piece of work, a watch is "somebody owes an answer here". The
     * partial unique index is what makes a second ask for the same thread and
     * owner answer the first; `auto_key` is what makes a standing rule (PX07)
     * watch a record once and never again.
     */
    id: 73,
    name: 'engine_decision_watches: a decision waiting on a named person, and what was done when it went quiet',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_decision_watches (
         id bigserial PRIMARY KEY,
         watch_id text NOT NULL UNIQUE,
         decision text NOT NULL,
         owner_user_id text NOT NULL,
         owner_name text,
         lane text,
         sop_refs text,
         ns_refs text,
         next_step text,
         channel_id text,
         thread_ts text,
         thread_link text,
         record_kind text,
         record_id text,
         status text NOT NULL DEFAULT 'watching',
         close_reason text,
         closed_by text,
         closed_at timestamptz,
         wait_minutes integer NOT NULL DEFAULT 1440,
         max_reminders integer NOT NULL DEFAULT 3,
         reminders_sent integer NOT NULL DEFAULT 0,
         quiet_since timestamptz NOT NULL DEFAULT now(),
         last_reminder_at timestamptz,
         last_reminder_ts text,
         last_checked_at timestamptz,
         last_error text,
         created_at timestamptz NOT NULL DEFAULT now(),
         created_by text,
         created_via text,
         auto_key text UNIQUE,
         record_hash text,
         fixture boolean NOT NULL DEFAULT false,
         history jsonb NOT NULL DEFAULT '[]'::jsonb
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_decision_watches_open_thread
         ON engine_decision_watches (channel_id, thread_ts, owner_user_id)
         WHERE status = 'watching' AND thread_ts IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS engine_decision_watches_status ON engine_decision_watches (status, last_checked_at)`,
    ],
  },
  {
    id: 71,
    name: 'engine_agent_versions: North Star version changes of 10 and 11 Oct, backfilled, with the hand rollback',
    statements: [
      `INSERT INTO engine_agent_versions (agent_id, name, version_id, previous_version_id, is_rollback, seen_at, eval_state, eval_run_id, eval_detail, settled_at)
       SELECT agent_id, name, version_id, previous_version_id, is_rollback, seen_at::timestamptz, eval_state, eval_run_id, eval_detail, settled_at::timestamptz FROM (VALUES
         ('8NQRXadH0OrKe5XV', 'North Star (Agent)', '1149ec32-e419-40e1-b55c-315c866212c6', '28c4509c-84e2-4dde-a411-6089602c5c71', false, '2026-10-10T22:37:53.170Z', 'failed', 'EVAL-202610102238', $d$Backfilled on 11 Oct 2026 from n8n's version list and the stored eval runs; the publish check was built later that day. EVAL-202610102238: NS-06 failed one repeat in three (no Sources list) and had passed in the run before. The version was rolled back by hand.$d$, '2026-10-10T22:37:53.170Z'),
         ('8NQRXadH0OrKe5XV', 'North Star (Agent)', '28c4509c-84e2-4dde-a411-6089602c5c71', '1149ec32-e419-40e1-b55c-315c866212c6', true, '2026-10-10T23:14:39.608Z', 'superseded', NULL, $d$Backfilled on 11 Oct 2026 from n8n's version list and the stored eval runs; the publish check was built later that day. Rolled back by hand after EVAL-202610102238 failed. n8n keeps no time for publishing an old version again, so this row is dated by the end of that run.$d$, '2026-10-10T23:14:39.608Z'),
         ('8NQRXadH0OrKe5XV', 'North Star (Agent)', 'd5b43089-9f37-434b-8f60-471f27c56539', '28c4509c-84e2-4dde-a411-6089602c5c71', false, '2026-10-11T02:10:33.134Z', 'failed', 'EVAL-202610110210', $d$Backfilled on 11 Oct 2026 from n8n's version list and the stored eval runs; the publish check was built later that day. EVAL-202610110210: NS-04 failed. The check was wrong, not the agent, so the check was revised with a new row in agent_eval_set and the version was kept.$d$, '2026-10-11T02:10:33.134Z')
       ) AS v(agent_id, name, version_id, previous_version_id, is_rollback, seen_at, eval_state, eval_run_id, eval_detail, settled_at)
       WHERE NOT EXISTS (SELECT 1 FROM engine_agent_versions e WHERE e.agent_id = '8NQRXadH0OrKe5XV' AND e.version_id = '1149ec32-e419-40e1-b55c-315c866212c6')`,
      `UPDATE engine_agent_versions SET previous_version_id = 'd5b43089-9f37-434b-8f60-471f27c56539' WHERE agent_id = '8NQRXadH0OrKe5XV' AND version_id = '08671da0-fe32-4000-9b7a-d9a795d7ddc5' AND previous_version_id = '28c4509c-84e2-4dde-a411-6089602c5c71'`,
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, detail, dedupe_key)
       SELECT 'agent_rolled_back', '2026-10-10T23:14:39.608Z'::timestamptz, '8NQRXadH0OrKe5XV', 'ENGINE', 'backfill (migration 71)',
              jsonb_build_object('name', 'North Star (Agent)', 'from', '1149ec32-e419-40e1-b55c-315c866212c6', 'to', '28c4509c-84e2-4dde-a411-6089602c5c71', 'rollback', true, 'reason', 'EVAL-202610102238 failed NS-06', 'backfilled', true),
              'agent_version:backfill:1149ec32'
        WHERE NOT EXISTS (SELECT 1 FROM engine_events WHERE dedupe_key = 'agent_version:backfill:1149ec32')`,
    ],
  },
  {
    id: 72,
    name: 'engine_agent_scorecard: the 11 Oct independent re-score',
    statements: [
      /**
       * 11 Oct 2026, Destiny: three independent read-only re-scores in one day,
       * two in the morning and one in the afternoon, all 74 of 120 (6.2), from
       * 6.1 the evening before. Only cost moved (5 to 6, in the morning). The
       * target of 6.5 was not reached. Stored as the afternoon pass reported.
       * The three credentials in personal projects are out of scope by the
       * owner's ruling.
       */
      `INSERT INTO engine_agent_scorecard (scored_on, dimension, name, score, floor, goal, evidence, source) VALUES
        ('2026-10-11', 1, $v$Governance and inventory$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): Three inventory rows matching n8n's active versions; Bays' row is from 10 Oct; inventory still recorded by hand.$v$, 'rescore'),
        ('2026-10-11', 2, $v$Agent identity and secrets$v$, 5, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): Per-agent bearer credentials unchanged; a fourth read-only two-tool token (Genie) repeats the pattern and is neutral; no rotation on record.$v$, 'rescore'),
        ('2026-10-11', 3, $v$Tool privilege$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): The channel-post guard allowed a real scheduled digest (execution 32823); no organic hold yet; Bays' tool list uncut.$v$, 'rescore'),
        ('2026-10-11', 4, $v$Runtime controls and injection defense$v$, 7, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): No new evidence.$v$, 'rescore'),
        ('2026-10-11', 5, $v$Human oversight$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): Two test cards decided by an approver at 06:02 UTC; still deliberate checks; no refused non-approver click.$v$, 'rescore'),
        ('2026-10-11', 6, $v$Evaluation and testing$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): EVAL-202610111407 was 95 of 95 and still running when read; the publish check's no-eval alert fired for real on Research Twin 96007353; eval still follows the publish.$v$, 'rescore'),
        ('2026-10-11', 7, $v$Observability$v$, 7, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): Token rows today: Bays 22 of 34, North Star 9 of 9, Research Twin 0 of 0; agent-token reads now routine; one day, not a week.$v$, 'rescore'),
        ('2026-10-11', 8, $v$Incident response and recovery$v$, 7, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): Four incidents closed with a specific written reason (audit 1713); credit-out detected within a minute twice; the handler files the credit refusal as a rate limit (LOOP-1791727843989-NA4M, open); INC-GENIE.CONTEXT-002 open.$v$, 'rescore'),
        ('2026-10-11', 9, $v$Change and rollback$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): Two rollback rows written by the check itself; PR 12 conflict-resolved and tested; against it, the eval floor lowered to 5 dollars on an unverified belief and reversed after a dead run, and a merge before an eval.$v$, 'rescore'),
        ('2026-10-11', 10, $v$Reliability and handoffs$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): No new measured evidence; both digests dispatched; credit-out window 06:25 to about 12:10 UTC.$v$, 'rescore'),
        ('2026-10-11', 11, $v$Cost and capacity$v$, 6, 8, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): The credit-out watcher worked on a real event; the account still ran dry after the floor was lowered; one eval_run_cost event.$v$, 'rescore'),
        ('2026-10-11', 12, $v$Data governance and retention$v$, 6, 7, 10, $v$Independent re-score, 11 Oct 2026 afternoon (claude/Agent_Maturity_Rescore_Oct_11_Afternoon.md in the BHA Agent project): No new evidence; retention last ran 6 Oct, 0 cleared.$v$, 'rescore')
       ON CONFLICT (scored_on, dimension) DO NOTHING`,
    ],
  },
  {
    /**
     * 13 Oct 2026, Destiny — agent maturity, evaluation and change control:
     * "the eval still follows the publish". One row per draft eval run: an
     * agent's eval cases asked of its unpublished draft through n8n's
     * call_agent, scored by the runner's own checks, with the draft's config
     * hash read before and after so a draft that changed mid-run is never a
     * verdict. The publish check reads it when a version change is recorded.
     */
    id: 74,
    name: 'engine_draft_eval_runs: an agent draft tested before it is published, and the publish check reading it',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_draft_eval_runs (
         id bigserial PRIMARY KEY,
         run_id text NOT NULL UNIQUE,
         agent text NOT NULL,
         agent_id text NOT NULL,
         agent_name text NOT NULL,
         config_hash_before text,
         config_hash_after text,
         state text NOT NULL DEFAULT 'running',
         detail text,
         cases integer NOT NULL DEFAULT 0,
         results_expected integer NOT NULL DEFAULT 0,
         results_done integer NOT NULL DEFAULT 0,
         cases_passed integer,
         failed_cases jsonb NOT NULL DEFAULT '[]'::jsonb,
         regressed jsonb NOT NULL DEFAULT '[]'::jsonb,
         compared_with text,
         results jsonb NOT NULL DEFAULT '[]'::jsonb,
         credit_before_usd numeric,
         requested_by text,
         started_at timestamptz NOT NULL DEFAULT now(),
         finished_at timestamptz
       )`,
      `CREATE INDEX IF NOT EXISTS engine_draft_eval_runs_agent ON engine_draft_eval_runs (agent_id, finished_at DESC)`,
      `ALTER TABLE engine_agent_versions ADD COLUMN IF NOT EXISTS draft_run_id text`,
      `ALTER TABLE engine_agent_versions ADD COLUMN IF NOT EXISTS draft_state text`,
      `ALTER TABLE engine_agent_versions ADD COLUMN IF NOT EXISTS draft_detail text`,
      `ALTER TABLE engine_agent_versions ADD COLUMN IF NOT EXISTS draft_alert_state text`,
      `ALTER TABLE engine_agent_versions ADD COLUMN IF NOT EXISTS draft_alert_detail text`,
      `ALTER TABLE engine_agent_versions ADD COLUMN IF NOT EXISTS draft_alert_text text`,
    ],
  },
  {
    /**
     * 14 Oct 2026, Destiny (Jason, #workflow-logs-kaiqi: "keep reminding until
     * all three are addressed"). DW-1791901078077-O0B8 closed as answered when
     * Kaiqi replied once, with two of Jason's three asks still owed. A watch on
     * a decision with more than one part now stays open through the owner's
     * reply. Every existing watch keeps today's behaviour (true).
     */
    id: 75,
    name: 'engine_decision_watches.close_on_reply: a multi-part decision is not closed by the first reply',
    statements: [`ALTER TABLE engine_decision_watches ADD COLUMN IF NOT EXISTS close_on_reply boolean NOT NULL DEFAULT true`],
  },
  {
    /**
     * Intake-2 on the lead's own row (14 Oct 2026, Destiny; Hardik's contract
     * of 13 Oct: "extend the current buyer row with intake_2 jsonb +
     * intake_2_completed_at"; Jason the same day: one opaque link per lead,
     * written back onto the existing record, no duplicate contact).
     * `intake_2_invite` holds the invite and every email sent for it; the
     * link's secret is never stored, only its sha256, which is unique so one
     * link can only ever open one lead.
     */
    id: 76,
    name: 'engine_vfarm_leads: Intake-2 invite and answers on the lead row',
    statements: [
      `ALTER TABLE engine_vfarm_leads
         ADD COLUMN IF NOT EXISTS intake_2              jsonb,
         ADD COLUMN IF NOT EXISTS intake_2_completed_at timestamptz,
         ADD COLUMN IF NOT EXISTS intake_2_invite       jsonb`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_vfarm_leads_intake2_token
         ON engine_vfarm_leads ((intake_2_invite->>'token_sha256'))
         WHERE intake_2_invite ? 'token_sha256'`,
    ],
  },
  {
    /**
     * Stage 3, paying (15 Oct 2026, Destiny), as a placeholder: a lead can sit there once its
     * Intake-2 is in, and nothing takes a payment until Jason and Hardik set the price and the
     * Stripe-to-ledger contract.
     */
    id: 77,
    name: 'engine_vfarm_leads: stage 3 (paying, placeholder)',
    statements: [
      `ALTER TABLE engine_vfarm_leads DROP CONSTRAINT IF EXISTS engine_vfarm_leads_stage_check`,
      `ALTER TABLE engine_vfarm_leads ADD CONSTRAINT engine_vfarm_leads_stage_check CHECK (stage IN (1, 2, 3))`,
    ],
  },
  {
    /**
     * The Early Access CRM (15 Oct 2026, Destiny): a next step with a due date, a close with a
     * reason, and the timeline of what a person wrote or did here. `status` and `notes` stay as
     * they are, unread by the new page except as history: nothing drops a column.
     */
    id: 78,
    name: 'engine_vfarm_leads: next step, close with a reason, activity timeline',
    statements: [
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS next_step text`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS next_step_due date`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS closed_at timestamptz`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS closed_reason text`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS closed_note text`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS activity jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE engine_vfarm_leads DROP CONSTRAINT IF EXISTS engine_vfarm_leads_closed_reason_check`,
      `ALTER TABLE engine_vfarm_leads ADD CONSTRAINT engine_vfarm_leads_closed_reason_check CHECK (closed_reason IS NULL OR closed_reason IN ('unresponsive', 'not_a_fit', 'timing', 'price', 'other'))`,
    ],
  },
  {
    // 15 Oct 2026 (Jason, #bha-self-healing): the minimal SPEC-CORE.INCIDENTS-002.
    // pattern_refs and canonical_id on this dashboard's copy of an incident (the
    // BHARAG ledger still refuses keys it does not know), and one row per fault
    // the repair bridge found no pattern for. patternCapture.ts.
    id: 79,
    name: 'incident pattern_refs and canonical_id; engine_pattern_captures',
    statements: [
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS pattern_refs jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS canonical_id text`,
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS pattern_candidate_id text`,
      `CREATE INDEX IF NOT EXISTS engine_incidents_canonical_id ON engine_incidents (canonical_id)`,
      `CREATE TABLE IF NOT EXISTS engine_pattern_captures (
         signature text PRIMARY KEY,
         canonical_id text NOT NULL,
         lane text,
         workflow text,
         failed_node text,
         error_class text,
         state text NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'proposed', 'declined', 'registered', 'failed')),
         candidate_id text,
         candidate_row_id bigint,
         pattern_id text,
         repair_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
         incident_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
         execution_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
         occurrences integer NOT NULL DEFAULT 0,
         first_seen_at timestamptz,
         last_seen_at timestamptz,
         error text,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    ],
  },
  {
    // 17 Oct 2026 (Destiny, D4): the Stripe to ledger rail. One row per Stripe event,
    // keyed on Stripe's own id so a retried delivery is one row; the lead's own payment
    // state beside its other records. No stage, entitlement or subscriber column.
    id: 80,
    name: 'engine_stripe_events; engine_vfarm_leads.stripe_payment',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_stripe_events (
         event_id text PRIMARY KEY,
         type text NOT NULL,
         livemode boolean NOT NULL,
         stripe_created_at timestamptz,
         received_at timestamptz NOT NULL DEFAULT now(),
         session_id text,
         payment_intent text,
         amount bigint,
         currency text,
         lead_id text,
         outcome text CHECK (outcome IS NULL OR outcome IN ('recorded', 'unmatched', 'ignored')),
         detail text,
         raw jsonb NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS engine_stripe_events_lead ON engine_stripe_events (lead_id, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_stripe_events_intent ON engine_stripe_events (payment_intent)`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS stripe_payment jsonb`,
    ],
  },
  {
    // 17 Oct 2026 (Jason, buyer flow v2, SOP 09cb58a7): five stages. 3 is the proposal (was the
    // "paying" placeholder, which no lead was ever in), 4 agreement and deposit, 5 customer. The
    // proposal lives on the lead, its link's hash indexed for the public page.
    id: 81,
    name: 'engine_vfarm_leads: stages 4 and 5, proposal',
    statements: [
      `ALTER TABLE engine_vfarm_leads DROP CONSTRAINT IF EXISTS engine_vfarm_leads_stage_check`,
      `ALTER TABLE engine_vfarm_leads ADD CONSTRAINT engine_vfarm_leads_stage_check CHECK (stage IN (1, 2, 3, 4, 5))`,
      `ALTER TABLE engine_vfarm_leads ADD COLUMN IF NOT EXISTS proposal jsonb`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_vfarm_leads_proposal_token ON engine_vfarm_leads ((proposal->>'token_sha256')) WHERE proposal IS NOT NULL`,
    ],
  },
  {
    // 18 Oct 2026 (Destiny; Kaiqi asked not to be reminded while heads-down on 31 Oct): a watch
    // can be snoozed until a date, at most 14 days ahead, and stays open with its history.
    id: 82,
    name: 'engine_decision_watches: snoozed_until, snoozed_by, owner_seen_until',
    statements: [
      `ALTER TABLE engine_decision_watches ADD COLUMN IF NOT EXISTS snoozed_until timestamptz`,
      `ALTER TABLE engine_decision_watches ADD COLUMN IF NOT EXISTS snoozed_by text`,
      // An owner message up to the snooze is the snooze being asked for, not the answer.
      `ALTER TABLE engine_decision_watches ADD COLUMN IF NOT EXISTS owner_seen_until timestamptz`,
    ],
  },  {
    // 19 Oct 2026 (Destiny, D2.5): an incident a person closes as a test, a probe or noise is
    // marked so, with the reason, and the self-healing scorecard counts it apart from real
    // faults instead of as a person's close. Null is a real incident.
    id: 83,
    name: 'engine_incidents: test_reason, test_marked_by, test_marked_at',
    statements: [
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS test_reason text`,
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS test_marked_by text`,
      `ALTER TABLE engine_incidents ADD COLUMN IF NOT EXISTS test_marked_at timestamptz`,
    ],
  },  {
    // 19 Oct 2026 (Destiny, D2.5): the five incidents a person closed whose own close reason says
    // they were a test, a drill or a guard doing its job, and which no existing rule already
    // counts apart. Read one by one from the 44 person closes, never matched by words in code.
    // Done here because the session that made mark_incidents_test could not reach it yet; any
    // later mark or clear goes through that tool.
    id: 84,
    name: 'engine_incidents: mark five closed tests and drills',
    statements: [
      `UPDATE engine_incidents SET test_reason = 'a pinned test run of Bays — Approval Decision while the approval gate was built (4 Oct); no real request failed', test_marked_by = 'migration 84 (Destiny, 19 Oct 2026, from the incident''s own close reason)', test_marked_at = now() WHERE natural_id = 'INC-BAYS.AGENT-043' AND test_reason IS NULL`,
      `UPDATE engine_incidents SET test_reason = 'a deliberate guard test: a DM to a made-up user id, approved by Destiny, failed channel_not_found as designed (11 Oct)', test_marked_by = 'migration 84 (Destiny, 19 Oct 2026, from the incident''s own close reason)', test_marked_at = now() WHERE natural_id = 'INC-BAYS.AGENT-050' AND test_reason IS NULL`,
      `UPDATE engine_incidents SET test_reason = 'the send-back guard correctly refused Jason answering a send-back meant for Ahad; a guard doing its job, not a fault', test_marked_by = 'migration 84 (Destiny, 19 Oct 2026, from the incident''s own close reason)', test_marked_at = now() WHERE natural_id = 'INC-BAYS.CODEX-030' AND test_reason IS NULL`,
      `UPDATE engine_incidents SET test_reason = 'raised by the 8 Oct protected-repair drill (LOOP-1790805930203-SNI2), which broke the workflow on purpose', test_marked_by = 'migration 84 (Destiny, 19 Oct 2026, from the incident''s own close reason)', test_marked_at = now() WHERE natural_id = 'INC-NS.AGENT-065' AND test_reason IS NULL`,
      `UPDATE engine_incidents SET test_reason = 'raised by the 8 Oct protected-repair drill (LOOP-1790805930203-SNI2), which broke the workflow on purpose', test_marked_by = 'migration 84 (Destiny, 19 Oct 2026, from the incident''s own close reason)', test_marked_at = now() WHERE natural_id = 'INC-NS.AGENT-066' AND test_reason IS NULL`,
    ],
  },  {
    // 20 Oct 2026 (Destiny, LOOP-1792388413323-4E0U): Logstream dated a closed incident by its close,
    // because BHARAG moves occurred_at to each status change. The writer now reads the earlier of
    // occurred_at and first_seen_at (logstream.INCIDENT_AT). Rows already written with the close date
    // are corrected once here: occurred_at moves back, time to recovery is worked out again from the
    // same close (old date + old seconds), and the 7- and 30-day counts are counted again. Each
    // corrected row says so in audit.date_corrected, with the date it held before. 118 rows on 20 Oct.
    id: 85,
    name: 'engine_logstream: date rows by when the incident happened, not its close',
    statements: [
      `WITH inc AS (
         SELECT natural_id,
                coalesce(fields->'payload'->>'workflow_or_scenario', '') AS wf,
                coalesce(fields->'payload'->>'failed_node_or_component', '') AS node,
                LEAST(CASE WHEN fields->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (fields->>'occurred_at')::timestamptz END,
                      CASE WHEN first_seen_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN first_seen_at::timestamptz END) AS at
           FROM engine_incidents WHERE natural_id IS NOT NULL),
       fix AS (
         SELECT l.id, l.occurred_at AS old_at, i.at AS new_at,
                (SELECT count(*) FROM inc o WHERE o.wf = i.wf AND o.node = i.node AND o.at <= i.at AND o.at > i.at - interval '7 days') AS f7,
                (SELECT count(*) FROM inc o WHERE o.wf = i.wf AND o.node = i.node AND o.at <= i.at AND o.at > i.at - interval '30 days') AS f30
           FROM engine_logstream l JOIN inc i ON i.natural_id = l.incident_id
          WHERE i.at IS NOT NULL AND l.occurred_at > i.at + interval '1 minute')
       UPDATE engine_logstream l
          SET occurred_at = f.new_at,
              objective_outcomes = l.objective_outcomes
                || jsonb_build_object('incident_frequency_7d', f.f7, 'incident_frequency_30d', f.f30)
                || CASE WHEN jsonb_typeof(l.objective_outcomes->'time_to_recovery_seconds') = 'number'
                        THEN jsonb_build_object('time_to_recovery_seconds',
                               GREATEST(0, round(extract(epoch FROM (f.old_at + ((l.objective_outcomes->>'time_to_recovery_seconds')::numeric * interval '1 second')) - f.new_at)))::bigint)
                        ELSE '{}'::jsonb END,
              audit = l.audit || jsonb_build_object('date_corrected', jsonb_build_object(
                'from', to_char(f.old_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'to', to_char(f.new_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'reason', 'dated by the incident''s close: BHARAG moves occurred_at on each status change (LOOP-1792388413323-4E0U)'))
         FROM fix f WHERE f.id = l.id`,
    ],
  },
  {
    // 21 Oct 2026, Destiny. A vFarm device was held by its name alone, so two farms sending
    // the same device names overwrote each other: on 21 Oct a one-off snapshot from "Vfarm_01"
    // (9598b09c) used the real rack's names, and the rack's devices sat under that farm until
    // the rack's next snapshot took them back. A device is now one row per farm and name, and so
    // is the Monitoring Twin's judgement of it. Nothing is deleted.
    id: 86,
    name: 'engine_vfarm_devices, engine_monitoring_device_state: one row per farm and device',
    statements: [
      `UPDATE engine_vfarm_devices SET farm_id = '' WHERE farm_id IS NULL`,
      `ALTER TABLE engine_vfarm_devices ALTER COLUMN farm_id SET NOT NULL`,
      `ALTER TABLE engine_vfarm_devices DROP CONSTRAINT engine_vfarm_devices_pkey`,
      `ALTER TABLE engine_vfarm_devices ADD PRIMARY KEY (farm_id, device_id)`,
      `ALTER TABLE engine_monitoring_device_state DROP CONSTRAINT engine_monitoring_device_state_pkey`,
      `ALTER TABLE engine_monitoring_device_state ADD PRIMARY KEY (farm_id, device_id)`,
    ],
  },
  {
    // 21 Oct 2026, Destiny (LOOP-3ASC, the sensor side; DNQO's sensor traces). The devices table
    // holds each sensor's latest reading only, so nothing could show a reading over time and
    // Jegan's sensor captures had nowhere to land. One row per farm, device, metric and the time
    // vFarm says the reading was taken: a reading repeated across snapshots is stored once.
    id: 87,
    name: 'engine_vfarm_readings: every sensor reading a snapshot carries, kept as history',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_vfarm_readings (
         id          bigserial PRIMARY KEY,
         farm_id     text NOT NULL,
         device_id   text NOT NULL,
         metric      text NOT NULL,
         value       double precision NOT NULL,
         unit        text,
         status      text,
         read_at     timestamptz NOT NULL,
         received_at timestamptz NOT NULL DEFAULT now(),
         synthetic   boolean NOT NULL DEFAULT false,
         UNIQUE (farm_id, device_id, metric, read_at)
       )`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_readings_series ON engine_vfarm_readings (farm_id, device_id, metric, read_at DESC)`,
    ],
  },
  {
    // 2026-10-22, Destiny (H58Q): Jason's SOURCE_TO_TARGET_LOG. One row per post of one
    // picture to one place. The rules are in mediaPostLog.ts; the table only holds them.
    id: 88,
    name: 'engine_media_post_log: which vFarm picture went where, and whether it was allowed to',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_media_post_log (
         log_id                text PRIMARY KEY,
         asset_id              text NOT NULL,
         asset_version         text NOT NULL,
         asset_file_id         text,
         source_id             text NOT NULL,
         platform              text NOT NULL,
         classification        text NOT NULL DEFAULT 'CONCEPTUAL',
         verified_current_p1_0 boolean NOT NULL DEFAULT false CHECK (verified_current_p1_0 = false),
         claim_state           text NOT NULL,
         approval              text NOT NULL DEFAULT 'pending',
         approved_by           text,
         approved_at           timestamptz,
         manual_only           boolean NOT NULL DEFAULT true CHECK (manual_only = true),
         automation_enabled    boolean NOT NULL DEFAULT false CHECK (automation_enabled = false),
         utm_url               text,
         publish_result        text NOT NULL DEFAULT 'not_published',
         target_url            text,
         target_id             text,
         read_back             text NOT NULL DEFAULT 'not_checked',
         read_back_detail      text,
         loop_id               text,
         notes                 text,
         logged_by             text NOT NULL,
         test                  boolean NOT NULL DEFAULT false,
         created_at            timestamptz NOT NULL DEFAULT now(),
         updated_at            timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS engine_media_post_log_asset ON engine_media_post_log (asset_id, asset_version)`,
      `CREATE INDEX IF NOT EXISTS engine_media_post_log_created ON engine_media_post_log (created_at DESC)`,
    ],
  },
  {
    // 2026-10-22, Destiny (Jason on the 22 Oct log): the two records "can we charge real buyers"
    // waits on, Hardik's acceptance pass and Jason's live-offer approval. Append-only; the rules
    // are in chargeGate.ts. The CHECKs hold the owners and verdicts even if a second writer appears.
    id: 89,
    name: 'engine_charge_gate: Hardik\'s acceptance pass and Jason\'s live-offer approval',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_charge_gate (
         gate_id          text PRIMARY KEY,
         kind             text NOT NULL CHECK (kind IN ('acceptance_pass', 'offer_approval')),
         rail             text NOT NULL,
         verdict          text NOT NULL,
         decided_by       text NOT NULL,
         evidence_link    text NOT NULL,
         evidence_channel text NOT NULL,
         evidence_ts      text NOT NULL,
         scope            text,
         notes            text,
         recorded_by      text NOT NULL,
         via              text NOT NULL,
         test             boolean NOT NULL DEFAULT false,
         created_at       timestamptz NOT NULL DEFAULT now(),
         CHECK ((kind = 'acceptance_pass' AND decided_by = 'U0BKT6MAW2Y' AND verdict IN ('green', 'red'))
             OR (kind = 'offer_approval' AND decided_by = 'U0A9V97949F' AND verdict IN ('approved', 'withdrawn')))
       )`,
      `CREATE INDEX IF NOT EXISTS engine_charge_gate_latest ON engine_charge_gate (rail, kind, created_at DESC)`,
    ],
  },
  {
    // 2026-10-24, Destiny (D2): a real farm vFarm's snapshot stops listing is "not listed", not a
    // silent feed. Vfarm_01 left the snapshot on 21 Oct 06:36 while v-farm kept arriving every three
    // minutes, and the twin held a critical FEED_SILENT incident on it for two days. Set when a real
    // snapshot leaves the farm out, cleared when one lists it again.
    id: 90,
    name: 'engine_vfarm_farms.unlisted_at: a real farm the snapshot stopped listing',
    statements: [`ALTER TABLE engine_vfarm_farms ADD COLUMN IF NOT EXISTS unlisted_at timestamptz`],
  },
  {
    // 24 Oct 2026, Destiny (D5): the snapshot carried current state only, so rover runs, frames,
    // drain and relay events, commands, device events and alert history never reached the
    // dashboard, and it kept about one reading in sixty. The snapshot's new `history` block lands
    // here, one row per vFarm row (section + vFarm's own key), the row stored whole so a new column
    // vFarm adds flows without a change here. `layout` and `rover_config` are full every tick and
    // land in the same table; an item a listed farm stops sending is marked gone, never deleted.
    // Every reading in `history.readings` goes to engine_vfarm_readings (migration 87).
    id: 91,
    name: 'engine_vfarm_history: everything vFarm records, by section, kept whole',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_vfarm_history (
         section       text NOT NULL,
         source_id     text NOT NULL,
         farm_id       text,
         device_id     text,
         at            timestamptz,
         row           jsonb NOT NULL,
         synthetic     boolean NOT NULL DEFAULT false,
         first_seen_at timestamptz NOT NULL DEFAULT now(),
         updated_at    timestamptz NOT NULL DEFAULT now(),
         gone_at       timestamptz,
         PRIMARY KEY (section, source_id)
       )`,
      `CREATE INDEX IF NOT EXISTS engine_vfarm_history_farm ON engine_vfarm_history (farm_id, section, at DESC)`,
      `ALTER TABLE engine_vfarm_snapshots ADD COLUMN IF NOT EXISTS history jsonb`,
    ],
  },
  {
    // 24 Oct 2026, Destiny (D8): about 1,335 of the 1,379 CST rows came from the automated tests' fake
    // +1 555 numbers and hand-made turn ids, none marked, so every CST figure counted them as
    // customers. A row is a test when the event says so (test: true), when any number on it is a
    // +1 555 one (fictional by design), or when its turn id is not a Twilio SID (CA/SM/MM + 32 hex)
    // or a channel id (voice_/sms_/web_ + uuid). The same rule runs on every write
    // (systemFeeds.cstTestReason); this backfills the rows already held. Nothing is deleted.
    id: 92,
    name: 'engine_cst_turns.test: CST test traffic kept apart from real customers',
    statements: [
      `ALTER TABLE engine_cst_turns ADD COLUMN IF NOT EXISTS test boolean NOT NULL DEFAULT false`,
      `ALTER TABLE engine_cst_turns ADD COLUMN IF NOT EXISTS test_reason text`,
      `UPDATE engine_cst_turns SET test = true, test_reason = CASE
          WHEN coalesce(turn_payload->>'test', delivery_payload->>'test') = 'true' THEN 'sent as a test'
          WHEN coalesce(phone_e164, '') ~ '^\\+?1555[0-9]{7}$'
            OR coalesce(turn_payload::text, '') ~ '(^|[^0-9])1555[0-9]{7}([^0-9]|$)'
            OR coalesce(delivery_payload::text, '') ~ '(^|[^0-9])1555[0-9]{7}([^0-9]|$)' THEN 'a fake +1 555 number'
          ELSE 'a hand-made turn id, not a Twilio or channel id' END
        WHERE test = false AND (
          coalesce(turn_payload->>'test', delivery_payload->>'test') = 'true'
          OR coalesce(phone_e164, '') ~ '^\\+?1555[0-9]{7}$'
          OR coalesce(turn_payload::text, '') ~ '(^|[^0-9])1555[0-9]{7}([^0-9]|$)'
          OR coalesce(delivery_payload::text, '') ~ '(^|[^0-9])1555[0-9]{7}([^0-9]|$)'
          OR (turn_id !~ '^(CA|SM|MM)[0-9a-f]{32}$' AND turn_id !~ '^(voice|sms|web)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))`,
      `CREATE INDEX IF NOT EXISTS engine_cst_turns_real ON engine_cst_turns (occurred_at DESC) WHERE NOT test`,
    ],
  },
  {
    // 0LEW essence markers (24 Oct 2026, Destiny; Jason's calls of 23 Oct). essence.ts holds the rules.
    id: 93,
    name: 'engine_essence_markers: confirmed lines about how a person decides, each with its own quote',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_essence_markers (
        marker_id text PRIMARY KEY,
        subject_id text NOT NULL,
        subject_name text,
        kind text NOT NULL CHECK (kind IN ('decision_rule','trade_off','debugging_instinct','standard','voice')),
        line text NOT NULL CHECK (char_length(line) BETWEEN 8 AND 280),
        quote text NOT NULL CHECK (char_length(quote) BETWEEN 15 AND 400),
        source_kind text NOT NULL CHECK (source_kind IN ('codex_log','review','architect_answer','doctrine_post')),
        source_ref text NOT NULL,
        seen_in text[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected','stable')),
        published boolean NOT NULL DEFAULT false,
        confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        proposed_by text NOT NULL,
        via text NOT NULL DEFAULT 'unknown',
        decided_by text,
        decided_at timestamptz,
        decision_note text,
        test boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (NOT published OR status IN ('confirmed','stable')),
        CHECK (status = 'proposed' OR decided_by IS NULL OR decided_by = subject_id)
      )`,
      `CREATE INDEX IF NOT EXISTS engine_essence_markers_subject ON engine_essence_markers (subject_id, status)`,
      `CREATE INDEX IF NOT EXISTS engine_essence_markers_source ON engine_essence_markers (source_ref)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_essence_markers_once ON engine_essence_markers (subject_id, kind, md5(quote), source_ref)`,
    ],
  },
  {
    // Jason, 23 Oct (#workflow-logs-destiny 1792769106.709119): an offer approval is an offer_approved
    // event with offer_id, loop_id, approver_id, timestamp and a conditions snapshot, and a pass rests on
    // an acceptance bundle. approver_id is decided_by and the timestamp created_at; these four are new.
    // The CHECK is NOT VALID so any earlier row stays as it was; chargeGate.decide() still refuses to count
    // an incomplete one.
    id: 94,
    name: 'engine_charge_gate: offer_id, loop_id, conditions and bundle_ref (Jason\'s offer_approved fields)',
    statements: [
      `ALTER TABLE engine_charge_gate ADD COLUMN IF NOT EXISTS offer_id text`,
      `ALTER TABLE engine_charge_gate ADD COLUMN IF NOT EXISTS loop_id text`,
      `ALTER TABLE engine_charge_gate ADD COLUMN IF NOT EXISTS conditions jsonb`,
      `ALTER TABLE engine_charge_gate ADD COLUMN IF NOT EXISTS bundle_ref text`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engine_charge_gate_offer_fields') THEN
           ALTER TABLE engine_charge_gate ADD CONSTRAINT engine_charge_gate_offer_fields CHECK (
             (kind <> 'offer_approval' OR offer_id IS NOT NULL)
             AND (kind <> 'offer_approval' OR verdict <> 'approved' OR (loop_id IS NOT NULL AND conditions IS NOT NULL))
             AND (kind <> 'acceptance_pass' OR verdict <> 'green' OR bundle_ref IS NOT NULL)) NOT VALID;
         END IF;
       END $$`,
    ],
  },
  {
    // 25 Oct 2026, Destiny: a main agent's draft eval falls back to its Anthropic backup when
    // OpenRouter cannot pay. The run asks the backup, and covers the main draft it was checked
    // against: which agent, and that draft's config hash, so the publish check can match it.
    id: 95,
    name: 'engine_draft_eval_runs: covers_agent_id and covers_config_hash (a backup run that covers its main agent)',
    statements: [
      `ALTER TABLE engine_draft_eval_runs ADD COLUMN IF NOT EXISTS covers_agent_id text`,
      `ALTER TABLE engine_draft_eval_runs ADD COLUMN IF NOT EXISTS covers_config_hash text`,
      `CREATE INDEX IF NOT EXISTS engine_draft_eval_runs_covers ON engine_draft_eval_runs (covers_agent_id, covers_config_hash) WHERE covers_agent_id IS NOT NULL`,
    ],
  },
  {
    // 26 Oct 2026, Destiny: no reply closes a decision watch; it closes on proof. close_on_reply is kept
    // as history and nothing reads it to decide, so every open watch and every new one says false.
    id: 96,
    name: 'engine_decision_watches.close_on_reply: false everywhere (a reply never closes a watch)',
    statements: [
      `ALTER TABLE engine_decision_watches ALTER COLUMN close_on_reply SET DEFAULT false`,
      `UPDATE engine_decision_watches SET close_on_reply = false WHERE status = 'watching' AND close_on_reply`,
    ],
  },
  {
    // 27 Oct 2026, Destiny (7RZT): which provider a draft eval run asked, and why it fell back, were in the tool's
    // answer only. Stored so the engine strain read and the Engine page can count backup runs without parsing detail.
    // Older rows are filled from what they already say: a backup agent's name ends "(Anthropic backup)", and a main
    // agent's fallback run carries covers_agent_id (migration 95).
    id: 97,
    name: 'engine_draft_eval_runs: ran_on and fallback_reason (which provider a run asked, and why it fell back)',
    statements: [
      `ALTER TABLE engine_draft_eval_runs ADD COLUMN IF NOT EXISTS ran_on text`,
      `ALTER TABLE engine_draft_eval_runs ADD COLUMN IF NOT EXISTS fallback_reason text`,
      `UPDATE engine_draft_eval_runs SET ran_on = CASE WHEN agent_name ILIKE '%(Anthropic backup)%' OR covers_agent_id IS NOT NULL THEN 'Anthropic' ELSE 'OpenRouter' END WHERE ran_on IS NULL`,
    ],
  },
  {
    // 27 Oct 2026, Destiny (Jason, #bha-coordination 1792702326.928939: Destiny owns cst-help-manuals, and
    // Hardik's Honest Gate check comes before anything lands there). The CST help pages, held here so the team
    // shares one link to each and the agents read them with their stage. helpPages.ts holds the rules; the
    // three v0 drafts are seeded from the CST Help Corpus v0 Claude Doc, as drafts with their gaps named.
    id: 98,
    name: 'engine_help_pages and engine_help_page_history (CST help pages, draft to checked to in cst-help-manuals)',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_help_pages (
         page_id        text PRIMARY KEY,
         title          text NOT NULL,
         body           text NOT NULL,
         body_sha256    text NOT NULL,
         gaps           jsonb NOT NULL DEFAULT '[]'::jsonb,
         sources        text,
         stage          text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft','checked','in_corpus')),
         checked_by     text,
         checked_at     timestamptz,
         checked_sha256 text,
         check_evidence text,
         bharag_doc_id  text,
         in_corpus_at   timestamptz,
         sort           integer NOT NULL DEFAULT 100,
         updated_by     text NOT NULL,
         updated_at     timestamptz NOT NULL DEFAULT now(),
         created_at     timestamptz NOT NULL DEFAULT now(),
         CHECK (stage = 'draft' OR (checked_by = 'U0BKT6MAW2Y' AND checked_sha256 = body_sha256 AND check_evidence IS NOT NULL)),
         CHECK (stage <> 'in_corpus' OR bharag_doc_id IS NOT NULL)
       )`,
      `CREATE TABLE IF NOT EXISTS engine_help_page_history (
         id           bigserial PRIMARY KEY,
         page_id      text NOT NULL,
         action       text NOT NULL,
         actor        text NOT NULL,
         note         text,
         body_sha256  text,
         stage_before text,
         stage_after  text,
         evidence     text,
         at           timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS engine_help_page_history_page ON engine_help_page_history (page_id, at DESC)`,
      `INSERT INTO engine_help_pages (page_id, title, body, body_sha256, gaps, sources, stage, sort, updated_by) VALUES ('operator-quickstart', $help$Your vFarm pilot, quick start$help$, $help$During the pilot you watch your rack in the vFarm app, and the BHA team makes changes to it. Your pilot channel in Slack is where you reach us, and a person answers every post.

## What you can see

- **Your farm only.** Your login shows your own farm and nothing else.
- **Readings:** temperature, humidity, pH, soil moisture and air quality from the sensors that are reporting.
- **Device status:** which parts of the rack are reporting and which are not.
- **Camera:** snapshots, once your rack's camera is connected and reporting.

A reading is only shown as current when its sensor is reporting live. If a sensor goes quiet, the app shows its last reading and when it was taken.

## What you can change

Your app may show you controls for watering, lights and the rack's settings. During the pilot, please leave those to the BHA team: a change made without us can hide a problem we are watching for. To ask for a change, post it in your pilot channel and say what you want and why.

## How to use your pilot channel

1. **Setting up:** post photos when the rack arrives, as you unbox it and where you place it.
2. **Power, water and network:** confirm each one with a short note and a photo.
3. **Every day:** post one to three sentences on how things look.
4. **If something is wrong:** say what you see, when it started and what you have already tried.
5. **Wins:** share them. They help us as much as the problems do.
6. **Not sure?** Post anyway. There are no silly questions in a pilot.

## What happens after you post

- You get a reply in your thread confirming we have seen it.
- A person then answers, or tells you when they will. We aim for that within 2 hours during our support hours, and never longer than 4 hours.
- If no one has replied in 4 hours, it goes straight to our founder.

## If it is urgent

A leak, a burning smell, sparks or anything that feels unsafe is urgent. Keep away from water near anything electrical, switch the rack off at the wall only if you can do so safely, then post **URGENT** in your channel. We send you the steps to make it safe first and look into the cause after.$help$, 'a7869472ec2d84e7f78f3fcb8cbe42e869024cbe9d7af934b6bfbd51c8a0e2d6', $help$[{"id": "operator-controls", "owner": "Jegan", "note": "Confirm that during the pilot operators only watch and the BHA team makes every change (watering, lights, rack settings). If operators may change anything themselves today, this page says so."}]$help$::jsonb, $help$SOP cst-help-manuals Content Standard (b1fabe02), SOP CST Help Not Production-Safe (646f9455), LOOP-1790541544543-8E8D (wet loop and burn-in), go/no-go draft (FVA9), the pilot channel's pinned note, the KMG9 test record of 26 Oct, and Ahad's CST release audit.$help$, 'draft', 1, 'U0AEW3TBYH1') ON CONFLICT (page_id) DO NOTHING`,
      `INSERT INTO engine_help_page_history (page_id, action, actor, note, body_sha256, stage_after) SELECT 'operator-quickstart', 'created', 'U0AEW3TBYH1', 'Seeded from the CST Help Corpus v0 Claude Doc, 27 Oct 2026', 'a7869472ec2d84e7f78f3fcb8cbe42e869024cbe9d7af934b6bfbd51c8a0e2d6', 'draft' WHERE NOT EXISTS (SELECT 1 FROM engine_help_page_history WHERE page_id = 'operator-quickstart')`,
      `INSERT INTO engine_help_pages (page_id, title, body, body_sha256, gaps, sources, stage, sort, updated_by) VALUES ('rack-care', $help$Caring for your rack and reservoir$help$, $help$The one job that keeps your rack healthy is a quick look for leaks and a dry floor. Anything that means opening, draining or cleaning the water system is done with the BHA team, step by step, until our written cleaning guide is ready.

## How the water moves

1. A pump in the reservoir (150 litres) lifts water up to the growing tray.
2. The tray drains back into the reservoir through a motorised valve.
3. An overflow outlet in the tray wall joins the same drain line, so the tray cannot overfill.
4. A top-up line, with its own valve, refills the reservoir.

The rack's pump and valve each run on a safety timer, so neither can run on and on by itself.

## Your weekly check (about 5 minutes)

- [ ] The floor under and around the reservoir is dry.
- [ ] No drips at the drain valve, the pipe joints or the tray outlet.
- [ ] The tray drains after watering and is not left standing full.
- [ ] Take one photo of the reservoir and tray, and post it in your pilot channel.

If you find water where it should not be, treat it as urgent: see "If it is urgent" on the quick start page.

## Cleaning and draining

The steps for draining the reservoir, cleaning the tray and flushing the lines, and how often to do each, are not written yet. Until they are, do not drain or take apart the water system yourself. Post in your pilot channel and we will walk you through it live.

## Filters

The current rack has no filter for you to clean or change.

## What changes when plants go in

Your rack is currently running on water only. When plants go in, this page gets a second update with plant-specific care.$help$, 'ad2bd8f2048bb34cee8fd8dd60e1af7070831e5239ab8120e72ae85654a985df', $help$[{"id": "cleaning-steps", "owner": "Jegan", "note": "The steps for draining the reservoir, cleaning the tray and flushing the lines, in the order they are done, and how often to do each."}, {"id": "plant-stage-care", "owner": "Jegan", "note": "Plant-stage care to add when plants go in: water changes, any nutrient mix, and how often."}]$help$::jsonb, $help$SOP cst-help-manuals Content Standard (b1fabe02), SOP CST Help Not Production-Safe (646f9455), LOOP-1790541544543-8E8D (wet loop and burn-in), go/no-go draft (FVA9), the pilot channel's pinned note, the KMG9 test record of 26 Oct, and Ahad's CST release audit.$help$, 'draft', 2, 'U0AEW3TBYH1') ON CONFLICT (page_id) DO NOTHING`,
      `INSERT INTO engine_help_page_history (page_id, action, actor, note, body_sha256, stage_after) SELECT 'rack-care', 'created', 'U0AEW3TBYH1', 'Seeded from the CST Help Corpus v0 Claude Doc, 27 Oct 2026', 'ad2bd8f2048bb34cee8fd8dd60e1af7070831e5239ab8120e72ae85654a985df', 'draft' WHERE NOT EXISTS (SELECT 1 FROM engine_help_page_history WHERE page_id = 'rack-care')`,
      `INSERT INTO engine_help_pages (page_id, title, body, body_sha256, gaps, sources, stage, sort, updated_by) VALUES ('what-cst-can-do', $help$What the BHA assistant can and cannot do for you today$help$, $help$The BHA assistant answers general questions from these help pages and hands everything else to a person. It does not see your farm's data, and it never guesses.

## It can

- Answer general questions about the pilot, the rack and how to use your pilot channel, from these help pages.
- Point you to the right page or step.
- Pass your question to a person on the BHA team.

## It cannot, today

- **See your farm's readings or device status.** It has no access to your farm's data, by design. For live readings, use the vFarm app. If the app is unavailable, it says so and stops.
- **Diagnose or fix a device, or change your rack's settings.** A person does that, through your pilot channel.
- **Quote prices, take payments or confirm an order.** A person on the team does that, by email.
- **Promise harvests, yields or returns.** No one at BHA makes those promises yet.
- **Give dates for shipping or new features.** A person answers those.

## Labelled as general guidance

While we finish testing the assistant, its answers are marked as general guidance. Check anything that matters with a person in your pilot channel.

## Questions about buying

If you ask about buying, you will see: "We've received your question. A member of the team will reply by email. For now this is manual and not instant." A named person on the team owns every one of those questions.$help$, '51af8c6764ecef6fa9986a0bd35b8900f24ca7d9618d2184ff82819d360d6b76', $help$[]$help$::jsonb, $help$SOP cst-help-manuals Content Standard (b1fabe02), SOP CST Help Not Production-Safe (646f9455), LOOP-1790541544543-8E8D (wet loop and burn-in), go/no-go draft (FVA9), the pilot channel's pinned note, the KMG9 test record of 26 Oct, and Ahad's CST release audit.$help$, 'draft', 3, 'U0AEW3TBYH1') ON CONFLICT (page_id) DO NOTHING`,
      `INSERT INTO engine_help_page_history (page_id, action, actor, note, body_sha256, stage_after) SELECT 'what-cst-can-do', 'created', 'U0AEW3TBYH1', 'Seeded from the CST Help Corpus v0 Claude Doc, 27 Oct 2026', '51af8c6764ecef6fa9986a0bd35b8900f24ca7d9618d2184ff82819d360d6b76', 'draft' WHERE NOT EXISTS (SELECT 1 FROM engine_help_page_history WHERE page_id = 'what-cst-can-do')`,
    ],
  },
  {
    // 27 Oct 2026, Destiny (Jason in #bha-coordination 1793095655.765219): the pilot rule is confirmed, operators
    // watch and the team makes every change. The quickstart now says it is the current pilot rule and that any change
    // will be written into the help pages first, and its operator-controls gap is closed. Written here because the
    // connector in use does not list write_help_page yet; the history line and event are the ones helpPages.write writes.
    id: 99,
    name: 'engine_help_pages: operator-quickstart states the pilot rule (Jason, 27 Oct), operator-controls gap closed',
    statements: [
      `UPDATE engine_help_pages SET body = $help$During the pilot you watch your rack in the vFarm app, and the BHA team makes changes to it. Your pilot channel in Slack is where you reach us, and a person answers every post.

## What you can see

- **Your farm only.** Your login shows your own farm and nothing else.
- **Readings:** temperature, humidity, pH, soil moisture and air quality from the sensors that are reporting.
- **Device status:** which parts of the rack are reporting and which are not.
- **Camera:** snapshots, once your rack's camera is connected and reporting.

A reading is only shown as current when its sensor is reporting live. If a sensor goes quiet, the app shows its last reading and when it was taken.

## What you can change

During the pilot, you watch and the BHA team makes every change. This is the current pilot rule. Your app may show you controls for watering, lights and the rack's settings; please leave those to the BHA team, because a change made without us can hide a problem we are watching for. To ask for a change, post it in your pilot channel and say what you want and why.

If what you can do yourself changes later, this page and the other help pages will say so first. Until they do, nothing here is permission to use a control.

## How to use your pilot channel

1. **Setting up:** post photos when the rack arrives, as you unbox it and where you place it.
2. **Power, water and network:** confirm each one with a short note and a photo.
3. **Every day:** post one to three sentences on how things look.
4. **If something is wrong:** say what you see, when it started and what you have already tried.
5. **Wins:** share them. They help us as much as the problems do.
6. **Not sure?** Post anyway. There are no silly questions in a pilot.

## What happens after you post

- You get a reply in your thread confirming we have seen it.
- A person then answers, or tells you when they will. We aim for that within 2 hours during our support hours, and never longer than 4 hours.
- If no one has replied in 4 hours, it goes straight to our founder.

## If it is urgent

A leak, a burning smell, sparks or anything that feels unsafe is urgent. Keep away from water near anything electrical, switch the rack off at the wall only if you can do so safely, then post **URGENT** in your channel. We send you the steps to make it safe first and look into the cause after.$help$, body_sha256 = 'e8463ab2fc18b34ba0fa3487b8129e29f4e9a469164316a8e08208566ef5b0df', gaps = '[]'::jsonb, stage = 'draft', checked_by = NULL, checked_at = NULL, checked_sha256 = NULL, check_evidence = NULL, bharag_doc_id = NULL, in_corpus_at = NULL, updated_by = 'U0AEW3TBYH1', updated_at = now() WHERE page_id = 'operator-quickstart' AND body_sha256 <> 'e8463ab2fc18b34ba0fa3487b8129e29f4e9a469164316a8e08208566ef5b0df'`,
      `INSERT INTO engine_help_page_history (page_id, action, actor, note, body_sha256, stage_before, stage_after) SELECT 'operator-quickstart', 'edited', 'U0AEW3TBYH1', 'Pilot rule confirmed by Jason (#bha-coordination 1793095655.765219): stated as the current pilot rule; operator-controls gap closed', 'e8463ab2fc18b34ba0fa3487b8129e29f4e9a469164316a8e08208566ef5b0df', 'draft', 'draft' WHERE NOT EXISTS (SELECT 1 FROM engine_help_page_history WHERE page_id = 'operator-quickstart' AND body_sha256 = 'e8463ab2fc18b34ba0fa3487b8129e29f4e9a469164316a8e08208566ef5b0df')`,
      `INSERT INTO engine_events (event_type, subject_id, lane, actor, detail) SELECT 'help_page_written', 'operator-quickstart', 'CST', 'U0AEW3TBYH1', jsonb_build_object('created', false, 'text_changed', true, 'stage_before', 'draft', 'stage_after', 'draft', 'gaps', 0, 'body_sha256', 'e8463ab2fc18b34ba0fa3487b8129e29f4e9a469164316a8e08208566ef5b0df', 'via', 'migration 99') WHERE NOT EXISTS (SELECT 1 FROM engine_events WHERE event_type = 'help_page_written' AND subject_id = 'operator-quickstart' AND detail->>'body_sha256' = 'e8463ab2fc18b34ba0fa3487b8129e29f4e9a469164316a8e08208566ef5b0df')`,
    ],
  },
  {
    // 28 Oct 2026, Destiny (D3 — Kavin's rover log of 26 Oct, NAFB): vFarm's bharag ledger lanes can be
    // told "accepted" while writing nothing (0 of 8 sensor entries, 26 Oct), and the only trace was a
    // log line. Each snapshot may now carry a `ledger_writes` report per lane and farm; it is kept on the
    // snapshot row whole, and the Monitoring Twin opens an incident on any refused entry.
    id: 100,
    name: 'engine_vfarm_snapshots.ledger_writes: vFarm ledger lanes report what they wrote and what was refused',
    statements: [`ALTER TABLE engine_vfarm_snapshots ADD COLUMN IF NOT EXISTS ledger_writes jsonb`],
  },
  {
    // 29 Oct 2026, Destiny (Jason's yes, DM D0AF0DG8ZPY 1793181986.036119): the code check, Destiny's second
    // review of every approved log against what is live, from 1 Nov. One row per Codex entry checked, in the
    // format Jason confirmed; the discrepancy catalog is read from these rows. And the three things Jason asked
    // November to produce, seeded as not started: the catalog, one definition of done checklist per lane he
    // named, and the v2 spec. codeChecks.ts holds the rules.
    id: 101,
    name: 'engine_code_checks and engine_audit_outputs (second review of approved logs, and November\'s outputs for Jason)',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_code_checks (
         codex_entry_id   text PRIMARY KEY,
         builder_slack_id text,
         builder_name     text,
         session_date     text,
         approved_at      timestamptz,
         posted_at        timestamptz NOT NULL,
         check_link       text NOT NULL,
         verdict          text NOT NULL CHECK (verdict IN ('matches','partly','overstated')),
         verdict_reason   text NOT NULL,
         claims           jsonb NOT NULL DEFAULT '[]'::jsonb,
         missing          jsonb NOT NULL DEFAULT '[]'::jsonb,
         couldnt_check    text,
         pay_call         text NOT NULL CHECK (pay_call IN ('as_logged','partly','hold')),
         follow_ups       jsonb NOT NULL DEFAULT '[]'::jsonb,
         recorded_by      text NOT NULL,
         created_at       timestamptz NOT NULL DEFAULT now(),
         updated_at       timestamptz NOT NULL DEFAULT now(),
         CHECK (NOT (verdict = 'overstated' AND pay_call = 'as_logged'))
       )`,
      `CREATE INDEX IF NOT EXISTS engine_code_checks_posted ON engine_code_checks (posted_at DESC)`,
      `CREATE TABLE IF NOT EXISTS engine_audit_outputs (
         output_id  text PRIMARY KEY,
         kind       text NOT NULL CHECK (kind IN ('catalog','dod_checklist','v2_spec')),
         lane       text,
         title      text NOT NULL,
         status     text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','drafting','ready_for_jason','accepted')),
         due        text,
         link       text,
         note       text,
         sort       integer NOT NULL DEFAULT 100,
         updated_by text NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `INSERT INTO engine_audit_outputs (output_id, kind, lane, title, status, due, note, sort, updated_by) VALUES
         ('discrepancy-catalog', 'catalog', NULL, 'Discrepancy catalog: where logs were overstated against what is live', 'not_started', '2026-11-30', 'Built from every code check marked partly or overstated; the rows below are the catalog as it stands.', 1, 'U0AEW3TBYH1'),
         ('dod-cst-comms', 'dod_checklist', 'CST and the core comms engine', 'Definition of done: CST and the core comms engine', 'not_started', '2026-11-30', NULL, 2, 'U0AEW3TBYH1'),
         ('dod-genie-engines', 'dod_checklist', 'Slack Genie and the Log, Guide and Briefing engines', 'Definition of done: Slack Genie and the Log, Guide and Briefing engines', 'not_started', '2026-11-30', NULL, 3, 'U0AEW3TBYH1'),
         ('dod-vfarm-p1', 'dod_checklist', 'vFarm P1 (cabinet, rover, telemetry, alerts)', 'Definition of done: vFarm P1 (cabinet, rover, telemetry, alerts)', 'not_started', '2026-11-30', NULL, 4, 'U0AEW3TBYH1'),
         ('dod-ns-comp-infra', 'dod_checklist', 'North Star and SE8L, comp and engine infra', 'Definition of done: North Star and SE8L, comp and engine infra', 'not_started', '2026-11-30', NULL, 5, 'U0AEW3TBYH1'),
         ('v2-execution-audit-spec', 'v2_spec', NULL, 'v2 execution audit spec: Bays or Genie run the first tier of checks against code and services', 'not_started', '2026-11-30', NULL, 6, 'U0AEW3TBYH1')
       ON CONFLICT (output_id) DO NOTHING`,
    ],
  },
  {
    /**
     * 27 Oct 2026, Hardik (SE8L / DW-1792507157643-YEAO). Three tables the doctrine-gap watcher keeps
     * so that what it counts survives a crash, a retry and two instances overlapping on a deploy.
     * Additive only: nothing reads them before this commit and nothing writes them while the watcher
     * is OFF.
     *   - sweeps: one row per pass. `seq` is the identity every reading in the pass carries, and a
     *     pass taken over after its owner went quiet keeps its seq; `owner_token` changes on takeover
     *     and is checked inside every write the pass makes (the fence).
     *   - episodes: one unbroken run of a needs_evidence / stale_evidence gap on one key, the only
     *     thing the seven-day Research Twin rule is measured on.
     *   - alarms: one row per recovery key, for opening its incident exactly once and for the rolling
     *     24 hours between restatements of an open one.
     */
    id: 102,
    name: 'SE8L: doctrine-gap sweeps (fenced), gap episodes and alarms',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_doctrine_gap_sweeps (
        seq BIGSERIAL PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('running', 'done')),
        owner_token TEXT NOT NULL,
        owner_version INTEGER NOT NULL DEFAULT 1,
        claimed_by TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        keys_processed INTEGER NOT NULL DEFAULT 0,
        claims_read INTEGER,
        resolver_error TEXT,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_doctrine_gap_sweeps_one_running ON engine_doctrine_gap_sweeps ((true)) WHERE state = 'running'`,
      `CREATE TABLE IF NOT EXISTS engine_doctrine_gap_episodes (
        id BIGSERIAL PRIMARY KEY,
        episode_id TEXT NOT NULL UNIQUE,
        recovery_key TEXT NOT NULL,
        research_key TEXT NOT NULL,
        surface TEXT NOT NULL,
        doctrine_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        condition TEXT NOT NULL,
        first_sweep_seq BIGINT NOT NULL,
        last_sweep_seq BIGINT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        last_confirmed_at TIMESTAMPTZ NOT NULL,
        confirmations INTEGER NOT NULL DEFAULT 1,
        continuity TEXT NOT NULL DEFAULT 'verified' CHECK (continuity IN ('verified', 'unverified')),
        continuity_note TEXT,
        ended_at TIMESTAMPTZ,
        end_reason TEXT CHECK (end_reason IN ('recovered', 'condition_changed', 'continuity_broken', 'clock_doubt')),
        detail JSONB NOT NULL DEFAULT '{}'::jsonb
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_doctrine_gap_episodes_one_open ON engine_doctrine_gap_episodes (recovery_key) WHERE ended_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS engine_doctrine_gap_episodes_research ON engine_doctrine_gap_episodes (research_key) WHERE ended_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS engine_doctrine_gap_alarms (
        recovery_key TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('opening', 'open', 'closed')),
        claim_token TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ledger_id TEXT,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        last_restated_at TIMESTAMPTZ,
        restatements INTEGER NOT NULL DEFAULT 0,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb
      )`,
    ],
  },
  {
    // 2026-10-28, Destiny (D3): the evidence store. One row per document, never edited or deleted:
    // a correction is a new version (same name, supersedes the old id). The charge gate's green
    // acceptance pass names one of these ids. See server/src/evidence.ts.
    id: 103,
    name: 'Evidence store: engine_evidence, append-only, versioned by name',
    statements: [
      `CREATE TABLE IF NOT EXISTS engine_evidence (
        evidence_id TEXT PRIMARY KEY CHECK (evidence_id ~ '^EV-[0-9]{10,}-[A-Z0-9]{4}$'),
        name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
        version INTEGER NOT NULL CHECK (version >= 1),
        title TEXT NOT NULL,
        proves TEXT NOT NULL CHECK (length(proves) >= 10),
        gate TEXT,
        loop_id TEXT CHECK (loop_id IS NULL OR loop_id ~ '^LOOP-[0-9]{10,}-[A-Z0-9]{4}$'),
        author_id TEXT NOT NULL,
        author_name TEXT,
        written_at TIMESTAMPTZ,
        saved_by TEXT NOT NULL,
        saved_by_name TEXT,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        via TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('slack_file', 'text')),
        source_ref TEXT,
        file_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_sha256 TEXT NOT NULL,
        file_bytes BYTEA NOT NULL,
        text TEXT NOT NULL,
        text_chars INTEGER NOT NULL,
        text_sha256 TEXT NOT NULL,
        extract JSONB NOT NULL DEFAULT '{}'::jsonb,
        supersedes TEXT REFERENCES engine_evidence (evidence_id),
        notes TEXT,
        test BOOLEAN NOT NULL DEFAULT false,
        UNIQUE (name, version, test)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_evidence_one_successor ON engine_evidence (supersedes) WHERE supersedes IS NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS engine_evidence_file_once ON engine_evidence (file_sha256, test)`,
      `CREATE INDEX IF NOT EXISTS engine_evidence_saved ON engine_evidence (saved_at DESC)`,
      `CREATE INDEX IF NOT EXISTS engine_evidence_gate ON engine_evidence (lower(gate)) WHERE gate IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS engine_evidence_loop ON engine_evidence (loop_id) WHERE loop_id IS NOT NULL`,
      `CREATE OR REPLACE FUNCTION engine_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'engine_evidence is append-only: a record is never edited or deleted; save a new version that supersedes it';
       END $$`,
      `DROP TRIGGER IF EXISTS engine_evidence_no_change ON engine_evidence`,
      `CREATE TRIGGER engine_evidence_no_change BEFORE UPDATE OR DELETE ON engine_evidence FOR EACH ROW EXECUTE FUNCTION engine_evidence_append_only()`,
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
