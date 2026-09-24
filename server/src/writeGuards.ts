/**
 * The write guards, in one place (2026-09-24, Destiny).
 *
 * Until now these lived only in n8n — the Code nodes of `Bays — Tools Router`
 * (`WjWzhVRq566A60fJ`) — so a write that did not come through Bays ran none of
 * them. The MCP write tools need the same checks, and a copy in the tool would
 * be a third place for the rules to disagree. So they are ported here,
 * verbatim in logic and with the n8n reasoning kept beside each one, and the
 * MCP tools call them. The ported nodes, by name:
 *
 *   `LOL - Prepare Loop Fields`   lane set, lane owners, assignee defaulting,
 *                                 the lane-owner gate, the loop id
 *   `LOL - Score Candidates`      the duplicate gate: tokens, Jaccard and
 *                                 containment, 0.35, top 3
 *   `UOL - Merge Updates`         who may update a loop; a lane is only ever
 *                                 set to one of the locked set
 *   `LBP - Normalise Pattern Fields`   cleaning, the checklist join, the
 *                                 `BP-` id, `created_at`, the BHARAG document
 *   `Flag_Pattern_Candidate` (Bays — Conversational Agent)   `CAND-` ids,
 *                                 Status starting at Proposed
 *
 * **A guard that refuses writes nothing** and says why, with what to send to
 * proceed — `confirmed_new`, `confirmed_assignee` — exactly the escape hatches
 * the Tools Router gives Bays. Nothing here writes; it returns what should be
 * written, and the caller writes it through `engineWrite`, the same function
 * n8n's POST and PATCH go through.
 */
import { query } from './pg';
import * as mirror from './mirror';
import { CODEX_JASON_STATUS, JOB_STATUSES, SLACK_TO_BUILDER } from './sources';

/* ------------------------------------------------------ the loop rules */

/**
 * Sept 2 -- the locked 9-lane set plus UNASSIGNED. lane_tag is EXECUTION
 * OWNER, not initiative: it answers "whose lane does the work land in".
 */
export const LANES = ['RT', 'NS', 'VFARM_HARDWARE', 'KIOSK', 'CAD_API', 'MEDIA', 'GENIE', 'CST', 'BAYS', 'UNASSIGNED'] as const;

/**
 * Sept 3 -- the other half of the lane map. A lane with a known owner and an
 * assignee who is somebody else is not written silently and not corrected
 * silently: either could be right, so it is refused until confirmed.
 * UNASSIGNED is deliberately absent: no owner means no gate to enforce.
 */
export const LANE_OWNERS: Record<string, string> = {
  RT: 'U0AEW3TBYH1', // Destiny
  NS: 'U0AEW3TBYH1', // Destiny
  VFARM_HARDWARE: 'U0AF011R821', // Jegan
  KIOSK: 'U0BNQGG020Y', // Kavin
  CAD_API: 'U0BKT6MAW2Y', // Hardik
  MEDIA: 'U0BKT6MAW2Y', // Hardik -- owns Media Twin and the Canon Render visual lane
  GENIE: 'U0AD1V1D65N', // Kaiqi
  CST: 'U0AC6RFNP3P', // Ahad
  BAYS: 'U0AEW3TBYH1', // Destiny
};

/** Bays's own Slack id. Bays can never own a loop: it has no table and no way to act on its own backlog. */
export const BAYS_ID = 'U0BD5EA1F71';
/** Where a loop with no lane owner falls. */
export const DEFAULT_OWNER = 'U0AEW3TBYH1';
/** Who may update any loop. Anyone else only a loop assigned to them, or an unassigned one. */
export const ADMIN_IDS = ['U0AEW3TBYH1', 'U0A9V97949F'];

export const LOOP_STATUSES = ['Open', 'In Progress', 'Closed'] as const;
/** Declined (2026-09-24): an architect's "this is not a pattern", from the Candidates tab, with a reason. */
export const CANDIDATE_STATUSES = ['Proposed', 'Approved', 'Registered', 'Declined'] as const;
/** `Sent Back` is held on a live row and is the pipeline's own, so it is allowed alongside the three the dashboard knows. */
export const CODEX_STATUSES = [...CODEX_JASON_STATUS, 'Sent Back'] as const;

const DUPLICATE_THRESHOLD = 0.35;
const DUPLICATE_MAX = 3;
/** At least this many shared meaningful words, unless the score alone is high (2026-09-24). */
export const DUPLICATE_MIN_SHARED = 3;
export const DUPLICATE_STRONG_SCORE = 0.6;

/* --------------------------------------------------------------- helpers */

/**
 * `LBP - Normalise Pattern Fields`' `clean`, for every kind: carriage returns
 * dropped, tabs to spaces, every other control character to a space, trimmed.
 * Newlines survive, because a loop's What or a pattern's solution has them.
 * Applied inside arrays and objects too, so a list of strings is cleaned
 * whole.
 */
export function clean(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replace(/\r/g, '')
      .replace(/\t/g, ' ')
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
      .trim();
  }
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clean(x)]));
  return v;
}

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  return clean(fields) as Record<string, unknown>;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : typeof v === 'object' && v && 'name' in v ? String((v as { name: unknown }).name ?? '').trim() : String(v).trim();
}

/** `Math.random().toString(36)` upper-cased, four characters — the suffix every n8n id carries. */
function suffix(): string {
  let s = '';
  while (s.length < 4) s += Math.random().toString(36).substring(2).toUpperCase();
  return s.slice(0, 4);
}

export function mintLoopId(): string {
  return `LOOP-${Date.now()}-${suffix()}`;
}

/** `BP-<SYSTEM, A-Z0-9 only, up to 8>-<ms>-<4>`, defaulting the system to BAYS, as `LBP` mints it. */
export function mintPatternId(system: string): string {
  const domain = (system || 'BAYS').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'BAYS';
  return `BP-${domain}-${Date.now()}-${suffix()}`;
}

const today = () => new Date().toISOString().slice(0, 10);

/* ----------------------------------------------------- the kind registry */

export interface GuardInfo {
  name: string;
  applies_to: 'create' | 'update' | 'create and update' | 'archive and delete';
  does: string;
}

export interface WritableKind {
  kind: mirror.MirrorKind;
  /** Required on create, by field name as stored. */
  required: string[];
  /** Fields whose value must be one of a list. */
  selects: Record<string, readonly string[]>;
  /** How the natural id is made when the caller does not send one. */
  id_minted: string | null;
  /** The archived state the page already draws, or null where the kind has none. */
  archive: { field: string; value: string } | null;
  deletable: boolean;
  /** Which BHARAG workspace a create is ingested into. */
  ingest: 'codex' | 'build_patterns' | 'commercial' | null;
  guards: GuardInfo[];
  /** Envelope arguments beyond `fields` this kind needs. */
  envelope?: string;
}

const EVERY: GuardInfo[] = [
  { name: 'control_characters', applies_to: 'create and update', does: 'Every string value is cleaned as LBP - Normalise Pattern Fields cleans it: \\r dropped, tabs and other control characters to spaces, trimmed.' },
  { name: 'required_fields', applies_to: 'create', does: 'Every required field is present and non-empty, or nothing is written.' },
  { name: 'select_values', applies_to: 'create and update', does: 'A field with a fixed vocabulary only takes one of its values; anything else is refused, never written as a new option.' },
  { name: 'no_overwrite_on_create', applies_to: 'create', does: 'create_record never updates: a natural id this table already holds is refused, and update_record is named instead.' },
];

export const WRITABLE: Record<string, WritableKind> = {
  loops: {
    kind: 'loops',
    required: ['What', 'Raised By'],
    selects: { Status: LOOP_STATUSES, lane_tag: LANES },
    id_minted: 'loop_id = LOOP-<ms>-<4>',
    archive: { field: 'Status', value: 'Closed' },
    deletable: true,
    ingest: null,
    envelope: 'confirmed_new, confirmed_assignee (booleans, the Tools Router’s escape hatches); requester_user_id (required on update, archive and delete)',
    guards: [
      ...EVERY,
      { name: 'lane_validation', applies_to: 'create and update', does: `lane_tag is normalised (upper case, spaces and hyphens to _) and must be one of ${LANES.join(', ')}. On create anything else becomes UNASSIGNED, never guessed; on update an unknown lane is refused.` },
      { name: 'assignee_default', applies_to: 'create', does: `A blank assignee, or Bays (${BAYS_ID}), falls to the lane owner; only a lane with no owner falls to Destiny. Bays is never an assignee.` },
      { name: 'lane_owner_gate', applies_to: 'create', does: 'An assignee who is not the lane owner is refused (lane_owner_mismatch) unless confirmed_assignee is true. Nothing is written.' },
      { name: 'duplicate_gate', applies_to: 'create', does: `The new What is scored against the assignee’s open loops — tokens over 2 characters less stopwords, the higher of Jaccard and containment; a candidate counts when the score is at least ${DUPLICATE_THRESHOLD} and it shares at least ${DUPLICATE_MIN_SHARED} meaningful words or scores at least ${DUPLICATE_STRONG_SCORE}; top ${DUPLICATE_MAX}. Any survivor is refused (possible_duplicate) unless confirmed_new is true. Nothing is written.` },
      { name: 'update_permission', applies_to: 'create and update', does: `requester_user_id is required on update, archive and delete. ${ADMIN_IDS.join(' and ')} may change any loop; anyone else only a loop assigned to them, or an unassigned one.` },
      { name: 'loop_id_shape', applies_to: 'create', does: 'loop_id is minted LOOP-<ms>-<4> when absent, and a supplied one must have that shape.' },
    ],
  },
  codex: {
    kind: 'codex',
    required: ['Submission ID'],
    selects: { 'Jason Status': CODEX_STATUSES },
    id_minted: null,
    archive: null,
    deletable: false,
    ingest: 'codex',
    envelope: 'builder_id (one of the seven, or a Slack id with a Builder Profiles row) — required on create',
    guards: [...EVERY],
  },
  patterns: {
    kind: 'patterns',
    required: ['pattern_name'],
    selects: {},
    id_minted: 'pattern_id = BP-<SYSTEM>-<ms>-<4>, SYSTEM from bha_system (A-Z0-9, up to 8), default BAYS',
    archive: null,
    deletable: true,
    ingest: 'build_patterns',
    guards: [
      ...EVERY,
      { name: 'pattern_normalise', applies_to: 'create', does: 'LBP - Normalise Pattern Fields: every field cleaned, implementation_checklist joined with " | " when a list, reusability defaulting to Moderate, created_at stamped now, pattern_id minted when absent.' },
    ],
  },
  pattern_candidates: {
    kind: 'pattern_candidates',
    required: ['Candidate', 'Summary'],
    selects: { Status: CANDIDATE_STATUSES, Lane: LANES },
    id_minted: 'natural_id = CAND-<ms>-<4>',
    archive: null,
    deletable: true,
    ingest: null,
    envelope: 'natural_id (optional; minted CAND-<ms>-<4>); confirmed_new to record a candidate whose name is already held',
    guards: [
      ...EVERY,
      { name: 'candidate_duplicate_by_name', applies_to: 'create', does: 'A candidate whose name, compared case- and punctuation-blind, is already held is refused (possible_duplicate) unless confirmed_new is true.' },
      { name: 'candidate_starts_proposed', applies_to: 'create', does: 'Status is Proposed on create whatever is sent, and Date Flagged defaults to today — as Flag_Pattern_Candidate writes it.' },
    ],
  },
  commercial: {
    kind: 'commercial',
    required: ['opportunity_title'],
    selects: { confidence: ['High', 'Medium', 'Low'] },
    id_minted: 'card_id = CARD-<ms>-<4>',
    archive: null,
    deletable: true,
    ingest: 'commercial',
    guards: [...EVERY, { name: 'card_stamp', applies_to: 'create', does: 'card_id minted CARD-<ms>-<4> when absent, created_at stamped now when absent.' }],
  },
  'rt-jobs': {
    kind: 'rt-jobs',
    required: ['Question'],
    selects: { Status: JOB_STATUSES },
    id_minted: 'Job ID = JOB-<ms>-<4>',
    archive: null,
    deletable: true,
    ingest: null,
    guards: [...EVERY, { name: 'job_defaults', applies_to: 'create', does: 'Job ID minted when absent; Status Pending, Attempts 0 and Opened At now unless sent.' }],
  },
  lane_backlog: {
    kind: 'lane_backlog',
    required: ['task', 'lane'],
    selects: {},
    id_minted: 'task_id = TASK-<ms>-<4>',
    archive: null,
    deletable: true,
    ingest: null,
    guards: [...EVERY, { name: 'task_id', applies_to: 'create', does: 'task_id minted TASK-<ms>-<4> when absent.' }],
  },
  builder_profiles: {
    kind: 'builder_profiles',
    required: ['user_id', 'name', 'pronouns', 'lane', 'role'],
    selects: {},
    id_minted: null,
    archive: null,
    deletable: true,
    ingest: null,
    guards: [...EVERY, { name: 'slack_user_id', applies_to: 'create', does: 'user_id must look like a Slack user id (U or W, then upper-case letters and digits) — it is what a loop or Codex write names the builder by.' }],
  },
};

export const WRITABLE_KINDS = Object.keys(WRITABLE);

export function writable(kind: string): WritableKind | null {
  return Object.prototype.hasOwnProperty.call(WRITABLE, kind) ? WRITABLE[kind] : null;
}

/**
 * Kinds `delete_record` takes that no other write tool does (2026-09-24,
 * Destiny). Research Twin's asks are written by the agent at the end of a run
 * and are not created or edited over MCP, but a test delivery is a row nobody
 * asked, and it has to be removable without a SQL console. Same confirm, same
 * record_deletions copy, same audit line as every other delete.
 */
export const DELETE_ONLY: Record<string, WritableKind> = {
  'rt-asks': {
    kind: 'rt-asks',
    required: [],
    selects: {},
    id_minted: null,
    archive: null,
    deletable: true,
    ingest: null,
    guards: [],
  },
};

export const DELETABLE_KINDS = [...WRITABLE_KINDS, ...Object.keys(DELETE_ONLY)];

export function deletable(kind: string): WritableKind | null {
  return writable(kind) ?? (Object.prototype.hasOwnProperty.call(DELETE_ONLY, kind) ? DELETE_ONLY[kind] : null);
}

/* ------------------------------------------------------- the results */

export interface Check {
  guard: string;
  result: 'pass' | 'fail' | 'applied' | 'skipped';
  note?: string;
}

export interface Refusal {
  ok: false;
  reason: 'missing_required' | 'invalid_value' | 'lane_owner_mismatch' | 'possible_duplicate' | 'not_permitted' | 'already_exists' | 'not_found' | 'not_writable' | 'bad_request';
  message: string;
  detail?: Record<string, unknown>;
  checks: Check[];
}

export interface CreatePlan {
  ok: true;
  input: mirror.MirrorInput;
  natural_id: string;
  checks: Check[];
}

export interface UpdatePlan {
  ok: true;
  fields: Record<string, unknown>;
  checks: Check[];
}

export interface CreateOptions {
  natural_id?: string | null;
  builder_id?: string | null;
  confirmed_new?: boolean;
  confirmed_assignee?: boolean;
  requester_user_id?: string | null;
}

function refuse(reason: Refusal['reason'], message: string, checks: Check[], detail?: Record<string, unknown>): Refusal {
  return { ok: false, reason, message, checks, ...(detail ? { detail } : {}) };
}

function checkSelects(spec: WritableKind, fields: Record<string, unknown>, checks: Check[]): Refusal | null {
  for (const [field, allowed] of Object.entries(spec.selects)) {
    if (!(field in fields) || fields[field] === null || fields[field] === undefined || fields[field] === '') continue;
    const v = str(fields[field]);
    const match = allowed.find((a) => a === v) ?? allowed.find((a) => a.toLowerCase() === v.toLowerCase());
    if (!match) {
      checks.push({ guard: 'select_values', result: 'fail', note: `${field}: "${v}"` });
      return refuse('invalid_value', `"${field}": "${v}" is not one of ${allowed.join(', ')}. Nothing was written.`, checks, { field, value: v, allowed });
    }
    fields[field] = match;
  }
  checks.push({ guard: 'select_values', result: 'pass' });
  return null;
}

function checkRequired(spec: WritableKind, fields: Record<string, unknown>, checks: Check[]): Refusal | null {
  const missing = spec.required.filter((f) => !str(fields[f]));
  if (missing.length) {
    checks.push({ guard: 'required_fields', result: 'fail', note: missing.join(', ') });
    return refuse('missing_required', `${spec.kind} needs ${missing.map((m) => `"${m}"`).join(', ')} in fields. Nothing was written.`, checks, { missing });
  }
  checks.push({ guard: 'required_fields', result: 'pass' });
  return null;
}

async function alreadyHeld(kind: mirror.MirrorKind, natural: string): Promise<number | null> {
  const r = await query<{ id: string }>(`SELECT id FROM ${mirror.KINDS[kind].table} WHERE natural_id = $1 ORDER BY id LIMIT 1`, [natural]);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

/* ----------------------------------------------------- the duplicate gate */

/**
 * `LOL - Score Candidates`' stopwords, plus nine added 2026-09-24 (Destiny):
 * test, agent, bays, check, run, build, update, new, add. They are the words
 * the engine's own asks are full of — "Dry-run connectivity test from Bays
 * agent" was refused as a duplicate of three unrelated loops at 0.4 on exactly
 * these — so they say nothing about whether two loops are the same work.
 */
const STOP = new Set(['the','and','for','that','this','with','from','into','not','are','was','were','has','have','had','can','should','need','needs','via','per','you','your','our','all','any','but','its','who','how','why','what','when','then','than','also','been','will','would','once','each','other','same','only','over','more','most','some','such','they','them','their','there','here','which','while','after','before','being','does','done','make','made','get','got','test','agent','bays','check','run','build','update','new','add']);

export function tokens(s: string): Set<string> {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/**
 * `LOL - Score Candidates`, stage 2 of the dedup cascade: normalised token
 * overlap, no model call. Two measures and the higher wins — Jaccard catches
 * a near-identical restatement, containment catches a new ask fully covered
 * by an existing longer loop, which is the shape that slipped through on
 * 1 Sep. The threshold starts strict: a false "looks like a duplicate" costs a
 * human interruption every time.
 */
export function compare(incoming: string, existing: string): { score: number; shared: number } {
  const a = tokens(incoming);
  const b = tokens(existing);
  let shared = 0;
  a.forEach((t) => {
    if (b.has(t)) shared++;
  });
  const union = new Set([...a, ...b]).size;
  const jaccard = union ? shared / union : 0;
  const containment = a.size ? shared / a.size : 0;
  return { score: Number(Math.max(jaccard, containment).toFixed(3)), shared };
}

export function score(incoming: string, existing: string): number {
  return compare(incoming, existing).score;
}


/**
 * Whether a candidate counts as a possible duplicate (2026-09-24, Destiny):
 * score >= 0.35 **and** (at least 3 shared meaningful words **or** score >=
 * 0.6). A short ask sharing two generic words with a long loop scored 0.4 on
 * containment alone and was refused; two words in common is not the same work.
 */
export function isDuplicate(c: { score: number; shared: number }): boolean {
  return c.score >= DUPLICATE_THRESHOLD && (c.shared >= DUPLICATE_MIN_SHARED || c.score >= DUPLICATE_STRONG_SCORE);
}

/**
 * Stage 1 is the partition: only the assignee's own open loops are searched,
 * never all seven tables. "Open" is Open or In Progress — a closed loop is not
 * one a new ask can duplicate.
 */
async function duplicateCandidates(builderId: string, what: string): Promise<{ loop_id: string; what: string; status: string; lane_tag: string; score: number; shared_words: number }[]> {
  const r = await query<{ fields: Record<string, unknown> }>(
    `SELECT fields FROM ${mirror.KINDS.loops.table} WHERE builder_id = $1 AND fields->>'Status' IN ('Open', 'In Progress') AND fields ? 'loop_id'`,
    [builderId],
  );
  return r.rows
    .map((row) => {
      const c = compare(what, str(row.fields.What));
      return {
        loop_id: str(row.fields.loop_id),
        what: str(row.fields.What),
        status: str(row.fields.Status),
        lane_tag: str(row.fields.lane_tag),
        score: c.score,
        shared_words: c.shared,
      };
    })
    .filter((c) => isDuplicate({ score: c.score, shared: c.shared_words }))
    .sort((x, y) => y.score - x.score)
    .slice(0, DUPLICATE_MAX);
}

/** Which of the seven a Slack id names, or the id itself for a profile builder. */
function builderOf(slackId: string): string {
  return SLACK_TO_BUILDER[slackId] ?? slackId;
}

/* ---------------------------------------------------------------- create */

export async function planCreate(kind: string, rawFields: Record<string, unknown>, opts: CreateOptions): Promise<CreatePlan | Refusal> {
  const spec = writable(kind);
  const checks: Check[] = [];
  if (!spec) return refuse('not_writable', `"${kind}" is not a kind the MCP write tools can write. One of: ${WRITABLE_KINDS.join(', ')}.`, checks);
  const fields = cleanFields(rawFields);
  checks.push({ guard: 'control_characters', result: 'applied' });

  let natural = '';
  const input: mirror.MirrorInput = { fields, created_time: new Date().toISOString() };

  switch (spec.kind) {
    case 'loops': {
      /**
       * `LOL - Prepare Loop Fields`. The lane is validated first, because the
       * lane decides the default owner.
       */
      const rawLane = str(fields.lane_tag).toUpperCase().replace(/[\s-]+/g, '_');
      const lane = (LANES as readonly string[]).includes(rawLane) ? rawLane : 'UNASSIGNED';
      checks.push({ guard: 'lane_validation', result: rawLane === lane ? 'pass' : 'applied', note: rawLane === lane ? lane : `"${rawLane || '(blank)'}" is not a locked lane, so UNASSIGNED` });
      fields.lane_tag = lane;
      const owner = LANE_OWNERS[lane] ?? '';

      let assignee = str(fields['Assignee Slack User ID']);
      let derived = false;
      if (!assignee || assignee === BAYS_ID) {
        const was = assignee;
        if (owner) {
          assignee = owner;
          derived = true;
        } else assignee = DEFAULT_OWNER;
        checks.push({ guard: 'assignee_default', result: 'applied', note: `${was === BAYS_ID ? 'Bays cannot own a loop' : 'no assignee'}, so ${assignee}${owner ? ' (the lane owner)' : ' (no lane owner)'}` });
      } else checks.push({ guard: 'assignee_default', result: 'skipped', note: 'assignee given' });
      fields['Assignee Slack User ID'] = assignee;

      if (owner && !derived && assignee !== owner && !opts.confirmed_assignee) {
        checks.push({ guard: 'lane_owner_gate', result: 'fail', note: `${lane} is owned by ${owner}` });
        return refuse(
          'lane_owner_mismatch',
          `${lane} is owned by ${owner}, and this loop is assigned to ${assignee}. Nothing was written. Either could be right — a mis-attribution or a deliberate cross-lane assignment — so ask, then call again with confirmed_assignee: true to keep ${assignee}, or with the owner as assignee.`,
          checks,
          { lane, lane_owner: owner, assignee },
        );
      }
      checks.push({ guard: 'lane_owner_gate', result: owner && assignee !== owner ? 'skipped' : 'pass', note: owner && assignee !== owner ? 'confirmed_assignee' : undefined });

      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;

      const suppliedId = str(fields.loop_id);
      if (suppliedId && !/^LOOP-\d+-[A-Z0-9]{4}$/.test(suppliedId)) {
        checks.push({ guard: 'loop_id_shape', result: 'fail' });
        return refuse('invalid_value', `"loop_id": "${suppliedId}" is not LOOP-<ms>-<4>. Leave it out and one is minted.`, checks);
      }
      natural = suppliedId || mintLoopId();
      fields.loop_id = natural;
      checks.push({ guard: 'loop_id_shape', result: suppliedId ? 'pass' : 'applied', note: natural });
      if (!str(fields.Status)) fields.Status = 'Open';
      if (!str(fields['Date Raised'])) fields['Date Raised'] = today();
      if (fields['Source Link'] === undefined) fields['Source Link'] = '';
      const bad = checkSelects(spec, fields, checks);
      if (bad) return bad;

      const builder = builderOf(assignee);
      input.builder_id = assignee;

      if (opts.confirmed_new) {
        checks.push({ guard: 'duplicate_gate', result: 'skipped', note: 'confirmed_new' });
      } else {
        const candidates = await duplicateCandidates(builder, str(fields.What));
        if (candidates.length) {
          checks.push({ guard: 'duplicate_gate', result: 'fail', note: candidates.map((c) => `${c.loop_id} ${c.score}`).join(', ') });
          return refuse(
            'possible_duplicate',
            `${candidates.length} open loop(s) on ${builder}’s table look like this one. Nothing was written. Ask whether it is one of these; to keep it separate, call again with confirmed_new: true.`,
            checks,
            { candidates, rule: `score >= ${DUPLICATE_THRESHOLD} and (shared words >= ${DUPLICATE_MIN_SHARED} or score >= ${DUPLICATE_STRONG_SCORE})` },
          );
        }
        checks.push({ guard: 'duplicate_gate', result: 'pass' });
      }
      break;
    }

    case 'patterns': {
      /** `LBP - Normalise Pattern Fields`. */
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      if (Array.isArray(fields.implementation_checklist)) fields.implementation_checklist = (fields.implementation_checklist as unknown[]).map(str).filter(Boolean).join(' | ');
      if (!str(fields.reusability)) fields.reusability = 'Moderate';
      fields.created_at = str(fields.created_at) || new Date().toISOString();
      natural = str(fields.pattern_id) || mintPatternId(str(fields.bha_system));
      fields.pattern_id = natural;
      checks.push({ guard: 'pattern_normalise', result: 'applied', note: natural });
      break;
    }

    case 'pattern_candidates': {
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      fields.Status = 'Proposed';
      if (!str(fields['Date Flagged'])) fields['Date Flagged'] = today();
      if (str(fields.Lane)) fields.Lane = str(fields.Lane).toUpperCase().replace(/[\s-]+/g, '_');
      checks.push({ guard: 'candidate_starts_proposed', result: 'applied' });
      natural = str(opts.natural_id) || `CAND-${Date.now()}-${suffix()}`;
      if (!/^CAND-\d+-[A-Z0-9]{4}$/.test(natural)) return refuse('invalid_value', `"natural_id": "${natural}" is not CAND-<ms>-<4>. Leave it out and one is minted.`, checks);
      input.natural_id = natural;
      const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!opts.confirmed_new) {
        const held = await query<{ natural_id: string | null; name: string | null; status: string | null }>(
          `SELECT natural_id, fields->>'Candidate' AS name, fields->>'Status' AS status FROM ${mirror.KINDS.pattern_candidates.table}`,
        );
        const same = held.rows.filter((r) => r.name && key(r.name) === key(str(fields.Candidate)));
        if (same.length) {
          checks.push({ guard: 'candidate_duplicate_by_name', result: 'fail' });
          return refuse('possible_duplicate', `A candidate named "${same[0].name}" is already held (${same.map((x) => `${x.natural_id} ${x.status}`).join(', ')}). Nothing was written. Call again with confirmed_new: true if this is a different pattern.`, checks, {
            candidates: same,
          });
        }
        checks.push({ guard: 'candidate_duplicate_by_name', result: 'pass' });
      } else checks.push({ guard: 'candidate_duplicate_by_name', result: 'skipped', note: 'confirmed_new' });
      break;
    }

    case 'commercial': {
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      natural = str(fields.card_id) || `CARD-${Date.now()}-${suffix()}`;
      fields.card_id = natural;
      if (!str(fields.created_at)) fields.created_at = new Date().toISOString();
      checks.push({ guard: 'card_stamp', result: 'applied', note: natural });
      break;
    }

    case 'rt-jobs': {
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      natural = str(fields['Job ID']) || `JOB-${Date.now()}-${suffix()}`;
      fields['Job ID'] = natural;
      if (!str(fields.Status)) fields.Status = 'Pending';
      if (fields.Attempts === undefined) fields.Attempts = 0;
      if (!str(fields['Opened At'])) fields['Opened At'] = new Date().toISOString();
      checks.push({ guard: 'job_defaults', result: 'applied', note: natural });
      break;
    }

    case 'lane_backlog': {
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      natural = str(fields.task_id) || `TASK-${Date.now()}-${suffix()}`;
      fields.task_id = natural;
      checks.push({ guard: 'task_id', result: 'applied', note: natural });
      break;
    }

    case 'builder_profiles': {
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      natural = str(fields.user_id);
      if (!/^[UW][A-Z0-9]{6,}$/.test(natural)) {
        checks.push({ guard: 'slack_user_id', result: 'fail' });
        return refuse('invalid_value', `"user_id": "${natural}" is not a Slack user id. It is the key every loop and Codex write names the builder by, so it has to be the real one.`, checks);
      }
      checks.push({ guard: 'slack_user_id', result: 'pass' });
      break;
    }

    case 'codex': {
      const missing = checkRequired(spec, fields, checks);
      if (missing) return missing;
      natural = str(fields['Submission ID']);
      if (!str(opts.builder_id)) return refuse('missing_required', '"builder_id" is required to create a Codex entry: which builder’s log it is (one of the seven, or a Slack id with a Builder Profiles row).', checks);
      input.builder_id = str(opts.builder_id);
      break;
    }
  }

  if (spec.kind !== 'loops') {
    const bad = checkSelects(spec, fields, checks);
    if (bad) return bad;
  }

  const held = await alreadyHeld(spec.kind, natural);
  if (held !== null) {
    checks.push({ guard: 'no_overwrite_on_create', result: 'fail' });
    return refuse('already_exists', `${spec.kind} already holds ${natural} (row ${held}). create_record never overwrites; use update_record to change it.`, checks, { id: held, natural_id: natural });
  }
  checks.push({ guard: 'no_overwrite_on_create', result: 'pass' });

  input.fields = fields;
  return { ok: true, input, natural_id: natural, checks };
}

/* ---------------------------------------------------------------- update */

/**
 * `UOL - Merge Updates`' permission rule, for a loop: an admin may change any
 * loop, anyone else only one assigned to them or one assigned to nobody. Bays
 * can never own a loop, so there is no Bays bypass.
 */
export function loopPermission(row: mirror.LookupRow, requester: string | null | undefined, checks: Check[]): Refusal | null {
  const who = str(requester);
  if (!who) {
    checks.push({ guard: 'update_permission', result: 'fail', note: 'no requester_user_id' });
    return refuse('not_permitted', '"requester_user_id" is required to change a loop: the Slack id of the person asking, so the Tools Router’s permission rule can be applied. Nothing was written.', checks);
  }
  const assignee = str(row.fields['Assignee Slack User ID']);
  const ok = ADMIN_IDS.includes(who) || !assignee || assignee === who;
  if (!ok) {
    checks.push({ guard: 'update_permission', result: 'fail', note: `${who} is not an admin and the loop is ${assignee}’s` });
    return refuse('not_permitted', `${who} may not change ${str(row.fields.loop_id) || `row ${row.id}`}: it is assigned to ${assignee}, and only the assignee or an admin (${ADMIN_IDS.join(', ')}) can change it. Nothing was written.`, checks, {
      assignee_user_id: assignee,
      requester_user_id: who,
    });
  }
  checks.push({ guard: 'update_permission', result: 'pass', note: ADMIN_IDS.includes(who) ? 'admin' : assignee ? 'assignee' : 'unassigned loop' });
  return null;
}

export async function planUpdate(kind: string, row: mirror.LookupRow, rawFields: Record<string, unknown>, requester: string | null | undefined): Promise<UpdatePlan | Refusal> {
  const spec = writable(kind);
  const checks: Check[] = [];
  if (!spec) return refuse('not_writable', `"${kind}" is not a kind the MCP write tools can write. One of: ${WRITABLE_KINDS.join(', ')}.`, checks);
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields) || !Object.keys(rawFields).length) {
    return refuse('bad_request', '"fields" must be an object holding only the keys to change. A key not sent is left exactly as it is; null removes one.', checks);
  }
  const fields = cleanFields(rawFields);
  checks.push({ guard: 'control_characters', result: 'applied' });

  // The key cannot change under an update: it is what every lookup matches on.
  const naturalField = mirror.KINDS[spec.kind].naturalField;
  if (naturalField && naturalField in fields && str(fields[naturalField]) !== str(row.fields[naturalField])) {
    return refuse('invalid_value', `"${naturalField}" is this row’s id and cannot be changed by an update.`, checks);
  }
  // Required fields cannot be removed or blanked by an update either.
  for (const f of spec.required) {
    if (f in fields && !str(fields[f])) return refuse('missing_required', `"${f}" is required on ${spec.kind} and cannot be removed or blanked.`, checks);
  }

  if (spec.kind === 'loops') {
    const denied = loopPermission(row, requester, checks);
    if (denied) return denied;
    if ('lane_tag' in fields && fields.lane_tag !== null) {
      // Sept 5: never write a lane that is not in the locked set.
      const lane = str(fields.lane_tag).toUpperCase().replace(/[\s-]+/g, '_');
      if (!(LANES as readonly string[]).includes(lane)) {
        checks.push({ guard: 'lane_validation', result: 'fail' });
        return refuse('invalid_value', `"lane_tag": "${lane}" is not one of ${LANES.join(', ')}. Nothing was written.`, checks);
      }
      fields.lane_tag = lane;
      checks.push({ guard: 'lane_validation', result: 'pass' });
    }
    if ('Assignee Slack User ID' in fields && str(fields['Assignee Slack User ID']) === BAYS_ID) {
      return refuse('invalid_value', 'Bays cannot be assigned a loop: it has no table and no way to act on its own backlog.', checks);
    }
  }
  if (spec.kind === 'pattern_candidates' && 'Lane' in fields && str(fields.Lane)) fields.Lane = str(fields.Lane).toUpperCase().replace(/[\s-]+/g, '_');

  const bad = checkSelects(spec, fields, checks);
  if (bad) return bad;
  return { ok: true, fields, checks };
}
