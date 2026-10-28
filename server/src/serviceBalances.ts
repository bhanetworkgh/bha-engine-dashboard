/**
 * The two balances the engine pays to keep running, read now (28 Oct 2026, Destiny): OpenRouter
 * (every agent's model) and Twilio (the Customer Service Twin's calls and texts). Bays asks for it
 * with `check_service_balances` when somebody asks in Slack.
 *
 * This server holds no OpenRouter or Twilio credential for this. n8n's `Engine — Service Balances`
 * (QZi2CUUzuc6namOd, `POST /webhook/engine-service-balances`, `x-dashboard-key`) reads both with
 * the credentials n8n already holds and answers `{checked_at, openrouter, twilio}`. Both reads are
 * free: nothing is spent asking.
 *
 * The floors are the SOP "Critical Service Credits": OpenRouter $15 (the eval runner's floor and
 * the research signals' floor), Twilio $10. They live here and nowhere else. A balance that could
 * not be read is `unreadable` with the reason, never a guess and never "ok".
 */
import * as n8n from './n8n';

export const FLOORS_USD = { openrouter: 15, twilio: 10 } as const;
export const WEBHOOK_PATH = '/webhook/engine-service-balances';
const TIMEOUT_MS = 30_000;

export type BalanceStatus = 'ok' | 'low' | 'unreadable';

export interface ServiceBalance {
  service: 'openrouter' | 'twilio';
  status: BalanceStatus;
  remaining_usd: number | null;
  floor_usd: number;
  currency: string;
  detail: string | null;
  total_credits_usd?: number | null;
  total_usage_usd?: number | null;
}

export interface Balances {
  ok: boolean;
  checked_at: string | null;
  openrouter: ServiceBalance;
  twilio: ServiceBalance;
  summary: string;
  reason?: string;
}

const num = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null;
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);

/** Pure: one service's answer from n8n, judged against its floor. */
export function judge(service: 'openrouter' | 'twilio', raw: unknown): ServiceBalance {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const floor = FLOORS_USD[service];
  const remaining = num(o.remaining_usd);
  const currency = str(o.currency) ?? 'USD';
  const base: ServiceBalance = { service, status: 'unreadable', remaining_usd: null, floor_usd: floor, currency, detail: null };
  if (service === 'openrouter') {
    base.total_credits_usd = num(o.total_credits_usd);
    base.total_usage_usd = num(o.total_usage_usd);
  }
  if (o.ok !== true || remaining === null) {
    return { ...base, detail: str(o.detail) ?? (raw ? 'n8n did not return a balance for it.' : 'n8n did not return this service at all.') };
  }
  if (currency !== 'USD') {
    return { ...base, remaining_usd: remaining, detail: `The balance is in ${currency}, and the floor is in USD, so it was not judged.` };
  }
  return { ...base, remaining_usd: remaining, status: remaining < floor ? 'low' : 'ok' };
}

const NAME = { openrouter: 'OpenRouter', twilio: 'Twilio' } as const;

/** Pure: one sentence per service, for Bays to quote. */
export function sentence(b: ServiceBalance): string {
  if (b.status === 'unreadable') return `${NAME[b.service]}: could not be read (${b.detail ?? 'no reason given'}).`;
  const money = `$${b.remaining_usd!.toFixed(2)}`;
  return b.status === 'low'
    ? `${NAME[b.service]}: ${money}, under the $${b.floor_usd} floor. Top it up.`
    : `${NAME[b.service]}: ${money}, above the $${b.floor_usd} floor.`;
}

export function fromAnswer(body: unknown): Balances {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const openrouter = judge('openrouter', o.openrouter);
  const twilio = judge('twilio', o.twilio);
  return {
    ok: openrouter.status !== 'unreadable' && twilio.status !== 'unreadable',
    checked_at: str(o.checked_at),
    openrouter,
    twilio,
    summary: `${sentence(openrouter)} ${sentence(twilio)}`,
  };
}

function unreadableBoth(reason: string, detail: string): Balances {
  const openrouter = judge('openrouter', { ok: false, detail });
  const twilio = judge('twilio', { ok: false, detail });
  return { ok: false, checked_at: null, openrouter, twilio, summary: `Neither balance could be read: ${detail}`, reason };
}

/** Reads both balances now, through n8n. Never throws: a failure is unreadable with the reason. */
export async function check(fetchImpl: typeof fetch = fetch): Promise<Balances> {
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) return unreadableBoth('not_configured', 'DASHBOARD_INBOUND_KEY is not set on this server, and the n8n balance webhook is authenticated by it.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${n8n.n8nHost()}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-dashboard-key': key },
      body: '{}',
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return unreadableBoth('webhook_refused', `n8n answered ${res.status} on ${WEBHOOK_PATH}: ${text.slice(0, 200) || 'no body'}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return unreadableBoth('bad_answer', `n8n's answer on ${WEBHOOK_PATH} was not JSON: ${text.slice(0, 200)}`);
    }
    return fromAnswer(body);
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return unreadableBoth('unreachable', timedOut ? `n8n did not answer within ${TIMEOUT_MS / 1000} seconds.` : `Could not reach n8n: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
