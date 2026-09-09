/**
 * Where each record kind lives in Airtable and how a row there becomes a
 * dashboard record. Every id, field name and select vocabulary here was read
 * from the live bases on 2026-09-09, not assumed.
 *
 *   loops       appUVlBSGGPHw6DGh   one table per builder, identical schema
 *   codex       apploVyhvTYNGSGCD   Codex Log
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
import type { BuildPattern, BuildPatternDetail, CodexEntry, Loop, LoopLaneTag, LoopStatus, Opportunity, ReadinessState, RecordKind, Source } from '../../src/data/types';

/** What action_required says, in five buckets. Only 'jason' is surfaced as a layer; the rest are held for filtering. */
export type CodexBucket = 'jason' | 'destiny' | 'builder' | 'other' | 'none';

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

export const CODEX = { base: 'apploVyhvTYNGSGCD', table: 'tblV6GeKEtKJrS4qN', label: 'Codex Log' };
export const PATTERNS = { base: 'app5ni3E8r7Lvxk22', table: 'tblaMXSMjmz30OvcU', label: 'Build Patterns' };
export const COMMERCIAL = { base: 'appvLglfdCqOKqLpT', table: 'tblyXShZLOFT3jNMe', label: 'Commercial Opportunities' };

export function loopTable(owner: string): { owner: string; table: string; label: string } | null {
  return LOOP_TABLES.find((t) => t.owner === owner) ?? null;
}
export function loopTableById(table: string): { owner: string; table: string; label: string } | null {
  return LOOP_TABLES.find((t) => t.table === table) ?? null;
}

/** Where a kind's single table is; loops resolve per owner instead. */
export function location(kind: Exclude<RecordKind, 'loops'>): { base: string; table: string; label: string } {
  return kind === 'codex' ? CODEX : kind === 'patterns' ? PATTERNS : COMMERCIAL;
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

/** Select choices as the Codex Log defines them, for the edit form. TEST_PROBE rows are not offered. */
export const CODEX_CHOICES = {
  session_type: [
    'Build',
    'Build/Debug',
    'Not Stated',
    'Build and Architechture',
    'Debug',
    'Architecture',
    'Build and Architecture',
    'Coordination & Verification',
    'Build & Correction',
    'Build and Debug',
    'Debug, Architecture, Full-System Audit',
    'Build, Consolidation & Full-System Documentation',
    'Maintenance, Pipeline Debugging & Coordination Review',
    'Build, Migration & Full-System Cleanup',
  ],
  verdict: ['Aligned & Moving the Needle', 'Partially Aligned'],
  narration_quality: ['Excellent', 'Great', 'Good'],
  pillar_tag: ['MULTIPLE', 'RT_PT_MONITORING', 'FRONT_DOOR', 'GENIE_BHARAG1', 'ROUTING_EVIDENCE'],
};

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

export function codexBucket(action: string | null): CodexBucket {
  if (!action) return 'none';
  const a = action.trim().toUpperCase().replace(/\.$/, '');
  if (a === 'JASON_SPOTCHECK') return 'jason';
  if (a === 'DESTINY_REVIEW') return 'destiny';
  if (a === 'BUILDER_FOLLOWUP') return 'builder';
  if (a === 'NONE' || a === '') return 'none';
  return 'other';
}

/** The fields a complete log carries. This is the dashboard's check, stated on the page; the log has no completeness field. */
export const CODEX_REQUIRED: { key: string; label: string }[] = [
  { key: 'builder', label: 'builder' },
  { key: 'session_url', label: 'session link' },
  { key: 'session_type', label: 'session type' },
  { key: 'verdict', label: 'verdict' },
  { key: 'architecture_fit', label: 'architecture fit' },
  { key: 'engine_movement', label: 'engine movement' },
  { key: 'needle_moved_evidence', label: 'needle-moved evidence' },
];

export function mapCodex(rec: AtRecord): CodexEntry {
  const f = rec.fields;
  const slack = str(f.builder_id);
  const name = str(f.builder_name);
  const builder = builderFromSlack(slack) ?? builderFromName(name);
  const logged = iso(f.timestamp);
  const action = str(f.action_required);
  const pay = bool(f.pay_eligible);
  const present: Record<string, unknown> = { builder, session_url: str(f.session_url), session_type: str(f.session_type), verdict: str(f.verdict), architecture_fit: str(f.architecture_fit), engine_movement: str(f.engine_movement), needle_moved_evidence: str(f.needle_moved_evidence) };
  const missing = CODEX_REQUIRED.filter((r) => !present[r.key]).map((r) => r.label);
  return {
    id: rec.id,
    builder_id: builder,
    builder_slack_id: slack,
    builder_name: name,
    logged_at: logged,
    week: logged ? isoWeek(logged) : null,
    session_type: str(f.session_type),
    session_url: str(f.session_url),
    verdict: str(f.verdict),
    narration_quality: str(f.narration_quality),
    pay_eligible: pay,
    action_required: action,
    card_id: str(f.card_id),
    lane_id: str(f.lane_id),
    pillar_tag: str(f.pillar_tag),
    flag_name: str(f.flag_name),
    flag_repeat_count: num(f.flag_repeat_count),
    architecture_fit: str(f.architecture_fit),
    engine_movement: str(f.engine_movement),
    needle_moved_evidence: str(f.needle_moved_evidence),
    red_flags: str(f.red_flags),
    complete: missing.length === 0,
    missing,
    note: null,
    spine: { session_id: null, builder_id: builder, subsystem: 'CODEX', lane: str(f.lane_id) },
    tags: pay ? { pay_eligible: true } : {},
    source: airtableSource(CODEX.base, CODEX.table, rec.id),
    airtable: { base: CODEX.base, table: CODEX.table, record_id: rec.id, url: recordUrl(CODEX.base, CODEX.table, rec.id) },
  };
}

/** The Airtable field names an edit may write. Same set as CodexEditableField. */
export const CODEX_EDITABLE = new Set([
  'session_type',
  'session_url',
  'verdict',
  'narration_quality',
  'pay_eligible',
  'action_required',
  'card_id',
  'lane_id',
  'pillar_tag',
  'architecture_fit',
  'engine_movement',
  'needle_moved_evidence',
  'red_flags',
]);

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
    status: statusName === 'canonical' ? 'canonical' : 'draft',
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
