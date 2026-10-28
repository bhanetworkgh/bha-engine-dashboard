/**
 * Code checks: Destiny's second review of approved builder logs (28 Oct 2026, Destiny — Jason's yes in
 * DM D0AF0DG8ZPY, thread 1793181986.036119; starts 1 Nov 2026).
 *
 * Jason's review and Bays' read the Codex, so they can only judge what a builder said. A code check judges
 * what is live (GitHub, Render, n8n, Twilio, the dashboard, BHARAG, vFarm) and makes a pay call. Jason asked
 * for three things to come out of November: a discrepancy catalog (every check that found a log overstated),
 * per-lane definition of done checklists tightened from it, and a v2 spec for Bays or Genie to run the first
 * tier of these checks automatically. This file holds both halves:
 *
 *   engine_code_checks   one row per Codex entry checked, in the format Jason confirmed (verdict, each claim
 *                        against where it was checked and the proof, what is missing, what could not be
 *                        checked, the pay call and its follow-ups). The catalog is read from these rows, never
 *                        kept by hand: every check marked partly or overstated is in it.
 *   engine_audit_outputs the deliverables Jason asked for, each with its state and its link.
 *
 * What is waiting comes from the pay ledger (engine_pay_sessions): a session approved on or after 1 Nov with
 * no check yet. Jason asked for checks within 24 to 48 hours of his approval, so a session past 48 hours is
 * shown as late, and a session with no approval time is shown as such rather than as on time.
 *
 * Destiny's own sessions are not waiting on a check: he is the one checking, and a check of his own log by
 * himself would prove nothing. They are counted apart and named.
 */
import { query, withTransaction } from './pg';
import { record } from './engineEvents';
import { changed } from './events';
import { parseLink } from './chargeGate';

export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';
/** Who may record a check or an output: the reviewer, and Jason. */
export const RECORDERS: ReadonlySet<string> = new Set([DESTINY, JASON]);

/** Lagos midnight, 1 Nov 2026: the first approval that is owed a check. */
export const START = '2026-11-01T00:00:00+01:00';
/** Jason's window, approval to check (24 to 48 hours; late past the outer edge). */
export const WINDOW_HOURS = 48;

export const VERDICTS = ['matches', 'partly', 'overstated'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABEL: Record<Verdict, string> = { matches: 'Matches the log', partly: 'Partly matches', overstated: 'Overstated' };
export const RESULTS = ['confirmed', 'partly', 'not_found'] as const;
export type ClaimResult = (typeof RESULTS)[number];
export const PAY_CALLS = ['as_logged', 'partly', 'hold'] as const;
export type PayCall = (typeof PAY_CALLS)[number];
export const PAY_LABEL: Record<PayCall, string> = { as_logged: 'Pay as logged', partly: 'Pay partly', hold: 'Hold' };
/** The readiness items Jason confirmed, in his order. "missing" names only these. */
export const MISSING = ['tested_for_real', 'deployed_and_live', 'failures_raised', 'monitored', 'written_down'] as const;
export type Missing = (typeof MISSING)[number];
export const MISSING_LABEL: Record<Missing, string> = {
  tested_for_real: 'Tested for real',
  deployed_and_live: 'Deployed and live',
  failures_raised: 'Failures raised, not silent',
  monitored: 'Monitored',
  written_down: 'Written down so someone else could run it',
};

export const OUTPUT_KINDS = ['catalog', 'dod_checklist', 'v2_spec'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];
export const OUTPUT_STATUSES = ['not_started', 'drafting', 'ready_for_jason', 'accepted'] as const;
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];
export const OUTPUT_STATUS_LABEL: Record<OutputStatus, string> = { not_started: 'Not started', drafting: 'Drafting', ready_for_jason: 'With Jason', accepted: 'Accepted by Jason' };

const CODEX_ID = /^CODEX-\d{8}-[a-z0-9-]{3,160}$/;
const OUTPUT_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const LOOP_ID = /^LOOP-\d{10,16}-[A-Z0-9]{4}$/;

export class CodeCheckError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

export interface Claim {
  claim: string;
  where: string;
  result: ClaimResult;
  proof: string;
}

export interface FollowUp {
  what: string;
  who: string;
  by: string;
  loop_id: string | null;
}

export interface CodeCheck {
  codex_entry_id: string;
  builder_slack_id: string | null;
  builder_name: string | null;
  session_date: string | null;
  approved_at: string | null;
  posted_at: string;
  check_link: string;
  verdict: Verdict;
  verdict_reason: string;
  claims: Claim[];
  missing: Missing[];
  couldnt_check: string | null;
  pay_call: PayCall;
  follow_ups: FollowUp[];
  recorded_by: string;
  created_at: string;
  updated_at: string;
  /** Hours from Jason's approval to the check being posted; null with no approval time. */
  hours_to_check: number | null;
}

export interface AuditOutput {
  output_id: string;
  kind: OutputKind;
  lane: string | null;
  title: string;
  status: OutputStatus;
  due: string | null;
  link: string | null;
  note: string | null;
  sort: number;
  updated_by: string;
  updated_at: string;
}

/** An approved session as the pay ledger holds it, cut to what this file needs. */
export interface Approval {
  codex_entry_id: string | null;
  builder: string | null;
  builder_slack_id: string | null;
  session_date: string | null;
  approved_at: string | null;
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const hoursBetween = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const h = (Date.parse(b) - Date.parse(a)) / 3_600_000;
  return Number.isFinite(h) ? Math.round(h * 10) / 10 : null;
};

// ─── Validation, pure ────────────────────────────────────────────────────────

export interface CheckInput {
  codex_entry_id?: unknown;
  check_link?: unknown;
  posted_at?: unknown;
  verdict?: unknown;
  verdict_reason?: unknown;
  claims?: unknown;
  missing?: unknown;
  couldnt_check?: unknown;
  pay_call?: unknown;
  follow_ups?: unknown;
  requester_user_id?: unknown;
}

export interface CleanCheck {
  codex_entry_id: string;
  check_link: string;
  posted_at: string | null;
  verdict: Verdict;
  verdict_reason: string;
  claims: Claim[];
  missing: Missing[];
  couldnt_check: string | null;
  pay_call: PayCall;
  follow_ups: FollowUp[];
  requester: string;
}

/**
 * Checks one code check against the format Jason confirmed. Every refusal names the rule. Pure.
 *   - a verdict and one line on why;
 *   - at least one claim, each with where it was checked, the result and the proof;
 *   - "Matches the log" cannot carry a claim that was not found, and "Overstated" needs at least one claim
 *     that was not confirmed (otherwise the verdict and the claims say different things);
 *   - pay partly or hold names every follow-up: what, who, by when, and its loop when there is one;
 *   - pay as logged on an overstated log is refused: Jason's rule is a pay call that follows the finding.
 */
export function cleanCheck(i: CheckInput): CleanCheck {
  const requester = text(i.requester_user_id, 40);
  if (!RECORDERS.has(requester)) throw new CodeCheckError('not_permitted', 'Only Destiny (who runs the code check) or Jason may record one.');
  const codex_entry_id = text(i.codex_entry_id, 200);
  if (!CODEX_ID.test(codex_entry_id)) throw new CodeCheckError('bad_codex_id', 'codex_entry_id is the log\'s Codex ID, e.g. CODEX-20261101-hardik-bhatt-media-twin.');
  const check_link = text(i.check_link, 400);
  if (!parseLink(check_link)) throw new CodeCheckError('bad_check_link', 'check_link is the Slack link to the check as posted in the log\'s own thread.');
  const posted_at = i.posted_at == null || i.posted_at === '' ? null : iso(i.posted_at);
  if (i.posted_at != null && i.posted_at !== '' && !posted_at) throw new CodeCheckError('bad_posted_at', 'posted_at is an ISO time, or left out for now.');
  const verdict = text(i.verdict, 20) as Verdict;
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new CodeCheckError('bad_verdict', `verdict is one of ${VERDICTS.join(', ')}.`);
  const verdict_reason = text(i.verdict_reason, 400);
  if (!verdict_reason) throw new CodeCheckError('reason_required', 'verdict_reason is the one line on why.');
  if (!Array.isArray(i.claims) || !i.claims.length) throw new CodeCheckError('claims_required', 'A check names at least one claim from the log, where it was checked, the result and the proof.');
  if (i.claims.length > 40) throw new CodeCheckError('too_many_claims', 'At most 40 claims on one check.');
  const claims: Claim[] = i.claims.map((c, n) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const claim = text(o.claim, 600);
    const where = text(o.where, 300);
    const result = text(o.result, 20) as ClaimResult;
    const proof = text(o.proof, 800);
    if (!claim) throw new CodeCheckError('bad_claim', `Claim ${n + 1}: say what the log claims.`);
    if (!where) throw new CodeCheckError('bad_claim', `Claim ${n + 1}: say where it was checked (GitHub, Render, Twilio, dashboard, BHARAG, vFarm, n8n...).`);
    if (!(RESULTS as readonly string[]).includes(result)) throw new CodeCheckError('bad_claim', `Claim ${n + 1}: result is one of ${RESULTS.join(', ')}.`);
    if (!proof) throw new CodeCheckError('bad_claim', `Claim ${n + 1}: give the proof (a commit, a run, a deploy, a record id), or what was looked for and not found.`);
    return { claim, where, result, proof };
  });
  const missingIn = i.missing == null ? [] : i.missing;
  if (!Array.isArray(missingIn)) throw new CodeCheckError('bad_missing', `missing is a list of ${MISSING.join(', ')}.`);
  const missing = [...new Set(missingIn.map((m) => text(m, 40)))] as Missing[];
  for (const m of missing) if (!(MISSING as readonly string[]).includes(m)) throw new CodeCheckError('bad_missing', `"${m}" is not one of ${MISSING.join(', ')}.`);
  missing.sort((a, b) => MISSING.indexOf(a) - MISSING.indexOf(b));
  const couldnt_check = text(i.couldnt_check, 1500) || null;
  const pay_call = text(i.pay_call, 20) as PayCall;
  if (!(PAY_CALLS as readonly string[]).includes(pay_call)) throw new CodeCheckError('bad_pay_call', `pay_call is one of ${PAY_CALLS.join(', ')}.`);
  const fIn = i.follow_ups == null ? [] : i.follow_ups;
  if (!Array.isArray(fIn) || fIn.length > 20) throw new CodeCheckError('bad_follow_ups', 'follow_ups is a list of at most 20 {what, who, by, loop_id}.');
  const follow_ups: FollowUp[] = fIn.map((f, n) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const what = text(o.what, 400);
    const who = text(o.who, 80);
    const by = text(o.by, 40);
    const loop_id = text(o.loop_id, 40) || null;
    if (!what || !who || !by) throw new CodeCheckError('bad_follow_ups', `Follow-up ${n + 1}: name what, who and by when.`);
    if (loop_id && !LOOP_ID.test(loop_id)) throw new CodeCheckError('bad_follow_ups', `Follow-up ${n + 1}: "${loop_id}" is not a loop id (LOOP-<digits>-<4 characters>).`);
    return { what, who, by, loop_id };
  });

  const notFound = claims.filter((c) => c.result === 'not_found').length;
  const notConfirmed = claims.filter((c) => c.result !== 'confirmed').length;
  if (verdict === 'matches' && notFound) throw new CodeCheckError('verdict_disagrees', `"Matches the log" with ${notFound} claim(s) not found: the verdict and the claims say different things.`);
  if (verdict !== 'matches' && !notConfirmed) throw new CodeCheckError('verdict_disagrees', `"${VERDICT_LABEL[verdict]}" with every claim confirmed: name the claim that was not.`);
  if (pay_call !== 'as_logged' && !follow_ups.length) throw new CodeCheckError('follow_ups_required', `${PAY_LABEL[pay_call]} names each follow-up: what, who, by when, and its loop.`);
  if (verdict === 'overstated' && pay_call === 'as_logged') throw new CodeCheckError('pay_disagrees', 'An overstated log is not paid as logged: pay partly with the follow-ups named, or hold.');
  return { codex_entry_id, check_link, posted_at, verdict, verdict_reason, claims, missing, couldnt_check, pay_call, follow_ups, requester };
}

export interface OutputInput {
  output_id?: unknown;
  kind?: unknown;
  lane?: unknown;
  title?: unknown;
  status?: unknown;
  due?: unknown;
  link?: unknown;
  note?: unknown;
  requester_user_id?: unknown;
}

// ─── Reading, pure ───────────────────────────────────────────────────────────

export interface Waiting {
  codex_entry_id: string | null;
  builder: string | null;
  builder_slack_id: string | null;
  session_date: string | null;
  approved_at: string | null;
  hours_waiting: number | null;
  late: boolean;
}

export interface Summary {
  start: string;
  window_hours: number;
  approved_since_start: number;
  own_sessions_excluded: number;
  waiting: Waiting[];
  checks: CodeCheck[];
  catalog: Array<CodeCheck & { not_confirmed: Claim[] }>;
  counts: {
    posted: number;
    waiting: number;
    late: number;
    no_approval_time: number;
    verdicts: Record<Verdict, number>;
    pay_calls: Record<PayCall, number>;
    within_window: number;
    timed: number;
  };
  hours_to_check: { n: number; p50: number | null; p95: number | null };
  notes: string[];
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Everything the tab and the read tool answer, from the approvals and the checks. Pure, so the rules can be
 * tested without a database. `now` is when the read happens.
 */
export function summarise(approvals: Approval[], checks: CodeCheck[], now: number): Summary {
  const startMs = Date.parse(START);
  const checkedIds = new Set(checks.map((c) => c.codex_entry_id));
  const inWindow = approvals.filter((a) => a.approved_at && Date.parse(a.approved_at) >= startMs);
  const own = inWindow.filter((a) => a.builder_slack_id === DESTINY);
  const owed = inWindow.filter((a) => a.builder_slack_id !== DESTINY);
  const waiting: Waiting[] = owed
    .filter((a) => !a.codex_entry_id || !checkedIds.has(a.codex_entry_id))
    .map((a) => {
      const h = hoursBetween(a.approved_at, new Date(now).toISOString());
      return { ...a, builder: a.builder, hours_waiting: h, late: h != null && h > WINDOW_HOURS };
    })
    .sort((x, y) => Date.parse(x.approved_at ?? '') - Date.parse(y.approved_at ?? ''));
  const sortedChecks = [...checks].sort((x, y) => Date.parse(y.posted_at) - Date.parse(x.posted_at));
  const verdicts = { matches: 0, partly: 0, overstated: 0 } as Record<Verdict, number>;
  const pay_calls = { as_logged: 0, partly: 0, hold: 0 } as Record<PayCall, number>;
  for (const c of checks) {
    verdicts[c.verdict]++;
    pay_calls[c.pay_call]++;
  }
  const timed = checks.map((c) => c.hours_to_check).filter((h): h is number => h != null).sort((a, b) => a - b);
  const notes: string[] = [];
  if (own.length) notes.push(`${own.length} of Destiny's own approved sessions are not waiting on a check: he is the one checking.`);
  const noTime = checks.filter((c) => c.approved_at == null).length;
  if (noTime) notes.push(`${noTime} check(s) have no approval time on the pay ledger, so they are left out of the time to check.`);
  if (!inWindow.length)
    notes.push(
      now < startMs
        ? 'Nothing is owed a check before 1 November: the first approval after midnight Lagos time is.'
        : 'No session approved since 1 November is on the pay ledger yet, so nothing is waiting. If Jason has approved one, the ledger has not received it, which is not the same as nothing waiting.',
    );
  return {
    start: START,
    window_hours: WINDOW_HOURS,
    approved_since_start: inWindow.length,
    own_sessions_excluded: own.length,
    waiting,
    checks: sortedChecks,
    catalog: sortedChecks.filter((c) => c.verdict !== 'matches').map((c) => ({ ...c, not_confirmed: c.claims.filter((x) => x.result !== 'confirmed') })),
    counts: {
      posted: checks.length,
      waiting: waiting.length,
      late: waiting.filter((w) => w.late).length,
      no_approval_time: noTime,
      verdicts,
      pay_calls,
      within_window: timed.filter((h) => h <= WINDOW_HOURS).length,
      timed: timed.length,
    },
    hours_to_check: { n: timed.length, p50: pct(timed, 50), p95: pct(timed, 95) },
    notes,
  };
}

// ─── The database halves ─────────────────────────────────────────────────────

function toCheck(r: Record<string, unknown>): CodeCheck {
  const approved_at = iso(r.approved_at);
  const posted_at = iso(r.posted_at) ?? '';
  return {
    codex_entry_id: String(r.codex_entry_id),
    builder_slack_id: (r.builder_slack_id as string) ?? null,
    builder_name: (r.builder_name as string) ?? null,
    session_date: (r.session_date as string) ?? null,
    approved_at,
    posted_at,
    check_link: String(r.check_link),
    verdict: r.verdict as Verdict,
    verdict_reason: String(r.verdict_reason),
    claims: Array.isArray(r.claims) ? (r.claims as Claim[]) : [],
    missing: Array.isArray(r.missing) ? (r.missing as Missing[]) : [],
    couldnt_check: (r.couldnt_check as string) ?? null,
    pay_call: r.pay_call as PayCall,
    follow_ups: Array.isArray(r.follow_ups) ? (r.follow_ups as FollowUp[]) : [],
    recorded_by: String(r.recorded_by),
    created_at: iso(r.created_at) ?? '',
    updated_at: iso(r.updated_at) ?? '',
    hours_to_check: hoursBetween(approved_at, posted_at),
  };
}

function toOutput(r: Record<string, unknown>): AuditOutput {
  return {
    output_id: String(r.output_id),
    kind: r.kind as OutputKind,
    lane: (r.lane as string) ?? null,
    title: String(r.title),
    status: r.status as OutputStatus,
    due: (r.due as string) ?? null,
    link: (r.link as string) ?? null,
    note: (r.note as string) ?? null,
    sort: Number(r.sort ?? 100),
    updated_by: String(r.updated_by),
    updated_at: iso(r.updated_at) ?? '',
  };
}

/** Approved sessions from the pay ledger, since the start. */
export async function approvals(): Promise<Approval[]> {
  const r = await query(
    `SELECT fields FROM engine_pay_sessions
      WHERE fields->>'Approved At' IS NOT NULL AND fields->>'Approved At' <> ''
        AND (fields->>'Approved At')::timestamptz >= $1::timestamptz`,
    [START],
  );
  return r.rows.map((row) => {
    const f = (row.fields ?? {}) as Record<string, unknown>;
    return {
      codex_entry_id: (f['Codex Entry ID'] as string) || null,
      builder: (f['Builder'] as string) || null,
      builder_slack_id: (f['Builder Slack ID'] as string) || null,
      session_date: (f['Session Date'] as string) || null,
      approved_at: iso(f['Approved At']),
    };
  });
}

export async function checks(): Promise<CodeCheck[]> {
  const r = await query(`SELECT * FROM engine_code_checks ORDER BY posted_at DESC`);
  return r.rows.map((x) => toCheck(x as Record<string, unknown>));
}

export async function outputs(): Promise<AuditOutput[]> {
  const r = await query(`SELECT * FROM engine_audit_outputs ORDER BY sort, output_id`);
  return r.rows.map((x) => toOutput(x as Record<string, unknown>));
}

/** The tab's route and the read tool's answer. */
export async function read(now = Date.now()): Promise<Summary & { outputs: AuditOutput[] }> {
  const [a, c, o] = await Promise.all([approvals(), checks(), outputs()]);
  return { ...summarise(a, c, now), outputs: o };
}

/**
 * Records one code check, or corrects one already recorded for the same Codex entry. The approval time,
 * builder and session date are taken from the pay ledger, never from the caller, so the time to check is
 * measured from Jason's real approval.
 */
export async function recordCheck(i: CheckInput, opts: { dry_run?: boolean } = {}): Promise<{ ok: true; written: boolean; corrected: boolean; check: CodeCheck; message: string }> {
  const c = cleanCheck(i);
  const ledger = await query(
    `SELECT fields FROM engine_pay_sessions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [c.codex_entry_id],
  );
  const f = (ledger.rows[0]?.fields ?? {}) as Record<string, unknown>;
  const approved_at = iso(f['Approved At']);
  const builder_slack_id = (f['Builder Slack ID'] as string) || null;
  if (builder_slack_id === DESTINY) throw new CodeCheckError('own_log', 'That is Destiny\'s own log. A code check is a second pair of eyes; his own logs are not checked by himself.');
  const posted_at = c.posted_at ?? new Date().toISOString();
  const prev = await query(`SELECT codex_entry_id FROM engine_code_checks WHERE codex_entry_id = $1`, [c.codex_entry_id]);
  const corrected = prev.rows.length > 0;
  const preview: CodeCheck = {
    codex_entry_id: c.codex_entry_id,
    builder_slack_id,
    builder_name: (f['Builder'] as string) || null,
    session_date: (f['Session Date'] as string) || null,
    approved_at,
    posted_at,
    check_link: c.check_link,
    verdict: c.verdict,
    verdict_reason: c.verdict_reason,
    claims: c.claims,
    missing: c.missing,
    couldnt_check: c.couldnt_check,
    pay_call: c.pay_call,
    follow_ups: c.follow_ups,
    recorded_by: c.requester,
    created_at: '',
    updated_at: '',
    hours_to_check: hoursBetween(approved_at, posted_at),
  };
  const head = `${c.codex_entry_id}: ${VERDICT_LABEL[c.verdict]}, ${PAY_LABEL[c.pay_call]}`;
  const ledgerNote = ledger.rows.length ? '' : ' The pay ledger has no session for this Codex ID, so the approval time and builder are not known and the time to check is not measured.';
  if (opts.dry_run) return { ok: true, written: false, corrected, check: preview, message: `Dry run: would ${corrected ? 'correct' : 'record'} ${head}.${ledgerNote} Nothing was written.` };
  return withTransaction(async (db) => {
    await db.query(
      `INSERT INTO engine_code_checks
         (codex_entry_id, builder_slack_id, builder_name, session_date, approved_at, posted_at, check_link, verdict, verdict_reason,
          claims, missing, couldnt_check, pay_call, follow_ups, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,$15)
       ON CONFLICT (codex_entry_id) DO UPDATE SET
         builder_slack_id=EXCLUDED.builder_slack_id, builder_name=EXCLUDED.builder_name, session_date=EXCLUDED.session_date,
         approved_at=EXCLUDED.approved_at, posted_at=EXCLUDED.posted_at, check_link=EXCLUDED.check_link, verdict=EXCLUDED.verdict,
         verdict_reason=EXCLUDED.verdict_reason, claims=EXCLUDED.claims, missing=EXCLUDED.missing, couldnt_check=EXCLUDED.couldnt_check,
         pay_call=EXCLUDED.pay_call, follow_ups=EXCLUDED.follow_ups, recorded_by=EXCLUDED.recorded_by, updated_at=now()`,
      [
        c.codex_entry_id, builder_slack_id, preview.builder_name, preview.session_date, approved_at, posted_at, c.check_link, c.verdict, c.verdict_reason,
        JSON.stringify(c.claims), JSON.stringify(c.missing), c.couldnt_check, c.pay_call, JSON.stringify(c.follow_ups), c.requester,
      ],
    );
    await record(
      {
        event_type: corrected ? 'code_check_corrected' : 'code_check_recorded',
        subject_id: c.codex_entry_id,
        lane: 'BAYS',
        actor: c.requester,
        source_ref: c.check_link,
        detail: {
          verdict: c.verdict, pay_call: c.pay_call, builder_slack_id, approved_at, posted_at,
          hours_to_check: preview.hours_to_check, claims: c.claims.length,
          not_confirmed: c.claims.filter((x) => x.result !== 'confirmed').length,
          follow_ups: c.follow_ups.map((x) => x.loop_id).filter(Boolean),
        },
      },
      db,
    );
    changed('code_checks', c.codex_entry_id, db);
    const r = await db.query(`SELECT * FROM engine_code_checks WHERE codex_entry_id = $1`, [c.codex_entry_id]);
    return { ok: true as const, written: true, corrected, check: toCheck(r.rows[0] as Record<string, unknown>), message: `${corrected ? 'Corrected' : 'Recorded'} ${head}.${ledgerNote}` };
  });
}

/** Creates or moves one of Jason's November outputs. Leaving a field out keeps it. */
export async function writeOutput(i: OutputInput, opts: { dry_run?: boolean } = {}): Promise<{ ok: true; written: boolean; created: boolean; output: AuditOutput; message: string }> {
  const who = text(i.requester_user_id, 40);
  if (!RECORDERS.has(who)) throw new CodeCheckError('not_permitted', 'Only Destiny or Jason may change a November output.');
  const output_id = text(i.output_id, 64);
  if (!OUTPUT_ID.test(output_id)) throw new CodeCheckError('bad_output_id', 'output_id is lower case letters, digits and hyphens, e.g. dod-vfarm-p1.');
  const cur = await query(`SELECT * FROM engine_audit_outputs WHERE output_id = $1`, [output_id]);
  const before = cur.rows[0] ? toOutput(cur.rows[0] as Record<string, unknown>) : null;
  const kind = (i.kind != null ? text(i.kind, 20) : before?.kind ?? '') as OutputKind;
  if (!(OUTPUT_KINDS as readonly string[]).includes(kind)) throw new CodeCheckError('bad_kind', `kind is one of ${OUTPUT_KINDS.join(', ')}.`);
  const title = i.title != null ? text(i.title, 200) : before?.title ?? '';
  if (!title) throw new CodeCheckError('bad_title', 'title is required.');
  const status = (i.status != null ? text(i.status, 20) : before?.status ?? 'not_started') as OutputStatus;
  if (!(OUTPUT_STATUSES as readonly string[]).includes(status)) throw new CodeCheckError('bad_status', `status is one of ${OUTPUT_STATUSES.join(', ')}.`);
  if (status === 'accepted' && who !== JASON && !text(i.note, 1000) && before?.status !== 'accepted') throw new CodeCheckError('note_required', 'Accepted means Jason accepted it: say where (a note with his message link).');
  const lane = i.lane !== undefined ? text(i.lane, 120) || null : before?.lane ?? null;
  const due = i.due !== undefined ? (text(i.due, 10) || null) : before?.due ?? null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new CodeCheckError('bad_due', 'due is a date, YYYY-MM-DD.');
  const link = i.link !== undefined ? text(i.link, 500) || null : before?.link ?? null;
  if (link && !/^https:\/\//.test(link)) throw new CodeCheckError('bad_link', 'link is an https address.');
  const note = i.note !== undefined ? text(i.note, 1000) || null : before?.note ?? null;
  const next: AuditOutput = { output_id, kind, lane, title, status, due, link, note, sort: before?.sort ?? 100, updated_by: who, updated_at: new Date().toISOString() };
  const message = before ? `${output_id}: ${OUTPUT_STATUS_LABEL[before.status]} → ${OUTPUT_STATUS_LABEL[status]}.` : `Created ${output_id} at ${OUTPUT_STATUS_LABEL[status]}.`;
  if (opts.dry_run) return { ok: true, written: false, created: !before, output: next, message: `Dry run: ${message} Nothing was written.` };
  return withTransaction(async (db) => {
    await db.query(
      `INSERT INTO engine_audit_outputs (output_id, kind, lane, title, status, due, link, note, sort, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE((SELECT max(sort)+1 FROM engine_audit_outputs),1),$9)
       ON CONFLICT (output_id) DO UPDATE SET kind=EXCLUDED.kind, lane=EXCLUDED.lane, title=EXCLUDED.title, status=EXCLUDED.status,
         due=EXCLUDED.due, link=EXCLUDED.link, note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [output_id, kind, lane, title, status, due, link, note, who],
    );
    await record({ event_type: 'audit_output_changed', subject_id: output_id, lane: 'BAYS', actor: who, source_ref: link, detail: { kind, status_before: before?.status ?? null, status_after: status } }, db);
    changed('code_checks', output_id, db);
    const r = await db.query(`SELECT * FROM engine_audit_outputs WHERE output_id = $1`, [output_id]);
    return { ok: true as const, written: true, created: !before, output: toOutput(r.rows[0] as Record<string, unknown>), message };
  });
}
