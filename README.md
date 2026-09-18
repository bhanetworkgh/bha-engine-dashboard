# BHA Engine Dashboard

Internal dashboard for Bays Horizon Advisory's automation engine.

The engine — Bays, Research Twin, North Star, Codex, BHARAG and vFarm — has no
single window onto its own state. Its data sits across Airtable, BHARAG and n8n's
execution history. Answering "what changed this week", "which loops are stale",
or "is vFarm on track" currently means opening six places by hand.

This is that window. Internal team tooling, not a customer product.

## Status

**Live on Render as one Node web service.** Sign-in is verified by the
server, which sets a session cookie. Ask Bays goes through the server to the
live agent workflow. **Open loops, Codex entries, build patterns, commercial
cards, both twins' ask ledgers, the research queue and the watched clients are
read out of this server's own Postgres tables**, which the engine writes to
through `/api/engine/:kind`. A change made on a page is written to the same
row. There is no Airtable read path left: the sync that used to rebuild a read
model from Airtable, the Airtable client and `AIRTABLE_API_KEY` were removed on
13 September 2026 (step 3 of the migration), after the tables were backfilled
and the engine's writes proved out.

**Loops and Codex entries are edited here and written straight to Airtable**
(14 September 2026) — the two record kinds this server writes there. See *Loop
edits* and *Codex entries* below.

Airtable's own field names are kept verbatim inside each row — `What`,
`Jason Status`, `Layer1 Review ` with its trailing space — because that is what
n8n writes, and a rename would break the engine's writes with no error.

**The System Registry** is the exception to all of that: four registries on one
page — Builders, Tools, Endpoint and Workflow — that this dashboard owns
outright. Nothing upstream records who manages Otter.ai or what a workflow is
for; rows are created and edited in the interface and stored in Postgres. The
Builders registry adds three figures it does not own: open loops, oldest loop
age and entries this week, read from the record tables on every load.

**There is no credentials registry** (2026-09-14). The table is not dropped,
because nothing drops a table, but it is neither served nor shown: it held names
and owners with no column a secret could go in, and it was still the place
somebody would reach for when they wanted somewhere to keep a key.

The server's state is in Postgres (`bha-engine-db` on Render, attached as
`DATABASE_URL`) and there is no second copy of anything: the engine writes a
row, the page reads that row. The status-change history nothing upstream keeps
is recorded here as each change lands and survives a deploy and a restart. The
server will not start without the database: there is no fallback store, because
one would lose writes without saying so. The twins are still phase 1 fixtures;
**vFarm and Engine health are placeholders** (2026-09-14) because every figure
they drew was one, and the Builders page is gone into the registry. Chat history
stays in the browser until Bays keeps memory of its own.

## Architecture

```
Browser  →  this repo's server (/api, same origin)  →  BHA engine (n8n)  →  data sources
```

A React front end and a small Node server, deployed together as one Render web
service. The server serves the built front end and answers every `/api` call.
It owns every secret: the login credential, the session signing key and the
engine API key. The browser holds none of them and never talks to the engine.

The server has one dependency, `pg`. Its state is in Postgres, reached through
a connection pool over `DATABASE_URL`; the schema is applied by a forward-only
migration runner on every boot, idempotently. Until 2026-09-12 it was a SQLite
file under `DATA_DIR` and that is gone: Render wiped the file on every deploy
and every spin-down, so nothing derived from it survived a restart.

All browser data access goes through one module, `src/data/index.ts`, which
calls `/api`. On the server, `engine.ts` derives every read, `store.ts` reads
the `engine_*` tables and owns the status-change history and the write paths,
`mirror.ts` is the one way a row gets into those tables, and `sources.ts` says
where each kind came from in Airtable and how its fields become a record.

### Inbound writes from n8n

`DASHBOARD_INBOUND_KEY` in the `x-dashboard-key` header authenticates these;
the session cookie is not needed. `:kind` is `loops`, `codex`, `patterns` or
`commercial`.

```
POST   /api/inbound/:kind           { id, record, builder?, table?, at? }   create or update
PATCH  /api/inbound/:kind/:id       { record, builder?, table?, at? }       same, id in the path
DELETE /api/inbound/:kind/:id                                                drop the row
```

`record` is the Airtable record as n8n's Airtable node returns it
(`{ id, createdTime, fields }`); the id may be given at the top level, in the
path, or only inside the record. For loops and Codex entries, `builder` (e.g. `jegan`) or
`table` (the tbl… id) says which builder table it lives in. `at` is the time of
the change and stamps the status event; without it the server uses now. The
call is idempotent: the same record twice is one row and no second event.

Two things changed on 13 September 2026. `record` is now **required** — this
server no longer reads Airtable, so a payload that only names a record has
nothing to fetch it from, and it says so rather than storing nothing.
`POST /api/inbound/resync/:kind` answers 410: there is no read model to
rebuild. Prefer `/api/engine/:kind` below; this route writes the same rows.

### Engine writes — n8n straight into Postgres

This is how every record reaches the dashboard (2026-09-13, all three steps
done). The engine writes a record here and the page reads that row; there is no
sync in between and nothing to rebuild. A kind n8n has not been pointed at is
not stale — it is stopped, and its rows stay exactly as the migration backfill
left them. The **Engine writes** tab of the System Registry names any kind in
that state.

**Auth.** The same service key as the inbound routes above: `DASHBOARD_INBOUND_KEY`
in the `x-dashboard-key` header. One key for the engine, already set on the
service. It is checked before the router looks at the kind or reads the body, so
an unauthenticated request never reaches a handler, and it never reaches the
browser bundle.

```
POST /api/engine/:kind          x-dashboard-key: <DASHBOARD_INBOUND_KEY>
```

**Body.** Airtable's own envelope. The values go under `fields`, with Airtable's
own field names — `What`, `Jason Status`, `Layer1 Review ` including its trailing
space. Sending the record's top level instead of `.fields` stores nothing, and is
refused with a message saying so.

```json
{
  "record_id": "recXXXXXXXXXXXXXX",
  "created_time": "2026-08-29T22:54:48.000Z",
  "builder_id": "destiny",
  "fields": { "loop_id": "LOOP-1788044070646-QNNK", "What": "…", "Status": "Open" }
}
```

`record_id` is Airtable's id and is optional wherever the row has a natural id —
leave it out when the engine is writing a row Airtable does not have yet, and
send it once it does; the row is adopted, not duplicated.

**Upserts.** Every endpoint is an upsert. The same row twice updates rather than
duplicating, so n8n retrying is safe. The response says which happened.

| kind | required besides `fields` | matched on |
|---|---|---|
| `loops` | `builder_id` or `table_id` | `loop_id`, else `record_id` |
| `codex` | `builder_id` or `table_id` | `Submission ID`, else `record_id` |
| `layer0` | — | `Submission ID`, else `record_id` |
| `patterns` | — | `pattern_id`, else `record_id` |
| `commercial` | — | `card_id`, else `record_id` |
| `ns-asks` | — | `Ask ID`, else `record_id` |
| `rt-asks` | — | `Ask ID`, else `record_id` |
| `rt-jobs` | — | `Job ID`, else `record_id` |
| `client_lanes` | — | `Lane ID`, else `record_id` |
| `client_questions` | `table_id`, `record_id` | `record_id` only |
| `client_requests` | `record_id` | `record_id` only |
| `incidents` | — | `entity_id`, else `record_id` |
| `pay_builders` | — | `Slack User ID`, else `record_id` |
| `pay_sessions` | — | `Codex Entry ID`, else `record_id` |
| `pay_statements` | — | `Statement ID`, else `record_id` |
| `error_counts` | — | `signature`, else `record_id` |
| `retry_attempts` | — | `incident_id`, else `record_id` |
| `digests` | — | `session_id`, else `record_id` |

**`incidents` comes from BHARAG rather than Airtable**, so it is the one kind
with no `record_id` to send: the ledger's `entity_id` is the key. Everything
else about the write is identical — same envelope, same header, same write log.

**The pay ledger posts to `/api/engine/pay`** with a `kind` of `"session"` or
`"statement"` in the body, rather than to a kind-named route — that is what n8n
was given, so that is what the server accepts. The body's `kind` is mapped onto
the mirror kind and everything after that is the ordinary path, so a pay row
lands with the same envelope, auth and write log as any other. There is no
default: a row with no `kind` is refused, naming the two options, because
guessing which of the ledger's tables a row belongs to is not recoverable.

`client_questions` and `client_requests` require `record_id`: neither carries an
id of its own, so Airtable's record id is the only thing that identifies a row.

**`ns` and `rt` are gone as kinds** (17 Sep 2026). Both twins moved onto their
own Airtable ledgers that day, and the endpoints are `ns-asks`, `rt-asks` and
`rt-jobs`; the old names now 404 with the list of kinds that do exist. The kinds
they replaced wrote to the legacy NS Records and Research Queue tables, which
have no writers left. **The research queue is one row per job now, not one per
attempt** — `Job ID` is unique, where `card_id` on the old table repeated, so
`rt-jobs` keys on a natural id where `rt` could not.

A job is *updated in place* as it is worked and the agent only mirrors on an ask
write, so `rt-jobs` exists for when n8n is pointed at it and **Resync from
Airtable on the Research Twin page is what actually keeps the queue current
today** — that button sweeps the ask ledger and the jobs table together.

For `loops` and `codex`, **`builder_id` is which builder's table the row lives in,
and that is what decides ownership** — not `Assignee Slack User ID`, which
disagrees on real rows. Send `destiny`, `jason`, `kaiqi`, `jegan`, `ahad`,
`hardik` or `kavin`, or the `tbl…` id itself.

**Responses.**

```json
{ "ok": true, "id": 577, "kind": "loops", "airtable_record_id": "rec…",
  "natural_id": "LOOP-…", "outcome": "inserted", "matched_on": "insert" }
```

`outcome` is `inserted`, `updated` or `unchanged` — a re-send of identical data
reports `unchanged` and writes nothing. A refusal is a 4xx whose `message` names
the field and says what was wrong with it:

```json
{ "ok": false, "message": "\"builder_id\" is required for loops: which builder's table this row lives in decides who owns it. …" }
```

**Every write is logged**, accepted or refused, to the `engine_writes` table and
to stdout: endpoint, kind, which key authenticated it, the row id, the outcome
and the reason for a refusal. It is on the **Engine writes** tab of the System
Registry, alongside a row count per record table split by whether the migration
backfill, the engine or a page wrote each row last — which is how you see that a
kind has stopped being fed.

### Loop edits — written straight to Airtable

Removing the Airtable client on 13 September left a real gap: `Bays — Daily
Open Loops Sweep` reads **Airtable**, so a loop closed in the dashboard updated
Postgres, left Airtable saying `Open`, and came back in the next 08:00 digest as
though nothing had happened. It was closed on 14 September through an n8n
webhook, and the same day by writing directly, which is what stands: the loop
panel edits four things at once and can move a row between builder tables, and
routing that through a webhook left no way to see where a half-completed move
stopped.

`AIRTABLE_TOKEN` on the Open Loops base (`AIRTABLE_OPEN_LOOPS_BASE_ID`) and, for
Codex, BHA Submissions (`AIRTABLE_SUBMISSIONS_BASE_ID`) — **the one token needs
read and write on both**. No other record kind is read from or written to
Airtable by this server; the pages still read Postgres. **One variable per base, named for its
base**, and no built-in default on this one: a default is a guess about which
base real loops are written to. Unset, the server names it at boot and refuses
every loop edit with the same sentence.

**Click a loop to edit it.** What, Status, Lane and Builder. `loop_id`,
`Raised By`, `Date Raised` and `Source Link` are shown and read-only.

**Postgres first, then Airtable.** The Airtable write never blocks or rolls back
the Postgres write, and every outcome is stored on the loop and shown on it.

#### Changing the builder is a move

There is no builder field: the builder *is* which of the seven tables the row
sits in. Changing it runs, in this order and no other:

1. read the full source row
2. create in the destination table
3. confirm a record id came back
4. only then delete from the source

Create before delete, so the worst case is the loop existing twice — visible and
fixable — rather than gone with nothing to recover from. If step 4 fails the
move is **not** retried: the outcome is `duplicate`, and it says *this loop now
exists in both X and Y — the copy in X needs deleting*, with the steps that
completed.

**The copy can be removed from here** (2026-09-14). The duplicate banner and the
loop panel carry *Remove the copy in X's table*, which retries that one delete
against the source table and the record id the move wrote down — migration 8
keeps it on the duplicate line, because by then the loop's own record id is the
new one. It never re-creates anything and never touches the destination row: the
loop already lives there, so re-running the move would make a third copy out of
a second. A source record that is already gone counts as done — somebody
deleting it in Airtable by hand reaches the same state. A retry that fails again
stays `duplicate` with the new reason on it and the action still offered.

`loop_id` travels unchanged; it is the identity. `What`, `Status`, `lane_tag`,
`Raised By`, `Date Raised`, `Source Link` and `raised_in` are carried.
**`Assignee Slack User ID` is never copied** — it is set from the destination
builder, because the digest routes by table and a row in one builder's table
naming another mis-delivered on 7 Sept. The new Airtable record id is stored
against the loop, and the status events, the note and the write log are re-keyed
onto it.

Edits and a move in one save are one operation: the edits are folded into the
fields the new row is created with.

**The move lands in Postgres only once Airtable has made it.** Which table a row
sits in is a fact about Airtable, not a field this dashboard owns — claiming it
early left this database saying one builder while the row was still in another's
table, with nothing left that knew where it really was. The field edits still go
first and still stand either way.

#### Field names

Read from the live base on 2026-09-14; all seven tables are identical.

```
What · Raised By · Date Raised · Source Link · Status ·
Assignee Slack User ID · loop_id · lane_tag · raised_in · last_modified
```

The lane field is **`lane_tag`**, not `Lane`. `last_modified` is a formula
(`LAST_MODIFIED_TIME()`) and is never written. Every name is Airtable's own and
none is translated — n8n writes these names and a rename breaks its writes with
no error.

#### When it does not land

Every write is logged to `loop_writebacks`, append-only: the loop, what changed,
the source and destination table on a move, the steps that completed, and the
outcome. The newest line per loop drives the page.

A loop whose newest write failed, or left it in two tables, is marked in the
status column (*not in Airtable* / *in two tables*), counted in a banner above
the table with the reasons, and carries the full reason and the completed steps
in its panel. A loop this dashboard calls closed while Airtable still says open
never looks cleanly closed.

Loops opened in the dashboard are skipped rather than sent: Airtable has no row
for them until the engine writes one and pushes it back. Recorded as a skip with
its reason, not as a failure.

### Codex entries — three stages, edits and delete

Same pattern as the loops work: Postgres first, then Airtable, directly, with a
failure recorded on the row and shown there. `AIRTABLE_TOKEN` again, on
`AIRTABLE_SUBMISSIONS_BASE_ID` (BHA Submissions, `appEmdKshNVTl64Zf`).

#### The three stages

A log is at exactly one, one per step. **The steps are named, not numbered**
(2026-09-14, Destiny): "Layer 0" told a reader nothing. The Airtable fields keep
their own names, and the page still quotes those wherever it states a rule.

| Stage | Step | Rule |
|---|---|---|
| Approved | builder codex | not flagged, and `Jason Status` is Approved **or Input Added** |
| Awaiting approval | pending review | not flagged, and `Jason Status` is Pending or empty |
| Needs input | completeness check | `Layer0 Flagged` is ticked |

**`Layer0 Flagged` wins.** A flagged log needs input whatever Jason Status says,
because that check runs first. That one rule is what makes the three exclusive
and what makes them sum to the submission count — the four tabs before this
asked a review question and a gate question in the same row, so "Complete"
overlapped "Approved" and the counts did not add up.

**Approved first, and no All tab** (2026-09-14, Destiny). Almost every log ends
up approved, so that is where the page opens. A fourth tab that was the sum of
the other three earned nothing; the three counts are printed together on the
card above the list, which is where the sum belongs. One consequence: the search
box filters inside the selected stage.

**"Input Added" counts as approved** (2026-09-14, Destiny). Jason adding input
means he has read the log and responded. It sat at Awaiting approval until then,
which put fourteen logs he had already answered in the queue of ones he had not
reached.

**The rules are not printed under the tabs.** The tab label carries the meaning;
they live in CLAUDE.md §4, as spec rather than caption.

There is no "Input added" stage. Jason adding input happens while a log sits at
Awaiting approval — he either approves or asks, and the builder answers in
thread — so those logs stay there, with a small "input added" tag on the row.

#### Field names

Read from the live base on 2026-09-14; all six builder tables carry the same 23:

```
Submission ID · Timestamp · Builder Name · Builder User ID · Builder Channel ID ·
Sheet Name · Session Url · Session Description · Summary · Transcript ·
Narration Quality · Session Type · `Layer1 Review ` · Jason Status ·
Jason Notes · Processed At · Orchestrator Layer2 Review · Builder Channel Post ·
Submission Source · Processed Date · Layer0 Flagged · Layer0 Missing ·
Codex Entry ID
```

`Layer1 Review ` ends in a space, in all six. `Session Url` is spelled that way
here and `Session URL` in the Layer 0 table, which has a different schema
entirely. `Jason Status` is a single select of exactly three — Approved,
Pending, Input Added — and this dashboard writes only the first two; Input Added
is the pipeline's.

#### The Layer 0 parking table

`tbljoWu73vsxyL6vc`, a different table with a different schema: no Jason Status,
no Layer 2 review, no Codex Entry ID. It holds submissions that never reached a
builder table. **Its rows are not in the stage counts** and the page says so
rather than leaving it to be inferred.

#### Delete

For production testing: driving a log through Layer 0, Layer 1 and approval
deliberately, then clearing the fixtures. It removes the Airtable row and the
Postgres row, and is confirmed by typing the Codex entry id back rather than by
a yes/no dialog — mid-test there are several near-identical rows on screen and
the id is the only thing that tells them apart. The whole record goes to
`record_deletions` first: once both sides have let go, that log is the only
place it can be read. There is no add; entries are created through Slack.

#### Rows deleted in Airtable

A row deleted by hand in Airtable notifies nothing, so the Codex page reconciles
on load: one pass over the record ids of the six builder tables and the Layer 0
table — ids only, a few kilobytes — removing any row here that Airtable no
longer has, and logging what went.

**A failed fetch is never read as an emptied table.** A table whose read fails
is left out entirely, nothing under it is touched, and the page names it. With
Airtable unreachable the page renders from Postgres and removes nothing.

**It says what Airtable said — in the log.** A pass that could read nothing used
to print "no submission table could be read" and stop, with the reason sitting
unread and nothing in the logs. It now carries Airtable's own message, commonest
reason first and bounded at two. **It says nothing on the page** (2026-09-14,
Destiny): a standing amber line about a background check, on a page whose rows
were never in doubt, is a banner nobody can act on either.

**There is no ids-only read.** This asked for `fields[]=` with no field named,
on the belief that an empty list meant "none of them". Airtable reads it as a
request for a field called `""` and refuses the whole request — which is how all
seven tables came to answer `Unknown field name: ""` and read as a permissions
problem. It asks for `Submission ID` now, the one spelling present in all seven
tables. The replay used for testing implemented the assumption rather than
Airtable's behaviour, so every test passed against a stand-in that shared the
bug; it refuses an empty field name now, exactly as Airtable does.

#### Resync from Airtable

The reconciliation only ever removed rows, so this dashboard's copy could only
fall behind: a log approved in Airtable stayed *awaiting approval* here, and one
created without the engine pushing it never arrived. A button on the Codex page
reads all seven tables whole and makes Postgres match — inserting what Airtable
has and we do not, updating what changed there, deleting what is gone.

**Airtable wins every disagreement.** It owns these fields; this dashboard does
not get to keep a value it contradicts. The one case that is never silent is a
row whose own change never reached Airtable — approved here while Airtable
refused the write. Reverting it is correct, and it is counted and named, in the
result panel and in the log.

Rows go in through `mirror.upsert` with `source = 'airtable'`, and the status
change is dated `via = 'mirror'`: this database learned of it when it looked and
has no idea when it happened. A table that cannot be read changes nothing under
it and is named with its reason. **Manual only** — not on load, not scheduled.
The log carries the whole outcome, per table and in total, including what both
sides hold afterwards, so "do they agree now" is answerable from the log alone.

**And it is bounded.** Seven reads at the client's fifteen-second write timeout
is a page that can hang for a minute and a half doing housekeeping; one load
took twenty-two seconds before this. A reconciliation read gets five seconds,
the whole pass gets eight, and tables the budget did not reach are named as
not reached rather than counted as failed — they are checked next time. A pass
is held for two minutes (twenty seconds if it failed, since that is the state
someone is trying to clear), and a delete made here drops it immediately.

#### Resync on Build patterns, Commercial and Clients

The same button, the same semantics and the same toast, on the other three
record pages (2026-09-15, Destiny). It is one shared pass — `store.resync`,
`POST /api/{patterns|commercial|clients}/resync` — and one shared control,
`components/ui/Resync.tsx`, which the Codex page now uses too, so the four pages
cannot word the same outcome differently.

| Page | Base | Reads |
|---|---|---|
| Build patterns | `app5ni3E8r7Lvxk22` | `tblaMXSMjmz30OvcU`, one shared table |
| Commercial | `appvLglfdCqOKqLpT` | `tblyXShZLOFT3jNMe`, one shared table |
| Clients | `appkSUSh9ijNjP2f8` | the `Index` (`tblFJ1yuYcuanjPdn`), then the table each index row names in `Table ID` |

Build patterns and Commercial are a single shared table each, not one per
builder, so their sweep is one read. **Clients follows the index and only the
index**: a questions table that no index row names is an orphan, is being
deleted upstream, and is never read — and any question row this database still
holds against one is removed and logged, but only once the index has actually
been read, since without that the first refusal would empty the whole kind.

Two things the pass says that the Codex one did not, and which it now says too:
a row Airtable handed over that this database **refused** is counted rather than
only logged — read five rows and store none is not the same as five already
matching — and a change made here that Airtable never had is named when it is
reverted, found through the mirror row's own `source = 'ui'` rather than through
`record_writes`, which only loops and Codex write to.

### Monthly tracking

Every record page carries the same three components in the same order: the
month currently in view as figures, a month-over-month chart, and a CSV export
of exactly the rows on screen. Clicking a month filters the page's list to it;
the export follows that selection and every other filter, and carries the
record's natural key so a row can be traced back to Airtable.

**The chart is the part that can lie by omission, and its whole shape is that
risk.** Several of the date fields only started being written recently, and a
month drawn as a low bar because the data did not exist yet reads as a quiet
month rather than a gap in instrumentation. So every month carries its own
coverage — separately for what was created and for what advanced, because they
are usually instrumented from different dates:

| coverage | drawn as |
|---|---|
| full | a solid bar |
| partial | a hatched bar, and "part" under the label |
| none | **no bar at all** — a dashed boundary rule, "none" under the label, and a sentence saying what began when |

The boundaries, each a fact about the engine rather than a rendering choice:

| Page | Created | Advanced | Boundary |
|---|---|---|---|
| Open loops | `Date Raised`, full history | `Status` → Closed | **Closes are dated only by this dashboard's status ledger** (`meta.history_since`). The loop tables carry no close date and nothing upstream keeps a status-change history, so before that month there is no closed figure — not a zero |
| Codex | `Timestamp` | `Jason Status` → Approved or Input Added | The approval **rate** is honest for the whole history: it counts a cohort's state today, not a dated event. **Median days to approval is not** — `Jason Reviewed At` was created on 14 Sep 2026 with no backfill, so Sep 2026 is partial and **Oct 2026 is the first honest month**. It is drawn as its own panel with its own boundary |
| Build patterns | `created_at` | none — patterns do not close, so there is no rate | Sep 2026 is partial: the extractor received empty payloads until the upstream fix on 15 Sep |
| Commercial | `created_at` | `missing_research_count` = 0, as a cohort | Sep 2026 is partial: card creation stopped on 9 Sep and was not fixed until the 15th |
| Clients | per-question `Last Updated` | `Movement Tag` is new, refined or contradicted | None. `Last Updated` has always been written correctly; the index's own `Last Run At` was frozen at 24 Aug because nothing wrote it back, so it is deliberately not the source |

Two further rules the builder applies everywhere. **A record with no usable date
is counted as undated, by name** — never dropped, never re-bucketed into the
earliest month. And **a month whose rows mostly arrived later is marked
partial**: Build Patterns holds 152 rows, most of them written to Airtable in
one go on 12 Aug 2026 carrying `created_at` values spread back through July.
Those dates are real and belong on the chart, but a bar of a hundred backdated
rows is not a hundred patterns' worth of output that month.

### Execution tracking

**One Executions page**, under RECORDS, tabbed by system exactly as the System
registry is tabbed: **All systems · Bays · North Star · Research Twin ·
Unregistered**, plus a tab for any other system the registry has filed a running
workflow under. Each tab shows, for the period in view, total executions,
successes, failures, failure rate, average execution time, a per-workflow
breakdown, and every individual execution behind it.

**Weekly, monthly and yearly**, from the same rows. Selecting a period on the
chart moves every figure, the workflow table, the comparison and the export with
it.

#### One row per execution, not a counter

`engine_execution_runs` holds one row per n8n execution, keyed on **n8n's own
execution id**: workflow, status, mode, start, end and duration. Every figure on
the page is a `GROUP BY` over those rows.

This replaced two counter tables on 15 Sep 2026, and it replaced them because
the counters were the fault rather than the arithmetic. The live page shipped
that morning was wrong three ways at once:

- every per-workflow figure was an exact multiple of 60 — 5820, 1620, 1500 —
  and the headline read 11,760 where n8n held 196 for the week;
- failures read **0** when n8n held 51;
- **7 workflows of 31** appeared, and the North Star tab was empty.

One bug caused all three. The reader paged with `lastId`, which the n8n public
API does not accept and silently ignores — it pages on an opaque `cursor` — so
each of its sixty pages was the same newest 200 executions, counted again every
time. 196 × 60 = 11,760; the failures were all older than those 200; so were 24
of the workflows. A counter cannot notice it is being told the same execution
twice.

Keyed on the execution id, none of that is expressible. Re-reading a page is an
upsert that changes nothing, so **the backfill is safe to run at any time**, and
a failure is a row whose status says `error` or `crashed` or it is not there.
The reader also now proves it is moving: a page that does not come back older
than the one before it stops the walk and is reported, loudly, rather than
followed.

Volume is not a concern — roughly 1,300 executions a day, about 40k rows a
month. `engine_execution_days` and `engine_executions` are left in place and
unread, like the `records` read model; nothing here drops a table.

#### Why the rows are copied here at all

Not because n8n discards them. This repo asserted that on 15 Sep — "about three
days and then discards it" — and it was never verified. The instance's history
begins on 12 Sep 2026 because that is when it was migrated, and no execution has
been observed ageing off.

The reason is simpler and does not depend on a retention policy nobody has
confirmed: a record of the engine's history should not be at the mercy of what
another system decides to keep, and a period cannot be grouped, drilled into or
exported from an API that only answers about recent runs. What is copied here
stays here. The page says what this database holds and from when, and claims
nothing about n8n's retention.

#### A poll, and it says so

n8n has no webhook for a finished execution, so the server asks every **45
seconds** for what is above the highest id it holds, and the page re-reads on
the same interval. It is never described as live, in the subtitle or anywhere
else.

The alternative — a reporting node added to each workflow — was rejected: a
workflow somebody forgets to instrument becomes a silent gap, which is the
failure this dashboard exists to remove. Nothing in this server can write to
n8n in any case.

An execution read while it is still running is stored with that status and read
again by id until it finishes. The row is its own to-do list, so there is no
second list of ids to keep in step with it, and an execution n8n no longer holds
is marked `unknown` rather than guessed at.

#### Per workflow, and per execution

Clicking a workflow opens its own view for the period: its executions day by
day, and then the runs themselves — id, start time, duration, how it ran, how it
ended — with failures called out and each id opening in n8n. This is the
capability the counter tables could not support at all.

#### The period in words, and the report

Above the figures, the comparison in prose: "executions up 12%, failures down
40%, average run time 3% faster". Written on the server so the page and the
downloaded report cannot word the same comparison differently.

The report downloads per week, per month or per year and carries the figures on
screen, the per-workflow breakdown and every period held. Because a report is
kept after the page is closed, every caveat is inside the file: the coverage of
the period, the comparison in full, and the refusal where there is nothing
honest to compare against. A period with no coverage carries blank cells, never
zeros.

The honesty rules are unchanged and matter more in prose, which reads as
authoritative:

- **A running period is cut to the same elapsed point.** Three days into a
  month, against the previous month's first three days.
- **A comparison whose window predates everything held is refused, by name.**
  Not "0 → 890" — instead, that those days were not quiet, they were not
  recorded.
- **A change from nought prints both figures**, because a ratio against nought
  has no meaning.

#### Systems, and nothing invisible

A workflow's system comes from the **workflow registry, by join at read time**,
so pointing a workflow at a system is a registry edit that re-files its whole
history rather than only its future — a row, not a deploy. A workflow no
registry row claims is counted in All systems and listed under **Unregistered**;
one filed under a system with no tab of its own gets a tab. The tabs sum to All
systems exactly, which is how you can see that nothing has been dropped.

**Engine health keeps a roll-up only**: one figure per system for the current
week and a link through. It answers "is something failing somewhere"; the
Executions page answers "what, and which".

### The MCP server — how an external Claude client reads this app

**Built 18 September 2026, on Destiny's instruction.** An MCP server mounted on
this same service at `/mcp/<MCP_SECRET>`, over streamable HTTP.

It exists because this dashboard is client-rendered: fetching
`https://dashboard.bhanetwork.org` returns an empty shell, so a Claude client
asked "on this page I can't do X" or "this panel should show Y" had no way to
see the app at all. These tools give it the app's **structure** — routes, pages,
panels, which data feeds which panel — and its **live data**. Structure is the
larger half, deliberately, because it is what makes a page you cannot see
reasonable about.

**Mounted, not a second service.** It hangs off the same `createServer` handler
as `/api`, ahead of it, so it deploys with the same commit and runs in the same
process against the same Postgres. Nothing about any existing route, page or
behaviour changed.

**No new dependency.** CLAUDE.md caps this server's dependencies at `pg` and
says the cap is the ceiling rather than a precedent, so the MCP SDK is not
here. Streamable HTTP is JSON-RPC 2.0 over a POST; the transport is
`server/src/mcp/index.ts` and it answers with a single JSON object, or with one
SSE frame when the client's `Accept` asks for an event stream, because clients
differ about which they send.

**Read only, with no write path.** There is no write tool in v1 and no code
path from a tool to a write — not a guarded one, none. `get_page_data` reads
through an in-process GET against this server's own `/api` router, which is how
it cannot drift from what the page shows; that loopback is GET-only and refuses
`/api/engine/*` and `/api/inbound/*` by name.

**The secret is a path segment and a miss is a 404.** `MCP_SECRET`, no default.
Anything that is not exactly `/mcp/<MCP_SECRET>` — a wrong secret, a deeper
path, or every request when the variable is unset — gets the same 404 an unknown
route gets. Not a 401: a 401 tells a stranger the endpoint is there and that
they need a credential.

| Tool | What it answers |
|---|---|
| `list_pages` | Every route: path, title, the file that implements it, and a one-line description of what it is for |
| `get_page_structure` | One page's panel layout in order — each component, where it is declared, the props that change what it shows, and the data expressions those props name |
| `get_component` | The full source of one named component, with the doc comment above it |
| `search_source` | Grep across the repo, with file, line and surrounding context, paged |
| `list_data_sources` | Every external source — Airtable base and table, BHARAG per lane, the two n8n endpoints, Postgres — with its credential, whether that credential is set, its `engine_*` table and which pages consume it |
| `get_page_data` | What a page would render right now, as JSON, read through the app's own routes |
| `get_health` | The deployed commit and branch, uptime, and a live probe of every data source |

**Nothing is a hand-written list.** The routes come out of `src/App.tsx`, the
sidebar labels out of `src/components/Layout.tsx`, a page's title and purpose
out of its own `PageHeader` (falling back to that page's section in
`CLAUDE.md`), a page's panels out of a scan of that page's own JSX, its data
routes out of `src/data/index.ts`, and the sources out of `sources.ts` and
`mirror.ts` as the process holds them. A map of the interface typed by hand
would be right on the day it was written and wrong by the next commit, and a
reader acting on it could not tell.

**Two rules run through every tool.** A tool that cannot answer returns an
explicit error naming what was looked for and where — `get_component` on a name
declared in two files fails and names both rather than picking, because a wrong
answer about structure gets acted on. And nothing is cut silently: every capped
answer says what the cap was and how to ask for the rest, and a payload past the
size cap comes back as its *shape* rather than as a sample, because a fragment
read as the whole is the mistake worth avoiding.

Every call is logged with its name and arguments: `[mcp] get_page_structure
{"path":"/engine-health"} — ok in 34ms, 51204 bytes`.

### The migration backfill

Gone, with the Airtable client it read through (13 September 2026).
`npm run backfill` and `POST /api/engine/backfill` no longer exist; the endpoint
answers 410. It ran on 13 September 2026 and brought 1,425 rows across from
Airtable; those rows are in `git log` if it is ever needed again.

### Environment

| Variable | Purpose |
|---|---|
| `AUTH_EMAIL`, `AUTH_PASSWORD_HASH` | The shared login (`npm run hash-password`) |
| `SESSION_SECRET` | Signs the session cookie |
| `ASK_BAYS_API_KEY`, `ASK_BAYS_URL` | The Ask Bays workflow |
| `DASHBOARD_INBOUND_KEY` | Authenticates the engine’s writes to `/api/engine/*` and `/api/inbound/*`. **Required** in practice — nothing can reach the record tables without it |
| `AIRTABLE_TOKEN` | Read **and** write on Open Loops and BHA Submissions, for loop and Codex edits; read on Build Patterns (`app5ni3E8r7Lvxk22`), Commercial Opportunities (`appvLglfdCqOKqLpT`) and BHA Client Research Loop (`appkSUSh9ijNjP2f8`), for the resync those three pages gained on 15 Sep. Five bases, one token; nothing is ever written to the last three. Without it nothing edited here reaches Airtable and no page can resync; the server says so at boot and on every write. **Note the name** — the client deleted on 13 Sep read `AIRTABLE_API_KEY` |
| `AIRTABLE_OPEN_LOOPS_BASE_ID` | The Open Loops base (`appUVlBSGGPHw6DGh`). **No default** — unset, the boot line says so by name and every loop edit is refused and marked. Called `AIRTABLE_BASE_ID` until 14 Sep 2026; that name is read by nothing |
| `AIRTABLE_SUBMISSIONS_BASE_ID` | BHA Submissions, for Codex entries. Defaults to `appEmdKshNVTl64Zf` |
| `N8N_API_KEY` | The n8n **instance API key**, for the Executions page. Read only — two endpoints, `GET /api/v1/executions` and `GET /api/v1/workflows` (names only, so a workflow with no registry row still appears under its own name). Not the same credential as `ASK_BAYS_API_KEY`, which is a webhook header. Without it no execution is ever read and the page says so rather than reading zero |
| `N8N_API_URL` | Defaults to `N8N_BASE_URL` + `/api/v1`. Points the same client at a replay in a sandbox |
| `AIRTABLE_API_URL` | Points the same client at a local replay of the API in a sandbox |
| `DATABASE_URL` | Postgres. **Required** — the server exits if it is missing or unreachable |
| `MCP_SECRET` | The path secret for the MCP server at `/mcp/<MCP_SECRET>` (18 Sep 2026). **No default** — unset, every request under `/mcp` gets a 404 and the boot line names the variable. A wrong secret gets the same 404 a wrong route gets, so the endpoint is not discoverable |

Auth is a single shared team login, matching the pattern used by BHARAG's admin
console. No per-user accounts.

**Counts on the records pages are computed by the server from raw rows**, not
handed over finished by the engine. Decision made 2026-09-08: nothing upstream
keeps a status-change history, so the server records one (an events table, a
daily snapshot per kind, and the date history began) and derives "this week
versus last", "open versus closed" and "median days raised to closed" from
it. A metric the data cannot support is returned null with a note saying what
is missing, and the note is what the page shows.

## Sections

| Section | Purpose |
|---|---|
| Overview | Headline numbers, what broke and what moved in 24h |
| Ask Bays | Chat interface onto the Bays agent |
| North Star | Every ask in its own ledger: delivery rate first, then outcome, response p50/p95, and a statistics tab covering who is asking, tool usage, citation coverage and claimed priority by lane |
| Research Twin | Asks, research jobs and statistics. "Went outside BHA" leads the asks; capped jobs lead the queue |
| vFarm | Placeholder — nothing on the rack writes here yet |
| Engine health | Incidents, retries and self-healing across the three lanes, tabbed All systems · Bays · North Star · Research Twin · Retries. Each lane needs its own BHARAG credential, and a lane that was not read is never drawn as health |
| Open loops | Loops by age and owner, close from the interface |
| Codex entries | Session logs by builder and week |
| Build patterns | Every pattern, by reusability. No `pattern_status` — the field was deleted from the base on 15 Sep |
| Commercial | One sortable table of opportunity cards, closest to ready first. Nothing on it groups the corpus: every candidate axis is constant or 1:1 with the card |
| Clients | Watched client lanes grouped under the client that owns them, ordered by `Client ID` |
| Executions | Every execution of every workflow, one row each, tabbed by system, weekly / monthly / yearly, against the period before, with a per-workflow drill-down and a downloadable report |
| Pay Tracker | Who is owed, for what work, and what has been paid. Owed groups by builder with monthly and daily kept apart; statements show their evidence whole. Counts work, never money — there are no rates in the system — and is read-only |
| System registry | Builders, Tools, Endpoint, Workflow, and the engine-writes surface |

## Repo layout

```
src/
  main.tsx            Entry point. Router + session provider.
  App.tsx             Route table. The login gate sits in front of everything.
  index.css           Design tokens for both themes, base styles, component classes.

  app/                Application-wide state.
    session.tsx       Shared team login (token, expiry, bearer) and the global lane filter.
    theme.tsx         Light / dark / system, stamped on <html data-theme>.
    useData.ts        Calls a data function with the current lane; owns loading and failure.

  data/               The one swap point. Nothing else knows where data comes from.
    types.ts          The contract. Shapes the engine endpoint must return.
    engine.ts         The HTTP client: env config, bearer, timeouts, error shape.
    index.ts          One async function per section, plus the write paths. Phase 2 changes these bodies only.
    fixtures/         Phase 1 mock rows, one file per domain. Deleted in phase 2.

  lib/                Pure helpers. No React, no data access.
    format.ts         Display formatting and the age colour scale.
    health.ts         Health-to-class mapping. Healthy returns no colour.
    actions.ts        act() — the single row-action handler.
    cx.ts             Class-name join.

  components/
    Layout.tsx        Sidebar, status strip, theme toggle, content outlet.
    ui/               Shared primitives (cards, stats, tabs, tables, tags, inline SVG charts, icons).

  screens/            One screen per route. Screens with sub-views get a folder.
    Overview.tsx      Flat file — small enough to read in one sitting.
    OpenLoops/        Loops, ReviewQueue, Reconciliation + index.
    Twin/             Summary, Records, Runs, Gaps + index. Serves North Star and Research Twin.
    VFarm/            index only — the page is a placeholder.
    EngineHealth/     index only — the execution roll-up; incidents are still a placeholder.
    Executions/       index only — every workflow execution, tabbed by system, by week / month / year.
    Registry/         The four registries, the engine-writes tab, and Editable.
```

server/
  src/
    index.ts          The HTTP server: /api routes, cookie guard, static dist/.
    auth.ts           Credential check (scrypt), signed HttpOnly session cookie, lockout.
    ask.ts            Proxy to the Bays workflow; attaches the API key server-side.
    engine.ts         Every read, derived from fixtures and the store.
    store.ts          Records with status, the events/observation history, and metrics.
    executions.ts     The 45s poll into engine_execution_runs, and the page's periods, comparisons and drill-down.
    n8n.ts            Read-only n8n client — GET /api/v1/executions and /workflows, paged on cursor.
    pg.ts             The connection pool, TLS, and the startup check that refuses to serve without it.
    migrations.ts     Forward-only numbered migrations, run on boot under an advisory lock.
    db.ts             The meta key/value state and the date helpers.
    hash.ts           `npm run hash-password`.
    mcp/              The MCP server, mounted at /mcp/<MCP_SECRET>. Read-only.
      index.ts        Streamable-HTTP transport: JSON-RPC over POST, the secret check, the 404 on a miss.
      tools.ts        The seven tools and their schemas. No write tool, and no path to one.
      structure.ts    Routes, pages, panels and sources, all derived from source at runtime.
      jsx.ts          The TSX scanner behind get_page_structure.
      source.ts       Repo-relative reads, the file walk, the glob and the grep.
tsconfig.server.json  Compiles server/ plus src/data/{types,fixtures} to server-dist/.
render.yaml           Render blueprint: one web service, one Postgres instance.
.env.example          Every server variable, documented.

### Where to make each kind of change

| To change | Go to |
|---|---|
| Where data comes from | `src/data/index.ts` — only this file |
| The shape the engine must return | `src/data/types.ts` |
| Mock values | `src/data/fixtures/<domain>.ts` |
| A colour, spacing or font | `src/index.css` — tokens for both themes, not per-component classes |
| What a screen shows | `src/screens/<Screen>/` |
| A table cell, tag, dot or row action used on several screens | `src/components/ui/` |
| Sidebar groups, status strip, lane filter | `src/components/Layout.tsx` |
| Formatting or the age colour scale | `src/lib/` |
| A new route | `src/App.tsx` and the sidebar list in `Layout.tsx` |

## Local development

Two processes: Vite for the front end (with `/api` proxied), and the server.

```bash
npm install
cp .env.example .env            # then set AUTH_PASSWORD_HASH or AUTH_PASSWORD
set -a; . ./.env; set +a         # or export the variables another way
npm run dev:server               # builds and starts the server on :8787
npm run dev                      # Vite on :5173, proxying /api to :8787
```

To produce the credential hash:

```bash
npm run hash-password -- 'the password'
```

To run the production shape locally (server serving `dist/`):

```bash
npm run build && npm start
```

Other scripts: `npm run typecheck` checks both the front end and the server.

## Environment variables

All read by the server. Set in the host's environment settings, never
committed. `.env.example` lists them with comments. Nothing prefixed `VITE_`
is used any more: the bundle contains no configuration and no secrets.

| Variable | Purpose |
|---|---|
| `AUTH_EMAIL` | The shared team email. Defaults to `admin@bhanetwork.org`. |
| `AUTH_PASSWORD_HASH` | scrypt hash of the shared password, from `npm run hash-password`. Rotate the password by replacing this. |
| `AUTH_PASSWORD` | Plain-text alternative for local development. Ignored when the hash is set. Without either, sign-in returns 503 and says so. |
| `SESSION_SECRET` | Signs the session cookie. When unset a random key is generated at boot, so every session ends on restart. Render's blueprint generates one. |
| `ASK_BAYS_URL` | The Bays agent workflow. Defaults to `https://bayshorizonnetwork.app.n8n.cloud/webhook/dashboard-ask-bays`. The boot log says whether the URL came from this variable or from that built-in default. |
| `N8N_BASE_URL` | Base for the "view execution" links on fixture-backed rows. Defaults to `https://bayshorizonnetwork.app.n8n.cloud`. Execution ids predating the move off `n8n.arupiautomates.cloud` do not exist on the company instance and will 404. |
| `ASK_BAYS_API_KEY` | Sent as `x-api-key` on every call to that workflow. Without it Ask Bays replies that it is not connected. |
| `ASK_BAYS_MODEL_LABEL` | Shown under the composer. Defaults to `Claude Sonnet 5.0`. |
| `DATABASE_URL` | Postgres connection string. **Required**: with it missing, or the database unreachable, the server prints why and exits 1 rather than starting on a store that cannot keep anything. On Render use the *internal* URL — a single-label host (`dpg-…-a`) that carries no TLS and resolves only from a service in the same region. |
| `DATABASE_CA_CERT` | PEM of the CA for a TLS connection, when using an external Postgres URL. Without it TLS is still used but the certificate is not verified, and the server says so at boot. |
| `DATABASE_POOL_MAX` | Pool size. Defaults to 8. |
| `PORT` | Listen port. Render sets it. Defaults to `8787`. |
| `MCP_SECRET` | The path secret for the MCP server. The endpoint is `/mcp/<MCP_SECRET>` on this same service, read-only, over streamable HTTP. **No default**: unset, `/mcp/*` answers 404 to everything and the boot line says so by name. It also goes into the Claude connector URL, which is why it is `sync: false` in the blueprint rather than a generated value. |

### Contracts

**Sign-in.** `POST /api/auth/login` with `{ "email", "password" }`. The server
compares the email in constant time and the password against the scrypt hash,
then sets `bha_session`: an HMAC-signed, HttpOnly, SameSite=Lax cookie (Secure
in production) that expires twelve hours out. `401` is a wrong pair; `429` is
the lockout (five failures from one address pause it for thirty seconds; fifty
failures from anywhere inside a minute pause everyone); `503` means no
credential is configured. `GET /api/auth/session` says whether the cookie is
live; `POST /api/auth/logout` revokes it. Every other `/api` route answers
`401` without a valid cookie, and the front end returns to sign-in on any
`401`.

**Ask Bays.** The browser posts `{ message, session_id, builder_id }` to
`POST /api/ask`. The server forwards the same body to `ASK_BAYS_URL` with the
`x-api-key` header and waits up to two minutes. The workflow answers
`{ ok, answer, session_id, steps }`; the server normalises that and returns
it. `session_id` is fixed for the life of a thread and is what gives Bays its
memory of the conversation. When `ok` is false, `answer` explains why and is
shown as the reply. `steps` is the agent's own trace, shown under the answer;
when empty nothing is shown, because the agent answered without looking
anything up. The agent can answer questions about engine state and create,
update or close loops, nothing else.

**Records.** `GET /api/records/:kind/metrics?lane=&builder=` returns the
counts strip for `loops`, `codex`, `patterns` or `commercial`.
`PATCH /api/records/:kind/:id` with `{ status, note? }` changes a status and
records the change; `POST /api/records/loops` opens a loop. Status
vocabularies: loops `open · in progress · closed`; codex `posted · ingested ·
archived`; patterns `active · retired`; commercial `idea · researching ·
evidence thin · ready to pitch · blocked · closed`.

**Reads.** `GET /api/{overview, engine-status, north-star, research-twin,
vfarm, engine-health, open-loops, codex, build-patterns, commercial, builders,
builders/:id, ask-bays}?lane=` return the shapes in `src/data/types.ts`.
`GET /api/executions?grain={week|month|year}&period=` returns the Executions
page — every system, every period held, and the selected period's workflows and
comparison. `GET /api/executions/workflow/:id` returns one workflow's days and
its individual runs. `POST /api/executions/backfill` reads n8n's whole history
again; it is idempotent, because every row is keyed on the execution id.
`GET /api/status` reports what is configured, without values.

## Deployment

One Render **web service** (not a static site), from `render.yaml` in this
repository. Pushes to the default branch deploy.

| Setting | Value |
|---|---|
| Runtime | Node 22.22 |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check | `/api/health` |
| Database | `bha-engine-db` (Postgres 18), `DATABASE_URL` from its internal connection string |

Set `AUTH_PASSWORD_HASH` and `ASK_BAYS_API_KEY` in the service's environment
by hand; the blueprint marks them `sync: false`. `SESSION_SECRET` is generated
by the blueprint. No disk is mounted: state is in Postgres.

`DATABASE_URL` is the one variable the service cannot start without. A deploy
with it missing, or pointing at a database this service cannot reach, fails in
the log with the reason and the fix rather than booting into a degraded mode.
Migrations run on boot and are idempotent, so a deploy that changes nothing
about the schema applies nothing.

The server serves `index.html` for any path that is not a file in `dist/`, so
deep links and refreshes work without a rewrite rule. Hashed assets are sent
with a one-year cache header; everything else is `no-cache` or short-lived.

## Working in this repo

Read `CLAUDE.md` before making changes — it holds the full spec, design rules and
per-section content requirements.

`BUILD_LOG.md` is a running record of build work and is the source material for
BHA session narrations. Append to it; never rewrite it.

## Owner

Destiny Arupi — Engine Steward, BHA.
