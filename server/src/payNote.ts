/**
 * Pay notes (9 Nov 2026, Destiny; Jason's DM D0AF0DG8ZPY 1794237173.152349, approved 16:57 CET).
 *
 * Every approved log carries a pay note: how much of a day is credited now, how much is held until
 * a stated condition is met, and, by subtraction, how much is docked for good. **Shares of a day,
 * never money**: full = 1.0, half = 0.5, none = 0.0 or a custom fraction. Jason applies the day rate
 * outside the system when he signs a statement.
 *
 *   pay_recommendation   full | half | none | custom_fraction
 *   credited_share       paid in the session's own month
 *   held_share           waiting on release_condition; moves to released_share when released
 *   released_share       what a release moved, paid in release_month
 *   docked               1 - credited - held - released; never paid, never backfilled
 *   reason_tag           LOCAL_ONLY | RELOG_OLD_WORK | PARTIAL_SCOPE | TEST_ONLY | OTHER
 *   reason_note, release_condition, decided_by/at, released_by/at, proof_link
 *
 * The rules, all enforced here rather than left to whoever calls:
 *   - Only Destiny or Jason decide or release.
 *   - Anything less than full needs a reason tag. Anything held needs a release condition. Anything
 *     docked needs a reason note, because a dock is never undone.
 *   - **Corrected forward, never removed** (Jason, 9 Nov): every set, correction and release is a new
 *     line in engine_pay_note_history, which the database refuses to edit or delete, and a pay note
 *     cannot be deleted. A second decision on the same log is a correction and needs a correction note.
 *   - **A dock stays docked**: a correction may not raise credited + held above what the log already
 *     had before. Only a release moves held into paid, and only with a proof link.
 *   - A log with no pay note counts as full, which is what every log approved before this was.
 *
 * Keyed on Submission ID, which a log has from the moment it is submitted; the Codex Entry ID is
 * written later in the approval run, so it is resolved from the log whenever it is read.
 */
import { query, withTransaction, type Queryable } from './pg';
import * as events from './events';
import * as engineEvents from './engineEvents';
import { FeedError } from './systemFeeds';
import * as paySuggest from './paySuggest';
const pct = paySuggest.pct;

export const RECOMMENDATIONS = ['full', 'half', 'none', 'custom_fraction'] as const;
export const REASON_TAGS = ['LOCAL_ONLY', 'RELOG_OLD_WORK', 'PARTIAL_SCOPE', 'TEST_ONLY', 'OTHER'] as const;
export const DECIDERS: Record<string, string> = { U0AEW3TBYH1: 'Destiny Arupi', U0A9V97949F: 'Jason Bays' };
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export class PayNoteError extends FeedError {
  constructor(
    public reason: string,
    message: string,
    status = 422,
  ) {
    super(status, message);
  }
}

type Obj = Record<string, unknown>;
const s = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const pick = (v: unknown): string => (v && typeof v === 'object' ? String((v as Obj).name ?? '') : v == null ? '' : String(v));

export interface PayNote {
  submission_id: string;
  codex_entry_id: string | null;
  builder_slack_id: string | null;
  builder: string | null;
  session_month: string | null;
  pay_recommendation: Recommendation;
  credited_share: number;
  held_share: number;
  released_share: number;
  docked_share: number;
  reason_tag: string | null;
  reason_note: string | null;
  release_condition: string | null;
  decided_by: string;
  decided_by_name: string | null;
  decided_at: string;
  released_by: string | null;
  released_at: string | null;
  release_month: string | null;
  proof_link: string | null;
  /** What the review suggested when this was decided (LogStream, 9 Nov 2026); null before it. */
  suggested: Record<string, unknown> | null;
  log_class: string | null;
  relog_of: string | null;
}

const COLS = `submission_id, codex_entry_id, builder_slack_id, builder, session_month, pay_recommendation,
  credited_share::float8 AS credited_share, held_share::float8 AS held_share, released_share::float8 AS released_share,
  reason_tag, reason_note, release_condition, decided_by,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at, released_by,
  to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS released_at, release_month, proof_link,
  suggested, log_class, relog_of`;

function shape(r: Obj): PayNote {
  const credited = Number(r.credited_share);
  const held = Number(r.held_share);
  const released = Number(r.released_share);
  return {
    ...(r as unknown as PayNote),
    credited_share: credited,
    held_share: held,
    released_share: released,
    docked_share: Math.max(0, round3(1 - credited - held - released)),
    decided_by_name: DECIDERS[String(r.decided_by)] ?? null,
  };
}

/** The log a note belongs to, by Submission ID or Codex Entry ID. Approved only: a pay note is an approval's. */
async function findLog(db: Queryable, ref: { submission_id?: string; codex_entry_id?: string }): Promise<{ submission_id: string; codex_entry_id: string | null; builder_slack_id: string | null; builder: string | null; month: string | null; status: string; fields: Obj }> {
  const sub = s(ref.submission_id, 200);
  const cid = s(ref.codex_entry_id, 200);
  if (!sub && !cid) throw new PayNoteError('missing_log', 'Name the log: submission_id or codex_entry_id.');
  const r = await db.query<{ fields: Obj }>(
    `SELECT fields FROM engine_codex_submissions
      WHERE ($1 <> '' AND fields->>'Submission ID' = $1) OR ($2 <> '' AND fields->>'Codex Entry ID' = $2)
      ORDER BY updated_at DESC, id DESC`,
    [sub, cid],
  );
  const subs = new Set(r.rows.map((x) => String(x.fields['Submission ID'] ?? '')).filter(Boolean));
  if (!r.rows.length || !subs.size) throw new PayNoteError('log_not_found', `No log carries ${sub ? `Submission ID ${sub}` : `Codex Entry ID ${cid}`}.`, 404);
  if (subs.size > 1) throw new PayNoteError('ambiguous_log', `${cid} matches more than one submission (${[...subs].join(', ')}). Name the submission_id.`, 409);
  const f = r.rows[0].fields;
  const when = pick(f.Timestamp) || pick(f['Processed At']);
  const month = /^\d{4}-\d{2}/.test(when) ? new Date(when).toISOString().slice(0, 7) : null;
  return {
    submission_id: [...subs][0],
    codex_entry_id: pick(f['Codex Entry ID']) || null,
    builder_slack_id: pick(f['Builder User ID']) || null,
    builder: pick(f['Builder Name']) || null,
    month,
    status: pick(f['Jason Status']),
    fields: f,
  };
}

export async function get(ref: { submission_id?: string; codex_entry_id?: string }, db: Queryable = { query } as Queryable): Promise<PayNote | null> {
  const log = await findLog(db, ref);
  const r = await db.query<Obj>(`SELECT ${COLS} FROM engine_pay_notes WHERE submission_id = $1`, [log.submission_id]);
  return r.rows[0] ? shape({ ...r.rows[0], codex_entry_id: r.rows[0].codex_entry_id ?? log.codex_entry_id }) : null;
}

/** What a pay choice resolves to, before anything is written. Pure, so it can be tested. */
export function resolve(b: Obj): { recommendation: Recommendation; credited: number; held: number } {
  const rec = s(b.pay_recommendation, 40).toLowerCase().replace(/^custom$/, 'custom_fraction') as Recommendation;
  if (!RECOMMENDATIONS.includes(rec)) throw new PayNoteError('bad_recommendation', `pay_recommendation must be one of ${RECOMMENDATIONS.join(', ')}.`);
  const rest = s(b.rest, 10).toLowerCase() || 'hold';
  if (rest !== 'hold' && rest !== 'dock') throw new PayNoteError('bad_rest', 'rest must be "hold" (held until the release condition is met) or "dock" (never paid).');
  const num = (v: unknown, name: string): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new PayNoteError('bad_share', `${name} must be a share of a day between 0 and 1 (for example 0.25), not "${String(v)}".`);
    return round3(n);
  };
  if (rec === 'full') return { recommendation: rec, credited: 1, held: 0 };
  if (rec === 'half') return { recommendation: rec, credited: 0.5, held: rest === 'hold' ? 0.5 : 0 };
  if (rec === 'none') return { recommendation: rec, credited: 0, held: rest === 'hold' ? 1 : 0 };
  const credited = num(b.credited_share, 'credited_share');
  if (credited === null) throw new PayNoteError('missing_share', 'custom_fraction needs credited_share: the share of a day credited now.');
  const heldIn = num(b.held_share, 'held_share');
  const held = heldIn ?? (rest === 'hold' ? round3(1 - credited) : 0);
  if (credited + held > 1.0005) throw new PayNoteError('bad_share', `credited_share ${credited} and held_share ${held} add up to more than a day.`);
  return { recommendation: rec, credited, held };
}

const VIA = ['slack_approve', 'dashboard_approve', 'mcp', 'engine'] as const;

/**
 * Sets the pay note on one approved log, or corrects it. The first decision is a set; any later one
 * is a correction, needs correction_note, and may not raise credited + held above what the log had
 * (a dock stays docked). Released shares are never touched here: a release is its own act.
 */
export async function set(b: Obj, opts: { dry_run?: boolean } = {}): Promise<{ written: boolean; dry_run: boolean; action: 'set' | 'correct' | 'unchanged'; note: PayNote; message: string }> {
  const by = s(b.decided_by, 40);
  if (!DECIDERS[by]) throw new PayNoteError('not_permitted', `Only Destiny or Jason set a pay note (decided_by is their Slack id); ${by || 'nobody'} was given.`, 403);
  const via = (s(b.via, 40) || 'engine') as (typeof VIA)[number];
  if (!VIA.includes(via)) throw new PayNoteError('bad_via', `via must be one of ${VIA.join(', ')}.`);
  const { recommendation, credited, held } = resolve(b);
  const tag = s(b.reason_tag, 40).toUpperCase() || null;
  const note = s(b.reason_note, 600) || null;
  const condition = s(b.release_condition, 600) || null;
  const docked = round3(1 - credited - held);
  if (tag && !(REASON_TAGS as readonly string[]).includes(tag)) throw new PayNoteError('bad_reason_tag', `reason_tag must be one of ${REASON_TAGS.join(', ')}.`);
  if (recommendation !== 'full' && !tag) throw new PayNoteError('missing_reason_tag', `Anything less than full needs a reason_tag (${REASON_TAGS.join(', ')}).`);
  if (held > 0 && (!condition || condition.length < 8)) throw new PayNoteError('missing_release_condition', 'A held share needs a release_condition: what has to happen, in plain words, for it to be paid.');
  if (docked > 0 && (!note || note.length < 3)) throw new PayNoteError('missing_reason_note', 'A docked share is never paid, so it needs a reason_note saying why.');
  if (tag === 'OTHER' && (!note || note.length < 3)) throw new PayNoteError('missing_reason_note', 'reason_tag OTHER needs a reason_note.');

  const run = async (db: Queryable) => {
    const log = await findLog(db, { submission_id: s(b.submission_id, 200), codex_entry_id: s(b.codex_entry_id, 200) });
    if (log.status !== 'Approved' && log.status !== 'Input Added') {
      throw new PayNoteError('not_approved', `${log.codex_entry_id ?? log.submission_id} is "${log.status || 'not reviewed'}", not approved: a pay note belongs to an approval.`);
    }
    // LogStream (9 Nov 2026): a re-log is credited only for the new work it states, so any credit on
    // one has to say what the credit is for. The suggestion the review made is kept beside the decision.
    // The suggestion's own class wins where it has one (10 Nov 2026): a continuation whose every part is
    // new is treated as new work there, so it is not a re-log here either.
    const sugClass = paySuggest.fromRow(log.fields)?.log_class;
    const rawClass = typeof sugClass === 'string' && sugClass ? sugClass : pick(log.fields['Log Class']);
    const logClass = rawClass === 'RELOG_OLD_WORK' ? 'RELOG_OLD_WORK' : rawClass === 'fresh_build' ? 'fresh_build' : null;
    const relogOf = pick(log.fields['Relog Of']).slice(0, 300) || null;
    if (logClass === 'RELOG_OLD_WORK' && credited > 0 && (!note || note.length < 8)) {
      throw new PayNoteError('relog_needs_delta', `${log.codex_entry_id ?? log.submission_id} is a re-log${relogOf ? ` of ${relogOf}` : ''}. It is credited only for the new work it states, so a credit on it needs a reason_note saying what the credit is for.`);
    }
    const suggested = paySuggest.fromRow(log.fields);
    const before = (await db.query<Obj>(`SELECT ${COLS} FROM engine_pay_notes WHERE submission_id = $1 FOR UPDATE`, [log.submission_id])).rows[0];
    const prior = before ? shape(before) : null;
    const correction = s(b.correction_note, 600) || null;
    if (prior) {
      const same = prior.pay_recommendation === recommendation && prior.credited_share === credited && prior.held_share === held && prior.reason_tag === tag && prior.reason_note === note && prior.release_condition === condition;
      if (same) return { action: 'unchanged' as const, note: prior };
      if (!correction || correction.length < 8) throw new PayNoteError('correction_needs_note', `${log.codex_entry_id ?? log.submission_id} already has a pay note (${prior.pay_recommendation}, ${prior.credited_share} credited, ${prior.held_share} held, decided by ${prior.decided_by_name ?? prior.decided_by} ${prior.decided_at}). Changing it is a correction: give correction_note saying why.`);
      if (prior.released_share > 0) throw new PayNoteError('already_released', 'A held share on this log was already released and paid. It cannot be re-decided; correct forward on a new log.');
      if (round3(credited + held) > round3(prior.credited_share + prior.held_share)) {
        throw new PayNoteError('dock_stays_docked', `This log was docked ${pct(prior.docked_share)} of a day by ${prior.decided_by_name ?? prior.decided_by}. A dock stays docked: credited + held cannot go above ${pct(prior.credited_share + prior.held_share)}.`);
      }
    }
    await db.query(
      `INSERT INTO engine_pay_notes (submission_id, codex_entry_id, builder_slack_id, builder, session_month, pay_recommendation, credited_share, held_share,
                                     reason_tag, reason_note, release_condition, decided_by, decided_at, updated_at, suggested, log_class, relog_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now(), $13, $14, $15)
       ON CONFLICT (submission_id) DO UPDATE SET codex_entry_id = EXCLUDED.codex_entry_id, builder_slack_id = EXCLUDED.builder_slack_id, builder = EXCLUDED.builder,
         session_month = EXCLUDED.session_month, pay_recommendation = EXCLUDED.pay_recommendation, credited_share = EXCLUDED.credited_share,
         held_share = EXCLUDED.held_share, reason_tag = EXCLUDED.reason_tag, reason_note = EXCLUDED.reason_note,
         release_condition = EXCLUDED.release_condition, decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now(),
         suggested = coalesce(engine_pay_notes.suggested, EXCLUDED.suggested), log_class = EXCLUDED.log_class, relog_of = EXCLUDED.relog_of`,
      [log.submission_id, log.codex_entry_id, log.builder_slack_id, log.builder, log.month, recommendation, credited, held, tag, note, held > 0 ? condition : null, by, suggested ? JSON.stringify(suggested) : null, logClass, relogOf],
    );
    const after = shape((await db.query<Obj>(`SELECT ${COLS} FROM engine_pay_notes WHERE submission_id = $1`, [log.submission_id])).rows[0]);
    const action = prior ? ('correct' as const) : ('set' as const);
    await db.query(
      `INSERT INTO engine_pay_note_history (submission_id, codex_entry_id, action, before, after, by_slack_id, via, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [log.submission_id, log.codex_entry_id, action, prior ? JSON.stringify(prior) : null, JSON.stringify(after), by, via, correction],
    );
    await mirrorToLedger(db, after);
    await engineEvents.record({ event_type: 'pay_note_set', subject_id: log.codex_entry_id ?? log.submission_id, actor: DECIDERS[by], detail: { action, recommendation, credited, held, docked: after.docked_share, reason_tag: tag, via } }, db);
    return { action, note: after };
  };

  const label = (n: PayNote) => `${n.codex_entry_id ?? n.submission_id}: ${n.pay_recommendation}, ${n.credited_share} credited, ${n.held_share} held${n.docked_share > 0 ? `, ${n.docked_share} docked` : ''}`;
  if (opts.dry_run) {
    try {
      await withTransaction(async (db) => {
        const r = await run(db);
        throw new DryRun(r);
      });
    } catch (e) {
      if (e instanceof DryRun) return { written: false, dry_run: true, action: e.r.action, note: e.r.note, message: `Dry run, nothing written. Would ${e.r.action}: ${label(e.r.note)}.` };
      throw e;
    }
  }
  const r = await withTransaction(run);
  return { written: r.action !== 'unchanged', dry_run: false, action: r.action, note: r.note, message: r.action === 'unchanged' ? `No change: ${label(r.note)} already.` : `${r.action === 'set' ? 'Set' : 'Corrected'}: ${label(r.note)}.` };
}

class DryRun extends Error {
  constructor(public r: { action: 'set' | 'correct' | 'unchanged'; note: PayNote }) {
    super('dry run');
  }
}

/**
 * Releases a log's held share once its condition is met. Destiny or Jason, with a proof link. The
 * whole held share moves to released_share and is paid in the month of the release.
 */
export async function release(b: Obj, opts: { dry_run?: boolean } = {}): Promise<{ written: boolean; dry_run: boolean; note: PayNote; message: string }> {
  const by = s(b.released_by, 40);
  if (!DECIDERS[by]) throw new PayNoteError('not_permitted', `Only Destiny or Jason release a held share (released_by is their Slack id); ${by || 'nobody'} was given.`, 403);
  const proof = s(b.proof_link, 500);
  if (!/^https:\/\/\S+$/.test(proof)) throw new PayNoteError('missing_proof', 'A release needs proof_link: the https link that shows the release condition was met (the PR, the engine event, the Slack message).');
  const via = s(b.via, 40) || 'engine';
  const run = async (db: Queryable) => {
    const log = await findLog(db, { submission_id: s(b.submission_id, 200), codex_entry_id: s(b.codex_entry_id, 200) });
    const row = (await db.query<Obj>(`SELECT ${COLS} FROM engine_pay_notes WHERE submission_id = $1 FOR UPDATE`, [log.submission_id])).rows[0];
    if (!row) throw new PayNoteError('no_pay_note', `${log.codex_entry_id ?? log.submission_id} has no pay note, so nothing is held.`, 404);
    const prior = shape(row);
    if (prior.held_share <= 0) throw new PayNoteError('nothing_held', `${log.codex_entry_id ?? log.submission_id} holds nothing (${prior.credited_share} credited${prior.docked_share > 0 ? `, ${prior.docked_share} docked, which is never released` : ''}).`);
    await db.query(
      `UPDATE engine_pay_notes SET released_share = released_share + held_share, held_share = 0, released_by = $2, released_at = now(),
              release_month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), proof_link = $3, updated_at = now() WHERE submission_id = $1`,
      [log.submission_id, by, proof],
    );
    const after = shape((await db.query<Obj>(`SELECT ${COLS} FROM engine_pay_notes WHERE submission_id = $1`, [log.submission_id])).rows[0]);
    await db.query(
      `INSERT INTO engine_pay_note_history (submission_id, codex_entry_id, action, before, after, by_slack_id, via, note) VALUES ($1,$2,'release',$3,$4,$5,$6,$7)`,
      [log.submission_id, after.codex_entry_id, JSON.stringify(prior), JSON.stringify(after), by, via, s(b.note, 600) || null],
    );
    await mirrorToLedger(db, after);
    await engineEvents.record({ event_type: 'pay_note_released', subject_id: after.codex_entry_id ?? log.submission_id, actor: DECIDERS[by], detail: { released: after.released_share, proof_link: proof, release_month: after.release_month } }, db);
    return after;
  };
  const msg = (n: PayNote) => `${n.codex_entry_id ?? n.submission_id}: ${pct(n.released_share)} of a day released for ${n.release_month ?? 'this month'}, on ${proof}.`;
  if (opts.dry_run) {
    try {
      await withTransaction(async (db) => {
        throw new DryRun({ action: 'unchanged', note: await run(db) });
      });
    } catch (e) {
      if (e instanceof DryRun) return { written: false, dry_run: true, note: e.r.note, message: `Dry run, nothing written. Would release: ${msg(e.r.note)}` };
      throw e;
    }
  }
  const n = await withTransaction(run);
  return { written: true, dry_run: false, note: n, message: `Released. ${msg(n)}` };
}

/**
 * Releases several logs on one proof (10 Nov 2026, Destiny, after Kaiqi asked whether every held log
 * would need its own release). One merged change or one engine event often meets the condition on
 * several logs; each is still released by `release` on its own, with its own history line and event,
 * so one that cannot be released (nothing held, no pay note) is named and never stops the others.
 */
export async function releaseMany(b: Obj, opts: { dry_run?: boolean } = {}): Promise<{ written: boolean; dry_run: boolean; released: number; failed: number; results: { ref: string; ok: boolean; message: string; reason?: string }[]; message: string }> {
  const raw = Array.isArray(b.submission_ids) ? b.submission_ids : Array.isArray(b.codex_entry_ids) ? b.codex_entry_ids : [];
  const byCodex = !Array.isArray(b.submission_ids) && Array.isArray(b.codex_entry_ids);
  const refs = [...new Set(raw.map((x) => s(x, 200)).filter(Boolean))];
  if (!refs.length) throw new PayNoteError('nothing_named', 'Name the logs to release: submission_ids (or codex_entry_ids), at least one.');
  if (refs.length > 50) throw new PayNoteError('too_many', `At most 50 logs a release; ${refs.length} were named.`);
  const results: { ref: string; ok: boolean; message: string; reason?: string }[] = [];
  for (const ref of refs) {
    try {
      const r = await release({ ...b, submission_id: byCodex ? '' : ref, codex_entry_id: byCodex ? ref : '' }, opts);
      results.push({ ref, ok: true, message: r.message });
    } catch (e) {
      if (!(e instanceof PayNoteError)) throw e;
      results.push({ ref, ok: false, reason: e.reason, message: e.message });
    }
  }
  const released = results.filter((r) => r.ok).length;
  const failed = results.length - released;
  return {
    written: !opts.dry_run && released > 0,
    dry_run: !!opts.dry_run,
    released,
    failed,
    results,
    message: `${opts.dry_run ? 'Dry run: would release' : 'Released'} ${released} of ${results.length}${failed ? `; ${failed} not released (${results.filter((r) => !r.ok).map((r) => `${r.ref}: ${r.reason}`).join('; ')})` : ''}.`,
  };
}

/** The pay note's figures, laid onto every pay-ledger copy of the session, so Pay Tracker reads one place. */
export function ledgerFields(n: PayNote | null): Obj {
  if (!n) return {};
  return {
    'Pay Recommendation': n.pay_recommendation,
    'Credited Share': n.credited_share,
    'Held Share': n.held_share,
    'Released Share': n.released_share,
    'Docked Share': n.docked_share,
    'Pay Reason Tag': n.reason_tag,
    'Pay Reason Note': n.reason_note,
    'Pay Release Condition': n.release_condition,
    'Pay Decided By': n.decided_by_name ?? n.decided_by,
    'Pay Decided At': n.decided_at,
    'Pay Released At': n.released_at,
    'Pay Release Month': n.release_month,
    'Pay Proof Link': n.proof_link,
  };
}

async function mirrorToLedger(db: Queryable, n: PayNote): Promise<void> {
  if (!n.codex_entry_id) return;
  const r = await db.query<{ id: string }>(
    `UPDATE engine_pay_sessions SET fields = fields || $2::jsonb, source = 'engine', updated_at = now() WHERE natural_id = $1 RETURNING id::text`,
    [n.codex_entry_id, JSON.stringify(ledgerFields(n))],
  );
  for (const row of r.rows) events.changed('pay_sessions', Number(row.id), db);
}

/** For paySync: the note for a Codex Entry ID, if any, read inside the caller's transaction. */
export async function forEntry(db: Queryable, codexEntryId: string): Promise<PayNote | null> {
  const r = await db.query<Obj>(
    `SELECT ${COLS} FROM engine_pay_notes n WHERE n.codex_entry_id = $1
        OR n.submission_id IN (SELECT fields->>'Submission ID' FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1)
      ORDER BY n.updated_at DESC LIMIT 1`,
    [codexEntryId],
  );
  return r.rows[0] ? shape(r.rows[0]) : null;
}

/* ------------------------------------------------------------- reads */

export async function history(ref: { submission_id?: string; codex_entry_id?: string }): Promise<Obj[]> {
  const log = await findLog({ query } as Queryable, ref);
  const r = await query<Obj>(
    `SELECT id::text, action, before, after, by_slack_id, via, note, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM engine_pay_note_history WHERE submission_id = $1 ORDER BY id`,
    [log.submission_id],
  );
  return r.rows.map((x) => ({ ...x, by: DECIDERS[String(x.by_slack_id)] ?? x.by_slack_id }));
}

/** Every share still held, oldest first: the Held list. */
export async function held(): Promise<PayNote[]> {
  const r = await query<Obj>(`SELECT ${COLS} FROM engine_pay_notes WHERE held_share > 0 ORDER BY decided_at`);
  return r.rows.map(shape);
}

export async function all(): Promise<PayNote[]> {
  const r = await query<Obj>(`SELECT ${COLS} FROM engine_pay_notes ORDER BY decided_at DESC`);
  return r.rows.map(shape);
}

export interface StatementLine {
  codex_entry_id: string;
  session_date: string | null;
  credited_share: number;
  pay_recommendation: string;
  reason_tag: string | null;
  docked_share: number;
  codex_link: string | null;
}

export interface StatementFacts {
  builder_slack_id: string;
  builder: string;
  pay_mode: string;
  month: string;
  session_count: number;
  working_days: number;
  credited_shares: number;
  released_shares: number;
  total_shares: number;
  sessions: StatementLine[];
  released: { codex_entry_id: string; session_month: string | null; released_share: number; proof_link: string | null; released_by: string | null }[];
  still_held: { codex_entry_id: string; session_month: string | null; held_share: number; reason_tag: string | null; reason_note: string | null; release_condition: string | null }[];
}

/**
 * One statement's facts per builder for a month (Jason: derived purely from credited and held shares
 * plus release decisions and proof links): the month's sessions with their credited share (a log
 * with no note counts as full), the shares released in that month, and everything still held.
 */
export async function statementFacts(b: Obj): Promise<{ month: string; pay_mode: string; statements: StatementFacts[] }> {
  const month = s(b.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new PayNoteError('bad_month', 'month must be YYYY-MM.');
  const mode = s(b.pay_mode, 20) || 'Monthly';
  const sessions = await query<{ fields: Obj }>(
    `SELECT DISTINCT ON (natural_id) fields FROM engine_pay_sessions WHERE fields->>'Month' = $1 AND fields->>'Pay Mode' = $2 ORDER BY natural_id, updated_at DESC`,
    [month, mode],
  );
  const notes = await all();
  const byEntry = new Map(notes.filter((n) => n.codex_entry_id).map((n) => [n.codex_entry_id as string, n]));
  const out = new Map<string, StatementFacts>();
  const ensure = (id: string, name: string): StatementFacts => {
    if (!out.has(id)) out.set(id, { builder_slack_id: id, builder: name, pay_mode: mode, month, session_count: 0, working_days: 0, credited_shares: 0, released_shares: 0, total_shares: 0, sessions: [], released: [], still_held: [] });
    return out.get(id)!;
  };
  for (const { fields: f } of sessions.rows) {
    const id = String(f['Builder Slack ID'] ?? '') || 'unknown';
    const st = ensure(id, String(f.Builder ?? 'Unknown builder'));
    const entry = String(f['Codex Entry ID'] ?? '');
    const n = byEntry.get(entry) ?? null;
    st.sessions.push({
      codex_entry_id: entry,
      session_date: (f['Session Date'] as string) ?? null,
      credited_share: n ? n.credited_share : 1,
      pay_recommendation: n ? n.pay_recommendation : 'full',
      reason_tag: n?.reason_tag ?? null,
      docked_share: n ? n.docked_share : 0,
      codex_link: (f['Codex Link'] as string) ?? null,
    });
  }
  const modeOf = new Map<string, string>();
  for (const r of (await query<{ k: string; m: string }>(`SELECT DISTINCT ON (fields->>'Builder Slack ID') fields->>'Builder Slack ID' AS k, fields->>'Pay Mode' AS m FROM engine_pay_sessions ORDER BY fields->>'Builder Slack ID', updated_at DESC`)).rows) modeOf.set(r.k, r.m);
  for (const n of notes) {
    const id = n.builder_slack_id ?? 'unknown';
    if ((modeOf.get(id) ?? 'Daily') !== mode) continue;
    if (n.release_month === month && n.released_share > 0) ensure(id, n.builder ?? 'Unknown builder').released.push({ codex_entry_id: n.codex_entry_id ?? n.submission_id, session_month: n.session_month, released_share: n.released_share, proof_link: n.proof_link, released_by: n.released_by ? (DECIDERS[n.released_by] ?? n.released_by) : null });
    if (n.held_share > 0 && (n.session_month ?? '') <= month) ensure(id, n.builder ?? 'Unknown builder').still_held.push({ codex_entry_id: n.codex_entry_id ?? n.submission_id, session_month: n.session_month, held_share: n.held_share, reason_tag: n.reason_tag, reason_note: n.reason_note, release_condition: n.release_condition });
  }
  for (const st of out.values()) {
    st.sessions.sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)));
    st.session_count = st.sessions.length;
    st.working_days = new Set(st.sessions.map((x) => String(x.session_date ?? '').slice(0, 10)).filter(Boolean)).size;
    st.credited_shares = round3(st.sessions.reduce((a, x) => a + x.credited_share, 0));
    st.released_shares = round3(st.released.reduce((a, x) => a + x.released_share, 0));
    st.total_shares = round3(st.credited_shares + st.released_shares);
  }
  return { month, pay_mode: mode, statements: [...out.values()].sort((a, b) => a.builder.localeCompare(b.builder)) };
}
