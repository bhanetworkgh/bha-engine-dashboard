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

/**
 * A record in the shape Airtable's REST API returns it: the id, the
 * createdTime, and the values under `fields` — never at the top level.
 *
 * This shape outlived the Airtable client it came from. The mirror tables
 * store exactly these three things per row (see mirror.ts), so a mirror row
 * is turned back into one of these and handed to the mappers below, which is
 * why every field name here is still Airtable's own.
 */
export interface AtRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** The record's own page in Airtable, for "open in Airtable" on every row. */
export function recordUrl(base: string, table: string, id: string): string {
  return `https://airtable.com/${base}/${table}/${id}`;
}

/** Airtable's record id, as a shape. A row the engine wrote before Airtable had one carries none. */
const REC_ID = /^rec[A-Za-z0-9]{14}$/;
import type { AskTool, BuildPattern, BuildPatternDetail, ClientLane, ClientQuestion, ClientRequest, CodexEntry, CodexEntryDetail, Layer0Hold, Loop, LoopLaneTag, LoopStatus, NsAsk, Opportunity, ReadinessState, RecordKind, RtAsk, RtJob, Source } from '../../src/data/types';

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
  switch (kind) {
    case 'loops':
      return LOOPS_BASE;
    case 'codex':
      return CODEX_BASE;
    case 'patterns':
      return PATTERNS.base;
    case 'commercial':
      return COMMERCIAL.base;
    case 'ns':
      return NORTH_STAR.base;
    case 'rt':
      return RESEARCH_TWIN.base;
    case 'rt_jobs':
      return RESEARCH_JOBS.base;
    case 'clients':
    case 'client_questions':
      return CLIENTS_INDEX.base;
    case 'client_requests':
      return CLIENT_REQUESTS.base;
  }
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
/**
 * Where the row is in Airtable.
 *
 * A row the engine wrote into this database before Airtable had one has no
 * record id, so there is no record page to open; the link goes to the table
 * it belongs to and the reference says the row is not in Airtable, rather
 * than pointing at a record page that would 404.
 */
function airtableSource(base: string, table: string, id: string): Source {
  return REC_ID.test(id) ? { kind: 'airtable', ref: id, url: recordUrl(base, table, id) } : { kind: 'airtable', ref: 'not in Airtable', url: `https://airtable.com/${base}/${table}` };
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
 * `Paid` — whether an approved log has been paid.
 *
 * A single select with exactly Yes and No in all six builder tables, written
 * No by Bays — Submit Actions at Layer 1 and flipped to Yes only when Jason
 * answers the card in #bha-pay-reviews. The field's own description in
 * Airtable says so.
 *
 * **Null is a third state and is not No.** The column was added after most of
 * the history, nothing backfills it, and the Layer 0 parking table has no such
 * field at all — so a row can carry no value. Reading that as "not paid" would
 * be this dashboard asserting a fact the base does not hold, which is the one
 * thing section 2 of CLAUDE.md forbids. Any spelling but those two reads null
 * for the same reason.
 */
function paidState(raw: unknown): boolean | null {
  const v = str(raw)?.toLowerCase();
  return v === 'yes' ? true : v === 'no' ? false : null;
}

/**
 * One submission row from a builder's table in BHA Submissions & Logs.
 *
 * The builder is the table, never a field: `Builder Name` can be blank and
 * several rows are. `Orchestrator Layer2 Review` is the finished Codex entry
 * — the thing this page exists to show — and is carried in full on the detail
 * shape only, because a hundred of them in one list payload is megabytes.
 *
 * `pending` is the set of `Submission ID`s sitting at `pending_builder_input`
 * in the Layer 0 parking table — the only thing that says a log is waiting on
 * its builder right now. It is passed in because that fact lives in another
 * table and this mapper reads one record; the caller fetches it once per read.
 * Without it no log is placed at Needs input, which is the right answer for
 * the paths that only want a record's approval state.
 */
export function mapCodex(rec: AtRecord, owner: string, table: string, pending?: ReadonlySet<string>): CodexEntryDetail {
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
  const submission = str(f['Submission ID']);
  const needsInput = Boolean(submission && pending?.has(submission));
  return {
    id: rec.id,
    builder_id: owner,
    table,
    submission_id: submission,
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
    /** Complete exactly as specified: the gate passed it and Layer 2 generated the codex. */
    complete: !flagged && Boolean(layer2),
    /**
     * The one rule that makes the three stages mutually exclusive: a log with a
     * Layer 0 row at `pending_builder_input` is at Needs input whatever Jason
     * Status says, because the builder has to answer before the log can move.
     * Otherwise Jason Status decides.
     *
     * **Not `Layer0 Flagged`** (decision 2026-09-14, Destiny). That box means
     * *was flagged once, ever* — nothing clears it when the builder answers —
     * so it held eight answered, merged and approved logs in a queue of work
     * owed. It is still read and still shown, because it is a true fact about
     * the log, but it no longer places one anywhere.
     *
     * **"Input Added" counts as approved** (decision 2026-09-14, Destiny).
     * Jason adding input means he has read the log and responded; it is a form
     * of having dealt with it, not a state of waiting for him.
     */
    stage: needsInput ? 'needs_input' : approval === 'approved' || approval === 'input added' ? 'approved' : 'awaiting',
    has_entry: Boolean(layer2),
    entry_excerpt: firstLines(layer2),
    /**
     * Session Description is the builder's own one-line title for the
     * session, so it is what the list shows. The generated codex is still
     * carried whole on the detail shape and is what opens on click; its
     * opening lines stay in `entry_excerpt` for search.
     */
    description_excerpt: firstLines(str(f['Session Description'])),
    paid: paidState(f.Paid),
    /**
     * When Jason acted on the log. The field was created on 14 Sep 2026 and
     * there is no backfill and never will be — its own description in Airtable
     * says so — so every submission before that carries a decision and no date
     * for it. Read as null rather than substituted with Processed At, which is
     * when the pipeline ran and not when a person decided.
     */
    reviewed_at: iso(f['Jason Reviewed At']),
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

/** The Layer 0 `Status` value that means the builder still owes an answer. */
export const LAYER0_PENDING = 'pending_builder_input';

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
    /**
     * The one state that means a builder is being waited on. Deliberately
     * narrower than `open`, which is everything that is not `completed`: it is
     * what places a log at Needs input, so it names the state literally rather
     * than inferring it from the absence of another.
     */
    pending_builder_input: (status ?? '').toLowerCase() === LAYER0_PENDING,
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
    /**
     * The system is the second segment and nothing more is needed to read it
     * (2026-09-16, Destiny). This used to require a slug after the sequence
     * number — `^BP-([A-Z0-9]+)-\d+-(.+)$` — so `BP-BHARAG-114`, which is a
     * perfectly ordinary id, was filed under no system at all. The slug is what
     * the keywords come from, and only that.
     */
    const m = patternId.match(/^BP-([A-Z0-9]+)-\d+(?:-(.+))?$/i);
    if (m) {
      system = m[1].toUpperCase();
      if (m[2]) for (const w of m[2].toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOP.has(w)) words.add(w);
    }
  }
  if (bhaSystem) for (const w of bhaSystem.toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOP.has(w)) words.add(w);
  return { system, keywords: [...words] };
}

/**
 * LANE-VFARM-ZONE_MONITORING_SAAS → zone, monitoring, saas.
 *
 * A commercial card's `lane_id` carries the same shape as a pattern id, minus
 * the sequence number, so the keywords on that page are read the same way. The
 * system segment is dropped: it is VFARM on every card, and a keyword every row
 * carries groups nothing.
 */
function laneKeywords(laneId: string | null): string[] {
  const m = laneId?.match(/^LANE-[A-Z0-9]+-(.+)$/i);
  if (!m) return [];
  const words = new Set<string>();
  for (const w of m[1].toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOP.has(w)) words.add(w);
  return [...words];
}

function excerpt(text: string | null, max = 180): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, end > 60 ? end : max).trim()}…`;
}

/**
 * One build pattern.
 *
 * **There is no `pattern_status`** (2026-09-15, Destiny). The field was deleted
 * from the base and removed from every workflow that wrote it, so the table has
 * twenty columns and none of them is a state. Reading it would now read nothing
 * on every row, and every row would come back "no status" — which is how a
 * deleted field turns into a page-wide bucket that means nothing. The dashboard
 * neither reads it nor writes it.
 *
 * `reusability` — Narrow / Moderate / Broad — is what varies here and is the
 * only thing the page groups by.
 */
export function mapPattern(rec: AtRecord): BuildPatternDetail {
  const f = rec.fields;
  const pattern_id = str(f.pattern_id);
  const bha_system = str(f.bha_system);
  const { system, keywords } = classify(pattern_id, bha_system);
  return {
    id: rec.id,
    pattern_id,
    title: str(f.pattern_name) ?? pattern_id ?? '(unnamed pattern)',
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

/**
 * Eight single-selects on this table are dead scaffold: their only options are
 * whole English sentences, written once as placeholders, and the extractor has
 * never populated any of them. They exist on roughly half the records and say
 * nothing about any of them; `lane_state_blocked_reason` even has an option
 * whose name is the empty string. None is mapped, so none can be rendered.
 *
 *   demand_signal_sources · demand_evidence · cta_surface_plan ·
 *   media_twin_integration_plan · subscription_flow_state ·
 *   infra_readiness_state · engine_movement_state · lane_state_blocked_reason
 *
 * They are left in Airtable and left inside the stored `fields` blob — nothing
 * here renames or removes a column the engine owns — they simply have no way
 * onto the page.
 */
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
    infra_readiness: str(f.infra_readiness),
    data_readiness: str(f.data_readiness),
    media_readiness: str(f.media_readiness),
    missing_research_count: num(f.missing_research_count),
    missing_research_questions: questions,
    next_action: str(f.next_action),
    pain_point: str(f.pain_point),
    offer: str(f.offer),
    target: str(f.target),
    who_pays: str(f.who_pays),
    bha_system: str(f.bha_system),
    keywords: laneKeywords(lane),
    metrics_hypothesis: str(f.metrics_hypothesis),
    missing_proof: str(f.missing_proof),
    implementation_constraints: str(f.implementation_constraints),
    commercial_impact: str(f.commercial_impact),
    offer_shapes_gates: str(f.offer_shapes_gates),
    next_experiments: str(f.next_experiments),
    experiment_results: str(f.experiment_results),
    research_gleanings: str(f.research_gleanings),
    demand_strength_hypothesis: str(f.demand_strength_hypothesis),
    competing_offers_snapshot: str(f.competing_offers_snapshot),
    hypothesis_rejection_note: str(f.hypothesis_rejection_note),
    commercial_ready_v1_checklist: str(f.commercial_ready_v1_checklist),
    infra_gaps: str(f.infra_gaps),
    reuse_patterns: str(f.reuse_patterns),
    source_logs: str(f.source_logs),
    // Constant across all 21 cards: the extractor writes them and nothing
    // advances them. Shown on the card, never grouped on.
    pilot_state: str(f.pilot_state),
    routing_state: str(f.routing_state),
    lane_state: str(f.lane_state),
    media_gate: str(f.media_gate),
    created_at: iso(f.created_at),
    note: null,
    spine: { session_id: null, builder_id: null, subsystem: 'COMMERCIALOPPS', lane },
    source: airtableSource(COMMERCIAL.base, COMMERCIAL.table, rec.id),
    airtable: { base: COMMERCIAL.base, table: COMMERCIAL.table, record_id: rec.id, url: recordUrl(COMMERCIAL.base, COMMERCIAL.table, rec.id) },
  };
}

/**
 * The fields a complete extractor run writes on every card. The one record that
 * is missing them — CARD-1783965721620-1RJX, TRAY_DESIGN_AND_DOSING — is a
 * malformed row, not a category: it has no created_at, no media_readiness, no
 * pilot_state and no readiness_state. The page says so in those words rather
 * than drawing it as a fourth bucket beside Research-First and Media-Ready.
 */
export const COMMERCIAL_REQUIRED: { key: keyof Opportunity; label: string }[] = [
  { key: 'created_at', label: 'created_at' },
  { key: 'readiness_state', label: 'readiness_state' },
  { key: 'media_readiness', label: 'media_readiness' },
  { key: 'pilot_state', label: 'pilot_state' },
];

export function incompleteFields(o: Opportunity): string[] {
  return COMMERCIAL_REQUIRED.filter((r) => o[r.key] === null || o[r.key] === undefined).map((r) => r.label);
}

/* ------------------------------------------------------------ the twins */

/**
 * North Star's and Research Twin's own ask ledgers, and Research Twin's
 * research queue (2026-09-17).
 *
 * Both twins finish every run with the same three steps — write the ledger row,
 * mirror it to this dashboard, ingest it into BHARAG — so nothing finishes
 * without being recorded. The five tables marked `[LEGACY]` in Airtable have no
 * writers left and appear nowhere in this file any more:
 *
 *   appkCTjhH8PtYRFI7 / tbl9OGZTyvBKrbeFm   NS Records
 *   appud969Dw7H4tMwv / tblUl8YHhQReDgq8G   Research Queue
 *   app4QnMJ2woiKlLc0 / tblWdsbejQ9IYYHm1   Research Queue Resolved Events
 *   appSoakKvs7MLkRnX / tblvEivGSXUs5SXaG   Priority ledger
 *   appxkIgnLL1zBsXqD / tblbuOUGPLt4nIi0G   Lane_status
 *
 * Every field name, id and select vocabulary below was read from the live bases
 * on 17 Sep 2026. Two of them differ from the brief that asked for this work,
 * and the live base wins: `Delivered` is **Delivered / Not delivered / No
 * target** (plus **Self-delivered** on Research Twin) rather than ending in
 * "Failed", and Research Twin's `Ask Type` carries an **External web search**
 * option the brief did not list. A vocabulary this code invented would quietly
 * file real rows under a name Airtable never writes.
 */

export const NORTH_STAR = { base: 'appRvx4u9V9BYp646', table: 'tblSb9potJlYg2lZK', label: 'North Star asks' };
export const RESEARCH_TWIN = { base: 'appv39nQzmfC9VVkG', table: 'tblDmsqI9f0xfAO5m', label: 'Research Twin asks' };
export const RESEARCH_JOBS = { base: 'appv39nQzmfC9VVkG', table: 'tblOsznfDELJdbyDR', label: 'Research jobs' };

/** Read from the live bases, in the bases' own order. */
export const NS_OUTCOMES = ['Answered', 'Thin', 'Refused (not its lane)', 'Failed'];
export const NS_QUESTION_TYPES = ['Priority', 'Lane health', "What's moving", 'Capacity / load', 'Other'];
export const NS_SYSTEMS = ['Bays', 'Genie', 'Research Twin', 'Slack', 'Scheduled', 'Unknown'];
export const NS_DELIVERED = ['Delivered', 'Not delivered', 'No target'];
export const NS_PRIORITY_TIERS = ['Critical', 'High', 'Medium', 'Low', 'Minimal', 'Not stated'];
export const CONFIDENCE_STATED = ['High', 'Medium', 'Low', 'Not stated'];

export const RT_OUTCOMES = ['Answered', 'Thin', 'Needs human', 'Refused (not its lane)', 'Failed'];
export const RT_ASK_TYPES = ['Card research', 'Question', 'External web search', 'Watched client', 'Other'];
export const RT_SYSTEMS = ['Bays', 'Genie', 'North Star', 'Commercial Extractor', 'Weekly Clock', 'Slack', 'Scheduled', 'Unknown'];
export const RT_DELIVERED = ['Delivered', 'Not delivered', 'No target', 'Self-delivered'];
export const RT_BHARAG = ['Yes', 'No (degraded)', 'Not used'];

export const JOB_STATUSES = ['Pending', 'In Progress', 'Resolved', 'Capped (needs human)'];
export const JOB_OPENED_BY = ['Commercial Extractor', 'Bays', 'Research Twin', 'North Star', 'Genie', 'Person'];
export const JOB_GAP_TYPES = ['Missing sources', 'Conflicting sources', 'Unclear question', 'No path forward', 'Other'];
export const JOB_CONFIDENCE = ['High', 'Medium', 'Low'];

/** A job at three passes without a usable answer is handed to a person. */
export const JOB_ATTEMPT_CAP = 3;
export const JOB_CAPPED = 'Capped (needs human)';
export const JOB_RESOLVED = 'Resolved';

/**
 * `Evidence Used`, parsed back into tool calls.
 *
 * The two twins write it differently, and both shapes are read here rather than
 * one being assumed — the lines come from the agents' own tail nodes, which
 * were read from n8n on 17 Sep 2026 rather than guessed at:
 *
 *   North Star     `- bharag_search -> 12 row(s), cited 3 time(s) | args: {…}`
 *   Research Twin  `- bharag_search | args: {…}` then `  -> <observation>`
 *
 * **Research Twin's line carries no counts, so `hits` and `cited` are null on
 * its rows and never nought.** Nought would read as "called and came back with
 * nothing", which is a different and much worse fact than "not recorded", and
 * it is exactly the kind of invented figure this dashboard exists to remove.
 *
 * Anything else — an empty blob, `No tools were called on this run.`, a shape
 * neither twin writes — is no tool calls rather than a guess.
 */
const TOOL_LINE = /^[-•*]\s*(.+)$/;
/** Research Twin's second line for a call: `  -> <observation>`. Not a call of its own. */
const CONTINUATION = /^->/;
const NS_COUNTS = /->\s*(\d+)\s*row\(?s?\)?\s*,\s*cited\s*(\d+)\s*time/i;

export function parseEvidence(raw: unknown): AskTool[] {
  const text = str(raw);
  if (!text || /^no tools were called/i.test(text)) return [];
  const out: AskTool[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // Checked before the bullet match, not after: `->` starts with a hyphen, so
    // an observation line matches the bullet pattern and was being stored as a
    // tool called "> Found 6 results…". Caught by running the two twins' real
    // line formats through this, which is the only reason it is not in
    // production — assuming a format is how the last four of these got written.
    if (CONTINUATION.test(line)) continue;
    const m = TOOL_LINE.exec(line);
    if (!m) continue;
    let rest = m[1];

    // Arguments first. North Star puts `| args:` *after* the counts and
    // Research Twin puts it in place of them, so cutting the line at the counts
    // before reading the args threw North Star's away every time.
    const argsAt = rest.indexOf('| args:');
    const args = argsAt >= 0 ? rest.slice(argsAt + 7).trim() || null : null;
    if (argsAt >= 0) rest = rest.slice(0, argsAt);

    const counts = NS_COUNTS.exec(rest);
    let hits: number | null = null;
    let cited: number | null = null;
    if (counts) {
      hits = Number(counts[1]);
      cited = Number(counts[2]);
      rest = rest.slice(0, counts.index);
    }

    const name = rest.replace(/->.*$/, '').replace(/\|$/, '').trim();
    if (!name) continue;
    out.push({ tool: name, hits, cited, args });
  }
  return out;
}

/** Whole days between two stamps, or null where either is missing. */
function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function mapNsAsk(rec: AtRecord): NsAsk {
  const f = rec.fields;
  const at = iso(f['Asked At']);
  const answer = str(f.Answer);
  return {
    id: rec.id,
    ask_id: str(f['Ask ID']),
    asked_at: at,
    week: at ? isoWeek(at) : null,
    asked_by_system: str(f['Asked By System']),
    asked_by_person: str(f['Asked By Person']),
    question: str(f.Question),
    question_type: str(f['Question Type']),
    lane: str(f.Lane),
    answer,
    answer_summary: str(f['Answer Summary']),
    has_answer: Boolean(answer),
    outcome: str(f.Outcome),
    claimed_priority_score: num(f['Claimed Priority Score']),
    claimed_priority_tier: str(f['Claimed Priority Tier']),
    claimed_lane_health: str(f['Claimed Lane Health']),
    claimed_strategic_importance: str(f['Claimed Strategic Importance']),
    architect_attention: bool(f['Architect Attention']),
    tools: parseEvidence(f['Evidence Used']),
    evidence_used: str(f['Evidence Used']),
    citation_coverage: num(f['Citation Coverage']),
    confidence_stated: str(f['Confidence Stated']),
    response_seconds: num(f['Response Seconds']),
    delivered: str(f.Delivered),
    delivery_target: str(f['Delivery Target']),
    slack_link: str(f['Slack Link']),
    error: str(f.Error),
    run_id: str(f['Run ID']),
    linked_twin_ask: str(f['Linked Twin Ask']),
    source: airtableSource(NORTH_STAR.base, NORTH_STAR.table, rec.id),
    airtable: { base: NORTH_STAR.base, table: NORTH_STAR.table, record_id: rec.id, url: recordUrl(NORTH_STAR.base, NORTH_STAR.table, rec.id) },
  };
}

export function mapRtAsk(rec: AtRecord): RtAsk {
  const f = rec.fields;
  const at = iso(f['Asked At']);
  const answer = str(f.Answer);
  return {
    id: rec.id,
    ask_id: str(f['Ask ID']),
    asked_at: at,
    week: at ? isoWeek(at) : null,
    asked_by_system: str(f['Asked By System']),
    asked_by_person: str(f['Asked By Person']),
    ask_type: str(f['Ask Type']),
    question: str(f.Question),
    card_id: str(f['Card ID']),
    lane: str(f.Lane),
    answer,
    answer_summary: str(f['Answer Summary']),
    has_answer: Boolean(answer),
    outcome: str(f.Outcome),
    confidence_stated: str(f['Confidence Stated']),
    used_web_search: bool(f['Used Web Search']),
    bharag_reachable: str(f['BHARAG Reachable']),
    sources_count: num(f['Sources Count']),
    sources: str(f.Sources),
    tools: parseEvidence(f['Evidence Used']),
    evidence_used: str(f['Evidence Used']),
    citation_coverage: num(f['Citation Coverage']),
    response_seconds: num(f['Response Seconds']),
    delivered: str(f.Delivered),
    delivery_target: str(f['Delivery Target']),
    slack_link: str(f['Slack Link']),
    error: str(f.Error),
    run_id: str(f['Run ID']),
    linked_twin_ask: str(f['Linked Twin Ask']),
    source: airtableSource(RESEARCH_TWIN.base, RESEARCH_TWIN.table, rec.id),
    airtable: { base: RESEARCH_TWIN.base, table: RESEARCH_TWIN.table, record_id: rec.id, url: recordUrl(RESEARCH_TWIN.base, RESEARCH_TWIN.table, rec.id) },
  };
}

export function mapRtJob(rec: AtRecord, now = new Date().toISOString()): RtJob {
  const f = rec.fields;
  const opened = iso(f['Opened At']) ?? iso(rec.createdTime);
  const resolved = iso(f['Resolved At']);
  const status = str(f.Status);
  const open = status !== JOB_RESOLVED && status !== JOB_CAPPED;
  return {
    id: rec.id,
    job_id: str(f['Job ID']),
    question: str(f.Question),
    context: str(f.Context),
    card_id: str(f['Card ID']),
    lane: str(f.Lane),
    status,
    opened_by: str(f['Opened By']),
    opened_at: opened,
    resolved_at: resolved,
    attempts: num(f.Attempts),
    finding: str(f.Finding),
    answer_history: str(f['Answer History']),
    sources: str(f.Sources),
    verdict: str(f.Verdict),
    confidence: str(f.Confidence),
    gap_type: str(f['Gap Type']),
    missing_elements: str(f['Missing Elements']),
    target_source_types: str(f['Target Source Types']),
    // Newline separated, newest last, as the field's own description says.
    linked_asks: (str(f['Linked Asks']) ?? '').split('\n').map((v) => v.trim()).filter(Boolean),
    reported_in_digest: bool(f['Reported In Digest']),
    /**
     * Three different questions, kept apart. `age_days` is always how long ago
     * the job was opened; `days_open` is how long it has been *waiting*, which
     * a resolved or capped job is no longer doing; `days_to_resolve` exists
     * only once it has been resolved.
     */
    age_days: daysBetween(opened, now),
    days_open: open ? daysBetween(opened, now) : null,
    days_to_resolve: daysBetween(opened, resolved),
    open,
    capped: status === JOB_CAPPED,
    source: airtableSource(RESEARCH_JOBS.base, RESEARCH_JOBS.table, rec.id),
    airtable: { base: RESEARCH_JOBS.base, table: RESEARCH_JOBS.table, record_id: rec.id, url: recordUrl(RESEARCH_JOBS.base, RESEARCH_JOBS.table, rec.id) },
  };
}

/* --------------------------------------------------------------- clients */

/**
 * The watched-clients index and the per-lane question tables.
 *
 * Each index row names its own questions table in `Table ID`. That field is
 * read at sync time and followed; there is no lane-to-table map in this code,
 * because the same hardcoded map was removed from the pipeline on 2026-09-10
 * for the same reason — adding a lane should be a row, not a deploy.
 */
export const CLIENTS_INDEX = { base: 'appkSUSh9ijNjP2f8', table: 'tblFJ1yuYcuanjPdn', label: 'Index' };

export function mapClientLane(rec: AtRecord): ClientLane {
  const f = rec.fields;
  return {
    id: rec.id,
    name: str(f['Lane / Client']) ?? '(unnamed lane)',
    lane_id: str(f['Lane ID']),
    lane_type: str(f['Lane Type']),
    /** Groups lanes under one client. Two rows with the same id are one client with two lanes. */
    client_id: str(f['Client ID']),
    questions_table_name: str(f['Questions Table']),
    questions_table: str(f['Table ID']),
    lane_status: str(f['Lane Status']),
    run_state: str(f['Run State']),
    last_run_at: iso(f['Last Run At']),
    next_run_due: iso(f['Next Run Due']),
    last_run_status: str(f['Last Run Status']),
    consecutive_errors: num(f['Consecutive Error Count']) ?? 0,
    infra_fix_required: bool(f['Infra Fix Required']),
    first_stuck_at: iso(f['First Stuck At']),
    stuck_cycles: num(f['Stuck Cycle Count']) ?? 0,
    quarantined: bool(f.Quarantined),
    commercial_hook: str(f['Commercial Hook']),
    interested_parties: str(f['Interested Parties']),
    latest_memo: str(f['Latest Memo Link']),
    source: airtableSource(CLIENTS_INDEX.base, CLIENTS_INDEX.table, rec.id),
    airtable: { base: CLIENTS_INDEX.base, table: CLIENTS_INDEX.table, record_id: rec.id, url: recordUrl(CLIENTS_INDEX.base, CLIENTS_INDEX.table, rec.id) },
  };
}

export function mapClientQuestion(rec: AtRecord, laneId: string, table: string): ClientQuestion {
  const f = rec.fields;
  return {
    id: rec.id,
    lane_id: laneId,
    table,
    question: str(f.Question) ?? '(no question text)',
    answer: str(f['This Week Answer']),
    plain_summary: str(f['Plain Summary']),
    confidence: str(f.Confidence),
    sources: str(f.Sources),
    movement_tag: str(f['Movement Tag']),
    answer_history: str(f['Answer History']),
    last_updated: iso(f['Last Updated']),
    missing_research: bool(f['Missing Research']),
    research_stuck: bool(f['Research Stuck']),
    next_experiments: str(f['Next Experiments']),
    run_count: num(f['Run Count']) ?? 0,
    source: airtableSource(CLIENTS_INDEX.base, table, rec.id),
    airtable: { base: CLIENTS_INDEX.base, table, record_id: rec.id, url: recordUrl(CLIENTS_INDEX.base, table, rec.id) },
  };
}

/**
 * "Needs a human" on a question. All three of these circuit breakers are
 * already computed upstream and written to the row; this reads them, it does
 * not recompute what they mean.
 */
/**
 * Client Requests — one row per thing a client has asked for
 * (`tblhu29KejAPQfSuy`, created 17 Sep 2026 for LOOP-1789590960971-EHF9).
 *
 * It lives in the client research base and keys on the same `Client ID` the
 * index does, so a request sits under the client that made it. The weekly
 * Research Loop does not read it; nothing here writes to it.
 */
export const CLIENT_REQUESTS = { base: CLIENTS_INDEX.base, table: 'tblhu29KejAPQfSuy', label: 'Client Requests' };

/**
 * Read from the live base on 17 Sep 2026, not assumed.
 *
 * **The order of `REQUEST_STATUSES` is the pipeline's own order** and is what
 * decides which end of it counts as settled: everything before `Confirmed` is
 * still interest. `OPEN_REQUEST_STATUSES` names that literally rather than
 * testing "not Delivered", because a status nobody planned for should read as
 * open — the unsafe direction here is calling something a commitment.
 */
export const REQUEST_STATUSES = ['Requested', 'Under Review', 'Confirmed', 'Delivered', 'Declined'];
export const REQUEST_CATEGORIES = ['Units', 'Kiosk', 'Idle Show', 'Signage', 'Other'];
export const OPEN_CHECKS = ['Feasibility', 'Licensing', 'Food Safety', 'Pricing', 'Ownership'];

/** Still interest rather than commitment. A status this list does not know is counted here. */
export function requestIsOpen(status: string | null): boolean {
  return status !== 'Confirmed' && status !== 'Delivered' && status !== 'Declined';
}

export function mapClientRequest(rec: AtRecord): ClientRequest {
  const f = rec.fields;
  return {
    id: rec.id,
    request: str(f.Request) ?? '(unnamed request)',
    client_id: str(f['Client ID']),
    lane_id: str(f['Lane ID']),
    category: str(f.Category),
    status: str(f.Status),
    // A multipleSelects field arrives as an array of names. An empty one means
    // nothing is outstanding, which is a different thing from a missing field
    // and is why this is never null.
    open_checks: Array.isArray(f['Open Checks']) ? (f['Open Checks'] as unknown[]).map((v) => String(v)).filter(Boolean) : [],
    details: str(f.Details),
    raised_by: str(f['Raised By']),
    date_requested: iso(f['Date Requested']),
    notes: str(f.Notes),
    source: airtableSource(CLIENT_REQUESTS.base, CLIENT_REQUESTS.table, rec.id),
    airtable: { base: CLIENT_REQUESTS.base, table: CLIENT_REQUESTS.table, record_id: rec.id, url: recordUrl(CLIENT_REQUESTS.base, CLIENT_REQUESTS.table, rec.id) },
  };
}

export function questionNeedsHuman(q: ClientQuestion, lane: ClientLane | undefined): boolean {
  return q.research_stuck || q.run_count >= 3 || Boolean(lane?.quarantined);
}
