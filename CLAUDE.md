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
commercial `appvLglfdCqOKqLpT`. Telemetry (decision 2026-09-10, Destiny): North
Star's ask log `appkCTjhH8PtYRFI7 / tbl9OGZTyvBKrbeFm`; Research Twin's queue
`appud969Dw7H4tMwv / tblUl8YHhQReDgq8G` (the `research_twin_research_jobs`
table in that base holds one test row and is never read); the watched clients
`appkSUSh9ijNjP2f8`, whose index row names its own questions table in
`Table ID` — carried on each question row, never hardcoded.
The twins are still phase 1 fixtures. The incident and vFarm fixtures are read
only by the Overview's two 24-hour columns now; their own pages are placeholders
and the Builders page is gone (2026-09-14, Destiny).

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
  index and then the table each index row names in `Table ID`; **a questions
  table no index row names is never read**, and a question row held against one
  is removed — but only once the index itself has been read, because without
  that guard the first refusal would empty the whole kind. Two things every
  resync now says: a row Airtable handed over that this database **refused** is
  counted rather than only logged, since reading five rows and storing none is
  not the same as five already matching; and a change made here that Airtable
  never had is named when it is reverted, found through the mirror row's own
  `source = 'ui'`, because only loops and Codex write to `record_writes`.
- **The token reads five bases and writes two.** `AIRTABLE_TOKEN` needs read and
  write on Open Loops and BHA Submissions as before, and **read only** on Build
  Patterns, Commercial Opportunities and BHA Client Research Loop for the three
  resyncs. Those three get **no base variable of their own**: this server never
  writes to them, so it can never write to a guess, and their ids stay in
  `sources.ts` where the record links already read them.
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

**Environment (all server-side, none in the bundle):** `AUTH_EMAIL`,
`AUTH_PASSWORD_HASH`, `SESSION_SECRET`, `ASK_BAYS_API_KEY`, `ASK_BAYS_URL`,
`DASHBOARD_INBOUND_KEY` (nothing reaches the record tables without it),
`AIRTABLE_TOKEN`, `AIRTABLE_OPEN_LOOPS_BASE_ID` (Open Loops) and
`AIRTABLE_SUBMISSIONS_BASE_ID` (BHA Submissions) — one token: read and write on
those two bases for loop and Codex edits, and read only on Build Patterns,
Commercial Opportunities and BHA Client Research Loop for the three resyncs,
which have no base variable because nothing is ever written to them. Without the
token nothing edited here reaches Airtable and no page can resync, and the
server says so at boot and on every write — and `DATABASE_URL`, the one the
server refuses to start without.
`DATABASE_CA_CERT`, `DATABASE_POOL_MAX` and `AIRTABLE_API_URL` are optional.
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
  vFarm                  ← placeholder
  Engine health          ← placeholder, no badge

RECORDS
  Open loops
  Codex entries
  Build patterns
  Commercial
  Clients

REFERENCE
  System registry
```

**There is no People section** (decision 2026-09-14, Destiny). Builders was its
only item and almost everything on that page was a fixture; the roster and the
two figures that were real are the **Builders** registry now. The Overview's
Builders tile went with it, per the tile-per-section rule.

North Star, Research Twin and vFarm each have four in-page sub-tabs:
**Summary · Records · Runs · Gaps**. Sub-tabs live inside the page, not as
sidebar dropdowns.

---

## 7. What goes on each screen

### Overview
One tile per sidebar section, each showing its headline number and its worst
current signal. Clicking a tile navigates into that section.

Pinned across the top: days to Halloween (the vFarm deadline), open loops,
entries logged this week.

**Nothing on this page counts an incident or a rack** (decision 2026-09-14,
Destiny). The vFarm-status and open-incidents pins, the incidents chip, the
Engine health card with its self-heal rate and its incidents by class, and the
seven-day incident count all read phase 1 fixtures, and the pages behind them
are placeholders now; a headline figure for a page that says "coming soon" is a
figure about nothing. The vFarm and Engine health tiles stay as navigation, with
a dash where the number was. The two 24-hour columns are still the phase 1
fixtures they have always been.

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
The ask log. **Thin rate is the headline** — answers that look real and cite
nothing — computed over the rows carrying an `outcome` and no others, with the
unclassified count stated beside it. `outcome` is North Star's own
single-select (answered / thin / failed) and is authoritative; a row without
one is *unclassified* and nothing is inferred from the answer text. Also: asks
per week, outcome over time, research-required rate, tool hits against cited
uses from the searches blob, citation coverage, by lane, and when it was last
asked anything — silence there is itself the signal.

### Research Twin
The research queue. It is an **attempt log** — one row per attempt, `card_id`
repeats — so every figure is per card, collapsed on `card_id` with the newest
attempt deciding the state, and the row count is printed beside the card count.
Cards at `requires_human` come first. Days stuck is counted from
`first_stuck_at`, which is deliberately not re-stamped, so it is the age of the
problem rather than of the last retry. A blank status is *untriaged*, a real
state, not an error.

### Clients
One row per watched lane, **grouped under the client that owns it** by the
index's own `Client ID`: two lanes with one id are one client with two lanes and
appear once, with the lanes nested beneath a heading row inside one table — one
set of columns, so the lanes line up down the whole page. Clients are ordered by
the **number** in the Client ID (2, 9, 12), not by its string, and the label is
"Client 9" from that id rather than a lane's full name.

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

### vFarm and Engine health
**Both are a single centred "coming soon" and nothing else** (decision
2026-09-14, Destiny). Every card, table and figure they held was computed from
phase 1 fixtures: vFarm's live readings, rack state and readiness panel, and
Engine health's incident list, state track, self-heal rate and retry counts.
Nothing on the rack and no incident has ever written a row to this dashboard, so
the pages looked like instrumentation without being any. Their fetches and their
routes are gone rather than left running behind a hidden page, and the removed
code lives in git history rather than commented out.

They keep their places in the sidebar, and Engine health keeps no badge. When
the engine starts writing these rows, what each page should show is the spec
that stood here before this entry — read it out of git.

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
