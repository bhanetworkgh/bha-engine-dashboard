/**
 * The pay ledger kept in step with the session logs at the moment a log is
 * written (2026-09-23, Destiny).
 *
 * Until now `Bays — Pay Ledger Sync` did this in n8n every thirty minutes: read
 * every approved log, read the roster, rebuild each ledger row and post it
 * back. So a Paid tick on a Slack card, or an approval, reached /pay up to half
 * an hour later. This does the same thing inside the write that changed the
 * log — the same transaction — so the two cannot be seen disagreeing, and the
 * n8n job has nothing left to do.
 *
 * **The rules are ported from that workflow's `Build Ledger Rows` node**, read
 * off the live workflow rather than remembered:
 *
 *   - a log is owed once it carries a `Codex Entry ID` — written at approval,
 *     so no select value has to be guessed at;
 *   - the builder is `Builder User ID` (a plain value, or `{name}`), and Pay
 *     Mode and the display name come from the roster by that Slack id,
 *     defaulting to Daily, then the log's `Builder Name`, then
 *     `Unknown builder`;
 *   - the session's date and month are when the work happened — `Timestamp`,
 *     else `Processed At`, in UTC — never when it was approved, or month-end
 *     work drifts into the wrong statement;
 *   - `Approved At` is `Jason Reviewed At`, else `Processed At`;
 *   - Paid is an explicit "Yes" on the log and nothing else.
 *
 * Three things this does that the node did not, all on Destiny's instruction:
 *
 *   - **Pay Mode is frozen at first write.** A builder moved from daily to
 *     monthly keeps the mode their earlier sessions were approved under; the
 *     node rewrote it every thirty minutes.
 *   - **Paid At is when the log flipped to Yes**, kept once set. The node
 *     wrote `Jason Reviewed At`, which is when the log was approved, not paid.
 *   - **A Slack Card Link, and every other field a row already has, is kept.**
 *     The node posted a whole record and dropped whatever it did not name.
 *
 * **The log is the source of truth for Paid**, in both directions. `Bays — Pay
 * Tracking` posts every newly approved session with Paid false, and that post
 * can land after the log was already marked paid; `applyLogPaid` is what
 * mirror.upsert runs on every pay_sessions write so that late post cannot undo
 * a payment.
 *
 * **Every copy of a session is written, not one.** The ledger holds two rows
 * for most sessions approved before the cutover — the copy read out of
 * Airtable, bound to its record id, and the copy n8n posted afterwards with
 * none — and the Pay page shows n8n's (see pay.sessionsHeld). Updating one
 * would leave the page reading the other, so each copy is brought to the same
 * Paid state, and the two stop disagreeing.
 */
import { nowIso } from './db';
import * as events from './events';
import * as mirror from './mirror';
import { withTransaction, type Queryable } from './pg';

const SESSIONS = 'engine_pay_sessions';
const STATEMENTS = 'engine_pay_statements';
const BUILDERS = 'engine_pay_builders';

/** A select can arrive as `{name}`; everything else is read as it is. Same as the node's `pick`. */
function pick(v: unknown): string {
  if (v && typeof v === 'object') return String((v as { name?: unknown }).name ?? '');
  return v === null || v === undefined ? '' : String(v);
}

function entryIdOf(fields: Record<string, unknown>): string | null {
  const v = pick(fields['Codex Entry ID']).trim();
  return v || null;
}

/** Paid on the log: an explicit Yes, and nothing else. An empty value means nobody has said. */
export function logSaysPaid(fields: Record<string, unknown>): boolean {
  return pick(fields.Paid).trim().toLowerCase() === 'yes';
}

type Held = { id: string; fields: Record<string, unknown> };

async function heldCopies(db: Queryable, entryId: string): Promise<Held[]> {
  const r = await db.query<Held>(`SELECT id::text AS id, fields FROM ${SESSIONS} WHERE natural_id = $1 ORDER BY id FOR UPDATE`, [entryId]);
  return r.rows;
}

/**
 * The payment's own date, one value for every copy: the earliest `Paid At`
 * any copy already carries, so a time once written is never moved, and `now`
 * only when this is the moment the log turned paid.
 */
function paidAtFor(copies: Held[], incoming: unknown): string {
  const set = copies
    .filter((c) => c.fields.Paid === true)
    .map((c) => pick(c.fields['Paid At']).trim())
    .filter(Boolean)
    .sort();
  return set[0] || pick(incoming).trim() || nowIso();
}

/**
 * What the log says about Paid, laid over an incoming pay_sessions row.
 *
 * Called by mirror.upsert on every pay_sessions write, inside its transaction.
 * Where no log carries this Codex Entry ID the row is left exactly as sent —
 * there is nothing to be the source of truth.
 */
export async function applyLogPaid(db: Queryable, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entryId = entryIdOf(fields);
  if (!entryId) return fields;
  const log = await db.query<{ fields: Record<string, unknown> }>(
    `SELECT fields FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [entryId],
  );
  if (!log.rows[0]) return fields;
  const paid = logSaysPaid(log.rows[0].fields);
  const copies = paid ? await heldCopies(db, entryId) : [];
  return {
    ...fields,
    Paid: paid,
    'Paid At': paid ? paidAtFor(copies, fields['Paid At']) : null,
    'Paid By': paid ? 'Jason' : null,
  };
}

/* ------------------------------------------------------------- the sync */

export type SyncOutcome = 'created' | 'updated' | 'unchanged' | 'skipped';

function ymd(raw: unknown): { date: string; month: string } | null {
  const s = pick(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
}

async function syncWith(db: Queryable, fields: Record<string, unknown>): Promise<SyncOutcome> {
  const entryId = entryIdOf(fields);
  if (!entryId) return 'skipped';

  const slackId = pick(fields['Builder User ID']).trim();
  const roster = slackId
    ? (await db.query<{ fields: Record<string, unknown> }>(`SELECT fields FROM ${BUILDERS} WHERE natural_id = $1 ORDER BY id LIMIT 1`, [slackId])).rows[0]?.fields ?? null
    : null;

  const copies = await heldCopies(db, entryId);
  const first = copies[0]?.fields ?? {};

  // When the work happened. With neither stamp, a row already held keeps the
  // date it has — re-deriving "now" on every write would move the session
  // each time, and the reconcile could never come back unchanged.
  const when = ymd(fields.Timestamp) ?? ymd(fields['Processed At']);
  const fallback = ymd(new Date().toISOString())!;
  const sessionDate = when?.date ?? (pick(first['Session Date']) || fallback.date);
  const month = when?.month ?? (pick(first.Month) || fallback.month);
  const approvedAt = pick(fields['Jason Reviewed At']) || pick(fields['Processed At']) || pick(first['Approved At']) || nowIso();

  const paid = logSaysPaid(fields);
  const paidAt = paid ? paidAtFor(copies, null) : null;

  const derived = {
    'Codex Entry ID': entryId,
    Builder: pick(roster?.Builder) || pick(fields['Builder Name']) || 'Unknown builder',
    'Builder Slack ID': slackId,
    'Session Date': sessionDate,
    'Approved At': approvedAt,
    Month: month,
    Paid: paid,
    'Paid At': paidAt,
    'Paid By': paid ? 'Jason' : null,
    'Codex Link': pick(fields['Session Url']),
  };
  const modeNow = pick(roster?.['Pay Mode']) || 'Daily';

  if (!copies.length) {
    const result = await mirror.upsert('pay_sessions', { created_time: nowIso(), fields: { ...derived, 'Pay Mode': modeNow } }, 'engine', db);
    return result.inserted ? 'created' : result.changed ? 'updated' : 'unchanged';
  }

  let changedAny = false;
  const at = nowIso();
  for (const copy of copies) {
    // Every field the row already has is kept — a Slack Card Link above all —
    // and Pay Mode is the row's own once it has one.
    const next = { ...copy.fields, ...derived, 'Pay Mode': pick(copy.fields['Pay Mode']) || modeNow };
    const r = await db.query<{ changed: boolean }>(
      `WITH b AS (SELECT fields FROM ${SESSIONS} WHERE id = $1::bigint)
       UPDATE ${SESSIONS} AS t
          SET fields = $2::jsonb,
              source = CASE WHEN b.fields IS DISTINCT FROM $2::jsonb THEN 'engine' ELSE t.source END,
              updated_at = CASE WHEN b.fields IS DISTINCT FROM $2::jsonb THEN $3 ELSE t.updated_at END
         FROM b
        WHERE t.id = $1::bigint
       RETURNING (b.fields IS DISTINCT FROM t.fields) AS changed`,
      [copy.id, JSON.stringify(next), at],
    );
    if (r.rows[0]?.changed) {
      changedAny = true;
      events.changed('pay_sessions', Number(copy.id), db);
    }
  }
  if (changedAny) await closeSettledStatements(db, slackId, month);
  return changedAny ? 'updated' : 'unchanged';
}

/**
 * Brings the pay ledger into line with one session log.
 *
 * With `on`, inside the caller's transaction and behind a savepoint: a ledger
 * row this cannot write is logged and the log's own write still lands — an
 * approval on Slack must never be refused because the pay copy of it could
 * not be kept, and the reconcile route puts the ledger right afterwards.
 * Without `on`, in a transaction of its own, and a failure is thrown.
 */
export async function syncPayFromCodex(codexRow: { fields: Record<string, unknown> | null | undefined }, on?: Queryable): Promise<SyncOutcome> {
  const fields = codexRow.fields ?? {};
  if (!entryIdOf(fields)) return 'skipped';
  if (!on) return withTransaction((db) => syncWith(db, fields));

  await on.query('SAVEPOINT pay_sync');
  try {
    const out = await syncWith(on, fields);
    await on.query('RELEASE SAVEPOINT pay_sync');
    return out;
  } catch (e) {
    await on.query('ROLLBACK TO SAVEPOINT pay_sync');
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pay-sync ${entryIdOf(fields)} failed, the log was still written: ${message}`);
    void mirror.logWrite({ endpoint: 'pay-sync', kind: 'pay_sessions', method: 'SYNC', key_label: null, natural_id: entryIdOf(fields), outcome: 'error', detail: `the log was written and its pay row was not: ${message}` });
    return 'skipped';
  }
}

/* ------------------------------------------------------- the statements */

/**
 * A Sent statement closes itself once every session behind it is paid — the
 * node `Close Settled Statements`, ported. Sessions are counted by Codex Entry
 * ID, so the two copies of a pre-cutover session are one session, not two.
 * Returns how many statements it closed.
 */
export async function closeSettledStatements(db: Queryable, builderSlackId: string, month: string): Promise<number> {
  if (!builderSlackId || !month) return 0;
  const open = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM ${STATEMENTS} WHERE fields->>'Status' = 'Sent' AND fields->>'Builder Slack ID' = $1 AND fields->>'Month' = $2`,
    [builderSlackId, month],
  );
  if (!open.rows.length) return 0;

  const s = await db.query<{ sessions: string; unpaid: string }>(
    `SELECT count(DISTINCT natural_id) AS sessions,
            count(*) FILTER (WHERE (fields->>'Paid') IS DISTINCT FROM 'true') AS unpaid
       FROM ${SESSIONS} WHERE fields->>'Builder Slack ID' = $1 AND fields->>'Month' = $2`,
    [builderSlackId, month],
  );
  const n = Number(s.rows[0]?.sessions ?? 0);
  if (!n || Number(s.rows[0]?.unpaid ?? 0) > 0) return 0;

  const at = nowIso();
  const patch = {
    Status: 'Payment Sent',
    'Payment Sent At': at,
    'Confirmed By': 'Marked paid on the session cards',
    Notes: `Closed automatically: all ${n} session(s) in this statement are marked paid.`,
  };
  for (const row of open.rows) {
    await db.query(`UPDATE ${STATEMENTS} SET fields = fields || $2::jsonb, source = 'engine', updated_at = $3 WHERE id = $1::bigint`, [row.id, JSON.stringify(patch), at]);
    events.changed('pay_statements', Number(row.id), db);
  }
  return open.rows.length;
}

/** Every Sent statement checked once — the reconcile's second half. */
async function closeAllSettled(): Promise<number> {
  return withTransaction(async (db) => {
    const r = await db.query<{ b: string; m: string }>(
      `SELECT DISTINCT fields->>'Builder Slack ID' AS b, fields->>'Month' AS m FROM ${STATEMENTS} WHERE fields->>'Status' = 'Sent'`,
    );
    let closed = 0;
    for (const x of r.rows) closed += await closeSettledStatements(db, x.b ?? '', x.m ?? '');
    return closed;
  });
}

/* ------------------------------------------------------- the reconcile */

export interface ReconcileResult {
  checked: number;
  created: number;
  updated: number;
  unchanged: number;
  statements_closed: number;
  failed: { codex_entry_id: string; reason: string }[];
  ms: number;
}

/**
 * POST /api/engine/pay/reconcile: every approved log through the same sync,
 * then every Sent statement through the same check. Safe to run any number of
 * times — a second run straight after the first reports every session
 * unchanged, which is the proof the two are in step.
 */
export async function reconcile(): Promise<ReconcileResult> {
  const t0 = Date.now();
  const r = await withTransaction((db) =>
    db.query<{ fields: Record<string, unknown> }>(`SELECT fields FROM engine_codex_submissions WHERE fields ? 'Codex Entry ID' ORDER BY id`),
  );
  const out: ReconcileResult = { checked: 0, created: 0, updated: 0, unchanged: 0, statements_closed: 0, failed: [], ms: 0 };
  for (const row of r.rows) {
    if (!entryIdOf(row.fields)) continue;
    out.checked++;
    try {
      const o = await syncPayFromCodex(row);
      if (o === 'created') out.created++;
      else if (o === 'updated') out.updated++;
      else if (o === 'unchanged') out.unchanged++;
    } catch (e) {
      out.failed.push({ codex_entry_id: entryIdOf(row.fields) ?? '?', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  out.statements_closed = await closeAllSettled();
  out.ms = Date.now() - t0;
  return out;
}
