/**
 * Shapes returned by the data module.
 *
 * These are the contract. Phase 1 fills them from fixtures; phase 2 fills them
 * from the engine endpoint. Nothing outside src/data/ should care which.
 *
 * Lane and subsystem vocabularies are taken from the live engine (n8n front
 * doors and the Bays error handler's computeSubsystem), not invented here.
 */

export type Lane =
  | 'VFARM_CORE'
  | 'VFARM_MEDIA'
  | 'CLIENT_CORE'
  | 'ENGINE_INTERNAL';

export type Subsystem =
  | 'AGENT'
  | 'CODEX'
  | 'CHANNELARCHIVES'
  | 'COMMERCIALOPPS'
  | 'BUILDPATTERNS'
  | 'NORTHSTAR'
  | 'RESEARCHTWIN'
  | 'VFARM'
  | 'BHARAG';

/** The global lane filter. 'all' means unfiltered. */
export type LaneFilter = Lane | 'all';

/** Every data function takes this. Today only lane is honoured. */
export interface Query {
  lane: LaneFilter;
}

/** Health of a thing. 'ok' deliberately carries no colour in the UI. */
export type Health = 'ok' | 'degraded' | 'failing';

/**
 * The four-field spine carried on every record, per CLAUDE.md section 8. A
 * record read from Airtable carries whichever of the four its table records;
 * the rest are null and render as a dash, never as a guessed value.
 */
export interface Spine {
  session_id: string | null;
  builder_id: string | null;
  subsystem: Subsystem | null;
  lane: string | null;
}

/** Tags rendered wherever present, per CLAUDE.md section 8. */
export interface Tags {
  pay_eligible?: boolean;
  is_incident?: boolean;
  self_healed?: boolean;
}

/** Every row links back to where it came from. */
export type SourceKind = 'slack' | 'airtable' | 'n8n';

export interface Source {
  kind: SourceKind;
  /** Human-readable reference, e.g. an execution id or record id. */
  ref: string;
  url: string;
}

/* ------------------------------------------------------------------ auth */

/**
 * The signed-in state as the server reports it. The session itself is an
 * HttpOnly cookie the browser never reads; this is what GET /api/auth/session
 * says about it.
 */
export interface AuthSession {
  /** ISO timestamp the server will stop honouring the cookie. */
  expires_at: string | null;
  /** The shared account's email, for display. */
  email: string;
}

export type AuthFailure = 'missing' | 'rejected' | 'locked' | 'network' | 'not-configured';

export type SignInResult = { ok: true; session: AuthSession } | { ok: false; reason: AuthFailure; message: string };

/** What the server is connected to, from GET /api/status. No secrets, only whether each is set. */
export interface ServerStatus {
  auth_configured: boolean;
  session_secret_configured: boolean;
  ask_bays_configured: boolean;
  ask_bays_url: string;
  model_label: string;
  data_dir: string;
  history_since: string | null;
  records_held: Record<string, number>;
  started_at: string;
  /** Whether DASHBOARD_INBOUND_KEY is set, so the engine can write. */
  inbound_configured: boolean;
  /** Whether AIRTABLE_TOKEN is set, so a loop edited here can reach Airtable. */
  airtable_configured: boolean;
  /**
   * Whether AIRTABLE_WRITEBACK is on (2026-09-21). Off, a page edit is saved
   * to this dashboard's tables and not sent to Airtable — which is a statement
   * about where the record is, not a fault, so nothing coloured hangs off it.
   */
  airtable_writeback: boolean;
  /**
   * Whether AIRTABLE_RETIRED is on (2026-09-22). On, this dashboard no longer
   * reads Airtable at all: the resync and final-import buttons come off the
   * pages, their routes answer 410, and Engine health reports Airtable as
   * retired rather than probing it. Not a fault state and never coloured — it
   * is the end of the cutover, not a failure of it.
   */
  airtable_retired: boolean;
  /** The Open Loops base this server writes to. */
  /** The Open Loops base, from AIRTABLE_OPEN_LOOPS_BASE_ID. Null when that variable is not set — there is no default. */
  airtable_base: string | null;
  /** The BHA Submissions base, for Codex entries. Its own variable, not AIRTABLE_BASE_ID. */
  airtable_submissions_base: string;
  /** Loops whose newest write to Airtable failed, or left the loop in two tables. */
  writeback_failures: number;
  /** The kinds the interface can change. The rest are the engine's to write. */
  writable: RecordKind[];
  freshness: Record<RecordKind, Freshness>;
}

/* -------------------------------------------------------------- overview */

export interface OverviewPin {
  label: string;
  value: string;
  health: Health;
  /** Marks the single value that matters most on this screen. */
  accent?: boolean;
}

export interface OverviewTile {
  key: string;
  label: string;
  to: string;
  headline: string;
  sublabel: string;
  signal: string;
  health: Health;
  /** Optional trend over recent buckets, oldest first. Only where something records it. */
  trend?: number[];
  /** Optional share of a whole, e.g. ingested / total. */
  share?: { value: number; total: number; label: string };
  /**
   * Plainly labelled figures drawn under the headline (2026-09-23), each "N of
   * M" — North Star's Delivered and Answered, which the tile used to print as
   * one sentence that contradicted its own share ring.
   */
  figures?: { label: string; value: number; of: number }[];
  /** A section nothing writes to yet: drawn greyed, with no number. */
  muted?: boolean;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface OverviewSeries {
  /** Loops raised per day over the last fourteen days, from raised_at. */
  loops_raised_14d: SeriesPoint[];
  /** Codex entries per ISO week. */
  entries_by_week: SeriesPoint[];
  /**
   * Asks across both twins by outcome, read from their own ledgers since
   * 17 Sep 2026. `refused` and `needs_human` are real outcomes rather than
   * failures, so they are counted apart from both.
   */
  asks_by_outcome: { answered: number; thin: number; failed: number; refused: number; needs_human: number };
  /** How often the two twins consult each other, across both ledgers. */
  twin_handoffs: { n: number; of: number; note: string };
  /**
   * Open loops per owner, from countOpenLoops() — the same rows as the total,
   * so these always sum to it.
   */
  loops_by_owner: { owner: string; open: number; in_progress: number; oldest_days: number }[];
  /** countOpenLoops().total, for the check that the owners sum to it. */
  open_loops_total: number;
}

export interface OverviewRates {
  answered: { value: number; total: number };
  ingested: { value: number; total: number };
}

/**
 * One row in Home's 24-hour columns (2026-09-23), read from a table — never a
 * sample. `to` opens the record it is about.
 */
export interface FeedItem {
  id: string;
  /** ISO. When the thing happened, by the row's own date where it has one. */
  at: string;
  /** What kind of row this is, in words: "Incident", "Log approved", … */
  what: string;
  title: string;
  detail: string;
  /** Lane, subsystem, builder or workflow — whichever the row names. */
  where: string | null;
  /** Only where the row itself says so. */
  status: 'Recovered' | 'Needs a person' | null;
  health: Health;
  to: string | null;
}

export interface OverviewData {
  pins: OverviewPin[];
  tiles: OverviewTile[];
  broke_24h: FeedItem[];
  moved_24h: FeedItem[];
  /** The window both columns cover, so the page can say "since 13:05 yesterday". */
  feeds_window: { since: string; until: string };
  series: OverviewSeries;
  rates: OverviewRates;
}

/* -------------------------------------------------------------- ask bays */

export type ChatDelivery = 'sending' | 'sent' | 'waiting' | 'answered' | 'failed' | 'timeout';

export interface ChatMessage {
  id: string;
  /**
   * 'notice' is the app speaking, not Bays: a refused key, a timeout, a
   * reply that never arrived. It is rendered as a system line so a refusal
   * is never mistaken for something Bays said.
   */
  role: 'user' | 'bays' | 'notice';
  text: string;
  at: string;
  /** Delivery state of a user message, set while it is in flight. */
  delivery?: ChatDelivery;
  /** Why a message failed or timed out, in a sentence. */
  note?: string;
  /** What Bays looked at before answering, from the agent's own trace. */
  steps?: string[];
}

export interface ChatThread {
  id: string;
  title: string;
  updated_at: string;
  messages: ChatMessage[];
  /** The session_id sent to Bays for every message in this thread. */
  session_id?: string;
  /** Threads typed in this dashboard rather than seeded. */
  local?: boolean;
  /** Pinned threads sort first. */
  pinned?: boolean;
}

export interface AskBaysData {
  threads: ChatThread[];
  /** What the chat is connected to, as configured on the server. */
  model_label: string;
  /** False when the server has no ASK_BAYS_API_KEY; the reply then says so. */
  connected: boolean;
  /** Builders who can be named as the asker. */
  builders: { id: string; name: string }[];
}

/**
 * One reply from the Bays agent, as the server normalises it. When `ok` is
 * false `answer` explains why, and is shown as the reply. `steps` lists what
 * the agent looked at, in short phrases; empty means it answered from what it
 * already knew.
 */
export interface AskReply {
  /**
   * The workflow answers `ok: false` with HTTP 200, so this field — never the
   * status code — is what says whether Bays answered. When it is false the
   * `answer` is the gate reporting a refusal, not Bays speaking, and the UI
   * must not attribute it to him.
   */
  ok: boolean;
  answer: string;
  session_id: string;
  steps: string[];
  /** When the workflow accepted the question, from its own clock. Success only. */
  asked_at?: string;
  /** Why it failed. Absent on success. */
  error?: AskErrorKind;
}

/**
 * The two the workflow itself returns, then the ones this app adds for a
 * failure that never got an answer out of it.
 */
export type AskErrorKind =
  | 'unauthorised'
  | 'empty_message'
  | 'not_configured'
  | 'timeout'
  | 'unreachable'
  | 'bad_response';

/* -------------------------------------------- north star / research twin */

export type AskOutcome = 'answered' | 'thin' | 'failed';

export interface TwinSummary {
  period: string;
  asks: number;
  answered: number;
  thin: number;
  failed: number;
  median_time_to_answer: string | null;
  /** Null when nothing is recording the timing yet. */
  median_unavailable_reason: string | null;
  top_askers: { builder_id: string; asks: number }[];
  by_lane: { lane: Lane; asks: number; thin: number; failed: number }[];
}

export interface AskRecord {
  id: string;
  question: string;
  asked_by: string;
  cycle: number;
  outcome: AskOutcome;
  evidence_shape_version: string | null;
  at: string;
  spine: Spine;
  tags: Tags;
  source: Source;
}

export interface RunSearch {
  tool: string;
  returned: number;
  empty: boolean;
}

export interface RunRecord {
  id: string;
  ask_id: string;
  question: string;
  started_at: string;
  searches: RunSearch[];
  ended: 'logged' | 'looping' | 'quarantined' | 'error';
  end_detail: string;
  spine: Spine;
  source: Source;
}

export interface GapRecord {
  id: string;
  question: string;
  reason: 'empty' | 'thin';
  cycles: number;
  first_seen: string;
  spine: Spine;
  source: Source;
}

export interface TransitionRecord {
  id: string;
  question: string;
  went_thin_at: string;
  answered_at: string;
  cycles: number;
  spine: Spine;
  source: Source;
}

export interface TwinData {
  name: string;
  summary: TwinSummary;
  records: AskRecord[];
  runs: RunRecord[];
  gaps: GapRecord[];
  transitions: TransitionRecord[];
  /** Set when a tab has nothing because nothing records it yet. */
  notes: {
    records?: string;
    runs?: string;
    gaps?: string;
    transitions?: string;
  };
}

/* ----------------------------------------------------------------- vfarm */

export interface VFarmAlert {
  id: string;
  at: string;
  place: string;
  kind: string;
  detail: string;
  health: Health;
  state: 'open' | 'closed';
  closed_at: string | null;
  spine: Spine;
  source: Source;
}

/* --------------------------------------------------------- engine health */

export type IncidentState =
  | 'new'
  | 'triage'
  | 'auto-retry pending'
  | 'resolved'
  | 'failed'
  | 'escalated to RT'
  | 'escalated to human';

export type ErrorClass =
  | 'BILLING_QUOTA'
  | 'NETWORK_TIMEOUT'
  | 'SCHEMA_VALIDATION'
  | 'CONFIG_AUTH'
  | 'UNKNOWN';

export interface IncidentAction {
  action_type: string;
  actor: string;
  outcome: 'ok' | 'failed' | 'skipped';
  reason: string;
  at: string;
}

/**
 * A phase 1 incident fixture. **Not the ledger incident** — that is `Incident`,
 * further down, and it is read from BHARAG.
 *
 * Renamed on 2026-09-17 when the real one arrived and needed the name. These
 * rows are read by exactly one thing: the Overview's two 24-hour columns, which
 * have been fixtures since 14 Sep and say so.
 */
export interface FixtureIncident {
  id: string;
  opened_at: string;
  summary: string;
  workflow: string;
  failed_node: string;
  error_class: ErrorClass;
  state: IncidentState;
  health: Health;
  retries_attempted: number;
  max_retries: number;
  /** How many raw failures collapsed into this row. */
  occurrences: number;
  fingerprint: string;
  actions: IncidentAction[];
  spine: Spine;
  tags: Tags;
  source: Source;
}

/* ------------------------------------------------------------ open loops */

export type LoopStatus = 'open' | 'in progress' | 'closed';

/** The locked nine-lane set plus UNASSIGNED, exactly as the loop tables' lane_tag field defines it. */
export type LoopLaneTag = 'RT' | 'NS' | 'VFARM_HARDWARE' | 'KIOSK' | 'CAD_API' | 'MEDIA' | 'GENIE' | 'CST' | 'BAYS' | 'UNASSIGNED';

/**
 * One loop, read from the builder's own table in the loops base. The Airtable
 * record id is the key; loop_id is the human one. There is no close date and
 * no last-modified time on these tables, which is why several loop metrics are
 * null with a note.
 */
/**
 * What happened the last time this dashboard wrote this record to Airtable.
 *
 * One shape for loops and Codex entries, because the reader's problem is the
 * same either way: the dashboard says one thing and Airtable says another, and
 * whoever made the change has to be able to see that it did not land. A
 * failure is therefore a field on the record and not only a log line.
 *
 * `skipped` is a record Airtable has no row for, which is not a failure.
 */
export interface RecordWrite {
  /**
   * `duplicate` is its own state, not a kind of failure: the save landed, and
   * the loop now exists in two tables with one copy needing deletion. Calling
   * that "failed" would say the change did not happen, which is the opposite
   * of the truth, and the recovery is different and specific.
   */
  state: 'ok' | 'skipped' | 'failed' | 'duplicate';
  /** The status the loop was left in, in Airtable's own spelling. */
  status: string;
  /** Why it was skipped, or why it failed — Airtable's own message where there is one. */
  reason: string | null;
  /** Airtable's status code, where the request got that far. */
  http: number | null;
  /** What the write was: 'edit', 'move', 'create', or 'status' for the retired n8n path. */
  action: string | null;
  /** Which fields changed, and the builder move where there was one. */
  detail: string | null;
  /** On a move, the tables it went between. */
  from_table: string | null;
  to_table: string | null;
  /** The steps that actually completed, in order. On a half-landed move this is what says where it stopped. */
  steps: string | null;
  /**
   * On a `duplicate`, the builder whose table still holds the copy — what an
   * action offering to remove it has to be able to name. Null on everything
   * else. The copy's record id stays on the server.
   */
  from_builder?: string | null;
  at: string;
}

export interface Loop {
  /** Airtable record id. Stable, and what every write is keyed by. */
  id: string;
  loop_id: string | null;
  title: string;
  /** The builder whose table the loop lives in. Never the assignee field. */
  owner: string;
  status: LoopStatus;
  /** Days since Date Raised; 0 when there is no date. */
  age_days: number;
  raised_at: string | null;
  raised_by: string | null;
  raised_in: string | null;
  lane_tag: LoopLaneTag | null;
  assignee_slack_id: string | null;
  /**
   * The table's last_modified formula (LAST_MODIFIED_TIME()), added 9 Sept
   * 2026. Every loop that existed before stamps from that day, so it says
   * nothing about history before it.
   */
  last_modified: string | null;
  /** Known only when the close went through this dashboard or arrived from n8n with a timestamp. */
  closed_at?: string | null;
  note?: string | null;
  /** The last write-back to Airtable, when this dashboard has attempted one. */
  writeback?: RecordWrite | null;
  spine: Spine;
  tags: Tags;
  source: Source;
  airtable: AirtableRef;
}

/** What the loop panel can change. Everything else on the row is read-only. */
export interface LoopEdit {
  title?: string;
  status?: LoopStatus;
  lane_tag?: LoopLaneTag | null;
  /** Not a field — the builder is which table the row sits in, so this is a move. */
  builder?: string;
}

export interface NewLoop {
  title: string;
  owner: string;
  lane_tag: LoopLaneTag;
  raised_by?: string;
  note?: string;
}

/** Where a record lives in Airtable, so every row can open there. */
export interface AirtableRef {
  base: string;
  table: string;
  record_id: string;
  url: string;
}

export interface OpenLoopsData {
  loops: Loop[];
  by_owner: OwnerTotals[];
  /** countOpenLoops(): the one open-loop total, the same one Home prints. */
  open_count: { total: number; open: number; in_progress: number; by_builder: { builder_id: string; open: number; in_progress: number }[] };
  freshness: Freshness;
  status_history_note: string;
}

export interface OwnerTotals {
  owner: string;
  open: number;
  in_progress: number;
  closed: number;
  oldest_days: number;
}

/**
 * How old a kind's rows are, and where they came from.
 *
 * There is no sync behind these rows any more (2026-09-13): the engine writes
 * them into this database and the page reads the same row. So there is no
 * "last synced" to report and nothing that can be behind a source — what a
 * page can honestly say is when one of its rows last changed here, how many
 * there are, and how many the engine has written since the migration.
 */
export interface Freshness {
  kind: RecordKind;
  /** 'engine' once any row of this kind is held, 'none' when none is. */
  source: 'engine' | 'none';
  /** When a row of this kind last changed in this database. */
  changed_at: string | null;
  /** Rows held. */
  rows: number;
  /** Of those, how many the engine or the interface has written since the migration backfill. */
  from_engine: number;
  /** Rows per source table, where the kind spans several. */
  tables: { table: string; label: string; n: number }[];
  /** Why nothing is held, when nothing is. */
  note: string | null;
}

/* ------------------------------- codex / patterns / commercial / builders */

/**
 * One submission from a builder's table in BHA Submissions & Logs
 * (appEmdKshNVTl64Zf) — the row a Codex entry is written onto.
 *
 * `builder_id` is the table the row lives in, so it is never blank; the
 * Builder Name field is, on several rows, which is why it is not used for
 * identity. `entry` (the Orchestrator Layer2 Review) is the finished Codex
 * entry text and lives on the detail shape only — the list carries
 * `entry_excerpt` and `has_entry` instead, because a hundred full entries in
 * one payload is megabytes.
 *
 * Two independent axes, not one pipeline:
 *   Jason Status   approved / pending / input added — the review decision
 *   Layer 0        flagged / clean — the completeness gate, before review
 * A row can be approved and still carry a Layer 0 flag; both are shown.
 */
export interface CodexEntry {
  /** Airtable record id. */
  id: string;
  /** The builder whose table the row lives in. Never null. */
  builder_id: string;
  /** That table's id, so a write knows where to go. */
  table: string;
  /** The pipeline's own key, e.g. U0AEW3TBYH1_1787265422533. */
  submission_id: string | null;
  /** CODEX-YYYYMMDD-builder-slug, once Bays has written it back. */
  codex_entry_id: string | null;
  /** From the Timestamp field, normalised to ISO. */
  logged_at: string | null;
  /**
   * When Jason approved or added input. `Jason Reviewed At` was created on
   * 14 Sep 2026 with no backfill, so this is null on every log before then —
   * which is why days-to-approval has a boundary and approval rate does not.
   */
  reviewed_at: string | null;
  /** ISO week of logged_at, e.g. 2026-W36. */
  week: string | null;
  session_type: string | null;
  session_url: string | null;
  narration_quality: string | null;
  submission_source: string | null;
  /** Jason Status verbatim: Approved, Pending, Input Added, or null. */
  jason_status: string | null;
  approval: CodexApproval;
  /** Layer0 Flagged: true when the completeness gate stopped this submission. */
  layer0_flagged: boolean;
  /** Layer0 Missing, parsed: which elements the gate found absent. */
  layer0_missing: string[];
  /** Not flagged by Layer 0, and Layer 2 has generated the codex. */
  complete: boolean;
  /** Which of the three stages this log is at. Layer0 Flagged wins; otherwise Jason Status decides. */
  stage: CodexTab;
  /** The last write of this record to Airtable, when this dashboard has attempted one. */
  writeback?: RecordWrite | null;
  /** Whether Orchestrator Layer2 Review holds anything. */
  has_entry: boolean;
  /** The opening of the Layer 2 review, for the list. */
  entry_excerpt: string | null;
  /**
   * The opening of Session Description — the builder's own one-line title for
   * the session — which is what the list shows in the description column. The
   * generated codex is still what opens on click; a scan down the page reads
   * better against the session's title than against the first 220 characters
   * of every entry, which all begin the same way.
   */
  description_excerpt: string | null;
  /**
   * `Paid`: true for Yes, false for No, and **null where the row carries no
   * value at all** — the column was added after most of the history and
   * nothing backfills it. Null is rendered as "not recorded", never as unpaid.
   */
  paid: boolean | null;
  processed_at: string | null;
  processed_date: string | null;
  note?: string | null;
  spine: Spine;
  tags: Tags;
  source: Source;
  airtable: AirtableRef;
}

/** The full submission, for the entry view. `entry` is the completed Codex entry. */
export interface CodexEntryDetail extends CodexEntry {
  /** Orchestrator Layer2 Review — the full Codex entry text. */
  entry: string | null;
  layer1_review: string | null;
  summary: string | null;
  session_description: string | null;
  jason_notes: string | null;
}

/**
 * The record kinds that have a statistics tab. Six pages, one engine — see
 * `server/src/stats.ts`.
 */
export type StatKind = 'codex' | 'loops' | 'patterns' | 'commercial' | 'clients' | 'northstar' | 'researchtwin' | 'researchjobs';

/**
 * One figure on a statistics tab, with the same figure a month ago.
 *
 * `unavailable` is the case that must not be drawn as a zero: a metric nothing
 * in the engine records. Its tile prints the reason rather than a number, which
 * is the same rule as "a zero and an unknown must never look the same".
 */
export interface RecordStatMetric {
  key: string;
  label: string;
  /** The source field the figure comes from, named as Airtable spells it. */
  field: string;
  unit: 'count' | 'percent' | 'duration';
  /** A duration figure is milliseconds; the page turns it into minutes, hours or days. */
  value: number | null;
  previous: number | null;
  /** How many rows the figure is over, so a rate says what it is a rate of. */
  n: number;
  previous_n: number;
  change: Delta | null;
  /** Which direction is good news, where there is one. Null means the page colours nothing. */
  better: 'up' | 'down' | null;
  /** The base of the figure, or why it is missing. Always shown. */
  note: string | null;
  /** True where nothing in the engine records this, so the tile says so plainly. */
  unavailable: boolean;
}

/** A month of one record kind set against the month before it. */
export interface RecordStats {
  kind: StatKind;
  /** Every month from the first record held to this one, for the picker. */
  months: { month: string; label: string; logs: number }[];
  selected: string;
  selected_label: string;
  previous: string;
  previous_label: string;
  /** True when the selected month is still running and the previous was cut to the same elapsed point. */
  like_for_like: boolean;
  /** Which days of the previous month were counted, where it was cut. Null where there is no comparison. */
  window: string | null;
  /** False where the previous month predates everything held; no change is given anywhere. */
  covered: boolean;
  metrics: RecordStatMetric[];
  /** The comparison in words, written on the server. */
  prose: string;
  /** What it is compared against, and why it was cut or refused. */
  note: string;
}

/** Jason Status, lower-cased. 'unset' is a row he has not touched. */
export type CodexApproval = 'approved' | 'pending' | 'input added' | 'unset';

/**
 * A submission parked at the Layer 0 completeness gate, waiting for the
 * builder to answer what it is missing. It is not a Codex entry and never
 * appears in the entry list; it is counted so the Incomplete tab can say how
 * many submissions never reached a builder's table at all.
 */
export interface Layer0Hold {
  id: string;
  submission_id: string | null;
  builder_id: string | null;
  builder_name: string | null;
  missing: string[];
  status: string | null;
  /** Anything but "completed". */
  open: boolean;
  /** Exactly `pending_builder_input`: the builder still owes an answer. */
  pending_builder_input: boolean;
  created_at: string | null;
  source: Source;
  airtable: AirtableRef;
}

/** The four tabs, exactly as defined against the source's own fields. */
/**
 * The three stages a log passes through, one per layer, plus All.
 *
 * They are mutually exclusive by one rule: `Layer0 Flagged` wins. A flagged log
 * is at `needs_input` whatever Jason Status says, because the gate ran first
 * and the builder has to answer before anything else can happen to it.
 * Otherwise Jason Status decides. So every submission is in exactly one stage
 * and the three sum to the total.
 *
 * The row that replaced this had "Approved / Pending approval" against
 * "Incomplete / Complete" — a review decision and a gate verdict in one row,
 * two different questions, which is why the counts overlapped. "Complete" is
 * gone: it was not a decision, it was Layer 2 having written something.
 *
 * There is no "Input added" stage. Jason adding input happens while a log sits
 * at Awaiting approval — he either approves or asks, and the builder answers in
 * thread — so those logs stay there.
 */
export type CodexTab = 'needs_input' | 'awaiting' | 'approved';

export interface CodexData {
  entries: CodexEntry[];
  freshness: Freshness;
  /** The tables read, in the order they are offered as builder tabs. */
  builders: { id: string; label: string; table: string; n: number }[];
  /** Submissions sitting at the Layer 0 gate, which have no builder-table row yet. */
  layer0_holds: Layer0Hold[];
  /** Select choices as the tables define them, for the review control. */
  choices: { jason_status: string[] };
}

/**
 * A row deleted by hand in Airtable notifies nothing, so this dashboard would
 * go on showing it. Every Codex page load compares the record ids Airtable
 * holds against the rows here and removes what is genuinely gone.
 *
 * A table whose read failed is never treated as an emptied table: nothing under
 * it is removed and `blocked` names it, because a failed fetch and a table
 * someone cleared look identical from here.
 */
/**
 * What one resync did, per table and in total.
 *
 * Airtable is the source of truth for every field it owns, so a resync only
 * ever moves rows in one direction. `overwritten` is the exception worth
 * naming: a row whose own change never reached Airtable and has now been
 * reverted to Airtable's copy. Silence there would be this dashboard losing a
 * decision somebody made in it.
 */
export interface ResyncTable {
  table: string;
  label: string;
  /** False when Airtable refused or the budget ran out. Nothing under it was touched. */
  read: boolean;
  reason: string | null;
  /** How many rows Airtable holds in this table. Null when it could not be read. */
  rows: number | null;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /**
   * Rows Airtable returned that this database refused to store, with the
   * reason in the server log. Counted rather than swallowed: a table that read
   * five rows and stored none is not a table that already matched, and without
   * this the two look identical on the page.
   */
  refused: number;
}

/**
 * One resync, whichever page pressed the button.
 *
 * The same shape for every kind on purpose: Codex reads seven tables, Clients
 * reads the index and then one table per lane, and Build patterns and
 * Commercial read exactly one each — but "what did it change, and what could it
 * not read" is the same question in all four cases, and the toast that answers
 * it is the same line.
 */
export interface Resync {
  ran: boolean;
  at: string;
  ms: number;
  tables: ResyncTable[];
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  refused: number;
  /** Rows whose local change never landed in Airtable and has now been overwritten. */
  overwritten: { record_id: string; natural_id: string | null }[];
  note: string;
}

/**
 * The final import from Airtable (2026-09-22, Destiny) — the last read of it,
 * and the one that must not lose anything.
 *
 * Deliberately **not** a Resync and deliberately not shaped like one. A resync
 * is Airtable-wins and deletes what Airtable no longer has, which is right
 * while Airtable is the record and catastrophic afterwards: every row the
 * engine has written here since the cutover has no Airtable copy at all. This
 * keeps what has changed here, names it, and deletes nothing — so it has
 * `kept_newer_here` where a resync has `deleted`, and the two cannot be read
 * for one another.
 */
export interface FinalImportKept {
  kind: string;
  table: string;
  label: string;
  record_id: string;
  natural_id: string | null;
  /** The field the two copies disagree about — Status wherever it is one of them. */
  field: string | null;
  here: string | null;
  airtable: string | null;
  /** How many keys differ in all, so "one field" and "the whole row" read differently. */
  differing: number;
  source: string;
  updated_at: string;
}

export interface FinalImportTable {
  table: string;
  label: string;
  kind: string;
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
  group: string;
  ran: boolean;
  at: string;
  ms: number;
  /** The line the decision is made against: nothing written here before it can be a decision made here. */
  cutover_at: string;
  tables: FinalImportTable[];
  inserted: number;
  updated: number;
  unchanged: number;
  kept_newer_here: number;
  refused: number;
  kept: FinalImportKept[];
  note: string;
}

/** The Codex page's own name for it, from before the other three pages had one. */
export type CodexResync = Resync;
export type CodexResyncTable = ResyncTable;

export interface CodexReconciliation {
  ran: boolean;
  checked: number;
  removed: number;
  /** Which rows went, for the line the page prints. */
  removed_ids: string[];
  /** Tables that could not be read, and why. Nothing under them was touched. */
  blocked: { table: string; label: string; reason: string }[];
  at: string | null;
  note: string;
}

/**
 * One build pattern. `system` and `keywords` are read off pattern_id and
 * bha_system — classification from the record's own naming, not a model.
 * Long text (problem, solution, context…) is not in the list payload; the
 * detail endpoint carries it.
 */
export interface BuildPattern {
  /** Airtable record id. */
  id: string;
  pattern_id: string | null;
  title: string;
  bha_system: string | null;
  reusability: string | null;
  created_at: string | null;
  /** The second segment of pattern_id, e.g. SLACK in BP-SLACK-001-…; null when the id does not follow that shape. */
  system: string | null;
  /** Lower-case words from the pattern_id slug and bha_system, for classification and search. */
  keywords: string[];
  /** The first sentences of `problem`, for the list. */
  excerpt: string | null;
  note?: string | null;
  source: Source;
  airtable: AirtableRef;
}

/** The full record, for the detail view. */
export interface BuildPatternDetail extends BuildPattern {
  problem: string | null;
  solution: string | null;
  context: string | null;
  next_use_case: string | null;
  commercial_impact: string | null;
  research_production_impact: string | null;
  learnings_gotchas: string | null;
  readiness_gates: string | null;
  implementation_checklist: string | null;
  integration_points: string | null;
  test_coverage: string | null;
  routing_logic: string | null;
  anti_pattern: string | null;
  naming_note: string | null;
  roadmap_context: string | null;
}

/**
 * `pattern_status` is gone (2026-09-15, Destiny). It was deleted from the Build
 * Patterns base and removed from every workflow that wrote it, so there is no
 * draft, no canonical and no "no status" — the table has twenty columns and
 * none of them is a state. The page reads nothing for it and writes nothing to
 * it; a pattern is a pattern.
 */
export interface BuildPatternsData {
  patterns: BuildPattern[];
  freshness: Freshness;
}

/** readiness_state as the Commercial Opportunities table defines it. */
export type ReadinessState = 'INCUBATE' | 'Research-First' | 'Media-Ready';

/**
 * One commercial card. Fields are the table's own. `missing_research_questions`
 * is the pipe-separated text split into its items; `missing_research_count` is
 * the table's own number and may disagree with that list — both are shown.
 */
export interface Opportunity {
  /** Airtable record id. */
  id: string;
  card_id: string | null;
  title: string;
  /** One per card — 21 lane_ids across 21 cards — so it names a card, it does not group them. */
  lane_id: string | null;
  readiness_state: ReadinessState | null;
  confidence: string | null;
  infra_readiness: string | null;
  data_readiness: string | null;
  media_readiness: string | null;
  missing_research_count: number | null;
  missing_research_questions: string[];
  /** missing_research_count, except a 0 (or no count) beside listed questions counts the listed ones; null if neither is written. */
  open_questions: number | null;
  next_action: string | null;
  pain_point: string | null;
  offer: string | null;
  target: string | null;
  who_pays: string | null;
  bha_system: string | null;
  /**
   * Read off the card's own `lane_id`, the same way a build pattern's keywords
   * are read off its `pattern_id` — `LANE-VFARM-ZONE_MONITORING_SAAS` gives
   * zone, monitoring, saas. The `VFARM` segment is left out because it is the
   * same on every card, so it would group nothing.
   *
   * `bha_system` is deliberately not a source here. On this table it is prose
   * — "vFarm (digital twin), RAG archive (intelligence layer), Swagger-
   * documented API" — and splitting it on spaces produces words like
   * "documented" and "layer", which are not keywords.
   */
  keywords: string[];
  /**
   * The rest of the prose the table carries. Every one of these is absent on
   * roughly half the corpus — the schema grew over months and the July and
   * early-August cards predate the deeper half of it — so each is rendered
   * where present and left out where not. Filtering the page down to the
   * fields every row carries is why it showed so much less than the table
   * holds.
   */
  metrics_hypothesis: string | null;
  missing_proof: string | null;
  implementation_constraints: string | null;
  commercial_impact: string | null;
  offer_shapes_gates: string | null;
  next_experiments: string | null;
  experiment_results: string | null;
  research_gleanings: string | null;
  demand_strength_hypothesis: string | null;
  competing_offers_snapshot: string | null;
  hypothesis_rejection_note: string | null;
  commercial_ready_v1_checklist: string | null;
  infra_gaps: string | null;
  reuse_patterns: string | null;
  source_logs: string | null;
  /**
   * The four the extractor hardcodes on every card it writes: pilot_state
   * research_only, routing_state research_loop, media_gate CLOSED, lane_state
   * research_first. Process Twin is the only thing that would ever advance
   * them and it never has, so they are constant across all 21 records. Shown on
   * the card, because they are what the row says; never a grouping, a tab or a
   * chart, because a bucket holding everything sorts nothing.
   */
  pilot_state: string | null;
  routing_state: string | null;
  lane_state: string | null;
  media_gate: string | null;
  created_at: string | null;
  note?: string | null;
  spine: Spine;
  source: Source;
  airtable: AirtableRef;
}

export interface CommercialData {
  opportunities: Opportunity[];
  freshness: Freshness;
  /** Per card, missing_research_count as observed at each boot — a trend only once seen on two different days. Keyed by record id. */
  trends: Record<string, MetricSeries>;
}

export interface Builder {
  id: string;
  name: string;
  lane: Lane;
  open_loops: number;
  oldest_loop_days: number;
  last_activity: string;
  contract_status: 'signed' | 'pending' | 'lapsed';
  entries_this_week: number;
  health: Health;
  source: Source;
}

/* ------------------------------------------------------------ the twins */

/**
 * North Star and Research Twin, as their own ledgers record them since
 * 17 Sep 2026.
 *
 * Both twins now finish every run with the same three steps — write the
 * ledger row, mirror it here, ingest it into BHARAG — so a run that finished
 * is a run that was recorded. The five `[LEGACY]` tables the pages read until
 * today (NS Records, the Research Queue and its resolved-events table, the
 * priority ledger and lane_status) have no writers left and are not read from
 * anywhere in this code.
 *
 * **These ledgers start empty, deliberately.** September holds a handful of
 * rows at most and October is the first clean month, which is why nothing here
 * smooths a sparse month into a trend: a rate over two asks says it is over
 * two asks, and a month with no rows says it was not recorded rather than
 * drawing a bar at nought.
 *
 * Every select vocabulary below was read from the live bases on 17 Sep 2026,
 * not taken from the brief — `Delivered` is Delivered / Not delivered / No
 * target (and Self-delivered on Research Twin), and Research Twin's ask types
 * carry an `External web search` option the brief did not mention.
 */

/** One tool call, as an `Evidence Used` line records it. */
export interface AskTool {
  tool: string;
  /**
   * How many rows came back, and how many of them ended up cited.
   *
   * **Null, not nought, where the ledger does not record it.** North Star's
   * line is `- tool -> 12 row(s), cited 3 time(s)`; Research Twin's is the tool
   * and its arguments followed by the observation, with no counts at all. A
   * nought here would read as "called and returned nothing", which is a
   * different and much worse fact than "not recorded".
   */
  hits: number | null;
  cited: number | null;
  /** The tool's arguments as the line carried them, for the detail view. */
  args: string | null;
}

/** A share of something, never printed without the denominator it is over. */
export interface Share {
  n: number;
  of: number;
  /** Null where `of` is nought — a rate over no rows is unknown, not nought. */
  pct: number | null;
  note: string;
}

/** A named count in a distribution. `key` is the source value, verbatim. */
export interface Slice {
  key: string;
  label: string;
  n: number;
}

/**
 * A duration, as p50 and p95 and never as a mean.
 *
 * A mean latency hides the tail, and the tail is what people experience. Both
 * are null where nothing recorded a duration; `n` is how many rows carried one.
 */
export interface Percentiles {
  p50: number | null;
  p95: number | null;
  n: number;
  of: number;
  note: string;
}

/** One cohort of asks — an asking system, a lane — with its own rates. */
export interface Cohort {
  key: string;
  label: string;
  asks: number;
  answered: number;
  delivered: number;
  /** Research Twin only: how many of this cohort's asks went outside BHA. */
  external: number | null;
}

/** One week of a stacked outcome column. `counts` is keyed by outcome, verbatim. */
export interface OutcomeWeek {
  week: string;
  label: string;
  total: number;
  counts: Record<string, number>;
}

/** One week of a duration trend. */
export interface DurationWeek {
  week: string;
  label: string;
  p50: number | null;
  p95: number | null;
  n: number;
}

/**
 * Twin-to-twin handoffs: how often the two actually consult each other.
 *
 * Until 17 Sep the twins could not reach each other at all — every handoff went
 * through a person or through Bays — so this is the only way to tell whether
 * being able to changed anything.
 */
export interface Handoffs {
  n: number;
  of: number;
  pct: number | null;
  /**
   * Both sides of an exchange, where both are held.
   *
   * `direction` is asserted only where the row says which way it went —
   * `Asked By System` naming the other twin. A row carrying only
   * `Linked Twin Ask` proves the two are linked and nothing about who asked
   * whom, so it is `linked` rather than a guess dressed as an arrow.
   */
  pairs: { ask_id: string; ask_at: string | null; ask_question: string | null; reply_id: string | null; reply_at: string | null; reply_summary: string | null; direction: 'ns→rt' | 'rt→ns' | 'linked'; ledger: 'North Star' | 'Research Twin' }[];
  note: string;
}

/* ----------------------------------------------------------- north star */

export interface NsAsk {
  id: string;
  ask_id: string | null;
  asked_at: string | null;
  week: string | null;
  asked_by_system: string | null;
  /** A Slack user id, or a `SYSTEM-…` string where no person was behind it. */
  asked_by_person: string | null;
  question: string | null;
  question_type: string | null;
  /** Often empty. Empty is a fact about the routing, not an error. */
  lane: string | null;
  answer: string | null;
  answer_summary: string | null;
  has_answer: boolean;
  /** Answered · Thin · Refused (not its lane) · Failed. Every new row carries one. */
  outcome: string | null;
  claimed_priority_score: number | null;
  claimed_priority_tier: string | null;
  claimed_lane_health: string | null;
  claimed_strategic_importance: string | null;
  architect_attention: boolean;
  /** Parsed from `Evidence Used`; the raw text is kept beside it for the detail view. */
  tools: AskTool[];
  evidence_used: string | null;
  /** 0–1, as the agent computed it. Not a model-reported confidence. */
  citation_coverage: number | null;
  confidence_stated: string | null;
  response_seconds: number | null;
  /** Delivered · Not delivered · No target. Written after the answer is sent. */
  delivered: string | null;
  delivery_target: string | null;
  slack_link: string | null;
  error: string | null;
  run_id: string | null;
  linked_twin_ask: string | null;
  source: Source;
  airtable: AirtableRef;
}

export interface NsData {
  asks: NsAsk[];
  freshness: Freshness;
}

export interface NsMetrics {
  kind: 'ns';
  computed_at: string;
  scope: { rows: number; month: string | null };
  /**
   * The failure metric. North Star once ran green for six consecutive days
   * while Slack rejected every post and nothing reported it, so anything below
   * 100% is coloured.
   */
  delivery_rate: Share;
  /** The outcome metric. */
  answered_rate: Share;
  asks: number;
  response: Percentiles;
  last_ask: { at: string | null; ask_id: string | null; note: string };
  asks_per_week: MetricSeries;
  outcome_per_week: OutcomeWeek[];
  outcome_mix: Slice[];
  outcome_note: string;
  delivery_mix: Slice[];
  /** Where an undelivered answer was aimed, so a quietly failing target is nameable. */
  failed_targets: { target: string; n: number; outcome: string }[];
  delivery_note: string;
  by_system: Cohort[];
  by_system_note: string;
  question_types: Slice[];
  question_type_note: string;
  citation: { mean: number | null; n: number; of: number; buckets: Slice[]; note: string };
  tools: { tool: string; calls: number; hits: number | null; cited: number | null; cited_rate: number | null }[];
  tools_note: string;
  response_trend: DurationWeek[];
  priority: { mix: Slice[]; by_lane: { lane: string; asks: number; critical_weeks: number; last_critical: string | null; mix: Slice[] }[]; note: string };
  architect: { n: number; of: number; lanes: { lane: string; n: number; last_at: string | null }[]; note: string };
  by_lane: Cohort[];
  by_lane_note: string;
  handoffs: Handoffs;
}

/* -------------------------------------------------------- research twin */

export interface RtAsk {
  id: string;
  ask_id: string | null;
  asked_at: string | null;
  week: string | null;
  asked_by_system: string | null;
  asked_by_person: string | null;
  /** Card research · Question · External web search · Watched client · Other. */
  ask_type: string | null;
  question: string | null;
  card_id: string | null;
  lane: string | null;
  answer: string | null;
  answer_summary: string | null;
  has_answer: boolean;
  /** Answered · Thin · Needs human · Refused (not its lane) · Failed. */
  outcome: string | null;
  confidence_stated: string | null;
  /**
   * Did it go outside BHA. Research Twin's job is the outside world; Bays and
   * North Star can both query BHARAG directly, so an ask that never left the
   * building is one they could have answered themselves.
   */
  used_web_search: boolean;
  /** Yes · No (degraded) · Not used. Recorded per run, never inferred. */
  bharag_reachable: string | null;
  sources_count: number | null;
  sources: string | null;
  tools: AskTool[];
  evidence_used: string | null;
  citation_coverage: number | null;
  response_seconds: number | null;
  /** Delivered · Not delivered · No target · Self-delivered. */
  delivered: string | null;
  delivery_target: string | null;
  slack_link: string | null;
  error: string | null;
  run_id: string | null;
  linked_twin_ask: string | null;
  source: Source;
  airtable: AirtableRef;
}

/**
 * One research job — **one row per job**, carrying its own status, attempts
 * and outcome.
 *
 * This is the semantic change from the queue it replaces: that table held one
 * row per *attempt* with a second table for outcomes, so "attempts" and "cards"
 * were different counts of different things. Here `attempts` is a number on the
 * job and a job is one row.
 */
export interface RtJob {
  id: string;
  job_id: string | null;
  question: string | null;
  context: string | null;
  card_id: string | null;
  lane: string | null;
  /** Pending · In Progress · Resolved · Capped (needs human). */
  status: string | null;
  opened_by: string | null;
  opened_at: string | null;
  resolved_at: string | null;
  /** Caps at three; the third pass without a usable answer hands it to a person. */
  attempts: number | null;
  finding: string | null;
  answer_history: string | null;
  sources: string | null;
  verdict: string | null;
  confidence: string | null;
  gap_type: string | null;
  missing_elements: string | null;
  target_source_types: string | null;
  linked_asks: string[];
  reported_in_digest: boolean;
  /**
   * Whole days, three different questions. `age_days` is always how long ago
   * the job was opened. `days_open` is how long it has been *waiting* and is
   * null once it is resolved or capped. `days_to_resolve` exists only once it
   * has been resolved.
   */
  age_days: number | null;
  days_open: number | null;
  days_to_resolve: number | null;
  open: boolean;
  capped: boolean;
  source: Source;
  airtable: AirtableRef;
}

export interface RtData {
  asks: RtAsk[];
  jobs: RtJob[];
  freshness: Freshness;
  /** The jobs table is mirrored separately, so it carries its own age. */
  jobs_freshness: Freshness;
}

export interface RtMetrics {
  kind: 'rt';
  computed_at: string;
  scope: { rows: number; month: string | null };
  /** The first figure on the page: did the ask go outside BHA at all. */
  external_rate: Share;
  answered_rate: Share;
  /** Correctly escalating beats a confident wrong answer, so this is never red. */
  needs_human_rate: Share;
  asks: number;
  response: Percentiles;
  last_ask: { at: string | null; ask_id: string | null; note: string };
  asks_per_week: MetricSeries;
  outcome_per_week: OutcomeWeek[];
  outcome_mix: Slice[];
  outcome_note: string;
  external_per_week: { week: string; label: string; used: number; total: number }[];
  external_note: string;
  bharag: { mix: Slice[]; degraded: number; of: number; note: string };
  sources: { buckets: Slice[]; none: number; of: number; mean: number | null; note: string };
  citation: { mean: number | null; n: number; of: number; buckets: Slice[]; note: string };
  confidence: { mix: Slice[]; by_outcome: { confidence: string; outcome: string; n: number }[]; high_no_sources: number; note: string };
  ask_types: Slice[];
  ask_type_note: string;
  by_system: Cohort[];
  by_system_note: string;
  delivery_mix: Slice[];
  delivery_note: string;
  response_trend: DurationWeek[];
  handoffs: Handoffs;
}

export interface RtJobMetrics {
  kind: 'rt_jobs';
  computed_at: string;
  scope: { rows: number; month: string | null };
  /** The number that matters on this page: any above nought needs a person. */
  capped: Share;
  open: number;
  in_progress: number;
  pending: number;
  resolved_this_month: number;
  /** Days from `Opened At` to `Resolved At`, p50 with p95 beside it. */
  time_to_resolve: Percentiles;
  oldest_open: { job_id: string | null; days: number | null; note: string };
  status_mix: Slice[];
  status_note: string;
  attempts_mix: Slice[];
  attempts_note: string;
  gap_mix: Slice[];
  gap_note: string;
  resolve_trend: DurationWeek[];
  opened_by: Slice[];
  opened_by_note: string;
  resolution_rate: Share;
}

/* ----------------------------------------------------------- engine health */

/**
 * Engine Health: is the engine working right now, and if not, what broke, did
 * it fix itself, and does anyone need to do something?
 *
 * Built 2026-09-17 from three sources that were already there and had never
 * been read: the BHARAG incident ledger (one call per lane, each with its own
 * credential), `error_counts` and `retry_attempts` in Airtable.
 *
 * **No incidents and no reporting look identical from the outside**, which is
 * the one thing this page must never blur. Every figure here distinguishes
 * them: a lane whose read succeeded and returned nothing says so, and a lane
 * with no credential or a refused read says *that*, and neither is drawn as
 * health. `lanes` below carries that per lane, on every payload.
 */

/** One lane's own read, and whether it happened at all. */
export interface LaneRead {
  lane: string;
  label: string;
  /** Whether this server holds a credential for this lane. */
  configured: boolean;
  /** Whether the last resync actually read it. */
  read: boolean;
  /** Why not, in the ledger's own words. */
  reason: string | null;
  /** When it was last read successfully. */
  at: string | null;
  open: number;
}

/**
 * One incident from the ledger.
 *
 * **`payload.retry_policy.retries_attempted` is not on this type.** The healer
 * does not maintain it — attempts live in `retry_attempts` — so the number on
 * the incident is stale the moment a retry happens. It stays inside the stored
 * payload, because nothing drops a field the engine owns, and it has no way
 * onto the page.
 */
export interface Incident {
  id: string;
  entity_id: string;
  type: string | null;
  subsystem: string | null;
  lane: string | null;
  lane_label: string;
  severity: string;
  /** Whether the severity is the ledger's own or derived from the class. */
  severity_from: 'the incident' | 'the error class';
  summary: string | null;
  resolution_status: string | null;
  workflow: string | null;
  failed_node: string | null;
  /** Normalised to one spelling; a class this code does not know keeps its name. */
  error_class: string;
  error_class_known: boolean;
  retryable: boolean;
  retryable_from: 'the incident' | 'the error class';
  error_message: string | null;
  execution_id: string | null;
  /** The execution's own page, where this database holds that execution. */
  execution_url: string | null;
  impact_tags: string[];
  max_retries: number | null;
  retry_interval: string | null;
  /** Plain English, written for a person to act on. Never truncated on the page. */
  self_healing_strategy: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  /** Set where the handler overrode its own first classification. */
  reclassified_from: string | null;
  first_seen_at: string | null;
  /**
   * Whether the lane's open query still returns it. **Never inferred from
   * age**: it goes false only when a read that succeeded did not include it.
   */
  open_now: boolean;
  last_seen_open: string | null;
  hours_to_resolve: number | null;
  /**
   * The newest close attempted from this dashboard, if any (2026-09-22): who,
   * when, and whether the ledger took it. A refused close is kept on the row
   * rather than greyed out, because a row that looks closed while the ledger
   * still has it open is the failure this exists to prevent.
   */
  close_attempt: IncidentClose | null;
}

export interface IncidentClose {
  state: 'ok' | 'failed';
  at: string;
  actor: string | null;
  /** BHARAG's own reason on a refusal, verbatim. */
  reason: string | null;
  http: number | null;
}

export interface IncidentCloseResult {
  at: string;
  actor: string;
  requested: number;
  closed: number;
  failed: number;
  skipped: number;
  results: { id: string; outcome: 'closed' | 'failed' | 'skipped'; reason: string | null; http: number | null }[];
  note: string;
}

export interface ErrorCount {
  id: string;
  signature: string;
  workflow: string | null;
  failed_node: string | null;
  error_class: string;
  /**
   * Occurrences inside the current six-hour window. **A countdown, not a
   * lifetime total** — it resets to nought once an alert fires — so nought
   * means "recently alerted", not "never happened". Null is not recorded.
   */
  error_count: number | null;
  last_seen: string | null;
  last_alerted_at: string | null;
  incident_id: string | null;
  source: Source;
  airtable: AirtableRef;
}

export interface RetryAttempt {
  id: string;
  incident_id: string;
  lane: string | null;
  lane_label: string;
  workflow: string | null;
  failed_node: string | null;
  error_class: string;
  execution_id: string | null;
  /** 1–3. The cap is the circuit breaker. */
  attempts: number | null;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  /** Retrying · Recovered · Exhausted. Retrying is genuinely undecided. */
  status: string;
  retry_execution_id: string | null;
  triggered_by: string | null;
  /** The last attempt's outcome in plain English. Shown in full. */
  last_result: string | null;
  can_retry: boolean;
  /** Why the button is disabled, where it is. */
  blocked_reason: string | null;
  source: Source;
  airtable: AirtableRef;
}

/* ------------------------------------------------------------- the repairs */

/**
 * One automated repair attempt, as `engine_repairs` holds it.
 *
 * The outcome is the whole truth of a repair: `repaired` only where the bridge
 * said so and a new workflow version came back. The bridge having been called
 * is not a repair, and a run that could not report its own result is
 * `needs_human` rather than assumed to have worked.
 */
export type RepairOutcome = 'repaired' | 'not_repaired' | 'needs_human' | 'skipped' | 'error';

export interface Repair {
  id: number;
  /** The bridge's own id. One row per repair, so a repeated report updates rather than duplicates. */
  repair_id: string;
  outcome: RepairOutcome | string;
  workflow_id: string | null;
  workflow_name: string | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  execution_id: string | null;
  /** What was actually wrong, in the repair agent's own words. */
  root_cause: string | null;
  /** What it changed, precisely. */
  change_summary: string | null;
  nodes_changed: string[];
  /** The whole value of a needs-human outcome: what a person should do, in order. */
  human_action: string | null;
  version_before: string | null;
  version_after: string | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  reverted_at: string | null;
  reverted_by: string | null;
  created_at: string;
  execution_url: string | null;
  /** Decided on the server, so the button and the endpoint cannot disagree. */
  can_revert: boolean;
  revert_blocked_reason: string | null;
}

export interface RepairSummary {
  total: number;
  last_7_days: number;
  last_30_days: number;
  by_outcome: { key: string; label: string; n: number }[];
  /** Repaired and not since put back — what the engine currently claims to have fixed. */
  repaired_standing: number;
  reverted: number;
  /** p50 and p95 only, never a mean, over the repairs that recorded a duration. */
  median_repair_ms: number | null;
  p95_repair_ms: number | null;
  timed: number;
  duration_note: string;
  newest_at: string | null;
}

export interface RepairsData {
  repairs: Repair[];
  summary: RepairSummary;
  /** Whether a revert can reach n8n at all, said once rather than on every row. */
  n8n_configured: boolean;
}

export interface RevertResult {
  ok: boolean;
  repair_id: string;
  message: string;
  /** Which guard refused it, where one did. */
  refused: 'not_found' | 'not_a_repair' | 'already_reverted' | 'no_restore_point' | 'no_snapshot' | 'version_moved_on' | 'not_configured' | 'n8n_refused' | null;
  /** The row as it now stands, so a page can update it in place. */
  repair: Repair | null;
}

/** A week of a stacked column, keyed by lane or by class. */
export interface HealthWeek {
  week: string;
  label: string;
  total: number;
  counts: Record<string, number>;
}

/** One workflow's open incidents, grouped by the node that actually failed. */
export interface WorkflowFaults {
  workflow: string;
  open: number;
  nodes: { node: string; open: number; incidents: Incident[] }[];
}

export interface HealthData {
  incidents: Incident[];
  error_counts: ErrorCount[];
  retries: RetryAttempt[];
  lanes: LaneRead[];
  freshness: Freshness;
  retries_freshness: Freshness;
  /** Whether the healer webhook is configured, so the button can say why not. */
  heal_configured: boolean;
}

export interface HealthMetrics {
  kind: 'health';
  computed_at: string;
  /** Null on All systems. */
  lane: string | null;
  scope: { incidents: number; open: number; retries: number };
  lanes: LaneRead[];
  open_incidents: { n: number; by_lane: Slice[]; note: string };
  healed: Share;
  needing_person: { n: number; exhausted: number; non_retryable: number; note: string };
  most_recent: { at: string | null; entity_id: string | null; summary: string | null; note: string };
  retries_24h: { n: number; recovered: number; retrying: number; exhausted: number; note: string };
  per_week_lane: HealthWeek[];
  per_week_class: HealthWeek[];
  week_note: string;
  by_lane: { key: string; label: string; open: number; retryable: number; note: string }[];
  by_lane_note: string;
  by_class: { key: string; label: string; n: number; retryable: boolean; known: boolean; what: string | null }[];
  class_note: string;
  by_severity: Slice[];
  severity_note: string;
  by_subsystem: Slice[];
  subsystem_note: string;
  top_faults: ErrorCount[];
  faults_note: string;
  time_to_resolve: Percentiles;
  reclassified: { n: number; of: number; pairs: { from: string; to: string; n: number }[]; note: string };
  /** Per-lane only: the failing node is the useful unit, not the workflow. */
  workflows: WorkflowFaults[];
  advice: Incident[];
  advice_note: string;
}

export interface RetryMetrics {
  kind: 'retries';
  computed_at: string;
  scope: { rows: number };
  recovery_rate: Share;
  retrying: number;
  exhausted: number;
  attempts_mix: Slice[];
  attempts_note: string;
  triggered_by: Slice[];
  triggered_note: string;
  by_class: Slice[];
  class_note: string;
  exhausted_note: string;
  retrying_note: string;
}

/** What a manual retry did. The same path an automatic one takes. */
export interface RetryResult {
  ok: boolean;
  incident_id: string;
  message: string;
}

/* -------------------------------------------------------- engine recovery */

/**
 * The recovery watcher (2026-09-23): an incident waiting on a dependency that
 * was down, re-run from its failed step once that dependency answers again.
 * See `server/src/recovery.ts`.
 */
export type RecoveryDependency = 'openrouter' | 'slack' | 'google' | 'bharag';
export type RecoveryStatus = 'waiting' | 'replaying' | 'recovered' | 'already_done' | 'chat_not_rerun' | 'failed_again' | 'data_gone';

export interface RecoveryRow {
  incident_id: string;
  lane: string | null;
  workflow: string | null;
  workflow_id: string | null;
  execution_id: string | null;
  failed_node: string | null;
  error_class: string | null;
  failed_at: string | null;
  dependency: RecoveryDependency;
  /** How the dependency was worked out, in a phrase: "error class", "credential slackApi", "host openrouter.ai". */
  dependency_from: string | null;
  status: RecoveryStatus;
  batch_id: string | null;
  retry_execution_id: string | null;
  note: string | null;
  replay_started_at: string | null;
  first_seen_at: string;
  updated_at: string;
  execution_url: string | null;
}

export interface DependencyState {
  ok: boolean | null;
  status: string | null;
  detail: string | null;
  /** OpenRouter only. */
  remaining_usd?: number | null;
  floor_usd?: number | null;
}

export interface RecoveryProbe {
  checked_at: string;
  dependencies: Record<RecoveryDependency, DependencyState>;
  /** Set where the probe itself could not be asked. */
  error: string | null;
}

export interface RecoveryRun {
  workflow: string;
  execution_id: string;
  outcome: Exclude<RecoveryStatus, 'waiting' | 'replaying'>;
  retry_execution_id?: string;
  note?: string;
}

export interface RecoveryBatch {
  batch_id: string;
  dependency: RecoveryDependency;
  started_by: string;
  started_at: string;
  settled_at: string | null;
  summary_sent_at: string | null;
  summary_http: number | null;
  summary_detail: string | null;
  /** The rows in the batch, in the shape the Slack summary carries. */
  runs: RecoveryRun[];
  /** How many of the batch's rows are still replaying. */
  pending: number;
}

/** An open incident the watcher looked at and is not waiting on anything for, and why. */
export interface RecoverySkip {
  incident_id: string;
  lane: string | null;
  workflow: string | null;
  error_class: string | null;
  reason: string;
}

export interface RecoveryPlan {
  at: string;
  enabled: boolean;
  /** Why it is off, where it is: the env override or the page toggle. */
  disabled_by: 'env' | 'toggle' | null;
  /** The page switch's own position, whatever the env override says. */
  switch_on: boolean;
  toggled_by: string | null;
  toggled_at: string | null;
  waiting: RecoveryRow[];
  replaying: RecoveryRow[];
  skipped: RecoverySkip[];
  /** Incidents open in the mirror that the watcher has not classified yet — the next tick reads their executions. */
  unclassified: string[];
  last_probe: RecoveryProbe | null;
  /** In words, what the next tick would do. Computed from what is held; nothing is called. */
  next_tick: string[];
  last_tick_at: string | null;
  interval_seconds: number;
}

export interface RecoveryData extends RecoveryPlan {
  /** Every row, newest first, settled ones included. */
  rows: RecoveryRow[];
  last_batch: RecoveryBatch | null;
  heal_configured: boolean;
  n8n_configured: boolean;
}

export interface RecoveryRerunResult {
  ok: boolean;
  incident_id: string;
  status: RecoveryStatus | null;
  message: string;
}

/* ------------------------------------------------------------ MCP writes */

/** One call to an MCP write tool (2026-09-24), refused and dry-run ones included. */
export interface McpWrite {
  id: number;
  at: string;
  access: 'read' | 'write' | null;
  tool: string;
  kind: string | null;
  record_id: string | null;
  natural_id: string | null;
  outcome: string;
  detail: string | null;
  dry_run: boolean;
  requester_user_id: string | null;
  /** The guard that refused, where one did. */
  reason: string | null;
}

export interface McpWritesData {
  writes: McpWrite[];
  /** Whether MCP_WRITE_TOKEN is set on this server. */
  write_configured: boolean;
}

/* -------------------------------------------------------------- pay ledger */

/**
 * Pay Tracker: who is owed money, for what work, and what has already been
 * paid.
 *
 * Built 2026-09-17 against a ledger created the same day. Before it, pay was a
 * tick on a Slack card, so answering "what do I owe Hardik for September" meant
 * scrolling back through weeks of messages.
 *
 * **This page counts work, not money.** There are no rates anywhere in the
 * system and none appear here; a figure with a currency sign on it would be
 * invented. If a rate is ever added it belongs in the Builders table first.
 *
 * **It is read-only.** Paid status is set by the Slack card or by a monthly
 * statement closing, and two places to change the same fact is how records
 * drift.
 *
 * **Monthly and daily are never summed into one rate.** They are different
 * agreements — a monthly builder is *expected* to wait until the 1st — and a
 * blended figure is meaningless.
 */

export interface PayBuilder {
  id: string;
  builder: string;
  slack_user_id: string | null;
  /** Monthly = one statement on the 1st. Daily = a card per session. */
  pay_mode: string | null;
  /** Unchecked rather than deleted, so history stays readable. */
  active: boolean;
  channel_id: string | null;
  notes: string | null;
  source: Source;
  airtable: AirtableRef;
}

export interface PaySession {
  id: string;
  codex_entry_id: string;
  builder: string;
  builder_slack_id: string | null;
  /** Frozen at approval. A later change to someone's pay mode does not rewrite this. */
  pay_mode: string | null;
  session_date: string | null;
  approved_at: string | null;
  /** YYYY-MM, from the session date. Never from `Approved At`. */
  month: string | null;
  /** True, false, or null where the row carries no Paid at all — not known, never read as unpaid. */
  paid: boolean | null;
  /** How this row reached the database: posted by the engine, or copied in by a resync. */
  held_via?: 'engine' | 'resync';
  paid_at: string | null;
  paid_by: string | null;
  statement_id: string | null;
  codex_link: string | null;
  slack_card_link: string | null;
  notes: string | null;
  source: Source;
  airtable: AirtableRef;
}

export interface PayStatement {
  id: string;
  statement_id: string;
  builder: string;
  builder_slack_id: string | null;
  month: string | null;
  /**
   * Distinct days with at least one approved session, and the count of
   * sessions. **Different numbers on purpose** — two sessions in one day is one
   * working day and two sessions — and neither is ever derived from the other.
   */
  working_days: number | null;
  session_count: number | null;
  /** Every session with its id and link. Shown in full; never truncated. */
  evidence: string | null;
  status: string | null;
  sent_at: string | null;
  payment_sent_at: string | null;
  confirmed_by: string | null;
  slack_link: string | null;
  notes: string | null;
  /** Whole days from Sent to Payment Sent, where both are recorded. */
  days_to_pay: number | null;
  /** Days since it was sent, while it is still open. */
  days_open: number | null;
  open: boolean;
  source: Source;
  airtable: AirtableRef;
}

/** One builder's outstanding work, which is the row the Owed tab is built from. */
export interface OwedBuilder {
  builder: string;
  slack_user_id: string | null;
  /**
   * Which table the builder is listed under: the roster's Pay Mode where they
   * are on it (2026-09-22), the sessions' own frozen mode otherwise. Each
   * session keeps its own mode; `mode_mismatch` counts the ones that differ.
   */
  pay_mode: string | null;
  mode_from: 'roster' | 'sessions';
  mode_mismatch: number;
  /** Sessions with no Paid flag at all — not known to be unpaid, and never added to `sessions_owed`. */
  sessions_unconfirmed: number;
  /** False where no Builders row matches this session's Slack id. */
  on_roster: boolean;
  /** False where the sessions carry no Slack id, which is why they group alone. */
  has_slack_id: boolean;
  active: boolean;
  sessions_owed: number;
  /** Distinct session dates among the unpaid sessions. Never the session count. */
  working_days_owed: number;
  oldest_unpaid: string | null;
  oldest_unpaid_days: number | null;
  months: string[];
  sessions: PaySession[];
}

export interface PayData {
  builders: PayBuilder[];
  sessions: PaySession[];
  statements: PayStatement[];
  freshness: Freshness;
  statements_freshness: Freshness;
  /** When this dashboard last read the ledger, and what that does and does not mean. */
  synced: { at: string | null; note: string };
  /**
   * Sessions held twice (2026-09-22): once from the Airtable resync of 20 Sep
   * and once as the engine posted them, under the same Codex Entry ID. Counted
   * once, the engine's copy preferred; `disagree` is pairs whose Paid differs.
   */
  duplicates: { rows: number; sessions: number; merged: number; disagree: number };
  /** When the engine last wrote a statement — null is never. */
  statements_last_write: string | null;
}

export interface PayMetrics {
  kind: 'pay';
  computed_at: string;
  scope: { sessions: number; unpaid: number; builders: number; statements: number };
  /** The month the figures are for, or the current month when every month is. */
  month: string;
  /** The month asked for; null is every month. */
  selected: string | null;
  /** Every month a session or statement is held for, newest first. */
  months_held: string[];
  /**
   * What is outstanding in months other than the selected one — never scoped
   * away, because a picker that hid last month's unpaid work on the 1st would
   * hide the thing payday is for. Nought with every month selected.
   */
  outside: { sessions_owed: number; sessions_unconfirmed: number; months: string[] };
  /* ---- owed ---- */
  /** `no_mode` is sessions carrying neither mode, so the split adds up to `n`. */
  sessions_owed: { n: number; monthly: number; daily: number; no_mode: number; note: string };
  /** Sessions carrying no Paid flag, counted apart from owed (2026-09-22). */
  sessions_unconfirmed: { n: number; monthly: number; daily: number; from_resync: number; note: string };
  builders_owed: { n: number; monthly: number; daily: number; no_mode: number; note: string };
  oldest_unpaid: { days: number | null; builder: string | null; codex_entry_id: string | null; pay_mode: string | null; note: string };
  this_month: { n: number; monthly: number; daily: number; no_mode: number; note: string };
  owed: OwedBuilder[];
  /* ---- statements ---- */
  open_statements: { n: number; chasing: number; note: string };
  settled_this_year: { n: number; year: string; note: string };
  statement_time_to_pay: Percentiles;
  /** In the base's own order, for the Statements tab's filters. */
  statement_status_mix: Slice[];
  oldest_open_statement: { statement_id: string | null; days: number | null; note: string };
  /* ---- statistics ---- */
  per_month: { month: string; label: string; total: number; counts: Record<string, number> }[];
  per_month_note: string;
  paid_per_week: { week: string; label: string; total: number; counts: Record<string, number> }[];
  paid_week_note: string;
  working_days: { builder: string; pay_mode: string | null; months: { month: string; working_days: number; sessions: number }[]; total_days: number; total_sessions: number }[];
  working_days_note: string;
  paid_by: Slice[];
  paid_by_note: string;
  /** Split, never blended: the two populations are not comparable. */
  time_to_pay: { mode: string; p: Percentiles }[];
  time_to_pay_note: string;
  ageing: Slice[];
  ageing_note: string;
  /** Sessions whose Slack id matches nobody on the roster. Should be nought. */
  no_roster_match: { n: number; of: number; sessions: PaySession[]; note: string };
}

/* --------------------------------------------------------------- clients */

/**
 * When this database last changed a row and what changed it (2026-09-22). A
 * client lane can sit on a resync for days with nothing on the page saying so;
 * this is what lets a stale lane read as stale.
 */
export interface HeldStamp {
  updated_at: string;
  /** `engine` = n8n posted it; `resync` = copied from Airtable; `page` = edited here. */
  via: 'engine' | 'resync' | 'page';
}

export interface ClientLane {
  /** Filled by the store from the mirror row; absent where a lane is built elsewhere. */
  held?: HeldStamp;
  id: string;
  name: string;
  lane_id: string | null;
  lane_type: string | null;
  client_id: string | null;
  questions_table_name: string | null;
  /** The table this lane's questions live in, read from the index row. */
  questions_table: string | null;
  lane_status: string | null;
  run_state: string | null;
  last_run_at: string | null;
  next_run_due: string | null;
  last_run_status: string | null;
  consecutive_errors: number;
  infra_fix_required: boolean;
  first_stuck_at: string | null;
  stuck_cycles: number;
  quarantined: boolean;
  commercial_hook: string | null;
  interested_parties: string | null;
  latest_memo: string | null;
  source: Source;
  airtable: AirtableRef;
}

export interface ClientQuestion {
  held?: HeldStamp;
  id: string;
  lane_id: string;
  table: string;
  question: string;
  answer: string | null;
  plain_summary: string | null;
  confidence: string | null;
  sources: string | null;
  movement_tag: string | null;
  answer_history: string | null;
  last_updated: string | null;
  missing_research: boolean;
  research_stuck: boolean;
  next_experiments: string | null;
  run_count: number;
  source: Source;
  airtable: AirtableRef;
}

/**
 * One thing a client has asked for.
 *
 * A new table in the client research base (`Client Requests`,
 * `tblhu29KejAPQfSuy`), created on 17 Sep 2026 for
 * LOOP-1789590960971-EHF9. Its whole point is stated in its own description:
 * **a request stays Requested or Under Review until every Open Check is
 * cleared**, so that interest is never mistaken for a commitment. That is the
 * one thing this dashboard has to render faithfully — a page that showed four
 * requests and no open checks would be reporting four commitments.
 *
 * It is **not read by the weekly Research Loop**. It hangs off the same Client
 * ID as the index, which is what lets it sit under the client that asked.
 */
export interface ClientRequest {
  held?: HeldStamp;
  id: string;
  /** Short name of what was asked for. */
  request: string;
  client_id: string | null;
  lane_id: string | null;
  category: string | null;
  status: string | null;
  /** What must be confirmed before this can move to Confirmed. Empty is "nothing outstanding". */
  open_checks: string[];
  details: string | null;
  raised_by: string | null;
  date_requested: string | null;
  notes: string | null;
  source: Source;
  airtable: AirtableRef;
}

/** A lane with its questions counted. */
export interface ClientLaneRow extends ClientLane {
  questions: number;
  active_questions: number;
  needs_human: number;
  missing_research: number;
  /** Questions already at three runs: the weekly clock skips them and a person is owed. */
  capped: number;
  /**
   * `Next Run Due` is in the past. That field is what the weekly clock reads,
   * so it is what says a lane is late — not the age of the last run, which only
   * says how long ago something happened.
   */
  /** The newest change to this lane or any of its questions, and how it arrived. */
  last_update: HeldStamp | null;
  overdue: boolean;
  /** How many days past `Next Run Due`, or null when the lane has no due date. */
  days_overdue: number | null;
  /** An index row with a lane status but no run yet: warming up, not failing. */
  warming_up: boolean;
}

/** One client, with every lane beneath it. */
export interface ClientGroup {
  client_id: string;
  /** "Client 2", from the index row's own Client ID. Never a lane's full name. */
  label: string;
  /** The number inside the Client ID, so the page can order 2, 9, 12 rather than 002, 009, 012. */
  number: number | null;
  lanes: ClientLaneRow[];
  questions: number;
  needs_human: number;
  /** What this client has asked for, newest first. */
  requests: ClientRequest[];
  /** Requests not yet Confirmed, Delivered or Declined — still interest, not commitment. */
  open_requests: number;
}

export interface ClientsData {
  clients: ClientGroup[];
  lanes: ClientLaneRow[];
  questions: ClientQuestion[];
  requests: ClientRequest[];
  freshness: Freshness;
  /**
   * How old the request rows are, separately from the lanes'. The two tabs read
   * two different tables and a line saying "4 rows" above one while counting
   * the other is exactly the kind of quietly-wrong figure this dashboard exists
   * to remove.
   */
  requests_freshness: Freshness;
  /** Lanes whose index row names no questions table, so nothing could be read. */
  unreadable: { lane_id: string | null; name: string; reason: string }[];
  /**
   * The last time n8n itself wrote each of the three kinds, from the write log
   * (2026-09-22). Null is never — distinct from a row's own stamp, which a
   * resync overwrites.
   */
  engine_last_write: { lanes: string | null; questions: string | null; requests: string | null };
}

/* --------------------------------------------------------------- records */

/**
 * Every kind the server holds, one per mirror table the engine writes.
 * 'client_questions' is a child of 'clients': the index row names its own
 * questions table and the lane it belongs to, and each question row carries
 * both.
 */
/**
 * `ns` and `rt` are the two twins' **ask ledgers** since 17 Sep 2026, and
 * `rt_jobs` is Research Twin's research queue. The legacy tables those first
 * two names used to mean are neither read nor written anywhere in this code.
 */
export type RecordKind = 'loops' | 'codex' | 'patterns' | 'commercial' | 'ns' | 'rt' | 'rt_jobs' | 'clients' | 'client_questions' | 'client_requests';

export interface Metric {
  /** Null when nothing records what this needs; `note` then says what is missing. */
  value: number | null;
  /** The comparison figure (last week), where the metric has one. */
  compare?: number | null;
  note: string | null;
}

/** A series the data supports, or the reason it does not. */
export interface MetricSeries {
  points: SeriesPoint[] | null;
  note: string | null;
}

/**
 * Open loops. Every figure here is computed by the server from the rows it
 * holds, and every one the rows cannot support is null with its reason. The
 * loop tables carry no close date and no last-modified time; that single fact
 * decides most of the nulls.
 */
export interface LoopMetrics {
  kind: 'loops';
  computed_at: string;
  scope: { builder: string | null; rows: number };

  open: number;
  in_progress: number;
  closed: number;
  /** Closed as a share of all loops in the builder's table, today. Not a rate over time. */
  close_rate_by_builder: { owner: string; closed: number; total: number; rate: number | null }[];
  close_rate_note: string;
  closed_per_day: MetricSeries;
  /** Newest first: 0–7 days, then older. */
  age_distribution: { bucket: string; n: number }[];
  raised_per_week: MetricSeries;
  /** Raised minus closed per week; closed is by last_modified, meaningful only after 9 Sept 2026. */
  net_per_week: MetricSeries;
  closed_per_week: MetricSeries;
  stale: { count: number | null; meaningful_from: string; note: string };
  /**
   * Who raises loops, one row per person. Raised By is free text, so the
   * spellings of one name are collapsed to a single identity before counting;
   * `variants` names the spellings that were merged, so the merge is visible
   * rather than silent.
   */
  top_raisers: { key: string; label: string; n: number; variants: string[] }[];
  top_raisers_note: string;
  /** The caveat every last_modified-derived figure carries. */
  modified_note: string;
  history_since: string | null;
  /** Present on the unscoped response only: the same figures per builder, so a tab change needs no request. */
  by_builder?: Record<string, LoopMetrics>;
}

export interface CodexMetrics {
  kind: 'codex';
  computed_at: string;
  scope: { builder: string | null; rows: number };
  entries: number;
  /** The three stages, each with the rule it applies and the layer it belongs to. */
  /** The three stages, approved first. `layer` is the step's name; the rule for each lives in CLAUDE.md, not on screen. */
  tabs: { tab: CodexTab; label: string; layer: string; n: number }[];
  /** The three stages against the total, so the figures visibly reconcile. */
  stage_reconciliation: { rows: number; sums_to: number; note: string };
  /** Submissions carrying a generated Layer 2 codex. */
  with_entry: { n: number; note: string };
  /** Layer 0: the gate's own flag, not a check this dashboard invents. */
  layer0: { flagged: number; clean: number; definition: string; note: string };
  /** Which elements the gate found missing, across every flagged row. */
  missing_mix: { element: string; n: number }[];
  /** Submissions parked at the gate with no builder-table row yet. */
  holds: { open: number; completed: number; note: string };
  /** Jason Status across every row. */
  approval_mix: { approval: CodexApproval; label: string; n: number }[];
  approval_note: string;
  per_builder_per_week: { owner: string; weeks: { week: string; start: string; label: string; short: string; n: number }[] }[];
  narration_quality_mix: { quality: string; n: number }[];
  narration_quality_note: string;
}

export interface PatternMetrics {
  kind: 'patterns';
  computed_at: string;
  /** `month` is the month the page is showing, or null for all time. */
  scope: { rows: number; month: string | null };
  /** Distinct pattern_id values against the row count: a count of rows is not a count of patterns. */
  duplicates: { distinct_ids: number; duplicate_rows: number; ids: { pattern_id: string; n: number }[]; note: string };
  /**
   * Narrow / Moderate / Broad, and the rows that answer in a sentence instead.
   * The one field on this table with variation worth grouping by — which is why
   * it is the only grouping left on the page.
   */
  reusability_mix: { reusability: string; n: number }[];
  reusability_note: string;
  /**
   * How much of the engine has patterns written up, from the system segment of
   * each pattern's own id — BHARAG in BP-BHARAG-114. A count of rows says how
   * much was written; this says how widely.
   */
  systems: { n: number; names: string[]; unfiled: number; note: string };
  created_per_week: MetricSeries;
}

export interface CommercialMetrics {
  kind: 'commercial';
  computed_at: string;
  /** `month` is the month the page is showing, or null for all time. */
  scope: { rows: number; month: string | null };
  cards: number;
  /** Cards carrying no open research question — the closest-to-ready end of the table. */
  clear: number;
  /** Cards at readiness_state Media-Ready. A figure, never a tab: 19 of 21 are Research-First. */
  media_ready: number;
  confidence_mix: { confidence: string; n: number }[];
  media_readiness_mix: { media_readiness: string; n: number }[];
  /**
   * Cards by the week of `created_at` — the weeks covering the month in view,
   * or the last eight weeks when the page is showing all time. The same card
   * Build patterns carries, so the two pages read as one shape.
   */
  created_per_week: MetricSeries;
  unresolved_questions: Metric;
  unresolved_trend: MetricSeries;
  /**
   * Cards missing the fields the extractor writes on every complete run. Not a
   * bucket and not a state — one malformed record, surfaced as incomplete so it
   * is not read as a category of its own.
   */
  incomplete: { n: number; cards: { id: string; card_id: string | null; missing: string[] }[]; note: string };
}

export type RecordMetrics = LoopMetrics | CodexMetrics | PatternMetrics | CommercialMetrics | NsMetrics | RtMetrics | RtJobMetrics;

/* ------------------------------------------------------------- registry */

/**
 * The System Registry. Six small tables this dashboard owns outright — there is
 * no Airtable base behind them, so unlike every other record kind here these
 * rows are created and edited in the interface and nowhere else.
 *
 * Every field is nullable on purpose. A value nobody has supplied stays null
 * and renders as "—"; the page never fills a gap with something plausible, and
 * the spend total states how many services are unpriced beside the figure.
 */
export type RegistryKind = 'workflows' | 'services' | 'credentials' | 'endpoints' | 'bases' | 'people';

/**
 * The kinds the registry page reads and writes.
 *
 * `credentials` is a kind the server still knows — the table is not dropped,
 * because nothing drops a table — but there is no credentials registry
 * (decision 2026-09-14, Destiny), so it is not served and the page cannot name
 * it. Keeping the two apart is what makes that a type error rather than an
 * undefined at runtime.
 */
export type ShownKind = Exclude<RegistryKind, 'credentials'>;

interface RegistryBase {
  id: string;
  created_at: string;
  updated_at: string;
  /** Soft delete. A row keeps its id and its history; it just stops being listed. */
  deleted_at: string | null;
  notes: string | null;
}

export type WorkflowStatus = 'production' | 'experimental' | 'retired';

export interface RegistryWorkflow extends RegistryBase {
  /** The n8n workflow id, which is also this row's primary key. */
  name: string;
  system: string | null;
  folder: string | null;
  pillar: string | null;
  owner: string | null;
  trigger_type: string | null;
  trigger_detail: string | null;
  status: WorkflowStatus | null;
  purpose: string | null;
  n8n_url: string | null;
  /** Whether the recovery watcher re-runs this workflow's failures (2026-09-23). `never` for chat replies. */
  replay: 'auto' | 'never';
}

export type ServiceStatus = 'active' | 'trial' | 'retired';
export type ServiceCategory = 'hosting' | 'automation' | 'data' | 'ai' | 'comms' | 'storage' | 'other';
export type BillingCycle = 'monthly' | 'quarterly' | 'yearly' | 'one-off';

export interface RegistryService extends RegistryBase {
  name: string;
  category: ServiceCategory | null;
  what_it_is_for: string | null;
  url: string | null;
  managed_by: string | null;
  plan: string | null;
  billing_owner: string | null;
  cost_amount: number | null;
  cost_currency: string | null;
  billing_cycle: BillingCycle | null;
  /** YYYY-MM-DD, or null when nobody has recorded one. */
  renewal_date: string | null;
  status: ServiceStatus | null;
}

/** Names and ownership only. No secret value is stored here, ever. */
export interface RegistryCredential extends RegistryBase {
  name: string;
  type: string | null;
  /** Workflow ids this credential was found on. Empty means none was found, not that none exists. */
  used_by: string[];
  owner: string | null;
}

export interface RegistryEndpoint extends RegistryBase {
  name: string;
  url: string;
  method: string | null;
  auth_type: string | null;
  owned_by_service: string | null;
  what_calls_it: string | null;
}

export interface RegistryBaseRow extends RegistryBase {
  name: string;
  what_it_is_for: string | null;
  url: string | null;
}

export interface RegistryPerson extends RegistryBase {
  name: string;
  slack_user_id: string | null;
  email: string | null;
  role: string | null;
  lanes_owned: string[];
}

/**
 * Monthly spend, computed by the server from the rows it holds.
 *
 * `totals` is one figure per currency and never a sum across them. The three
 * counts beside it are what stop an incomplete total reading as a complete
 * one, and the page prints them next to the number rather than under it.
 */
export interface SpendTotal {
  currency: string;
  monthly: number;
  services: number;
}

export interface Spend {
  totals: SpendTotal[];
  active: number;
  priced: number;
  unpriced: number;
  /** Priced, but one-off or with no cycle, so not part of a monthly figure. */
  not_monthly: number;
  /** Which services those are, so the card can name what is left to fill in. */
  not_monthly_ids: string[];
  renewing_soon: string[];
  overdue: string[];
  with_renewal_date: number;
  /** The server's date, so one clock decides what "within thirty days" means. */
  today: string;
}

/**
 * The live figures beside a person on the Builders registry, read from the
 * record tables. Null is not zero: Jason has an Open Loops table but no
 * submissions table, so his entries this week is null rather than 0, and the
 * oldest of no open loops is not zero days.
 */
export interface BuilderFigures {
  id: string;
  open_loops: number | null;
  oldest_loop_days: number | null;
  entries_this_week: number | null;
}

export interface RegistryData {
  workflows: RegistryWorkflow[];
  services: RegistryService[];
  endpoints: RegistryEndpoint[];
  bases: RegistryBaseRow[];
  people: RegistryPerson[];
  /** Keyed to a person's id, which is the builder id the record tables use. */
  builders: BuilderFigures[];
  spend: Spend;
  /** Digests flagged missing in the last seven days. See DigestHealth. */
  digest_health: DigestHealth;
  includes_deleted: boolean;
}

/** What a row of each kind looks like, keyed by the kind that holds it. */
export interface RegistryRowOf {
  workflows: RegistryWorkflow;
  services: RegistryService;
  credentials: RegistryCredential;
  endpoints: RegistryEndpoint;
  bases: RegistryBaseRow;
  people: RegistryPerson;
}

/* --------------------------------------------------------- engine writes */

/**
 * What the engine has written, and what each record table holds.
 *
 * The Airtable sync went on 13 September 2026 (step 3) and these tables are
 * the record now — every page reads them directly. So these shapes answer the
 * question that replaced "do the two agree": is the engine still writing this
 * kind at all, and is anything being refused.
 */
export interface MirrorHeld {
  kind: string;
  label: string;
  table: string;
  rows: number;
  /** Written last by the migration backfill that read Airtable. Can only shrink from here. */
  from_airtable: number;
  /** Written last by n8n posting to /api/engine. Still zero means the kind is not wired yet. */
  from_engine: number;
  /** Written last by someone changing the row on a page. */
  from_ui: number;
  latest: string | null;
}

export interface EngineWriteRow {
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

export interface EngineWrites {
  total: number;
  window_hours: number;
  tally: Record<string, number>;
  recent: EngineWriteRow[];
  first_at: string | null;
  last_at: string | null;
  held: MirrorHeld[];
  /** Whether DASHBOARD_INBOUND_KEY is set. Without it the engine cannot write at all. */
  configured: boolean;
}

/**
 * Digest delivery health. `rows` is load-bearing: with nothing read in yet,
 * `missing: 0` would read as "no digest went missing", which is a different
 * claim from "nothing is recorded".
 */
export interface DigestHealth {
  rows: number;
  window_days: number;
  sent: number;
  delivered: number;
  missing: number;
  latest_sent_at: string | null;
}

/* ---------------------------------------------------------- monthly rollups */

/**
 * How much of a month the metric was actually instrumented for.
 *
 * This is the whole point of the monthly charts. Several of the date fields
 * behind them only started being written recently, and a month that renders as
 * a low bar because the data did not exist yet reads as a quiet month rather
 * than as a gap in instrumentation — which is worse than no chart at all.
 *
 *   full     the metric was recording for the whole month
 *   partial  it was recording for part of it, or the records are known to
 *            undercount; the bar is drawn and marked
 *   none     nothing was recording; **no bar is drawn**, the boundary is
 *            labelled instead
 */
export type MonthCoverage = 'full' | 'partial' | 'none';

export interface MonthPoint {
  /** YYYY-MM. */
  month: string;
  /** "Jul", and "Jul 26" where the series crosses a year. */
  label: string;
  created: number;
  /** Closed, approved, resolved — whatever this page's `advanced_label` says. */
  advanced: number;
  rate: number | null;
  /** How well `created` was instrumented in this month. */
  coverage: MonthCoverage;
  /**
   * How well `advanced` was, which is often not the same thing. A loop's
   * raised date has always existed; the date it closed exists only from the
   * day this database started keeping the status ledger. One month can
   * therefore have a trustworthy raised count and no closed count at all, and
   * drawing that as "closed: 0" would be the lie this whole shape exists to
   * prevent.
   */
  advanced_coverage: MonthCoverage;
  /** Why this month is partial or absent. Null when it is full. */
  note: string | null;
  /**
   * Rows dated into this month whose row arrived materially later — a bulk
   * import backdating its own records. Counted so a month of imported history
   * cannot be read as a month of output.
   */
  backfilled: number;
  /** Clients only: the movement-tag mix inside the month. */
  segments: Record<string, number> | null;
}

export interface MonthlyBoundary {
  /** The first month the metric can be trusted. */
  month: string;
  /** What began then, and why nothing before it counts. */
  note: string;
}

/**
 * A second metric on the same page with its own, later boundary — Codex's days
 * to approval, which only exists from the day `Jason Reviewed At` was created.
 */
export interface MonthlySecondary {
  label: string;
  unit: string;
  points: { month: string; label: string; value: number | null; n: number; coverage: MonthCoverage }[];
  boundary: MonthlyBoundary;
  note: string;
}

export interface MonthlySeries {
  kind: RecordKind;
  created_label: string;
  /** The source field, spelled as the source spells it, so the rule stays checkable. */
  created_field: string;
  /** Null on a kind with nothing to advance to — patterns do not close. */
  advanced_label: string | null;
  advanced_field: string | null;
  rate_label: string | null;
  months: MonthPoint[];
  boundary: MonthlyBoundary | null;
  /** Records with no usable date: counted and named, never dropped or re-bucketed. */
  undated: { n: number; ids: string[]; note: string };
  secondary: MonthlySecondary | null;
  /** Clients only: the movement tags, in the order they are drawn. */
  segment_keys: string[] | null;
  /** The month the page opens on — the newest with any data, or this one. */
  current: string;
}

/* ------------------------------------------------------ execution tracking */

/**
 * Executions are stored **one row per execution**, keyed on n8n's own id, and
 * every figure below is a query over those rows rather than a counter kept
 * alongside them (decision 2026-09-15, Destiny — the second one that day).
 *
 * The counters that came first were wrong on the live page in three ways at
 * once — every total sixty times what n8n held, failures at nought, seven
 * workflows of thirty-one — and all three were one paging bug being added up
 * repeatedly. None of them is expressible against rows: re-reading an execution
 * is an upsert on its primary key, and a failure is a row whose status says so.
 *
 * The rows are copied out of n8n so the record does not depend on another
 * system's retention policy. Nothing here asserts what that policy is: the
 * instance's history begins on 12 Sep 2026 because that is when it was
 * migrated, and no execution has been observed ageing off.
 */

/** Everything every execution figure carries, whether it is a period, a system or one workflow. */
export interface ExecutionTotals {
  executions: number;
  succeeded: number;
  failed: number;
  /** A person stopping a run is not a fault, so it is counted apart from failures. */
  canceled: number;
  /** Still running, or waiting. Not yet a success and not yet a failure. */
  unfinished: number;
  /** succeeded + failed + canceled — the denominator the failure rate uses. */
  finished: number;
  /** Failures over finished runs. Null where nothing has finished. */
  failure_rate: number | null;
  /** Mean wall-clock time in milliseconds, over `timed` runs. Null where none recorded an end. */
  avg_ms: number | null;
  /** How many runs carried both a start and an end, so the mean can be checked. */
  timed: number;
}

/** One workflow's executions inside the period in view. */
export interface ExecutionWorkflow extends ExecutionTotals {
  workflow_id: string;
  workflow_name: string;
  /** From the workflow registry, by join at read time. Null where no row claims it. */
  system: string | null;
  /** Whether a registry row names this workflow at all. */
  registered: boolean;
  /** The failing execution ids, newest first, so each one opens in n8n. */
  failed_ids: string[];
  n8n_url: string | null;
  /**
   * The workflow's last ten finished runs, whenever they ran, and when it last
   * failed (2026-09-22). Beside the period's failure rate so a workflow that has
   * been fixed does not read as broken for the rest of the month. Null where
   * nothing has finished.
   */
  recent: { runs: number; failed: number; last_failure_at: string | null; succeeded_since_failure: number; last_run_at: string | null } | null;
}

/** Which calendar grain the page is reporting on. */
export type ExecutionGrain = 'week' | 'month' | 'year';

/** One period's totals. `key` is 2026-W38, 2026-09 or 2026, by grain. */
export interface ExecutionPeriod extends ExecutionTotals {
  key: string;
  label: string;
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  end: string;
  coverage: MonthCoverage;
  note: string | null;
  /** True for the period that has not finished yet. */
  current: boolean;
}

/**
 * One figure against the same figure last period.
 *
 * `better` is whether the movement is good news, which is not the same as up:
 * more executions is up and neutral, more failures is up and bad, a faster
 * average is down and good. Null where the direction carries no judgement.
 */
/**
 * One figure against the same figure a period ago.
 *
 * `better` is whether the movement is good news, which is not the same as up:
 * more executions is neither, more failures is bad, a faster average is good.
 * Null where the direction is not news, and the page colours nothing there.
 */
export interface Delta {
  from: number;
  to: number;
  /** Percentage change, or null where the previous figure was nought and a ratio has no meaning. */
  pct: number | null;
  direction: 'up' | 'down' | 'flat';
  better: boolean | null;
}

/** The Executions page's own name for it, kept so that page reads as it did. */
export type ExecutionDelta = Delta;

export interface ExecutionComparison {
  /** The period compared against, and what it is called. */
  against: string;
  against_label: string;
  executions: ExecutionDelta | null;
  successes: ExecutionDelta | null;
  failures: ExecutionDelta | null;
  /** In percentage points, not a ratio of a ratio. */
  failure_rate: ExecutionDelta | null;
  avg_ms: ExecutionDelta | null;
  /**
   * True when the period in view is still running and the previous one was cut
   * to the same elapsed point, so the totals are comparable.
   */
  like_for_like: boolean;
  /** False where the window being compared against predates everything held, and no delta is given. */
  covered: boolean;
  /**
   * The comparison in words — "executions up 12%, failures down 40%, average
   * run time 3% faster". Written on the server so the page and the downloaded
   * report cannot word the same comparison differently.
   */
  prose: string;
  /** What the comparison is against, and why it is cut or refused. */
  note: string;
}

/** One system's executions at one grain. `all` is every system together. */
export interface ExecutionSystem extends ExecutionTotals {
  /** The registry's own `system` value, which is the join key. `unregistered` is everything no row claims. */
  system: string;
  /** What the page calls it — "North Star", not "North Star Twin". */
  label: string;
  periods: ExecutionPeriod[];
  /**
   * The weeks inside the period in view, tallied from the same day rows as the
   * period's own totals — so a month and the weeks drawn under it cannot
   * disagree. The first and last are cut to the period.
   */
  weeks: ExecutionPeriod[];
  /** The period in view, which every figure on the page follows. */
  period: ExecutionPeriod;
  workflows: ExecutionWorkflow[];
  comparison: ExecutionComparison;
}

export interface ExecutionsData {
  grain: ExecutionGrain;
  /** The period in view. Selecting one on the chart re-reads at that key. */
  period: string;
  systems: ExecutionSystem[];
  /** The first period held whole. What came before it is not here, and is drawn as absent rather than nought. */
  boundary: MonthlyBoundary | null;
  /** Where the rows came from, when they were last read, and how far back they go. */
  source: {
    /** When the poll last completed. */
    at: string | null;
    configured: boolean;
    /** How often new executions are read. A poll: n8n has nothing to push. */
    poll_seconds: number;
    n8n_base: string | null;
    /** How many executions this database holds, and the span they cover. */
    held: number;
    oldest: string | null;
    newest: string | null;
    highest_id: string | null;
    note: string;
    /** Anything that made the last pass less than complete. Null when it was clean. */
    warning: string | null;
  };
}

/** One execution, as the drill-down lists it. */
export interface ExecutionRun {
  execution_id: string;
  /** n8n's own word: success, error, crashed, canceled, running, waiting, new, unknown. */
  status: string;
  /** How it was started — webhook, trigger, integrated, manual. */
  mode: string | null;
  started_at: string;
  stopped_at: string | null;
  /** Null, never nought, where the run recorded no end. */
  duration_ms: number | null;
}

/**
 * What a read of n8n did, whether it was the poll or a backfill by hand.
 *
 * `warning` is the one field worth reading first: a stalled cursor or a page
 * ceiling means the pass saw less than everything, and a pass that saw less
 * than everything must say so rather than reporting what it managed as though
 * it were the whole.
 */
export interface ExecutionBackfill {
  ran: boolean;
  at: string;
  ms: number;
  read: number;
  inserted: number;
  updated: number;
  resolved: number;
  open: number;
  highest: number | null;
  pages: number;
  full: boolean;
  /** How many executions this database holds after the pass, and how many n8n says it holds. */
  held: number;
  reported: number | null;
  note: string;
  warning: string | null;
}

/**
 * One workflow opened up: its own days inside the period, and its individual
 * executions. This is what a counter could never answer, and the reason the
 * rows are stored.
 */
export interface ExecutionWorkflowDetail {
  workflow: ExecutionWorkflow;
  grain: ExecutionGrain;
  period: { key: string; label: string; start: string; end: string };
  days: (ExecutionTotals & { day: string })[];
  /** Newest first, capped. `runs_total` says how many there were. */
  runs: ExecutionRun[];
  runs_total: number;
  n8n_base: string | null;
}

/* ------------------------------------------------- vFarm Early Access */

/**
 * What somebody did about a lead. This dashboard's own note to itself — it is
 * not a subscriber state, a payment state or an entitlement, and the funnel
 * records none of those.
 */
export type VfarmLeadStatus = 'new' | 'contacted' | 'qualified' | 'archived';

export const VFARM_LEAD_STATUSES: VfarmLeadStatus[] = ['new', 'contacted', 'qualified', 'archived'];

/**
 * One expression of interest in vFarm Early Access, as the static site sent it.
 *
 * Born in this dashboard rather than mirrored from anywhere: the site posts to
 * this server's one public route and this is the only copy. `ip_hash` is
 * deliberately absent — it is a rate-limiting artefact and has no way onto the
 * page.
 */
export interface VfarmLead {
  id: string;
  full_name: string;
  email: string;
  organization_name: string | null;
  source_surface: string;
  source_page: string | null;
  source_campaign: string | null;
  page_contract_version: string | null;
  mechanics_contract_version: string | null;
  claim_state: string | null;
  status: string;
  notes: string | null;
  /** When the Slack notification landed. Null means this one was never announced. */
  notified_at: string | null;
  submitted_at: string | null;
  created_at: string;
  user_agent: string | null;
  /**
   * Attribution the site captured from the URL the visitor arrived on.
   *
   * '' means the link did not carry that value; null means the row predates
   * the columns. The two are different facts and the page shows them
   * differently.
   */
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  asset_id: string | null;
  source_channel: string | null;
  landing_variant: string | null;
  contract_version: string | null;
  /**
   * Everything Form A asked, keyed by the question's own text, and the n8n
   * tracker's identifiers (2026-09-23). Null on a lead the old public route
   * wrote, which predates Form A reaching this dashboard.
   */
  form_a: {
    answers: Record<string, unknown>;
    early_access_lead_id: string | null;
    buyer_intake_id: string;
    correlation_id: string | null;
    source_campaign: string | null;
    submitted_at: string | null;
  } | null;
  /** This address was already on an earlier row. Computed at read time, never stored. */
  is_repeat_email: boolean;
}

export interface VfarmLeadsData {
  leads: VfarmLead[];
  summary: {
    total: number;
    last_7_days: number;
    last_30_days: number;
    by_status: Record<string, number>;
  };
}

/* ------------------------------------------------------ pattern candidates */

/**
 * An idea Bays flagged from real work before it became a registered build
 * pattern (2026-09-23). One row of engine_pattern_candidates, whose `fields`
 * carry the Airtable table's own names verbatim; these are those fields, and
 * nothing is derived except the id.
 */
export interface PatternCandidate {
  /** natural_id (CAND-<ms>-<4>), else the Airtable record id, else the row id. */
  id: string;
  candidate: string | null;
  summary: string | null;
  lane: string | null;
  /** Proposed, Approved or Registered — as written; an unknown value keeps its own name. */
  status: string | null;
  builder: string | null;
  builder_slack_id: string | null;
  suggested_architect: string | null;
  architect_slack_id: string | null;
  why_this_architect: string | null;
  flagged_by: string | null;
  source_link: string | null;
  /** YYYY-MM-DD as the row carries it. */
  date_flagged: string | null;
  /** Set only on Registered rows. */
  pattern_id: string | null;
  registered_at: string | null;
}

export interface PatternCandidatesData {
  candidates: PatternCandidate[];
  /** Rows in the table, and when any of them last changed here. */
  held: number;
  updated_at: string | null;
}
