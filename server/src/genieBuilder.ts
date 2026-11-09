/**
 * Genie Builder interactions: the Logstream side of the first production-connected Genie rail
 * (9 Nov 2026, Destiny — Jason and Kaiqi, #bha-coordination 1793566544.600759; Decision Watch
 * DW-1794175428364-B304; contract docs/contracts/genie-builder-interactions.md).
 *
 * Genie (u82u, rail `genie-slack-n8n`) sends one message per stage of each interaction to
 * `POST /api/engine/genie-builder`, with the same `x-dashboard-key` every engine sender uses:
 *
 *   queued    what was asked, by whom, whether it touches anything live and why, the plan
 *   approval  who approved, how many approvals were needed, the two-builder check, granted or denied
 *   terminal  how it ended, what n8n built (artifact and debrief), what was shipped back, live_effect
 *   review    the builder's decision (accepted / modified / rejected) and a usefulness rating 1 to 5
 *
 * **One row per interaction_id**, each stage filling only its own columns and dated, so nothing a
 * stage wrote is overwritten by another. The same stage sent again (a retry) replaces only that
 * stage's own columns. Every message is checked before anything is written; a refusal is a 422 with
 * the reason and writes nothing (Jason's engine bar: no silent failures).
 *
 * Three rules from the rev 5 contract and Jason's G1 to G6 are held here, not left to the sender:
 *   - proof_type is on every message (test_forced or live_natural); a record any stage marked
 *     test_forced stays test_forced, so a test is never counted as real use.
 *   - a granted approval on a live-touching action by the requester is refused (two-builder gate),
 *     and live_effect true is refused unless a granted approval is already held.
 *   - a rating is never null: the review stage needs it, and a finished interaction with no review
 *     after 48 hours reads as a failed feedback loop, never as closed. Only a reviewed interaction
 *     counts toward the proof.
 */
import { query, withTransaction } from './pg';
import * as events from './events';
import { FeedError } from './systemFeeds';

type Obj = Record<string, unknown>;

export const SCHEMA = 'genie.builder.interaction.v1';
export const STAGES = ['queued', 'approval', 'terminal', 'review'] as const;
export type Stage = (typeof STAGES)[number];
export const PROOF_TYPES = ['test_forced', 'live_natural'] as const;
export const INTENTS = ['create_workflow', 'modify_workflow', 'publish_workflow'] as const;
export const TWO_BUILDER = ['not_required', 'passed', 'rejected_self_approval'] as const;
export const APPROVAL = ['granted', 'denied'] as const;
export const DECISIONS = ['accepted', 'modified', 'rejected'] as const;
/** A finished interaction with no review this long after it finished is a failed feedback loop (G2). */
export const REVIEW_WINDOW_HOURS = 48;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function text(v: unknown, max = 2000): string | null {
  if (typeof v === 'string') return v.trim().slice(0, max) || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function iso(v: unknown, where: string, field: string): string | null {
  const s = text(v, 64);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new FeedError(422, `${where}: ${field} "${s}" is not a date and time (ISO 8601).`);
  return new Date(t).toISOString();
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string, field: string, required: boolean): T | null {
  const s = text(v, 64);
  if (!s) {
    if (required) throw new FeedError(422, `${where}: ${field} is required, one of ${allowed.join(', ')}.`);
    return null;
  }
  if (!(allowed as readonly string[]).includes(s)) throw new FeedError(422, `${where}: ${field} "${s}" is not one of ${allowed.join(', ')}.`);
  return s as T;
}
function need(v: string | null, where: string, field: string): string {
  if (!v) throw new FeedError(422, `${where}: ${field} is required for this stage.`);
  return v;
}
function bool(v: unknown, where: string, field: string, required: boolean): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) {
    if (required) throw new FeedError(422, `${where}: ${field} is required, true or false.`);
    return null;
  }
  throw new FeedError(422, `${where}: ${field} must be true or false.`);
}
function json(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  if (s.length > 200_000) throw new FeedError(413, `A field is ${s.length} characters; keep each one under 200,000.`);
  return s;
}

/** One stage message, checked whole. Exported for the test. */
export interface StageRow {
  interaction_id: string;
  rail_id: string;
  stage: Stage;
  proof_type: (typeof PROOF_TYPES)[number];
  at: string;
  cols: Record<string, string | number | boolean | null>;
  payload: Obj;
}

export function parseStage(m: unknown, where = 'The message'): StageRow {
  if (!isObj(m)) throw new FeedError(422, `${where} is not an object.`);
  if (m.schema !== undefined && m.schema !== SCHEMA) throw new FeedError(422, `${where}: schema must be "${SCHEMA}" (or left out).`);
  const interaction_id = need(text(m.interaction_id, 200), where, 'interaction_id');
  const rail_id = need(text(m.rail_id, 100), where, 'rail_id');
  const stage = oneOf(m.stage, STAGES, where, 'stage', true) as Stage;
  const proof_type = oneOf(m.proof_type, PROOF_TYPES, where, 'proof_type', true) as StageRow['proof_type'];
  const w = `${where} (${stage})`;
  const now = new Date().toISOString();
  const cols: StageRow['cols'] = {};
  let at = now;
  if (stage === 'queued') {
    cols.requester_id = need(text(m.requester_id, 40), w, 'requester_id');
    at = iso(m.queued_at, w, 'queued_at') ?? now;
    cols.queued_at = at;
    cols.intent = oneOf(m.intent, INTENTS, w, 'intent', true);
    cols.live_touching = bool(m.live_touching, w, 'live_touching', true);
    cols.live_touching_reason = text(m.live_touching_reason, 1000);
    if (!cols.live_touching_reason) throw new FeedError(422, `${w}: live_touching_reason is required: why this action does or does not touch anything live.`);
    cols.genie_plan_id = need(text(m.genie_plan_id, 200), w, 'genie_plan_id');
    cols.plan_summary = need(text(m.plan_summary, 4000), w, 'plan_summary');
    cols.context_sources = json(m.context_sources ?? null);
    if (cols.context_sources === null) throw new FeedError(422, `${w}: context_sources is required: what the reuse lookup found, or ["none found"].`);
    cols.subagent_query = json(m.subagent_query ?? null);
  } else if (stage === 'approval') {
    cols.approver_id = need(text(m.approver_id, 40), w, 'approver_id');
    at = iso(m.approved_at, w, 'approved_at') ?? now;
    cols.approved_at = at;
    const req = m.approvals_required;
    if (req !== 1 && req !== 2) throw new FeedError(422, `${w}: approvals_required must be 1 or 2.`);
    cols.approvals_required = req;
    cols.two_builder_check = oneOf(m.two_builder_check, TWO_BUILDER, w, 'two_builder_check', true);
    cols.approval_decision = oneOf(m.approval_decision, APPROVAL, w, 'approval_decision', true);
    if (req === 2 && cols.two_builder_check === 'not_required') throw new FeedError(422, `${w}: two approvals are required, so two_builder_check cannot be not_required.`);
    if (cols.two_builder_check === 'rejected_self_approval' && cols.approval_decision === 'granted') throw new FeedError(422, `${w}: a rejected self-approval cannot be granted.`);
    const stop = text(m.error_or_stop_reason, 1000);
    if (cols.approval_decision === 'denied') cols.error_or_stop_reason = stop ?? 'approval_denied';
  } else if (stage === 'terminal') {
    at = iso(m.finished_at, w, 'finished_at') ?? now;
    cols.finished_at = at;
    cols.status = need(text(m.status, 60), w, 'status');
    cols.backend_artifact_id = text(m.backend_artifact_id, 200);
    cols.backend_artifact_version = text(m.backend_artifact_version, 200);
    cols.live_effect = bool(m.live_effect, w, 'live_effect', true);
    const stop = text(m.error_or_stop_reason, 1000);
    if (stop) cols.error_or_stop_reason = stop;
    if (!isObj(m.backend_debrief) && !stop) throw new FeedError(422, `${w}: backend_debrief is required as an object (nodes, assumptions, warnings, validate result, active, published), or an error_or_stop_reason when nothing was built.`);
    cols.backend_debrief = json(m.backend_debrief ?? null);
    cols.submission = json(m.submission ?? null);
    if (cols.submission === null && !stop) throw new FeedError(422, `${w}: submission is required: what was actually shipped back (G3).`);
    cols.evidence_links = json(Array.isArray(m.evidence_links) ? m.evidence_links : []);
  } else {
    cols.rater_id = need(text(m.rater_id, 40), w, 'rater_id');
    at = iso(m.reviewed_at, w, 'reviewed_at') ?? now;
    cols.reviewed_at = at;
    cols.builder_decision = oneOf(m.builder_decision, DECISIONS, w, 'builder_decision', true);
    const r = m.usefulness_rating;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 5) throw new FeedError(422, `${w}: usefulness_rating is required, a whole number from 1 to 5 (it is never null).`);
    cols.usefulness_rating = r;
    cols.review_note = text(m.review_note, 4000);
  }
  return { interaction_id, rail_id, stage, proof_type, at, cols, payload: m };
}

/** Each stage's own columns, the only ones that stage may write. */
const STAGE_COLS: Record<Stage, string[]> = {
  queued: ['requester_id', 'queued_at', 'intent', 'live_touching', 'live_touching_reason', 'genie_plan_id', 'plan_summary', 'context_sources', 'subagent_query'],
  approval: ['approver_id', 'approved_at', 'approvals_required', 'two_builder_check', 'approval_decision'],
  terminal: ['finished_at', 'status', 'backend_artifact_id', 'backend_artifact_version', 'backend_debrief', 'submission', 'live_effect', 'evidence_links'],
  review: ['rater_id', 'reviewed_at', 'builder_decision', 'usefulness_rating', 'review_note'],
};
const JSON_COLS = new Set(['context_sources', 'subagent_query', 'backend_debrief', 'submission', 'evidence_links']);

interface HeldRow {
  rail_id: string;
  requester_id: string | null;
  live_touching: boolean | null;
  approval_decision: string | null;
  two_builder_check: string | null;
}

/** The checks that need what is already held for the interaction. Exported for the test. */
export function crossCheck(s: StageRow, held: HeldRow | null): void {
  const w = `${s.interaction_id} (${s.stage})`;
  if (held && held.rail_id !== s.rail_id) throw new FeedError(422, `${w}: rail_id "${s.rail_id}" differs from the "${held.rail_id}" this interaction was opened on.`);
  if (s.stage === 'approval' && s.cols.approval_decision === 'granted' && held?.live_touching === true) {
    if (held.requester_id && held.requester_id === s.cols.approver_id) {
      throw new FeedError(422, `${w}: the requester (${held.requester_id}) approved their own live-touching action. The two-builder gate refuses self-approval; send it as denied with two_builder_check rejected_self_approval.`);
    }
    if (s.cols.approvals_required !== 2) throw new FeedError(422, `${w}: a live-touching action needs approvals_required 2.`);
  }
  if (s.stage === 'terminal' && s.cols.live_effect === true) {
    if (!held || held.approval_decision !== 'granted') throw new FeedError(422, `${w}: live_effect is true but no granted approval is held for this interaction. Send the approval stage first.`);
    if (held.live_touching === true && held.two_builder_check !== 'passed') throw new FeedError(422, `${w}: live_effect is true on a live-touching action whose two-builder check is not passed.`);
  }
}

export async function store(body: Obj): Promise<{ received: number; inserted: number; updated: number; interaction_ids: string[]; dry_run: boolean }> {
  const batch = Array.isArray(body.messages);
  const list = batch ? (body.messages as unknown[]) : [body];
  if (!list.length) throw new FeedError(422, 'messages is empty: nothing to store.');
  if (list.length > 50) throw new FeedError(413, `${list.length} messages in one call; send at most 50.`);
  const rows = list.map((m, i) => parseStage(m, batch ? `messages[${i}]` : 'The message'));
  const dry = body.dry_run === true;
  const run = async (db: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
    let inserted = 0;
    let updated = 0;
    for (const s of rows) {
      const h = await db.query<HeldRow>(
        `SELECT rail_id, requester_id, live_touching, approval_decision, two_builder_check FROM engine_genie_builder_interactions WHERE interaction_id = $1 FOR UPDATE`,
        [s.interaction_id],
      );
      const held = h.rows[0] ?? null;
      crossCheck(s, held);
      const cols = STAGE_COLS[s.stage];
      const vals = cols.map((c) => (c in s.cols ? s.cols[c] : null));
      const stopSet = 'error_or_stop_reason' in s.cols;
      const stamp = JSON.stringify({ [s.stage]: { at: s.at, received_at: new Date().toISOString() } });
      const payload = JSON.stringify({ [s.stage]: s.payload });
      const params: unknown[] = [s.interaction_id, s.rail_id, s.proof_type, ...vals, stamp, payload, stopSet ? s.cols.error_or_stop_reason : null];
      const n = cols.length;
      const colList = cols.join(', ');
      const valList = cols.map((c, i) => (JSON_COLS.has(c) ? `$${i + 4}::jsonb` : `$${i + 4}`)).join(', ');
      const setList = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
      const r = await db.query<{ inserted: boolean }>(
        `INSERT INTO engine_genie_builder_interactions (interaction_id, rail_id, proof_type, ${colList}, stages, payload, error_or_stop_reason)
         VALUES ($1, $2, $3, ${valList}, $${n + 4}::jsonb, $${n + 5}::jsonb, $${n + 6})
         ON CONFLICT (interaction_id) DO UPDATE SET ${setList},
           proof_type = CASE WHEN engine_genie_builder_interactions.proof_type = 'test_forced' OR EXCLUDED.proof_type = 'test_forced' THEN 'test_forced' ELSE 'live_natural' END,
           stages = engine_genie_builder_interactions.stages || EXCLUDED.stages,
           payload = engine_genie_builder_interactions.payload || EXCLUDED.payload,
           error_or_stop_reason = coalesce(EXCLUDED.error_or_stop_reason, engine_genie_builder_interactions.error_or_stop_reason),
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        params,
      );
      if (r.rows[0]?.inserted) inserted++;
      else updated++;
    }
    events.changed('genie_builder', null, db);
    return { received: rows.length, inserted, updated, interaction_ids: rows.map((s) => s.interaction_id) };
  };
  try {
    const out = await withTransaction(async (db) => {
      const r = await run(db);
      if (dry) throw new DryRun(r);
      return r;
    });
    return { ...out, dry_run: false };
  } catch (e) {
    if (e instanceof DryRun) return { ...e.result, dry_run: true };
    throw e;
  }
}
class DryRun extends Error {
  constructor(public result: { received: number; inserted: number; updated: number; interaction_ids: string[] }) {
    super('dry run');
  }
}

/* ------------------------------------------------------------------- read */

export interface Interaction {
  interaction_id: string;
  rail_id: string;
  proof_type: string;
  stage_reached: Stage;
  requester_id: string | null;
  queued_at: string | null;
  intent: string | null;
  live_touching: boolean | null;
  live_touching_reason: string | null;
  genie_plan_id: string | null;
  plan_summary: string | null;
  context_sources: unknown;
  subagent_query: unknown;
  approver_id: string | null;
  approved_at: string | null;
  approvals_required: number | null;
  two_builder_check: string | null;
  approval_decision: string | null;
  finished_at: string | null;
  status: string | null;
  backend_artifact_id: string | null;
  backend_artifact_version: string | null;
  backend_debrief: unknown;
  submission: unknown;
  live_effect: boolean | null;
  evidence_links: unknown;
  error_or_stop_reason: string | null;
  rater_id: string | null;
  reviewed_at: string | null;
  builder_decision: string | null;
  usefulness_rating: number | null;
  review_note: string | null;
  /** Reviewed with a rating, after a finish: the only interactions the proof counts (G2). */
  counts_toward_proof: boolean;
  /** Finished, no review, and the review window has passed. Never read as closed. */
  feedback_failed: boolean;
  received_at: string;
  updated_at: string;
}

/** What a row adds up to. Exported for the test. */
export function derive(r: Omit<Interaction, 'stage_reached' | 'counts_toward_proof' | 'feedback_failed'>, now = Date.now()): Interaction {
  const reviewed = r.usefulness_rating !== null && r.builder_decision !== null;
  const finished = r.finished_at !== null;
  const stage_reached: Stage = reviewed ? 'review' : finished ? 'terminal' : r.approved_at ? 'approval' : 'queued';
  const late = finished && now - Date.parse(r.finished_at as string) > REVIEW_WINDOW_HOURS * 3600_000;
  return { ...r, stage_reached, counts_toward_proof: reviewed && finished, feedback_failed: finished && !reviewed && late };
}

const ROW_SQL = `SELECT interaction_id, rail_id, proof_type, requester_id,
  to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS queued_at, intent, live_touching, live_touching_reason, genie_plan_id, plan_summary,
  context_sources, subagent_query, approver_id, to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at, approvals_required,
  two_builder_check, approval_decision, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at, status, backend_artifact_id,
  backend_artifact_version, backend_debrief, submission, live_effect, evidence_links, error_or_stop_reason, rater_id,
  to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at, builder_decision, usefulness_rating, review_note,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
  FROM engine_genie_builder_interactions`;

export function summarise(rows: Interaction[]) {
  const pick = (proof: string | null) => {
    const xs = proof ? rows.filter((r) => r.proof_type === proof) : rows;
    const rated = xs.filter((r) => r.counts_toward_proof);
    const avg = rated.length ? Math.round((rated.reduce((a, r) => a + (r.usefulness_rating ?? 0), 0) / rated.length) * 100) / 100 : null;
    return {
      interactions: xs.length,
      finished: xs.filter((r) => r.finished_at).length,
      counted_toward_proof: rated.length,
      accepted: rated.filter((r) => r.builder_decision === 'accepted').length,
      modified: rated.filter((r) => r.builder_decision === 'modified').length,
      rejected: rated.filter((r) => r.builder_decision === 'rejected').length,
      average_rating: avg,
      awaiting_review: xs.filter((r) => r.finished_at && !r.counts_toward_proof && !r.feedback_failed).length,
      feedback_failed: xs.filter((r) => r.feedback_failed).length,
      live_touching: xs.filter((r) => r.live_touching).length,
      live_effect: xs.filter((r) => r.live_effect).length,
      self_approval_refused: xs.filter((r) => r.two_builder_check === 'rejected_self_approval').length,
      denied: xs.filter((r) => r.approval_decision === 'denied').length,
    };
  };
  return { all: pick(null), live_natural: pick('live_natural'), test_forced: pick('test_forced') };
}

export async function read(opts: { rail_id?: string | null; interaction_id?: string | null; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.rail_id) { params.push(opts.rail_id); where.push(`rail_id = $${params.length}`); }
  if (opts.interaction_id) { params.push(opts.interaction_id); where.push(`interaction_id = $${params.length}`); }
  const r = await query<Omit<Interaction, 'stage_reached' | 'counts_toward_proof' | 'feedback_failed'>>(
    `${ROW_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY coalesce(queued_at, received_at) DESC`,
    params,
  );
  const now = Date.now();
  const all = r.rows.map((x) => derive({ ...x, approvals_required: x.approvals_required === null ? null : Number(x.approvals_required), usefulness_rating: x.usefulness_rating === null ? null : Number(x.usefulness_rating) }, now));
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  return {
    schema: SCHEMA,
    summary: summarise(all),
    interactions: all.slice(0, limit),
    returned: Math.min(limit, all.length),
    held: all.length,
    first_at: all.length ? all[all.length - 1].queued_at ?? all[all.length - 1].received_at : null,
    last_at: all.length ? all[0].updated_at : null,
    rules: [
      'One row per interaction_id; each of the four stages (queued, approval, terminal, review) fills only its own fields.',
      'Only a finished interaction that was reviewed with a 1 to 5 rating counts toward the proof. A finished one left unreviewed for 48 hours is a failed feedback loop.',
      'proof_type test_forced is never counted as real use: the live_natural figures are the ones that answer "does Genie help in real use".',
      'A requester approving their own live-touching action is refused, and live_effect true needs a granted approval already held.',
      'Nothing here is inferred: a field Genie did not send is null.',
    ],
  };
}
