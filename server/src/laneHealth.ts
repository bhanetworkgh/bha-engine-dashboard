/**
 * Lane health and convergence (28 Sep 2026, Jason, #bha-north-star-twin
 * 1790611246.825499 — "turn the ranking into a loop per lane").
 *
 * For every ranked lane: its rank and six factors (laneRanking.ts), and four
 * states read from what the engine already records —
 *
 *   research   Research Twin jobs for the lane and any commercial lanes it is
 *              linked to (engine_lane_profiles.linked_lanes). A resolved job IS
 *              a gleaning: what was asked (Question), what was found (Verdict,
 *              else Finding), confidence, limits (Missing Elements) and whether
 *              more depth is needed. States: not_started, in_queue (Pending),
 *              active (In Progress), answered, stale. The re-entry signal is
 *              `action`: first_pass, deeper_pass or none, with the reason.
 *   self_heal  incidents and recurring fault signatures, for the lanes that have
 *              workflows of their own (BAYS, NS, RT). Every other lane says it is
 *              not instrumented rather than reading as healthy.
 *   logs       Codex work logs whose Lanes Touched names the lane, in the last
 *              14 days: awaiting evaluation or evaluated. Autopaid is null —
 *              there is no autopay rule yet.
 *   convergence  loops opened against loops closed in the last 14 days, with
 *              recurring faults, read as converging, steady or churning.
 *
 * Nothing here is written anywhere: it is computed at read time from rows other
 * code already keeps, so it cannot drift from them. Where the rows cannot answer,
 * the answer is null with a note, never a nought.
 */
import { query } from './pg';
import { ranking, type RankedLane } from './laneRanking';

export const STALE_AFTER_DAYS = 30;
export const WINDOW_DAYS = 14;
/** Research is only proposed for the top of the order; everything else waits its turn. */
export const RESEARCH_TOP_N = 5;

/** Which work lane an incident source and a workflow name belong to. */
const SOURCE_LANE: Record<string, string> = { bays: 'BAYS', north_star: 'NS', research_twin: 'RT' };
function laneOfWorkflow(name: string): string | null {
  if (/^Bays\b/i.test(name)) return 'BAYS';
  if (/^North Star\b/i.test(name)) return 'NS';
  if (/^Research Twin\b/i.test(name)) return 'RT';
  return null;
}

export interface Gleaning {
  job_id: string;
  lane_id: string;
  asked: string;
  found: string;
  confidence: string | null;
  limits: string | null;
  needs_depth: boolean;
  resolved_at: string | null;
  stale: boolean;
}

export interface ResearchState {
  state: 'not_started' | 'in_queue' | 'active' | 'answered' | 'stale';
  lanes_read: string[];
  open_jobs: number;
  gleanings: Gleaning[];
  action: 'first_pass' | 'deeper_pass' | 'none';
  reason: string;
}

/** Pure: a lane's research state from its jobs. */
export function researchState(
  lanes: string[],
  jobs: Array<{ lane_id: string; job_id: string; status: string; question: string; verdict: string; finding: string; confidence: string | null; missing: string | null; resolved_at: string | null }>,
  rank: number,
  now: Date,
): ResearchState {
  const mine = jobs.filter((j) => lanes.includes(j.lane_id));
  const pending = mine.filter((j) => j.status === 'Pending').length;
  const active = mine.filter((j) => j.status === 'In Progress').length;
  const gleanings: Gleaning[] = mine
    .filter((j) => j.status === 'Resolved')
    .map((j) => {
      const age = j.resolved_at ? (now.getTime() - Date.parse(j.resolved_at)) / 86_400_000 : Infinity;
      const conf = j.confidence ? j.confidence.trim() : null;
      const limits = j.missing && j.missing.trim() ? j.missing.trim() : null;
      return {
        job_id: j.job_id,
        lane_id: j.lane_id,
        asked: j.question,
        found: (j.verdict || j.finding || '').slice(0, 600),
        confidence: conf,
        limits: limits ? limits.slice(0, 400) : null,
        needs_depth: /^low$/i.test(conf ?? '') || Boolean(limits),
        resolved_at: j.resolved_at,
        stale: age > STALE_AFTER_DAYS,
      };
    })
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)));

  let state: ResearchState['state'];
  if (active) state = 'active';
  else if (pending) state = 'in_queue';
  else if (gleanings.length && gleanings.every((g) => g.stale)) state = 'stale';
  else if (gleanings.length) state = 'answered';
  else state = 'not_started';

  let action: ResearchState['action'] = 'none';
  let reason: string;
  if (lanes.length === 0) reason = 'No research lane is linked to this lane yet, so there is nothing to research against.';
  else if (active || pending) reason = `${active + pending} research job${active + pending === 1 ? '' : 's'} already open.`;
  else if (rank > RESEARCH_TOP_N) reason = `Ranked ${rank}; research is proposed only for the top ${RESEARCH_TOP_N}.`;
  else if (!gleanings.length) {
    action = 'first_pass';
    reason = 'Top-ranked with no research on record.';
  } else if (state === 'stale') {
    action = 'deeper_pass';
    reason = `Every finding is older than ${STALE_AFTER_DAYS} days.`;
  } else if (gleanings[0].needs_depth) {
    action = 'deeper_pass';
    reason = `The newest finding (${gleanings[0].job_id}) is ${gleanings[0].confidence ? gleanings[0].confidence.toLowerCase() + ' confidence' : 'unrated'}${gleanings[0].limits ? ' with named gaps' : ''}.`;
  } else reason = 'Answered for now.';
  return { state, lanes_read: lanes, open_jobs: active + pending, gleanings: gleanings.slice(0, 5), action, reason };
}

export interface LaneHealth {
  rank: number;
  lane_id: string;
  kind: string;
  score: number;
  factors: RankedLane['factors'];
  missing: RankedLane['missing'];
  linked_lanes: string[];
  research: ResearchState;
  self_heal: { instrumented: boolean; open_incidents: number | null; incidents_14d: number | null; recurring: Array<{ signature: string; workflow: string; count: number }>; note: string | null };
  logs: { touched_14d: number; awaiting_evaluation: number; evaluated: number; autopaid: null; note: string };
  convergence: { opened_14d: number | null; closed_14d: number | null; open_now: number; verdict: 'converging' | 'steady' | 'churning' | 'unknown'; note: string };
}

export async function laneHealth(opts: { kind?: 'work' | 'commercial' | 'all'; lane_id?: string; now?: Date } = {}): Promise<{ lanes: LaneHealth[]; notes: string[] }> {
  const now = opts.now ?? new Date();
  const r = await ranking(opts.kind ?? 'work', now);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();

  const linked = new Map(
    (await query<{ lane_id: string; linked_lanes: string[] | null }>(`SELECT lane_id, linked_lanes FROM engine_lane_profiles`)).rows.map((p) => [p.lane_id, p.linked_lanes ?? []]),
  );
  const jobs = (
    await query<{ lane_id: string; job_id: string; status: string; question: string; verdict: string; finding: string; confidence: string | null; missing: string | null; resolved_at: string | null }>(
      `SELECT lane_id, coalesce(natural_id, fields->>'Job ID', 'row-' || id) AS job_id, coalesce(fields->>'Status', '') AS status,
              coalesce(fields->>'Question', '') AS question, coalesce(fields->>'Verdict', '') AS verdict, coalesce(fields->>'Finding', '') AS finding,
              fields->>'Confidence' AS confidence, fields->>'Missing Elements' AS missing, fields->>'Resolved At' AS resolved_at
         FROM engine_rt_jobs WHERE coalesce(lane_id, '') <> ''`,
    )
  ).rows;

  const incidents = (
    await query<{ source: string; open: string; recent: string }>(
      `SELECT fields->>'source' AS source, count(*) FILTER (WHERE open_now)::text AS open,
              count(*) FILTER (WHERE fields->>'occurred_at' >= $1)::text AS recent
         FROM engine_incidents GROUP BY 1`,
      [since],
    )
  ).rows;
  const recurring = (
    await query<{ signature: string; workflow: string; count: number }>(
      `SELECT coalesce(fields->>'signature', '') AS signature, coalesce(fields->>'workflow', '') AS workflow, coalesce((fields->>'error_count')::int, 0) AS count
         FROM engine_error_counts WHERE coalesce((fields->>'error_count')::int, 0) >= 2 AND coalesce(fields->>'last_seen', '') >= $1`,
      [since],
    )
  ).rows;

  const logs = (
    await query<{ lanes: string; status: string }>(
      `SELECT coalesce(fields->>'Lanes Touched', '') AS lanes, coalesce(fields->>'Jason Status', '') AS status
         FROM engine_codex_submissions WHERE coalesce(fields->>'Timestamp', created_time, '') >= $1`,
      [since],
    )
  ).rows;

  const loops = (
    await query<{ lane: string; opened: string; closed: string; open_now: string }>(
      `WITH l AS (
         SELECT DISTINCT ON (fields->>'loop_id') id, airtable_record_id, fields
           FROM engine_loops ORDER BY fields->>'loop_id', updated_at DESC
       )
       SELECT coalesce(l.fields->>'lane_tag', '') AS lane,
              count(*) FILTER (WHERE coalesce(l.fields->>'Date Raised', '') >= $1)::text AS opened,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM events e WHERE e.kind = 'loops' AND e.to_status = 'closed' AND e.via IN ('engine', 'ui') AND e.at >= $1
                   AND (e.record_id = l.airtable_record_id OR e.record_id = 'row-' || l.id)))::text AS closed,
              count(*) FILTER (WHERE l.fields->>'Status' IN ('Open', 'In Progress'))::text AS open_now
         FROM l GROUP BY 1`,
      [since.slice(0, 10)],
    )
  ).rows;
  const loopsBy = new Map(loops.map((x) => [x.lane, x]));

  const out: LaneHealth[] = [];
  for (const l of r.lanes) {
    if (opts.lane_id && l.lane_id !== opts.lane_id) continue;
    const links = linked.get(l.lane_id) ?? [];
    const researchLanes = l.kind === 'commercial' ? [l.lane_id, ...links] : links;
    const research = researchState(researchLanes, jobs, l.rank, now);

    const instrumented = ['BAYS', 'NS', 'RT'].includes(l.lane_id);
    const inc = instrumented ? incidents.filter((i) => SOURCE_LANE[i.source] === l.lane_id) : [];
    const rec = instrumented ? recurring.filter((e) => laneOfWorkflow(e.workflow) === l.lane_id) : [];

    const mineLogs = logs.filter((g) => g.lanes.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).includes(l.lane_id));
    const evaluated = mineLogs.filter((g) => /^(approved|input added)$/i.test(g.status)).length;

    const lp = loopsBy.get(l.lane_id);
    const opened = lp ? Number(lp.opened) : l.kind === 'work' ? 0 : null;
    const closed = lp ? Number(lp.closed) : l.kind === 'work' ? 0 : null;
    let verdict: LaneHealth['convergence']['verdict'] = 'unknown';
    let cnote = `Loops raised against loops closed in the last ${WINDOW_DAYS} days; a close is dated by this dashboard's own status ledger.`;
    if (l.kind !== 'work') cnote = 'Commercial lanes carry no loops, so convergence is not measured for them yet.';
    else if (opened !== null && closed !== null) {
      if (rec.length > 0 || opened > closed * 1.5 + 2) verdict = 'churning';
      else if (closed >= opened) verdict = 'converging';
      else verdict = 'steady';
    }

    out.push({
      rank: l.rank,
      lane_id: l.lane_id,
      kind: l.kind,
      score: l.score,
      factors: l.factors,
      missing: l.missing,
      linked_lanes: links,
      research,
      self_heal: {
        instrumented,
        open_incidents: instrumented ? inc.reduce((a, i) => a + Number(i.open), 0) : null,
        incidents_14d: instrumented ? inc.reduce((a, i) => a + Number(i.recent), 0) : null,
        recurring: rec.slice(0, 5),
        note: instrumented ? null : 'No workflow or incident source belongs to this lane yet, so self-heal state is not instrumented — not healthy, not measured.',
      },
      logs: {
        touched_14d: mineLogs.length,
        awaiting_evaluation: mineLogs.length - evaluated,
        evaluated,
        autopaid: null,
        note: 'From Codex logs whose Lanes Touched names this lane. Autopaid is null until the autopay rule is agreed.',
      },
      convergence: { opened_14d: opened, closed_14d: closed, open_now: lp ? Number(lp.open_now) : 0, verdict, note: cnote },
    });
  }
  return {
    lanes: out,
    notes: [
      `A resolved Research Twin job is a gleaning; findings older than ${STALE_AFTER_DAYS} days are stale. Research is proposed only for the top ${RESEARCH_TOP_N} lanes.`,
      'Work lanes reach research only through linked_lanes (set with set_lane_profile), because research jobs carry commercial LANE-… ids, never work-lane tags.',
      'Self-heal is instrumented only for BAYS, NS and RT, the three lanes with workflows and incident sources of their own.',
    ],
  };
}
