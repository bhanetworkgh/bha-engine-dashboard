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

/** The four-field spine carried on every record, per CLAUDE.md section 8. */
export interface Spine {
  session_id: string;
  builder_id: string;
  subsystem: Subsystem;
  lane: Lane;
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
}

/* -------------------------------------------------------------- ask bays */

export interface ChatMessage {
  id: string;
  role: 'user' | 'bays';
  text: string;
  at: string;
}

export interface ChatThread {
  id: string;
  title: string;
  updated_at: string;
  messages: ChatMessage[];
}

export interface AskBaysData {
  threads: ChatThread[];
  /** Bays has no memory today. The UI says so rather than implying otherwise. */
  memory_note: string;
}

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

export interface Loop {
  id: string;
  title: string;
  owner: string;
  status: LoopStatus;
  /** Days since the loop was raised. Time in current status is not recorded. */
  age_days: number;
  raised_at: string;
  lane: Lane;
  spine: Spine;
  tags: Tags;
  source: Source;
}

export interface ProposedClose {
  id: string;
  loop_id: string;
  title: string;
  owner: string;
  age_days: number;
  reason: string;
  citation: { text: string; source: Source };
}

export interface ReconciliationRow {
  id: string;
  loop_id: string;
  title: string;
  expected_owner: string;
  found_in: string | null;
  discrepancy: string;
  source: Source;
}

export interface OpenLoopsData {
  loops: Loop[];
  by_owner: { owner: string; open: number; in_progress: number; oldest_days: number }[];
  review_queue: ProposedClose[];
  reconciliation: ReconciliationRow[];
  reconciliation_note: string;
  status_history_note: string;
}

/* ------------------------------- codex / patterns / commercial / builders */

export interface CodexEntry {
  id: string;
  builder_id: string;
  week: string;
  logged_at: string;
  session_type: string;
  title: string;
  narration_url: string | null;
  ingested: boolean;
  spine: Spine;
  tags: Tags;
  source: Source;
}

export interface CodexData {
  entries: CodexEntry[];
  this_week: number;
  ingested_rate: string;
}

export interface BuildPattern {
  id: string;
  code: string;
  title: string;
  lane: Lane;
  references: number;
  last_referenced: string | null;
  author: string;
  source: Source;
}

export interface BuildPatternsData {
  patterns: BuildPattern[];
  reference_note: string;
}

export type Readiness =
  | 'idea'
  | 'researching'
  | 'evidence thin'
  | 'ready to pitch'
  | 'blocked';

export interface Opportunity {
  id: string;
  title: string;
  readiness: Readiness;
  health: Health;
  owner: string;
  lane: Lane;
  last_touched: string;
  blocker: string | null;
  spine: Spine;
  source: Source;
}

export interface CommercialData {
  opportunities: Opportunity[];
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
