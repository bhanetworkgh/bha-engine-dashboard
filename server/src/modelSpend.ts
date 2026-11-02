/**
 * Model spend (2026-11-02, Destiny: "a record page for tracking token spending and costs").
 *
 * Until this, the only dollar figure the engine held was what OpenRouter's lifetime usage counter
 * read before and after each eval run. Nobody could answer "what did October cost": readings were
 * taken only when an eval ran. So:
 *
 *   - Every hour this process reads OpenRouter's /credits with its own key and keeps one row in
 *     engine_model_usage_readings: the account's total_usage (lifetime dollars spent, which only
 *     goes up) and total_credits (lifetime dollars bought). A top-up moves total_credits, never
 *     total_usage, so the difference between two readings is exactly what was spent between them.
 *   - Migration 111 copied in every reading the eval runs had already taken (from 11 Oct 2026).
 *
 * Dollars are measured, never estimated, except the per-agent split, which OpenRouter does not
 * give: that is the measured total shared out by each agent's token count and is labelled an
 * estimate wherever it is shown. The Anthropic backup has no balance API, so it is tokens and
 * refusals only, and says so.
 *
 * A day's figure is the counter interpolated at the day's two edges, only when a reading sits
 * within MAX_GAP_H of each edge; otherwise the day is "not measured", never nought.
 */
import { query } from './pg';
import * as timers from './timers';
import { ANTHROPIC_CREDIT_TEXT } from './creditOut';

const OPENROUTER_URL = (process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
export const RULE = { tick_minutes: 60, max_gap_hours: 6, days: 45 } as const;

interface Reading {
  at: string;
  total_usage_usd: number;
  total_credits_usd: number | null;
  origin: string;
}

/* ---------------------------------------------------------------- the reading */

export type ReadResult = { ok: true; reading: Reading } | { ok: false; error: string };

/** Reads OpenRouter's counter once and stores it. Never throws. */
export async function takeReading(): Promise<ReadResult> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { ok: false, error: 'OPENROUTER_API_KEY is not set on this server, so the usage counter cannot be read' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${OPENROUTER_URL}/credits`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    let body: { data?: { total_credits?: unknown; total_usage?: unknown } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      /* the status says what happened */
    }
    const used = Number(body.data?.total_usage);
    const bought = Number(body.data?.total_credits);
    if (!(res.status >= 200 && res.status < 300) || !Number.isFinite(used)) return { ok: false, error: `OpenRouter answered ${res.status} to the usage read: ${text.slice(0, 160) || 'no body'}` };
    const reading: Reading = { at: new Date().toISOString(), total_usage_usd: used, total_credits_usd: Number.isFinite(bought) ? bought : null, origin: 'hourly' };
    await query(
      `INSERT INTO engine_model_usage_readings (source, at, total_usage_usd, total_credits_usd, origin) VALUES ('openrouter', $1, $2, $3, 'hourly')
       ON CONFLICT (source, at) DO NOTHING`,
      [reading.at, used, reading.total_credits_usd],
    );
    return { ok: true, reading };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'OpenRouter did not answer the usage read within 10 seconds' : `the usage read failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

let timer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
export function startReading(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('model spend reading');
    takeReading()
      .then((r) => {
        lastError = r.ok ? null : r.error;
        if (!r.ok) console.error(`[model-spend] ${r.error}`);
      })
      .catch((e) => console.error(`[model-spend] reading failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, RULE.tick_minutes * 60_000);
  timer.unref();
}

/* ---------------------------------------------------------------- the maths, pure */

/** The counter at time t, by straight line between the readings either side, when both are close enough. */
export function usageAt(readings: Reading[], t: number, maxGapMs = RULE.max_gap_hours * 3600_000): number | null {
  let before: Reading | null = null;
  let after: Reading | null = null;
  for (const r of readings) {
    const at = Date.parse(r.at);
    if (at <= t && (!before || at > Date.parse(before.at))) before = r;
    if (at >= t && (!after || at < Date.parse(after.at))) after = r;
  }
  if (!before || !after) return null;
  const b = Date.parse(before.at);
  const a = Date.parse(after.at);
  if (t - b > maxGapMs || a - t > maxGapMs) return null;
  if (a === b) return before.total_usage_usd;
  return before.total_usage_usd + ((after.total_usage_usd - before.total_usage_usd) * (t - b)) / (a - b);
}

export interface Day {
  day: string;
  spent_usd: number | null;
  measured: boolean;
}

/** One figure per UTC day from `from` to `to` (YYYY-MM-DD), null where the counter was not read near both edges. */
export function dailySpend(readings: Reading[], from: string, to: string): Day[] {
  const out: Day[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    const end = Math.min(d + 86_400_000, Date.now());
    const a = usageAt(readings, d);
    const b = usageAt(readings, end);
    const ok = a !== null && b !== null && b >= a;
    out.push({ day: new Date(d).toISOString().slice(0, 10), spent_usd: ok ? Math.round((b! - a!) * 100) / 100 : null, measured: ok });
  }
  return out;
}

/** Spend between two instants, from the readings nearest each (no interpolation limit), with what it rests on. */
export function spendBetween(readings: Reading[], fromMs: number, toMs: number): { spent_usd: number; from: string; to: string } | null {
  const sorted = [...readings].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const first = sorted.find((r) => Date.parse(r.at) >= fromMs);
  const last = [...sorted].reverse().find((r) => Date.parse(r.at) <= toMs);
  if (!first || !last || Date.parse(last.at) <= Date.parse(first.at)) return null;
  return { spent_usd: Math.round((last.total_usage_usd - first.total_usage_usd) * 100) / 100, from: first.at, to: last.at };
}

/** Eval windows merged where they overlap, so a dollar spent during two runs is counted once. */
export function mergedEvalSpend(runs: Array<{ before: number; after: number; start: number; end: number }>): number {
  const s = [...runs].filter((r) => Number.isFinite(r.before) && Number.isFinite(r.after)).sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: { start: number; end: number; lo: number; hi: number } | null = null;
  for (const r of s) {
    if (cur && r.start <= cur.end) {
      cur.end = Math.max(cur.end, r.end);
      cur.lo = Math.min(cur.lo, r.before);
      cur.hi = Math.max(cur.hi, r.after);
    } else {
      if (cur) total += cur.hi - cur.lo;
      cur = { start: r.start, end: r.end, lo: r.before, hi: r.after };
    }
  }
  if (cur) total += cur.hi - cur.lo;
  return Math.round(total * 100) / 100;
}

/* ---------------------------------------------------------------- the read */

const ASK_TABLES: Array<[string, string]> = [
  ['bays', 'engine_bays_asks'],
  ['north_star', 'engine_ns_asks'],
  ['research_twin', 'engine_rt_asks'],
];

export async function read(opts: { days?: number } = {}) {
  const days = Math.min(Math.max(Math.floor(opts.days ?? RULE.days), 1), 120);
  const now = Date.now();
  const since = new Date(now - days * 86_400_000).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);
  const fromDay = since.slice(0, 10);

  const r = await query<{ at: Date; total_usage_usd: string; total_credits_usd: string | null; origin: string }>(
    `SELECT at, total_usage_usd, total_credits_usd, origin FROM engine_model_usage_readings WHERE source = 'openrouter' ORDER BY at`,
  );
  const readings: Reading[] = r.rows.map((x) => ({
    at: new Date(x.at).toISOString(),
    total_usage_usd: Number(x.total_usage_usd),
    total_credits_usd: x.total_credits_usd === null ? null : Number(x.total_credits_usd),
    origin: x.origin,
  }));
  const latest = readings[readings.length - 1] ?? null;
  const daily = dailySpend(readings, fromDay, today);
  const measuredDays = daily.filter((d) => d.measured);
  const sum = (ds: Day[]) => Math.round(ds.reduce((a, d) => a + (d.spent_usd ?? 0), 0) * 100) / 100;
  const last7 = daily.slice(-7);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthDays = daily.filter((d) => d.day >= monthStart);

  // Tokens per agent and day, from the ask ledgers.
  const tok = await query<{ agent: string; day: string; asks: string; with_tokens: string; tokens: string; p50: string | null; p95: string | null }>(
    ASK_TABLES.map(
      ([agent, table]) => `SELECT '${agent}' AS agent, left(created_time, 10) AS day, count(*) AS asks,
              count(*) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$') AS with_tokens,
              coalesce(sum((fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$'), 0) AS tokens,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$') AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$') AS p95
         FROM ${table} WHERE created_time >= $1 GROUP BY 2`,
    ).join(' UNION ALL '),
    [since],
  );
  const byAgentDay = tok.rows.map((x) => ({ agent: x.agent, day: x.day, asks: Number(x.asks), with_tokens: Number(x.with_tokens), tokens: Number(x.tokens), p50: x.p50 === null ? null : Math.round(Number(x.p50)), p95: x.p95 === null ? null : Math.round(Number(x.p95)) }));

  const agentTotals = await query<{ agent: string; asks: string; tokens: string; p50: string | null; p95: string | null }>(
    ASK_TABLES.map(
      ([agent, table]) => `SELECT '${agent}' AS agent, count(*) AS asks,
              coalesce(sum((fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$'), 0) AS tokens,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$') AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$') AS p95
         FROM ${table} WHERE created_time >= $1`,
    ).join(' UNION ALL '),
    [since],
  );

  const bySource = await query<{ source: string; asks: string; tokens: string; p50: string | null }>(
    `SELECT coalesce(fields->>'Source', '(none)') AS source, count(*) AS asks,
            coalesce(sum((fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$'), 0) AS tokens,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY (fields->>'Total Tokens')::bigint) FILTER (WHERE fields->>'Total Tokens' ~ '^[0-9]+$') AS p50
       FROM engine_bays_asks WHERE created_time >= $1 GROUP BY 1 ORDER BY 3 DESC`,
    [since],
  );

  // Eval runs: each run's own before/after, and the merged total.
  const ev = await query<{ at: Date; detail: Record<string, unknown> }>(`SELECT at, detail FROM engine_events WHERE event_type = 'eval_run_cost' AND at >= $1 ORDER BY at DESC`, [since]);
  const evalRuns = ev.rows.map((e) => {
    const d = e.detail ?? {};
    return {
      run_id: String(d.run_id ?? ''),
      at: new Date(e.at).toISOString(),
      started_at: d.started_at ? String(d.started_at) : null,
      spent_usd: Number(d.spent_usd ?? NaN),
      results: Number(d.results ?? NaN),
      answered_by: d.answered_by ?? null,
    };
  });
  const evalMerged = mergedEvalSpend(
    ev.rows.map((e) => {
      const d = e.detail ?? {};
      const end = new Date(e.at).getTime();
      return { before: Number(d.usage_before_usd), after: Number(d.usage_after_usd), start: d.started_at ? Date.parse(String(d.started_at)) : end, end };
    }),
  );

  // The Anthropic backup: answers it gave and refusals for credit. Tokens of its answers sit in the ask rows.
  const backup = await query<{ day: string; answered: string; failed: string }>(
    `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE (detail->>'fallback_ok')::boolean IS TRUE) AS answered,
            count(*) FILTER (WHERE (detail->>'fallback_ok')::boolean IS NOT TRUE) AS failed
       FROM engine_events WHERE event_type = 'ai_provider_fallback' AND at >= $1 GROUP BY 1 ORDER BY 1`,
    [since],
  );
  const refusals = await query<{ n: string; last: string | null }>(
    `SELECT count(*) AS n, max(created_time) AS last FROM (${ASK_TABLES.map(([, t]) => `SELECT created_time, fields FROM ${t}`).join(' UNION ALL ')}) a
      WHERE created_time >= $1 AND coalesce(fields->>'Error', '') ~* $2`,
    [since, ANTHROPIC_CREDIT_TEXT],
  );

  // Per-agent dollars: the measured spend in the window less the eval windows, shared by token count. An estimate.
  const windowSpend = spendBetween(readings, Date.parse(since), now);
  const totals = agentTotals.rows.map((x) => ({ agent: x.agent, asks: Number(x.asks), tokens: Number(x.tokens), p50: x.p50 === null ? null : Math.round(Number(x.p50)), p95: x.p95 === null ? null : Math.round(Number(x.p95)) }));
  const allTokens = totals.reduce((a, x) => a + x.tokens, 0);
  const shareable = windowSpend ? Math.max(0, windowSpend.spent_usd - evalMerged) : null;
  const agents = totals.map((x) => ({
    ...x,
    est_usd: shareable === null || !allTokens ? null : Math.round(((shareable * x.tokens) / allTokens) * 100) / 100,
  }));

  return {
    window: { days, since, readings_held: readings.length, first_reading: readings[0]?.at ?? null },
    openrouter: {
      latest: latest ? { at: latest.at, total_usage_usd: latest.total_usage_usd, remaining_usd: latest.total_credits_usd === null ? null : Math.round((latest.total_credits_usd - latest.total_usage_usd) * 100) / 100, origin: latest.origin } : null,
      last_read_error: lastError,
      last_7_days_usd: sum(last7),
      last_7_days_measured: last7.filter((d) => d.measured).length,
      month_to_date_usd: sum(monthDays),
      month_to_date_measured: monthDays.filter((d) => d.measured).length,
      month_days: monthDays.length,
      per_day_usd: measuredDays.length ? Math.round((sum(measuredDays) / measuredDays.length) * 100) / 100 : null,
      window_usd: windowSpend,
      daily,
    },
    evals: { runs: evalRuns, merged_usd: evalMerged, runs_counted: evalRuns.length },
    agents,
    by_agent_day: byAgentDay,
    bays_by_source: bySource.rows.map((x) => ({ source: x.source, asks: Number(x.asks), tokens: Number(x.tokens), p50: x.p50 === null ? null : Math.round(Number(x.p50)) })),
    anthropic_backup: {
      by_day: backup.rows.map((x) => ({ day: x.day, answered: Number(x.answered), failed: Number(x.failed) })),
      credit_refusals: Number(refusals.rows[0]?.n ?? 0),
      last_refusal_at: refusals.rows[0]?.last ?? null,
      note: 'Anthropic has no balance or usage API for this account, so the backup is shown as answers and refusals, never dollars. Its free $100 returns on the 16th.',
    },
    notes: [
      'Dollars are OpenRouter\'s own lifetime usage counter, read every hour (and, before 2 Nov 2026, only around eval runs). A day with no reading near both its edges is not measured, never nought.',
      'The per-agent dollars are an estimate: the measured spend for the window, less the eval runs, shared out by each agent\'s token count. Other model calls on the account (the extractors, pattern drafts, voice notes) sit inside it.',
      'Eval spend merges overlapping runs, so a dollar spent while two runs were going is counted once. Asks answered during a run are inside its window, so it is an upper bound.',
    ],
  };
}
