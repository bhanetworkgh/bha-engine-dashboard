/**
 * One working day is one Codex entry and one paid day (14 Nov 2026, Destiny; Jason's SOP 3c0def60, "One Log
 * Per Working Day: Merged Logs Create No Future Balance").
 *
 * A builder may submit as many logs in a day as they like, and each still goes to Jason's review. But every log a
 * builder submits on one UTC calendar date after the first belongs to that day's entry: it pays nothing of its
 * own, gets no pay row, no pay card, no Codex post, no impact post and no Logstream post, and its held share never
 * becomes a balance. The builder is told it was added to the day's running log.
 *
 * Which log owns the day (the "primary"): the first of the day to be approved with a Codex Entry ID, by approval
 * time; else the first approved; else the earliest submitted. So once a day's entry is approved and owed pay, it
 * stays the day's entry, whatever arrives after it. A rejected log or a report is not part of any day.
 *
 * Worked out on every Codex write, in the same transaction (mirror.afterWrite), for every log of that builder on
 * that date, and written onto each row as new fields (never a rename):
 *
 *   Day Date                 the UTC date, YYYY-MM-DD
 *   Day Logs                 how many logs the day holds
 *   Day Log Number           this log's place in the day, by when it was submitted
 *   Day Entry Submission ID  the primary's Submission ID
 *   Day Entry Codex ID       the primary's Codex Entry ID, once it has one
 *   Merged Into Day          true for every log but the primary
 *
 * Only from `CUTOVER` (UTC date). Days before it were paid as they were, and nothing here rewrites them.
 */
import { nowIso } from './db';
import * as events from './events';
import type { Queryable } from './pg';

type Obj = Record<string, unknown>;

export const ZONE = 'UTC';
/** The first UTC date the rule applies to (Destiny, 13 Nov 2026: merge Ahad's 12 and 13 Nov logs). */
export const CUTOVER = '2026-11-12';

export const FIELD = {
  date: 'Day Date',
  logs: 'Day Logs',
  number: 'Day Log Number',
  entrySubmission: 'Day Entry Submission ID',
  entryCodex: 'Day Entry Codex ID',
  merged: 'Merged Into Day',
} as const;

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(typeof v === 'object' ? ((v as Obj).name ?? '') : v)).trim();
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The UTC calendar date of a timestamp, or null when it is not one. Pure. */
export function utcDate(raw: unknown): string | null {
  const t = s(raw);
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return fmt.format(d);
}

/** True when this log was merged into another log's day. */
export function isMerged(fields: Obj | null | undefined): boolean {
  const v = fields?.[FIELD.merged];
  return v === true || v === 'true';
}

/** SQL for the Submission IDs of every merged log, for leaving their pay notes out of anything owed. */
export const MERGED_SUBMISSIONS_SQL = `SELECT fields->>'Submission ID' FROM engine_codex_submissions WHERE fields->>'Merged Into Day' = 'true'`;

/** The builder and date a log belongs to, or null when it is not in any day (no builder, no time, before the cutover, a report). */
export function dayKey(fields: Obj | null | undefined): { builder: string; date: string } | null {
  if (!fields) return null;
  const builder = s(fields['Builder User ID']);
  const date = utcDate(fields.Timestamp) ?? utcDate(fields['Processed At']);
  if (!builder || !date || date < CUTOVER) return null;
  if (s(fields['Log Kind']).toLowerCase() === 'report') return null;
  return { builder, date };
}

function inDay(fields: Obj): boolean {
  return s(fields['Jason Status']) !== 'Rejected' && dayKey(fields) !== null;
}

const approvedAt = (f: Obj): number => {
  for (const k of ['Jason Reviewed At', 'Processed At', 'Timestamp']) {
    const t = Date.parse(s(f[k]));
    if (!Number.isNaN(t)) return t;
  }
  return Number.MAX_SAFE_INTEGER;
};
const submittedAt = (f: Obj): number => {
  const t = Date.parse(s(f.Timestamp));
  return Number.isNaN(t) ? approvedAt(f) : t;
};

export interface DayRow {
  id: string;
  fields: Obj;
}

/**
 * The fields each log of one builder's day should carry. Pure: the rows in, a patch per row id out. Rows that are not
 * in the day (rejected, a report) are left out of the answer and keep what they have.
 */
export function planDay(rows: DayRow[]): Map<string, Obj> {
  const day = rows.filter((r) => inDay(r.fields));
  const out = new Map<string, Obj>();
  if (!day.length) return out;
  // The first log submitted that UTC day owns it (Destiny, 13 Nov 2026: "as long as you have submitted the first one, it
  // counts as that day's pay"); every later one is an extra log, decided at submission, so approval order never moves it.
  const primary = [...day].sort((a, b) => submittedAt(a.fields) - submittedAt(b.fields) || Number(a.id) - Number(b.id))[0];
  const order = [...day].sort((a, b) => submittedAt(a.fields) - submittedAt(b.fields) || Number(a.id) - Number(b.id));
  const date = dayKey(primary.fields)!.date;
  order.forEach((r, i) => {
    out.set(r.id, {
      [FIELD.date]: date,
      [FIELD.logs]: day.length,
      [FIELD.number]: i + 1,
      [FIELD.entrySubmission]: s(primary.fields['Submission ID']) || null,
      [FIELD.entryCodex]: s(primary.fields['Codex Entry ID']) || null,
      [FIELD.merged]: r.id !== primary.id,
    });
  });
  return out;
}

/** Every log of one builder within a day either side of a UTC date, whole. The day itself is picked out in planDay. */
async function readNear(db: Queryable, builder: string, date: string): Promise<DayRow[]> {
  const d = new Date(`${date}T12:00:00Z`);
  const lo = new Date(d.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const hi = new Date(d.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  const r = await db.query<{ id: string; fields: Obj }>(
    `SELECT id::text AS id, fields FROM engine_codex_submissions
      WHERE fields->>'Builder User ID' = $1
        AND left(coalesce(fields->>'Timestamp', fields->>'Processed At', ''), 10) BETWEEN $2 AND $3
      ORDER BY id`,
    [builder, lo, hi],
  );
  return r.rows.filter((x) => dayKey(x.fields)?.date === date);
}

/**
 * Works one builder's day out again and writes the day fields onto every log that needs them, then brings each
 * log's pay row into line. Inside the caller's transaction. Returns the rows it changed.
 */
export async function regroup(db: Queryable, builder: string, date: string): Promise<{ rows: DayRow[]; changed: string[] }> {
  const rows = await readNear(db, builder, date);
  const plan = planDay(rows);
  const changed: string[] = [];
  const at = nowIso();
  for (const r of rows) {
    const patch = plan.get(r.id);
    if (!patch) continue;
    const same = Object.entries(patch).every(([k, v]) => JSON.stringify(r.fields[k] ?? null) === JSON.stringify(v));
    if (same) continue;
    await db.query(`UPDATE engine_codex_submissions SET fields = fields || $2::jsonb, updated_at = $3 WHERE id = $1::bigint`, [r.id, JSON.stringify(patch), at]);
    r.fields = { ...r.fields, ...patch };
    events.changed('codex', Number(r.id), db);
    changed.push(r.id);
  }
  return { rows, changed };
}

/**
 * What a stored Codex write sets off for pay (mirror.afterWrite): a log in a day regroups that day and syncs the pay
 * of every log in it, the primary first; any other log syncs its own pay as before.
 */
export async function afterCodexWrite(fields: Obj, db: Queryable, syncPay: (row: { fields: Obj }, on: Queryable) => Promise<unknown>): Promise<void> {
  const key = dayKey(fields);
  if (!key) {
    await syncPay({ fields }, db);
    return;
  }
  const { rows } = await regroup(db, key.builder, key.date);
  const sorted = [...rows].sort((a, b) => Number(isMerged(a.fields)) - Number(isMerged(b.fields)));
  for (const r of sorted) await syncPay({ fields: r.fields }, db);
  if (!rows.some((r) => s(r.fields['Submission ID']) === s(fields['Submission ID']))) await syncPay({ fields }, db);
}

/**
 * Every day from the cutover worked out again, once at boot: the rows held before this shipped (Ahad's 12 and 13 Nov)
 * get their day fields, and the pay rows of logs merged into a day go. Safe to repeat: a second run changes nothing.
 */
export async function backfill(run: (fn: (db: Queryable) => Promise<void>) => Promise<void>, syncPay: (row: { fields: Obj }, on: Queryable) => Promise<unknown>): Promise<{ days: number; changed: number }> {
  let days = 0;
  let changed = 0;
  await run(async (db) => {
    const r = await db.query<{ b: string; t: string }>(
      `SELECT DISTINCT fields->>'Builder User ID' AS b, left(coalesce(fields->>'Timestamp', fields->>'Processed At', ''), 10) AS t
         FROM engine_codex_submissions
        WHERE coalesce(fields->>'Builder User ID', '') <> '' AND left(coalesce(fields->>'Timestamp', fields->>'Processed At', ''), 10) >= $1`,
      [new Date(Date.parse(`${CUTOVER}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)],
    );
    const seen = new Set<string>();
    for (const x of r.rows) {
      for (const shift of [-1, 0, 1]) {
        const d = new Date(Date.parse(`${x.t}T12:00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10);
        if (d < CUTOVER || seen.has(`${x.b}|${d}`)) continue;
        seen.add(`${x.b}|${d}`);
        const out = await regroup(db, x.b, d);
        if (!out.rows.length) continue;
        days++;
        changed += out.changed.length;
        if (out.changed.length) for (const row of out.rows) await syncPay({ fields: row.fields }, db);
      }
    }
  });
  return { days, changed };
}

/** The logs of one day, for the Codex page's "This day's logs". */
export async function dayOf(db: Queryable, fields: Obj): Promise<{ date: string; entry_submission_id: string | null; entry_codex_id: string | null; logs: { id: string; submission_id: string; codex_entry_id: string | null; title: string; submitted_at: string | null; status: string; merged: boolean; number: number }[] } | null> {
  const key = dayKey(fields);
  if (!key) return null;
  const rows = (await readNear(db, key.builder, key.date)).filter((r) => inDay(r.fields));
  if (rows.length < 2) return null;
  const plan = planDay(rows);
  const logs = rows
    .map((r) => {
      const p = plan.get(r.id) ?? {};
      return {
        id: r.id,
        submission_id: s(r.fields['Submission ID']),
        codex_entry_id: s(r.fields['Codex Entry ID']) || null,
        title: s(r.fields['Session Description']).slice(0, 300) || 'Untitled session',
        submitted_at: s(r.fields.Timestamp) || null,
        status: s(r.fields['Jason Status']) || 'Pending',
        merged: p[FIELD.merged] === true,
        number: Number(p[FIELD.number] ?? 0),
      };
    })
    .sort((a, b) => a.number - b.number);
  const primary = logs.find((l) => !l.merged) ?? null;
  return { date: key.date, entry_submission_id: primary?.submission_id ?? null, entry_codex_id: primary?.codex_entry_id ?? null, logs };
}

/**
 * Is a log submitted now (or at `at`) an extra log of its builder's UTC day? Asked at submission (relog-check) and on
 * every Codex write (paySuggest.annotate), before the day fields are stamped. An extra log is any log after the first
 * non-rejected log of that builder on that UTC date. Null when it is the first, or before the cutover.
 */
export async function extraOfDay(db: Queryable, b: { builder_user_id?: unknown; submission_id?: unknown; at?: unknown }): Promise<{ day_date: string; entry_submission_id: string | null; entry_codex_id: string | null; log_number: number; earlier: { submission_id: string; codex_entry_id: string | null; status: string }[] } | null> {
  const builder = s(b.builder_user_id);
  const self = s(b.submission_id);
  const at = utcDate(b.at) ?? utcDate(new Date().toISOString());
  if (!builder || !at || at < CUTOVER) return null;
  const rows = (await readNear(db, builder, at)).filter((r) => s(r.fields['Submission ID']) !== self || !self);
  const mine = Date.parse(s(b.at)) || Date.now();
  const earlier = rows
    .filter((r) => inDay(r.fields) && dayKey(r.fields)!.date === at && submittedAt(r.fields) < mine && (!self || s(r.fields['Submission ID']) !== self))
    .sort((x, y) => submittedAt(x.fields) - submittedAt(y.fields) || Number(x.id) - Number(y.id));
  if (!earlier.length) return null;
  const first = earlier[0].fields;
  return {
    day_date: at,
    entry_submission_id: s(first['Submission ID']) || null,
    entry_codex_id: s(first['Codex Entry ID']) || null,
    log_number: earlier.length + 1,
    earlier: earlier.map((r) => ({ submission_id: s(r.fields['Submission ID']), codex_entry_id: s(r.fields['Codex Entry ID']) || null, status: s(r.fields['Jason Status']) || 'Pending' })),
  };
}

