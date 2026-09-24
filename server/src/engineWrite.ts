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
import * as mirror from './mirror';
import * as store from './store';

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
export async function postRecord(kind: mirror.MirrorKind, body: mirror.MirrorInput, ctx: WriteCtx): Promise<PostResult> {
  try {
    const result = await mirror.upsert(kind, body, 'engine');
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
    const r = await mirror.patchFields(kind, rowId, fields, 'engine');
    // Same as a POST: the row is stored, and this dates the status it was
    // left in. A patch that sets Status is exactly such a change.
    await store.recordEngineWrite(kind, r.id);
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
