/**
 * What one day of the outside digest cost (20 Nov 2026, Destiny, after Jason approved Apify Starter in
 * C0ATC4CA3G9 1795126079.876419: "at the bottom of the daily digest, let it write the cost it took to get the
 * digest for that day, so by the end of the month we'll have a trackable way to see what every day costs").
 *
 * Two parts, each read from its own source and never guessed:
 *   - Apify, BHA RSS's YouTube transcripts and LinkedIn posts: the digest day's own line in Apify's
 *     /users/me/usage/monthly (dailyServiceUsages), read with APIFY_READ_TOKEN, plus the cycle so far up to that
 *     day and the plan's usage cap when the day is in the current cycle;
 *   - writing the digest: the OpenRouter cost BHA RSS reports for the model calls that wrote it (model_cost_usd).
 * A part that could not be read is null with the reason, and the card says so: never nought.
 * Stored on engine_outside_digests.cost, so a month of days can be added up, and shown at the foot of the card.
 */
const API = 'https://api.apify.com/v2';

export interface DigestCost {
  digest_date: string;
  apify: { day_usd: number | null; cycle_to_day_usd: number | null; cycle_start: string | null; cycle_end: string | null; cap_usd: number | null; error?: string };
  model: { usd: number | null; error?: string };
  total_usd: number | null;
  read_at: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dayOf = (iso: unknown): string => (typeof iso === 'string' ? iso.slice(0, 10) : '');

/** Pure: the Apify part for one day from a /users/me/usage/monthly answer and, when read, /users/me/limits. */
export function apifyPart(date: string, usage: Record<string, unknown>, limits?: Record<string, unknown> | null): DigestCost['apify'] {
  const cycle = (usage.usageCycle ?? {}) as Record<string, unknown>;
  const days = Array.isArray(usage.dailyServiceUsages) ? (usage.dailyServiceUsages as Array<Record<string, unknown>>) : [];
  const start = typeof cycle.startAt === 'string' ? cycle.startAt : null;
  const end = typeof cycle.endAt === 'string' ? cycle.endAt : null;
  const inCycle = Boolean(start && end && date >= dayOf(start) && date <= dayOf(end));
  if (!inCycle) return { day_usd: null, cycle_to_day_usd: null, cycle_start: start, cycle_end: end, cap_usd: null, error: `Apify's usage answer is for ${dayOf(start)} to ${dayOf(end)}, not a cycle holding ${date}` };
  const line = days.find((d) => dayOf(d.date) === date);
  // A day in the cycle with no line is a day Apify billed nothing for, which Apify itself states by leaving it out.
  const day = line ? num(line.totalUsageCreditsUsd) ?? 0 : 0;
  const toDay = days.filter((d) => dayOf(d.date) <= date).reduce((s, d) => s + (num(d.totalUsageCreditsUsd) ?? 0), 0);
  const lc = ((limits?.monthlyUsageCycle ?? {}) as Record<string, unknown>);
  const sameCycle = limits && dayOf(lc.startAt) === dayOf(start);
  const cap = sameCycle ? num(((limits!.limits ?? {}) as Record<string, unknown>).maxMonthlyUsageUsd) : null;
  return { day_usd: day, cycle_to_day_usd: toDay, cycle_start: start, cycle_end: end, cap_usd: cap };
}

/** Pure: the whole cost from its two parts. The total is given only when both parts were read. */
export function combine(date: string, apify: DigestCost['apify'], modelUsd: number | null, modelError?: string, now = new Date()): DigestCost {
  const model: DigestCost['model'] = modelUsd === null ? { usd: null, error: modelError ?? 'BHA RSS did not report the cost of writing this digest' } : { usd: modelUsd };
  const total = apify.day_usd !== null && model.usd !== null ? apify.day_usd + model.usd : null;
  return { digest_date: date, apify, model, total_usd: total, read_at: now.toISOString() };
}

export const usd = (n: number): string => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const short = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '?');

/** Pure: the line at the foot of the digest card. */
export function costLine(c: DigestCost | null | undefined): string {
  if (!c) return ':money_with_wings: Cost of this day: not read.';
  const a = c.apify.day_usd === null ? `Apify not read (${c.apify.error ?? 'no reason given'})` : `${usd(c.apify.day_usd)} Apify (transcripts and LinkedIn)`;
  const m = c.model.usd === null ? `digest writing not reported` : `${usd(c.model.usd)} writing the digest`;
  const total = c.total_usd === null ? '' : ` = *${usd(c.total_usd)}*`;
  const cycle = c.apify.cycle_to_day_usd === null
    ? ''
    : `  ·  Apify cycle ${short(c.apify.cycle_start)} to ${short(c.apify.cycle_end)}: ${usd(c.apify.cycle_to_day_usd)}${c.apify.cap_usd !== null ? ` of ${usd(c.apify.cap_usd)}` : ''} used to this day`;
  return `:money_with_wings: Cost of this day: ${a} + ${m}${total}${cycle}`;
}

async function get(path: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Apify answered ${r.status} to ${path.split('?')[0]}: ${text.slice(0, 200)}`);
  return ((JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
}

/** Reads Apify for the day and puts the two parts together. Never throws: a part it cannot read says why. */
export async function forDay(date: string, modelUsd: number | null): Promise<DigestCost> {
  const token = process.env.APIFY_READ_TOKEN?.trim();
  let apify: DigestCost['apify'];
  if (!token) {
    apify = { day_usd: null, cycle_to_day_usd: null, cycle_start: null, cycle_end: null, cap_usd: null, error: 'APIFY_READ_TOKEN is not set' };
  } else {
    try {
      const usage = await get(`/users/me/usage/monthly?date=${encodeURIComponent(date)}`, token);
      const limits = await get('/users/me/limits', token).catch(() => null);
      apify = apifyPart(date, usage, limits);
    } catch (e) {
      apify = { day_usd: null, cycle_to_day_usd: null, cycle_start: null, cycle_end: null, cap_usd: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return combine(date, apify, modelUsd);
}
