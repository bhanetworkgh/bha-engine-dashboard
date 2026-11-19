/**
 * The Apify usage watch (19 Nov 2026, Destiny). BHA RSS uses Apify for YouTube transcripts and LinkedIn posts,
 * and on 19 Nov the free plan's $5 ran out mid-month with nothing saying so beforehand. This reads Apify's own
 * figures once an hour (APIFY_READ_TOKEN, read only) and posts one line in the engine alerts channel as Bays:
 *
 *   - when the month's usage passes 50%, 80% and 100% of what the plan includes, once each per cycle;
 *   - once per cycle, when the month is on pace to use more than the plan includes, with the day it runs out.
 *
 * Numbers live in RULE and nowhere else. It reads and posts; it starts, stops and changes nothing on Apify.
 * /users/me is read here only for the plan's included credit: nothing else from it is kept or returned,
 * because it carries the proxy password.
 */
import { getMeta, setMeta } from './db';
import * as engineEvents from './engineEvents';
import * as slack from './slack';
import * as quota from './quota';
import * as timers from './timers';

export const RULE = {
  thresholds: [50, 80, 100],
  /** No pace warning in the first days of a cycle: two days of use is too little to project from. */
  pace_after_days: 2,
  tick_minutes: 60,
};
const STATE_KEY = 'apify_usage.state';
const API = 'https://api.apify.com/v2';

export interface Snapshot {
  cycle_start: string;
  cycle_end: string;
  used_usd: number;
  included_usd: number | null;
  hard_limit_usd: number | null;
  plan: string | null;
}
export interface State { cycle_start: string; sent: string[] }
export interface Alert { key: string; text: string }

const usd = (n: number) => `$${n.toFixed(2)}`;
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Pure: what the month looks like, and the day it runs out at this pace (null when it does not). */
export function pace(s: Snapshot, now: Date): { elapsed_days: number; total_days: number; projected_usd: number; runs_out_on: string | null } {
  const start = new Date(s.cycle_start).getTime();
  const end = new Date(s.cycle_end).getTime();
  const total = Math.max(1, (end - start) / 86_400_000);
  const elapsed = Math.min(total, Math.max(0.01, (now.getTime() - start) / 86_400_000));
  const perDay = s.used_usd / elapsed;
  const projected = perDay * total;
  let runsOut: string | null = null;
  if (s.included_usd !== null && perDay > 0 && projected > s.included_usd) {
    runsOut = day(new Date(start + (s.included_usd / perDay) * 86_400_000).toISOString());
  }
  return { elapsed_days: elapsed, total_days: total, projected_usd: projected, runs_out_on: runsOut };
}

/** Pure: the alerts this reading owes, given what was already sent this cycle. */
export function judge(s: Snapshot, state: State | null, now: Date): Alert[] {
  if (s.included_usd === null || s.included_usd <= 0) return [];
  const sent = new Set(state && state.cycle_start === s.cycle_start ? state.sent : []);
  const pct = (s.used_usd / s.included_usd) * 100;
  const p = pace(s, now);
  const head = `Apify (BHA RSS's YouTube transcripts and LinkedIn posts): ${usd(s.used_usd)} of the ${usd(s.included_usd)} the ${s.plan ?? 'current'} plan includes is used, ${Math.round(pct)}%, in the cycle ${day(s.cycle_start)} to ${day(s.cycle_end)}.`;
  const out: Alert[] = [];
  const crossed = RULE.thresholds.filter((t) => pct >= t && !sent.has(`t${t}`));
  if (crossed.length) {
    const t = crossed[crossed.length - 1];
    const tail = t >= 100
      ? s.hard_limit_usd !== null && s.hard_limit_usd <= s.used_usd
        ? ' The usage limit is reached, so Apify is blocked: BHA RSS keeps saving items without transcripts or LinkedIn posts until the cycle resets or the limit goes up.'
        : ' Anything more this cycle is billed on top as pay as you go.'
      : p.runs_out_on ? ` At this pace it runs out on ${p.runs_out_on}.` : ' At this pace it lasts the cycle.';
    out.push({ key: `t${t}`, text: `${head}${tail}` });
    for (const c of crossed) sent.add(`t${c}`);
  }
  if (!sent.has('pace') && !out.length && p.elapsed_days >= RULE.pace_after_days && p.runs_out_on && pct < 100) {
    out.push({ key: 'pace', text: `${head} At this pace the month costs about ${usd(p.projected_usd)} and the included credit runs out on ${p.runs_out_on}. Fewer transcripts, or a higher plan, keeps it inside.` });
  }
  return out;
}

async function get(path: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Apify answered ${r.status} to ${path}: ${text.slice(0, 200)}`);
  return ((JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads Apify now. Throws with the reason when the token is unset or Apify refuses. */
export async function snapshot(): Promise<Snapshot> {
  const token = process.env.APIFY_READ_TOKEN?.trim();
  if (!token) throw new Error('APIFY_READ_TOKEN is not set, so Apify cannot be read');
  const limits = await get('/users/me/limits', token);
  const me = await get('/users/me', token);
  const cycle = (limits.monthlyUsageCycle ?? {}) as Record<string, unknown>;
  const current = (limits.current ?? {}) as Record<string, unknown>;
  const lim = (limits.limits ?? {}) as Record<string, unknown>;
  const plan = (me.plan ?? {}) as Record<string, unknown>;
  // One line per read: the figures only, and the field names when the plan's credit was not found,
  // so a missing figure says where to look rather than going quiet.
  console.log(`[apify-usage] cycle ${String(cycle.startAt)} to ${String(cycle.endAt)}; used ${String(current.monthlyUsageUsd)}; plan ${String(plan.id)} credit ${String(plan.monthlyUsageCreditsUsd)}; limit ${String(lim.maxMonthlyUsageUsd)}${num(plan.monthlyUsageCreditsUsd) === null ? `; plan fields: ${Object.keys(plan).join(',')}; current fields: ${Object.keys(current).join(',')}` : ''}`);
  return {
    cycle_start: String(cycle.startAt ?? ''),
    cycle_end: String(cycle.endAt ?? ''),
    used_usd: num(current.monthlyUsageUsd) ?? 0,
    included_usd: num(plan.monthlyUsageCreditsUsd),
    hard_limit_usd: num(lim.maxMonthlyUsageUsd),
    plan: typeof plan.id === 'string' ? plan.id : null,
  };
}

async function post(text: string): Promise<{ ok: boolean; error?: string }> {
  const channel = quota.channelId();
  if (!channel) return { ok: false, error: `${quota.CHANNEL_VAR} is not set` };
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set` };
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false });
  return r.ok ? { ok: true } : { ok: false, error: `Slack refused it: ${String(r.error ?? 'unknown error')}` };
}

/** One pass: read, judge, post what is owed. A post Slack refuses is not marked sent, so the next pass tries again. */
export async function check(now = new Date()): Promise<{ snapshot: Snapshot; posted: string[]; failed: string[] }> {
  const s = await snapshot();
  const raw = await getMeta(STATE_KEY);
  let state: State | null = null;
  try { state = raw ? (JSON.parse(raw) as State) : null; } catch { state = null; }
  const sent = state && state.cycle_start === s.cycle_start ? [...state.sent] : [];
  const posted: string[] = [];
  const failed: string[] = [];
  for (const a of judge(s, state, now)) {
    const r = await post(a.text);
    if (!r.ok) { failed.push(`${a.key}: ${r.error}`); continue; }
    posted.push(a.key);
    sent.push(a.key);
    // A threshold covers the ones under it, so they are not said again later this cycle.
    if (a.key.startsWith('t')) for (const t of RULE.thresholds) if (t <= Number(a.key.slice(1))) sent.push(`t${t}`);
    await engineEvents.record({ event_type: 'apify_usage_alert', subject_id: `apify:${day(s.cycle_start)}`, lane: 'GENIE', actor: 'apify-usage-watch', detail: { key: a.key, used_usd: s.used_usd, included_usd: s.included_usd, cycle_start: s.cycle_start, cycle_end: s.cycle_end } }).catch(() => undefined);
  }
  await setMeta(STATE_KEY, JSON.stringify({ cycle_start: s.cycle_start, sent: [...new Set(sent)] }));
  if (failed.length) console.error(`[apify-usage] alert not posted: ${failed.join('; ')}`);
  return { snapshot: s, posted, failed };
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startWatching(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('apify usage watch');
    if (busy || !process.env.APIFY_READ_TOKEN?.trim()) return;
    busy = true;
    check().catch((e) => console.error(`[apify-usage] ${e instanceof Error ? e.message : String(e)}`)).finally(() => (busy = false));
  };
  timer = setInterval(tick, RULE.tick_minutes * 60_000);
  timer.unref?.();
  setTimeout(tick, 90_000).unref?.();
}
