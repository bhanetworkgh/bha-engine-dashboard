import { useData } from '../app/useData';
import { getCodexStats, type CodexStatMetric, type Delta } from '../data';
import { EmptyPanel, LoadFailed, Loading, MetricCard } from '../components/ui';

/**
 * The Codex statistics tab: one month set against the month before it.
 *
 * The entries tab answers "what was logged"; this one answers "is it getting
 * better or worse", which is a different question and needs a different screen.
 * Six figures — how much was logged, how much of it was approved, how fast the
 * approval came, how often the completeness check stopped a log, how much has
 * been paid, and how fast that was — each with the same figure a month ago.
 *
 * **Everything that makes a comparison honest is computed on the server** (see
 * `codexStats.ts`): which month is compared against which, whether a running
 * month was cut to a like-for-like window, and the sentence at the top. This
 * file draws it. The one rule it owns is colour: a change is coloured only
 * where the direction is news, so more logs is uncoloured and a rising
 * completeness-flag rate is red.
 */

function fmt(value: number | null, unit: CodexStatMetric['unit']): string {
  if (value === null) return '—';
  if (unit === 'percent') return `${value}%`;
  if (unit === 'days') return `${value} ${value === 1 ? 'day' : 'days'}`;
  return String(value);
}

/**
 * A change against the month before.
 *
 * A rate moves in **points**, never in a percentage of a percentage: an
 * approval rate going 80% → 90% is up 10 points, and calling that "up 12.5%"
 * is a number nobody can act on. A change from nought prints both figures
 * rather than an infinity dressed up as a percentage.
 */
function Change({ d, unit }: { d: Delta | null; unit: CodexStatMetric['unit'] }) {
  if (!d) return null;
  if (d.direction === 'flat') return <span className="text-[11.5px] text-faint">no change</span>;
  const arrow = d.direction === 'up' ? '↑' : '↓';
  const tone = d.better === null ? 'text-dim' : d.better ? 'text-ok' : 'text-failing';
  const words =
    unit === 'percent'
      ? `${Math.abs(Math.round((d.to - d.from) * 10) / 10)} points`
      : d.pct === null
        ? `${fmt(d.from, unit)} → ${fmt(d.to, unit)}`
        : `${Math.abs(d.pct)}%`;
  return (
    <span className={`tabular text-[11.5px] ${tone}`} title={`${fmt(d.from, unit)} last month, ${fmt(d.to, unit)} this one`}>
      {arrow} {words}
    </span>
  );
}

/**
 * One figure.
 *
 * A metric nothing records prints the reason where the number would be, rather
 * than a dash that reads like a quiet month or a nought that reads like a fact.
 */
function StatTile({ m, previousLabel, covered }: { m: CodexStatMetric; previousLabel: string; covered: boolean }) {
  return (
    <MetricCard title={m.label} right={m.field} note={m.note} noteMinLines={4} align="top">
      {m.unavailable ? (
        <div className="text-[13px] leading-snug text-degraded">Not recorded anywhere.</div>
      ) : (
        <div className="space-y-1.5">
          {/*
            A figure the month cannot support says so in words. A dash set in
            the display face at 30px reads like a redaction, and worse, it reads
            like a value — the one thing a missing figure must never do.
          */}
          {m.value === null ? (
            <div className="text-[13px] leading-snug text-degraded">Not recorded this month.</div>
          ) : (
            <div className="font-display tabular text-[30px] leading-none text-ink">{fmt(m.value, m.unit)}</div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Change d={m.change} unit={m.unit} />
            {m.change ? (
              <span className="text-[11px] text-faint">
                vs {fmt(m.previous, m.unit)} in {previousLabel}
              </span>
            ) : (
              <span className="text-[11px] text-faint">
                {!covered ? `nothing held for ${previousLabel}` : m.value === null ? 'no figure to compare' : `no figure for ${previousLabel}`}
              </span>
            )}
          </div>
        </div>
      )}
    </MetricCard>
  );
}

export default function CodexStatistics({ month, onMonth }: { month: string | null; onMonth: (m: string) => void }) {
  const { status, data, error } = useData(() => getCodexStats(month), [month]);

  if (status === 'error') return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.months.length === 0) {
    return (
      <div className="px-6 pb-6 md:px-8">
        <EmptyPanel>No Codex submission carries a Timestamp, so there is no month to compare.</EmptyPanel>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-6 pb-6 md:px-8">
      {/*
        The month picker, and the comparison in words under it. The sentence is
        written on the server so this tab and anything that quotes it cannot
        word the same change differently.
      */}
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker">Month in view</div>
            <div className="mt-1 text-[15px] text-ink">{data.selected_label}</div>
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-faint">
            <span>Compare</span>
            <select
              className="input h-[30px] w-auto py-0 text-[12px]"
              value={data.selected}
              onChange={(e) => onMonth(e.target.value)}
              aria-label="Month to compare"
            >
              {/* Newest first, like every other list on every page. */}
              {[...data.months].reverse().map((m) => (
                <option key={m.month} value={m.month}>
                  {m.label} · {m.logs} {m.logs === 1 ? 'log' : 'logs'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink">{data.prose}</p>
        {/*
          Why the comparison is cut, or why it is refused. Amber where there is
          nothing honest to compare against, because that is a gap rather than
          a caveat.
        */}
        <p className={`mt-1.5 text-[11.5px] leading-snug ${data.covered ? 'text-faint' : 'text-degraded'}`}>{data.note}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.metrics.map((m) => (
          <StatTile key={m.key} m={m} previousLabel={data.previous_label} covered={data.covered} />
        ))}
      </div>
    </div>
  );
}
