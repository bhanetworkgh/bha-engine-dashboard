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
  /** Whether AIRTABLE_API_KEY is set, and where the client points (a local replay in a sandbox). */
  airtable_configured: boolean;
  airtable_url: string;
  /** Whether DASHBOARD_INBOUND_KEY is set, so n8n can push writes. */
  inbound_configured: boolean;
  /** Minutes between timed resyncs; 0 when disabled. */
  resync_minutes: number;
  sync: Record<RecordKind, SyncInfo>;
}

/* ---------------------------------------------------------------- status */

export interface EngineStatus {
  last_refresh: string;
  health: Health;
  /** Why it is degraded or failing. Null when healthy. */
  note: string | null;
  open_incidents: number;
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
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface OverviewSeries {
  /** Loops raised per day over the last fourteen days, from raised_at. */
  loops_raised_14d: SeriesPoint[];
  /** Incidents opened per day over the last seven days, from opened_at. */
  incidents_7d: SeriesPoint[];
  /** Codex entries per ISO week. */
  entries_by_week: SeriesPoint[];
  /** Asks across both twins by outcome. */
  asks_by_outcome: { answered: number; thin: number; failed: number };
  /** Open loops per owner, table totals. */
  loops_by_owner: { owner: string; open: number; in_progress: number; oldest_days: number }[];
  /** Incidents by error class. */
  incidents_by_class: { error_class: ErrorClass; n: number; open: number }[];
  /** Incidents by state, in state-machine order. */
  incidents_by_state: { state: IncidentState; n: number }[];
}

export interface OverviewRates {
  self_heal: { value: number; total: number };
  answered: { value: number; total: number };
  ingested: { value: number; total: number };
  retries: { value: number; total: number };
}

export interface OverviewEvent {
  id: string;
  at: string;
  title: string;
  detail: string;
  health: Health;
  spine: Spine;
  source: Source;
}

export interface OverviewData {
  pins: OverviewPin[];
  tiles: OverviewTile[];
  broke_24h: OverviewEvent[];
  moved_24h: OverviewEvent[];
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

export interface SensorReading {
  id: string;
  at: string;
  place: string;
  ph: number | null;
  temp_c: number | null;
  humidity_pct: number | null;
  health: Health;
  source: Source;
}

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

export interface LifecycleEvent {
  id: string;
  at: string;
  type:
    | 'burn_in_cycle_started'
    | 'burn_in_anomaly'
    | 'growth_cycle_started'
    | 'growth_cycle_measurement_logged';
  detail: string;
  spine: Spine;
  source: Source;
}

export interface VFarmData {
  /** Live half: sensor rollups plus alerts. */
  readings: SensorReading[];
  alerts: VFarmAlert[];
  places: { name: string; last_seen: string; health: Health }[];
  /** Not-yet-emitting half. Empty, with a reason. */
  lifecycle: LifecycleEvent[];
  lifecycle_note: string;
  readiness_note: string;
  days_to_halloween: number;
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

export interface Incident {
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

export interface EngineHealthData {
  incidents: Incident[];
  metrics: {
    self_heal_rate: string;
    retries_attempted: number;
    retries_succeeded: number;
    mean_time_to_resolve: string;
    escalations: number;
  };
  lanes_at_retry_ceiling: { lane: Lane; incidents: number }[];
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
  spine: Spine;
  tags: Tags;
  source: Source;
  airtable: AirtableRef;
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
  sync: SyncInfo;
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
 * How and when a kind's rows last reached this dashboard. `source` is
 * 'airtable' after a resync, 'inbound' when the newest change came from n8n,
 * and 'none' when nothing has been loaded (no key, or a resync that failed).
 */
export interface SyncInfo {
  kind: RecordKind;
  source: 'airtable' | 'none';
  synced_at: string | null;
  /** The last resync's failure, when there was one. */
  error: string | null;
  /** Rows held per table, as counted at the last resync. */
  tables: { table: string; label: string; n: number }[];
  /** Whether the server can write back to Airtable at all. */
  write_through: boolean;
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
  /** Not flagged by Layer 0, and Layer 2 has written the entry. */
  complete: boolean;
  /** Whether Orchestrator Layer2 Review holds anything. */
  has_entry: boolean;
  /** The opening of the Layer 2 review, for the list. */
  entry_excerpt: string | null;
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
  /** Anything but "completed": still waiting on the builder. */
  open: boolean;
  created_at: string | null;
  source: Source;
  airtable: AirtableRef;
}

/** The four tabs, exactly as defined against the source's own fields. */
export type CodexTab = 'approved' | 'pending' | 'incomplete' | 'complete';

export interface CodexData {
  entries: CodexEntry[];
  sync: SyncInfo;
  /** The tables read, in the order they are offered as builder tabs. */
  builders: { id: string; label: string; table: string; n: number }[];
  /** Submissions sitting at the Layer 0 gate, which have no builder-table row yet. */
  layer0_holds: Layer0Hold[];
  /** Select choices as the tables define them, for the review control. */
  choices: { jason_status: string[] };
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
  status: PatternStatus;
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
 * pattern_status as the Build Patterns table defines it — a single-select
 * with exactly two choices — plus the state the table does not name: a row
 * that leaves the field empty. 'unset' is never written back; it is what a
 * row already is.
 */
export type PatternStatus = 'draft' | 'canonical' | 'unset';

/** The two a pattern can be moved to from here. */
export type WritablePatternStatus = 'draft' | 'canonical';

export interface BuildPatternsData {
  patterns: BuildPattern[];
  sync: SyncInfo;
  /** Every system seen in pattern ids, with counts, for the classification strip. */
  systems: { system: string; n: number; canonical: number }[];
  /** How many rows leave pattern_status empty, for the page's own explanation of the states. */
  unset: number;
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
  lane_id: string | null;
  readiness_state: ReadinessState | null;
  confidence: string | null;
  pilot_state: string | null;
  routing_state: string | null;
  lane_state: string | null;
  lane_state_blocked_reason: string | null;
  engine_movement_state: string | null;
  demand_evidence: string | null;
  infra_readiness: string | null;
  data_readiness: string | null;
  media_readiness: string | null;
  media_gate: string | null;
  missing_research_count: number | null;
  missing_research_questions: string[];
  next_action: string | null;
  pain_point: string | null;
  offer: string | null;
  target: string | null;
  who_pays: string | null;
  bha_system: string | null;
  created_at: string | null;
  note?: string | null;
  spine: Spine;
  source: Source;
  airtable: AirtableRef;
}

export interface CommercialData {
  opportunities: Opportunity[];
  sync: SyncInfo;
  /** Cards grouped by lane_id, in the order lanes first appear. */
  lanes: { lane_id: string; n: number; unresolved_questions: number | null }[];
  /** Per card, missing_research_count as observed at each resync — a trend only once seen on two different days. Keyed by record id. */
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

export interface BuildersData {
  builders: Builder[];
}

export interface BuilderDetail {
  builder: Builder;
  loops: Loop[];
  entries: CodexEntry[];
  incidents: Incident[];
}

/* --------------------------------------------------------------- records */

export type RecordKind = 'loops' | 'codex' | 'patterns' | 'commercial';

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
  /** The four tabs, each with the rule it applies, so the page never states a rule the server does not use. */
  tabs: { tab: CodexTab; label: string; n: number; rule: string }[];
  /** Submissions carrying a completed Layer 2 entry. */
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
  median_days_to_approval: Metric;
}

export interface PatternMetrics {
  kind: 'patterns';
  computed_at: string;
  scope: { rows: number };
  draft: number;
  canonical: number;
  /** Rows whose pattern_status is empty. Counted separately: an untriaged pattern is not a draft. */
  unset: number;
  /** draft + canonical + unset, and the total, so the figures visibly reconcile. */
  reconciliation: { rows: number; draft: number; canonical: number; unset: number; sums_to: number; note: string };
  /** Distinct pattern_id values against the row count — the second reason the figures move. */
  duplicates: { distinct_ids: number; duplicate_rows: number; ids: { pattern_id: string; n: number }[]; note: string };
  /** Canonical as a share of all patterns, today. */
  promotion_rate: Metric;
  /** What each state means. The field itself defines two; the third is the absence of a value. */
  status_legend: { status: PatternStatus; meaning: string }[];
  by_system: { system: string; draft: number; canonical: number; unset: number }[];
  reusability_mix: { reusability: string; n: number }[];
  reusability_note: string;
  created_per_week: MetricSeries;
}

export interface CommercialMetrics {
  kind: 'commercial';
  computed_at: string;
  scope: { rows: number };
  cards: number;
  by_lane: { lane_id: string; n: number; unresolved: number | null; blocked: number }[];
  by_readiness: { readiness_state: string; n: number }[];
  confidence_mix: { confidence: string; n: number }[];
  unresolved_questions: Metric;
  unresolved_trend: MetricSeries;
  demand_evidence_note: string;
}

export type RecordMetrics = LoopMetrics | CodexMetrics | PatternMetrics | CommercialMetrics;

/** What POST /api/resync answers: one result per kind, one line per table. */
export interface ResyncResponse {
  ok: boolean;
  results: {
    kind: RecordKind;
    ok: boolean;
    started_at: string;
    finished_at: string;
    tables: { table: string; label: string; n: number; inserted: number; changed: number; removed: number; error: string | null; ms: number }[];
  }[];
}
