# CLAUDE.md — BHA Engine Dashboard

Read this at the start of every session. It is the standing spec for this repo.

---

## 1. What this is

Bays Horizon Advisory (BHA) runs an automation engine on self-hosted n8n. It has
several subsystems: **Bays** (a Slack-facing AI agent), **Research Twin** (RT),
**North Star** (NS), **Codex** (builder session logging), **BHARAG** (the RAG /
storage platform), and **vFarm** (a physical vertical-farm product).

The engine has no window. Its state is scattered across Airtable bases, BHARAG,
and n8n's own execution history. Nobody can see it without opening six places by
hand.

**This repo is that window.** An internal dashboard for the BHA team — roughly
six people. Not a customer product.

Owner: Destiny Arupi, Engine Steward at BHA.

---

## 2. Hard rules

1. **No secrets in this repo.** API endpoint URLs and tokens are environment
   variables, injected at deploy. Never commit a `.env` with real values.
2. **No invented data on screen.** If a value isn't available, the UI says so.
   Never fill a panel with plausible-looking filler to make it look complete.
3. **Maintain `BUILD_LOG.md`** (see section 9). Append as you work, never
   rewrite earlier entries.
4. **The browser never talks to Airtable, BHARAG, Slack or n8n directly.** It
   calls this repo's own server, and only the server talks to the engine. See
   section 4. No engine key or credential is ever compiled into the bundle.
5. **Ask before changing scope.** If a section seems to need a new dependency
   or a new external service, stop and raise it rather than building it. The
   server in `server/` was added on Destiny's instruction (2026-09-08). It has
   exactly one dependency, `pg`, added on Destiny's instruction (2026-09-12)
   when state moved to Postgres. That is the ceiling, not a precedent.
6. **Never rename a field the engine writes.** Rows carry Airtable's own field
   names verbatim and n8n writes those names; a rename breaks the engine's
   writes silently, which is the failure this migration existed to end.

---

## 3. Connectors — use them

This project has Slack, Google Drive and n8n connectors available. Run `/mcp`
in your first session and confirm they're attached.

Use them to ground your work rather than guessing:

- **n8n** — read the actual workflows to understand what the engine does and
  what data exists. Do not modify any workflow. Read only.
- **Slack** — search `#bha-coordination`, `#workflow-logs-destiny`,
  `#bha-pipeline-errors` for context on what the team is building and why.
- **Google Drive** — where session narrations and reference docs live, and where
  you upload `BUILD_LOG.md` at the end of each session.

---

## 4. Architecture

A React front end and a small Node server, deployed together as one Render web
service. The server serves the built front end and answers every `/api` call.

```
Browser  →  server in this repo (/api, same origin)  →  one JSON endpoint on the BHA engine  →  data sources
```

The server owns every secret: the login credential, the session signing key
and the engine API key. It verifies sign-in, sets an HttpOnly session cookie,
rejects any `/api` request without a live cookie, and is the only path from the
browser to the engine. The engine endpoint fans out to Airtable, BHARAG and n8n
execution history and returns one response. Neither side of this app knows or
cares where anything came from.

**Every record comes from the engine, into Postgres** (decision 2026-09-13,
Destiny — step 3 of the migration). n8n writes each record to
`POST /api/engine/:kind` and it lands in that kind's `engine_*` table; the page
reads that row. There is no Airtable read path: `sync.ts`, `airtable.ts`, the
backfill and `AIRTABLE_API_KEY` were removed the same day, after the tables
were backfilled (1,425 rows) and the engine's writes were proved correct
against Airtable's copy. A kind n8n has not been pointed at is not stale, it is
stopped, and the **Engine writes** tab of the System Registry names it.

**Airtable's own field names are kept verbatim.** Each row stores
`{ airtable_record_id, created_time, fields }` with `fields` exactly as the
Airtable REST API shapes it — `What`, `Jason Status`, `Layer1 Review ` with its
trailing space. n8n writes those names and a rename breaks its writes with no
error. `server/src/sources.ts` still holds where each kind came from, its field
names and its select vocabularies, all read from the live bases rather than
assumed, and its mappers are what turn a row into a record. The base and table
ids stay so every row can still link back to Airtable.

Where each kind came from, and still links to: loops `appUVlBSGGPHw6DGh`, one
table per builder. **Codex entries, BHA Submissions & Logs
(`appEmdKshNVTl64Zf`), one table per builder** (decision 2026-09-10, Destiny) —
the builder is the table a row lives in, never a field, and the completed entry
is the `Orchestrator Layer2 Review` column. Build patterns `app5ni3E8r7Lvxk22`,
commercial `appvLglfdCqOKqLpT`. **The twins write to their own ledgers**
(decision 2026-09-17, Destiny): North Star's asks
`appRvx4u9V9BYp646 / tblSb9potJlYg2lZK`, Research Twin's asks
`appv39nQzmfC9VVkG / tblDmsqI9f0xfAO5m` and its research queue
`appv39nQzmfC9VVkG / tblOsznfDELJdbyDR`. The watched clients
`appkSUSh9ijNjP2f8`, whose index row names its own questions table in
`Table ID` — carried on each question row, never hardcoded.
The incident and vFarm fixtures are read only by the Overview's two 24-hour
columns now; their own pages are placeholders and the Builders page is gone
(2026-09-14, Destiny). **The Overview's two twin tiles and its asks figure read
the ledgers** (2026-09-17): they were the last fixtures left computing a number
about a page that now holds real rows, which is the disagreement section 2
forbids.

**Five Airtable tables are `[LEGACY]` and are read by nothing here** (decision
2026-09-17, Destiny): `appkCTjhH8PtYRFI7 / tbl9OGZTyvBKrbeFm` (NS Records),
`appud969Dw7H4tMwv / tblUl8YHhQReDgq8G` (Research Queue),
`app4QnMJ2woiKlLc0 / tblWdsbejQ9IYYHm1` (its resolved-events table),
`appSoakKvs7MLkRnX / tblvEivGSXUs5SXaG` (the priority ledger) and
`appxkIgnLL1zBsXqD / tblbuOUGPLt4nIi0G` (Lane_status). They have no writers.
They stay listed in the System Registry, because they hold real history and a
base that vanished from the registry would read as one that was never there.
`engine_ns_records` and `engine_rt_attempts` keep the rows they hold, unread,
like the `records` read model — nothing drops a table.

**State lives in Postgres** (decision 2026-09-12, Destiny): `bha-engine-db` on
the same Render environment, reached through `DATABASE_URL`. It replaces the
SQLite file under `DATA_DIR`, which Render wiped on every deploy and every
spin-down. `pg` is the server's one dependency past Node itself, granted
explicitly for this. Therefore:

- **The server does not start without the database.** A missing
  `DATABASE_URL`, or one it cannot reach, prints the reason and exits. There
  is deliberately no fallback store: a silent fallback is how writes go
  missing without anyone noticing.
- **The schema is forward-only migrations** in `server/src/migrations.ts`, run
  on boot, idempotent, serialised by an advisory lock. Nothing drops a table.
  A shape change is a migration that alters a table — never a silent drop,
  because `events` and `observations` are real history. The old `records` read
  model is still there, unread, for the same reason.
- **These tables are the record.** There is no second copy and nothing to
  resync. `mirror.ts` is the one way a row gets in; `store.ts` reads the tables
  and maps them through `sources.ts`.
- **Every write from the interface goes to the same row**, keeping every field
  it already had — `fields` is stored whole, so a write that replaced it with
  the two keys the interface knows about would drop the rest. If n8n later
  pushes the same record carrying Airtable's copy of those fields, that push
  wins: it is the newer statement.
- **Loop and Codex edits are written straight to Airtable** (decisions
  2026-09-14, Destiny). `AIRTABLE_TOKEN` on the Open Loops base
  (`AIRTABLE_OPEN_LOOPS_BASE_ID`) and BHA Submissions
  (`AIRTABLE_SUBMISSIONS_BASE_ID`) — one variable per base, each named for its
  base, and no built-in default on the loops one, because a default is a guess
  about which base real loops are written to. **The token needs read and write
  on both bases**; render.yaml and .env.example said "the Open Loops base and
  nothing else" until 14 Sep, and a token scoped that way authenticates and
  then refuses every read of the submissions base —
  no other record kind is read from or written to Airtable, and the pages still
  read Postgres. It exists because the 08:00 Open Loops digest reads Airtable, so a
  close that stopped at Postgres came back the next morning as though nothing
  had happened. The n8n write-back that stood here for a day is retired: it
  handled the status only, and two paths writing the same field is the thing
  worth avoiding. **Postgres first, then Airtable.** The Airtable write never
  blocks or rolls back the Postgres write, and a write that does not land is
  stored on the loop and shown on it — a loop the dashboard calls closed while
  Airtable still says open must never look cleanly closed. See
  `server/src/loops.ts` and `server/src/airtable.ts`.
- **The write-back is behind `AIRTABLE_WRITEBACK` and is off** (decision
  2026-09-21, Destiny). The workspace is over its monthly API cap, so every one
  of those calls answers 429, and these tables are the record. The code is not
  deleted — the cap resets and the final import still needs the reads beside it
  — it is gated, and the four write paths answer `skipped` rather than `failed`.
  **Off, a page edit says nothing about Airtable**: no error, no "not in
  Airtable" marker, because nothing failed, and a warning about a system that is
  deliberately no longer the record is worse than no warning. Two things follow
  from it. **A builder move lands in Postgres**, because with nothing asking
  Airtable it lands here or it has not happened at all — the rule above holds
  only while the write-back is on. And a **Retry now on a duplicate stays a
  duplicate** and says why: that button exists to delete an Airtable row, the
  copy really is still in two tables, and saying nothing would be claiming a
  repair that did not happen. **The resync buttons are not behind this flag**:
  they are reads, and they are how the final import happens.
- **The final import is a different pass from the resync, deliberately**
  (decision 2026-09-22, Destiny). `POST /api/engine/final-import/:group`,
  behind the session cookie like the resync buttons, and one button on Engine
  health that runs all nine Airtable-backed groups in turn.
  A resync is Airtable-wins and **deletes what Airtable no longer has**, which
  is right while Airtable is the record and catastrophic afterwards: every row
  the engine has written here since the cutover has no Airtable copy at all. So
  the final import inserts what is missing, updates a row **only** where nothing
  has written it here since the cutover or its last write was a resync, and
  otherwise **keeps what is here and names it** with both values and the field
  that differs. **It never deletes.** It is not a flag on the resync: one
  function that sometimes lets Airtable win and sometimes does not is one nobody
  can reason about at the moment they are about to run it. The cutover line is
  `2026-09-21T00:00Z` and is a constant rather than a parameter — a caller able
  to move it could move it past a real change. Incidents are not a group: they
  come from BHARAG, so there is no Airtable copy to import.
  **Eleven groups from 2026-09-23**, the two new ones being `builders` and
  `bays`. The four Bays tables are engine-only from here on — nothing resyncs
  them and n8n writes them directly — but every one holds real history in
  Airtable that has to come across once, which is exactly what this pass is for
  and why they are in it without being on a resync button.
  **`channel_tracking` is the one that matters**: it maps each Slack channel to
  the capture doc it is currently writing into, and `Bays — Message Capture`
  reads it on every message. Cut over against an empty table it would start
  every channel from nothing and lose the mapping. For the tables with no id
  column of their own — Review Returns, Deep Think Log, Pattern Candidates —
  imported rows are keyed on **Airtable's record id**, because that is the only
  stable thing they carry; the same key decides whether a row is already held,
  so the decision cannot be made about one row and written to another.
- **`AIRTABLE_RETIRED` ends the dependency** (decision 2026-09-22, Destiny),
  off until the final import has run and been read. On: `get_health` reports
  Airtable as **retired** rather than probing it — not healthy and not
  unreachable, because both are claims about a live dependency and it is
  neither; `get_mirror_status` reports every kind's source as the engine;
  the resync and final-import buttons come off the pages and their routes answer
  **410 Gone** with the reason, a 410 rather than a 404 because the route was
  there, it did something, and it is finished. **The Codex page's on-load
  reconciliation stops too**, and that one matters most: its job is to *delete*
  rows Airtable no longer has, so left running after the cutover the first page
  load would quietly delete every Codex entry the engine had written since.
  Retired also forces the write-back off, because a flag saying "do not look at
  Airtable" and one saying "do write to Airtable" cannot both be honoured and
  only one of them can be honoured safely. **Nothing is deleted** — the client,
  the resyncs and the final import all stay exactly as they are, because the
  flag is reversible and a deletion is not.
- **Airtable is gone from the interface** (decision 2026-09-23, Destiny).
  Every "Open in Airtable" button and row action, the "Airtable record" field,
  the `airtable_url` CSV columns (the id column stays, headed `record_id`), the
  source links that drew "Airtable ↗", and every hint or definition that
  named it are removed or reworded to say the engine writes these rows. The
  Resync button draws only where its pass reads a live source — Engine
  health's "Resync from BHARAG" — and nothing on the other pages. The
  not-landed marker, banner and toasts stop drawing (`unlanded()` is false):
  with the write-back forced off, the only failures left were stale ones from
  before the cutover. **The data is untouched**: `airtable_record_id`, the
  `airtable` fields on API payloads and the importers all stay, as history.
  The registry keeps Airtable as a **retired** service (migration 27), its
  url shown unlinked, and its bases as the history section with no action.
  An incident whose own n8n node name says "(Airtable)" is engine data and
  is shown as written.
- **Changing a loop's builder is a move, not an edit.** There is no builder
  field: the builder *is* which of the seven tables the row sits in. Read the
  source row, create in the destination, confirm a record id came back, and
  only then delete the source — create before delete, so the worst case is a
  duplicate rather than a lost loop. A failed delete is not retried and is its
  own outcome, naming both tables. **The copy left behind can be removed from
  the interface** (decision 2026-09-14, Destiny): the duplicate banner and the
  loop panel offer it, and it retries that one delete against the source table
  and the record id the move wrote down. Never a re-created row, never the
  destination row — the loop lives there now, and re-running the move would
  make a third copy out of a second. A source record already gone is success;
  a retry that fails again stays a duplicate, with the new reason, and the
  action stays. `loop_id` travels unchanged;
  `Assignee Slack User ID` is never copied but set from the destination,
  because the digest routes by table. The new record id is stored against the
  loop and the events, note and write log are re-keyed onto it. **The move
  lands in Postgres only once Airtable has made it** — which table a row sits
  in is a fact about Airtable, not a field this dashboard owns, and claiming it
  early leaves nothing that knows where the row really is.
- **Every write to Airtable is logged** to `record_writes`, append-only and
  keyed by kind: what changed, the source and destination table on a loop move,
  the steps that completed, and the outcome. The newest line per record is what
  the page marks. One table and one marker for both kinds — a second would
  drift from the first.
- **A Codex log is at exactly one of three stages, one per step** (decision
  2026-09-14, Destiny): **Needs input** (the log has a row in the Layer 0
  parking table whose own `Status` is `pending_builder_input`, which wins
  whatever Jason Status says), **Awaiting approval** (not that, and `Jason
  Status` is Pending or empty), **Approved** (not that, and Jason Status is
  Approved **or Input Added**). They sum to the submission count.
  **`Layer0 Flagged` does not place a log** (decision 2026-09-14, Destiny).
  That box means *was flagged once, ever* — nothing clears it when the builder
  answers — so it held eight logs (Ahad 4, Hardik 2, Kavin 2) in the queue of
  work owed after every one had been answered, merged and approved. It is still
  read, still shown on the entry, and still what the completeness card counts,
  because it is a true fact about the log's history. The Layer 0 table's own
  `Status` is the only field that says a builder is being waited on **now**, and
  the join is on `Submission ID`. The comparison names `pending_builder_input`
  literally: `Layer0Hold.open` is everything that is not `completed`, which is a
  wider set, and reading one as the other is the same class of bug.
  **"Input Added" counts as approved** (decision 2026-09-14, Destiny): Jason
  adding input means he has read the log and responded, which is a form of
  having dealt with it, not a state of waiting for him. It sat at Awaiting
  approval until then, which put fourteen logs he had already answered in the
  queue of ones he had not reached. A log whose missing answers are supplied
  goes back to review, not through the check again.
- **The three rules are not printed on the page** (decision 2026-09-14,
  Destiny). The tab label carries the meaning; a paragraph under it restating
  the rule is furniture. They live here, in this section, where they are the
  spec rather than a caption.
- **The steps are named, never numbered, on screen** (decision 2026-09-14,
  Destiny): **completeness check**, **pending review**, **builder codex**.
  "Layer 0" told a reader nothing. The Airtable fields keep their own names —
  `Layer0 Flagged`, `Layer1 Review `, `Orchestrator Layer2 Review` — and the
  page still quotes those wherever it states a rule, so the rule stays
  checkable against the source.
- **Approved is the first tab and there is no All tab** (decision 2026-09-14,
  Destiny). Almost every log ends up approved, so that is where the page opens.
  A fourth tab that is the sum of the other three earns nothing; the sum is
  printed on the card above the list, where it belongs. The stage card reads
  the same order, so the page states one order rather than two.
- **The Layer 0 parking table (`tbljoWu73vsxyL6vc`) is a different table with a
  different schema** — no Jason Status, no Layer 2 review, no Codex Entry ID —
  holding submissions that never reached a builder table. Its rows are counted
  on their own and never inside the stage counts, and the page says so. They
  are **not** drawn as a bar in the completeness card: everything in that table
  is parked by definition, so the bar restated its own table's name. A row
  there whose answers have been merged is the engine's to delete — this
  dashboard never deletes an engine row it was not asked to touch.
- **Deleting a Codex submission removes it from Airtable and from here**, for
  production testing. Confirmed by typing the Codex entry id back, never a
  yes/no dialog: mid-test several near-identical rows are on screen and the id
  is the only thing that tells them apart. The whole row goes to
  `record_deletions` first — once both sides let go that log is the only place
  it can be read. There is no add; entries are created through Slack.
- **The Codex page reconciles against Airtable on load.** A row deleted by hand
  in Airtable notifies nothing, so one pass compares the record ids across the
  six builder tables and the Layer 0 table against the rows held and removes
  what is genuinely gone. **A table whose read fails is never treated as an
  emptied table**: nothing under it is touched, and the log says which table
  could not be read **and what Airtable said** — a failure that does not name
  its reason, and logs nothing, is a sentence nobody can act on. The pass is
  bounded: five seconds a read, eight seconds in total, tables not reached
  named as not reached rather than failed, and the result held for two minutes
  (twenty seconds when it failed) so reading the page is not a load test.
  **It says nothing on the page** (decision 2026-09-14, Destiny): a standing
  amber line about a background check, on a page whose rows were never in
  doubt, is a banner nobody can act on either. It goes to the server log.
- **There is no way to ask Airtable for record ids alone.** `fields[]=` with no
  field named is read as a request for a field called `""` and refuses the
  whole request — which is how every table on the Codex page came to answer
  `Unknown field name: ""` and read as a permissions problem. Ask for one small
  real field instead; `Submission ID` is the one spelling that exists in all
  seven tables. **The replay used for testing must refuse exactly what Airtable
  refuses**: it implemented the assumption instead, so every test passed
  against a stand-in that shared the bug.
- **A liveness probe names no field and reads one record** (decision
  2026-09-20, Destiny). `airtable.probeReachable` is `?maxRecords=1` and nothing
  else, and it is deliberately not `listRecordIds`: that function hardcodes
  `Submission ID`, which exists on the six builder tables and Layer 0 and
  nowhere else, so pointed at Build Patterns it asked for a column that table
  has not got and Airtable refused the whole request — `get_health` then
  reported Airtable as unreachable while the token was working perfectly, which
  is the worst direction for a health check to fail in. It also pages to the
  end, so it was walking 175 records to answer a yes/no question: 2,244ms to say
  something false, and still 2,661ms once it was pointed at a table that does
  carry the field. **Any field name a probe hardcodes is a field that can be
  absent from whichever table it is later pointed at**, which is why the fix is
  to name none rather than to pick a better one. `listRecordIds` keeps the field
  and the paging, both of which are right for its real callers: the Codex
  reconciliation reads the builder tables, where the field exists and a partial
  read would look like an emptied table.
- **The resync's outcome is a toast, not a table** (decision 2026-09-14,
  Destiny): how long it took and three totals — inserted, updated, deleted. The
  per-table breakdown stays in the server log, in full, where somebody goes when
  a total looks wrong. A table that could not be read is named in the toast and
  the run reads as a failure; it is never folded into a zero.
- **An empty stage keeps its table** (decision 2026-09-14, Destiny): the frame,
  the headers, the tabs and the search box stay and one centred sentence sits
  where the rows would be, so the page holds its shape. An empty stage and a
  search that matched nothing are different sentences.
- **Resync from Airtable is a button on four pages, and Airtable wins**
  (decisions 2026-09-14 and 2026-09-15, Destiny). The reconciliation only ever *removed* rows, so this dashboard's
  copy could only fall behind: a log approved in Airtable stayed "awaiting
  approval" here, and one created without the engine pushing it never arrived.
  The resync reads all seven tables whole and makes Postgres match — insert
  what Airtable has and we do not, update what changed there, delete what is
  gone. **Airtable is the source of truth for every field it owns and this
  dashboard does not win a disagreement.** The one case that is never silent is
  a row whose own change never reached Airtable: reverting it is correct, and
  it is counted and named in the result and the log, because a decision made
  here disappearing without mention is the thing this dashboard exists to stop.
  Rows go in through `mirror.upsert` with `source = 'airtable'` and their
  status change is dated `via = 'mirror'` — this database learned of it when it
  looked and has no idea when it happened. **Manual only**: not on load, not on
  a schedule. It reads every field of every row, and it deletes.
- **Build patterns, Commercial and Clients resync the same way** (decision
  2026-09-15, Destiny), through one shared pass (`store.resync`,
  `POST /api/{patterns|commercial|clients}/resync`) and one shared control
  (`src/components/ui/Resync.tsx`), which the Codex page uses too so the four
  cannot word the same outcome differently. Build patterns
  (`app5ni3E8r7Lvxk22 / tblaMXSMjmz30OvcU`) and Commercial
  (`appvLglfdCqOKqLpT / tblyXShZLOFT3jNMe`) are **one shared table each**, not
  one per builder, so each is a single sweep. Clients reads the watched-clients
  index, the shared **Client Requests** table, and then the table each index row
  names in `Table ID`; **a questions
  table no index row names is never read**, and a question row held against one
  is removed — but only once the index itself has been read, because without
  that guard the first refusal would empty the whole kind. Two things every
  resync now says: a row Airtable handed over that this database **refused** is
  counted rather than only logged, since reading five rows and storing none is
  not the same as five already matching; and a change made here that Airtable
  never had is named when it is reverted, found through the mirror row's own
  `source = 'ui'`, because only loops and Codex write to `record_writes`.
- **The token reads seven bases and writes two.** `AIRTABLE_TOKEN` needs read
  and write on Open Loops and BHA Submissions as before, and **read only** on
  Build Patterns, Commercial Opportunities, BHA Client Research Loop and — from
  2026-09-17 — **BHA North Star Ledger (`appRvx4u9V9BYp646`) and BHA Research
  Twin Ledger (`appv39nQzmfC9VVkG`)**, for the five resyncs. Those two replaced
  the legacy ask log and queue the token was scoped to until then, so **a token
  not re-scoped authenticates and then refuses both twins' resyncs** — the same
  failure the submissions base had on 14 Sep, and the reason to check the grant
  rather than assume it carried over. Those five get **no base variable of their
  own**: this server never writes to them, so it can never write to a guess, and
  their ids stay in `sources.ts` where the record links already read them. A
  token without read on one of them authenticates and then refuses, which the
  resync names by table rather than reading as an emptied one.
- **Both twins resync, and Research Twin sweeps two tables** (decisions
  2026-09-16 and 2026-09-17, Destiny), through the same shared pass and the same
  control as the other four. Research Twin's sweep reads its ask ledger **and**
  the research queue: a job is *updated in place* as it is worked — its status,
  attempts and finding all change — and the agent only mirrors on an ask write,
  so a queue kept current by ask mirrors alone would show every job at the state
  it was in when it was opened. Every one of the three tables carries a unique
  id of its own (`Ask ID`, `Job ID`), unlike the attempt log they replaced where
  `card_id` repeated; the sweep still compares Airtable record ids, which are
  unique everywhere.
- **Executions are stored one row per execution, never as counters** (decision
  2026-09-15, Destiny — the second of that day, replacing the first). n8n's own
  execution id is the primary key of `engine_execution_runs`, and every figure
  the Executions page prints is a `GROUP BY` over those rows: weekly, monthly
  and yearly all come from the same rows, so they cannot disagree. There is no
  watermark arithmetic and nothing accumulates.
  **The counters were the fault, so they were deleted rather than corrected.**
  The page that shipped with per-day counters was wrong three ways at once —
  every figure exactly sixty times what n8n held, failures at nought, seven
  workflows of thirty-one — and one paging bug caused all three: the client sent
  its page cursor as `lastId`, which the n8n public API ignores, so sixty
  identical pages of the newest 200 executions were read and *added* sixty
  times. A counter cannot notice it is being told the same execution twice; a
  primary key cannot fail to. Re-reading is an upsert, so a backfill is safe to
  run at any time, however often.
  `engine_execution_days` and `engine_executions`, the two counter tables this
  replaced, are left in place and unread, like the `records` read model.
  **Nothing here asserts what n8n retains.** The page used to say n8n keeps
  about three days and discards the rest; that was never verified, and it is not
  true as stated — the instance's history begins on 12 Sep 2026 because that is
  when it was migrated, and no execution has been observed ageing off. The rows
  are copied here so the record does not depend on another system's retention
  policy, whatever that policy turns out to be, and so a period can be grouped,
  drilled into and exported without asking n8n anything. What the page says is
  what this database holds, and from when.
  **Duration is stored per execution**, null where the run recorded no end,
  never nought, so an average is exact and always over the number of runs it
  says it is.
  A workflow's system comes from the **workflow registry, by join at read
  time**, so pointing a workflow at a system is a registry edit that re-files
  its whole history rather than only its future. `N8N_API_KEY` is read-only, is
  a different credential from `ASK_BAYS_API_KEY`, and now reads two endpoints:
  `GET /api/v1/executions` and `GET /api/v1/workflows`, the second for names
  only, so a workflow with no registry row still appears under its own name.
- **New executions arrive by poll, and the page says so.** n8n has no way to
  tell this dashboard that an execution finished, so the server reads what is
  above the highest id it holds every 45 seconds and the page re-reads on the
  same interval. It is never described as live. **No reporting node is ever
  added to a workflow for this**: a workflow somebody forgets to instrument
  becomes a silent gap, which is the failure this dashboard exists to remove.
  An execution read while it is still running is stored with that status — the
  row is its own to-do list — and re-read by id until it finishes, so it is
  counted once, with its real outcome, and never guessed at.
- **A period still running is never compared against a whole one.** Week on week
  and month on month would report a collapse every Monday morning if this week's
  partial total were set against the whole of last week, so the previous period
  is cut to the same elapsed point and the page says which days it used. And the
  comparison is refused outright where that **window** falls before the oldest
  execution held — not merely where the previous period does. It says instead
  that those days were not quiet, they were not recorded. A change from nought
  prints both figures rather than an infinity.
- **Every page states how old its rows are**, relative ("4 min ago"), in the
  same place, along with how many the engine has written since the migration
  backfill. A kind sitting entirely on backfilled rows says so in amber, because
  nothing is feeding it. A figure that can be a day old with nothing saying so
  is a correctness bug on an engine-health surface, not a polish issue.
- **`/api/engine/:kind` is authenticated by `DASHBOARD_INBOUND_KEY`** in
  `x-dashboard-key` (the same pattern as `ASK_BAYS_API_KEY`, inbound), checked
  before the router reads the body. `/api/inbound/:kind` is the older route and
  still writes the same rows, but `record` is required there now. Every write —
  accepted or refused, with the reason — lands in `engine_writes` and on the
  Engine writes tab.
- **n8n can read and part-update through the same surface** (decision
  2026-09-21, Destiny). BHA's shared Airtable workspace hit its monthly API cap
  on 20 Sep at about 23:00 UTC and every n8n workflow that touches Airtable is
  failing, so Airtable is being cut out of the engine: every Airtable node
  becomes an HTTPS call here, and these tables become the only record. n8n could
  already write a whole record. It could not read one back and it could not
  change part of one, which an Airtable node does constantly, so
  `GET /api/engine/:kind` and `PATCH /api/engine/:kind/:id` exist. Same key,
  same header, same log. **n8n never connects to Postgres**: `bha-engine-db`
  stays closed to everything outside its Render environment, exactly as
  render.yaml intends, and these two routes are the whole of what reaches it
  from outside.
- **The lookup is the only readable thing under `/api/engine`.** Every other
  method and path there is still refused, and the in-process loopback
  `get_page_data` reads through still refuses the whole prefix by name whatever
  the method. Filters — `id`, `airtable_record_id`, `natural_id`, `builder_id`,
  `table_id`, and `f.<Field Name>` for a key inside the blob — are all optional
  and all ANDed, with `limit` (100, at most 1,000) and `order`. **A filter
  naming a column that kind's table has not got is refused** and the answer
  names the ones it has: `patterns` has no `builder_id`, and quietly ignoring
  the filter would answer a different question confidently. Which columns a
  table has is **read from `information_schema`, not derived from the kind's
  spec** — `engine_client_requests` carries `table_id` although its spec says it
  is not per-lane, so the obvious derivation is already wrong on a live table.
  `count` is every row that matched rather than the page, because a caller that
  asked for twenty of six hundred needs to know there are six hundred. **Field
  names are bound parameters**, never concatenated: the only things interpolated
  are the table and column names, and both come from this code and from the
  database.
- **PATCH merges into `fields` and touches nothing else.** A key not sent is
  left exactly as it is and a key sent as `null` is removed — which is the whole
  reason it exists beside POST, a whole-record write that replaces the blob: an
  Airtable node setting one field would otherwise drop the other twenty-two,
  the same rule this section already states for an interface edit. The promoted
  columns are **re-derived from the merged blob** so they cannot drift from it,
  and `changed` is decided by Postgres with `IS DISTINCT FROM`, as on the
  upsert. `builder_id` and `table_id` are deliberately not re-derived: those are
  not fields, they are which of the seven tables the row sits in, and changing
  one is a move rather than an edit.
- **Six operators, not one** (decision 2026-09-22, Destiny), added for the Bays
  cutover — ~19 workflows and 100+ Airtable nodes, and an Airtable node does
  more than equality. `f.` equals, **`nf.` does not equal *and matches a row
  that has not got the field at all***, `c.` contains case-insensitively, `in.`
  equals any of a comma-separated list, `gte.` and `lte.` compare as strings.
  Every one of them works on a blob field and on a promoted column alike, so
  `c.natural_id=LOOP-17880` is a filter.
  **`nf.` is `IS DISTINCT FROM`, and that is the operator's whole point**: a
  missing field reads NULL and `NULL <> 'Closed'` is NULL rather than true, so a
  plain `<>` would silently drop every row that never had a Status — on a schema
  that grew over months, most of the old ones. **`c.` is `strpos` on the
  lower-cased pair, never `ILIKE '%…%'`**, so a value containing `%` or `_` is a
  character and not a wildcard. **`gte.`/`lte.` are string comparisons** and are
  documented as such: Airtable's dates are ISO strings and sort correctly as
  text, which is why they are refused on `id`, the one genuinely numeric thing
  here, rather than being quietly wrong on it. An `in.` that comes out empty is
  refused rather than matching nothing — an empty list is usually a value n8n
  failed to fill in, and a filter that silently matches nothing reads as a table
  that has gone empty.
  **The five column names are reserved**: a filter naming one addresses the
  column, never a blob key of the same name. Checked against the live tables
  before the rule was written — across all eighteen mirror tables the only blob
  key with one of those names is `builder_id` on the 61 digest rows, and that
  column is derived from precisely that key.
- **A row can be created without an Airtable id, in every kind Bays writes**
  (2026-09-22). `record_id` is optional wherever the kind has a natural id, and
  a repeat post matches on that id and updates rather than duplicating — proved
  one kind at a time for all sixteen. **For a kind whose table has no id column
  this dashboard can name** — Review Returns, Lane Backlog, Deep Think Log —
  n8n supplies `natural_id` **in the envelope**, and `keyOnNatural` makes it a
  real key, which is the only way such a kind can be idempotent. Never both: an
  explicit `natural_id` on a kind that derives its own is refused rather than
  quietly ignored, because the blob and the column would then be two statements
  about one key and the column is what every lookup matches on.
- **`PATCH /api/engine/:kind/by-natural/:natural_id`** (2026-09-22) takes the
  same merge, because n8n holds `loop_id` and `Submission ID` rather than this
  database's row id — making every workflow look the id up first and feed it
  back in is two calls for one change with a race in between. **More than one
  match is a 409 naming both ids, never a pick**: `natural_id` is deliberately
  not unique, so a duplicate is a real state and choosing one would write into
  whichever happened to sort first. None is a 404.
- **Four more kinds, engine-only** (decision 2026-09-22, Destiny), for tables
  the Bays workflows use that were never mirrored: **`channel_tracking`**
  (`apprzpppxE2yV0q84 / tblboJRTsFSkHW0ra`, keyed on `channel_id`) — read by
  `Bays — Message Capture` on **every Slack message**, and failing since the cap
  hit at about 23:00 UTC on 20 Sep, so no Slack message has been archived
  since; **`review_returns`** (`appEmdKshNVTl64Zf / tblStfkeUZH7n2vmt`), the
  send-back rounds on a submitted log; and **`lane_backlog`** and
  **`deep_think_log`** in the Bays Tools Router base (`appMNvZsFRb9isRRq`).
  Nothing resyncs any of them and after the cutover no second copy exists, which
  `get_mirror_status` says rather than naming a base nothing reads. **No table
  id is recorded for the last two**: this server never reads that base, so a
  table id would be a constant with no caller, and a constant with no caller is
  one nobody notices going stale.
- **Two more Airtable-backed kinds** (decision 2026-09-23, Destiny), and unlike
  the four above these are **not** engine-only: both hold real rows in Airtable,
  both are swept by a resync, and both are in the final import.
  **`builder_profiles`** (`app6wGosV52Ur4mIF / tblsgl1O3iskbrR8t`, keyed on
  `user_id` — the Slack id) is the one that unblocks onboarding, below.
  **`pattern_candidates`** (`app5ni3E8r7Lvxk22 / tblqTkT6hEWESdd1y`) is a
  pattern somebody flagged that an architect has not yet turned into one; it is
  in the Build Patterns base, so that page's one Resync from Airtable sweeps
  both tables, the way Research Twin's one button sweeps its ask ledger and its
  job queue. Its ids are minted by n8n as `CAND-<ms>-<4>` and are not a column
  this dashboard can name, so they arrive as `natural_id` in the envelope.
  **Builder Profiles has no resync button on any page**, deliberately: nothing
  in the interface reads it yet — the Builders registry tab is
  `registry_people`, a different list — and a control that filled a table no
  screen shows is one nobody could check the result of. `POST /api/builders/resync`
  exists for the MCP `resync` tool and the final import, and
  `get_mirror_status` names it, which is where somebody looking at that kind is.
- **Adding a builder is a row, not a deploy** (decision 2026-09-23, Destiny).
  Loops and Codex entries resolve their owner from the seven fixed tables in
  `sources.ts`, and `Bays — Onboarding` created a new builder's table through
  Airtable's Meta API — which stops working the moment Airtable is retired, and
  needed a code change and a deploy to be read here even while it worked. So
  `builder_id` on a loop or a Codex write is now **either** one of the seven
  **or any Slack user id with a row in Builder Profiles**, with no `table_id`.
  **The onboarding contract, in order**: POST the profile to
  `/api/engine/builder_profiles` with `user_id`, `name`, `pronouns`, `lane` and
  `role`; from the next request that builder's loops and Codex entries are
  accepted on their Slack id. An id with no profile is **refused**, and the
  refusal names Builder Profiles as the fix rather than listing seven names and
  stopping.
  Two things this must not disturb. **A Slack id belonging to one of the seven
  resolves to their name**, not to a new builder, so `builder_id` on those rows
  keeps the one spelling every page already groups by — the raw value is
  checked against the roster before it is lower-cased, because a Slack id is
  upper case. And **`table_id` stays null** for a profile builder, which is the
  honest answer: there is no Airtable table, and writing one would be inventing
  a location. The profile lookup is only reached when the name is not one of
  the seven and no `table_id` was sent, so a resync of nine hundred loops costs
  no extra round trip.
- **`GET /api/engine/loops` and `/codex` return `builder_id` and `table_id` on
  every row**, and that is pinned by a test (`npm run test:lookup`) rather than
  left as a comment. n8n's update-a-loop path reads them to find the owner — the
  builder *is* which table a row sits in — so a lookup that stopped sending them
  would not fail, it would answer, and every workflow downstream would quietly
  lose the owner. A kind whose table has neither column answers **null**, never
  absent, so a caller can tell "no table" from "this route stopped sending it".
  Live at the time of writing: 946 of 946 loops and 199 of 199 Codex rows carry
  both.
- **A lookup is logged as `read`, not as a write.** It is on `engine_writes`
  because it is the same surface with the same key, and it is its own outcome so
  that the writes can still be counted without it; the Engine writes tab counts
  lookups in a figure of their own for the same reason. The id in a PATCH path
  is the row's own bigint id, which is what the lookup returns — never the
  Airtable record id, because after the cut there will be rows that never have
  one.
- **The status-change history accumulates, and is now the whole ledger.** The
  events table (status changes with timestamps) is the only place a close is
  dated, and a record's previous status is its last event. An engine write
  records its own event as it lands; a reconcile at boot writes down anything
  that changed while the process was not running, stamped `via = 'mirror'` and
  left out of close-rate figures because it cannot be dated. `meta.history_since`
  is when this database began recording — not the last restart. Every metric
  derived from it still cites that date, and one the rows cannot support is
  still null with a note.
- **The pay ledger follows the session log at write time** (decision
  2026-09-23, Destiny). `server/src/paySync.ts`, called from `mirror.upsert`
  and `mirror.patchFields` after any stored change to a `codex` row, in the
  same transaction. It replaces n8n's `Bays — Pay Ledger Sync` (every 30
  minutes), whose `Build Ledger Rows` rules it ports exactly — a log is owed
  once it has a `Codex Entry ID`; builder from `Builder User ID`; Pay Mode and
  name from `pay_builders`, defaulting to Daily, then `Builder Name`, then
  `Unknown builder`; Session Date and Month from `Timestamp`, else `Processed
  At`, in UTC; Approved At from `Jason Reviewed At`, else `Processed At`; Paid
  is an explicit "Yes". Three things differ on purpose: **Pay Mode is frozen at
  first write**, **Paid At is when the log turned Yes** and is kept once set,
  and **a Slack Card Link and every other field already on the row are kept**.
  **The log is the source of truth for Paid**: `Bays — Pay Tracking` posts each
  new approval with `Paid: false`, and that post can land after the log was
  marked paid, so every pay_sessions write — POST or PATCH, from anyone — has
  Paid, Paid At and Paid By replaced with what the log says before it is saved.
  **Every copy of a session is written**: most sessions approved before the
  cutover are held twice (the Airtable import's copy and n8n's), the page shows
  n8n's, and updating one would leave the page reading the other. After any
  pay change a **Sent** statement whose sessions (counted by Codex Entry ID)
  are all paid closes itself to Payment Sent, exactly as the node `Close
  Settled Statements` did. The sync runs behind a savepoint: a pay row that
  cannot be written is logged to `engine_writes` and the log's own write still
  lands, because an approval must never be refused over its pay copy.
  `POST /api/engine/pay/reconcile` (`x-dashboard-key`) runs every approved log
  through the same sync and every Sent statement through the same check,
  answers `{checked, created, updated, unchanged, statements_closed, failed}`,
  and is safe to repeat — the second run reports everything unchanged. The
  same pass also runs **once at every boot**, in the background, and its counts
  land on `engine_writes` as endpoint `boot` — it catches a log written while
  the process was down, and it put the first production run on the record.
  `npm run test:pay` pins all of it.
- **Open pages refresh themselves** (decision 2026-09-23, Destiny). Every write
  path announces `{kind, id, at}` on an in-process bus (`server/src/events.ts`)
  **after its transaction commits** — `pg.afterCommit` — never before, because a
  page told early would re-read the old row and hear nothing more; a rollback
  announces nothing. `GET /api/events` streams them as Server-Sent Events behind
  the page cookie, with a comment every 25 seconds, `Cache-Control: no-cache`
  and `X-Accel-Buffering: no`. One process, so no broker. **It carries what
  changed, never the row**: the page re-reads its own route, so the stream cannot
  become a second read path. The client holds one EventSource for the app
  (`src/app/live.tsx`), reconnecting with backoff; `useData(fn, deps, { kinds })`
  re-reads quietly — no loading state — 750ms after the last matching change,
  on any change when no kinds are given, and whenever the tab becomes visible
  or the window takes focus. Down for over a minute, it polls every 30 seconds
  until the stream returns. The store's memoised figures are invalidated by the
  same bus, so an engine write cannot leave a cached figure behind.
- **Notes are this dashboard's own.** A note typed on a loop was never an
  Airtable field; it lives in `record_notes`, keyed by record id, and moves with
  the row if Airtable later gives it an id.

**Counts are computed by the server from raw rows** (decision 2026-09-08).
The loop tables carry no close date and no last-modified time; nothing
upstream keeps a status-change history. A metric the data cannot support is
null with a note, and the note is shown. A zero and an unknown must never look
the same.

**Ask Bays** goes `browser → POST /api/ask → server → dashboard-ask-bays
workflow` with the key in `x-api-key` from the server's environment. The
thread's `session_id` is stable for its life and is Bays's memory. The reply's
`steps` are shown under the answer; empty means nothing is shown.

**The incident ledger is the second external read path** (decision 2026-09-17,
Destiny). Until it, Airtable was the only system this server called out to.
BHARAG's `GET /api/v1/incidents` is read only, adds no dependency past Node
itself, and needs **one credential per lane** — the three error handlers each
hold their own and a key for one lane is refused for another, so it is three
calls with three keys and cannot be collapsed. `server/src/bharag.ts` is the
only code that holds them. Nothing here writes to the ledger: the handlers
create incidents and the healer closes them.

**An MCP server is mounted on this same service** (decision 2026-09-18,
Destiny), at `/mcp/:secret` over streamable HTTP, so an external Claude client
can read this app. It is there because the page is client-rendered: fetching the
dashboard's URL returns an empty shell, so a client asked "on this page I can't
do X" could not see the app at all. It reads the app's **structure** — routes,
pages, panels, which data feeds which panel — and its **live data**, and
structure is the larger half because it is what makes a page nobody can see
reasonable about.

- **Not a second service and not a second dependency.** It hangs off the same
  `createServer` handler as `/api`, ahead of it, so it deploys with the same
  commit and runs in the same process against the same Postgres. The MCP SDK is
  not added: rule 5 of section 2 says `pg` is the ceiling and not a precedent,
  and streamable HTTP is JSON-RPC 2.0 over a POST. The transport answers with a
  single JSON object, or one SSE frame where the client's `Accept` asks for a
  stream, because clients differ about which they send.
- **Every tool reads, and the one that acts only re-runs a button the page
  already has.** There is no destructive tool, and no code route from a tool to
  a write that was not already a page's own. `get_page_data` reads through an
  in-process GET against this server's own `/api` router — the same function
  that answers the browser, which is what stops the tool drifting from the
  page — and that loopback is GET-only and refuses `/api/engine/*` and
  `/api/inbound/*` by name.
- **`MCP_SECRET` is a path segment, and a miss is a 404.** Anything that is not
  exactly `/mcp/<MCP_SECRET>` — a wrong secret, a deeper path, every request
  when the variable is unset — gets the 404 an unknown route gets, on every
  method, checked before anything else is read. **Never a 401, anywhere under
  `/mcp`** (2026-09-18): a 401 tells a stranger the endpoint is there, and it is
  also what starts an OAuth flow, so a client that gets one goes off to discover
  an authorization server this service does not have. No default, on the rule
  the base ids follow.
- **`GET` opens an event stream and holds it, and refusing it was the bug**
  (decision 2026-09-18, Destiny). This server pushes nothing, so answering
  `GET` with 405 was spec-legal — and it made the endpoint undiscoverable.
  Claude's connector check opens with a `GET`, read the 405 as "could not
  connect", could not then work out how the server signs in, and fell back to
  OAuth dynamic client registration, which fails here because there is no
  OAuth. So `GET` answers 200 `text/event-stream`, writes a comment
  immediately, and sends another every 20 seconds — Render's router closes an
  idle connection, and a first byte is what tells a client an open stream from a
  hang. It carries no messages, which is the truth; it opens, which is what the
  client needs. **`OPTIONS` answers the CORS preflight with 204** and
  `Access-Control-Expose-Headers: Mcp-Session-Id`, without which a browser
  client cannot read the session id this server issued to it, and **`DELETE`
  answers 204**. All three are behind the same secret check, so none of them
  tells an unauthenticated caller the endpoint is there.
- **A session id is issued on initialize and accepted forever after.** It comes
  back in `Mcp-Session-Id` and the client sends it on every later request.
  Nothing per-session is kept — every tool reads the same source tree and the
  same database — so **an id this process does not recognise is accepted rather
  than refused**: Render restarts on every deploy and after every spin-down, so
  a client's id routinely outlives the process that issued it, and the spec's
  404 for an expired session would be indistinguishable here from the 404 a
  wrong secret gets.
- **Nothing it says about structure is written by hand.** Routes come out of
  `src/App.tsx`, sidebar labels out of `Layout.tsx`, a page's title and purpose
  out of its own `PageHeader` falling back to that page's section in this file,
  its panels out of a scan of the page's own JSX, its data routes out of
  `src/data/index.ts`, and the sources out of `sources.ts` and `mirror.ts` as
  the process holds them. A hand-written map of the interface would be right on
  the day it was written and wrong by the next commit, and a reader acting on it
  could not tell.
- **A tool that cannot answer says why, and nothing is cut silently.** An
  explicit error names what was looked for and where — `get_component` on a name
  declared in two files fails and names both rather than picking one, because
  `LaneView` is two different panels and a wrong answer about structure gets
  acted on. Every capped answer says what the cap was and how to ask for the
  rest, and a payload past the size cap comes back as its **shape** rather than
  as a sample: a fragment read as the whole is the failure worth designing out.
- Every call is logged with its name and arguments. **Thirteen tools**
  (twelve read, one act), and **every one of them carries MCP annotations**
  (decision 2026-09-20, Destiny), because the spec's default for a tool that
  declares none is *potentially destructive* — twelve read-only tools that
  said nothing about themselves were being offered to every client as though
  any of them might delete something.

  Structure and source: `list_pages`, `get_page_structure` (the one that
  matters — it is what lets somebody reason about a page they cannot see),
  `get_component`, `search_source`, `list_data_sources`.
  Live data: `get_page_data` (with a `fields` list of dot paths, so two numbers
  cost two numbers rather than a whole payload), `query_postgres`,
  `describe_schema`, `get_health`.
  Whether the copy is current: `get_mirror_status`, `diff_source_vs_mirror`,
  `search_logs`. And `resync`, the one tool that acts.

- **The second half was built because two real faults were slow to find**
  (decision 2026-09-20, Destiny). Both were diagnosed through this server and
  both took longer than they should have. Pay Tracker showed nothing because an
  n8n workflow had written no rows into Airtable — four calls here and two
  elsewhere, because nothing could compare a source against its mirror. Then,
  after the upstream fix, the page *still* showed nothing, because the mirror
  only fills when somebody presses Resync; the server reported that correctly
  and uselessly, having no way to press it. So: `get_mirror_status` answers
  "which kinds are empty, and is that stopped or merely unread" for all
  eighteen kinds in one call, `diff_source_vs_mirror` settles one kind against
  Airtable and names the record ids on each side, and `resync` runs the page's
  own code path rather than a second copy of it — **one run per pass per 60
  seconds**, and a second call inside that window is told "ran N seconds ago"
  rather than queued, because a queue turns an impatient client into a load
  test on somebody else's API.
- **`query_postgres` is read-only in three independent ways**, because one
  would be a single point of failure on a tool a model drives: the statement is
  parsed and refused unless it is exactly one `SELECT` or `WITH` with no
  writable CTE and no second statement; it runs inside
  `BEGIN TRANSACTION READ ONLY`; and the transaction is rolled back
  unconditionally, success or failure. A 5-second `statement_timeout` is set on
  the transaction, and the row cap (100 by default, 1,000 at most) is applied as
  a `LIMIT` in the wrapping query and **stated in the answer as a floor, not a
  total** — a capped read says how many it fetched and that there are more,
  never a count it did not actually make.
- **Output is budgeted, and that is a correctness rule rather than a courtesy.**
  A tool answer lands in a context window, and every token spent on rows nobody
  asked for displaces reasoning about the fault. So every tool defaults to
  summaries and counts and makes the caller ask for rows: `get_mirror_status`
  answers in counts and verdicts, `diff_source_vs_mirror` names at most ten
  record ids per side and says the difference in full, and `search_logs`
  distinguishes "nothing matched" from "this process has only been up four
  minutes" rather than letting an empty result read as silence upstream.

**The write gate: preview, then token, then act once** (decision 2026-09-20,
Destiny). `server/src/mcp/gate.ts`. It is **scaffolding, shipped ahead of the
first tool that needs it** — nothing destructive goes through it today, and
`resync` deliberately does not use it, because re-reading rows from a source
this dashboard already reads is not a change anybody needs to approve. It is
here so that the first real mutation does not have to invent the shape, and so
that the shape is tested before anything depends on it
(`npm run test:gate`, eight assertions).

It is **enforced on the server**, not in a client's confirmation dialog and not
in the model's judgement: both of those change with which client is connected
and what a model decides in the moment. A mutating tool called without a token
performs no change, and the only thing that can mint a token is a preview this
process computed.

- **The token is bound to a digest of the whole operation** — the tool, the
  target, the changes, and the record as it is *now*, hashed whole. Not just
  the fields the change names: a token minted against a row somebody has since
  edited stops matching, which is how "it changed underneath you" is detected
  rather than assumed.
- **Sixty seconds, one use.** Long enough to read a preview, short enough that a
  stale one cannot act. The caller may ask for a shorter window; the knob is
  clamped so it can only ever shorten, never extend.
- **Four refusals, each with its own name**, because they want four different
  next moves: `token_expired` (wait and re-preview), `token_used` (stop and read
  what already happened — it is refused rather than repeated, so a retry cannot
  double-apply), `record_changed` (re-read the record; the change was computed
  against values that are no longer there) and `token_unknown` (including a
  token spent by the wrong tool, and every token outstanding when the process
  restarted). A single "invalid token" would collapse all four into a shrug.
- **A create requires an idempotency key**; an update does not, because setting
  a status twice leaves it set. The claim is a partial unique index on
  `(tool, idempotency_key)`, so two identical creates racing cannot both
  insert — the loser reads the winner's row and replays its result.
- **`engine_mcp_writes` records every outcome, refusals included.** Tool,
  arguments, digest, token, idempotency key, target, before, after, outcome,
  detail, actor. A preview is deliberately *not* logged: a preview is not a
  write, and a log that records intentions beside actions stops being a record
  of what happened. The audit write **throws rather than swallowing** — if the
  change cannot be recorded it does not happen, the opposite of the Early Access
  notification hop and deliberately so: a lead nobody announced is still a lead,
  but a mutation nobody recorded undercuts the premise that these tables are the
  record.

The two calls, worked through, so the next tool added through the gate does not
reinvent the shape. Call one names no token:

```
tools/call  set_lead_status  { "id": "c6e2fae0-…", "status": "contacted" }

{ "status": "preview",
  "tool": "set_lead_status",
  "target": "engine_vfarm_leads c6e2fae0-…",
  "changes": [ { "field": "status", "current": "new", "proposed": "contacted" } ],
  "token": "4f1c…", "digest": "9ab3…",
  "expires_at": "2026-09-20T14:02:31.000Z", "expires_in_seconds": 60,
  "note": "Nothing has changed. Call set_lead_status again with token=\"4f1c…\"
           to make exactly this change. The token is good for 60 seconds, works
           once, and stops working if the record changes in the meantime — re-run
           without a token to get a fresh preview." }
```

Call two carries it, and the server re-reads the record before spending it:

```
tools/call  set_lead_status  { "id": "c6e2fae0-…", "status": "contacted", "token": "4f1c…" }

{ "status": "applied", "target": "engine_vfarm_leads c6e2fae0-…",
  "changes": [ { "field": "status", "current": "new", "proposed": "contacted" } ],
  "audit_id": 41 }
```

The re-read is the point: `redeem` is handed an operation built from a **fresh**
read, never from the preview. Passing the preview's own operation back in would
compare a value with itself and prove nothing.

**The repair record is the one write to n8n** (decision 2026-09-20, Destiny).
`engine_repairs`, migration 20, one row per repair attempt the bridge reported —
`repair_id` unique, because the bridge posts once and n8n retries a failed HTTP
node, so the same result twice must update one row rather than add a second. It
is not a mirror table: the rows are born of this engine's own repair loop rather
than copied out of Airtable, so the columns are real columns, and the whole
payload is stored beside them — the columns are the read model, the blob is the
record, and a field the bridge adds before this dashboard reads it is kept
rather than dropped.

`POST /api/engine/repair` carries the same `DASHBOARD_INBOUND_KEY` as every
other engine write and lands on the same `engine_writes` log, so a repair
refused for an unknown outcome is visible on the Engine writes tab beside
everything else. `GET /api/repairs` is behind the cookie like every other page
route, and `POST /api/repairs/:id/revert` is the only thing in this application
that changes a workflow — see the Repairs tab in section 7 for the four guards,
why a restore needs the workflow rather than a version id, and why `active` is
never sent. **No new environment variable**: the revert uses the `N8N_API_KEY`
the Executions page already reads with, which is now read-and-one-write rather
than read-only, and that is the only change to what this server needs.

**vFarm Early Access leads arrive from n8n, all of them through Form A**
(decision 2026-09-23, Destiny). Every Early Access lead now arrives through
Hardik's Google Form A, either directly or from the bhanetwork.org/vfarm form,
which submits into Form A. Hardik's n8n tracker posts each one to
**`POST /api/engine/vfarm-leads`**, one lead per call, and sends the Slack alert
itself. Handled by `storeFormA` in `server/src/earlyAccess.ts`.

- **Auth:** `x-dashboard-key: <DASHBOARD_INBOUND_KEY>`, the same header and key
  as every other `/api/engine` write. A missing or wrong key gets a 401 and is
  logged to `engine_writes` like the others.
- **Stored in `engine_vfarm_leads`:** `name`, `email` (lower-cased) and
  `organisation` go in the existing `full_name`, `email` and
  `organization_name` columns. Each one falls back to the matching answer
  (`Full name`, `Email address`, `Organization / household name`) if the top
  level leaves it out. Everything else goes in the `form_a` jsonb column,
  stored as sent: `answers`, `early_access_lead_id`, `buyer_intake_id`,
  `correlation_id`, `source_campaign` and `submitted_at`. `source_campaign`
  is also copied into its own column. `submitted_at` is copied into its
  timestamp column only if it is ISO 8601; Google Forms' `9/23/2026 14:05:09`
  stays in the blob as sent. `source_surface` is `form_a`.
- **Upsert key:** `buyer_intake_id`, matched through a unique index on
  `form_a->>'buyer_intake_id'`. The same submission posted twice updates one
  row. An update replaces the columns and the whole blob, and never touches
  `status` or `notes`, which belong to the dashboard.
- **Answers** are keyed by Form A's question text, character for character.
  Two questions end in a space, and a key without that space is a different
  key. The 23 questions live in `src/data/formA.ts`. A key that is not one of
  them is still stored, shown on the page under its own heading, and named in
  the reply as `unexpected_questions`. Any of the 23 not sent is named as
  `missing_questions`.
- **No Slack.** This route posts nothing to Slack; the tracker sends its own
  alert. `notified_at` stays null on these rows, and the page does not mark a
  Form A lead "not announced".
- **Replies:**
  - `201` for a new row, `200` for an update:
    `{ ok, stored: "inserted"|"updated", id, buyer_intake_id, inserted, answers, unexpected_questions, missing_questions, ignored_fields }`.
  - `422` for no `buyer_intake_id`, a missing name or email, or `answers` that is not an object.
  - `405` for any method but POST.

```
POST /api/engine/vfarm-leads
x-dashboard-key: <DASHBOARD_INBOUND_KEY>
content-type: application/json

{
  "name": "Ama Mensah",
  "email": "ama.mensah@example.org",
  "organisation": "Mensah Family Farm",
  "early_access_lead_id": "VFLEAD-1790150000000-K3F9QZ",
  "buyer_intake_id": "VFBUYER-FORMA-1A2B3C",
  "correlation_id": "VFARM-FORMA-1A2B3C",
  "source_campaign": "vfarm_flagship_1031",
  "submitted_at": "9/23/2026 14:05:09",
  "answers": {
    "Full name": "Ama Mensah",
    "Email address": "ama.mensah@example.org",
    "Organization / household name": "Mensah Family Farm",
    "Which best describes you or your organization?": "Household / individual",
    "City": "Kumasi",
    "State / Province / Region": "Ashanti",
    "Country": "Ghana",
    "What is your primary use case for vFarm?": "Home food production",
    "What would you like vFarm to help you accomplish?": "Grow leafy greens year round",
    "Approximately how much space could you make available?": "A spare room, about 10 m²",
    "Do you have an indoor or protected space available?": "Yes",
    "Is electrical power available near the potential installation area?": "Yes",
    "Is a water source available near the potential installation area?": "Yes",
    "What type of environment would the first vFarm most likely operate in? ": "Home",
    "Are there any site constraints we should know about?": "Power cuts a few times a month",
    "How would you most want to monitor or interact with your vFarm?": "Phone app",
    "How serious is your interest in becoming an early vFarm buyer or pilot partner? ": "Very serious",
    "When could you realistically consider a vFarm pilot or purchase?": "Within 3 months",
    "Which best describes your current budget readiness?": "Budget set aside",
    "Would you consider a small Early Access reservation commitment in exchange for priority consideration as pilot units become available?": "Yes",
    "Would you be willing to provide structured feedback during an Early Access pilot?": "Yes",
    "Anything else you'd like us to know?": "Happy to host a demo.",
    "How did you hear about vFarm?": "LinkedIn"
  }
}
```

The Early Access tab on `/vfarm` opens a lead on click and shows every stored
answer. The answers are grouped by subject in Form A's own order. **Those
headings are the dashboard's, not the form's section titles**: nothing the
dashboard can read (the n8n workflows, the response sheet) names the form's
sections. To use the real titles, change `FORM_A_GROUPS` in
`src/data/formA.ts`.

**The public route below is superseded and unused by the site** (2026-09-23,
Destiny). It is kept, not deleted, but nothing current posts to it: it is
origin-checked for browsers, so n8n cannot call it, and it stores only name,
email and organisation. The rules under it still describe that route.

**The vFarm Early Access funnel was the one public write route** (decision
2026-09-20, Destiny). The form on bhanetwork.org posts to
`POST /api/public/vfarm-early-access`, the row lands in `engine_vfarm_leads`,
an n8n webhook announces it in `#vfarm-early-access`, and the Early Access tab
on `/vfarm` is where somebody reads and annotates it. All of it is in
`server/src/earlyAccess.ts`.

- **Public by necessity, and the only one.** The static site has no session, so
  the route sits among the open routes above the cookie guard. Nothing else was
  opened up, and a route a stranger can POST to is worth naming rather than
  burying — which is why the whole of it is one file.
- **It answers with nothing.** `{ ok: true }` and a status code: never the
  stored row, never a count, never whether the address was already on file. A
  public endpoint that confirms "you are already on the list" is an address
  oracle. The repeat is recorded and flagged on the dashboard instead.
- **It records an expression of interest and nothing else.** No subscriber,
  payment, entitlement, reservation or delivery state is set, read or implied —
  not in the handler, not in the table, not in the response, and none of those
  columns belongs in that table. `status` (`new`, `contacted`, `qualified`,
  `archived`) is this dashboard's own note about whether anybody has replied.
- **It never stores an address.** `ip_hash` is a salted SHA-256 under
  `IP_HASH_SALT`, for the rate limiter. It has no way onto the page and the read
  route leaves it out. Unset, a random per-process salt is used rather than an
  unsalted digest — SHA-256 of an IPv4 address is reversible by anyone with an
  afternoon — and the boot line says so.
- **Origin, method, rate, shape, write, in that order.** A refused origin never
  reaches the body; a flood is turned away before it costs a database round
  trip. Five in ten minutes and twenty a day per hashed address, in-process,
  because a shared counter in Postgres would mean a write on every refused
  request, which is what a flood is trying to make us do.
- **CORS is not an authorization boundary and the code says so.** An `Origin`
  that is present and not on `EARLY_ACCESS_ALLOWED_ORIGINS` is refused 403, and
  so is its preflight — but a request with no `Origin` is allowed, because
  `Origin` is unauthenticated and refusing its absence only inconveniences
  honest callers. The validation and the rate limit are what protect this route.
- **Unknown body fields are ignored, never rejected.** The site and this server
  deploy separately, so a field added there before it is read here must not
  start failing every submission.
- **The notification is started and never awaited**, five-second timeout, and a
  failure is logged and never fatal. `notified_at` stays null, which is the
  useful part: the row says "not announced", which is what somebody wants when
  they are wondering why they missed one. No Slack token is in this repo and
  nothing here calls Slack directly — the webhook holds that credential, the
  same way `ENGINE_HEAL_URL` does.
- **`email` is not unique.** A person may express interest twice and the second
  time is a fact worth seeing. A unique constraint would either reject the
  submission, telling a stranger their address is on file, or drop it silently.
  Repeats are stored and flagged at read time.
- **Only `status` and `notes` are editable.** The rest of the row is what a
  person told the site about themselves, and a record somebody can quietly
  rewrite is not a record.

**Environment (all server-side, none in the bundle):** `AUTH_EMAIL`,
`AUTH_PASSWORD_HASH`, `SESSION_SECRET`, `ASK_BAYS_API_KEY`, `ASK_BAYS_URL`,
`DASHBOARD_INBOUND_KEY` (nothing reaches the record tables without it),
`AIRTABLE_TOKEN`, `AIRTABLE_OPEN_LOOPS_BASE_ID` (Open Loops) and
`AIRTABLE_SUBMISSIONS_BASE_ID` (BHA Submissions) — one token: read and write on
those two bases for loop and Codex edits, and read only on Build Patterns,
Commercial Opportunities, BHA Client Research Loop, **BHA North Star Ledger and
BHA Research Twin Ledger** for the five resyncs, which have no base variable
because nothing is ever written to them. Without the
token nothing edited here reaches Airtable and no page can resync, and the
server says so at boot and on every write — and `DATABASE_URL`, the one the
server refuses to start without.
`AIRTABLE_RETIRED` — whether this dashboard has stopped depending on Airtable
at all. **Off unless set** (`1`, `true`, `on`, `yes`), from 2026-09-22, and
turned on only after the final import has run and its report has been read. It
forces `AIRTABLE_WRITEBACK` off whatever that is set to.
`AIRTABLE_WRITEBACK` — whether a loop or Codex edit is **also** sent to
Airtable. **Off unless set** (`1`, `true`, `on`, `yes`), from 2026-09-21. It is
declared in the blueprint with an empty value rather than left out, so turning
it back on for the final import is an edit to a line that exists rather than a
variable somebody has to know the name of, and the boot line states which of the
two states the server is in either way.
`N8N_API_KEY` — the n8n **instance** API key. Three endpoints read
(`GET /api/v1/executions`, `GET /api/v1/workflows` for names only, and
`GET /api/v1/workflows/{id}` whole) and, from 2026-09-20, **one written**:
`PUT /api/v1/workflows/{id}`, reached only from the repair revert. It was
read-only until then and that is the only write it will do — **the key now needs
workflow write scope**, or every revert is refused with n8n's own reason and the
row stays exactly as it was. Not the same credential as `ASK_BAYS_API_KEY`,
which is a webhook header. Without it no execution is ever read, the Executions
page says so rather than reading zero, and the Repairs tab says no repair can be
put back from here.
`BHARAG_BAYS_KEY`, `BHARAG_NORTH_STAR_KEY` and `BHARAG_RESEARCH_TWIN_KEY` — the
incident ledger, one per lane, read only, no defaults. A lane with no key is
never read and Engine health says so rather than showing it healthy; the boot
line names every lane that is not keyed. `AIRTABLE_TOKEN` also needs read on
`appINvgEoZjuYQI2O` (engine_events) for that page's two Airtable tables.
`ENGINE_HEAL_URL` is the self-healing webhook behind Retry now, optional, with
the live webhook as its default. `AIRTABLE_TOKEN` also needs read on
`appwnt0mEtfwDtcN5` (BHA Pay Ledger) for Pay Tracker — read only, and no base
variable, because nothing here ever writes to it.
`EARLY_ACCESS_NOTIFY_URL` — the n8n webhook that posts a lead from the
superseded public route into `#vfarm-early-access`; Form A leads are announced
by Hardik's tracker and never touch it. Unset, the hop is skipped, the boot line says
so once, and the endpoint still works. `IP_HASH_SALT` — the salt for the stored
`ip_hash`; unset, a random per-process one is used and the boot line says the
stored hashes will not compare across a restart.
`EARLY_ACCESS_ALLOWED_ORIGINS` is optional, comma-separated, and defaults to
bhanetwork.org, www.bhanetwork.org and localhost:5173 — it has no blueprint
entry, because a literal repeating a default is a second place for it to drift.
`MCP_SECRET` — the path secret for the MCP server at `/mcp/<MCP_SECRET>`, read
only. **No default**, and unset the endpoint answers 404 to everything and the
boot line names the variable; it is `sync: false` in the blueprint rather than a
generated value because the same string goes into the Claude connector URL.
**The 2026-09-20 upgrade added no variable of its own**: `query_postgres` and
`describe_schema` read the pool `DATABASE_URL` already opens, `resync` calls the
same routes the buttons call with the credentials they already use, and the write
gate keeps its tokens in memory. Nothing to set before it merges, which is worth
saying rather than leaving to be discovered.
`DATABASE_CA_CERT`, `DATABASE_POOL_MAX`, `N8N_API_URL`, `BHARAG_API_URL` and
`AIRTABLE_API_URL` are optional.
`DATA_DIR` is gone, and so are `AIRTABLE_RESYNC_MINUTES`, the
`N8N_WRITEBACK_*` pair and `AIRTABLE_BASE_ID` (renamed 2026-09-14; **a base
variable is named for its base**, so the next one cannot be mistaken for it).
**The token variable is `AIRTABLE_TOKEN`** — the client deleted on 13 Sep read
`AIRTABLE_API_KEY`, and that name is not in use. The loops base has **no
default**: unset, the boot line names the variable and every loop edit is
refused and marked, rather than real loops being written to a guessed base.

**Auth:** one shared login for the whole team, same as BHARAG's console. Not
per-user accounts. The password is posted to `/api/auth/login`; the server
checks it against `AUTH_PASSWORD_HASH` and sets a twelve-hour cookie. Five
failures from one address lock it for thirty seconds. No user management, no
roles, no signup.

## 5. Design

**Feel:** a modern consumer dashboard in the manner of Apple's account pages.
Calm, spacious, precise. Cool neutral surfaces, white cards, one blue accent.
Someone leaves this open on a second screen all day and it does not shout at
them. The reference is the "My Apple" mockup Destiny supplied on 2026-09-08.

- **Two themes.** Light and dark, switchable from the user menu in the sidebar,
  following the OS by default. Every colour is a token in `src/index.css`;
  components never name a hex value.
- **The interface opens at 80%** (decision 2026-09-16, Destiny). It reads better
  there — more of a table on screen, the sidebar whole, cards in three columns —
  so it does that without anybody setting it. Applied as `zoom` on `<html>`, not
  `transform: scale`, so the page genuinely has more CSS pixels and every
  breakpoint, sticky header and table behaves as it would on a larger screen; a
  transform would shrink a picture of the smaller layout. Settings carries
  75 / 80 / 90 / 100 and says the thing that surprises people: **it multiplies
  with the browser's own zoom**, so a browser already at 80% lands at 64%. A
  browser without `zoom` (Firefox before 126) renders at 100%, which is the size
  this dashboard has always been.
- **Palette:** cool light grey page (`#f5f5f7`) with white cards in light mode,
  near-black page with charcoal cards in dark. **One accent: system blue**, for
  links, the active tab, primary buttons, progress and focus. No gold, no
  terracotta, no orange as accent (decision 2026-09-08, Destiny).
- **Colour carries meaning.** Green dot = healthy. Amber = degraded. Red =
  failing. Amber and red appear only on a genuinely bad state, never on a
  label, a default, or a decoration. Coloured rounded-square **icon tiles**
  (blue, indigo, teal, green, purple, pink, graphite) are allowed on
  navigation-like affordances — quick actions, system tiles, list rows — and
  never on data values.
- **Cards on paper.** 18px radii, a soft shadow, no hairline border. The
  Overview opens with a greeting and a gradient summary banner whose numbers
  are read from the data; the banner's floating chips may drift gently. That,
  the idle mark on Ask Bays and a short fade-in are the only animations.
- **Density inside a card.** Real tables, tight rows, thirty visible. Charts
  are small inline SVG, never a library.
- **Type:** Inter, falling back to the system sans. Semibold for titles and
  headline numbers, medium for labels, regular for everything else. No serif.
- **Sentence case everywhere.** Never Title Case, never ALL CAPS.
- **Every row does something.** Hover reveals its actions inline. Never bury
  actions in a menu.
- **Newest first, everywhere.** Every list, every table, on every page.
- **Cards in a row are the same height, and their content fills them.** A
  hundred-pixel card holding ten pixels of text is a bug; fix the ratio, not
  the card.
- **The page body never scrolls sideways.** A filter bar too wide for the
  column wraps, or scrolls inside its own container.
- **Long lists are paged.** Twenty rows, next and previous. Never six hundred
  rows in one scroll.
- **"Coming soon" is not an empty state.** Where the data is real, show it.
  Where the capability does not exist yet, say so plainly rather than drawing
  an empty chart that implies it works.

---

## 6. Navigation

Fixed left sidebar, grouped, with the shared account (Admin) at the bottom
opening Settings and Sign out. Main content fills the rest. Top right: date,
time, weather when the browser shares a location, and the theme toggle. No
status strip. Ask Bays hides the top row and gives its history panel the full
height.

```
Home (the Overview)
Ask Bays

SYSTEMS
  North Star
  Research Twin
  Media Twin             ← placeholder
  Genie                  ← placeholder
  Customer Service Twin  ← placeholder (2026-09-22)
  vFarm                  ← Overview is a placeholder; Early Access is real
  Engine health

RECORDS
  Open loops
  Codex entries
  Build patterns
  Commercial
  Clients
  Executions             ← every run of every workflow, tabbed by system
  Pay Tracker            ← who is owed, for what work, and what has been paid

REFERENCE
  System registry
```

**The sidebar shows every item at once and never scrolls** (decision
2026-09-16, Destiny). A dashboard whose navigation is half below the fold is one
where people miss pages. The rows are 32px and the group spacing is sized so all
sixteen fit the shortest laptop; `overflow-y-auto` is kept only as the failure
mode if the list ever outgrows that, because navigation that clips an item
silently is worse than navigation that scrolls.

**There is no People section** (decision 2026-09-14, Destiny). Builders was its
only item and almost everything on that page was a fixture; the roster and the
two figures that were real are the **Builders** registry now. The Overview's
Builders tile went with it, per the tile-per-section rule.

Sub-tabs live inside the page, not as sidebar dropdowns. **North Star has two —
Asks · Statistics — and Research Twin three — Asks · Jobs · Statistics**
(2026-09-17, Destiny). The Summary · Records · Runs · Gaps shape they and vFarm
carried was a phase 1 fixture layout; the twins have real rows now and the tabs
are what those rows are.

---

## 7. What goes on each screen

### Overview
One tile per sidebar section, each showing its headline number and its worst
current signal. Clicking a tile navigates into that section.

Pinned across the top: days to Halloween (the vFarm deadline), open loops,
entries logged this week.

**Nothing on this page counts a rack** (decision 2026-09-14, Destiny). The
vFarm-status pin and everything behind it read phase 1 fixtures and the page
behind them is a placeholder; a headline figure for a page that says "coming
soon" is a figure about nothing. The vFarm tile stays as navigation, with a dash
where the number was. The two 24-hour columns are still the phase 1 fixtures
they have always been.

**The Engine health tile counts incidents again** (2026-09-17), because that
page is real now. It carries the figure its page leads with — open incidents —
and its signal is that page's own failure metric: an exhausted retry, or a lane
that could not be read. **Where no lane answered the headline is a dash**, not a
nought: nought open incidents and nobody asked look identical, and only one of
them is good news.

Below: two columns — **what broke in the last 24 hours**, **what moved in the
last 24 hours**.

Overview is a scrolling page: greeting, summary banner, systems, then cards.
The first screen must carry the greeting, the banner and the systems row.

### Ask Bays
A chat interface onto the existing Bays agent.

Empty state: the BHA mark centred, large, with a slow subtle idle animation.
Input bar pinned to the bottom. Nothing else on screen until the user types.
On first send, the mark gives way to the thread.

Right-hand panel: new chat, chat history list, search past chats.

**Note:** Bays has no memory today. Build the history and new-chat UI fully
against fixtures. It gets wired in a later phase.

### North Star
**Two tabs**: Asks and Statistics. Asks is the working surface — five figures,
**asks per week and outcome over time**, the filter, the month, the search and
the asks. Those two charts are the last eight weeks rather than a month against
a month, which is why they are beside the asks and not on the other tab.
**Resync from Airtable** is at the top, the same control the other pages carry.

**It reads its own ledger** (`appRvx4u9V9BYp646 / tblSb9potJlYg2lZK`, decision
2026-09-17, Destiny), one row per ask, written by the agent at the end of every
run and mirrored to `POST /api/engine/ns-asks`. The legacy NS Records table it
read until then has no writers; the orange "none written since the migration
backfill" line was telling the truth and the fix was to point the page at
something live rather than to silence the line.

**Delivery rate is the headline, and it is the one coloured figure on the page.**
`Delivered = "Delivered"` over all asks. Delivery is recorded *after* the answer
is sent, so it is the only figure that says something reached a person rather
than that a run finished — North Star once ran green for six consecutive days
while Slack rejected every post and nothing reported it. Below 100% is bad.
Then: **answered rate** (the outcome metric), **asks**, **median response time
with p95 beside it**, and **last ask**, where silence is itself the signal.

**The old thin rate, classified and unclassified figures are not carried
across.** Thin at 100%, classified at 42% and unclassified at 58% were artefacts
of `outcome` being added late to the legacy table. Every row in this ledger
carries an outcome, so **there is no unclassified bucket**: the four are
Answered · Thin · Refused (not its lane) · Failed, and Thin is a slice of the
outcome mix rather than a headline of its own.

**Statistics**: outcome mix, delivery mix (naming the `Delivery Target` of
anything undelivered), **who is asking** — `Asked By System` with each cohort's
own answered and delivery rates, which is the card that catches a Slack path
failing behind an 8am sweep that keeps the aggregate healthy — question type
mix, citation coverage, tool usage parsed from `Evidence Used`, response time as
p50/p95 with a trend, **claimed priority tier by lane over time** (a lane called
Critical three weeks running is the pattern this makes visible), architect
attention with the lanes and dates, by lane counting `(no lane)` rather than
dropping it, and **twin-to-twin handoffs**.

### Research Twin
**Three tabs**: Asks, Jobs and Statistics (decision 2026-09-17, Destiny). Asks
are new — until then this page showed the queue and the twin's actual
conversations were recorded nowhere. **Resync from Airtable** is at the top and
sweeps both tables.

**Asks** (`appv39nQzmfC9VVkG / tblDmsqI9f0xfAO5m`, mirrored to
`POST /api/engine/rt-asks`). **"Went outside BHA" is the first figure on the
page**: `Used Web Search` over all asks. Research Twin's job is the outside
world, and Bays and North Star can both query BHARAG directly, so a low figure
means it is being used as a lookup either of them could have done themselves. It
is **not coloured** — a month of genuinely internal questions is a real month —
and the weekly trend on the statistics tab is what actually reads. Then answered
rate, **needs a human** (the escalation metric, beside the answered rate and
**never red**: escalating correctly beats a confident wrong answer), asks, and
median response time with p95.

**Statistics**: outcome mix with Needs human as its own slice, **external search
rate over time**, BHARAG reachable (a degraded evidence store is not the same as
a lane having no evidence, and any `No (degraded)` at all is worth surfacing),
sources per answer with the share citing nothing, citation coverage, confidence
mix **cross-cut against outcome** (High confidence with zero sources is the
combination worth catching), ask type mix, who is asking, delivery mix where
**Self-delivered is a correct outcome** — the weekly Watched Clients report posts
its own file during the run — response time as p50/p95, and twin-to-twin
handoffs.

**Jobs** (`appv39nQzmfC9VVkG / tblOsznfDELJdbyDR`). **A job is one row**, carrying
its own status, attempts and outcome. That is the semantic change from the queue
it replaced: that held one row per *attempt* with a second table for outcomes, so
"attempts" and "cards" were different counts and every figure had to collapse on
`card_id` first. `Attempts` is a number on the job now, capped at three, and
**none of the one-row-per-attempt language is carried across.**

**Capped, needing a person leads and is coloured**: any number above nought
needs attention, because nothing else in the engine will move those jobs. It is a
real outcome the queue records, not a failure it hides. Then open jobs
(Pending + In Progress), resolved this month, median time to resolve with p95,
and the age of the oldest open job. Its statistics cards: status depth, attempts
against the cap, gap types over capped and low-confidence jobs, time to resolve
trended, opened by, and a resolution rate over jobs that reached a terminal
state with open jobs excluded and named as excluded.

**The jobs tab carries its own freshness line.** An ask is mirrored the moment a
run ends; a job is updated in place and reaches this database only through the
resync. One age above both would be quietly wrong about whichever was not
written last.

### Both twins
These ledgers were created empty on 17 Sep 2026 with no history carried in, so
**September holds a handful of rows and October is the first clean month**.
Nothing on either page smooths that: a rate over two asks says it is over two
asks, an empty month says it was not recorded rather than drawing a bar at
nought, and the existing "recording starts" marker and the *"it was not quiet, it
was not recorded"* line stand as they are.

Five rules hold on every figure on both pages:

1. **A percentage always carries its denominator.** "25 of 59", never "42%".
2. **No duration is ever a mean.** p50 and p95 only, over the rows that carried
   one, with how many did stated beside them. A mean hides the tail and the tail
   is what people feel.
3. **Every card states what it excludes**, in its footnote, in plain English.
4. **Cohorts that matter are segmented** — by asking system and by lane. An
   aggregate mixing an automated sweep with human Slack questions hides a
   failure in either, in the direction that looks healthy.
5. **Colour only genuine bad directions**: delivery below 100%, capped jobs above
   nought, BHARAG degraded. Needs human, external-search rate and everything else
   stay neutral.

**Twin-to-twin handoffs** is one figure about the pair, so it has one route
(`/api/twin-handoffs`) rather than a copy computed on each page, and it appears
on the Home page as well as on both statistics tabs. It counts asks in either
ledger where `Linked Twin Ask` is set or `Asked By System` names the other twin,
plus an Ask ID appearing in a job's `Linked Asks`. **The fallbacks are stated in
the footnote rather than hidden**: the front doors do not yet pass
`Linked Twin Ask` through, so early rows leave it empty and this reads slightly
high rather than silently low. **A direction is only asserted where the row says
one** — `Asked By System` naming the other twin. A row carrying only
`Linked Twin Ask` proves the two are linked and nothing about who asked whom, so
it reads "linked" rather than an arrow this code picked.

### Clients
One row per watched lane, **grouped under the client that owns it** by the
index's own `Client ID`: two lanes with one id are one client with two lanes and
appear once, with the lanes nested beneath a heading row inside one table — one
set of columns, so the lanes line up down the whole page. Clients are ordered by
the **number** in the Client ID (2, 9, 12), not by its string, and the label is
"Client 9" from that id rather than a lane's full name.

**Requests are a third tab** (decision 2026-09-17, Destiny). `Client Requests`
(`tblhu29KejAPQfSuy`) appeared in the same base on 17 Sep 2026, for
LOOP-1789590960971-EHF9, and its own description states the rule this dashboard
has to render faithfully: **a request stays Requested or Under Review until
every Open Check is cleared**, so that interest is never mistaken for a
commitment. The open checks are therefore a column rather than a detail behind a
click, and a row with none outstanding says so in words — an empty cell would
read either as "nothing needed" or as "nobody has filled this in". Nothing is a
commitment until Airtable says **Confirmed**, and a status neither side knows
counts as open: the unsafe direction here is calling something a commitment.

Requests sit under the client whose `Client ID` they carry, the same grouping
the lanes use. **A request whose client id no index row has still appears**, in
a lane-less group of its own — it is a real thing a real client asked for, and
dropping it because the index has not caught up would be this dashboard deciding
a request does not exist. The tab has its own freshness line, because it reads a
different table from the lanes and "4 rows" above one while counting the other
is exactly the quietly-wrong figure this dashboard exists to remove. It is one
shared table for every client, so the resync sweeps it as a fixed source beside
the index rather than learning it from a row. Nothing here writes to it, and the
weekly Research Loop does not read it.

**The page renders what the `Index` table holds, never what tables exist in the
base** (`appkSUSh9ijNjP2f8 / tblFJ1yuYcuanjPdn`, four rows). Question tables with
no index row are orphans, are being deleted upstream, and never appear. Each
lane's questions table is read from its index row's `Table ID`; there is no
lane-to-table map in this code, so adding a client is a row, not a deploy.

**`Lane Status` and `Run State` are two different questions and get two
columns** (decision 2026-09-15, Destiny). Lane Status is onboarding maturity —
`warm_running`, `warming_up` — and moves with the calendar. Run State is the
outcome of the last research run — `contradicted`, `stuck`, `idle` — and is set
by Research Twin, not by the clock. A lane can be both at once, and the single
pill that mixed them could only say one.

**Staleness is `Next Run Due` against today**, because that is the field the
weekly clock reads; the age of the last run only says how long ago something
happened. Those stamps were frozen for weeks because nothing wrote them back,
fixed in n8n on 15 Sep, so they become real from the next weekly run — until
then the page shows every running lane overdue since 31 Aug, which is the
history and not a page fault.

"Needs human" reads the three circuit breakers that already exist upstream —
`Research Stuck`, `Run Count` at 3, or a quarantined lane — and never recomputes
what they mean. `Quarantined` is the real one: it flips true only when
`Stuck Cycle Count` reaches 3, and `Consecutive Error Count` and
`Infra Fix Required` are its infrastructure equivalents. `Run Count` caps at 3,
so a question at 3 is skipped by the weekly clock and is counted in its own
column. `Plain Summary` is deliberately jargon-free and is shown first. A lane
with no run yet is **warming up, not failing**.

### A statistics tile
**Every card in a statistics grid is one shape** (decision 2026-09-16, Destiny):
a title, the source field top right, **one figure in the display face at 30px**,
a quiet line under it saying what the figure is a share of, the detail it
summarises beneath that, and the note at the foot. `TileFigure` is that shape,
pulled out of `StatTile` so a tile a page brings with it cannot draw itself
differently — before it, half of North Star's and Research Twin's grids read as
figures and half as charts.

**A tile's headline is derived from what that tile already shows**, never from
anything else, so a reader can check it against the bars underneath it. Where a
card has no single obvious figure the headline is the largest share and the line
under it names which — never a status this code picks out by name, because the
vocabulary is Airtable's to change: a queue whose cards are all `answered` made
a hardcoded resolved-share read 0% above a bar saying 100%.

A figure the rows cannot support prints the reason where the number would be. A
dash set at 30px reads like a redaction, and worse, like a value.

### Monthly tracking, on every record page
Three components, same order, same styling on all five (decision 2026-09-15,
Destiny): **the month in view as figures**, a **month-over-month chart**, and a
**CSV export of exactly the rows on screen**. A month is selected by clicking
it; the page's list filters to it and the export follows that selection and
every other filter. Every export carries the record's natural key — `loop_id`,
`pattern_id`, `card_id`, the question's `record_id` — so a row traces back to
Airtable.

**A chart bar is never drawn for a month whose metric had no instrumentation.**
Every month carries its own coverage, separately for what was created and what
advanced, because the two are usually instrumented from different dates: `full`
is a solid bar, `partial` a hatched one marked "part", and `none` **no bar at
all** — a dashed boundary rule and a sentence saying what began when. A zero and
an absence must never look the same, which is the same rule as section 4's.

The boundaries, each a fact about the engine:

- **Open loops** — raised has always been dated by `Date Raised`. **Closed is
  dated only by this dashboard's own status ledger** (`meta.history_since`): the
  loop tables carry no close date and nothing upstream keeps a status-change
  history, so before that month there is no closed figure and no close rate.
- **Codex** — the approval **rate** is honest for the whole history because it
  counts a cohort's state today rather than a dated event. **Median days to
  approval is not**: `Jason Reviewed At` was created on **14 Sep 2026**, there is
  no backfill and never will be, so Sep 2026 is partial and **Oct 2026 is the
  first honest month**. It is drawn as its own panel with its own boundary.
- **Build patterns** and **Commercial** — Sep 2026 is partial on both. The
  extractor received empty payloads and correctly produced nothing until the
  upstream fix on 15 Sep; Commercial's card creation stopped on 9 Sep. The low
  bar is the outage, not a fall in output.
- **Clients** — counts questions by their own `Last Updated`, which has always
  been written correctly, and shows the `Movement Tag` mix per month. The
  index's `Last Run At` was frozen at 24 Aug because nothing wrote it back and is
  deliberately not the source.

**A record with no usable date is counted as undated, by name** — never dropped
and never re-bucketed into the earliest month. And **a month whose rows mostly
arrived later is marked partial**: Build Patterns holds 152 rows, most written
to Airtable in one go on 12 Aug 2026 carrying `created_at` values spread back
through July. Those dates are real and belong on the chart, but a bar of a
hundred backdated rows is not a hundred patterns' worth of output that month.

### Executions
**Every run of every workflow in the engine, as a record kind** (decision
2026-09-15, Destiny). It replaced a Bays page that held only Bays' executions,
and the execution sections that briefly sat on North Star and Research Twin: a
run is a record like any other and it is the same record whichever system
produced it, so one page with a tab per system beats a section repeated on
three.

**Tabs, like the System registry's**: All systems · Bays · North Star · Research
Twin · **Unregistered**, plus a tab for any other system the registry has filed
a running workflow under. **All systems leads**, because "every execution across
the engine" is what the page is for. The tabs sum to it exactly, and that is the
point of the last two: a workflow the registry names no system for used to be
counted in the total and shown under no tab, and one filed under a system
without a tab was invisible altogether. **A workflow must never be invisible
because a registry row is missing.**

**One month at a time** (decision 2026-09-16, Destiny). The week / month / year
control is gone: the tabs are what you switch between and the period is what you
set, and asking both questions in one row read as two controls for one view. The
server still answers at all three grains — the rows are one per execution and a
grain is only a `GROUP BY`, so nothing about the arithmetic changed and the other
two stay reachable by query string. The month is chosen in a picker, the same one
the record pages use, and the chart under the figures shows **that month's weeks**,
tallied from the same day rows so a month and its weeks can never disagree.

**Six figures, as tiles** — executions, succeeded, failed, failure rate, average
time, workflows run — in the same cards the record pages' statistics tabs use, so
a month of executions reads like a month of anything else here. The card that
carried the period in words above them is gone (decision 2026-09-16, Destiny);
the change against last month is still on every tile that has one.

Per period, per tab: **executions, succeeded, failed, failure rate and average
time**, each with its change against the same period before it; a chart over
periods with failures drawn inside the bar; and a per-workflow breakdown — name,
executions, failures, failure rate, average time, and the workflow itself
**opens**: its own days inside the period and its individual executions, each
with its id, start, duration, how it ran and how it ended, and each id opening
in n8n. That drill-down is why executions are stored as rows; a counter cannot
answer it however carefully it is kept.

**Above the figures, the period in words** — "executions up 12%, failures down
40%, average run time 3% faster" — because that is how a change is read. It is
written on the server so the page and the downloaded report cannot word the same
comparison differently.

**Two downloads, and both follow the tab** (decision 2026-09-16, Destiny). The
button at the top of the page takes **the whole year** — the control up there is
the year, so a report asked for from beside it is that year. The button on the
**Every month held** card, after the bars-or-line switch, opens a list of that
year's months and takes **one month**, which is where a reader is already looking
at months. All systems downloads every system; Bays downloads Bays. Each
re-reads its period from the server rather than building from what is on screen,
because the page holds one month and the report may be asked for another — the
grains are `GROUP BY`s over the same one-row-per-execution table, so a year
cannot disagree with the months inside it.

**A report downloads per week, per month or per year**: the figures on screen,
the per-workflow breakdown, and every period held. A report is kept after the
page is closed, so every caveat the page makes is inside the file — the
coverage of the period, the comparison in full, and the refusal where there is
nothing honest to compare against. A period with no coverage carries blank
cells, never zeros.

**A change is only coloured where the direction is news.** More executions is up
and means nothing on its own; more failures is up and is bad; a faster average
is down and is good. An outcome of `success` gets no colour either — a column of
green on a page where almost everything succeeds is decoration.

See section 4 for how the rows are stored and polled, for why nothing here
claims what n8n retains, and for the two rules that keep a comparison honest.

### Engine health
**Built 2026-09-17, Destiny**, where a "coming soon" page stood. It answers one
question: **is the engine actually working right now, and if not, what broke,
was it fixed by itself, and does anyone need to do something?**

Three sources, all of which were already being written and none of which had
ever been read:

- **The incident ledger**, BHARAG `GET /api/v1/incidents?status=open&source=<lane>`.
  **One call per lane, each with its own credential** — the three error handlers
  each hold their own BHARAG key and a key for one lane is refused for another,
  so this is three calls with three keys and cannot be collapsed into one.
  `BHARAG_BAYS_KEY`, `BHARAG_NORTH_STAR_KEY`, `BHARAG_RESEARCH_TWIN_KEY`, no
  defaults, on the same rule the Airtable base ids follow.
- **`error_counts`** (`appINvgEoZjuYQI2O / tblnvhKOnuOoiB1RX`), one row per
  recurring fault signature, shared by all three lanes.
- **`retry_attempts`** (`appINvgEoZjuYQI2O / tblu9fFmCkAaeJd8Y`), one row per
  incident the healer has touched.

All three are mirrored into Postgres through `/api/engine/{incidents,error_counts,retry_attempts}`
and the page reads the mirror, so a page load costs nothing external and a
refused read never blanks a screen. **Resync from Airtable** is the button, and
it reads all five sources.

**The rule the whole page is built around: no incidents and no reporting look
identical from the outside, and only one of them is good news.** A lane with no
credential was never asked; a lane that refused was asked and said no; a lane
that answered with nothing is the only one of the three that is health. Every
tab leads with which lanes answered, every figure computed over an unread lane
says so in its own note, and **a lane that was not read is never drawn as a
bar** — a bar is a measured value, and whatever count is held for an unread lane
is what happened to be stored.

**The final import lives here** (2026-09-22, Destiny), on the All systems tab
and under the page's own content: one button that runs every Airtable-backed
group in turn and prints what it did — inserted, updated, unchanged, **kept
newer here**, refused — with every kept row named beside both values. It is on
this page because it is not about any one record kind, and it is below the
figures because it is a one-off control for the cutover rather than part of
what this page is for. The groups run one after another, never in parallel:
nine full sweeps of somebody else's API from one click is how a careful pass
turns into a rate limit, and the workspace is over its cap already. It takes
itself off the page once `AIRTABLE_RETIRED` is on.

**Six tabs**: All systems · Bays · North Star · Research Twin · Retries ·
**Repairs** (the last one added 2026-09-20, with the repair bridge). **The
three lane tabs are one component with a different lane**, because the handlers
are deliberately identical and a per-lane copy would drift the first time one of
them changed. All systems is the same component with no lane. Retries and
Repairs are the two halves of what happened *after* a failure — what the healer
retried on its own, and what the bridge changed in a workflow.

**Five figures**: open incidents (the failure metric, coloured above nought,
with the per-lane split), healed without a person (`Recovered ÷ (Recovered +
Exhausted)`, with retries still in flight excluded because they have not
finished), needing a person (exhausted retries **union** open incidents in a
non-retryable class — a union, not a sum, because an incident can be both), the
most recent incident, and retries in the last 24 hours. Then two charts —
incidents per week stacked by lane, and by class over the same weeks, so a shift
in *what kind* of thing is breaking is visible and not only how much.

**The error classes are a shared vocabulary as of 17 Sep 2026**, and three of
them are retryable: `NETWORK_TIMEOUT` (which includes a 429 — rate limiting is
the caller going too fast, not a billing problem), `MODEL_OUTPUT_INVALID` (new;
a model answers differently every run so a retry usually works) and
`UPSTREAM_5XX` (new, split out of billing: a server error is not a refusal on
credit). `BILLING_QUOTA`, `CONFIG_AUTH`, `SCHEMA_VALIDATION` and `UNKNOWN` are
not. **The sources disagree about spelling** — `error_counts` writes
`schema_validation`, the ledger and `retry_attempts` write `SCHEMA_VALIDATION` —
and both are normalised to one spelling, read off the live tables rather than
assumed. **A class this dashboard has not heard of keeps its own name** rather
than being folded into `UNKNOWN`: `UNKNOWN` means the handler looked and could
not decide, which is a different fact.

**`retries_attempted` on the incident payload is never displayed.** The healer
does not maintain it — attempts live in `retry_attempts` — so it is stale the
moment a retry happens. It stays inside the stored blob, because nothing drops a
field the engine owns, and it has no way onto the page.

**Severity and retryability prefer the incident's own answer**, falling back to
the class map only where the row carries none, and each says which of the two
answered for it. This code never contradicts a handler about an incident the
handler classified.

**Incidents are never deleted.** The ledger is read with `status=open`, so a
closed incident simply stops appearing — and deleting those would throw away
exactly the history time-to-resolve is computed from. A row a **successful**
read no longer returns is marked closed-since and keeps everything else it had.
A lane that refused touches nothing. And an incident is dated by **its own
`created_at`**, never by when this database inserted it: the insert time is a
fact about the resync, and preferring it would put every incident read in one
pass into the week somebody pressed the button.

Per-lane tabs add **this lane's workflows** — open incidents by workflow, then by
the node that actually failed, because the failing node is the useful unit — and
**the advice given**, every open incident's `self_healing_strategy` **in full**.
It is written as plain English for a person to act on and it is the most useful
text on the page; truncating it to a line would throw away the only part that
says what to do.

**The Retries tab is the self-healing loop's own record.** The healer runs every
five minutes and calls n8n's own retry endpoint with `loadWorkflow: true`, which
resumes from the failed node rather than replaying the run — which is why a
retry does not re-post Slack messages or re-write rows it already wrote. Backoff
is 1 minute, then 4, then 15, each randomised by a fifth; three attempts is the
cap and reaching it breaks the circuit deliberately.

Two things that tab must not overstate, and both shape how it is drawn:
**a retry that ran is not a retry that worked** — `Retrying` is genuinely
undecided, so it is excluded from the recovery rate rather than counted either
way — and **`Exhausted` is not always a failure of the system**: a pruned
execution lands there immediately and correctly, which is why `last_result` is
shown in full on every row.

**Retry now posts to the same webhook the schedule posts to**, and is recorded
the same way against the same cap; only `triggered_by` differs, so the button is
not styled or described as a different mechanism. It is disabled at three
attempts and at a row with no execution id, and the tooltip says which — the
circuit is broken on purpose and a person should look before it is asked again.
The browser never calls the healer: the request goes to this server, which holds
the URL, like every other outbound call.

**The Repairs tab is the repair bridge's record, and the way back from one**
(decision 2026-09-20, Destiny). `bha-repair-bridge` is a separate always-on
service: n8n's `Bays — Error Handler` classifies a failure, refuses the classes
no code change can fix and the three error handlers and the healer by name, and
posts a repair request to it; the bridge runs Claude Code headless against the
failing workflow and posts its result to `POST /api/engine/repair`, which lands
in `engine_repairs`. Nothing here calls the bridge and nothing here runs a
repair: this dashboard is where a repair is read and undone.

**The rule the tab exists for: nothing heals invisibly.** Every failure ends as
retried, repaired, or waiting on a person, and every repair shows the error, the
root cause, the exact change, and a way back. So:

- **A repair is repaired only where the bridge said so and a `version_after`
  came back.** The bridge having been *called* is not a repair, and a run that
  finished without a parseable result is `needs_human` rather than assumed to
  have worked — enforced in the bridge and again here, because a guard that
  lives only in the caller is not a guard. The five outcomes are `repaired`,
  `not_repaired`, `needs_human`, `skipped` and `error`, and a sixth is refused
  with a 422 naming it rather than filed under one of them: the vocabulary is
  what the two services share, and one drifting is worth an error.
- **`human_action` is on the row, not behind the click.** A repair that ended by
  naming what a person should do has already said the most useful thing it will
  say, and the demo case is the shape to copy — "select an existing credential
  and verify it, or create a new one", never silence.
- **A revert restores the workflow and is stamped only once n8n has taken it.**
  `reverted_at` is a claim about another system's state, so it is written after
  that system agrees; a refused revert leaves the row exactly as it was, because
  a row that says it was reverted when it was not is worse than no revert.
- **Four guards, and the answer names which one refused**: the outcome is not
  `repaired`, it has already been reverted, no restore point was recorded, or
  **the workflow's current version is no longer the one the repair produced** —
  which means somebody has edited it since, and a blind restore would throw
  their work away. That last one is the only guard that costs a live read of
  n8n, so it happens when somebody asks to revert rather than on every row of
  the list.
- **A restore needs the workflow, not a version id.** n8n's public API offers
  `PUT /workflows/{id}`, which replaces a workflow with a body you supply, and
  no endpoint that fetches a historical version by its id — a version id names a
  restore point without containing it. So a revert restores from the snapshot
  the bridge reads before it edits anything, carried on its result payload;
  where that snapshot is absent the button is **refused with that reason and the
  manual route named** (the workflow's own history in n8n), never drawn as a
  revert that happened. The restore also mints a *new* version holding the old
  content rather than resurrecting the old id, so the row records what n8n
  actually produced.
- **The revert is the one write to n8n in this application** and it is used for
  nothing else. `server/src/n8n.ts` holds it beside its reads, so every use of
  `N8N_API_KEY` stays in one file, and nothing there edits, activates,
  deactivates or deletes a workflow. Section 3 still holds everywhere else:
  workflows are read, never modified. **`active` is deliberately not sent** — a
  restore that switched a live workflow off, or on, would be a second change
  nobody asked for.
- **Five figures**: repairs this week, repaired and standing, needing a person
  (coloured), not repaired (coloured), and median time to repair with p95.
  **"Standing" excludes a repair since put back**, because a reverted repair is
  not a fix the engine currently has — and those two figures are counted from
  the rows on screen rather than from the summary the server computed before the
  revert, so the strip cannot disagree with the table under it. A skipped or
  errored attempt is left out of the duration figures: they take milliseconds
  and would read as repairs being fast rather than as most attempts never
  running.
- **`repaired` is not green.** A machine changed a live workflow, which is worth
  reading rather than celebrating, so it carries the accent rather than the
  healthy tone. Colour marks only what needs somebody: needing a person, and not
  repaired.

Every figure on the page follows the same five rules the twins' pages follow: a
percentage carries its denominator, no duration is ever a mean (p50 and p95),
every card says what it excludes, nought is a number and an unread lane is a
sentence, and colour marks only a genuinely bad direction — open incidents above
nought, exhausted retries above nought, critical severity.

### vFarm — Early Access
**Built 2026-09-20, Destiny.** Two tabs, and the split is the point.

**Overview is unchanged and still says the page is not wired up.** Nothing on
the rack has ever written a row here, so the live-readings table, the lifecycle
timeline and the readiness panel are still gone and the sentence explaining why
is still the whole of that tab. The funnel arriving does not make the rack
instrumented, and a tab that quietly started implying it did would be the thing
section 2 forbids — which is why Early Access is a second tab rather than a
replacement for the first.

**Early Access is the funnel's receiving end, as a small CRM.** Since
2026-09-23 every lead is a Form A lead posted by Hardik's n8n tracker to
`POST /api/engine/vfarm-leads` (section 4), and **clicking a lead opens every
answer it gave**, grouped by subject in the form's own order under headings
that are this dashboard's, not the form's own section titles, which nothing
here can read. A lead from the superseded public route says it has no Form A
answers. The "never announced" marker is shown only on those old-route leads:
a Form A lead is announced by the tracker, never from here. A summary row
(leads, last 7 days, last 30 days, new against contacted), then the leads newest
first: date, name, email, organisation, where they came from, status, notes.
Status and notes are editable inline and nothing else is. An edit lands on
screen first and is put back if the server refuses it, and the summary counts are
recomputed from the rows on screen so the strip cannot disagree with the table
under it — which is the reconciliation bug the record pages already learned once.

**A repeat email is a neutral tag, not a warning.** Somebody asking twice is a
real signal and not a fault, so it gets no colour: amber and red are for a
genuinely bad state, per section 5.

**A lead that was never announced in Slack says so on its row.** It is the one
thing about the row a reader cannot see anywhere else, and it is exactly what
somebody needs when they are wondering why they missed one.

**It is a record to read and annotate, and nothing more.** No export, no email
sending, no bulk action beyond copying addresses out. The moment this page could
email somebody it would need to know who had already been emailed, and that is a
second system, not a tab. Nothing on it is a commitment: a row says a person
filled in a form.

### Media Twin, Genie and vFarm
**Three single centred "coming soon" pages, and nothing else** (decisions
2026-09-14 and 2026-09-16, Destiny). **Media Twin and Genie are systems in the
engine and belong in the Systems group**, so they are there, as placeholders,
rather than absent — nothing either of them does writes a row here yet, and a
page of fixtures would be the thing section 2 forbids. Genie's executions are
counted on the Executions page, under whichever system the workflow registry
files them.

Every card, table and figure they held was computed from phase 1 fixtures:
vFarm's live readings, rack state and readiness panel. Nothing on the rack has
ever written a row to this dashboard, so the page looked like instrumentation
without being any. Its fetches and its routes are gone rather than left running
behind a hidden page, and the removed code lives in git history rather than
commented out.

They keep their places in the sidebar. When the engine starts writing these
rows, what each page should show is the spec that stood here before the 14 Sep
entry — read it out of git.

### Open loops
The densest screen.

- Every loop with **time-in-status**, newest first. That number is the headline
  signal on this page.
- **Click a loop to edit it**: What, Status, Lane and Builder, in one save.
  `loop_id`, `Raised By`, `Date Raised` and `Source Link` are read-only.
- Grouped by owner, so you can see where work is piling up and on whom.
- Open, update and close a loop directly from the interface.
- A separate **review queue** for stale loops: each proposed close carries its
  supporting citation and a reason. The user approves or rejects. **Nothing ever
  auto-closes.**
- A reconciliation view for loops that went missing during data migration.
- **Every loop has an address**: `/open-loops/<loop_id>` opens it, and opening
  one puts that address in the bar so it can be copied (2026-09-22, Destiny).
  Keyed on `loop_id`, never the Airtable record id — a move between builder
  tables mints a new record id, so a link built on one breaks at exactly the
  moment somebody is following it. A link naming a loop this dashboard does not
  hold says so rather than quietly showing the list.

### Codex entries / Build patterns / Commercial
Entries by builder and week, session type, link to the narration, and the
generated codex itself. **Three stages**, one per step, ordered Approved first
and each printing its rule on the page — see section 4. They are mutually exclusive and sum to the
total, which the four tabs that came before did not: those asked a review
question and a gate question in one row, so "Complete" overlapped "Approved".
Clicking a row opens the whole entry: the generated codex and the review in
full and collapsible, Jason Status and notes, the completeness verdict with what
it found missing, and Approve / Send back to pending / Delete.

**Every entry has an address too**: `/codex/<Codex Entry ID>` opens it, the
same shape Open loops has and from the same hook so the two cannot drift. The
Codex entry id where there is one and the submission id where there is not — a
log still at the completeness check has no Codex entry id yet and a link to it
has to work anyway, which is the same pair the delete confirmation falls back
through.

**The page fade-in is keyed on the page, not on the whole path** (2026-09-22).
It always was keyed on `location.pathname`, which remounted the page on every
URL change and threw away everything it held. That was invisible until records
gained addresses of their own, and it is why a link to a record that is not held
used to answer with silence: the toast saying so was destroyed milliseconds
after it was set.

Build patterns and Commercial share the Codex page's shape — the same filter
bar, the same truncated list rows with the full record on click, the same chart
treatment, the same resync control in the same place.

**Build patterns and Commercial are one shape, not two** (decision 2026-09-16,
Destiny). Both open on the current month, chosen in a picker **to the left of the
search box** — where it is on every record page — and the strip, the cards and
the list all follow that one selection — a
strip answering all time beside a list answering one month is two right numbers
to two different questions, which is the reconciliation bug Open loops had. Each
carries a stat strip and then **exactly two cards**: Build patterns shows
reusability and created per week, Commercial shows confidence and created per
week. Each carries a **keyword bar** under the filter row, read off the record's
own id — a pattern's `pattern_id`, a card's `lane_id`
(`LANE-VFARM-ZONE_MONITORING_SAAS` gives zone, monitoring, saas). The system
segment is dropped from both because every row carries it. Commercial's
`bha_system` is deliberately not a keyword source: on that table it is prose,
and splitting it on spaces yields "documented" and "layer".

**Commercial's media-readiness filter bar is gone, and two of its cards moved**
(decision 2026-09-16, Destiny). The bar read All / high / medium / low / not set
beside a confidence bar reading the same five words, which is two controls for
one question; confidence is the one left. Media readiness and the open-question
trend are **statistics tiles** now — both are month-against-month questions, so
they belong beside the month-against-month figures, in the same cards. The
trend is the one figure there that is never scoped to the month: it is this
dashboard's own observation of the whole corpus at each resync, and cutting a
record of when something was written down to the month the cards were created
in would be two questions in one chart. Media readiness is still a sortable
column on the list, because it is still the second half of the default order.
The list's own table no longer scrolls sideways at the widths the other record
tables fit at; `media readiness` and `open questions` are headed `media` and
`questions`, which is what bought the room.

**Build patterns reads at the density the other record pages do** (decision
2026-09-16, Destiny): **four figures on the strip**, not three — patterns,
distinct pattern ids, **systems covered**, broadly reusable — and a **system**
column on the list, both read off the second segment of each pattern's own id.
That derivation used to require a slug after the sequence number, so
`BP-BHARAG-114` was filed under no system at all; the system is the second
segment and nothing more is needed to read it. The slug is what the keywords
come from, and only that.

**Pattern candidates are a tab on Build patterns** (2026-09-23, Destiny):
Patterns · **Candidates** · Statistics, at `/build-patterns?view=candidates` — the
tab is in the address, and that URL is the one Bays' instructions give in place
of the retired Airtable view. `GET /api/pattern-candidates`, behind the cookie,
reads `engine_pattern_candidates` directly (a mirror kind with no store mapper),
with the field names exactly as the rows carry them — `Candidate`, `Summary`,
`Lane`, `Status`, `Builder`, `Suggested Architect`, `Why This Architect`,
`Flagged By`, `Source Link`, `Date Flagged`, `Pattern ID`, `Registered At`.
Newest Date Flagged first. Status counts are the filter; the page's own month
picker and search box scope it too, the month being the month flagged. A row
opens in the same dialog shape a pattern does, and a Registered row's Pattern
ID opens that pattern through the Patterns tab's own `setOpen` — no second
mechanism. **Read only**: a candidate is registered through the Bays Tools
Router's `log_build_pattern`, never from here. A failed read says so on the tab
rather than drawing an empty list.

**Build patterns has no status** (decision 2026-09-15, Destiny). `pattern_status`
was deleted from the base and removed from every workflow that wrote it, so the
canonical / draft / no-status split, its tabs, its pill, its filter and the two
row actions that wrote it are gone, and the page neither reads nor writes that
column. The all-systems strip — BP-BHARAG, BP-CAPACITY, BP-CST — is gone too: it
grouped rows by the domain segment of their own id, which the id already says on
the row. What is left that varies is `reusability` (Narrow / Moderate / Broad,
and the rows that answer in a sentence), and that is the page's one grouping.
`implementation_checklist` is a pipe-separated string, split on ` | ` for
display. The amber "none written since the migration backfill" line comes off,
same as Codex: it says n8n has gone quiet, which is not what it means on a page
kept current by a button.

**Nothing on Commercial groups the corpus** (decision 2026-09-15, Destiny). All
21 records were checked against every candidate axis: `lane_id` is 1:1 with the
card (21 values, 21 cards); `readiness_state` is 19 Research-First to 1
Media-Ready to 1 blank, and `INCUBATE` has never been used; `pilot_state`,
`routing_state`, `media_gate` and `lane_state` are a single hardcoded value on
every row, written by the extractor, and Process Twin is the only thing that
would ever advance them. So the lane tab, the readiness tab, the card-name tab
and the per-lane strip are gone, replaced by **one sortable table** defaulting
to `missing_research_count` ascending then `media_readiness` descending —
closest to ready first, which is the question the page answers. Four figures
above it: cards, cards with no open research question, cards at Media-Ready,
open research questions across the corpus. The four constants are still shown on
the card, because they are what the row says; they are never a tab or a chart,
because a bucket holding everything sorts nothing.

**The per-lane strip read "1.3 open" and nothing computed it.** It was
`{n} · {unresolved} open` — a middot between two integers — and because every
lane holds exactly one card the first number was always 1. "1.5 open" was one
card with five open research questions. It went with the grouping.

**Eight columns are dead scaffold and are not mapped at all**:
`demand_signal_sources`, `demand_evidence`, `cta_surface_plan`,
`media_twin_integration_plan`, `subscription_flow_state`,
`infra_readiness_state`, `engine_movement_state`, `lane_state_blocked_reason` —
single-selects whose only options are whole English sentences, written once as
placeholders and never populated, on roughly half the records; the last has an
option whose name is the empty string. They stay in Airtable and inside the
stored `fields` blob, because nothing here removes a column the engine owns, but
they have no way onto the page.

**The schema grew over months, so absence is rendered as absence.** July and
early-August cards lack `lane_state`, `engine_movement_state`,
`missing_research_count`, `infra_gaps` and `reuse_patterns` entirely, and the
card shows what a record has rather than narrowing to the fields every record
carries — which is why the page used to show so much less than the table holds.
The one record missing what a complete extractor run writes
(`CARD-1783965721620-1RJX`, no `created_at`, `media_readiness`, `pilot_state` or
`readiness_state`) is surfaced as **incomplete**, never as a bucket of its own.

### Pay Tracker
**Built 2026-09-17, Destiny**, against a ledger created the same day. One
question: **who is owed money, for what work, and what has already been paid?**
Before it, pay was a tick on a Slack card, so answering "what do I owe Hardik for
September" meant scrolling back through weeks of messages.

The BHA Pay Ledger, `appwnt0mEtfwDtcN5`, three tables — **Builders**
(`tblS6WMJugqP8GJNa`, who is paid how), **Sessions** (`tblPVfIicEiJ2uOYC`, one
row per approved session, owed or paid) and **Monthly Statements**
(`tbl5iAdfhz91PZrUg`, one row per monthly builder per month). Mirrored through
`POST /api/engine/pay` — **one route with a `kind` of "session" or "statement" in
the body**, which is what n8n was given, rather than three kind-named routes;
those exist too and the dispatch is the only thing that differs. **The session
logs are the source of truth for Paid** (2026-09-23): a pay row's Paid, Paid At
and Paid By are whatever its log says, whoever posts it.

Four rules run through every figure, and they are what the page is for:

- **It counts work, not money.** There are no rates in this system and none
  appear here. If a rate is ever added it belongs in the Builders table first;
  until then any figure with a currency sign on it would be invented.
- **It is read-only.** Paid status is set by the Slack card or by a monthly
  statement closing. Two places to change the same fact is how records drift, so
  there is no write path from this page and no button that would make one.
- **Monthly and daily are never summed into one rate.** They are different
  agreements — a monthly builder is *expected* to wait until the 1st — so a
  blended figure describes nobody. Time to pay is two figures, never one, and
  the Owed tab is two tables rather than one with a column.
- **Working days and session count are different numbers.** Two sessions in one
  day is one working day and two sessions. Neither is derived from the other and
  neither is presented as the other; the statement panel prints both side by
  side and says so when they differ.

**A month is the session's own month**, which comes from the session date. A
session worked on 30 September and approved on 1 October belongs to September,
and nothing here groups by `Approved At`. **`Pay Mode` is frozen onto the
session at approval**: if somebody moves from daily to monthly their old sessions
keep the mode they had, so the page reads the row's own value and never joins to
the Builders table to decide how a past session should be treated. **A session
carrying neither mode is counted apart from both** and named wherever the split
is printed, because a split that does not add up to the figure above it is the
quietly-wrong number this dashboard exists to remove.

**Four tabs, Owed first.** Owed is one row per builder, not per session — that is
the view Jason wants on payday, and the sessions behind a figure are the evidence
for it rather than the answer, so they are behind a click. Statements is every
monthly statement with its **evidence block shown whole**: it is the proof Jason
asked for and a one-line summary of it would defeat the point of writing it down.
Sessions is the full ledger for when an answer needs checking. Statistics is the
shape over time.

**A session opens its Codex entry, in place** (2026-09-23, Destiny). The row
links were wrong twice over: "Codex" opened `Codex Link`, which is the Otter
recording, and "Airtable" opened a retired base. Both are gone, with every
other Airtable link and word on /pay; **Open** shows the entry in the same
dialog the Codex page uses (`src/screens/CodexEntryDialog.tsx`, moved there
from Codex.tsx, not copied), **read-only** — no Approve, Send back, Delete or
Airtable button, because this page has no write path. The recording is the
narration link inside it. `GET /api/pay/sessions/:id/codex` resolves the
session on the server: by `Codex Entry ID` where exactly one Codex row carries
it, else by `Codex Link` = the entry's `Session Url` where exactly one does —
only 67 of 211 Codex rows carry a `Codex Entry ID`, and on 23 Sep that split
the 78 sessions 67 by id and 11 by recording, none ambiguous, none unresolved.
Two matches is a 409 naming both, never a pick; none is a 404 the dialog
states plainly, not in red.

**Status colour on a statement: only `Disputed`, and `Sent` once it is older than
fourteen days.** `Payment Sent` is not a success to celebrate, it is the normal
state, so it carries none. A statement closes itself to Payment Sent once every
session behind it is ticked — so if a payment goes out and the sessions are never
ticked, the statement stays open and reappears, which is a forgotten payment
surfacing rather than vanishing.

**The ledger is written with the session log, in the same request**
(decision 2026-09-23, Destiny — see "The pay ledger follows the session log" in
section 4). The n8n `Bays — Pay Ledger Sync` job that ran every 30 minutes has
nothing left to do and can be retired; the page carries a **Live** indicator
where the Resync button stood, grey when the update stream is down. **The
ledger's own age is still on the page, and still load-bearing**: nothing owed
and nothing ever written look identical, and on a pay page that is the
difference between a quiet month and an unpaid builder, so every empty state
here says which of the two it is rather than drawing a tidy nought.

**Sessions whose `Builder Slack ID` matches nobody on the roster are surfaced,
never dropped.** It should be nought; if it is not, somebody is building and the
pay system has not been told who they are, so no statement will ever include them
and no card will ever be sent. Colour is otherwise reserved for what is genuinely
bad: unpaid past sixty days, a disputed statement, a statement sent and unanswered
past fourteen days.

### System registry
**Four registries on one page** (decision 2026-09-14, Destiny) — Builders,
Tools, Endpoint, Workflow. **Engine writes is gone** (2026-09-22, Destiny): it
compared this database against Airtable, and Airtable is retired, so it
compared against nothing. `/api/engine-writes` went with it; the
`engine_writes` log itself is kept and still read. The Airtable bases on the
Endpoint tab are labelled as history, not live. A service's url is shown, not
edited, on the Tools tab. The workflow registry was brought in step with the
live n8n list on 2026-09-22 (13 rows added by seed, 3 corrected by migration 24,
each only where the row still held its seeded value).

**There is no credentials registry.** The `registry_credentials` table is not
dropped, because nothing drops a table, but it is neither read nor served.

**Builders** is the roster with the live figures beside it: who they are and
what they own from `registry_people`, and open loops, oldest loop age and
entries this week read from Postgres. Nothing on it comes from a fixture, and a
figure the rows cannot support is null with a note rather than a zero.

---

## 8. Rules that apply to every row, on every screen

- **Four-field spine** on every record: `session_id`, `builder_id`,
  `subsystem`, `lane`. The lane filter lives in session state and the data
  module honours it; the dropdown was removed from the shell on 2026-09-08
  (Destiny) and can return as a page-level control when a screen needs it.
- **Tags rendered where present:** `pay_eligible`, `is_incident`,
  `self_healed`. Small, quiet, consistent everywhere.
- **Every row links back to its source** — Slack message, Airtable record, or
  n8n execution.
- **Empty states name what is missing and why.** Several Gaps tabs will be empty
  at launch. The correct empty state is a plain sentence explaining that nothing
  is recording this yet — not a shrug icon, and never filler rows.

---

## 9. BUILD_LOG.md

Maintain `BUILD_LOG.md` in the repo root. Append as you work — not a summary
written at the end.

Each entry:

```
## YYYY-MM-DD HH:MM — short title
Intent:     what you set out to do
Files:      which files changed
Problem:    what broke, with the error text verbatim
Fix:        what resolved it
Decision:   any choice made, and why
```

Never rewrite or condense earlier entries. This file is the source for BHA's
session narrations, so specificity matters more than tidiness.

At the end of each session, upload the current `BUILD_LOG.md` to Google Drive
via the Drive connector.

---

## 10. Session start checklist

1. Read this file.
2. Read `README.md`.
3. Run `/mcp` and confirm Slack, Drive and n8n are attached.
4. Read `BUILD_LOG.md` to see where the last session ended.
5. State what you plan to do before doing it.
