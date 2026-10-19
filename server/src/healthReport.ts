/**
 * The weekly engine health report (19 Oct 2026, Destiny — D2.7: "an engine health report that
 * shows our metrics and our work" in #all-bayshorizonnetwork, every week).
 *
 * One read, computed here and nowhere else, so the Slack post, the page and anyone asking get the
 * same numbers. n8n's `Engine — Weekly Health Report` asks `GET /api/engine/health-report` every
 * Monday and posts `slack_text` as Bays; this module never posts anything itself.
 *
 * The period is the last full week (Monday to Sunday, UTC), set against every full week since the
 * self-healer began (21 Sep 2026). Every figure carries what it is counted out of, and a figure
 * the rows cannot support says so instead of printing a nought.
 */
import { getMeta, nowIso, setMeta } from './db';
import * as bharag from './bharag';
import { query } from './pg';
import * as selfHealing from './selfHealing';
import * as sops from './sops';
import { genieOutcome } from './systemFeeds';

const SINCE = selfHealing.HEALER_SINCE; // 2026-09-21, a Monday
const DAY = 86_400_000;

function weekStart(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "21 to 27 Sep", "28 Sep to 4 Oct". */
export function weekLabel(start: string): string {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(a.getTime() + 6 * DAY);
  const am = MONTHS[a.getUTCMonth()];
  const bm = MONTHS[b.getUTCMonth()];
  return am === bm ? `${a.getUTCDate()} to ${b.getUTCDate()} ${bm}` : `${a.getUTCDate()} ${am} to ${b.getUTCDate()} ${bm}`;
}
export function pct(n: number, of: number): number | null {
  return of ? Math.round((n / of) * 1000) / 10 : null;
}
/** How much smaller `to` is than `from`, as a percentage of `from`. Null where there is no base. */
export function reduction(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from <= 0) return null;
  return Math.round(((from - to) / from) * 1000) / 10;
}
/** Change from `prev` to `cur` as a signed percentage; null where prev is nought. */
export function change(prev: number, cur: number): number | null {
  return prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
}
const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
const fmtChange = (v: number | null, prev: number, cur: number) => (v === null ? (prev === 0 && cur > 0 ? `${cur} from none` : 'no change') : `${v > 0 ? '+' : ''}${v}%`);
const n = (v: number) => v.toLocaleString('en-US');
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function p50(values: number[]): number | null {
  const s = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.ceil(0.5 * s.length) - 1] : null;
}
function duration(sec: number | null): string {
  if (sec === null) return 'n/a';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${Math.round((sec / 3600) * 10) / 10} h`;
}

const clip = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The twin review (19 Oct 2026, LOOP-1792016378151-RYHY; Jason, 14 Oct: Bays' critiques of the
 * twins should be continuous and leave a record). Last week only. North Star is the one twin whose
 * answers can be checked against the loop board: every loop id its answers named, and whether that
 * loop's status then changed (the dashboard's own status record, never a mirror line) before the
 * week ended. Research Twin and Genie are judged on their own recorded outcomes; nothing here
 * grades an answer's content.
 */
export async function twinReview(last: string, end: string) {
  const [nsOut, nsLoops, nsStuck, rtOut, rtMiss, genie] = await Promise.all([
    query<{ outcome: string; n: number }>(
      `SELECT coalesce(nullif(fields->>'Outcome', ''), 'No outcome') AS outcome, count(*)::int AS n FROM engine_ns_asks
        WHERE coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz >= $1::date
          AND coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz < $2::date GROUP BY 1 ORDER BY 2 DESC`,
      [last, end],
    ),
    query<{ named: number; held: number; moved: number; closed: number }>(
      `${NS_NAMED}
       SELECT count(*)::int AS named, count(st)::int AS held, count(*) FILTER (WHERE moved)::int AS moved,
              count(*) FILTER (WHERE moved AND st = 'Closed')::int AS closed FROM x`,
      [last, end],
    ),
    query<{ loop_id: string; times: number; b: string | null; st: string | null; what: string | null }>(
      `${NS_NAMED}
       SELECT loop_id, times, b, st, what FROM x WHERE NOT moved AND st IS DISTINCT FROM 'Closed' AND times >= 3
        ORDER BY times DESC, loop_id LIMIT 5`,
      [last, end],
    ),
    query<{ outcome: string; delivered: string; n: number }>(
      `SELECT coalesce(nullif(fields->>'Outcome', ''), 'No outcome') AS outcome, coalesce(nullif(fields->>'Delivered', ''), 'Not recorded') AS delivered, count(*)::int AS n
         FROM engine_rt_asks
        WHERE coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz >= $1::date
          AND coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz < $2::date GROUP BY 1, 2`,
      [last, end],
    ),
    query<{ id: string | null; outcome: string; delivered: string; q: string | null }>(
      `SELECT fields->>'Ask ID' AS id, coalesce(nullif(fields->>'Outcome', ''), 'No outcome') AS outcome, coalesce(nullif(fields->>'Delivered', ''), 'Not recorded') AS delivered, fields->>'Question' AS q
         FROM engine_rt_asks
        WHERE coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz >= $1::date
          AND coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz < $2::date
          AND (fields->>'Outcome' NOT IN ('Answered', 'Refused (not its lane)') OR fields->>'Delivered' NOT IN ('Delivered', 'Self-delivered'))
        ORDER BY coalesce(nullif(fields->>'Asked At', ''), created_time) DESC LIMIT 5`,
      [last, end],
    ),
    query<{ event_type: string; status: string | null; q: string | null }>(
      `SELECT DISTINCT ON (request_id) event_type, status, question AS q FROM engine_genie_events
        WHERE request_id IS NOT NULL AND event_type NOT LIKE 'genie.subagent.%' AND occurred_at >= $1::date AND occurred_at < $2::date
        ORDER BY request_id, occurred_at DESC`,
      [last, end],
    ),
  ]);
  const nsTotal = nsOut.rows.reduce((a, r) => a + r.n, 0);
  const l = nsLoops.rows[0] ?? { named: 0, held: 0, moved: 0, closed: 0 };
  const rtTotal = rtOut.rows.reduce((a, r) => a + r.n, 0);
  const rtCount = (f: (r: { outcome: string; delivered: string }) => boolean) => rtOut.rows.filter(f).reduce((a, r) => a + r.n, 0);
  const gOut = genie.rows.map((r) => genieOutcome(r.event_type, r.status));
  const gCount = (o: string) => gOut.filter((x) => x === o).length;
  return {
    north_star: {
      asks: nsTotal,
      outcomes: nsOut.rows,
      loops_pointed_at: l.named,
      loops_held: l.held,
      loops_moved: l.moved,
      loops_closed: l.closed,
      hit_rate: pct(l.moved, l.named),
      stuck: nsStuck.rows.map((r) => ({ loop_id: r.loop_id, times_named: r.times, builder: r.b, status: r.st, what: clip(r.what, 90) })),
    },
    research_twin: {
      asks: rtTotal,
      answered: rtCount((r) => r.outcome === 'Answered'),
      thin: rtCount((r) => r.outcome === 'Thin'),
      needs_human: rtCount((r) => r.outcome === 'Needs human'),
      refused: rtCount((r) => r.outcome === 'Refused (not its lane)'),
      failed: rtCount((r) => r.outcome === 'Failed'),
      not_delivered: rtCount((r) => r.delivered === 'Not delivered'),
      misses: rtMiss.rows.map((r) => ({ ask_id: r.id, outcome: r.outcome, delivered: r.delivered, question: clip(r.q, 110) })),
    },
    genie: {
      asks: gOut.length,
      answered: gCount('Answered'),
      incomplete: gCount('Incomplete'),
      failed: gCount('Failed'),
      misses: genie.rows.filter((r) => genieOutcome(r.event_type, r.status) !== 'Answered').slice(0, 5).map((r) => ({ outcome: genieOutcome(r.event_type, r.status), question: clip(r.q, 110) })),
    },
  };
}

/** Every loop id North Star's answers named last week, with whether its status then changed. */
const NS_NAMED = `
  WITH asks AS (
    SELECT coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz AS t, fields->>'Answer' AS ans FROM engine_ns_asks
     WHERE coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz >= $1::date
       AND coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz < $2::date),
  named AS (SELECT m[1] AS loop_id, min(t) AS first_named, count(*)::int AS times
              FROM asks, regexp_matches(coalesce(ans, ''), '(LOOP-[0-9]+-[A-Z0-9]{4})', 'g') AS m GROUP BY 1),
  cur AS (SELECT DISTINCT ON (natural_id) natural_id, fields->>'Status' AS st, fields->>'What' AS what, builder_id AS b
            FROM engine_loops WHERE natural_id IS NOT NULL ORDER BY natural_id, updated_at DESC),
  x AS (SELECT named.loop_id, named.times, cur.st, cur.b, cur.what,
               EXISTS (SELECT 1 FROM events e JOIN engine_loops el ON e.record_id = 'row-' || el.id
                        WHERE el.natural_id = named.loop_id AND e.kind = 'loops' AND e.via <> 'mirror'
                          AND e.at::timestamptz > named.first_named AND e.at::timestamptz < $2::date) AS moved
          FROM named LEFT JOIN cur ON cur.natural_id = named.loop_id)`;

export async function buildData(opts: { now?: string } = {}) {
  const now = opts.now ?? nowIso();
  const thisWeek = weekStart(now);
  const last = addDays(thisWeek, -7);
  const prev = addDays(last, -7);
  const weeks: string[] = [];
  for (let w = SINCE; w <= last; w = addDays(w, 7)) weeks.push(w);
  const end = thisWeek; // exclusive

  const card = await selfHealing.scorecard({ weeks: weeks.length + 1 });
  const cw = card.weeks.filter((w) => w.week_start <= last);
  const first = cw[0];
  const lastW = cw.find((w) => w.week_start === last);
  const prevW = cw.find((w) => w.week_start === prev);

  const [codex, loops, loopsClosedWeek, loopsClosedByWeek, asks, patterns, logsByWeek] = await Promise.all([
    query<{ b: string; submitted: number; approved: number; rejected: number; waiting: number; wk: number; wk_approved: number }>(
      `WITH c AS (SELECT builder_id AS b, fields->>'Jason Status' AS js,
                         coalesce(nullif(fields->>'Timestamp', ''), created_time)::timestamptz AS t
                    FROM engine_codex_submissions WHERE builder_id IS NOT NULL)
       SELECT b, count(*)::int AS submitted,
              count(*) FILTER (WHERE js IN ('Approved', 'Input Added'))::int AS approved,
              count(*) FILTER (WHERE js = 'Rejected')::int AS rejected,
              count(*) FILTER (WHERE coalesce(js, '') NOT IN ('Approved', 'Input Added', 'Rejected'))::int AS waiting,
              count(*) FILTER (WHERE t >= $2::date AND t < $3::date)::int AS wk,
              count(*) FILTER (WHERE t >= $2::date AND t < $3::date AND js IN ('Approved', 'Input Added'))::int AS wk_approved
         FROM c WHERE t >= $1::date AND t < $3::date GROUP BY b ORDER BY submitted DESC, b`,
      [SINCE, last, end],
    ),
    query<{ b: string; open: number; closed: number; raised: number; raised_closed: number }>(
      `WITH l AS (SELECT DISTINCT ON (natural_id) natural_id, builder_id AS b, fields->>'Status' AS st, fields->>'Date Raised' AS dr
                    FROM engine_loops WHERE natural_id IS NOT NULL ORDER BY natural_id, updated_at DESC)
       SELECT coalesce(b, 'unassigned') AS b,
              count(*) FILTER (WHERE st IN ('Open', 'In Progress'))::int AS open,
              count(*) FILTER (WHERE st = 'Closed')::int AS closed,
              count(*) FILTER (WHERE dr >= $1)::int AS raised,
              count(*) FILTER (WHERE dr >= $1 AND st = 'Closed')::int AS raised_closed
         FROM l GROUP BY 1 ORDER BY open DESC, b`,
      [SINCE],
    ),
    query<{ b: string; n: number }>(
      `SELECT coalesce(builder, 'unassigned') AS b, count(DISTINCT record_id)::int AS n FROM events
        WHERE kind = 'loops' AND lower(to_status) = 'closed' AND via <> 'mirror' AND at::timestamptz >= $1::date AND at::timestamptz < $2::date GROUP BY 1`,
      [last, end],
    ),
    query<{ week: string; n: number }>(
      `SELECT to_char(date_trunc('week', at::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, count(DISTINCT record_id)::int AS n FROM events
        WHERE kind = 'loops' AND lower(to_status) = 'closed' AND via <> 'mirror' AND at::timestamptz >= $1::date AND at::timestamptz < $2::date GROUP BY 1`,
      [SINCE, end],
    ),
    query<{ agent: string; wk: boolean; asks: number; owed: number; delivered: number; done: number; secs: number[] }>(
      `WITH a AS (
         SELECT 'Bays' AS agent, fields, coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz AS t FROM engine_bays_asks
         UNION ALL SELECT 'North Star', fields, coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz FROM engine_ns_asks
         UNION ALL SELECT 'Research Twin', fields, coalesce(nullif(fields->>'Asked At', ''), created_time)::timestamptz FROM engine_rt_asks)
       SELECT agent, (t >= $2::date) AS wk, count(*)::int AS asks,
              count(*) FILTER (WHERE coalesce(fields->>'Delivered', '') <> 'Nothing posted')::int AS owed,
              count(*) FILTER (WHERE fields->>'Delivered' = 'Delivered' OR fields->>'Delivered' = 'Self-delivered')::int AS delivered,
              count(*) FILTER (WHERE fields->>'Outcome' IN ('Answered', 'Answered with tool issues', 'Ranking only'))::int AS done,
              coalesce(array_agg(nullif(fields->>'Response Seconds', '')::numeric) FILTER (WHERE nullif(fields->>'Response Seconds', '') IS NOT NULL), '{}') AS secs
         FROM a WHERE t >= $1::date AND t < $3::date GROUP BY 1, 2`,
      [SINCE, last, end],
    ),
    query<{ week: string; n: number }>(
      `SELECT to_char(date_trunc('week', coalesce(nullif(fields->>'created_at', ''), created_time)::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, count(*)::int AS n
         FROM engine_build_patterns GROUP BY 1`,
    ),
    query<{ week: string; n: number }>(
      `SELECT to_char(date_trunc('week', coalesce(nullif(fields->>'Timestamp', ''), created_time)::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, count(*)::int AS n
         FROM engine_codex_submissions WHERE coalesce(nullif(fields->>'Timestamp', ''), created_time)::timestamptz >= $1::date GROUP BY 1`,
      [SINCE],
    ),
  ]);

  // Names: a builder id is one of the seven names, or a Slack id with a Builder Profile.
  const twins = await twinReview(last, end);
  const prof = await query<{ id: string; name: string | null }>(`SELECT natural_id AS id, fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id IS NOT NULL`);
  const nameOf = (b: string) => (/^U[A-Z0-9]{6,}$/.test(b) ? prof.rows.find((p) => p.id === b)?.name ?? b : cap(b));

  // SOPs come from BHARAG; a read that could not finish is said, never counted as nought.
  let sopRows: { created_at: string | null }[] = [];
  let sopNote: string | null = null;
  try {
    const s = await sops.read();
    if (s.ok) {
      sopRows = s.sops;
      if (!s.complete) sopNote = 'the SOP read was cut short, so the SOP figures are a floor';
    } else sopNote = `SOPs could not be read from BHARAG (${s.error ?? 'no reason given'})`;
  } catch (e) {
    sopNote = `SOPs could not be read from BHARAG (${e instanceof Error ? e.message : String(e)})`;
  }
  const sopWeek = (w: string) => sopRows.filter((r) => r.created_at && weekStart(r.created_at) === w).length;

  const patWeek = (w: string) => patterns.rows.find((r) => r.week === w)?.n ?? 0;
  const patTotal = patterns.rows.filter((r) => r.week < end).reduce((a, r) => a + r.n, 0);
  const patSince = patterns.rows.filter((r) => r.week >= SINCE && r.week < end).reduce((a, r) => a + r.n, 0);
  const patBefore = patTotal - patSince;
  const sopTotal = sopRows.filter((r) => !r.created_at || r.created_at.slice(0, 10) < end).length;
  const sopSince = sopRows.filter((r) => r.created_at && r.created_at.slice(0, 10) >= SINCE && r.created_at.slice(0, 10) < end).length;

  const agentLine = (agent: string, wk: boolean) => {
    const rows = asks.rows.filter((r) => r.agent === agent && (wk ? r.wk : true));
    const sum = (k: 'asks' | 'owed' | 'delivered' | 'done') => rows.reduce((a, r) => a + r[k], 0);
    const secs = rows.flatMap((r) => (r.secs ?? []).map(Number));
    return { asks: sum('asks'), owed: sum('owed'), delivered: sum('delivered'), done: sum('done'), p50: p50(secs) };
  };

  const data = {
    period: { week: last, label: weekLabel(last), previous: prev, since: SINCE, weeks: weeks.map((w) => ({ start: w, label: weekLabel(w) })) },
    reliability: {
      first_week: first ? { label: weekLabel(first.week_start), runs: first.runs, failed: first.failed_runs, rate: first.failure_rate.pct } : null,
      last_week: lastW ? { runs: lastW.runs, failed: lastW.failed_runs, rate: lastW.failure_rate.pct } : null,
      previous_week: prevW ? { runs: prevW.runs, failed: prevW.failed_runs, rate: prevW.failure_rate.pct } : null,
      reduction_since_first_week: reduction(first?.failure_rate.pct ?? null, lastW?.failure_rate.pct ?? null),
      failed_runs_reduction_since_first_week: reduction(first?.failed_runs ?? null, lastW?.failed_runs ?? null),
      runs_since: cw.reduce((a, w) => a + w.runs, 0),
      failed_since: cw.reduce((a, w) => a + w.failed_runs, 0),
    },
    self_healing: {
      automatic_fixes_since: cw.reduce((a, w) => a + w.automatic_fixes.total, 0),
      without_incident_since: cw.reduce((a, w) => a + w.automatic_fixes.without_incident, 0),
      automatic_fixes_last_week: lastW?.automatic_fixes.total ?? 0,
      real_faults_last_week: lastW?.real_faults ?? 0,
      engine_share: card.totals.fixed_by_engine_share,
      time_to_fix: card.totals.time_to_fix,
    },
    logs: codex.rows.map((r) => ({ builder: nameOf(r.b), submitted: r.submitted, approved: r.approved, approval_rate: pct(r.approved, r.submitted), rejected: r.rejected, waiting: r.waiting, last_week: r.wk, last_week_approved: r.wk_approved })),
    loops: loops.rows.map((r) => ({ builder: nameOf(r.b), open: r.open, closed: r.closed, close_rate: pct(r.closed, r.open + r.closed), raised_since: r.raised, closed_of_raised_since: r.raised_closed, closed_last_week: loopsClosedWeek.rows.find((x) => x.b === r.b)?.n ?? 0 })),
    agents: ['Bays', 'North Star', 'Research Twin'].map((a) => ({ agent: a, since: agentLine(a, false), last_week: agentLine(a, true) })),
    twins,
    learned: {
      patterns_total: patTotal, patterns_since: patSince, patterns_before: patBefore,
      patterns_last_week: patWeek(last), patterns_previous_week: patWeek(prev),
      sops_total: sopTotal, sops_since: sopSince, sops_last_week: sopWeek(last), sops_previous_week: sopWeek(prev), sop_note: sopNote,
    },
    weekly: weeks.map((w) => {
      const s = cw.find((x) => x.week_start === w);
      return {
        week: w, label: weekLabel(w),
        runs: s?.runs ?? 0, failure_rate: s?.failure_rate.pct ?? null, automatic_fixes: s?.automatic_fixes.total ?? 0,
        logs: logsByWeek.rows.find((x) => x.week === w)?.n ?? 0,
        loops_closed: loopsClosedByWeek.rows.find((x) => x.week === w)?.n ?? 0,
        patterns: patWeek(w), sops: sopWeek(w),
      };
    }),
  };

  return { now, data };
}

export async function build(opts: { now?: string } = {}) {
  const { now, data } = await buildData(opts);
  return { ok: true, generated_at: now, data, slack_text: slackText(data), definitions: DEFINITIONS };
}

const DEFINITIONS = [
  'Weeks run Monday to Sunday, UTC. The report covers the last full week against every full week since the self-healer went live on 21 Sep 2026.',
  'Runs are production runs (webhook, trigger and sub-workflow); manual tests, the healer’s own retries and the error handlers’ runs are left out. Failed means error or crashed.',
  'A real fault is an incident that is not a test, the simulator, a guard refusing a request on purpose, or marked a test by a person with a reason.',
  'A log is approved when Jason Status is Approved or Input Added. Logs are counted by when they were submitted.',
  'Open loops are counted once per loop id (the newest copy). Close rate is closed over open plus closed. Loops closed in a week are dated by the dashboard’s own status record.',
  'The twin review covers last week only. North Star is checked against the loop board: a loop it named counts as moved when its status changed afterwards. Research Twin and Genie are judged on their own recorded outcomes.',
  'An agent reply is delivered when it reached the person; scheduled runs that post nothing are not counted as owed. Completed means answered (for North Star, a ranking it was asked for also counts).',
];

type ReportData = Awaited<ReturnType<typeof buildData>>['data'];

type Twins = Awaited<ReturnType<typeof twinReview>>;

/** The twin review in words, for the Slack post (`*bold*`) and the BHARAG document (`**bold**`). */
export function twinLines(t: Twins, style: 'slack' | 'md'): string[] {
  const b = (x: string) => (style === 'slack' ? `*${x}*` : `**${x}**`);
  const L: string[] = [];
  const ns = t.north_star;
  if (!ns.asks) L.push(`• ${b('North Star')}: no asks recorded last week.`);
  else {
    L.push(`• ${b('North Star')} pointed people at ${n(ns.loops_pointed_at)} loops across ${n(ns.asks)} answers and rankings. ${n(ns.loops_moved)} of them moved afterwards (${fmtPct(ns.hit_rate)}), ${n(ns.loops_closed)} to closed. A loop counts as moved when its status changed after North Star first named it.`);
    if (ns.stuck.length) {
      L.push(`• Named again and again, still not moving:`);
      for (const s of ns.stuck) L.push(`    ◦ ${s.loop_id} (${s.builder ? cap(s.builder) : 'no owner'}, ${s.status ?? 'not held'}, named ${s.times_named} times): ${s.what}`);
    }
  }
  const rt = t.research_twin;
  if (!rt.asks) L.push(`• ${b('Research Twin')}: no asks recorded last week.`);
  else {
    const parts = [`${rt.answered} answered`];
    if (rt.thin) parts.push(`${rt.thin} thin`);
    if (rt.needs_human) parts.push(`${rt.needs_human} needing a person`);
    if (rt.failed) parts.push(`${rt.failed} failed`);
    if (rt.refused) parts.push(`${rt.refused} turned away as not its lane`);
    L.push(`• ${b('Research Twin')}: ${rt.asks} asks; ${parts.join(', ')}${rt.not_delivered ? `; ${rt.not_delivered} never reached the person` : ''}.`);
    for (const m of rt.misses) L.push(`    ◦ ${m.outcome}${m.delivered === 'Not delivered' ? ', not delivered' : ''}: "${m.question}"`);
  }
  const g = t.genie;
  if (!g.asks) L.push(`• ${b('Genie')}: no asks recorded last week.`);
  else {
    L.push(`• ${b('Genie')}: ${g.asks} asks; ${g.answered} answered${g.incomplete ? `, ${g.incomplete} stopped before its own check was satisfied` : ''}${g.failed ? `, ${g.failed} failed` : ''}.`);
    for (const m of g.misses) L.push(`    ◦ ${m.outcome}: "${m.question}"`);
  }
  return L;
}

/** The week's twin review as one BHARAG document, so critiques build up and can be searched. */
export function twinCritiqueDoc(d: ReportData) {
  const title = `Twin Critique: week of ${d.period.label} ${d.period.week.slice(0, 4)}`;
  const content = [
    `# ${title}`,
    '',
    `Weekly review of BHA's twins (North Star, Research Twin, Genie), written by the BHA Engine Dashboard from the engine's own records for ${d.period.week} to ${addDays(d.period.week, 6)} (UTC). Posted with the weekly Engine Health Report.`,
    '',
    ...twinLines(d.twins, 'md'),
    '',
    '## How it is judged',
    '- North Star: every loop id its answers named last week, and whether that loop\'s status changed after it was first named, before the week ended. A loop named often that does not move is either blocked or being ranked without effect.',
    '- Research Twin and Genie: their own recorded outcome and delivery for each ask. Nothing here grades what an answer said.',
  ].join('\n');
  return { title, content };
}

/**
 * Files the week's critique in BHARAG's codex workspace, where Bays searches. Once per week:
 * the document id is kept in `meta` and a repeat answers with it instead of filing twice.
 */
export async function fileTwinCritique(opts: { now?: string; dry_run?: boolean } = {}) {
  const { data } = await buildData({ now: opts.now });
  const doc = twinCritiqueDoc(data);
  const key = `twin_critique.${data.period.week}`;
  const held = await getMeta(key);
  if (held) return { ok: true, filed: false, already: true, week: data.period.week, title: doc.title, bharag_id: held, detail: `already filed for this week as ${held}` };
  if (opts.dry_run) return { ok: true, filed: false, dry_run: true, week: data.period.week, title: doc.title, content: doc.content, detail: `would file into ${bharag.ingestKeyVar('codex')}` };
  const r = await bharag.ingest('codex', {
    title: doc.title, content: doc.content, source_type: 'twin_critique', content_type: 'text',
    project_tags: ['twin-critique', 'north-star', 'research-twin', 'genie'],
    metadata: { doc_type: 'twin_critique', week_start: data.period.week, loop: 'LOOP-1792016378151-RYHY' },
  }, { source: 'dashboard:twin_critique' });
  if (!r.ok) return { ok: false, filed: false, week: data.period.week, title: doc.title, detail: r.detail };
  await setMeta(key, r.id ?? 'ingested (no id returned)');
  return { ok: true, filed: true, week: data.period.week, title: doc.title, bharag_id: r.id ?? null, detail: r.detail };
}

export function slackText(d: ReportData): string {
  const r = d.reliability;
  const sh = d.self_healing;
  const L: string[] = [];
  L.push(`*BHA Engine Health Report: week of ${d.period.label}*`);
  L.push(`Straight from the BHA Engine Dashboard. Every number is read from the engine's own records and shows what it is counted out of. Weeks run Monday to Sunday (UTC), set against every week since the self-healer went live on 21 Sep.`);
  L.push('');
  L.push('*1. Reliability*');
  if (r.first_week && r.last_week) {
    L.push(`• Failure rate: ${fmtPct(r.first_week.rate)} in the week of ${r.first_week.label} (${n(r.first_week.failed)} of ${n(r.first_week.runs)} runs) down to ${fmtPct(r.last_week.rate)} last week (${n(r.last_week.failed)} of ${n(r.last_week.runs)}).`);
    L.push(`• That is a ${fmtPct(r.reduction_since_first_week)} drop in the failure rate in ${d.period.weeks.length - 1} weeks, and ${fmtPct(r.failed_runs_reduction_since_first_week)} fewer failed runs a week.`);
    if (r.previous_week) L.push(`• Week on week: ${fmtPct(r.previous_week.rate)} the week before, ${fmtPct(r.last_week.rate)} last week.`);
  } else L.push('• Not enough full weeks recorded yet to compare.');
  L.push(`• ${n(r.runs_since)} production runs since 21 Sep, ${n(r.failed_since)} failed (${fmtPct(pct(r.failed_since, r.runs_since))}).`);
  L.push('');
  L.push('*2. Self-healing*');
  L.push(`• ${sh.automatic_fixes_since} automatic ${sh.automatic_fixes_since === 1 ? 'fix' : 'fixes'} since 21 Sep (${sh.automatic_fixes_last_week} last week); ${sh.without_incident_since} were fixed before an incident was ever opened.`);
  L.push(`• Of the real faults closed with a known closer, the engine closed ${sh.engine_share.n} of ${sh.engine_share.of} (${fmtPct(sh.engine_share.pct)}). This is the figure we are raising.`);
  const tf = sh.time_to_fix;
  if (tf.engine.n || tf.person.n) L.push(`• Time to fix: the engine's median ${tf.engine.p50_minutes === null ? 'n/a' : `${tf.engine.p50_minutes} min`} (${tf.engine.n} timed); a person's median ${tf.person.p50_minutes === null ? 'n/a' : `${Math.round((tf.person.p50_minutes / 60) * 10) / 10} h`} (${tf.person.n} timed).`);
  L.push('');
  L.push('*3. Builder logs (Codex), per person since 21 Sep*');
  for (const b of d.logs) L.push(`• ${b.builder}: ${b.submitted} submitted, ${b.approved} approved (${fmtPct(b.approval_rate)})${b.rejected ? `, ${b.rejected} rejected` : ''}${b.waiting ? `, ${b.waiting} waiting` : ''}. Last week: ${b.last_week} submitted, ${b.last_week_approved} approved.`);
  const tl = d.logs.reduce((a, b) => ({ s: a.s + b.submitted, ap: a.ap + b.approved }), { s: 0, ap: 0 });
  L.push(`• Team: ${tl.s} submitted, ${tl.ap} approved (${fmtPct(pct(tl.ap, tl.s))}).`);
  L.push('');
  L.push('*4. Open loops, per person*');
  for (const b of d.loops) L.push(`• ${b.builder}: ${b.open} open, ${b.closed} closed (${fmtPct(b.close_rate)} close rate). ${b.closed_of_raised_since} of ${b.raised_since} raised since 21 Sep are closed; ${b.closed_last_week} closed last week.`);
  const tlo = d.loops.reduce((a, b) => ({ o: a.o + b.open, c: a.c + b.closed, w: a.w + b.closed_last_week }), { o: 0, c: 0, w: 0 });
  L.push(`• Team: ${n(tlo.o)} open, ${n(tlo.c)} closed (${fmtPct(pct(tlo.c, tlo.o + tlo.c))}); ${tlo.w} closed last week.`);
  L.push('');
  L.push('*5. The agents*');
  for (const a of d.agents) {
    const s = a.since;
    const w = a.last_week;
    L.push(`• ${a.agent}: ${n(s.asks)} asks since 21 Sep; ${fmtPct(pct(s.delivered, s.owed))} delivered (${n(s.delivered)} of ${n(s.owed)}), ${fmtPct(pct(s.done, s.asks))} completed, median reply ${duration(s.p50)}. Last week: ${n(w.asks)} asks, ${fmtPct(pct(w.delivered, w.owed))} delivered, ${fmtPct(pct(w.done, w.asks))} completed.`);
  }
  L.push('');
  L.push('*6. Twin review: hits and misses*');
  L.push(...twinLines(d.twins, 'slack'));
  L.push('');
  L.push('*7. What the engine has learned*');
  const lr = d.learned;
  L.push(`• Build patterns: ${n(lr.patterns_total)} on record. ${n(lr.patterns_since)} added since 21 Sep, ${fmtPct(pct(lr.patterns_since, lr.patterns_before))} on top of the ${n(lr.patterns_before)} held before. Last week ${lr.patterns_last_week} (${fmtChange(change(lr.patterns_previous_week, lr.patterns_last_week), lr.patterns_previous_week, lr.patterns_last_week)} on the week before).`);
  if (lr.sop_note && !lr.sops_total) L.push(`• SOPs: ${lr.sop_note}.`);
  else L.push(`• SOPs: ${lr.sops_total} written, ${lr.sops_since} since 21 Sep. Last week ${lr.sops_last_week} (${fmtChange(change(lr.sops_previous_week, lr.sops_last_week), lr.sops_previous_week, lr.sops_last_week)} on the week before)${lr.sop_note ? `; ${lr.sop_note}` : ''}.`);
  L.push('');
  L.push('*8. Week by week*');
  for (const w of d.weekly) L.push(`• ${w.label}: ${n(w.runs)} runs, ${fmtPct(w.failure_rate)} failed, ${w.automatic_fixes} automatic ${w.automatic_fixes === 1 ? 'fix' : 'fixes'}, ${w.logs} logs, ${w.loops_closed} loops closed, ${w.patterns} patterns, ${w.sops} SOPs.`);
  L.push('');
  L.push('Full breakdown on Engine health: https://dashboard.bhanetwork.org/engine-health?tab=self-healing');
  return L.join('\n');
}
