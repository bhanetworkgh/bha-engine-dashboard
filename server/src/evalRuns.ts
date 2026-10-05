/**
 * The eval history (2026-10-05, Destiny). `engine_eval_runs` holds every result
 * `Agent Evals — Runner` has ever written — one row per case per repeat — and
 * until now the dashboard showed only the latest run's pass rate. This reads
 * the whole ledger as runs, so a pass rate can be set beside the one before it
 * and a failed case can be opened on the day it failed.
 *
 * The rules are the scorecard's own (`scorecard.ts`): **a case passes only if
 * every repeat passed**, and a run is finished once it holds `Run Size` results
 * (or, for the runs before 28 Sep that carry no size, once 30 minutes pass with
 * no new result). An unfinished run is listed and marked, never scored as final.
 * A read and nothing else.
 */
import { query } from './pg';

export interface EvalRunRow {
  run_id: string;
  started_at: string | null;
  finished_at: string | null;
  execution: string | null;
  results: number;
  run_size: number | null;
  complete: boolean;
  /** Not finished and no result for 30 minutes: the run stopped part-way. */
  stalled: boolean;
  cases: number;
  passed: number;
  failed_cases: string[];
  by_agent: Array<{ agent: string; cases: number; passed: number }>;
}

export async function runs(): Promise<{ runs: EvalRunRow[]; results: number; first_run_at: string | null }> {
  const r = await query<{
    run_id: string; started_at: string | null; finished_at: string | null; execution: string | null; results: number; run_size: number | null;
    complete: boolean; stalled: boolean; cases: number; passed: number; failed_cases: string[] | null; by_agent: EvalRunRow['by_agent'] | null;
  }>(
    `WITH per_case AS (
       SELECT fields->>'Run ID' AS run_id, fields->>'Case ID' AS case_id, coalesce(fields->>'Agent', '(not named)') AS agent,
              bool_and((fields->>'Passed') = 'true') AS ok
         FROM engine_eval_runs GROUP BY 1, 2, 3
     ), per_agent AS (
       SELECT run_id, jsonb_agg(jsonb_build_object('agent', agent, 'cases', n, 'passed', ok) ORDER BY agent) AS by_agent
         FROM (SELECT run_id, agent, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok FROM per_case GROUP BY 1, 2) a GROUP BY 1
     ), cases AS (
       SELECT run_id, count(*)::int AS cases, count(*) FILTER (WHERE ok)::int AS passed,
              array_agg(case_id ORDER BY case_id) FILTER (WHERE NOT ok) AS failed_cases
         FROM per_case GROUP BY 1
     ), runs AS (
       SELECT fields->>'Run ID' AS run_id, min(fields->>'Run At') AS started_at, max(fields->>'Run At') AS finished_at,
              max(fields->>'Execution') AS execution, count(*)::int AS results, max((fields->>'Run Size')::int) AS run_size,
              max(created_time)::timestamptz AS last, max(id) AS last_id
         FROM engine_eval_runs GROUP BY 1
     )
     SELECT r.run_id, r.started_at, r.finished_at, r.execution, r.results, r.run_size,
            (CASE WHEN r.run_size IS NOT NULL THEN r.results >= r.run_size ELSE r.last < now() - interval '30 minutes' END) AS complete,
            (r.run_size IS NOT NULL AND r.results < r.run_size AND r.last < now() - interval '30 minutes') AS stalled,
            c.cases, c.passed, c.failed_cases, a.by_agent
       FROM runs r JOIN cases c USING (run_id) JOIN per_agent a USING (run_id)
      ORDER BY r.last_id DESC`,
  );
  const list = r.rows.map((x) => ({ ...x, failed_cases: x.failed_cases ?? [], by_agent: x.by_agent ?? [] }));
  return {
    runs: list,
    results: list.reduce((n, x) => n + x.results, 0),
    first_run_at: list.length ? list[list.length - 1].started_at : null,
  };
}

/** One run, case by case: every repeat with its checks, failed cases first. Answers are cut at 4,000 characters and say so. */
export async function run(runId: string) {
  const r = await query<{
    result_id: string | null; case_id: string | null; agent: string | null; repeat: number | null; passed: boolean; question: string | null;
    answer: string | null; answer_chars: number | null; failed_checks: string | null; checks: string | null; run_at: string | null; execution: string | null;
  }>(
    `SELECT fields->>'Result ID' AS result_id, fields->>'Case ID' AS case_id, fields->>'Agent' AS agent,
            nullif(fields->>'Repeat', '')::int AS repeat, (fields->>'Passed') = 'true' AS passed, fields->>'Question' AS question,
            left(fields->>'Answer', 4000) AS answer, length(fields->>'Answer') AS answer_chars,
            nullif(fields->>'Failed Checks', '') AS failed_checks, fields->>'Checks' AS checks,
            fields->>'Run At' AS run_at, fields->>'Execution' AS execution
       FROM engine_eval_runs WHERE fields->>'Run ID' = $1
      ORDER BY fields->>'Case ID', nullif(fields->>'Repeat', '')::int`,
    [runId],
  );
  const byCase = new Map<string, typeof r.rows>();
  for (const x of r.rows) {
    const k = x.case_id ?? '(no case id)';
    byCase.set(k, [...(byCase.get(k) ?? []), x]);
  }
  const cases = [...byCase.entries()]
    .map(([case_id, repeats]) => ({
      case_id,
      agent: repeats[0].agent,
      question: repeats[0].question,
      passed: repeats.every((x) => x.passed),
      repeats: repeats.map((x) => {
        let checks: Array<{ name: string; ok: boolean; detail: string }> = [];
        try {
          const parsed: unknown = x.checks ? JSON.parse(x.checks) : [];
          if (Array.isArray(parsed)) checks = parsed as typeof checks;
        } catch {
          /* a Checks value that is not JSON is shown as no checks; Failed Checks still names what failed */
        }
        return { result_id: x.result_id, repeat: x.repeat, passed: x.passed, answer: x.answer, answer_chars: x.answer_chars, failed_checks: x.failed_checks, checks, run_at: x.run_at, execution: x.execution };
      }),
    }))
    .sort((a, b) => Number(a.passed) - Number(b.passed) || a.case_id.localeCompare(b.case_id));
  return { run_id: runId, found: r.rows.length > 0, cases };
}
