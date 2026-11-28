/**
 * The engine's write path, as functions (2026-09-24, Destiny).
 *
 * `POST /api/engine/:kind`, `PATCH /api/engine/:kind/:id` and
 * `PATCH /api/engine/:kind/by-natural/:natural_id` did their work inline in
 * index.ts. The MCP write tools need exactly the same work — the same
 * `mirror.upsert` / `mirror.patchFields`, the same status dating through
 * `store.recordEngineWrite`, the same line on `engine_writes` — so it lives
 * here and **both call it**. A second copy of a write path is a second thing
 * that drifts, and the drift would be invisible until a row written one way
 * read differently from a row written the other.
 *
 * What differs between callers is only how they are named on the log: the
 * endpoint, the method and which credential let them in. That is `WriteCtx`.
 */
import * as reuseCheck from './reuseCheck';
import * as layer0Notice from './layer0Notice';
import * as codeReview from './codeReview';
import * as paySuggest from './paySuggest';
import * as confidenceScore from './confidenceScore';
import { query } from './pg';
import * as mirror from './mirror';
import * as store from './store';
import { guardRejected } from './codexReject';
import { guardVoided, retireOnSubmission, retireOnApproval } from './layer0Void';

/** The submission a whole-record codex write names, for the rejected-log guard. */
function submissionOf(fields: unknown): string | null {
  const v = fields && typeof fields === 'object' ? (fields as Record<string, unknown>)['Submission ID'] : null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface WriteCtx {
  /** What the log calls the caller: a route path, or `mcp:<tool>`. */
  endpoint: string;
  method: string;
  /** Which credential let it in — a label, never the value. */
  key_label: string;
  /** When the request started, for `ms` on the log. */
  t0?: number;
  /** Appended to the log detail, e.g. "via MCP create_record". */
  note?: string;
}

export interface PostResult {
  ok: true;
  id: number;
  kind: mirror.MirrorKind;
  airtable_record_id: string | null;
  natural_id: string | null;
  outcome: 'inserted' | 'updated' | 'unchanged';
  matched_on: mirror.MirrorResult['matched_on'];
}

function ms(ctx: WriteCtx): number | undefined {
  return ctx.t0 === undefined ? undefined : Date.now() - ctx.t0;
}

function detail(ctx: WriteCtx, text: string): string {
  return ctx.note ? `${text} (${ctx.note})` : text;
}

/**
 * A whole record in: the upsert, the status dating, the log line. A refusal is
 * logged and rethrown as the `MirrorError` it was, so the caller answers with
 * the status it carries.
 */
/**
 * The reuse check on a submitted log (Genie rebuild 10.10). Run once, on the write that first carries the log's
 * description or summary, and stored as `Reuse Check` (a new field name, JSON): ran, the summary line and the top
 * matches. A report, a log already carrying one, or a log already decided is left as it is. It never changes pay
 * and never fails the write: a check that throws is stored as not run, with the reason.
 */
export async function reuseOnSubmission(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (fields['Reuse Check'] || String(fields['Log Kind'] ?? '') === 'Report') return fields;
  const status = String(fields['Jason Status'] ?? '');
  if (status && status !== 'Pending') return fields;
  const text = [fields['Session Description'], fields['Summary']].filter((v) => typeof v === 'string' && v.trim()).join('\n');
  if (!text) return fields;
  const sid = String(fields['Submission ID'] ?? '');
  const v = await reuseCheck.check({ text, source_ref: sid || 'log', exclude_submission_id: sid });
  const stored = { ran: v.ran, reason: v.reason ?? null, summary: v.summary, matches: v.matches.map((m) => ({ kind: m.kind, id: m.id, title: m.title, score: m.score, how: m.how })), at: new Date().toISOString() };
  return { ...fields, 'Reuse Check': JSON.stringify(stored) };
}

/**
 * VFARM_CONFIDENCE_SCORING_V0 on every commercial write (28 Nov 2026, confidenceScore.ts):
 * the card's score is worked out from the row as it will be after the write and stored on
 * it, and a write that would start a pilot is refused unless the card passes the pilot gate.
 * A card already in a pilot state is not re-gated by an unrelated edit.
 */
async function withConfidence(fields: Record<string, unknown>, current: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  const merged = { ...(current ?? {}), ...fields };
  const action = confidenceScore.gatedAction(fields);
  const already = current ? confidenceScore.gatedAction({ lane_state: current.lane_state, pilot_state: current.pilot_state }) : null;
  if (action && !already) {
    const g = confidenceScore.gate(merged, action);
    if (!g.allowed) throw new mirror.MirrorError(`confidence_gate: this card cannot start a pilot under ${confidenceScore.RULE.version}: ${g.missing.join('; ')}`, 422);
  }
  const c = confidenceScore.score(merged);
  return { ...fields, [confidenceScore.FIELD]: c, [confidenceScore.BAND_FIELD]: c.band };
}

async function currentCard(by: { rowId?: string; cardId?: string }): Promise<Record<string, unknown> | null> {
  const r = by.rowId
    ? await query<{ fields: Record<string, unknown> }>('SELECT fields FROM engine_commercial_cards WHERE id = $1', [by.rowId])
    : by.cardId
      ? await query<{ fields: Record<string, unknown> }>('SELECT fields FROM engine_commercial_cards WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1', [by.cardId])
      : { rows: [] as Array<{ fields: Record<string, unknown> }> };
  return r.rows[0]?.fields ?? null;
}

export async function postRecord(kind: mirror.MirrorKind, body: mirror.MirrorInput, ctx: WriteCtx): Promise<PostResult> {
  try {
    // A rejected Codex log is closed to the engine (2026-10-15, codexReject.ts).
    if (kind === 'codex') await guardRejected({ submissionId: submissionOf(body.fields) }, (body.fields as Record<string, unknown> | null) ?? null);
    // A voided parked log is closed to the engine too (2026-10-25, layer0Void.ts).
    if (kind === 'layer0') await guardVoided({ submissionId: submissionOf(body.fields) }, (body.fields as Record<string, unknown> | null) ?? null);
    // LogStream (9 Nov 2026): a Codex write carrying the review's work parts gets its suggested pay note.
    if (kind === 'codex' && body.fields && typeof body.fields === 'object') body = { ...body, fields: await paySuggest.annotate(body.fields as Record<string, unknown>) };
    // The code review at submission (14 Nov 2026, codeReview.ts): its answer becomes the Codex entry's code check fields.
    if (kind === 'codex' && body.fields && typeof body.fields === 'object') body = { ...body, fields: codeReview.annotate(body.fields as Record<string, unknown>) };
    // The reuse check at submission (19 Nov 2026, Genie rebuild 10.10): a flag for Jason's card, never a pay hold.
    if (kind === 'codex' && body.fields && typeof body.fields === 'object') body = { ...body, fields: await reuseOnSubmission(body.fields as Record<string, unknown>) };
    if (kind === 'commercial' && body.fields && typeof body.fields === 'object') {
      const f = body.fields as Record<string, unknown>;
      body = { ...body, fields: await withConfidence(f, await currentCard({ cardId: typeof f.card_id === 'string' ? f.card_id : undefined })) };
    }
    const result = await mirror.upsert(kind, body, 'engine');
    if (kind === 'layer0' && layer0Notice.becameComplete(body.fields as Record<string, unknown>, result.changed)) void layer0Notice.deleteOnComplete(String(result.id)).catch(() => undefined);
    // A log that went through retires any parked copy of the same recording (2026-10-25).
    // Not awaited and never able to fail this write: its outcome is on engine_writes.
    if (kind === 'codex') void retireOnSubmission((body.fields as Record<string, unknown> | null) ?? null);
    // An approved log closes its own parked copy (27 Nov 2026): never awaited, never able to fail this write.
    if (kind === 'codex') void retireOnApproval({ submissionId: submissionOf(body.fields) }, (body.fields as Record<string, unknown> | null) ?? null);
    // One read-only record post in #bha-code-reviews per code review (never awaited, never able to fail this write).
    if (kind === 'codex') void codeReview.afterCodexWrite((body.fields as Record<string, unknown> | null) ?? null);
    // The row is stored; this dates the status it left the record in. It is
    // the only place a status change is timestamped, so it happens on the
    // write rather than being noticed later, and it never fails the write.
    await store.recordEngineWrite(kind, result.id);
    const outcome = result.inserted ? 'inserted' : result.changed ? 'updated' : 'unchanged';
    await mirror.logWrite({
      endpoint: ctx.endpoint,
      kind,
      method: ctx.method,
      key_label: ctx.key_label,
      airtable_record_id: result.airtable_record_id,
      natural_id: result.natural_id,
      outcome,
      detail: detail(ctx, `matched on ${result.matched_on}`),
      ms: ms(ctx),
    });
    return {
      ok: true,
      id: result.id,
      kind: result.kind,
      airtable_record_id: result.airtable_record_id,
      natural_id: result.natural_id,
      outcome,
      matched_on: result.matched_on,
    };
  } catch (e) {
    await logRefusal(kind, ctx, e);
    throw e;
  }
}

/**
 * The row id a natural id names — exactly one, or a refusal (404 none, 409
 * more than one) that is logged before it is thrown.
 */
export async function resolveRow(kind: mirror.MirrorKind, naturalKey: string, ctx: WriteCtx): Promise<string> {
  try {
    return String(await mirror.resolveNatural(kind, naturalKey));
  } catch (e) {
    await logRefusal(kind, ctx, e, naturalKey);
    throw e;
  }
}

/**
 * Part of one record: the merge into `fields`, the status dating, the log line.
 * `rowId` is this table's own bigint id; resolve a natural id first with
 * `resolveRow`.
 */
export async function patchRecord(
  kind: mirror.MirrorKind,
  rowId: string,
  fields: Record<string, unknown>,
  ctx: WriteCtx,
  naturalKey: string | null = null,
): Promise<mirror.PatchResult & { ok: true }> {
  try {
    if (kind === 'codex') await guardRejected({ rowId }, fields);
    if (kind === 'layer0') await guardVoided({ rowId }, fields);
    if (kind === 'codex' && ('Work Parts' in fields || 'Log Class' in fields)) {
      // The suggestion is worked out from the row as it will be after the merge.
      const cur = (await query<{ fields: Record<string, unknown> }>('SELECT fields FROM engine_codex_submissions WHERE id = $1', [rowId])).rows[0]?.fields ?? {};
      const merged = await paySuggest.annotate({ ...cur, ...fields });
      fields = { ...fields, 'Pay Suggestion': merged['Pay Suggestion'] };
    }
    if (kind === 'commercial' && !(confidenceScore.FIELD in fields)) fields = await withConfidence(fields, await currentCard({ rowId }));
    const r = await mirror.patchFields(kind, rowId, fields, 'engine');
    // Same as a POST: the row is stored, and this dates the status it was
    // left in. A patch that sets Status is exactly such a change.
    await store.recordEngineWrite(kind, r.id);
    // A parked log just completed: its review notice goes (layer0Notice.ts). Never awaited, never able to fail this.
    if (kind === 'layer0' && layer0Notice.becameComplete(fields, r.changed)) void layer0Notice.deleteOnComplete(String(r.id)).catch(() => undefined);
    // An approved log closes its own parked copy (27 Nov 2026): never awaited, never able to fail this write.
    if (kind === 'codex') void retireOnApproval({ rowId: r.id ? String(r.id) : rowId }, fields);
    await mirror.logWrite({
      endpoint: ctx.endpoint,
      kind,
      method: ctx.method,
      key_label: ctx.key_label,
      airtable_record_id: r.airtable_record_id,
      natural_id: r.natural_id,
      outcome: r.changed ? 'updated' : 'unchanged',
      detail: detail(ctx, `merged ${Object.keys(fields).join(', ')} into row ${r.id}${naturalKey === null ? '' : ` (by-natural ${naturalKey})`}`),
      ms: ms(ctx),
    });
    return { ok: true, ...r };
  } catch (e) {
    await logRefusal(kind, ctx, e);
    throw e;
  }
}

async function logRefusal(kind: string, ctx: WriteCtx, e: unknown, naturalKey?: string): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  const status = e instanceof mirror.MirrorError ? e.status : 500;
  await mirror.logWrite({
    endpoint: ctx.endpoint,
    kind,
    method: ctx.method,
    key_label: ctx.key_label,
    ...(naturalKey ? { natural_id: naturalKey } : {}),
    outcome: status >= 500 ? 'error' : 'rejected',
    detail: detail(ctx, message),
    ms: ms(ctx),
  });
}
