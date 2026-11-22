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
 *
 * **Every build, not only the n8n rail** (22 Nov 2026, Destiny; Jason in #bha-coordination
 * 1795291672.614769 and 1795291916.233199, thread 1795286817.701399). Two more stages and the fields
 * Jason listed:
 *   - queued also carries `surface` (slack, web_chat, claude_code, other) and the `reuse_check`
 *     (`result`: reused, extended, forked or built_new; `matches`: what was found; `justification`,
 *     required for built_new), both required: no build is planned without the dedupe check logged.
 *     `build_ref` names the build (a loop, PR, workflow or Codex id).
 *   - terminal may carry `tools_invoked`, the tools Genie called (n8n, GitHub, BHARAG ...).
 *   - `not_used` records a build done without Genie: who, where, what was built, the reason in one of
 *     six categories with a short why, and its own reuse check. `used_genie` is false on that row.
 *   - `production` marks the build production, and is refused unless the rule holds: a reuse check is
 *     logged, and either Genie was not used (reason recorded) or the Genie build finished and was
 *     reviewed accepted or modified (Jason's SOP: no production pattern without this record and the
 *     reuse check).
 *
 * **The record keeps itself current** (22 Nov 2026, Destiny: "immediately Genie finishes doing something ... it should
 * always update the build record"). Genie wrote its row twice and then never again, so a build published, switched to
 * Genie's own Slack login and run live still read "inactive, sandbox only". Now every change Genie makes through an
 * approval (genieApprovals.finish) is added to its build as it lands: `actions` (the ask in the person's words, the
 * call, who approved it, what came back) and the facts the call settles merged into `backend_debrief` (published,
 * active version, credential, the last test and live execution). Which build a change belongs to: the build carrying
 * the conversation (`thread_ref`, which Genie's chat app stamps on every record_genie_build call), else the build
 * naming the same workflow, else the one open build the same person queued from the same place in the last 12 hours.
 * A change that fits none is left unlinked, never guessed onto a build.
 */
import { query, withTransaction } from './pg';
import * as events from './events';
import { FeedError } from './systemFeeds';

type Obj = Record<string, unknown>;

export const SCHEMA = 'genie.builder.interaction.v1';
export const STAGES = ['queued', 'approval', 'terminal', 'review', 'not_used', 'production'] as const;
export type Stage = (typeof STAGES)[number];
export const PROOF_TYPES = ['test_forced', 'live_natural'] as const;
export const INTENTS = ['create_workflow', 'modify_workflow', 'publish_workflow', 'github_change', 'infra_change', 'dashboard_change', 'other_build'] as const;
export const SURFACES = ['slack', 'web_chat', 'claude_code', 'other'] as const;
export const REUSE_RESULTS = ['reused', 'extended', 'forked', 'built_new'] as const;
export const NOT_USED_CATEGORIES = ['missing_tool', 'trust', 'too_slow', 'ux', 'not_applicable', 'other'] as const;
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

/** The reuse / dedupe check, required before a build (Jason, 21 Nov). Exported for the test. */
export function parseReuse(v: unknown, w: string): { json: string; result: (typeof REUSE_RESULTS)[number] } {
  if (!isObj(v)) throw new FeedError(422, `${w}: reuse_check is required: { result: reused | extended | forked | built_new, matches: [...], justification }. No build is planned or recorded without the dedupe check logged.`);
  const result = oneOf(v.result, REUSE_RESULTS, w, 'reuse_check.result', true) as (typeof REUSE_RESULTS)[number];
  const matches = Array.isArray(v.matches) ? v.matches.slice(0, 20) : [];
  const justification = text(v.justification, 2000);
  if (result === 'built_new' && (!justification || justification.length < 10)) {
    throw new FeedError(422, `${w}: reuse_check.result built_new needs a justification: why no existing pattern, flow or build could be reused or extended.`);
  }
  if (result !== 'built_new' && matches.length === 0) {
    throw new FeedError(422, `${w}: reuse_check.result ${result} needs matches naming what was ${result === 'reused' ? 'reused' : result === 'extended' ? 'extended' : 'forked'} (an id and what it is).`);
  }
  return { json: JSON.stringify({ result, matches, justification }), result };
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
    cols.surface = oneOf(m.surface, SURFACES, w, 'surface', true);
    const reuse = parseReuse(m.reuse_check, w);
    cols.reuse_check = reuse.json;
    cols.reuse_result = reuse.result;
    cols.build_ref = text(m.build_ref, 300);
  } else if (stage === 'not_used') {
    cols.requester_id = need(text(m.requester_id, 40), w, 'requester_id');
    at = iso(m.queued_at, w, 'queued_at') ?? now;
    cols.queued_at = at;
    cols.surface = oneOf(m.surface, SURFACES, w, 'surface', true);
    cols.intent = oneOf(m.intent, INTENTS, w, 'intent', false);
    cols.build_ref = need(text(m.build_ref, 300), w, 'build_ref');
    cols.plan_summary = need(text(m.plan_summary, 4000), w, 'plan_summary (what was built)');
    cols.not_used_category = oneOf(m.not_used_category, NOT_USED_CATEGORIES, w, 'not_used_category', true);
    cols.not_used_reason = text(m.not_used_reason, 1000);
    if (!cols.not_used_reason) throw new FeedError(422, `${w}: not_used_reason is required: one to three lines on why Genie was not used.`);
    const reuse = parseReuse(m.reuse_check, w);
    cols.reuse_check = reuse.json;
    cols.reuse_result = reuse.result;
    cols.used_genie = false;
  } else if (stage === 'production') {
    cols.production_marked_by = need(text(m.marked_by, 40), w, 'marked_by');
    at = iso(m.marked_at, w, 'marked_at') ?? now;
    cols.production_marked_at = at;
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
    if (m.tools_invoked !== undefined) {
      if (!Array.isArray(m.tools_invoked) || m.tools_invoked.some((t) => typeof t !== 'string')) throw new FeedError(422, `${w}: tools_invoked must be a list of tool names.`);
      cols.tools_invoked = json((m.tools_invoked as string[]).slice(0, 100));
    }
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
  queued: ['requester_id', 'queued_at', 'intent', 'live_touching', 'live_touching_reason', 'genie_plan_id', 'plan_summary', 'context_sources', 'subagent_query', 'surface', 'reuse_check', 'reuse_result', 'build_ref'],
  approval: ['approver_id', 'approved_at', 'approvals_required', 'two_builder_check', 'approval_decision'],
  terminal: ['finished_at', 'status', 'backend_artifact_id', 'backend_artifact_version', 'backend_debrief', 'submission', 'live_effect', 'evidence_links', 'tools_invoked'],
  review: ['rater_id', 'reviewed_at', 'builder_decision', 'usefulness_rating', 'review_note'],
  not_used: ['requester_id', 'queued_at', 'surface', 'intent', 'build_ref', 'plan_summary', 'not_used_category', 'not_used_reason', 'reuse_check', 'reuse_result', 'used_genie'],
  production: ['production_marked_by', 'production_marked_at'],
};
const JSON_COLS = new Set(['context_sources', 'subagent_query', 'backend_debrief', 'submission', 'evidence_links', 'tools_invoked', 'reuse_check']);

interface HeldRow {
  rail_id: string;
  requester_id: string | null;
  live_touching: boolean | null;
  approval_decision: string | null;
  two_builder_check: string | null;
  used_genie?: boolean | null;
  reuse_result?: string | null;
  not_used_reason?: string | null;
  finished_at?: string | null;
  builder_decision?: string | null;
  queued_at?: string | null;
}

/** Why a build may not be marked production yet; empty when it may. Exported for the test. */
export function productionBlockers(h: Partial<HeldRow> | null): string[] {
  if (!h) return ['no Genie Builder record exists for this build'];
  const out: string[] = [];
  if (!h.reuse_result) out.push('no reuse check is logged');
  if (h.used_genie === false) {
    if (!h.not_used_reason) out.push('Genie was not used and no reason is recorded');
  } else {
    if (!h.finished_at) out.push('the Genie build has not finished');
    if (h.builder_decision !== 'accepted' && h.builder_decision !== 'modified') out.push('the builder has not reviewed it as accepted or modified');
  }
  return out;
}

/** The checks that need what is already held for the interaction. Exported for the test. */
export function crossCheck(s: StageRow, held: HeldRow | null): void {
  const w = `${s.interaction_id} (${s.stage})`;
  if (held && held.rail_id !== s.rail_id) throw new FeedError(422, `${w}: rail_id "${s.rail_id}" differs from the "${held.rail_id}" this interaction was opened on.`);
  if (s.stage === 'not_used' && held && held.used_genie !== false && held.queued_at) {
    throw new FeedError(422, `${w}: this interaction was opened as a Genie build; a build done without Genie is its own record with its own interaction_id.`);
  }
  if (['approval', 'terminal', 'review'].includes(s.stage) && held?.used_genie === false) {
    throw new FeedError(422, `${w}: this record says Genie was not used, so it has no ${s.stage} stage.`);
  }
  if (s.stage === 'production') {
    const blockers = productionBlockers(held);
    if (blockers.length) throw new FeedError(422, `${w}: not marked production: ${blockers.join('; ')}. Rule: no production pattern without a Genie Builder record and a logged reuse check.`);
  }
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
        `SELECT rail_id, requester_id, live_touching, approval_decision, two_builder_check, used_genie, reuse_result, not_used_reason, finished_at, builder_decision, queued_at FROM engine_genie_builder_interactions WHERE interaction_id = $1 FOR UPDATE`,
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
      const ref = text((s.payload as Obj).thread_ref, 120);
      if (ref) await db.query(`UPDATE engine_genie_builder_interactions SET thread_ref = coalesce(thread_ref, $2) WHERE interaction_id = $1`, [s.interaction_id, ref]);
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
  surface: string | null;
  used_genie: boolean;
  not_used_category: string | null;
  not_used_reason: string | null;
  tools_invoked: unknown;
  reuse_check: unknown;
  reuse_result: string | null;
  build_ref: string | null;
  production_marked_at: string | null;
  production_marked_by: string | null;
  /** The chat conversation or Slack thread the build was asked in. */
  thread_ref: string | null;
  /** Every approved change Genie made for this build, oldest first, added as it landed. */
  actions: unknown;
  last_action_at: string | null;
  /** Why this build may not be marked production yet; empty when it may (or already is). */
  production_blockers: string[];
  /** Reviewed with a rating, after a finish: the only interactions the proof counts (G2). */
  counts_toward_proof: boolean;
  /** Finished, no review, and the review window has passed. Never read as closed. */
  feedback_failed: boolean;
  received_at: string;
  updated_at: string;
}

/** What a row adds up to. Exported for the test. */
type Raw = Omit<Interaction, 'stage_reached' | 'counts_toward_proof' | 'feedback_failed' | 'production_blockers'>;
export function derive(r: Raw, now = Date.now()): Interaction {
  const used = r.used_genie !== false;
  const reviewed = r.usefulness_rating !== null && r.builder_decision !== null;
  const finished = r.finished_at !== null;
  const stage_reached: Stage = r.production_marked_at ? 'production' : !used ? 'not_used' : reviewed ? 'review' : finished ? 'terminal' : r.approved_at ? 'approval' : 'queued';
  const late = used && finished && now - Date.parse(r.finished_at as string) > REVIEW_WINDOW_HOURS * 3600_000;
  const production_blockers = r.production_marked_at ? [] : productionBlockers({ ...r, used_genie: used });
  return { ...r, used_genie: used, stage_reached, production_blockers, counts_toward_proof: used && reviewed && finished, feedback_failed: used && finished && !reviewed && late };
}

const ROW_SQL = `SELECT interaction_id, rail_id, proof_type, requester_id,
  to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS queued_at, intent, live_touching, live_touching_reason, genie_plan_id, plan_summary,
  context_sources, subagent_query, approver_id, to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at, approvals_required,
  two_builder_check, approval_decision, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at, status, backend_artifact_id,
  backend_artifact_version, backend_debrief, submission, live_effect, evidence_links, error_or_stop_reason, rater_id,
  to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at, builder_decision, usefulness_rating, review_note,
  surface, used_genie, not_used_category, not_used_reason, tools_invoked, reuse_check, reuse_result, build_ref,
  to_char(production_marked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS production_marked_at, production_marked_by,
  thread_ref, actions, to_char(last_action_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_action_at,
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
      builds: xs.length,
      with_genie: xs.filter((r) => r.used_genie).length,
      without_genie: xs.filter((r) => !r.used_genie).length,
      reuse: Object.fromEntries(REUSE_RESULTS.map((k) => [k, xs.filter((r) => r.reuse_result === k).length])) as Record<(typeof REUSE_RESULTS)[number], number>,
      no_reuse_check: xs.filter((r) => !r.reuse_result).length,
      not_used_by_category: Object.fromEntries(NOT_USED_CATEGORIES.map((k) => [k, xs.filter((r) => r.not_used_category === k).length])) as Record<(typeof NOT_USED_CATEGORIES)[number], number>,
      by_surface: Object.fromEntries([...SURFACES, 'not_sent'].map((k) => [k, xs.filter((r) => (r.surface ?? 'not_sent') === k).length])),
      marked_production: xs.filter((r) => r.production_marked_at).length,
    };
  };
  return { all: pick(null), live_natural: pick('live_natural'), test_forced: pick('test_forced') };
}

export async function read(opts: { rail_id?: string | null; interaction_id?: string | null; surface?: string | null; used_genie?: boolean | null; requester_id?: string | null; search?: string | null; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.rail_id) { params.push(opts.rail_id); where.push(`rail_id = $${params.length}`); }
  if (opts.interaction_id) { params.push(opts.interaction_id); where.push(`interaction_id = $${params.length}`); }
  if (opts.surface) { params.push(opts.surface); where.push(`surface = $${params.length}`); }
  if (typeof opts.used_genie === 'boolean') { params.push(opts.used_genie); where.push(`used_genie = $${params.length}`); }
  if (opts.requester_id) { params.push(opts.requester_id); where.push(`requester_id = $${params.length}`); }
  if (opts.search) {
    params.push(opts.search.toLowerCase());
    where.push(`strpos(lower(coalesce(interaction_id,'') || ' ' || coalesce(plan_summary,'') || ' ' || coalesce(build_ref,'') || ' ' || coalesce(not_used_reason,'') || ' ' || coalesce(reuse_check::text,'')), $${params.length}) > 0`);
  }
  const r = await query<Raw>(
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
      'Every build is recorded, with Genie or without: a build done without Genie is a not_used record with its reason (missing_tool, trust, too_slow, ux, not_applicable, other).',
      'No build is planned or recorded without the reuse check: reused, extended, forked or built_new, with what was found, and built_new says why.',
      'Every approved change Genie makes is added to its build as it lands (actions), and the facts it settles (published, active version, credential, last test and live run) are merged into backend_debrief. A change is linked by the conversation it was asked in, else the workflow it names, else the one open build the same person queued from the same place in the last 12 hours; otherwise it is left unlinked.',
      'A build is marked production only once its reuse check is logged and either its Genie build was reviewed accepted or modified, or Genie was not used and the reason is recorded. Cite a past build by its interaction_id.',
    ],
  };
}

/* ------------------------------------------------- the record keeps itself current (22 Nov 2026) */

/** An approved change, as genieApprovals holds it. */
export interface ApprovalAction {
  id: string;
  server: string;
  tool: string;
  args: unknown;
  summary: string | null;
  thread_ts: string | null;
  channel_id: string | null;
  surface: string | null;
  requester: string | null;
  decided_by: string | null;
  status: string;
  result: string | null;
  error: string | null;
  plan: unknown;
  created_at: string | Date;
  finished_at: string | Date | null;
}

const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
function parseJson(v: string | null): Obj {
  if (!v) return {};
  try {
    const j = JSON.parse(v);
    return isObj(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * What one finished change settles about the build, merged into backend_debrief. Pure: exported for the test. Only
 * facts the call itself states are taken; nothing is guessed from a call that failed.
 */
export function factsFrom(a: Pick<ApprovalAction, 'server' | 'tool' | 'args' | 'status' | 'result'>): { debrief: Obj; ids: string[]; live_execution: string | null } {
  const args = asObj(a.args);
  const res = parseJson(a.result);
  const debrief: Obj = {};
  const ids = [args.workflowId, args.workflow_id, res.workflowId, res.id].filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 80);
  let live: string | null = null;
  if (a.status !== 'done') return { debrief, ids: [...new Set(ids)], live_execution: null };
  if (a.server === 'n8n') {
    const wf = (typeof args.workflowId === 'string' && args.workflowId) || (typeof res.workflowId === 'string' && res.workflowId) || null;
    if (wf) debrief.workflow_id = wf;
    if (a.tool === 'publish_workflow') {
      debrief.published = true;
      debrief.active = true;
      if (typeof res.activeVersionId === 'string') debrief.active_version_id = res.activeVersionId;
    } else if (a.tool === 'unpublish_workflow') {
      debrief.published = false;
      debrief.active = false;
    } else if (a.tool === 'update_workflow') {
      if (typeof args.versionName === 'string') debrief.last_change = args.versionName;
      for (const op of Array.isArray(args.operations) ? args.operations : []) {
        const o = asObj(op);
        if (o.type === 'setNodeCredential' && typeof o.credentialName === 'string') {
          const key = typeof o.credentialKey === 'string' ? o.credentialKey : 'credential';
          if (key === 'slackApi') debrief.slack_credential = o.credentialName;
          else debrief[`${key}_credential`] = o.credentialName;
        }
      }
    } else if (a.tool === 'execute_workflow') {
      const ex = typeof res.executionId === 'string' ? res.executionId : null;
      if (ex) {
        if (args.executionMode === 'production') {
          debrief.live_execution_id = ex;
          live = ex;
        } else debrief.test_execution_id = ex;
      }
    }
  }
  return { debrief, ids: [...new Set(ids)], live_execution: live };
}

const SURFACE_OF: Record<string, string> = { chat: 'web_chat', slack: 'slack' };

/**
 * Adds one finished change to the build it belongs to. Returns the interaction_id, or null when it fits no build.
 * Safe to run twice: a change already on a build is never added again.
 */
export async function linkAction(a: ApprovalAction): Promise<string | null> {
  if (a.status !== 'done' && a.status !== 'failed') return null;
  const thread = a.thread_ts ? String(a.thread_ts) : null;
  const facts = factsFrom(a);
  return withTransaction(async (db) => {
    let id: string | null = null;
    if (thread) {
      const r = await db.query<{ interaction_id: string }>(
        `SELECT interaction_id FROM engine_genie_builder_interactions WHERE thread_ref = $1 AND used_genie ORDER BY coalesce(queued_at, received_at) DESC LIMIT 1`,
        [thread],
      );
      id = r.rows[0]?.interaction_id ?? null;
    }
    if (!id && facts.ids.length && a.requester) {
      const r = await db.query<{ interaction_id: string }>(
        `SELECT interaction_id FROM engine_genie_builder_interactions
          WHERE used_genie AND requester_id = $1 AND (backend_artifact_id = ANY($2) OR backend_debrief->>'workflow_id' = ANY($2) OR build_ref = ANY($2))
          ORDER BY coalesce(queued_at, received_at) DESC LIMIT 1`,
        [a.requester, facts.ids],
      );
      id = r.rows[0]?.interaction_id ?? null;
    }
    if (!id && a.requester) {
      const r = await db.query<{ interaction_id: string }>(
        `SELECT interaction_id FROM engine_genie_builder_interactions
          WHERE used_genie AND requester_id = $1 AND thread_ref IS NULL AND production_marked_at IS NULL
            AND surface IS NOT DISTINCT FROM $2
            AND coalesce(queued_at, received_at) BETWEEN $3::timestamptz - interval '12 hours' AND $3::timestamptz + interval '1 hour'`,
        [a.requester, SURFACE_OF[String(a.surface ?? 'slack')] ?? null, new Date(a.created_at).toISOString()],
      );
      if (r.rows.length === 1) id = r.rows[0].interaction_id;
    }
    if (!id) return null;
    const held = await db.query<{ actions: unknown[] }>(`SELECT actions FROM engine_genie_builder_interactions WHERE interaction_id = $1 FOR UPDATE`, [id]);
    const already = (held.rows[0]?.actions ?? []).some((x) => asObj(x).approval_id === a.id);
    if (!already) {
      const at = new Date(a.finished_at ?? Date.now()).toISOString();
      const action = {
        approval_id: a.id,
        at,
        server: a.server,
        tool: a.tool,
        change: a.summary ? a.summary.slice(0, 600) : `${a.server}: ${a.tool}`,
        ask: (typeof asObj(a.plan).goal === 'string' ? (asObj(a.plan).goal as string) : '').slice(0, 1000) || null,
        approved_by: a.decided_by,
        ok: a.status === 'done',
        result: a.status === 'done' ? (a.result ?? '').slice(0, 400) || null : null,
        error: a.status === 'failed' ? (a.error ?? '').slice(0, 400) || null : null,
      };
      const evidence = facts.live_execution && facts.debrief.workflow_id
        ? [`https://bayshorizonnetwork.app.n8n.cloud/workflow/${String(facts.debrief.workflow_id)}/executions/${facts.live_execution}`]
        : [];
      await db.query(
        `UPDATE engine_genie_builder_interactions SET
            actions = actions || $2::jsonb,
            last_action_at = greatest(coalesce(last_action_at, $3::timestamptz), $3::timestamptz),
            backend_debrief = coalesce(backend_debrief, '{}'::jsonb) || $4::jsonb,
            backend_artifact_id = coalesce(backend_artifact_id, $5),
            backend_artifact_version = coalesce($6, backend_artifact_version),
            evidence_links = coalesce(evidence_links, '[]'::jsonb) || $7::jsonb,
            tools_invoked = CASE WHEN coalesce(tools_invoked, '[]'::jsonb) @> $8::jsonb THEN tools_invoked ELSE coalesce(tools_invoked, '[]'::jsonb) || $8::jsonb END,
            thread_ref = coalesce(thread_ref, $9),
            updated_at = now()
          WHERE interaction_id = $1`,
        [
          id,
          JSON.stringify([action]),
          at,
          JSON.stringify(facts.debrief),
          (facts.debrief.workflow_id as string | undefined) ?? null,
          (facts.debrief.active_version_id as string | undefined) ?? null,
          JSON.stringify(evidence),
          JSON.stringify([`${a.server} ${a.tool}`]),
          thread,
        ],
      );
    }
    await db.query(`UPDATE engine_genie_approvals SET build_id = $2 WHERE id = $1`, [a.id, id]);
    events.changed('genie_builder', null, db);
    return id;
  });
}

/** Finished changes from the last 14 days not yet on a build. Run at boot, after migration 149. */
export async function backfillActions(): Promise<{ linked: number; unlinked: number }> {
  const r = await query<ApprovalAction>(
    `SELECT id, server, tool, args, summary, thread_ts, channel_id, surface, requester, decided_by, status, result, error, plan, created_at, finished_at
       FROM engine_genie_approvals WHERE build_id IS NULL AND status IN ('done','failed') AND created_at > now() - interval '14 days' ORDER BY created_at`,
  );
  let linked = 0;
  for (const a of r.rows) if (await linkAction(a)) linked++;
  return { linked, unlinked: r.rows.length - linked };
}

/** The builds asked for in one conversation or thread, newest first: what the chat app shows to rate. */
export async function forThread(threadRef: string): Promise<Interaction[]> {
  const r = await query<Raw>(`${ROW_SQL} WHERE thread_ref = $1 ORDER BY coalesce(queued_at, received_at) DESC LIMIT 20`, [threadRef]);
  return r.rows.map((x) => derive({ ...x, approvals_required: x.approvals_required === null ? null : Number(x.approvals_required), usefulness_rating: x.usefulness_rating === null ? null : Number(x.usefulness_rating) }));
}
