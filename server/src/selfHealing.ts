/**
 * The self-healing scorecard (19 Oct 2026, Destiny — D2.5: "If BHA is going to
 * be marketing that we have a self-healing system, we need to be able to back
 * everything up with numbers").
 *
 * One read, week by week, of what the engine did about its own failures:
 *
 *   runs           production runs (webhook, trigger, sub-workflow), and how
 *                  many failed. Manual test runs, the healer's own retries and
 *                  the error handlers' runs are not workload and are left out.
 *   faults         incidents, split into real faults and the ones counted
 *                  apart: tests, the simulator and a guard refusing a request
 *                  on purpose (logstream.excludedReason, the one definition).
 *   fixed          every automatic fix, wherever it was recorded: a healer
 *                  retry that recovered (with or without an incident, the
 *                  RUN-… rows), a repair still standing, a recovery-watcher
 *                  re-run, and a polling one-off the watcher closed. Each is
 *                  counted once per incident.
 *   closed         how each real fault closed: by the engine, on its own (a
 *                  vFarm device that came back), by a person, by policy (a chat
 *                  never re-run hours late), or not recorded (closed before
 *                  2 Oct, when nothing wrote who closed what).
 *   time to fix    p50 and p95 from the fault to its close, engine and person
 *                  (the fault's time is the earlier of the ledger's occurred_at and
 *                  when this database first saw it: BHARAG moves occurred_at to the
 *                  close on every status change, so read alone a closed incident
 *                  looks fixed the instant it happened),
 *                  apart, only for closes on or after 2 Oct 2026.
 *
 * It reads and writes nothing. Every figure carries its denominator and says
 * what it leaves out, because a number quoted to a buyer has to survive the
 * buyer asking how it was counted.
 */
import { nowIso } from './db';
import { query } from './pg';
import { excludedReason } from './logstream';

/** Closes before this date carry no closer and no trusted time. */
export const TRUSTED_SINCE = '2026-10-02T00:00:00Z';
/** The first week the healer ran (it replaced the old retry workflow on 21 Sep). */
export const HEALER_SINCE = '2026-09-21';
const PRODUCTION_MODES = ['webhook', 'trigger', 'integrated'];
const FAILED = ['error', 'crashed'];
/** A step whose job is to throw when something upstream failed. */
export const ALARM_NODE = /^\s*(raise|assert|pat assert|stop on)\b/i;

export type Closer = 'engine' | 'cleared_itself' | 'person' | 'policy' | 'not_recorded';

export interface IncidentRow {
  incident_id: string;
  lane_id: string | null;
  workflow: string | null;
  node: string | null;
  tags: string[] | null;
  execution_id: string | null;
  occurred_at: string;
  open_now: boolean;
  resolution_status: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  test_reason?: string | null;
}

/** How a closed incident closed. `engineIds` are incidents an automatic fix is recorded against. */
export function closerOf(i: Pick<IncidentRow, 'incident_id' | 'resolution_status' | 'resolved_by' | 'open_now'>, engineIds: Set<string>): Closer | null {
  if (i.open_now) return null;
  const rs = String(i.resolution_status ?? '').toLowerCase();
  const by = String(i.resolved_by ?? '').toLowerCase();
  if (rs === 'wont_fix' || by.startsWith('recovery:chat_not_rerun')) return 'policy';
  if (rs === 'self_healed' || engineIds.has(i.incident_id) || (by.startsWith('recovery') && !by.includes('chat_not_rerun'))) return 'engine';
  // A device or farm vFarm stopped listing was removed there by a person; it did not clear itself (D2, 24 Oct 2026).
  if (by.startsWith('monitoring-twin') && by.includes('stopped listing')) return 'person';
  if (by.startsWith('monitoring-twin')) return 'cleared_itself';
  if (rs === 'manually_resolved' || by.startsWith('mcp:') || by.startsWith('page') || by.includes('@') || by === 'bays' || by === 'dashboard') return 'person';
  return 'not_recorded';
}

function weekStart(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function pct(n: number, of: number): { n: number; of: number; pct: number | null } {
  return { n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null };
}
function percentiles(minutes: number[]): { n: number; p50_minutes: number | null; p95_minutes: number | null } {
  const s = [...minutes].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10 : null);
  return { n: s.length, p50_minutes: at(50), p95_minutes: at(95) };
}

export interface AutoFix {
  key: string;
  kind: 'retry_recovered' | 'repair_standing' | 'recovery_rerun' | 'one_off_closed' | 'incident_self_healed';
  at: string;
  incident_id: string | null;
  workflow: string | null;
}

/**
 * Why a fix is left out of the automatic-fix count: its own workflow is a test, the simulator or a
 * guard refusal (the incident rule, excludedReason), its repair id is a TEST row, or the incident it
 * fixed is counted apart. Null means it is a real automatic fix.
 */
export function fixApartReason(f: AutoFix, apartIncident: Map<string, string | null>): string | null {
  if (/^REP-TEST\b/i.test(f.key)) return 'test';
  const own = excludedReason({ workflow: f.workflow, node: null });
  if (own) return own;
  if (f.incident_id && apartIncident.get(f.incident_id)) return apartIncident.get(f.incident_id)!;
  return null;
}

/** One fix per incident (or per run where no incident was opened), earliest kind kept. */
export function dedupeFixes(fixes: AutoFix[], incidentByExec: Map<string, string>): AutoFix[] {
  const out = new Map<string, AutoFix>();
  for (const f of [...fixes].sort((a, b) => a.at.localeCompare(b.at))) {
    let key = f.key;
    const exec = key.match(/^(?:RUN|EXEC)-(\d+)$/)?.[1];
    if (exec && incidentByExec.has(exec)) key = incidentByExec.get(exec)!;
    if (!out.has(key)) out.set(key, { ...f, key, incident_id: f.incident_id ?? (key.startsWith('INC-') ? key : null) });
  }
  return [...out.values()];
}

export async function scorecard(opts: { weeks?: number } = {}) {
  const now = nowIso();
  const thisWeek = weekStart(now);
  const fromHealer = Math.round((Date.parse(`${thisWeek}T00:00:00Z`) - Date.parse(`${HEALER_SINCE}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  const n = Math.max(1, Math.min(26, Math.floor(Number(opts.weeks) || Math.max(fromHealer, 1))));
  const weeks: string[] = [];
  for (let i = n - 1; i >= 0; i--) weeks.push(addDays(thisWeek, -7 * i));
  const from = weeks[0];

  const [runs, inc, retries, repairs, recov, oneOffs, routed] = await Promise.all([
    query<{ week: string; runs: number; failed: number }>(
      `SELECT to_char(date_trunc('week', nullif(started_at, '')::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, count(*)::int AS runs,
              count(*) FILTER (WHERE status = ANY($3))::int AS failed
         FROM engine_execution_runs WHERE mode = ANY($2) AND nullif(started_at, '')::timestamptz >= $1::date GROUP BY 1`,
      [from, PRODUCTION_MODES, FAILED],
    ),
    query<IncidentRow>(
      `SELECT natural_id AS incident_id, lane_id, fields->'payload'->>'workflow_or_scenario' AS workflow,
              fields->'payload'->>'failed_node_or_component' AS node,
              CASE WHEN jsonb_typeof(fields->'payload'->'impact_tags') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(fields->'payload'->'impact_tags')) END AS tags,
              nullif(fields->'payload'->>'execution_id', '') AS execution_id,
              to_char(LEAST(nullif(fields->>'occurred_at', '')::timestamptz, nullif(first_seen_at, '')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
              open_now, fields->>'resolution_status' AS resolution_status,
              to_char(resolved_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resolved_at, resolved_by, test_reason
         FROM engine_incidents WHERE natural_id IS NOT NULL`,
    ),
    query<{ key: string; at: string; workflow: string | null; execution_id: string | null }>(
      `SELECT natural_id AS key, coalesce(nullif(fields->>'last_attempt_at', ''), updated_at) AS at, fields->>'workflow' AS workflow, nullif(fields->>'execution_id', '') AS execution_id
         FROM engine_retry_attempts WHERE fields->>'status' = 'Recovered' AND natural_id IS NOT NULL`,
    ),
    query<{ execution_id: string | null; at: string; workflow: string | null; repair_id: string }>(
      `SELECT execution_id, coalesce(finished_at, created_at)::text AS at, workflow_name AS workflow, repair_id
         FROM engine_repairs WHERE outcome = 'repaired' AND reverted_at IS NULL AND version_after IS NOT NULL`,
    ),
    query<{ incident_id: string; at: string; workflow: string | null }>(
      `SELECT incident_id, updated_at AS at, workflow FROM engine_recovery WHERE status IN ('recovered', 'already_done')`,
    ),
    query<{ subject_id: string; at: string; workflow: string | null }>(
      `SELECT subject_id, at::text AS at, detail->>'workflow' AS workflow FROM engine_events WHERE event_type = 'polling_one_off_closed' AND subject_id IS NOT NULL`,
    ),
    query<{ route: string | null; kind: string | null; n: number }>(
      `SELECT detail->>'route' AS route, detail->>'route_kind' AS kind, count(*)::int AS n
         FROM engine_events WHERE event_type = 'self_healer_routed' AND at >= $1::date GROUP BY 1, 2 ORDER BY 3 DESC`,
      [from],
    ),
  ]);

  const incidentByExec = new Map<string, string>();
  for (const i of inc.rows) if (i.execution_id) incidentByExec.set(i.execution_id, i.incident_id);

  const raw: AutoFix[] = [
    ...retries.rows.map((r) => ({ key: r.key, kind: 'retry_recovered' as const, at: new Date(r.at).toISOString(), incident_id: r.key.startsWith('INC-') ? r.key : null, workflow: r.workflow })),
    ...repairs.rows.map((r) => ({ key: r.execution_id ? `EXEC-${r.execution_id}` : r.repair_id, kind: 'repair_standing' as const, at: new Date(r.at).toISOString(), incident_id: null, workflow: r.workflow })),
    ...recov.rows.map((r) => ({ key: r.incident_id, kind: 'recovery_rerun' as const, at: new Date(r.at).toISOString(), incident_id: r.incident_id, workflow: r.workflow })),
    ...oneOffs.rows.map((r) => ({ key: r.subject_id, kind: 'one_off_closed' as const, at: new Date(r.at).toISOString(), incident_id: r.subject_id, workflow: r.workflow })),
    ...inc.rows.filter((i) => String(i.resolution_status).toLowerCase() === 'self_healed').map((i) => ({ key: i.incident_id, kind: 'incident_self_healed' as const, at: i.resolved_at ?? i.occurred_at, incident_id: i.incident_id, workflow: i.workflow })),
  ];
  const allFixes = dedupeFixes(raw, incidentByExec);
  // A fix on a test, the simulator, a guard refusal or an incident a person marked a test is
  // not an automatic fix of a real fault: counted apart, never in the figure we quote
  // (21 Oct 2026, D2: REP-TEST-SETTLE-1792444500 had been counted as a real fix).
  const apartIncident = new Map(inc.rows.map((i) => [i.incident_id, i.test_reason ? 'marked_test' : excludedReason({ workflow: i.workflow, node: i.node, tags: i.tags })]));
  const fixApart = (f: AutoFix): string | null => fixApartReason(f, apartIncident);
  const fixes = allFixes.filter((f) => !fixApart(f));
  const fixesApart = allFixes.filter((f) => fixApart(f));
  const engineIds = new Set(fixes.map((f) => f.incident_id).filter((x): x is string => Boolean(x)));

  const classified = inc.rows.map((i) => {
    const apart = apartIncident.get(i.incident_id) ?? null;
    return { ...i, apart, alarm: !apart && ALARM_NODE.test(i.node ?? ''), closer: closerOf(i, engineIds), week: weekStart(i.occurred_at) };
  });

  const blank = () => ({ engine: 0, cleared_itself: 0, person: 0, policy: 0, not_recorded: 0 });
  const rows = weeks.map((w) => {
    const r = runs.rows.find((x) => x.week === w);
    const mine = classified.filter((i) => i.week === w);
    const real = mine.filter((i) => !i.apart);
    const apart: Record<string, number> = {};
    for (const i of mine) if (i.apart) apart[i.apart] = (apart[i.apart] ?? 0) + 1;
    const closed = blank();
    for (const i of real) if (i.closer) closed[i.closer]++;
    const wf = fixes.filter((f) => weekStart(f.at) === w);
    const byKind: Record<string, number> = {};
    for (const f of wf) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    return {
      week_start: w,
      partial: w === thisWeek,
      runs: r?.runs ?? 0,
      failed_runs: r?.failed ?? 0,
      failure_rate: pct(r?.failed ?? 0, r?.runs ?? 0),
      incidents: mine.length,
      real_faults: real.length,
      real_faults_raised_by_alarm: real.filter((i) => i.alarm).length,
      counted_apart: apart,
      automatic_fixes: { total: wf.length, without_incident: wf.filter((f) => !f.incident_id).length, by_kind: byKind, counted_apart: fixesApart.filter((f) => weekStart(f.at) === w).length },
      closed_real_faults: closed,
      still_open: real.filter((i) => i.open_now).length,
    };
  });

  const window = classified.filter((i) => i.week >= from);
  const realW = window.filter((i) => !i.apart);
  const closedW = blank();
  for (const i of realW) if (i.closer) closedW[i.closer]++;
  const decided = closedW.engine + closedW.cleared_itself + closedW.person;
  const minutes = (c: Closer) =>
    realW
      .filter((i) => i.closer === c && i.resolved_at && i.resolved_at >= TRUSTED_SINCE)
      .map((i) => (Date.parse(i.resolved_at!) - Date.parse(i.occurred_at)) / 60_000)
      .filter((m) => m >= 0);
  const fixW = fixes.filter((f) => weekStart(f.at) >= from);
  const runsW = rows.reduce((a, r) => a + r.runs, 0);
  const failedW = rows.reduce((a, r) => a + r.failed_runs, 0);

  return {
    generated_at: now,
    window: { from, to: now, weeks: n, current_week_partial: true },
    totals: {
      runs: runsW,
      failed_runs: failedW,
      failure_rate: pct(failedW, runsW),
      incidents: window.length,
      real_faults: realW.length,
      counted_apart: window.length - realW.length,
      automatic_fixes: fixW.length,
      automatic_fixes_without_incident: fixW.filter((f) => !f.incident_id).length,
      automatic_fixes_counted_apart: fixesApart.filter((f) => weekStart(f.at) >= from).length,
      closed_real_faults: closedW,
      fixed_by_engine_share: pct(closedW.engine + closedW.cleared_itself, decided),
      still_open: realW.filter((i) => i.open_now).length,
      time_to_fix: { engine: percentiles([...minutes('engine'), ...minutes('cleared_itself')]), person: percentiles(minutes('person')) },
    },
    weeks: rows,
    healer_routes: { since: from, rows: routed.rows, note: routed.rows.length ? 'Every failure the healer was handed, by the route it took (self_healer_routed, from 19 Oct 2026).' : 'No route recorded yet: the healer began recording its routes on 19 Oct 2026.' },
    open_real_faults: realW.filter((i) => i.open_now).map((i) => ({ incident_id: i.incident_id, workflow: i.workflow, node: i.node, occurred_at: i.occurred_at })),
    recent_fixes: fixW.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
    definitions: [
      'Runs are production runs: webhook, trigger and sub-workflow runs. Manual test runs, the healer’s own retries and the error handlers’ runs are left out. Failed means error or crashed.',
      'A real fault is an incident that is not a test, not the simulator, not a guard refusing a request on purpose, and not marked a test by a person with a reason (mark_incidents_test, or close_incidents with test true); those are counted apart. A fault raised by an alarm step (Raise, Assert, Stop On) is a real fault: the alarm is reporting something that failed upstream.',
      'An automatic fix is a healer retry that recovered (including runs that never opened an incident), a Claude Code repair still standing, a recovery-watcher re-run, or a polling one-off the watcher closed. Each incident counts once, in the week of its first fix. A fix on a test, the simulator, a guard refusal or an incident marked a test is counted apart (automatic_fixes_counted_apart), never as a real fix.',
      'Fixed by the engine share = (closed by the engine + cleared on its own) ÷ (those + closed by a person). Closed by policy (a chat not re-run hours late) and closes not recorded (before 2 Oct 2026) are left out of it, and named.',
      'Time to fix is p50 and p95 from the fault to its close, only for closes on or after 2 Oct 2026; never a mean.',
    ],
  };
}
