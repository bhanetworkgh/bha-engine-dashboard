/**
 * Where each record kind lives in Airtable and how a row there becomes a
 * dashboard record. Every id, field name and select vocabulary here was read
 * from the live bases on 2026-09-09, not assumed.
 *
 *   loops       appUVlBSGGPHw6DGh   one table per builder, identical schema
 *   codex       appEmdKshNVTl64Zf   BHA Submissions & Logs, one table per
 *                                   builder plus the Layer 0 holding table
 *   patterns    app5ni3E8r7Lvxk22   Build Patterns
 *   commercial  appvLglfdCqOKqLpT   Commercial Opportunities
 *
 * The mappers derive nothing the source does not carry. `builder_id` is
 * mapped from a Slack user id or a display name; `week` is computed from a
 * date; `system` and `keywords` are read off a pattern's own id. Everything
 * else is the field, or null.
 */
import type { AtRecord } from './airtable';
import { recordUrl } from './airtable';
import type { BuildPattern, BuildPatternDetail, CodexEntry, CodexEntryDetail, Layer0Hold, Loop, LoopLaneTag, LoopStatus, Opportunity, ReadinessState, RecordKind, Source } from '../../src/data/types';

/** Jason Status as the submission tables define it, lower-cased. 'unset' is a row he has not touched. */
export type CodexApproval = 'approved' | 'pending' | 'input added' | 'unset';

/* ------------------------------------------------------------- locations */

export const LOOPS_BASE = 'appUVlBSGGPHw6DGh';

/** Owner is the table a loop lives in — never the assignee field, which varies within a table. */
export const LOOP_TABLES: { owner: string; table: string; label: string }[] = [
  { owner: 'destiny', table: 'tblBJekl3ROpNZxQW', label: 'Destiny' },
  { owner: 'jason', table: 'tblVOLhWULskNiIUt', label: 'Jason' },
  { owner: 'kaiqi', table: 'tblOhjIS8t0dtCQmt', label: 'Kaiqi' },
  { owner: 'jegan', table: 'tblqMepD3XGZY4tZz', label: 'Jegan' },
  { owner: 'ahad', table: 'tbl3bTRcuUcbYXgDc', label: 'Ahad' },
  { owner: 'hardik', table: 'tblaloC4JIRdBq5EM', label: 'Hardik' },
  { owner: 'kavin', table: 'tbltm7QUmWAZpzTKz', label: 'Kavin' },
];

/**
 * Codex entries live in BHA Submissions & Logs, one table per builder. Which
 * table a row lives in *is* its builder identity — the Builder Name field can
 * be blank, the table never is. That is why there is no "no builder" bucket
 * any more, and why there is no Jason table: he reviews logs, he does not
 * submit them.
 */
export const CODEX_BASE = 'appEmdKshNVTl64Zf';

export const CODEX_TABLES: { owner: string; table: string; label: string; sheet: string }[] = [
  { owner: 'destiny', table: 'tblSqm5ty9QVTlmuA', label: 'Destiny', sheet: 'Destiny Arupi' },
  { owner: 'jegan', table: 'tblTu46ZQYHrim4yI', label: 'Jegan', sheet: 'Jeganathan' },
  { owner: 'kaiqi', table: 'tbl6QBXrgtLv9axqu', label: 'Kaiqi', sheet: 'kaiqi yang' },
  { owner: 'hardik', table: 'tblPrGLTE6GGFIHum', label: 'Hardik', sheet: 'Hardik Bhatt' },
  { owner: 'ahad', table: 'tblG67z5RRZyoBZSj', label: 'Ahad', sheet: 'Ahad' },
  { owner: 'kavin', table: 'tbltOCB2DHE5FFXa6', label: 'Kavin', sheet: 'Kavin G N' },
];

/**
 * The Layer 0 completeness-gate holding table. A submission that failed the
 * gate is parked here until the builder answers the missing pieces; it is not
 * a Codex entry and never appears in the entry list. It is read so the
 * Incomplete tab can say how many submissions are sitting in the gate right
 * now, which the builder tables alone cannot tell you.
 */
export const CODEX_LAYER0 = { base: CODEX_BASE, table: 'tbljoWu73vsxyL6vc', label: 'Layer 0' };

export function codexTable(owner: string): { owner: string; table: string; label: string; sheet: string } | null {
  return CODEX_TABLES.find((t) => t.owner === owner) ?? null;
}
export function codexTableById(table: string): { owner: string; table: string; label: string; sheet: string } | null {
  return CODEX_TABLES.find((t) => t.table === table) ?? null;
}
export const PATTERNS = { base: 'app5ni3E8r7Lvxk22', table: 'tblaMXSMjmz30OvcU', label: 'Build Patterns' };
export const COMMERCIAL = { base: 'appvLglfdCqOKqLpT', table: 'tblyXShZLOFT3jNMe', label: 'Commercial Opportunities' };

export function loopTable(owner: string): { owner: string; table: string; label: string } | null {
  return LOOP_TABLES.find((t) => t.owner === owner) ?? null;
}
export function loopTableById(table: string): { owner: string; table: string; label: string } | null {
  return LOOP_TABLES.find((t) => t.table === table) ?? null;
}

/** Where a kind's single table is. Loops and Codex entries resolve per builder instead. */
export function location(kind: Exclude<RecordKind, 'loops' | 'codex'>): { base: string; table: string; label: string } {
  return kind === 'patterns' ? PATTERNS : COMMERCIAL;
}

/** The base a kind's records live in. */
export function baseFor(kind: RecordKind): string {
  return kind === 'loops' ? LOOPS_BASE : kind === 'codex' ? CODEX_BASE : kind === 'patterns' ? PATTERNS.base : COMMERCIAL.base;
}

/* ------------------------------------------------------------ vocabularies */

/** Slack user ids as they appear in the loop tables' assignee field and the Codex Log's builder_id. */
export const SLACK_TO_BUILDER: Record<string, string> = {
  U0AEW3TBYH1: 'destiny',
  U0A9V97949F: 'jason',
  U0AD1V1D65N: 'kaiqi',
  U0AF011R821: 'jegan',
  U0AC6RFNP3P: 'ahad',
  U0BKT6MAW2Y: 'hardik',
  U0BNQGG020Y: 'kavin',
};

/** Display names as the Codex Log's builder_name select spells them, lower-cased. */
const NAME_TO_BUILDER: Record<string, string> = {
  'destiny arupi': 'destiny',
  destiny: 'destiny',
  jeganathan: 'jegan',
  jegan: 'jegan',
  ahad: 'ahad',
  'hardik bhatt': 'hardik',
  hardik: 'hardik',
  'kaiqi yang': 'kaiqi',
  kaiqi: 'kaiqi',
  'jason bays': 'jason',
  jason: 'jason',
  'kavin g n': 'kavin',
  kavin: 'kavin',
};

export const LOOP_LANE_TAGS: LoopLaneTag[] = ['RT', 'NS', 'VFARM_HARDWARE', 'KIOSK', 'CAD_API', 'MEDIA', 'GENIE', 'CST', 'BAYS', 'UNASSIGNED'];

export const LOOP_STATUS_TO_AIRTABLE: Record<LoopStatus, string> = { open: 'Open', 'in progress': 'In Progress', closed: 'Closed' };
const AIRTABLE_TO_LOOP_STATUS: Record<string, LoopStatus> = { Open: 'open', 'In Progress': 'in progress', Closed: 'closed' };

/**
 * The only Codex field this dashboard writes. Jason Status is the review
 * decision, and it is a single-select with exactly these three choices in
 * every builder table. Everything else on a submission row is written by the
 * pipeline that produced it and is read-only here.
 */
export const CODEX_JASON_STATUS = ['Approved', 'Pending', 'Input Added'] as const;

export const CODEX_CHOICES = { jason_status: [...CODEX_JASON_STATUS] };

export const READINESS_STATES: ReadinessState[] = ['INCUBATE', 'Research-First', 'Media-Ready'];

/* ---------------------------------------------------------------- helpers */

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

/** YYYY-MM-DD from a date or datetime string; null when it is not one. */
function day(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}
function iso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** ISO week, e.g. 2026-W36, from a date string. */
export function isoWeek(dayStr: string): string {
  const d = new Date(`${dayStr.slice(0, 10)}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y = d.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const w = Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

export function builderFromSlack(id: unknown): string | null {
  const s = str(id);
  return s ? (SLACK_TO_BUILDER[s] ?? null) : null;
}
export function builderFromName(name: unknown): string | null {
  const s = str(name);
  return s ? (NAME_TO_BUILDER[s.toLowerCase()] ?? null) : null;
}

/** Display names for the builders this engine knows, keyed by builder id. */
export const BUILDER_LABELS: Record<string, string> = {
  destiny: 'Destiny',
  jason: 'Jason',
  jegan: 'Jegan',
  kaiqi: 'Kaiqi',
  ahad: 'Ahad',
  hardik: 'Hardik',
  kavin: 'Kavin',
};

/**
 * One canonical identity per person, for free-text name fields.
 *
 * The loop tables' Raised By is a plain text box, so the same person is
 * written several ways — "Jason" and "Jason Bays", "Destiny" and "Destiny
 * Arupi", "Jegan" and "Jeganathan". Counting those as separate raisers made
 * the page wrong, not merely untidy: one person's share of the loops was
 * split across two bars.
 *
 * A name that maps to a builder collapses to that builder. A name that does
 * not is kept as written (case- and space-normalised), because inventing an
 * identity for a stranger would be worse than showing two spellings.
 */
export function canonicalPerson(raw: unknown): { key: string; label: string } | null {
  const s = str(raw);
  if (!s) return null;
  const cleaned = s.replace(/^@+/, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const builder = SLACK_TO_BUILDER[cleaned] ?? NAME_TO_BUILDER[cleaned.toLowerCase()] ?? null;
  if (builder) return { key: builder, label: BUILDER_LABELS[builder] ?? builder };
  return { key: `raw:${cleaned.toLowerCase()}`, label: cleaned };
}

const SLACK_HOST = 'bayshorizonnetwork.slack.com';

function slackSource(url: string | null, fallbackRef: string): Source | null {
  if (!url || !url.includes(SLACK_HOST)) return null;
  const ref = url.split('/').pop() || fallbackRef;
  return { kind: 'slack', ref, url };
}
function airtableSource(base: string, table: string, id: string): Source {
  return { kind: 'airtable', ref: id, url: recordUrl(base, table, id) };
}

/* ----------------------------------------------------------------- loops */

export function mapLoop(rec: AtRecord, owner: string, table: string): Loop {
  const f = rec.fields;
  const statusName = str(f.Status);
  const status = statusName ? (AIRTABLE_TO_LOOP_STATUS[statusName] ?? 'open') : 'open';
  const laneRaw = str(f.lane_tag);
  const lane_tag = laneRaw && (LOOP_LANE_TAGS as string[]).includes(laneRaw) ? (laneRaw as LoopLaneTag) : null;
  const raised = day(f['Date Raised']);
  const link = str(f['Source Link']);
  return {
    id: rec.id,
    loop_id: str(f.loop_id),
    title: str(f.What) ?? '(no text)',
    owner,
    status,
    age_days: 0, // set by the store from raised_at and today
    raised_at: raised,
    raised_by: str(f['Raised By']),
    raised_in: str(f.raised_in),
    lane_tag,
    assignee_slack_id: str(f['Assignee Slack User ID']),
    last_modified: iso(f.last_modified),
    closed_at: null,
    note: null,
    spine: { session_id: null, builder_id: owner, subsystem: null, lane: lane_tag },
    tags: {},
    source: slackSource(link, rec.id) ?? airtableSource(LOOPS_BASE, table, rec.id),
    airtable: { base: LOOPS_BASE, table, record_id: rec.id, url: recordUrl(LOOPS_BASE, table, rec.id) },
  };
}

/* ----------------------------------------------------------------- codex */

/** Jason Status, lower-cased. An empty field is 'unset' — he has not looked at it. */
export function codexApproval(raw: string | null): CodexApproval {
  const a = (raw ?? '').trim().toLowerCase();
  if (a === 'approved') return 'approved';
  if (a === 'pending') return 'pending';
  if (a === 'input added') return 'input added';
  return 'unset';
}

/**
 * Layer0 Missing is a JSON array of the dimensions the completeness gate
 * found absent — mission_fit, error_fix, next_step, commercial. It is written
 * as text, so a malformed value is treated as "nothing recorded" rather than
 * thrown away silently or guessed at.
 */
export function layer0Missing(raw: unknown): string[] {
  const text = str(raw);
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  } catch {
    // Not JSON: fall through to the comma-separated reading below.
  }
  return text
    .replace(/^[[\]]+|[[\]]+$/g, '')
    .split(',')
    .map((v) => v.replace(/["']/g, '').trim())
    .filter(Boolean);
}

/** mission_fit → "mission fit". The gate writes snake_case; the page is sentence case. */
export function missingLabel(key: string): string {
  return key.replace(/_/g, ' ').toLowerCase();
}

/** The first lines of the Layer 2 review, for the list. The whole thing is on the entry. */
function firstLines(text: string | null, max = 220): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/**
 * One submission row from a builder's table in BHA Submissions & Logs.
 *
 * The builder is the table, never a field: `Builder Name` can be blank and
 * several rows are. `Orchestrator Layer2 Review` is the finished Codex entry
 * — the thing this page exists to show — and is carried in full on the detail
 * shape only, because a hundred of them in one list payload is megabytes.
 */
export function mapCodex(rec: AtRecord, owner: string, table: string): CodexEntryDetail {
  const f = rec.fields;
  const logged = iso(f.Timestamp);
  const jason = str(f['Jason Status']);
  const approval = codexApproval(jason);
  // "Layer1 Review " carries a trailing space in every table; read both spellings.
  const layer1 = str(f['Layer1 Review ']) ?? str(f['Layer1 Review']);
  const layer2 = str(f['Orchestrator Layer2 Review']);
  const flagged = bool(f['Layer0 Flagged']);
  const missing = layer0Missing(f['Layer0 Missing']);
  const url = str(f['Session Url']);
  return {
    id: rec.id,
    builder_id: owner,
    table,
    submission_id: str(f['Submission ID']),
    codex_entry_id: str(f['Codex Entry ID']),
    logged_at: logged,
    week: logged ? isoWeek(logged) : null,
    session_type: str(f['Session Type']),
    session_url: url,
    narration_quality: str(f['Narration Quality']),
    submission_source: str(f['Submission Source']),
    jason_status: jason,
    approval,
    layer0_flagged: flagged,
    layer0_missing: missing,
    /** Complete exactly as specified: the gate passed it and Layer 2 wrote an entry. */
    complete: !flagged && Boolean(layer2),
    has_entry: Boolean(layer2),
    entry_excerpt: firstLines(layer2),
    processed_at: iso(f['Processed At']),
    processed_date: day(f['Processed Date']),
    note: null,
    spine: { session_id: str(f['Submission ID']), builder_id: owner, subsystem: 'CODEX', lane: null },
    tags: {},
    source: slackSource(url, rec.id) ?? airtableSource(CODEX_BASE, table, rec.id),
    airtable: { base: CODEX_BASE, table, record_id: rec.id, url: recordUrl(CODEX_BASE, table, rec.id) },
    entry: layer2,
    layer1_review: layer1,
    summary: str(f.Summary),
    session_description: str(f['Session Description']),
    jason_notes: str(f['Jason Notes']),
  };
}

/** The list shape: everything but the long text. */
export function codexSummary(e: CodexEntryDetail): CodexEntry {
  const { entry, layer1_review, summary, session_description, jason_notes, ...rest } = e;
  void [entry, layer1_review, summary, session_description, jason_notes];
  return rest;
}

/** One row of the Layer 0 holding table: a submission parked at the completeness gate. */
export function mapLayer0(rec: AtRecord): Layer0Hold {
  const f = rec.fields;
  const name = str(f['Builder Username']);
  const status = str(f.Status);
  return {
    id: rec.id,
    submission_id: str(f['Submission ID']),
    builder_id: builderFromSlack(f['Builder User ID']) ?? builderFromName(name),
    builder_name: name,
    missing: layer0Missing(f['Missing Fields']),
    status,
    open: (status ?? '').toLowerCase() !== 'completed',
    created_at: iso(f['Created At']),
    source: airtableSource(CODEX_BASE, CODEX_LAYER0.table, rec.id),
    airtable: { base: CODEX_BASE, table: CODEX_LAYER0.table, record_id: rec.id, url: recordUrl(CODEX_BASE, CODEX_LAYER0.table, rec.id) },
  };
}

/** The one Airtable field an edit may write, and the one status change. */
export const CODEX_EDITABLE = new Set(['Jason Status', 'Jason Notes']);

/* -------------------------------------------------------------- patterns */

const STOP = new Set(['with', 'and', 'the', 'for', 'of', 'on', 'in', 'to', 'a', 'an', 'as', 'by', 'via', 'from']);

/** BP-SLACK-001-BLOCK_KIT_WITH_TEXT_FALLBACK → system SLACK, words block kit text fallback. */
function classify(patternId: string | null, bhaSystem: string | null): { system: string | null; keywords: string[] } {
  const words = new Set<string>();
  let system: string | null = null;
  if (patternId) {
    const m = patternId.match(/^BP-([A-Z0-9]+)-\d+-(.+)$/i);
    if (m) {
      system = m[1].toUpperCase();
      for (const w of m[2].toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOP.has(w)) words.add(w);
    }
  }
  if (bhaSystem) for (const w of bhaSystem.toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOP.has(w)) words.add(w);
  return { system, keywords: [...words] };
}

function excerpt(text: string | null, max = 180): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, end > 60 ? end : max).trim()}…`;
}

export function mapPattern(rec: AtRecord): BuildPatternDetail {
  const f = rec.fields;
  const pattern_id = str(f.pattern_id);
  const bha_system = str(f.bha_system);
  const statusName = str(f.pattern_status);
  const { system, keywords } = classify(pattern_id, bha_system);
  return {
    id: rec.id,
    pattern_id,
    title: str(f.pattern_name) ?? pattern_id ?? '(unnamed pattern)',
    /**
     * pattern_status is a single-select with exactly two choices, and a
     * sizeable minority of rows leave it empty. Folding empty into draft was
     * why the draft count and the total never reconciled: a pattern nobody
     * has triaged is not a draft, it is a pattern in no state at all. Three
     * states here, two of them writable.
     */
    status: statusName === 'canonical' ? 'canonical' : statusName === 'draft' ? 'draft' : 'unset',
    bha_system,
    reusability: str(f.reusability),
    created_at: iso(f.created_at),
    system,
    keywords,
    excerpt: excerpt(str(f.problem)),
    note: null,
    source: airtableSource(PATTERNS.base, PATTERNS.table, rec.id),
    airtable: { base: PATTERNS.base, table: PATTERNS.table, record_id: rec.id, url: recordUrl(PATTERNS.base, PATTERNS.table, rec.id) },
    problem: str(f.problem),
    solution: str(f.solution),
    context: str(f.context),
    next_use_case: str(f.next_use_case),
    commercial_impact: str(f.commercial_impact),
    research_production_impact: str(f.research_production_impact),
    learnings_gotchas: str(f.learnings_gotchas),
    readiness_gates: str(f.readiness_gates),
    implementation_checklist: str(f.implementation_checklist),
    integration_points: str(f.integration_points),
    test_coverage: str(f.test_coverage),
    routing_logic: str(f.routing_logic),
    anti_pattern: str(f.anti_pattern),
    naming_note: str(f.naming_note),
    roadmap_context: str(f.roadmap_context),
  };
}

/** The list shape: everything but the long text. */
export function patternSummary(p: BuildPatternDetail): BuildPattern {
  const { problem, solution, context, next_use_case, commercial_impact, research_production_impact, learnings_gotchas, readiness_gates, implementation_checklist, integration_points, test_coverage, routing_logic, anti_pattern, naming_note, roadmap_context, ...rest } = p;
  void [problem, solution, context, next_use_case, commercial_impact, research_production_impact, learnings_gotchas, readiness_gates, implementation_checklist, integration_points, test_coverage, routing_logic, anti_pattern, naming_note, roadmap_context];
  return rest;
}

/* ------------------------------------------------------------ commercial */

export function mapOpportunity(rec: AtRecord): Opportunity {
  const f = rec.fields;
  const readinessRaw = str(f.readiness_state);
  const readiness_state = readinessRaw && (READINESS_STATES as string[]).includes(readinessRaw) ? (readinessRaw as ReadinessState) : null;
  const questionsText = str(f.missing_research_questions);
  const questions = questionsText
    ? questionsText
        .split('|')
        .map((q) => q.trim())
        .filter(Boolean)
    : [];
  const lane = str(f.lane_id);
  return {
    id: rec.id,
    card_id: str(f.card_id),
    title: str(f.opportunity_title) ?? str(f.card_id) ?? '(untitled card)',
    lane_id: lane,
    readiness_state,
    confidence: str(f.confidence),
    pilot_state: str(f.pilot_state),
    routing_state: str(f.routing_state),
    lane_state: str(f.lane_state),
    lane_state_blocked_reason: str(f.lane_state_blocked_reason),
    engine_movement_state: str(f.engine_movement_state),
    demand_evidence: str(f.demand_evidence),
    infra_readiness: str(f.infra_readiness),
    data_readiness: str(f.data_readiness),
    media_readiness: str(f.media_readiness),
    media_gate: str(f.media_gate),
    missing_research_count: num(f.missing_research_count),
    missing_research_questions: questions,
    next_action: str(f.next_action),
    pain_point: str(f.pain_point),
    offer: str(f.offer),
    target: str(f.target),
    who_pays: str(f.who_pays),
    bha_system: str(f.bha_system),
    created_at: iso(f.created_at),
    note: null,
    spine: { session_id: null, builder_id: null, subsystem: 'COMMERCIALOPPS', lane },
    source: airtableSource(COMMERCIAL.base, COMMERCIAL.table, rec.id),
    airtable: { base: COMMERCIAL.base, table: COMMERCIAL.table, record_id: rec.id, url: recordUrl(COMMERCIAL.base, COMMERCIAL.table, rec.id) },
  };
}
