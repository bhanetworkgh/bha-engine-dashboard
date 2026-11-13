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
import * as payNote from './payNote';
import { afterCommit, withTransaction, type Queryable } from './pg';
import * as sameDay from './sameDay';

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

/**
 * A report logged in the Codex (`Log Kind: Report`, 9 Nov 2026, Destiny: the Media Twin weekly readiness report) is a
 * record, not a session: it is never owed pay, so it gets no pay row.
 */
export function isReport(fields: Record<string, unknown>): boolean {
  return pick(fields['Log Kind']).trim().toLowerCase() === 'report';
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
 * Who marked a log paid (12 Nov 2026): the Yes, Paid click writes `Paid By Slack ID` on the log, and the
 * name is read from Builder Profiles (Jason has none, so he is named here). A log paid before that carries
 * no id and keeps what its pay rows already say, else "Jason", who pressed every Yes, Paid until then.
 */
const KNOWN_PAYERS: Record<string, string> = { U0A9V97949F: 'Jason', U0AEW3TBYH1: 'Destiny Arupi' };
async function paidByName(db: Queryable, logFields: Record<string, unknown>, existing: unknown): Promise<string> {
  const id = pick(logFields['Paid By Slack ID']).trim();
  if (id) {
    if (KNOWN_PAYERS[id]) return KNOWN_PAYERS[id];
    const r = await db.query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [id]).catch(() => ({ rows: [] as Array<{ name: string | null }> }));
    return r.rows[0]?.name || id;
  }
  return pick(existing).trim() || 'Jason';
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
    'Paid By': paid ? await paidByName(db, log.rows[0].fields, fields['Paid By'] ?? copies[0]?.fields['Paid By']) : null,
    // A late post of the session from n8n must not drop the pay note either.
    ...payNote.ledgerFields(await payNote.forEntry(db, entryId)),
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
  // A log merged into its day's entry (sameDay.ts, 14 Nov 2026) is owed nothing of its own: the day's entry is the
  // one paid day. Its unpaid pay rows go, each kept in record_deletions first; a row already marked paid is kept,
  // because a payment that happened is never taken off the record.
  if (sameDay.isMerged(fields)) return dropMergedCopies(db, entryId, fields);

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
    'Paid By': paid ? await paidByName(db, fields, first['Paid By']) : null,
    'Codex Link': pick(fields['Session Url']),
    // The pay note (9 Nov 2026, payNote.ts): shares credited, held and docked, laid onto every copy.
    ...payNote.ledgerFields(await payNote.forEntry(db, entryId)),
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
      // A session just marked paid: redraw the builder's other open cards once this commits (payCard.refreshUnpaidSoon).
      if (paid && copy.fields.Paid !== true && copy.fields.Paid !== 'true' && copy.fields.Paid !== 'Yes' && slackId) {
        afterCommit(db, () => { void import('./payCard').then((pc) => pc.refreshUnpaidSoon(slackId)).catch(() => undefined); });
      }
      // A paid session turned unpaid (13 Nov 2026): the 12 Nov boot reconcile did this with nothing said. The log
      // is the record, so the write stands, but it is raised at once: one event and one alert in the engine alerts channel.
      if (!paid && (copy.fields.Paid === true || copy.fields.Paid === 'true' || copy.fields.Paid === 'Yes')) {
        const row = Number(copy.id);
        afterCommit(db, () => { void raiseUnpaid(row, entryId, slackId, pick(fields.Paid)); });
      }
    }
  }
  if (changedAny) await closeSettledStatements(db, slackId, month);
  return changedAny ? 'updated' : 'unchanged';
}

async function dropMergedCopies(db: Queryable, entryId: string, fields: Record<string, unknown>): Promise<SyncOutcome> {
  const copies = await heldCopies(db, entryId);
  let dropped = 0;
  const day = pick(fields[sameDay.FIELD.entryCodex]) || pick(fields[sameDay.FIELD.entrySubmission]);
  for (const c of copies) {
    const paid = c.fields.Paid === true || c.fields.Paid === 'true' || c.fields.Paid === 'Yes';
    if (paid) {
      console.error(`[pay-sync] ${entryId} is merged into the day of ${day || 'another log'} but its pay row ${c.id} is marked paid, so it is kept.`);
      continue;
    }
    const row = (await db.query<{ airtable_record_id: string | null; natural_id: string | null }>(`SELECT airtable_record_id, natural_id FROM ${SESSIONS} WHERE id = $1::bigint`, [c.id])).rows[0];
    await db.query(
      `INSERT INTO record_deletions (kind, record_id, natural_id, builder_id, table_id, reason, fields, actor, at) VALUES ('pay_sessions', $1, $2, NULL, NULL, $3, $4, 'pay-sync', $5)`,
      [row?.airtable_record_id ?? `row-${c.id}`, row?.natural_id ?? entryId, `Merged into the day entry ${day || '(not yet approved)'}: one working day is one paid day (SOP 3c0def60).`, JSON.stringify(c.fields), nowIso()],
    );
    await db.query(`DELETE FROM ${SESSIONS} WHERE id = $1::bigint`, [c.id]);
    events.changed('pay_sessions', Number(c.id), db);
    dropped++;
  }
  if (dropped) {
    const slackId = pick(fields['Builder User ID']).trim();
    if (slackId) afterCommit(db, () => { void import('./payCard').then((pc) => pc.refreshUnpaidSoon(slackId)).catch(() => undefined); });
  }
  return dropped ? 'updated' : 'unchanged';
}

/** One alert when a paid pay session is written unpaid: who, which log, what the log now says. Never throws. */
export async function raiseUnpaid(rowId: number, entryId: string, slackId: string, logPaid: string): Promise<void> {
  const text = `A pay session that was marked paid has just been written unpaid: pay row ${rowId}, Codex ${entryId}, builder ${slackId || 'unknown'}. The log now says Paid "${logPaid || 'empty'}". If nobody meant to undo a payment, check the log and mark it paid again.`;
  try {
    const engineEvents = await import('./engineEvents');
    const claim = await engineEvents.record({ event_type: 'pay_session_unpaid', subject_id: entryId, lane: 'BAYS', actor: 'pay-sync', detail: { row_id: rowId, builder_slack_id: slackId, log_paid: logPaid, text }, dedupe_key: `pay_session_unpaid:${rowId}:${nowIso().slice(0, 16)}` });
    if (!claim.recorded) return;
    const channel = process.env.QUOTA_ALERT_CHANNEL?.trim();
    if (!channel) return void console.error(`[pay-sync] no QUOTA_ALERT_CHANNEL, alert not posted: ${text}`);
    const slack = await import('./slack');
    const res = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false });
    if (!res.ok) console.error(`[pay-sync] unpaid alert refused by Slack (${res.error}): ${text}`);
  } catch (e) {
    console.error(`[pay-sync] unpaid alert not posted: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  if (!entryIdOf(fields) || isReport(fields)) return 'skipped';
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
  // Ids first, then each log read fresh just before it is synced (12 Nov 2026): the pass takes minutes, and
  // syncing from a copy read at the start undid a Yes, Paid pressed while it ran (CODEX-20261112-destiny-…,
  // paid 20:26:21, set unpaid by the boot pass at 20:27:29 from its 20:24 copy).
  const r = await withTransaction((db) =>
    db.query<{ id: string }>(`SELECT id::text AS id FROM engine_codex_submissions WHERE fields ? 'Codex Entry ID' ORDER BY id`),
  );
  const out: ReconcileResult = { checked: 0, created: 0, updated: 0, unchanged: 0, statements_closed: 0, failed: [], ms: 0 };
  for (const { id } of r.rows) {
    const fresh = await withTransaction((db) => db.query<{ fields: Record<string, unknown> }>(`SELECT fields FROM engine_codex_submissions WHERE id = $1::bigint`, [id]));
    const row = fresh.rows[0];
    if (!row || !entryIdOf(row.fields) || isReport(row.fields)) continue;
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
