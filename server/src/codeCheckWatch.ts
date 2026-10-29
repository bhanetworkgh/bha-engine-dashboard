/**
 * The code check's alert, reminders and Codex note (29 Oct 2026, Destiny — D6; Jason's yes of 28 Oct, DM
 * D0AF0DG8ZPY 1793181986.036119: "Bays alerts Destiny on approval and reminds him until the check is posted").
 *
 * Every RULE.every_minutes, the waiting list codeChecks.read() already computes (a session on the pay ledger
 * approved on or after 1 Nov, not Destiny's own, with no check recorded) is walked. Each waiting log is at one
 * step: step 0 is the alert, sent once Jason has approved it; step k (k >= 1) is reminder k, due
 * RULE.first_reminder_hours (3) after approval and then every RULE.remind_every_hours (3), until the check is
 * recorded. Past codeChecks.WINDOW_HOURS a reminder says it is late. Only the current step is sent, so a
 * process that was down sends one message on its return, never a backlog.
 *
 * One DM per step: the claim is an engine event (code_check_due_alerted, or code_check_reminded) whose dedupe
 * key is the Codex ID and the step, written before the DM goes. Another instance, or the next pass, finds the
 * key held and sends nothing. A DM Slack refuses gives the claim back (the event is deleted) and is retried on
 * the next pass, as codexGap.ts does, so a reminder nobody received is never counted as sent.
 *
 * codexNote() is the other half: once a check is recorded, the verdict, pay call, link and time are written
 * onto the Codex row itself under new field names (Code Check Verdict, Code Check Pay Call, Code Check Link,
 * Code Check At, Code Check By), through engineWrite.patchRecord, which merges and keeps every other field. It
 * never fails the check: its outcome is returned and logged.
 *
 * It sends DMs, writes events and stamps the Codex row; it changes no pay row and no check.
 */
import { query } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';
import * as engineWrite from './engineWrite';
import * as cc from './codeChecks';
import { getMeta, setMeta } from './db';

/** Destiny, 29 Oct 2026: the alert as soon as Jason approves, then a reminder every 3 hours until the check is recorded. */
export const RULE = { every_minutes: 2, first_reminder_hours: 3, remind_every_hours: 3 } as const;

const DASHBOARD = () => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');

const lagos = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Pure: which step a log waiting this many hours is at. 0 is the alert; 1, 2, … are the reminders. */
export function stepFor(hoursWaiting: number): number {
  if (!(hoursWaiting >= RULE.first_reminder_hours)) return 0;
  return 1 + Math.floor((hoursWaiting - RULE.first_reminder_hours) / RULE.remind_every_hours);
}

export function dedupeKey(codexId: string, step: number): string {
  return `code_check_due:${codexId}:${step}`;
}

export interface Due {
  codex_entry_id: string;
  builder: string | null;
  session_date: string | null;
  approved_at: string;
  hours_waiting: number;
  late: boolean;
  step: number;
  channel_id: string | null;
}

/** Pure: the message for one step. */
export function messageFor(d: Due): string {
  const by = new Date(Date.parse(d.approved_at) + cc.WINDOW_HOURS * 3_600_000).toISOString();
  const who = d.builder ?? 'a builder';
  const where = [`<${DASHBOARD()}/codex/${encodeURIComponent(d.codex_entry_id)}|Open the log>`, d.channel_id ? `log channel <#${d.channel_id}>` : null].filter(Boolean).join(' · ');
  if (d.step === 0) {
    return [
      `*Code check due:* ${who}, \`${d.codex_entry_id}\`${d.session_date ? ` (session ${d.session_date})` : ''}.`,
      `Jason approved it ${lagos(d.approved_at)} Lagos time. Due by ${lagos(by)} Lagos (${cc.WINDOW_HOURS} hours).`,
      where,
    ].join('\n');
  }
  const late = d.hours_waiting - cc.WINDOW_HOURS;
  return [
    `*Reminder ${d.step}: code check still owed* for ${who}, \`${d.codex_entry_id}\`.`,
    d.late
      ? `*Late:* approved ${Math.floor(d.hours_waiting)} hours ago, ${Math.ceil(late)} hours past the ${cc.WINDOW_HOURS}-hour window. If it cannot be done, say so on the record rather than letting pay stall quietly.`
      : `Approved ${Math.floor(d.hours_waiting)} hours ago. Due by ${lagos(by)} Lagos.`,
    where,
    `_Next reminder in ${RULE.remind_every_hours} hours, until the check is recorded._`,
  ].join('\n');
}

/** The logs that are due a message now, from the same waiting list the Code checks tab shows. */
/**
 * The trial (Destiny, 29 Oct 2026): before 1 Nov the alert and reminders can be switched on to prove them on
 * real approvals, then off again. It changes only what this watcher alerts on; the Code checks tab, its waiting
 * list and its figures still start at 1 Nov. Off is the default and once 1 Nov arrives it no longer matters.
 */
export const TRIAL_KEY = 'code_check.alert_trial';
export interface Trial { on: boolean; from: string | null; set_by: string | null; set_at: string | null }
export async function trial(): Promise<Trial> {
  try {
    const v = await getMeta(TRIAL_KEY);
    const t = v ? (JSON.parse(v) as Partial<Trial>) : {};
    return { on: t.on === true, from: t.from ?? null, set_by: t.set_by ?? null, set_at: t.set_at ?? null };
  } catch {
    return { on: false, from: null, set_by: null, set_at: null };
  }
}
export async function setTrial(on: boolean, by: string, from: string | null): Promise<Trial> {
  const t: Trial = { on, from: on ? from : null, set_by: by, set_at: new Date().toISOString() };
  await setMeta(TRIAL_KEY, JSON.stringify(t));
  await record({ event_type: on ? 'code_check_trial_on' : 'code_check_trial_off', subject_id: TRIAL_KEY, lane: 'BAYS', actor: by, detail: { from: t.from } });
  return t;
}

/** Pure: the approval time alerts count from. The trial only ever moves it earlier than 1 Nov. */
export function alertsFrom(t: Trial): string {
  return t.on && t.from && Date.parse(t.from) < Date.parse(cc.START) ? t.from : cc.START;
}

export async function due(now = Date.now()): Promise<{ due: Due[]; skipped: string[]; from: string }> {
  const from = alertsFrom(await trial());
  const s = from === cc.START ? await cc.read(now) : cc.summarise((await cc.approvals(from)).map((a) => a), await cc.checks(), now, from);
  const skipped: string[] = [];
  const out: Due[] = [];
  const ids = s.waiting.map((w) => w.codex_entry_id).filter((x): x is string => !!x);
  const ch = ids.length
    ? await query<{ cid: string; ch: string | null }>(
        `SELECT DISTINCT ON (fields->>'Codex Entry ID') fields->>'Codex Entry ID' AS cid, NULLIF(fields->>'Builder Channel ID', '') AS ch
           FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = ANY($1::text[]) ORDER BY fields->>'Codex Entry ID', updated_at DESC`,
        [ids],
      )
    : { rows: [] };
  const chOf = new Map(ch.rows.map((r) => [r.cid, r.ch]));
  for (const w of s.waiting) {
    if (!w.codex_entry_id) {
      skipped.push(`a session by ${w.builder ?? 'an unknown builder'} approved ${w.approved_at ?? 'at no recorded time'} has no Codex ID, so it cannot be named in an alert`);
      continue;
    }
    if (!w.approved_at || w.hours_waiting == null) {
      skipped.push(`${w.codex_entry_id} has no approval time on the pay ledger`);
      continue;
    }
    out.push({ codex_entry_id: w.codex_entry_id, builder: w.builder, session_date: w.session_date, approved_at: w.approved_at, hours_waiting: w.hours_waiting, late: w.late, step: stepFor(w.hours_waiting), channel_id: chOf.get(w.codex_entry_id) ?? null });
  }
  return { due: out, skipped, from };
}

export interface RunResult {
  waiting: number;
  /** The approval time alerts counted from on this pass: 1 Nov, or the trial's start while it is on. */
  from: string;
  sent: Array<{ codex_entry_id: string; step: number }>;
  already: number;
  failed: Array<{ codex_entry_id: string; step: number; detail: string }>;
  would_send: Array<{ codex_entry_id: string; step: number; text: string }>;
  skipped: string[];
}

export async function run(opts: { now?: number; dry_run?: boolean; send?: typeof slack.dm } = {}): Promise<RunResult> {
  const send = opts.send ?? slack.dm;
  const { due: list, skipped, from } = await due(opts.now ?? Date.now());
  const out: RunResult = { waiting: list.length, from, sent: [], already: 0, failed: [], would_send: [], skipped };
  for (const d of list) {
    const key = dedupeKey(d.codex_entry_id, d.step);
    if (opts.dry_run) {
      const held = await query(`SELECT 1 FROM engine_events WHERE dedupe_key = $1`, [key]);
      if (held.rows.length) out.already++;
      else out.would_send.push({ codex_entry_id: d.codex_entry_id, step: d.step, text: messageFor(d) });
      continue;
    }
    const claim = await record({
      event_type: d.step === 0 ? 'code_check_due_alerted' : 'code_check_reminded',
      subject_id: d.codex_entry_id,
      lane: 'BAYS',
      actor: 'code-check-watch',
      detail: { step: d.step, approved_at: d.approved_at, hours_waiting: d.hours_waiting, late: d.late, builder: d.builder, rule: RULE },
      dedupe_key: key,
    });
    if (!claim.recorded) {
      out.already++;
      continue;
    }
    const sent = await send(cc.DESTINY, messageFor(d));
    if (!sent.ok) {
      // Give the claim back so the next pass tries again; a reminder nobody received is never counted.
      await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
      console.error(`[code-check-watch] DM for ${d.codex_entry_id} step ${d.step} not sent, will retry: ${sent.detail}`);
      out.failed.push({ codex_entry_id: d.codex_entry_id, step: d.step, detail: sent.detail });
      continue;
    }
    out.sent.push({ codex_entry_id: d.codex_entry_id, step: d.step });
  }
  return out;
}

/**
 * Writes the recorded check onto the Codex row (new field names; every other field kept). Never throws:
 * the outcome is returned for the caller to report.
 */
export async function codexNote(check: cc.CodeCheck): Promise<{ ok: boolean; row_id: string | null; detail: string }> {
  try {
    const r = await query<{ id: string }>(
      `SELECT id::text FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC`,
      [check.codex_entry_id],
    );
    if (!r.rows.length) return { ok: false, row_id: null, detail: `no Codex row carries ${check.codex_entry_id}, so the check is recorded but not written onto a log` };
    if (r.rows.length > 1) return { ok: false, row_id: null, detail: `${r.rows.length} Codex rows carry ${check.codex_entry_id} (ids ${r.rows.map((x) => x.id).join(', ')}); none was picked` };
    const id = r.rows[0].id;
    await engineWrite.patchRecord(
      'codex',
      id,
      {
        'Code Check Verdict': check.verdict,
        'Code Check Pay Call': check.pay_call,
        'Code Check Reason': check.verdict_reason,
        'Code Check Link': check.check_link,
        'Code Check At': check.posted_at,
        'Code Check By': check.recorded_by,
      },
      { endpoint: 'code-check:note', method: 'INTERNAL', key_label: 'server', t0: Date.now(), note: `code check ${check.verdict} / ${check.pay_call} written onto the log` },
    );
    return { ok: true, row_id: id, detail: `written onto Codex row ${id}` };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[code-check-watch] the check for ${check.codex_entry_id} was recorded but not written onto the log: ${detail}`);
    return { ok: false, row_id: null, detail };
  }
}

/* ----------------------------------------------------------------- timer */

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('code check watch');
    if (busy) return;
    busy = true;
    run()
      .then((r) => {
        if (r.sent.length || r.failed.length) console.log(`[code-check-watch] ${r.waiting} waiting: sent ${r.sent.map((x) => `${x.codex_entry_id}#${x.step}`).join(', ') || 'none'}; failed ${r.failed.length}`);
      })
      .catch((e) => console.error(`[code-check-watch] pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.every_minutes * 60 * 1000);
  timer.unref();
}
