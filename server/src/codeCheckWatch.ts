/**
 * The code check's alert, reminders and Codex note (29 Oct 2026, Destiny — D6; Jason's yes of 28 Oct, DM
 * D0AF0DG8ZPY 1793181986.036119: "Bays alerts Destiny on approval and reminds him until the check is posted").
 *
 * Every RULE.every_minutes, the waiting list codeChecks.read() already computes (a session on the pay ledger
 * approved on or after 1 Nov, not Destiny's own, with no check recorded) is walked. Each waiting log is at one
 * step: step 0 is the alert, sent once Jason has approved it; step k (k >= 1) is reminder k, due
 * RULE.first_reminder_hours (3) after approval and then every RULE.remind_every_hours (3), RULE.max_reminders (4)
 * at most, about 12 hours; after the fourth nothing more is sent for that log. Only the current step is sent, so a
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
 * The channel (2 Nov 2026, Destiny): the alert is no longer a DM, which got buried. Each waiting log gets
 * ONE card in #bha-code-reviews (CODE_CHECK_CHANNEL, default C0CDRV4TMCP), claimed by the event key
 * code_check_card:<Codex ID> with the card's ts kept on that event, and every reminder after it is a reply in
 * the card's thread tagging Destiny. The card carries a third button, Mark reviewed, whose action id is the
 * approval card's (approvals.ACTION_APPROVE) and whose value is CCR-<Codex ID>, so n8n's Bays — Front Door and
 * Bays — Approval Decision forward the click unchanged to /api/engine/approvals/decide, which hands a CCR- id
 * to markReviewed(). Only Destiny or Jason may mark one; the claim is the event code_check_marked_reviewed
 * (dedupe code_check_reviewed:<Codex ID>), the card is rewritten without the button, and a reviewed log gets no
 * more reminders. Recording the check (record_code_check) marks its card reviewed too. Marking reviewed records
 * no check: the Code checks tab keeps it waiting until one is recorded.
 *
 * It posts cards, writes events and stamps the Codex row; it changes no pay row and no check.
 */
import { query } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';
import * as engineWrite from './engineWrite';
import * as cc from './codeChecks';
import * as bharag from './bharag';
import { getMeta, setMeta } from './db';

/** Destiny, 29 Oct 2026: the alert as soon as Jason approves, then a reminder every 3 hours, 4 at most (about 12 hours). */
export const RULE = { every_minutes: 2, first_reminder_hours: 3, remind_every_hours: 3, max_reminders: 4 } as const;

/** #bha-code-reviews (2 Nov 2026, Destiny). */
export const CHANNEL = (): string => process.env.CODE_CHECK_CHANNEL?.trim() || 'C0CDRV4TMCP';
/** The Mark reviewed button reuses the approval card's action id so the Front Door forwards it unchanged. */
export const ACTION_MARK = 'engine_approval_approve';
export const REVIEW_PREFIX = 'CCR-';
export const isReviewId = (id: string): boolean => id.startsWith(REVIEW_PREFIX) && id.length > REVIEW_PREFIX.length;
export const cardKey = (codexId: string): string => `code_check_card:${codexId}`;
export const reviewedKey = (codexId: string): string => `code_check_reviewed:${codexId}`;

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
  /** Past the last reminder: only a missing card is posted. */
  quiet?: boolean;
}

/** Pure: the message for one step, as Block Kit with a plain-text fallback. */
export function messageFor(d: Due, opts: { reviewed?: { by: string; at: string; via?: string } | null } = {}): { text: string; blocks: unknown[] } {
  const reviewed = opts.reviewed ?? null;
  const by = new Date(Date.parse(d.approved_at) + cc.WINDOW_HOURS * 3_600_000).toISOString();
  const who = d.builder ?? 'a builder';
  const logUrl = `${DASHBOARD()}/codex/${encodeURIComponent(d.codex_entry_id)}`;
  const last = d.step >= RULE.max_reminders;
  const header = d.quiet ? 'Code check still owed' : d.step === 0 ? 'A log is ready for your code check' : last ? `Last reminder: code check still owed` : `Reminder ${d.step} of ${RULE.max_reminders}: code check still owed`;
  const lead =
    d.step === 0
      ? `Jason approved *${who}*'s log. It is ready for your review.`
      : `*${who}*'s log was approved ${Math.floor(d.hours_waiting)} hours ago and has no check recorded yet.${last ? ' This is the last reminder for it.' : ''}`;
  const text =
    d.step === 0
      ? `Code check due: ${who}, ${d.codex_entry_id}. Approved ${lagos(d.approved_at)} Lagos, due by ${lagos(by)} Lagos.`
      : `${header}: ${who}, ${d.codex_entry_id}, approved ${Math.floor(d.hours_waiting)} hours ago.`;
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: lead } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Builder*\n${who}` },
        { type: 'mrkdwn', text: `*Codex ID*\n\`${d.codex_entry_id}\`` },
        { type: 'mrkdwn', text: `*Approved*\n${lagos(d.approved_at)} Lagos` },
        { type: 'mrkdwn', text: `*Due by*\n${lagos(by)} Lagos` },
      ],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Open the log' }, url: logUrl, action_id: 'code_check_open_log' },
        { type: 'button', text: { type: 'plain_text', text: 'Code checks' }, url: `${DASHBOARD()}/pay?tab=code-checks`, action_id: 'code_check_open_tab' },
        ...(reviewed
          ? []
          : [{ type: 'button', text: { type: 'plain_text', text: 'Mark reviewed' }, value: `${REVIEW_PREFIX}${d.codex_entry_id}`, action_id: ACTION_MARK }]),
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            d.channel_id ? `Log channel <#${d.channel_id}>` : null,
            reviewed
              ? null
              : d.quiet
                ? 'Its reminders have all gone; it stays here until it is marked reviewed.'
                : last
                ? 'No more reminders after this one.'
                : `Reminders in this thread every ${RULE.remind_every_hours} hours, ${RULE.max_reminders} at most, until it is marked reviewed or the check is recorded.`,
          ].filter(Boolean).join(' · '),
        },
      ],
    },
  ];
  if (reviewed) {
    blocks[0] = { type: 'header', text: { type: 'plain_text', text: 'Code check reviewed' } };
    blocks.splice(blocks.length - 1, 0, {
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: Marked reviewed by <@${reviewed.by}> on ${lagos(reviewed.at)} Lagos${reviewed.via ? ` (${reviewed.via})` : ''}.` },
    });
    return { text: `Code check reviewed: ${who}, ${d.codex_entry_id}, by ${reviewed.by}.`, blocks };
  }
  return { text, blocks };
}

/** Pure: a reminder in the card's thread, tagging Destiny. */
export function reminderFor(d: Due): string {
  const last = d.step >= RULE.max_reminders;
  return `<@${cc.DESTINY}> ${last ? 'Last reminder' : `Reminder ${d.step} of ${RULE.max_reminders}`}: ${d.builder ?? 'this'}'s log was approved ${Math.floor(d.hours_waiting)} hours ago and is not reviewed yet.${last ? ' No more reminders after this one.' : ''}`;
}

/** The logs that are due a message now, from the same waiting list the Code checks tab shows. */
/**
 * The trial (Destiny, 29 Oct 2026): before 1 Nov the alert and reminders can be switched on to prove them on
 * real approvals, then off again. It changes only what this watcher alerts on; the Code checks tab, its waiting
 * list and its figures still start at 1 Nov. Off is the default and once 1 Nov arrives it no longer matters.
 */
export const TRIAL_KEY = 'code_check.alert_trial';
export interface Trial { on: boolean; from: string | null; set_by: string | null; set_at: string | null }
export const TRIAL_ENV = 'CODE_CHECK_ALERT_TRIAL_FROM';
export async function trial(): Promise<Trial> {
  // The service setting wins where it is set (an ISO time), so the trial can be switched from Render
  // when the MCP tool is not reachable. Unset, the stored switch decides.
  const env = process.env[TRIAL_ENV]?.trim();
  if (env && !Number.isNaN(Date.parse(env))) return { on: true, from: new Date(env).toISOString(), set_by: `service setting ${TRIAL_ENV}`, set_at: null };
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
  const rv = ids.length
    ? await query<{ subject_id: string }>(`SELECT subject_id FROM engine_events WHERE event_type = 'code_check_marked_reviewed' AND subject_id = ANY($1::text[])`, [ids])
    : { rows: [] };
  const reviewedIds = new Set(rv.rows.map((r) => r.subject_id));
  for (const w of s.waiting) {
    if (!w.codex_entry_id) {
      skipped.push(`a session by ${w.builder ?? 'an unknown builder'} approved ${w.approved_at ?? 'at no recorded time'} has no Codex ID, so it cannot be named in an alert`);
      continue;
    }
    if (!w.approved_at || w.hours_waiting == null) {
      skipped.push(`${w.codex_entry_id} has no approval time on the pay ledger`);
      continue;
    }
    if (reviewedIds.has(w.codex_entry_id)) continue; // marked reviewed: no more reminders
    const step = stepFor(w.hours_waiting);
    // After the four reminders nothing more is sent for it, but a log with no card yet still gets one, so
    // every waiting log is in the channel (the four pending on 2 Nov were past their reminders).
    out.push({ codex_entry_id: w.codex_entry_id, builder: w.builder, session_date: w.session_date, approved_at: w.approved_at, hours_waiting: w.hours_waiting, late: w.late, step: Math.min(step, RULE.max_reminders), channel_id: chOf.get(w.codex_entry_id) ?? null, quiet: step > RULE.max_reminders });
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

/** Posts one message into a channel (or a thread); returns the message ts. Stood in by the tests. */
export type Poster = (channel: string, text: string, blocks?: unknown[], thread_ts?: string) => Promise<{ ok: boolean; detail: string; ts?: string }>;
export const slackPost: Poster = async (channel, text, blocks, thread_ts) => {
  const r = await slack.botCall('chat.postMessage', { channel, text, blocks, thread_ts, unfurl_links: false, unfurl_media: false });
  return r.ok ? { ok: true, detail: 'posted', ts: typeof r.ts === 'string' ? r.ts : undefined } : { ok: false, detail: String(r.error ?? `HTTP ${String(r.http_status ?? '?')}`) };
};

interface Card { id: number; channel: string; ts: string; due: Due }

/** The card already posted for a log, if any (its ts is on the claim event). */
export async function cardFor(codexId: string): Promise<Card | null> {
  const r = await query<{ id: string; detail: Record<string, unknown> }>(`SELECT id::text, detail FROM engine_events WHERE dedupe_key = $1`, [cardKey(codexId)]);
  const row = r.rows[0];
  if (!row || typeof row.detail?.ts !== 'string' || typeof row.detail?.channel !== 'string') return null;
  return { id: Number(row.id), channel: row.detail.channel as string, ts: row.detail.ts as string, due: row.detail.due as Due };
}

/** Posts the card for a log once. 'posted' when this call put it there, 'held' when it was already there. */
async function ensureCard(d: Due, post: Poster): Promise<{ state: 'posted' | 'held' | 'failed' | 'pending'; ts?: string; detail?: string }> {
  const have = await cardFor(d.codex_entry_id);
  if (have) return { state: 'held', ts: have.ts };
  const channel = CHANNEL();
  const claim = await record({
    event_type: 'code_check_card_posted',
    subject_id: d.codex_entry_id,
    lane: 'BAYS',
    actor: 'code-check-watch',
    detail: { channel, due: d },
    dedupe_key: cardKey(d.codex_entry_id),
  });
  if (!claim.recorded) return { state: 'pending' }; // another pass is posting it right now
  const m = messageFor(d);
  const sent = await post(channel, m.text, m.blocks);
  if (!sent.ok || !sent.ts) {
    await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
    return { state: 'failed', detail: sent.ok ? 'Slack gave no message ts' : sent.detail };
  }
  await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ ts: sent.ts })]);
  return { state: 'posted', ts: sent.ts };
}

export async function run(opts: { now?: number; dry_run?: boolean; post?: Poster } = {}): Promise<RunResult> {
  const post = opts.post ?? slackPost;
  const { due: list, skipped, from } = await due(opts.now ?? Date.now());
  const out: RunResult = { waiting: list.length, from, sent: [], already: 0, failed: [], would_send: [], skipped };
  for (const d of list) {
    const key = dedupeKey(d.codex_entry_id, d.step);
    if (opts.dry_run) {
      const held = await query(`SELECT 1 FROM engine_events WHERE dedupe_key = $1`, [key]);
      const card = await cardFor(d.codex_entry_id);
      if (d.quiet) {
        if (card) out.already++;
        else out.would_send.push({ codex_entry_id: d.codex_entry_id, step: d.step, text: messageFor(d).text });
        continue;
      }
      if (held.rows.length && card) out.already++;
      else out.would_send.push({ codex_entry_id: d.codex_entry_id, step: d.step, text: card ? reminderFor(d) : messageFor(d).text });
      continue;
    }
    // The card first: a log that was only ever DM'd (before 2 Nov) gets its card on the next pass.
    const card = await ensureCard(d, post);
    if (card.state === 'failed') {
      console.error(`[code-check-watch] card for ${d.codex_entry_id} not posted, will retry: ${card.detail}`);
      out.failed.push({ codex_entry_id: d.codex_entry_id, step: d.step, detail: card.detail ?? 'not posted' });
      continue;
    }
    if (card.state === 'pending') continue;
    if (d.quiet) {
      if (card.state === 'posted') out.sent.push({ codex_entry_id: d.codex_entry_id, step: d.step });
      else out.already++;
      continue;
    }
    const claim = await record({
      event_type: d.step === 0 ? 'code_check_due_alerted' : 'code_check_reminded',
      subject_id: d.codex_entry_id,
      lane: 'BAYS',
      actor: 'code-check-watch',
      detail: { step: d.step, approved_at: d.approved_at, hours_waiting: d.hours_waiting, late: d.late, builder: d.builder, rule: RULE, channel: CHANNEL() },
      dedupe_key: key,
    });
    if (!claim.recorded) {
      if (card.state === 'posted') out.sent.push({ codex_entry_id: d.codex_entry_id, step: d.step });
      else out.already++;
      continue;
    }
    // The card just posted is this step's message; otherwise the reminder goes in its thread.
    if (card.state === 'posted' || d.step === 0) {
      out.sent.push({ codex_entry_id: d.codex_entry_id, step: d.step });
      continue;
    }
    const sent = await post(CHANNEL(), reminderFor(d), undefined, card.ts);
    if (!sent.ok) {
      // Give the claim back so the next pass tries again; a reminder nobody received is never counted.
      await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
      console.error(`[code-check-watch] reminder for ${d.codex_entry_id} step ${d.step} not sent, will retry: ${sent.detail}`);
      out.failed.push({ codex_entry_id: d.codex_entry_id, step: d.step, detail: sent.detail });
      continue;
    }
    out.sent.push({ codex_entry_id: d.codex_entry_id, step: d.step });
  }
  return out;
}

/* ----------------------------------------------------------- mark reviewed */

export interface ReviewResult { status: number; body: Record<string, unknown> }

/**
 * One click on Mark reviewed (or a recorded check). Destiny or Jason only; one claim per log; the card is
 * rewritten without the button. Nothing here records a check.
 */
export async function markReviewed(input: { id: string; user_id: string; via?: string; tell?: boolean }): Promise<ReviewResult> {
  const codexId = input.id.startsWith(REVIEW_PREFIX) ? input.id.slice(REVIEW_PREFIX.length) : input.id;
  const card = await cardFor(codexId);
  const tell = async (text: string) => {
    if (input.tell === false || !card) return;
    const r = await slack.botCall('chat.postEphemeral', { channel: card.channel, user: input.user_id, text });
    if (!r.ok) console.error(`[code-check-watch] could not tell ${input.user_id}: ${String(r.error)}`);
  };
  if (!cc.RECORDERS.has(input.user_id)) {
    await tell(`Only <@${cc.DESTINY}> or <@${cc.JASON}> can mark a code check reviewed. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: 'not_allowed', raise: false, codex_entry_id: codexId, message: `${input.user_id} may not mark this reviewed. Nothing was changed.` } };
  }
  const claim = await record({
    event_type: 'code_check_marked_reviewed',
    subject_id: codexId,
    lane: 'BAYS',
    actor: input.user_id,
    detail: { via: input.via ?? 'button', card_ts: card?.ts ?? null },
    dedupe_key: reviewedKey(codexId),
  });
  if (!claim.recorded) {
    const prev = await query<{ actor: string | null }>(`SELECT actor FROM engine_events WHERE dedupe_key = $1`, [reviewedKey(codexId)]);
    const by = prev.rows[0]?.actor;
    await tell(`This one was already marked reviewed${by ? ` by <@${by}>` : ''}. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: 'already_reviewed', raise: false, codex_entry_id: codexId, message: 'Already marked reviewed. Nothing was changed.' } };
  }
  if (!card) {
    return { status: 200, body: { ok: true, done: true, codex_entry_id: codexId, card_updated: false, raise: false, message: 'Marked reviewed. No card in the channel to update.' } };
  }
  const m = messageFor(card.due, { reviewed: { by: input.user_id, at: new Date().toISOString(), via: input.via } });
  const r = await slack.botCall('chat.update', { channel: card.channel, ts: card.ts, text: m.text, blocks: m.blocks });
  const err = r.ok ? null : `The card could not be updated: ${String(r.error)}`;
  if (err) console.error(`[code-check-watch] ${codexId}: ${err}`);
  return { status: 200, body: { ok: true, done: true, codex_entry_id: codexId, card_updated: r.ok === true, raise: !!err, ...(err ? { message: `Marked reviewed. ${err}` } : { message: 'Marked reviewed.' }) } };
}

/** A recorded check marks its card reviewed. Never throws; never fails the check. */
export async function reviewedByCheck(check: cc.CodeCheck): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await markReviewed({ id: check.codex_entry_id, user_id: check.recorded_by, via: `check recorded: ${cc.VERDICT_LABEL[check.verdict as cc.Verdict] ?? check.verdict}`, tell: false });
    if (r.body.reason === 'already_reviewed') return { ok: true, detail: 'the card was already marked reviewed' };
    return { ok: r.body.ok === true, detail: String(r.body.message ?? r.body.reason ?? '') };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
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

/**
 * Writes the recorded check onto the Codex entry's own document in BHARAG (2 Nov 2026, Destiny — Jegan's
 * edit-in-place, KWV1): metadata key `code_check`, the same id, nothing else touched, so Bays and the twins
 * read the review on the document they already search. Every copy of the entry (metadata codex_entry_id) is
 * edited. Never throws; `dry_run` finds the documents and edits nothing.
 */
export async function bharagNote(check: cc.CodeCheck, opts: { dry_run?: boolean } = {}): Promise<{ ok: boolean; documents: string[]; edited: string[]; detail: string }> {
  const keyVar = bharag.ingestKeyVar('codex');
  try {
    const found = await bharag.findByMetadata(keyVar, 'codex_entry_id', check.codex_entry_id);
    if (!found.ids.length) {
      return { ok: false, documents: [], edited: [], detail: `no document in the Codex workspace carries ${check.codex_entry_id} (${found.scanned} read${found.complete ? '' : ', stopped at the page cap'})` };
    }
    if (opts.dry_run) return { ok: true, documents: found.ids, edited: [], detail: `would edit ${found.ids.length} document(s): ${found.ids.join(', ')}` };
    const metadata = {
      code_check: {
        verdict: check.verdict,
        verdict_label: cc.VERDICT_LABEL[check.verdict as cc.Verdict] ?? check.verdict,
        pay_call: check.pay_call,
        pay_label: cc.PAY_LABEL[check.pay_call as cc.PayCall] ?? check.pay_call,
        reason: check.verdict_reason,
        not_confirmed: check.claims.filter((x) => x.result !== 'confirmed').map((x) => x.claim),
        missing: check.missing,
        link: check.check_link,
        at: check.posted_at,
        by: check.recorded_by,
      },
    };
    const edited: string[] = [];
    const failed: string[] = [];
    for (const id of found.ids) {
      const r = await bharag.patchDocument(keyVar, id, { metadata });
      if (r.ok) edited.push(id);
      else failed.push(`${id}: ${r.detail}`);
    }
    if (failed.length) console.error(`[code-check-watch] BHARAG note for ${check.codex_entry_id} failed on ${failed.join('; ')}`);
    return failed.length
      ? { ok: false, documents: found.ids, edited, detail: `edited ${edited.length} of ${found.ids.length}; refused: ${failed.join('; ')}` }
      : { ok: true, documents: found.ids, edited, detail: `written onto ${edited.length} BHARAG document(s) in place: ${edited.join(', ')}` };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[code-check-watch] BHARAG note for ${check.codex_entry_id} not written: ${detail}`);
    return { ok: false, documents: [], edited: [], detail };
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
