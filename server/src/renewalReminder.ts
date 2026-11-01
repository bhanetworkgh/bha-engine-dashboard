/**
 * Renewal reminders for the tools BHA pays for (1 Nov 2026, Destiny).
 *
 * **Why this exists.** n8n Cloud renewed at 00:00 UTC on 1 Nov 2026 against a card with no funds.
 * The charge failed, the workspace went offline at about 00:41 UTC (404 "No instance here", then
 * 503 "Workspace offline"), and Bays and every workflow stopped until Destiny moved funds and
 * resubscribed at about 06:07 UTC. Nothing said in advance that a renewal was coming, so a bank
 * transfer that takes days had no time to land.
 *
 * **What it does.** Every hour it reads the System Registry's services. For every active tool with
 * a renewal date it posts one Block Kit card in #bha-engine-alerts at 7 days, 3 days and 1 day
 * before that date, tagging Destiny and Jason, naming the amount and which card pays. If the
 * check starts late (a date entered 2 days out), only the nearest stage posts: the card for 3 days.
 * The card for 1 day also covers a renewal that is today.
 *
 * **Once each, and never silently lost.** Each stage is claimed as an engine event
 * (`registry_renewal_alert_sent`, keyed on the tool, its renewal date and the stage) before the
 * post. A post Slack refuses gives the claim back, so the next hour tries again, writes
 * `registry_renewal_alert_failed` and DMs Destiny once a day per stage, so a failure is never quiet.
 *
 * **Dates roll forward.** Once a renewal date has passed (the day after it), a monthly, quarterly
 * or yearly tool's date moves on by its cycle through the registry's own update, written as
 * `registry_renewal_rolled_forward`. That way the next month's reminder needs nobody to remember.
 * A one-off or cycle-less date is left alone.
 *
 * It reads the registry and writes events, Slack posts and the rolled date; it changes nothing else.
 */
import { query } from './pg';
import { record } from './engineEvents';
import * as registry from './registry';
import * as slack from './slack';
import * as timers from './timers';

export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';
/** Days before a renewal date that each get one card, nearest last. */
export const STAGES = [7, 3, 1] as const;
export const EVERY_MINUTES = 60;
const DAY = 86_400_000;

export const CHANNEL_VAR = 'RENEWAL_ALERT_CHANNEL';
/** #bha-engine-alerts, where the n8n quota alerts already go. */
export const DEFAULT_CHANNEL = 'C0ASVQQ8CH3';

export function channelId(): string {
  return process.env[CHANNEL_VAR]?.trim() || process.env.QUOTA_ALERT_CHANNEL?.trim() || DEFAULT_CHANNEL;
}

function dashboardUrl(): string {
  return (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
}

export interface Service {
  id: string;
  name: string;
  url?: string | null;
  plan?: string | null;
  managed_by?: string | null;
  billing_owner?: string | null;
  paid_with?: string | null;
  cost_amount?: number | string | null;
  cost_currency?: string | null;
  billing_cycle?: string | null;
  renewal_date?: string | null;
  status?: string | null;
  what_it_is_for?: string | null;
  deleted_at?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `today` to `date`, both YYYY-MM-DD, read as UTC calendar days. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}

/** The stage due for a renewal `days` away: the nearest stage it is inside, or null (too far, or past). */
export function stageFor(days: number): number | null {
  if (days < 0) return null;
  for (const s of [...STAGES].sort((a, b) => a - b)) if (days <= s) return s;
  return null;
}

export const dedupeKey = (s: Service, stage: number) => `renewal:${s.id}:${s.renewal_date}:${stage}`;

/** A day plus k months, the day clamped to the month's length (31 Jan + 1 = 28/29 Feb). */
function addMonths(day: string, k: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const total = m - 1 + k;
  const yy = y + Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const CYCLE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * The next renewal date for a date that has passed, by the tool's cycle, or null where it has not
 * passed or has no repeating cycle. Steps from the original date so a 31st stays the month's end.
 */
export function nextRenewal(date: string, cycle: string | null | undefined, today: string): string | null {
  const months = CYCLE_MONTHS[String(cycle ?? '').toLowerCase()];
  if (!months || !DATE.test(date) || daysUntil(date, today) >= 0) return null;
  let k = months;
  let next = addMonths(date, k);
  while (daysUntil(next, today) < 0) {
    k += months;
    next = addMonths(date, k);
  }
  return next;
}

/** The active services with a renewal date, each with how far away it is and the stage due. */
export function due(services: Service[], today: string): Array<{ service: Service; days: number; stage: number }> {
  const out: Array<{ service: Service; days: number; stage: number }> = [];
  for (const s of services) {
    if (s.deleted_at || (s.status ?? 'active') !== 'active') continue;
    if (!s.renewal_date || !DATE.test(s.renewal_date)) continue;
    const days = daysUntil(s.renewal_date, today);
    const stage = stageFor(days);
    if (stage !== null) out.push({ service: s, days, stage });
  }
  return out;
}

/* ------------------------------------------------------------- the card */

const ICON: Record<number, string> = { 7: ':large_yellow_circle:', 3: ':large_orange_circle:', 1: ':red_circle:' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function whenText(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function amountText(s: Service): string {
  const n = s.cost_amount === null || s.cost_amount === undefined || s.cost_amount === '' ? null : Number(s.cost_amount);
  if (n === null || !Number.isFinite(n)) return 'Not recorded';
  const cur = (s.cost_currency || 'USD').toUpperCase();
  const money = cur === 'USD' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${cur}`;
  return s.billing_cycle ? `${money} ${s.billing_cycle}` : money;
}

type Block = Record<string, unknown>;

export function message(s: Service, days: number, stage: number, mentions = `<@${DESTINY}> <@${JASON}>`): { text: string; blocks: Block[] } {
  const when = whenText(days);
  const title = `${s.name} renews ${when}`;
  const paid = s.paid_with?.trim() || 'Not recorded';
  const purpose = s.what_it_is_for?.trim();
  const ask =
    stage === 1
      ? `*Last call: make sure the card has the funds today.* If the charge fails on ${dateLabel(s.renewal_date as string)}, ${s.name} stops${purpose ? ` and with it: ${purpose}` : ''}.`
      : `*Check the card has the funds before ${dateLabel(s.renewal_date as string)}.* A bank transfer can take days, so move money now rather than on the day. If the charge fails, ${s.name} stops.`;
  const links = [s.url ? `:credit_card: <${s.url}|Open ${s.name}>` : null, `:card_index_dividers: <${dashboardUrl()}/registry|System Registry>`].filter(Boolean).join('   ·   ');
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: `${ICON[stage] ?? ':hourglass:'} ${title}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: ask } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Renews*\n${dateLabel(s.renewal_date as string)}` },
        { type: 'mrkdwn', text: `*Amount*\n${amountText(s)}` },
        { type: 'mrkdwn', text: `*Paid with*\n${paid}` },
        { type: 'mrkdwn', text: `*Plan*\n${s.plan?.trim() || 'Not recorded'}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: links } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Renewal alerts post 7 days, 3 days and 1 day before each renewal date in the System Registry. ${mentions ? `cc ${mentions}` : ''}`.trim() }],
    },
  ];
  const text = `${title} (${dateLabel(s.renewal_date as string)}): ${amountText(s)}, paid with ${paid}. Check the card has the funds.`;
  return { text, blocks };
}

/* ------------------------------------------------------------ the sweep */

export type Post = (channel: string, msg: { text: string; blocks: Block[] }) => Promise<{ ok: boolean; detail: string; ts?: string }>;

const defaultPost: Post = async (channel, msg) => {
  const r = await slack.botCall('chat.postMessage', { channel, text: msg.text, blocks: msg.blocks, unfurl_links: false, unfurl_media: false });
  if (!r.ok) return { ok: false, detail: `Slack refused the renewal alert: ${String(r.error ?? 'unknown error')}` };
  return { ok: true, detail: 'posted', ts: typeof r.ts === 'string' ? r.ts : undefined };
};

export interface CheckOptions {
  today?: string;
  dry_run?: boolean;
  /** Post here instead of #bha-engine-alerts, without claiming the stage (proof runs in the sandbox). */
  channel_override?: string;
  /** Only this registry id. */
  only?: string;
  post?: Post;
  dm?: typeof slack.dm;
  services?: Service[];
}

export interface CheckResult {
  today: string;
  channel: string;
  rolled: Array<{ id: string; from: string; to: string }>;
  alerts: Array<{ id: string; name: string; renewal_date: string; days: number; stage: number; outcome: 'posted' | 'already_posted' | 'would_post' | 'post_failed'; detail?: string; ts?: string }>;
}

export async function check(opts: CheckOptions = {}): Promise<CheckResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const post = opts.post ?? defaultPost;
  const dm = opts.dm ?? slack.dm;
  const testRun = Boolean(opts.channel_override);
  const channel = opts.channel_override || channelId();
  let services = (opts.services ?? ((await registry.list('services')) as unknown as Service[])).filter((s) => !opts.only || s.id === opts.only);
  const out: CheckResult = { today, channel, rolled: [], alerts: [] };

  // 1. Roll passed dates forward (not on a dry or test run).
  if (!opts.dry_run && !testRun) {
    const next: Service[] = [];
    for (const s of services) {
      const to = s.renewal_date && (s.status ?? 'active') === 'active' && !s.deleted_at ? nextRenewal(s.renewal_date, s.billing_cycle, today) : null;
      if (!to) {
        next.push(s);
        continue;
      }
      const from = s.renewal_date as string;
      await registry.update('services', s.id, { renewal_date: to });
      await record({
        event_type: 'registry_renewal_rolled_forward',
        subject_id: s.id,
        lane: 'BAYS',
        actor: 'renewal reminder',
        detail: { from, to, cycle: s.billing_cycle },
        dedupe_key: `renewal-roll:${s.id}:${from}`,
      });
      out.rolled.push({ id: s.id, from, to });
      next.push({ ...s, renewal_date: to });
    }
    services = next;
  }

  // 2. One card per stage due.
  for (const { service: s, days, stage } of due(services, today)) {
    const base = { id: s.id, name: s.name, renewal_date: s.renewal_date as string, days, stage };
    const key = dedupeKey(s, stage);
    if (opts.dry_run) {
      const held = await query(`SELECT 1 FROM engine_events WHERE dedupe_key = $1`, [key]);
      out.alerts.push({ ...base, outcome: held.rows.length ? 'already_posted' : 'would_post' });
      continue;
    }
    const msg = message(s, days, stage);
    if (testRun) {
      const sent = await post(channel, msg);
      out.alerts.push({ ...base, outcome: sent.ok ? 'posted' : 'post_failed', detail: `test run, stage not claimed: ${sent.detail}`, ts: sent.ts });
      continue;
    }
    const claim = await record({
      event_type: 'registry_renewal_alert_sent',
      subject_id: s.id,
      lane: 'BAYS',
      actor: 'renewal reminder',
      detail: { renewal_date: s.renewal_date, stage, days, channel, amount: amountText(s), paid_with: s.paid_with ?? null },
      dedupe_key: key,
    });
    if (!claim.recorded) {
      out.alerts.push({ ...base, outcome: 'already_posted' });
      continue;
    }
    const sent = await post(channel, msg);
    if (!sent.ok) {
      // Give the claim back so the next hour tries again; never mark sent what nobody saw.
      await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
      const failed = await record({
        event_type: 'registry_renewal_alert_failed',
        subject_id: s.id,
        lane: 'BAYS',
        actor: 'renewal reminder',
        detail: { renewal_date: s.renewal_date, stage, error: sent.detail },
        dedupe_key: `renewal-failed:${s.id}:${s.renewal_date}:${stage}:${today}`,
      });
      if (failed.recorded) {
        const told = await dm(DESTINY, `The renewal alert for ${s.name} (${whenText(days)}, ${dateLabel(s.renewal_date as string)}) could not be posted in <#${channel}>: ${sent.detail}. It will be tried again every hour.`);
        if (!told.ok) console.error(`[renewal] the failure DM to Destiny about ${s.id} was not sent either: ${told.detail}`);
      }
      console.error(`[renewal] ${s.id} stage ${stage} not posted, will retry: ${sent.detail}`);
      out.alerts.push({ ...base, outcome: 'post_failed', detail: sent.detail });
      continue;
    }
    if (sent.ts) await query(`UPDATE engine_events SET detail = detail || jsonb_build_object('slack_ts', $2::text) WHERE id = $1`, [claim.id, sent.ts]).catch(() => undefined);
    out.alerts.push({ ...base, outcome: 'posted', ts: sent.ts });
  }
  return out;
}

/* ----------------------------------------------------------------- timer */

let timer: NodeJS.Timeout | null = null;
let busy = false;

function tick(): void {
  timers.beat('renewal reminder');
  if (busy) return;
  busy = true;
  check()
    .then((r) => {
      const said = [...r.rolled.map((x) => `${x.id} rolled to ${x.to}`), ...r.alerts.filter((a) => a.outcome !== 'already_posted').map((a) => `${a.id} ${a.stage}d ${a.outcome}`)];
      if (said.length) console.log(`[renewal] ${said.join(', ')}`);
    })
    .catch((e) => console.error(`[renewal] check failed: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => (busy = false));
}

export function startSweeping(): void {
  if (timer) return;
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, EVERY_MINUTES * 60 * 1000);
  timer.unref();
}
