/**
 * The agent maturity scorecard (2026-09-28, Destiny — Agent Upgrade Plan,
 * Phase 0). One row per quality dimension per scoring, in
 * `engine_agent_scorecard`, beside the live metrics that back the scores.
 *
 * Nothing on the page is typed in. A score is a row written by a re-score and
 * carries the evidence it was given for; a metric is counted from the engine's
 * own tables at read time. A metric whose instrumentation does not exist yet is
 * `null` with a note saying which plan step brings it, never a nought.
 */
import { query } from './pg';
import * as quota from './quota';
import type { AgentMetric, ScoreRow, ScorecardData } from '../../src/data/types';

const WINDOW_DAYS = 30;

async function ledger(table: string, agent: string): Promise<AgentMetric> {
  const r = await query<{ asks: string; delivered: string; thin: string; failed: string }>(
    `SELECT count(*)::text AS asks,
            count(*) FILTER (WHERE fields->>'Delivered' = 'Delivered')::text AS delivered,
            count(*) FILTER (WHERE fields->>'Outcome' = 'Thin')::text AS thin,
            count(*) FILTER (WHERE fields->>'Outcome' = 'Failed')::text AS failed
       FROM ${table}
      WHERE created_time >= to_char((now() - make_interval(days => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    [WINDOW_DAYS],
  );
  const row = r.rows[0];
  return {
    agent,
    asks: Number(row?.asks ?? 0),
    delivered: Number(row?.delivered ?? 0),
    thin: Number(row?.thin ?? 0),
    failed: Number(row?.failed ?? 0),
    window_days: WINDOW_DAYS,
    note: null,
  };
}

/**
 * The latest eval run (plan steps 3.2–3.4). A case passes only if every one of
 * its repeats passed — pass^k — so a flaky answer cannot average its way to a
 * pass. Null with a note until a run exists.
 */
/**
 * Only a finished run is scored (28 Sep, found by the independent re-score: the
 * figure read "1 of 1 passed" off a run two results in). From 28 Sep every result
 * carries 'Run Size', the number of results its run will write, so a run is
 * finished once it holds that many. The runs before that carry no size and count
 * as finished once 30 minutes pass with no new result. `where` narrows which
 * results a run must contain to be a candidate at all.
 */
async function latestCompleteRun(where = 'TRUE'): Promise<{ run: string | null; inProgress: string | null }> {
  const r = await query<{ run: string; complete: boolean }>(
    `WITH runs AS (
       SELECT fields->>'Run ID' AS run, count(*) AS n, max((fields->>'Run Size')::int) AS size,
              max(created_time) AS last, max(id) AS last_id,
              bool_or(${where}) AS relevant
         FROM engine_eval_runs GROUP BY 1
     )
     SELECT run, (CASE WHEN size IS NOT NULL THEN n >= size
                       ELSE last::timestamptz < now() - interval '30 minutes' END) AS complete
       FROM runs WHERE relevant ORDER BY last_id DESC LIMIT 5`,
  );
  const done = r.rows.find((x) => x.complete)?.run ?? null;
  const first = r.rows[0];
  return { run: done, inProgress: first && !first.complete ? first.run : null };
}

async function evalSummary(): Promise<ScorecardData['evals']> {
  const { run, inProgress } = await latestCompleteRun();
  const pending = inProgress ? ` Run ${inProgress} is still in progress and is not counted yet.` : '';
  if (!run) return { pass_rate: null, note: `No finished eval run yet. Run the n8n workflow Agent Evals — Runner.${pending}` };
  const r = await query<{ cases: string; passed: string; results: string; at: string | null }>(
    `WITH per_case AS (
       SELECT fields->>'Case ID' AS case_id, bool_and((fields->>'Passed') = 'true') AS ok, count(*) AS n, max(fields->>'Run At') AS at
         FROM engine_eval_runs WHERE fields->>'Run ID' = $1 GROUP BY 1
     )
     SELECT count(*)::text AS cases, count(*) FILTER (WHERE ok)::text AS passed, sum(n)::text AS results, max(at) AS at FROM per_case`,
    [run],
  );
  const row = r.rows[0];
  const cases = Number(row?.cases ?? 0);
  const passed = Number(row?.passed ?? 0);
  return {
    pass_rate: cases ? passed / cases : null,
    note: `${passed} of ${cases} cases passed in run ${run}${row?.at ? ` (${row.at.slice(0, 16).replace('T', ' ')} UTC)` : ''}; a case passes only if all its repeats pass (${row?.results ?? 0} results).${pending}`,
  };
}

/**
 * Prompt-injection tests (plan step 6.2): the `INJ-` cases plus the three
 * injection cases that came first (NS-03, RT-03, BAYS-03, plan step 1.5), read
 * from the latest eval run that carried any of them, pass^k like the rest.
 */
const INJECTION_CASES = "(fields->>'Case ID' LIKE 'INJ-%' OR fields->>'Case ID' IN ('NS-03', 'RT-03', 'BAYS-03'))";

async function injectionSummary(): Promise<ScorecardData['injection']> {
  const { run } = await latestCompleteRun(INJECTION_CASES);
  if (!run) return { pass_rate: null, note: 'No finished run has carried the injection tests yet. They are in the eval set; run Agent Evals — Runner.' };
  const r = await query<{ cases: string; passed: string; failed: string | null }>(
    `WITH per_case AS (
       SELECT fields->>'Case ID' AS case_id, bool_and((fields->>'Passed') = 'true') AS ok
         FROM engine_eval_runs WHERE fields->>'Run ID' = $1 AND ${INJECTION_CASES} GROUP BY 1
     )
     SELECT count(*)::text AS cases, count(*) FILTER (WHERE ok)::text AS passed,
            string_agg(case_id, ', ' ORDER BY case_id) FILTER (WHERE NOT ok) AS failed
       FROM per_case`,
    [run],
  );
  const row = r.rows[0];
  const cases = Number(row?.cases ?? 0);
  const passed = Number(row?.passed ?? 0);
  return {
    pass_rate: cases ? passed / cases : null,
    note: `${passed} of ${cases} injection cases passed in run ${run}${row?.failed ? `; failed: ${row.failed}` : ''}.`,
  };
}

/**
 * Time to resolve an incident (plan step 5.1, the part the data supports).
 * BHARAG records no resolved_at and no resolver, so the close is dated by the
 * last 3-minute ledger read that still saw the incident open: accurate to about
 * three minutes, and only for incidents that closed after that poll began
 * (2026-09-27 16:46 UTC). Five or more closing in the same minute is a bulk
 * sweep, not a resolution, and is left out. Never a mean.
 */
const LEDGER_POLL_SINCE = '2026-09-27T16:46:00Z';

async function resolveSummary(): Promise<ScorecardData['resolve']> {
  const r = await query<{ n: string; p50: string | null; p95: string | null; by_sev: string | null }>(
    `WITH closed AS (
       SELECT fields->>'severity' AS severity,
              extract(epoch FROM (last_seen_open::timestamptz - (fields->>'occurred_at')::timestamptz)) / 60 AS mins,
              date_trunc('minute', last_seen_open::timestamptz) AS closed_min
         FROM engine_incidents
        WHERE NOT open_now AND last_seen_open >= $1 AND fields->>'occurred_at' IS NOT NULL
     ), bulk AS (
       SELECT closed_min FROM closed GROUP BY 1 HAVING count(*) >= 5
     ), kept AS (
       SELECT * FROM closed WHERE closed_min NOT IN (SELECT closed_min FROM bulk)
     )
     SELECT count(*)::text AS n,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mins))::text AS p50,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY mins))::text AS p95,
            (SELECT string_agg(severity || ' ' || c, ', ') FROM (SELECT coalesce(severity, 'unknown') AS severity, count(*) AS c FROM kept GROUP BY 1) s) AS by_sev
       FROM kept`,
    [LEDGER_POLL_SINCE],
  );
  const row = r.rows[0];
  const n = Number(row?.n ?? 0);
  return {
    n,
    p50_minutes: n && row?.p50 !== null ? Number(row?.p50) : null,
    p95_minutes: n && row?.p95 !== null ? Number(row?.p95) : null,
    note: n
      ? `Over ${n} incident${n === 1 ? '' : 's'} closed since the 3-minute ledger poll began on 27 Sep (${row?.by_sev}). Dated by the last read that saw each open, so accurate to about 3 minutes; bulk closes (5+ in one minute) excluded. Who closed them is not recorded upstream.`
      : 'No incident has closed since the 3-minute ledger poll began on 27 Sep, so there is nothing to time yet.',
  };
}

export async function data(): Promise<ScorecardData> {
  const latest = await query<{ scored_on: string }>(`SELECT max(scored_on)::text AS scored_on FROM engine_agent_scorecard`);
  const scoredOn = latest.rows[0]?.scored_on ?? null;
  const scores = scoredOn
    ? (
        await query<Omit<ScoreRow, 'score' | 'floor' | 'goal'> & { score: string; floor: string; goal: string }>(
          `SELECT dimension, name, score::text, floor::text, goal::text, evidence, scored_on::text, source
             FROM engine_agent_scorecard WHERE scored_on = $1 ORDER BY dimension`,
          [scoredOn],
        )
      ).rows.map((s) => ({ ...s, score: Number(s.score), floor: Number(s.floor), goal: Number(s.goal) }))
    : [];
  const average = scores.length ? Math.round((scores.reduce((a, s) => a + s.score, 0) / scores.length) * 10) / 10 : null;
  const weakestRow = scores.length ? scores.reduce((w, s) => (s.score < w.score ? s : w), scores[0]) : null;
  const history = (
    await query<{ scored_on: string; average: string }>(
      `SELECT scored_on::text, round(avg(score), 1)::text AS average FROM engine_agent_scorecard GROUP BY scored_on ORDER BY scored_on`,
    )
  ).rows.map((h) => ({ scored_on: h.scored_on, average: Number(h.average) }));

  const agents: AgentMetric[] = [
    await ledger('engine_ns_asks', 'North Star'),
    await ledger('engine_rt_asks', 'Research Twin'),
    // Bays' own ledger since 28 Sep (plan step 2.5). Bays does not grade its
    // answers thin, so thin is null rather than a nought that would read as none.
    { ...(await ledger('engine_bays_asks', 'Bays')), thin: null, note: 'Recording since 28 Sep 2026. Bays does not grade answers as thin.' },
  ];

  const incidents = (
    await query<{ severity: string; open: string }>(
      `SELECT coalesce(fields->>'severity', 'unknown') AS severity, count(*)::text AS open
         FROM engine_incidents WHERE open_now GROUP BY 1 ORDER BY 2 DESC`,
    )
  ).rows.map((i) => ({ severity: i.severity, open: Number(i.open) }));

  let q: ScorecardData['quota'] = { used: null, quota: null, pct: null, note: null };
  try {
    const u = await quota.usage();
    q = { used: u.used ?? null, quota: u.quota ?? null, pct: typeof u.pct === 'number' ? u.pct : null, note: null };
  } catch (e) {
    q.note = `Quota could not be read: ${e instanceof Error ? e.message : String(e)}`;
  }

  const refusals = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM engine_mcp_writes WHERE at >= now() - interval '7 days' AND outcome IN ('refused', 'denied')`,
  );

  return {
    scored_on: scoredOn,
    average,
    weakest: weakestRow ? { dimension: weakestRow.dimension, name: weakestRow.name, score: weakestRow.score } : null,
    scores,
    history,
    agents,
    incidents,
    quota: q,
    mcp_refusals_7d: Number(refusals.rows[0]?.n ?? 0),
    evals: await evalSummary(),
    injection: await injectionSummary(),
    resolve: await resolveSummary(),
  };
}
