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
- **The status-change history accumulates, and is now the whole ledger.** The
  events table (status changes with timestamps) is the only place a close is
  dated, and a record's previous status is its last event. An engine write
  records its own event as it lands; a reconcile at boot writes down anything
  that changed while the process was not running, stamped `via = 'mirror'` and
  left out of close-rate figures because it cannot be dated. `meta.history_since`
  is when this database began recording — not the last restart. Every metric
  derived from it still cites that date, and one the rows cannot support is
  still null with a note.
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
- **Read only, and there is no write path to close.** v1 has no write tool and
  no code route from a tool to a write. `get_page_data` reads through an
  in-process GET against this server's own `/api` router — the same function
  that answers the browser, which is what stops the tool drifting from the
  page — and that loopback is GET-only and refuses `/api/engine/*` and
  `/api/inbound/*` by name.
- **`MCP_SECRET` is a path segment, and a miss is a 404.** Anything that is not
  exactly `/mcp/<MCP_SECRET>` — a wrong secret, a deeper path, every request
  when the variable is unset — gets the 404 an unknown route gets. **Never a
  401**: a 401 tells a stranger the endpoint is there and that they need a
  credential. No default, on the rule the base ids follow.
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
- Every call is logged with its name and arguments. Seven tools: `list_pages`,
  `get_page_structure` (the one that matters — it is what lets somebody reason
  about a page they cannot see), `get_component`, `search_source`,
  `list_data_sources`, `get_page_data`, `get_health`.

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
`N8N_API_KEY` — the n8n **instance** API key, read only, two endpoints
(`GET /api/v1/executions` and `GET /api/v1/workflows`, the second for names
only), for the Executions page; not the same credential as `ASK_BAYS_API_KEY`,
which is a webhook header. Without it no execution is ever read and the page
says so rather than reading zero.
`BHARAG_BAYS_KEY`, `BHARAG_NORTH_STAR_KEY` and `BHARAG_RESEARCH_TWIN_KEY` — the
incident ledger, one per lane, read only, no defaults. A lane with no key is
never read and Engine health says so rather than showing it healthy; the boot
line names every lane that is not keyed. `AIRTABLE_TOKEN` also needs read on
`appINvgEoZjuYQI2O` (engine_events) for that page's two Airtable tables.
`ENGINE_HEAL_URL` is the self-healing webhook behind Retry now, optional, with
the live webhook as its default. `AIRTABLE_TOKEN` also needs read on
`appwnt0mEtfwDtcN5` (BHA Pay Ledger) for Pay Tracker — read only, and no base
variable, because nothing here ever writes to it.
`MCP_SECRET` — the path secret for the MCP server at `/mcp/<MCP_SECRET>`, read
only. **No default**, and unset the endpoint answers 404 to everything and the
boot line names the variable; it is `sync: false` in the blueprint rather than a
generated value because the same string goes into the Claude connector URL.
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
  vFarm                  ← placeholder
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
fifteen fit the shortest laptop; `overflow-y-auto` is kept only as the failure
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

**Five tabs**: All systems · Bays · North Star · Research Twin · Retries. **The
three lane tabs are one component with a different lane**, because the handlers
are deliberately identical and a per-lane copy would drift the first time one of
them changed. All systems is the same component with no lane.

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

Every figure on the page follows the same five rules the twins' pages follow: a
percentage carries its denominator, no duration is ever a mean (p50 and p95),
every card says what it excludes, nought is a number and an unread lane is a
sentence, and colour marks only a genuinely bad direction — open incidents above
nought, exhausted retries above nought, critical severity.

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

### Codex entries / Build patterns / Commercial
Entries by builder and week, session type, link to the narration, and the
generated codex itself. **Three stages**, one per step, ordered Approved first
and each printing its rule on the page — see section 4. They are mutually exclusive and sum to the
total, which the four tabs that came before did not: those asked a review
question and a gate question in one row, so "Complete" overlapped "Approved".
Clicking a row opens the whole entry: the generated codex and the review in
full and collapsible, Jason Status and notes, the completeness verdict with what
it found missing, and Approve / Send back to pending / Delete.

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
those exist too and the dispatch is the only thing that differs. **Resync from
Airtable** is the button, and Airtable is the source of truth.

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

**Status colour on a statement: only `Disputed`, and `Sent` once it is older than
fourteen days.** `Payment Sent` is not a success to celebrate, it is the normal
state, so it carries none. A statement closes itself to Payment Sent once every
session behind it is ticked — so if a payment goes out and the sessions are never
ticked, the statement stays open and reappears, which is a forgotten payment
surfacing rather than vanishing.

**The ledger's own age is on the page, and it is load-bearing.** The ledger is
kept in step with the approved logs by a sync that runs every 30 minutes, and
this dashboard reads the ledger when somebody presses Resync — two hops, both
stated. **Nothing owed and the sync not having run look identical**, and on a pay
page that is the difference between a quiet month and an unpaid builder, so every
empty state here says which of the two it is rather than drawing a tidy nought.

**Sessions whose `Builder Slack ID` matches nobody on the roster are surfaced,
never dropped.** It should be nought; if it is not, somebody is building and the
pay system has not been told who they are, so no statement will ever include them
and no card will ever be sent. Colour is otherwise reserved for what is genuinely
bad: unpaid past sixty days, a disputed statement, a statement sent and unanswered
past fourteen days.

### System registry
**Four registries on one page** (decision 2026-09-14, Destiny) — Builders,
Tools, Endpoint, Workflow — plus **Engine writes** as a fifth tab, which is the
dual-write surface rather than a registry.

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
