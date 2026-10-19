import { useData } from '../../app/useData';
import { getSelfHealing, type FixTime, type HealShare } from '../../data';
import { Card, CardHeader, EmptyState, FigureCell, LoadFailed, Loading, RecordId, StatStrip, TableFrame, Th } from '../../components/ui';
import { when } from './parts';
import { HEALTH_KINDS } from './kinds';

/**
 * The self-healing scorecard (19 Oct 2026, Destiny — D2.5): what the engine did
 * about its own failures, week by week, in numbers that survive being asked how
 * they were counted. Read from `/api/engine-health/self-healing`, the same read
 * `read_self_healing` gives an MCP client, so the page and a quoted figure agree.
 *
 * Every percentage carries its denominator, no duration is a mean, and colour
 * marks only what needs a person: a real fault still open.
 */

const ratio = (s: HealShare) => (s.of ? `${s.n} of ${s.of}` : 'none to count');
const mins = (m: number | null) => (m === null ? '—' : m < 90 ? `${Math.round(m)} min` : m < 48 * 60 ? `${Math.round((m / 60) * 10) / 10} h` : `${Math.round((m / 1440) * 10) / 10} d`);
const fixLine = (t: FixTime) => (t.n ? `p50 ${mins(t.p50_minutes)}, p95 ${mins(t.p95_minutes)}, over ${t.n}` : 'no trusted close yet');
const KIND: Record<string, string> = {
  retry_recovered: 'retry recovered',
  repair_standing: 'repair standing',
  recovery_rerun: 'recovery re-run',
  one_off_closed: 'one-off closed',
  incident_self_healed: 'closed self-healed',
};
const APART: Record<string, string> = { test: 'test', simulator: 'simulator', refused_ask: 'refused ask', refused_click: 'refused click' };

export function SelfHealing() {
  const { status, data, error } = useData(getSelfHealing, [], { kinds: HEALTH_KINDS });
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  const weeks = [...data.weeks].reverse();

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto pb-6">
      <StatStrip cols={5}>
        <FigureCell label="failure rate" value={t.failure_rate.pct} unit="%" note={`${t.failed_runs.toLocaleString()} of ${t.runs.toLocaleString()} production runs since ${data.window.from}`} />
        <FigureCell label="real faults" value={t.real_faults} note={`${t.counted_apart} more counted apart: tests, the simulator and guard refusals`} />
        <FigureCell label="fixed by the engine" value={t.fixed_by_engine_share.pct} unit="%" note={`${ratio(t.fixed_by_engine_share)} real faults closed by the engine or on their own, of those closed by the engine or a person`} />
        <FigureCell label="automatic fixes" value={t.automatic_fixes} note={`${t.automatic_fixes_without_incident} of them before any incident was opened`} />
        <FigureCell label="still open" value={t.still_open} tone={t.still_open ? 'degraded' : undefined} note="real faults waiting on a person now" />
      </StatStrip>

      <div className="mx-6 grid gap-4 md:mx-8 md:grid-cols-2">
        <Card className="pb-3">
          <CardHeader title="How real faults closed" right={<span className="text-[11.5px] text-faint">since {data.window.from}</span>} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-5 text-[13px]">
            <dt className="text-dim">By the engine</dt><dd className="tabular text-right">{t.closed_real_faults.engine}</dd>
            <dt className="text-dim">Cleared on its own</dt><dd className="tabular text-right">{t.closed_real_faults.cleared_itself}</dd>
            <dt className="text-dim">By a person</dt><dd className="tabular text-right">{t.closed_real_faults.person}</dd>
            <dt className="text-dim">By policy (chat not re-run)</dt><dd className="tabular text-right">{t.closed_real_faults.policy}</dd>
            <dt className="text-dim">Not recorded (before 2 Oct)</dt><dd className="tabular text-right">{t.closed_real_faults.not_recorded}</dd>
          </dl>
          <p className="px-5 pt-3 text-[12px] text-dim">Time to fix, engine: {fixLine(t.time_to_fix.engine)}. Person: {fixLine(t.time_to_fix.person)}. Closes on or after 2 Oct 2026 only.</p>
        </Card>
        <Card className="pb-3">
          <CardHeader title="How the healer routed each failure" right={<span className="text-[11.5px] text-faint">since {data.healer_routes.since}</span>} />
          {data.healer_routes.rows.length === 0 ? (
            <EmptyState compact>{data.healer_routes.note}</EmptyState>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-5 text-[13px]">
              {data.healer_routes.rows.map((r) => (
                <div key={`${r.route}-${r.kind}`} className="contents">
                  <dt className="text-dim">{r.route ?? '?'} · {(r.kind ?? '').replace(/_/g, ' ')}</dt>
                  <dd className="tabular text-right">{r.n}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <Card className="mx-6 pb-3 md:mx-8">
        <CardHeader title="Week by week" right={<span className="text-[11.5px] text-faint">newest first; this week is still running</span>} />
        <TableFrame flat grow={false} label="Self-healing week by week">
          <thead>
            <tr>
              <Th>week of</Th>
              <Th>runs</Th>
              <Th>failed</Th>
              <Th>real faults</Th>
              <Th>apart</Th>
              <Th>automatic fixes</Th>
              <Th>engine · person · other</Th>
              <Th>open</Th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => {
              const c = w.closed_real_faults;
              const apart = Object.entries(w.counted_apart).map(([k, n]) => `${n} ${APART[k] ?? k}`).join(', ');
              return (
                <tr key={w.week_start}>
                  <td className="td tabular whitespace-nowrap">{w.week_start}{w.partial ? <span className="text-faint"> (so far)</span> : null}</td>
                  <td className="td tabular">{w.runs.toLocaleString()}</td>
                  <td className="td tabular">{w.failed_runs} <span className="text-faint">({w.failure_rate.pct ?? 0}%)</span></td>
                  <td className="td tabular">{w.real_faults}{w.real_faults_raised_by_alarm ? <span className="text-faint"> ({w.real_faults_raised_by_alarm} by an alarm)</span> : null}</td>
                  <td className="td text-dim">{apart || '—'}</td>
                  <td className="td tabular">{w.automatic_fixes.total}{w.automatic_fixes.without_incident ? <span className="text-faint"> ({w.automatic_fixes.without_incident} with no incident)</span> : null}</td>
                  <td className="td tabular">{c.engine + c.cleared_itself} · {c.person} · {c.policy + c.not_recorded}</td>
                  <td className={`td tabular ${w.still_open ? 'text-degraded' : ''}`}>{w.still_open}</td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      </Card>

      <div className="mx-6 grid gap-4 md:mx-8 md:grid-cols-2">
        <Card className="pb-3">
          <CardHeader title="Recent automatic fixes" />
          {data.recent_fixes.length === 0 ? (
            <EmptyState compact>No automatic fix is recorded in this window.</EmptyState>
          ) : (
            <ul className="px-5 text-[12.5px]">
              {data.recent_fixes.slice(0, 10).map((f) => (
                <li key={f.key} className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
                  <span className="min-w-0 truncate"><RecordId>{f.key}</RecordId> <span className="text-dim">{f.workflow ?? ''}</span></span>
                  <span className="whitespace-nowrap text-faint">{KIND[f.kind] ?? f.kind} · {when(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="pb-3">
          <CardHeader title="How it is counted" />
          <ul className="list-disc space-y-1.5 px-9 text-[12px] text-dim">
            {data.definitions.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
