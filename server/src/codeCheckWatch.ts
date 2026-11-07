/**
 * The code check's alert, reminders and Codex note (29 Oct 2026, Destiny — D6; Jason's yes of 28 Oct, DM
 * D0AF0DG8ZPY 1793181986.036119: "Bays alerts Destiny on approval and reminds him until the check is posted").
 *
 * Every RULE.every_minutes, the waiting list codeChecks.read() already computes (a session on the pay ledger
 * approved on or after 1 Nov, not Destiny's own, with no check recorded) is walked. Each waiting log is at one
 * step: step 0 is the alert, sent once Jason has approved it; step k (k >= 1) is reminder k, due
 * RULE.first_reminder_hours (6) after approval and then every RULE.remind_every_hours (6), RULE.max_reminders (3)
 * at most, 18 hours; after the third nothing more is sent for that log. Only the current step is sent, so a
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
 * The log itself (3 Nov 2026, Destiny): the card's Open the log button opens the posted Codex in the builder's
 * log channel, in its thread, because that is where the check is written. findLogPost() reads the channel for
 * Bays' top-level "Codex Entry" post carrying the exact Codex ID; a card already posted is rewritten once the
 * post is found. Not found, the button opens the dashboard and the card says so.
 *
 * Send it and the rest happens (3 Nov 2026, Destiny): prepare_code_check saves the whole check as ready to send
 * (engine_code_check_prepared) beside the Slack draft. Every pass reads only the threads of ready checks. A reply
 * after the save, from the person who prepared it, that opens "Code check:" and carries the exact Codex ID is the
 * check going out: it is recorded with that message's own link and time, which runs the same Codex note, BHARAG
 * note and reviewed card as record_code_check, and one line confirms it under his message. A verdict or pay call
 * changed in the draft before sending is never recorded from the saved one: it stops, and the card's thread says so.
 *
 * It posts cards, writes events and stamps the Codex row; it changes no pay row and no check it was not handed.
 */
import { query } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';
import * as engineWrite from './engineWrite';
import * as cc from './codeChecks';
import * as bharag from './bharag';
import { readSince } from './decisionWatch';
import { getMeta, setMeta } from './db';

/** Destiny, 4 Nov 2026: a reminder every 6 hours, 3 at most (18 hours). It was every 3 hours, 4 at most. */
export const RULE = { every_minutes: 2, first_reminder_hours: 6, remind_every_hours: 6, max_reminders: 3 } as const;

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
  /** The posted Codex in the builder's log channel, opened in its thread. */
  log_url?: string | null;
}

/** Pure: the message for one step, as Block Kit with a plain-text fallback. */
export function messageFor(d: Due, opts: { reviewed?: { by: string; at: string; via?: string } | null } = {}): { text: string; blocks: unknown[] } {
  const reviewed = opts.reviewed ?? null;
  const by = new Date(Date.parse(d.approved_at) + cc.WINDOW_HOURS * 3_600_000).toISOString();
  const who = d.builder ?? 'a builder';
  const logUrl = d.log_url || `${DASHBOARD()}/codex/${encodeURIComponent(d.codex_entry_id)}`;
  const last = d.step >= RULE.max_reminders;
  const header = d.quiet ? 'Code check still owed' : d.step === 0 ? 'A log is ready for your code check' : last ? `Last reminder: code check still owed` : `Reminder ${d.step} of ${RULE.max_reminders}: code check still owed`;
  const lead =
    d.step === 0
      ? `Jason approved *${who}*'s log. It is ready for your review.`
      : `*${who}*'s log was approved ${Math.floor(d.hours_waiting)} hours ago and has no check recorded yet.${last && !d.quiet ? ' This is the last reminder for it.' : ''}`;
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
        { type: 'mrkdwn', text: `*For review by*\n<@${cc.DESTINY}>` },
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
            d.log_url ? null : 'The posted log was not found, so Open the log goes to the dashboard.',
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

/** Where a log stands with the automatic check: a card to remind on, nothing to send yet, or no automatic check at all. */
async function draftFor(d: Due, automatic: string | null): Promise<{ ts?: string; skip?: boolean }> {
  const r = await query<{ state: string; card_ts: string | null }>(`SELECT state, card_ts FROM engine_code_check_drafts WHERE codex_entry_id = $1`, [d.codex_entry_id]);
  const row = r.rows[0];
  if (row?.state === 'ready' && row.card_ts) return { ts: row.card_ts };
  if (row && row.state !== 'failed') return { skip: true };
  if (!row && automatic && Date.parse(d.approved_at) >= Date.parse(automatic)) return { skip: true };
  return {};
}

export async function run(opts: { now?: number; dry_run?: boolean; post?: Poster; find?: typeof findLogPost } = {}): Promise<RunResult> {
  const post = opts.post ?? slackPost;
  const find = opts.find ?? findLogPost;
  const { due: list, skipped, from } = await due(opts.now ?? Date.now());
  const out: RunResult = { waiting: list.length, from, sent: [], already: 0, failed: [], would_send: [], skipped };
  const automatic = (await getMeta('code_check.auto_from').catch(() => null)) || null;
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
    // The automatic check's card is the alert, and its reminders go in that card's thread. No second card.
    const draft = await draftFor(d, automatic);
    if (draft.skip) continue;
    if (draft.ts) {
      if (d.quiet || d.step === 0) { out.already++; continue; }
      const claimed = await record({ event_type: 'code_check_reminded', subject_id: d.codex_entry_id, lane: 'BAYS', actor: 'code-check-watch', detail: { step: d.step, approved_at: d.approved_at, hours_waiting: d.hours_waiting, late: d.late, builder: d.builder, rule: RULE, channel: CHANNEL(), on: 'check card' }, dedupe_key: key });
      if (!claimed.recorded) { out.already++; continue; }
      const sent = await post(CHANNEL(), reminderFor(d), undefined, draft.ts);
      if (!sent.ok) {
        await query(`DELETE FROM engine_events WHERE id = $1`, [claimed.id]);
        out.failed.push({ codex_entry_id: d.codex_entry_id, step: d.step, detail: sent.detail });
        continue;
      }
      out.sent.push({ codex_entry_id: d.codex_entry_id, step: d.step });
      continue;
    }
    // The card first: a log that was only ever DM'd (before 2 Nov) gets its card on the next pass.
    const held = await cardFor(d.codex_entry_id);
    if (!held?.due?.log_url) {
      d.log_url = await logUrlFor(d, find);
      if (held && d.log_url) await linkCard(held, d.log_url);
    }
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

/* ------------------------------------------------------- the posted log */

export interface LogPost { channel: string; ts: string; url: string }
const WORKSPACE = (): string => process.env.SLACK_WORKSPACE_URL?.trim().replace(/\/+$/, '') || 'https://bayshorizonnetwork.slack.com';
/** Pure: a link that opens the message's own thread. */
export const threadUrl = (channel: string, ts: string): string =>
  `${WORKSPACE()}/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${ts}&cid=${channel}`;

/** Pure: Bays' top-level Codex post for exactly this id, never a later message that only mentions it. */
export function isLogPost(m: { text?: string; blocks?: unknown; bot_id?: string; thread_ts?: string; ts?: string }, codexId: string): boolean {
  if (!m.bot_id || (m.thread_ts && m.thread_ts !== m.ts)) return false;
  const body = `${m.text ?? ''} ${m.blocks ? JSON.stringify(m.blocks) : ''}`;
  return body.includes('Codex Entry') && new RegExp(`${codexId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(body);
}

/** Finds the posted Codex in the log channel, reading back from the newest message. Null, with the reason logged, when it is not there. */
export async function findLogPost(codexId: string, channel: string | null, around: string): Promise<LogPost | null> {
  if (!channel) return null;
  const oldest = String(Math.floor(Date.parse(around) / 1000) - 21 * 86_400);
  for (const token of [undefined, slack.northStarToken()] as const) {
    if (token === null) continue;
    let cursor: string | undefined;
    let error: string | null = null;
    for (let page = 0; page < 5 && !error; page++) {
      const r = await slack.botCall('conversations.history', { channel, oldest, limit: 200, cursor }, 'form', token);
      if (!r.ok) {
        error = String(r.error);
        break;
      }
      const hit = ((r.messages as { ts?: string; text?: string; blocks?: unknown; bot_id?: string; thread_ts?: string }[]) ?? []).find((m) => m.ts && isLogPost(m, codexId));
      if (hit?.ts) return { channel, ts: hit.ts, url: threadUrl(channel, hit.ts) };
      cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      if (!cursor) return null;
    }
    if (error) console.error(`[code-check-watch] could not read ${channel} for ${codexId}: ${error}`);
  }
  return null;
}

/** Looked for and not found: not asked again for an hour, so a missing post is not a read every two minutes. */
const notFoundAt = new Map<string, number>();

async function logUrlFor(d: Due, find: typeof findLogPost): Promise<string | null> {
  const last = notFoundAt.get(d.codex_entry_id);
  if (last && Date.now() - last < 3_600_000) return null;
  const hit = await find(d.codex_entry_id, d.channel_id, d.approved_at).catch(() => null);
  if (!hit) notFoundAt.set(d.codex_entry_id, Date.now());
  return hit?.url ?? null;
}

/** Rewrites a card posted before its log was found. A card Slack will not rewrite stays as it was and is tried again. */
async function linkCard(card: Card, url: string): Promise<void> {
  const due = { ...card.due, log_url: url };
  const m = messageFor(due);
  const r = await slack.botCall('chat.update', { channel: card.channel, ts: card.ts, text: m.text, blocks: m.blocks });
  if (!r.ok) {
    console.error(`[code-check-watch] card for ${due.codex_entry_id} not linked to its log: ${String(r.error)}`);
    return;
  }
  await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1`, [card.id, JSON.stringify({ due })]);
}

/* ------------------------------------------------- send it and the rest happens */

export const OPENS_CHECK = /^[\s*_~>]*code check:/i;
const flat = (t: string): string => t.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Pure: is this reply the check going out? From the person who prepared it, a real message, opening the check, naming the exact log. */
export function isSentCheck(m: { user?: string; bot_id?: string; subtype?: string; text?: string; ts?: string }, codexId: string, preparedBy: string, afterTs: number): boolean {
  if (m.bot_id || m.subtype || m.user !== preparedBy || !m.ts || Number(m.ts) <= afterTs) return false;
  return OPENS_CHECK.test(m.text ?? '') && (m.text ?? '').includes(codexId);
}

/** Pure: what the sent text does to the saved check. A changed verdict or pay call stops it; changed wording is noted. */
export function compareSent(draft: string, sent: string, verdict: cc.Verdict, payCall: cc.PayCall, approve?: cc.Approve | null): { same: boolean; conflict: string | null } {
  const s = flat(sent);
  const conflict = !s.includes(flat(cc.VERDICT_LABEL[verdict]))
    ? `the verdict "${cc.VERDICT_LABEL[verdict]}" is not in what went out`
    : !s.includes(flat(cc.PAY_LABEL[payCall]))
      ? `the pay call "${cc.PAY_LABEL[payCall]}" is not in what went out`
      : approve && !s.includes(`approve: ${approve}`)
        ? `the summary line "Approve: ${approve}" is not in what went out`
        : null;
  return { same: flat(draft) === s, conflict };
}

/** Everything a recorded check sets off. Each outcome is reported; none can fail the check. */
export async function afterRecord(check: cc.CodeCheck, opts: { full_text?: string | null } = {}): Promise<{ codex_note: Awaited<ReturnType<typeof codexNote>>; bharag_note: Awaited<ReturnType<typeof bharagNote>>; review_card: { ok: boolean; detail: string } }> {
  const codex_note = await codexNote(check, opts);
  const bharag_note = await bharagNote(check, opts);
  const review_card = await reviewedByCheck(check);
  return { codex_note, bharag_note, review_card };
}

export interface Prepared {
  codex_entry_id: string;
  check: cc.CheckInput;
  draft_text: string;
  channel: string;
  thread_ts: string;
  state: string;
  prepared_by: string;
  prepared_at: string;
}

/** Saves a check as ready to send, replacing an earlier one for the same log. */
export async function prepare(
  i: cc.CheckInput & { draft_text?: unknown; channel_id?: unknown; thread_ts?: unknown; readiness?: unknown; gate?: unknown; gate_ref?: unknown },
  opts: { dry_run?: boolean; dryRecord?: typeof cc.recordCheck; mark?: typeof reviewedOnCard; gate?: typeof cc.checkGate } = {},
): Promise<{ ok: true; written: boolean; message: string; channel: string; thread_ts: string; log_url: string; check: cc.CodeCheck; review_card?: { ok: boolean; detail: string } }> {
  const id = typeof i.codex_entry_id === 'string' ? i.codex_entry_id.trim() : '';
  const draft = typeof i.draft_text === 'string' ? i.draft_text.trim() : '';
  const broke = await (opts.gate ?? cc.checkGate)({ ...i, codex_entry_id: id, draft_text: draft });
  if (broke) throw new cc.CodeCheckError(broke.reason, broke.message);
  if (!OPENS_CHECK.test(draft) || !draft.includes(id)) throw new cc.CodeCheckError('bad_draft', 'draft_text is the check exactly as drafted on Slack: it opens "Code check:" and names the Codex ID, or the watch could not recognise it when it goes out.');
  let channel = typeof i.channel_id === 'string' ? i.channel_id.trim() : '';
  let ts = typeof i.thread_ts === 'string' ? i.thread_ts.trim() : '';
  if (!channel || !ts) {
    const row = await query<{ ch: string | null; at: string | null }>(
      `SELECT NULLIF(fields->>'Builder Channel ID', '') AS ch, COALESCE(fields->>'Jason Reviewed At', fields->>'Processed At') AS at
         FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`,
      [id],
    );
    const hit = await findLogPost(id, row.rows[0]?.ch ?? null, row.rows[0]?.at ?? new Date().toISOString());
    if (!hit) throw new cc.CodeCheckError('log_post_not_found', `The posted Codex for ${id} was not found in its log channel. Pass channel_id and thread_ts.`);
    channel = hit.channel;
    ts = hit.ts;
  }
  const log_url = threadUrl(channel, ts);
  const dry = await (opts.dryRecord ?? cc.recordCheck)({ ...i, check_link: log_url }, { dry_run: true });
  const c = compareSent(draft, draft, dry.check.verdict as cc.Verdict, dry.check.pay_call as cc.PayCall, dry.check.bays_summary?.approve);
  if (c.conflict) throw new cc.CodeCheckError('draft_disagrees', `The draft and the check say different things: ${c.conflict.replace('what went out', 'the draft')}.`);
  if (opts.dry_run) return { ok: true, written: false, message: `Dry run: ${id} would be saved as ready to send in ${channel}, thread ${ts}.`, channel, thread_ts: ts, log_url, check: dry.check };
  const { draft_text: _d, channel_id: _c, thread_ts: _t, ...check } = i;
  await query(
    `INSERT INTO engine_code_check_prepared (codex_entry_id, check_input, draft_text, channel, thread_ts, state, prepared_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, 'ready', $6)
     ON CONFLICT (codex_entry_id) DO UPDATE SET check_input = EXCLUDED.check_input, draft_text = EXCLUDED.draft_text, channel = EXCLUDED.channel,
       thread_ts = EXCLUDED.thread_ts, state = 'ready', prepared_by = EXCLUDED.prepared_by, prepared_at = now(), sent_ts = NULL, sent_link = NULL,
       sent_text = NULL, sent_differs = NULL, recorded_at = NULL, detail = NULL`,
    [id, JSON.stringify(check), draft, channel, ts, dry.check.recorded_by],
  );
  // The review is done once the check is drafted, so the card says so now. Sending is what records it.
  const review_card = await (opts.mark ?? reviewedOnCard)(dry.check, 'check drafted');
  return {
    ok: true, written: true, channel, thread_ts: ts, log_url, check: dry.check, review_card,
    message: `${id} is ready to send and ${review_card.ok ? 'its card is marked reviewed' : `its card could not be marked: ${review_card.detail}`}. Sending it from Slack records it; nothing else is needed.`,
  };
}

async function settle(id: string, state: string, detail: string, sent?: { ts: string; link: string; text: string; differs: boolean }): Promise<void> {
  await query(
    `UPDATE engine_code_check_prepared SET state = $2, detail = $3, sent_ts = COALESCE($4, sent_ts), sent_link = COALESCE($5, sent_link),
       sent_text = COALESCE($6, sent_text), sent_differs = COALESCE($7, sent_differs), recorded_at = CASE WHEN $2 = 'recorded' THEN now() ELSE recorded_at END
     WHERE codex_entry_id = $1`,
    [id, state, detail, sent?.ts ?? null, sent?.link ?? null, sent?.text ?? null, sent?.differs ?? null],
  );
}

/** A problem goes to the card's thread, among reviewers, never under the builder's log. */
async function raise(id: string, p: Prepared, text: string, post: Poster): Promise<void> {
  const card = await cardFor(id);
  const sent = card ? await post(card.channel, `<@${p.prepared_by}> ${text}`, undefined, card.ts) : { ok: false, detail: 'no card' };
  if (!sent.ok) {
    const dm = await slack.dm(p.prepared_by, text);
    if (!dm.ok) console.error(`[code-check-watch] could not raise on ${id}: ${text} (${dm.detail})`);
  }
}

/** Hours a saved check may sit unsent before the card's thread says so, once. */
export const UNSENT_AFTER_HOURS = 6;

/**
 * Marking the card at the draft stops its reminders, so a draft nobody sends would otherwise go quiet
 * while the log still waits. One line in the card's thread; the claim is an event, given back if the post fails.
 */
async function nudgeUnsent(id: string, p: Prepared, preparedEpoch: number, post: Poster, now = Date.now()): Promise<void> {
  if (now - preparedEpoch * 1000 < UNSENT_AFTER_HOURS * 3_600_000) return;
  const key = `code_check_unsent:${id}:${Math.floor(preparedEpoch)}`;
  const claim = await record({ event_type: 'code_check_draft_unsent', subject_id: id, lane: 'BAYS', actor: 'code-check-watch', detail: { prepared_at: p.prepared_at }, dedupe_key: key });
  if (!claim.recorded) return;
  const card = await cardFor(id);
  const sent = card ? await post(card.channel, `<@${p.prepared_by}> The code check on ${id} was drafted ${UNSENT_AFTER_HOURS} hours ago and has not been sent, so it is not recorded. Send it from your drafts.`, undefined, card.ts) : { ok: false, detail: 'no card' };
  if (!sent.ok) await query(`DELETE FROM engine_events WHERE dedupe_key = $1`, [key]);
}

export interface SentResult { ready: number; recorded: string[]; stopped: string[]; failed: string[]; unread: string[] }

/** One pass over the ready checks. Reads only those threads. */
export async function recordSent(opts: { post?: Poster; read?: typeof readSince; record?: typeof cc.recordCheck; after?: typeof afterRecord; now?: number } = {}): Promise<SentResult> {
  const post = opts.post ?? slackPost;
  const read = opts.read ?? readSince;
  const out: SentResult = { ready: 0, recorded: [], stopped: [], failed: [], unread: [] };
  // A claim a crashed pass left behind goes back; recording again is a correction, never a second check.
  await query(`UPDATE engine_code_check_prepared SET state = 'ready' WHERE state = 'recording' AND claimed_at < now() - interval '10 minutes'`);
  const rows = await query<Prepared & { check_input: cc.CheckInput; epoch: string }>(
    `SELECT codex_entry_id, check_input, draft_text, channel, thread_ts, state, prepared_by, prepared_at, extract(epoch from prepared_at)::text AS epoch
       FROM engine_code_check_prepared WHERE state = 'ready' ORDER BY prepared_at`,
  );
  out.ready = rows.rows.length;
  for (const row of rows.rows) {
    const id = row.codex_entry_id;
    const p: Prepared = { ...row, check: row.check_input };
    const after = Number(row.epoch);
    const seen = await read(row.channel, row.thread_ts, String(after));
    if (!seen.ok) {
      out.unread.push(id);
      await query(`UPDATE engine_code_check_prepared SET detail = $2 WHERE codex_entry_id = $1`, [id, seen.error]);
      continue;
    }
    const m = seen.messages.find((x) => isSentCheck(x, id, row.prepared_by, after));
    if (!m?.ts) {
      await nudgeUnsent(id, p, after, post, opts.now);
      continue;
    }
    const claim = await query(`UPDATE engine_code_check_prepared SET state = 'recording', claimed_at = now() WHERE codex_entry_id = $1 AND state = 'ready' RETURNING 1`, [id]);
    if (!claim.rows.length) continue;
    const sentText = m.text ?? '';
    const link = `${WORKSPACE()}/archives/${row.channel}/p${m.ts.replace('.', '')}?thread_ts=${row.thread_ts}&cid=${row.channel}`;
    const check = row.check_input as cc.CheckInput;
    const cmp = compareSent(row.draft_text, sentText, check.verdict as cc.Verdict, check.pay_call as cc.PayCall, check.approve as cc.Approve | undefined);
    const sent = { ts: m.ts, link, text: sentText, differs: !cmp.same };
    if (cmp.conflict) {
      const text = `The check on ${id} went out, but ${cmp.conflict}, so it was not recorded: the record would disagree with the thread. Prepare it again with what it should say. ${link}`;
      await settle(id, 'stopped', cmp.conflict, sent);
      await raise(id, p, text, post);
      out.stopped.push(id);
      continue;
    }
    try {
      const r = await (opts.record ?? cc.recordCheck)({ ...check, check_link: link, posted_at: new Date(Number(m.ts) * 1000).toISOString(), requester_user_id: row.prepared_by });
      const a = await (opts.after ?? afterRecord)(r.check);
      const notes = [
        a.codex_note.ok ? 'Codex' : null,
        a.bharag_note.ok ? 'BHARAG' : null,
        a.review_card.ok ? 'the review card' : null,
      ].filter(Boolean);
      const missed = [a.codex_note.ok ? null : `Codex: ${a.codex_note.detail}`, a.bharag_note.ok ? null : `BHARAG: ${a.bharag_note.detail}`, a.review_card.ok ? null : `the card: ${a.review_card.detail}`].filter(Boolean);
      await settle(id, 'recorded', missed.length ? `not all landed: ${missed.join('; ')}` : 'recorded', sent);
      const line = `Recorded on ${notes.join(', ') || 'the Code checks tab'}.${cmp.same ? '' : ' Your edits are what stands in this thread; the verdict and pay call matched the saved check.'}`;
      const reply = await post(row.channel, line, undefined, row.thread_ts);
      if (!reply.ok) console.error(`[code-check-watch] ${id} recorded, confirmation not posted: ${reply.detail}`);
      if (missed.length) await raise(id, p, `The check on ${id} is recorded, but ${missed.join('; ')}. ${link}`, post);
      out.recorded.push(id);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await settle(id, 'failed', detail, sent);
      await raise(id, p, `The check on ${id} went out and could not be recorded: ${detail} ${link}`, post);
      out.failed.push(id);
    }
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
  return reviewedOnCard(check, `check recorded: ${cc.VERDICT_LABEL[check.verdict as cc.Verdict] ?? check.verdict}`);
}

/** Marks the card reviewed. Never throws: neither a save nor a recorded check fails over a card. */
export async function reviewedOnCard(check: cc.CodeCheck, via: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await markReviewed({ id: check.codex_entry_id, user_id: check.recorded_by, via, tell: false });
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
export async function codexNote(check: cc.CodeCheck, opts: { full_text?: string | null } = {}): Promise<{ ok: boolean; row_id: string | null; detail: string }> {
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
        ...(check.bays_summary ? { 'Code Check Approve': check.bays_summary.approve, 'Code Check Why': check.bays_summary.why, 'Code Check Lane Goal': check.bays_summary.lane_goal, 'Code Check Lane': check.bays_summary.lane_check } : {}),
        'Code Check Link': check.check_link,
        'Code Check At': check.posted_at,
        'Code Check By': check.recorded_by,
        // The whole check, when the log's thread carries only the short version (7 Nov 2026, Destiny).
        ...(opts.full_text?.trim() ? { 'Code Check Full': opts.full_text.trim() } : {}),
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
export async function bharagNote(check: cc.CodeCheck, opts: { dry_run?: boolean; full_text?: string | null } = {}): Promise<{ ok: boolean; documents: string[]; edited: string[]; detail: string }> {
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
        summary: check.bays_summary,
        not_confirmed: check.claims.filter((x) => x.result !== 'confirmed').map((x) => x.claim),
        missing: check.missing,
        link: check.check_link,
        at: check.posted_at,
        by: check.recorded_by,
        ...(opts.full_text?.trim() ? { full_text: opts.full_text.trim() } : {}),
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

/** The automatic check's pass, loaded late because codeCheckDraft imports this file. A failure never stops the watch. */
async function draftSweep(): Promise<void> {
  const d = await import('./codeCheckDraft');
  await d.sweep().catch((e) => console.error(`[code-check-draft] sweep failed: ${e instanceof Error ? e.message : String(e)}`));
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('code check watch');
    if (busy) return;
    busy = true;
    recordSent()
      .then((r) => {
        if (r.recorded.length || r.stopped.length || r.failed.length) console.log(`[code-check-watch] sent checks: recorded ${r.recorded.join(', ') || 'none'}; stopped ${r.stopped.join(', ') || 'none'}; failed ${r.failed.join(', ') || 'none'}`);
        for (const id of r.unread) console.error(`[code-check-watch] the thread for ${id} could not be read; it stays ready`);
      })
      .catch((e) => console.error(`[code-check-watch] sent pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .then(() => run())
      .then((r) => draftSweep().then(() => r))
      .then((r) => {
        if (r.sent.length || r.failed.length) console.log(`[code-check-watch] ${r.waiting} waiting: sent ${r.sent.map((x) => `${x.codex_entry_id}#${x.step}`).join(', ') || 'none'}; failed ${r.failed.length}`);
      })
      .catch((e) => console.error(`[code-check-watch] pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.every_minutes * 60 * 1000);
  timer.unref();
}
