/**
 * The n8n Cloud plan's monthly execution quota, and the alerts that say how
 * close the engine is to it (2026-09-26, Jason and Destiny).
 *
 * **Why this exists.** On 26 Sep the 10,000-execution plan ran out at 14:28 UTC,
 * eleven days into the month, and n8n stopped starting every production run:
 * Bays, Research Twin, North Star and every schedule went quiet at once. There
 * was no error anywhere, because n8n refuses the run before it becomes an
 * execution, so nothing is logged and no error workflow fires. The only signal
 * was Bays not answering. Jason asked for alerts at 70%, 85% and 95% of the
 * quota, posted into Slack and logged to BHARAG, so the next cap is seen coming
 * instead of found through silence at the front door.
 *
 * **What n8n counts.** Only production executions: runs started by a webhook,
 * a schedule or polling trigger, a chat trigger, or an automatic retry.
 * Manual runs from the editor, sub-workflows called by another workflow
 * (`integrated`) and error-workflow runs are not billed
 * (https://docs.n8n.io/build/understand-workflows/understand-executions).
 * `COUNTED_MODES` is that rule, read against the `mode` n8n stores on every
 * execution, which is already on every row in `engine_execution_runs`.
 *
 * **It is this database's count, not n8n's.** n8n Cloud exposes no usage
 * figure over its API, so the used figure is the production rows held here
 * since the cycle began. It trails n8n by one poll and can differ from the
 * plan page slightly; the page says so.
 *
 * **Two settings, no defaults** — the rule every other variable here follows.
 * `N8N_EXECUTION_QUOTA` is the plan's monthly executions (50000 from 26 Sep).
 * `N8N_BILLING_CYCLE_START` is a day the plan's monthly count restarted, as
 * YYYY-MM-DD or a full ISO time; the cycle repeats monthly from it. A guessed
 * quota or cycle would put the alert lines in the wrong place, so with either
 * missing the page says "not configured" and nothing is sent.
 * `QUOTA_ALERT_CHANNEL` is the Slack channel id alerts go to, posted as Bays;
 * `QUOTA_ALERT_MENTIONS` optionally lists Slack user ids to tag.
 *
 * **Each line is announced once per cycle**, and only after Slack accepted it:
 * a post that fails is retried on the next check rather than marked sent. If
 * several lines are crossed at once, one message names the highest and every
 * line under it is marked with it, so a late start does not post three alerts.
 */
import { getMeta, nowIso, setMeta } from './db';
import { query } from './pg';
import * as slack from './slack';
import * as bharag from './bharag';
import type { ExecutionQuota, QuotaThreshold } from '../../src/data/types';

export const QUOTA_VAR = 'N8N_EXECUTION_QUOTA';
export const CYCLE_VAR = 'N8N_BILLING_CYCLE_START';
export const CHANNEL_VAR = 'QUOTA_ALERT_CHANNEL';
export const MENTIONS_VAR = 'QUOTA_ALERT_MENTIONS';

/** The execution modes n8n Cloud bills against the quota. Everything else is free. */
export const COUNTED_MODES = ['webhook', 'trigger', 'retry', 'chat'] as const;

/** Jason's three lines, plus the cap itself so the moment it is hit is said out loud too. */
export const THRESHOLDS = [70, 85, 95, 100] as const;

/** How often the poll's after-pass actually checks. The query is cheap; the point is not to re-read every 45 s. */
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** The pace is the last seven days, so one busy afternoon does not swing the projection. */
const PACE_DAYS = 7;

const LAST_ERROR = 'quota.last_error';
const ANNOUNCED = 'quota.monitor_announced';
const alertKey = (cycleStart: string, at: number) => `quota.alert.${cycleStart}.${at}`;

function dashboardUrl(): string {
  return (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
}

function quotaSetting(): number | null {
  const raw = process.env[QUOTA_VAR]?.trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The anchor as a day and the time of day it starts at, or null where unset or unreadable. */
function anchorSetting(): { day: string; time: string } | null {
  const raw = process.env[CYCLE_VAR]?.trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/);
  if (!m) return null;
  const t = m[2] ? (m[2].endsWith('Z') ? m[2] : `${m[2]}Z`) : 'T00:00:00Z';
  // Written the way n8n's own started_at is (…:00.000Z), so the string
  // comparison against the rows cannot slip at the millisecond.
  const parsed = new Date(`${m[1]}${t}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return { day: m[1], time: parsed.toISOString().slice(10) };
}

export function channelId(): string | null {
  return process.env[CHANNEL_VAR]?.trim() || null;
}

/** A day plus k months, with the day clamped to the month's length (31 Jan + 1 month = 28/29 Feb). */
function addMonths(day: string, k: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const total = m - 1 + k;
  const yy = y + Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The billing cycle that contains `now`: when it began and when the next one begins, both ISO. */
export function cycleOf(anchor: { day: string; time: string }, now: string): { start: string; resets: string } {
  const [ay, am] = anchor.day.split('-').map(Number);
  const [ny, nm] = now.slice(0, 7).split('-').map(Number);
  let k = (ny - ay) * 12 + (nm - am);
  let start = `${addMonths(anchor.day, k)}${anchor.time}`;
  if (start > now) {
    k -= 1;
    start = `${addMonths(anchor.day, k)}${anchor.time}`;
  }
  return { start, resets: `${addMonths(anchor.day, k + 1)}${anchor.time}` };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

interface AlertRecord {
  at: string;
  slack_link: string | null;
  bharag: string | null;
}

async function alertRecord(cycleStart: string, at: number): Promise<AlertRecord | null> {
  const raw = await getMeta(alertKey(cycleStart, at));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AlertRecord;
  } catch {
    return { at: raw, slack_link: null, bharag: null };
  }
}

/** This cycle's usage of the quota, from the rows held here. Never throws for a missing setting; says so instead. */
export async function usage(): Promise<ExecutionQuota> {
  const q = quotaSetting();
  const anchor = anchorSetting();
  const channel = channelId();
  const lastError = (await getMeta(LAST_ERROR)) || null;
  const empty: ExecutionQuota = {
    configured: false,
    note: '',
    quota: q,
    cycle_start: null,
    resets_on: null,
    used: null,
    not_counted: null,
    pct: null,
    per_day: null,
    projected: null,
    projected_pct: null,
    runs_out_on: null,
    thresholds: THRESHOLDS.map((at) => ({ at, crossed: false, alerted_at: null, slack_link: null, bharag: null })),
    channel,
    last_error: lastError,
  };
  if (q === null || anchor === null) {
    const missing = [q === null ? QUOTA_VAR : null, anchor === null ? CYCLE_VAR : null].filter(Boolean).join(' and ');
    return { ...empty, note: `${missing} ${missing.includes(' and ') ? 'are' : 'is'} not set on this server, so the quota cannot be measured and no alert can be sent.` };
  }

  const now = nowIso();
  const { start, resets } = cycleOf(anchor, now);
  const since = new Date(Date.now() - PACE_DAYS * 86_400_000).toISOString();
  const r = await query<{ used: string; other: string; recent: string }>(
    `SELECT count(*) FILTER (WHERE started_at >= $1 AND mode = ANY($3))::text                          AS used,
            count(*) FILTER (WHERE started_at >= $1 AND (mode IS NULL OR NOT (mode = ANY($3))))::text   AS other,
            count(*) FILTER (WHERE started_at >= $2 AND mode = ANY($3))::text                          AS recent
       FROM engine_execution_runs
      WHERE started_at >= LEAST($1, $2)`,
    [start, since, [...COUNTED_MODES]],
  );
  const used = Number(r.rows[0]?.used ?? 0);
  const notCounted = Number(r.rows[0]?.other ?? 0);
  const perDay = Math.round((Number(r.rows[0]?.recent ?? 0) / PACE_DAYS) * 10) / 10;
  const daysLeft = Math.max(0, (new Date(resets).getTime() - Date.now()) / 86_400_000);
  const projected = Math.round(used + perDay * daysLeft);
  let runsOut: string | null = null;
  if (used >= q) runsOut = now;
  else if (perDay > 0) {
    const at = new Date(Date.now() + ((q - used) / perDay) * 86_400_000).toISOString();
    if (at < resets) runsOut = at;
  }
  const pct = used / q;

  const thresholds: QuotaThreshold[] = [];
  for (const at of THRESHOLDS) {
    const rec = await alertRecord(start, at);
    thresholds.push({ at, crossed: pct * 100 >= at, alerted_at: rec?.at ?? null, slack_link: rec?.slack_link ?? null, bharag: rec?.bharag ?? null });
  }

  return {
    configured: true,
    note:
      `Counted from the executions this database copies from n8n, so it trails n8n by one poll and can differ slightly from the figure on n8n's plan page. ` +
      `Only production runs count: webhooks, schedules and polling triggers, chat triggers and automatic retries. Manual runs, sub-workflows and error-workflow runs are free.`,
    quota: q,
    cycle_start: start,
    resets_on: resets,
    used,
    not_counted: notCounted,
    pct,
    per_day: perDay,
    projected,
    projected_pct: projected / q,
    runs_out_on: runsOut,
    thresholds,
    channel,
    last_error: lastError,
  };
}

function mentions(): string {
  const ids = (process.env[MENTIONS_VAR] ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[UW][A-Z0-9]+$/.test(s));
  return ids.map((id) => `<@${id}>`).join(' ');
}

const ICON: Record<number, string> = { 70: ':large_yellow_circle:', 85: ':large_orange_circle:', 95: ':red_circle:', 100: ':rotating_light:' };

function paceLine(u: ExecutionQuota): string {
  if (u.per_day === null || u.resets_on === null || u.quota === null) return '';
  const pace = `At the last seven days' pace (about ${fmt(u.per_day)} a day)`;
  return u.runs_out_on && (u.used ?? 0) < u.quota
    ? `${pace} the quota runs out around *${dayLabel(u.runs_out_on)}*, before the reset on ${dayLabel(u.resets_on)}.`
    : `${pace} this cycle ends near ${fmt(u.projected ?? 0)} (${Math.round((u.projected_pct ?? 0) * 100)}%) when it resets on ${dayLabel(u.resets_on)}.`;
}

function alertText(u: ExecutionQuota, at: number): string {
  const head =
    at >= 100
      ? `${ICON[100]} *n8n execution quota reached — ${fmt(u.used ?? 0)} of ${fmt(u.quota ?? 0)}.* n8n is now refusing every production run: Bays, Research Twin, North Star and every schedule have stopped, and nothing will say so in their own logs.`
      : `${ICON[at] ?? ':warning:'} *n8n executions at ${Math.floor((u.pct ?? 0) * 100)}% of this month's quota* — ${fmt(u.used ?? 0)} of ${fmt(u.quota ?? 0)} used since ${dayLabel(u.cycle_start as string)}.`;
  const tail =
    at >= 100
      ? 'It clears when the plan resets or is raised.'
      : 'When it reaches 100%, n8n stops running Bays, Research Twin, North Star and every schedule, with no error anywhere.';
  return [head, paceLine(u), tail, `Executions page: ${dashboardUrl()}/executions`, mentions()].filter(Boolean).join('\n');
}

function liveText(u: ExecutionQuota): string {
  return [
    `:bar_chart: *n8n execution-quota monitor is live.* This cycle so far: ${fmt(u.used ?? 0)} of ${fmt(u.quota ?? 0)} production runs (${Math.round((u.pct ?? 0) * 1000) / 10}%), counting since ${dayLabel(u.cycle_start as string)}; resets ${dayLabel(u.resets_on as string)}.`,
    paceLine(u),
    `Alerts post here at ${THRESHOLDS.filter((t) => t < 100).join('%, ')}% and at the cap, and each is logged to BHARAG. Executions page: ${dashboardUrl()}/executions`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function post(channel: string, text: string): Promise<{ ok: true; link: string | null } | { ok: false; error: string }> {
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false });
  if (!r.ok) return { ok: false, error: `Slack refused the alert: ${String(r.error ?? 'unknown error')}` };
  const ts = typeof r.ts === 'string' ? r.ts : null;
  if (!ts) return { ok: true, link: null };
  const p = await slack.botCall('chat.getPermalink', { channel, message_ts: ts }, 'form');
  return { ok: true, link: p.ok && typeof p.permalink === 'string' ? p.permalink : null };
}

/** The same alert as a BHARAG document in Bays' workspace, so it is searchable next month. */
async function log(u: ExecutionQuota, label: string, text: string, link: string | null): Promise<string> {
  const doc: bharag.IngestDocument = {
    title: `n8n execution quota — ${label} — cycle from ${(u.cycle_start ?? '').slice(0, 10)}`,
    content: [
      `N8N EXECUTION QUOTA — ${label.toUpperCase()}`,
      `Recorded: ${nowIso()}`,
      `Cycle: ${u.cycle_start} to ${u.resets_on}`,
      `Used (production runs): ${u.used} of ${u.quota} (${Math.round((u.pct ?? 0) * 1000) / 10}%)`,
      `Not counted (manual, sub-workflow, error handler): ${u.not_counted}`,
      `Pace, last 7 days: ${u.per_day} a day; projected end of cycle ${u.projected} (${Math.round((u.projected_pct ?? 0) * 100)}%)`,
      `Runs out on: ${u.runs_out_on ?? 'not before the reset at this pace'}`,
      link ? `Slack: ${link}` : 'Slack: no permalink returned',
      '',
      'MESSAGE AS POSTED:',
      text,
      '',
      'WHY THIS IS RECORDED: on 26 Sep 2026 the 10k plan ran out eleven days into the month and n8n silently stopped every production run. These records are how the engine sees a cap coming. Counted by the BHA Engine Dashboard from its copy of n8n executions, so it can trail n8n by one poll.',
    ].join('\n'),
    source_type: 'manual',
    content_type: 'doc',
    project_tags: ['engine', 'n8n-quota', 'monitoring'],
    metadata: { kind: 'n8n_execution_quota', label, cycle_start: u.cycle_start, used: u.used, quota: u.quota, pct: u.pct, per_day: u.per_day, slack_link: link },
  };
  const r = await bharag.ingest('bays', doc);
  return r.ok ? r.detail : `not logged: ${r.detail}`;
}

let lastCheck = 0;
let checking: Promise<void> | null = null;

/**
 * Posts any line this cycle has crossed and not yet announced. Called after
 * every execution poll; its own throttle makes that one real check every five
 * minutes. `force` skips the throttle (the boot-time check).
 */
export function check(force = false): Promise<void> {
  if (checking) return checking;
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve();
  lastCheck = Date.now();
  checking = run().finally(() => {
    checking = null;
  });
  return checking;
}

async function run(): Promise<void> {
  const u = await usage();
  if (!u.configured || u.cycle_start === null) return;
  const pending = u.thresholds.filter((t) => t.crossed && !t.alerted_at);
  const announce = !(await getMeta(ANNOUNCED));
  if (!pending.length && !announce) return;

  const channel = channelId();
  if (!channel || !slack.slackConfigured()) {
    const missing = !channel ? CHANNEL_VAR : slack.SLACK_TOKEN_VAR;
    await setMeta(LAST_ERROR, `${missing} is not set on this server, so ${pending.length ? `the ${pending[pending.length - 1].at}% alert` : 'the monitor announcement'} could not be posted.`);
    return;
  }

  if (pending.length) {
    const top = pending[pending.length - 1].at;
    const text = alertText(u, top);
    const posted = await post(channel, text);
    if (!posted.ok) {
      await setMeta(LAST_ERROR, `${nowIso()} — ${posted.error}. It will be tried again on the next check.`);
      console.error('quota alert not posted:', posted.error);
      return;
    }
    const logged = await log(u, top >= 100 ? 'quota reached' : `${top}% reached`, text, posted.link);
    const record: AlertRecord = { at: nowIso(), slack_link: posted.link, bharag: logged };
    for (const t of pending) await setMeta(alertKey(u.cycle_start, t.at), JSON.stringify(record));
    await setMeta(LAST_ERROR, logged.startsWith('not logged') ? `${nowIso()} — the ${top}% alert posted to Slack but BHARAG ${logged}` : '');
    if (announce) await setMeta(ANNOUNCED, nowIso());
    return;
  }

  // First run with everything configured: say so once, which also proves the
  // Slack and BHARAG paths end to end rather than on the first real alert.
  const text = liveText(u);
  const posted = await post(channel, text);
  if (!posted.ok) {
    await setMeta(LAST_ERROR, `${nowIso()} — the monitor announcement was not posted: ${posted.error}`);
    return;
  }
  const logged = await log(u, 'monitor live', text, posted.link);
  await setMeta(ANNOUNCED, JSON.stringify({ at: nowIso(), slack_link: posted.link, bharag: logged }));
  await setMeta(LAST_ERROR, logged.startsWith('not logged') ? `${nowIso()} — the monitor announcement posted to Slack but BHARAG ${logged}` : '');
}
