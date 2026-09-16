import { useData } from '../app/useData';
import { getCodexStats, getMonthly, type CodexEntry, type CodexStatMetric, type CodexStats, type Delta } from '../data';
import { EmptyPanel, Legend, LoadFailed, Loading, MetricCard, MonthChart } from '../components/ui';
import { csvRow, downloadCsv, toCsv } from '../lib/csv';

/**
 * The Codex statistics tab: one month set against the month before it.
 *
 * The entries tab answers "what was logged"; this one answers "is it getting
 * better or worse", which is a different question and needs a different screen.
 * Since 16 Sep 2026 (Destiny) it owns **everything month-shaped on this page**
 * — the month-over-month chart, the month in view, the approval-time figure and
 * the export all moved here, and the entries tab went back to being a list with
 * its filters. A small month card above a list, duplicating a screen one tab
 * away, was two answers to one question.
 *
 * **Everything that makes a comparison honest is computed on the server** (see
 * `codexStats.ts`): which month is compared against which, whether a running
 * month was cut to a like-for-like window, and the sentence at the top. This
 * file draws it. The one rule it owns is colour: a change is coloured only
 * where the direction is news, so more logs is uncoloured and a rising
 * completeness-flag rate is red.
 */

/** "18 min", "4.2 hours", "2.1 days" — the unit a person would use out loud. */
function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} sec`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 172_800_000) return `${Math.round((ms / 3_600_000) * 10) / 10} hours`;
  return `${Math.round((ms / 86_400_000) * 10) / 10} days`;
}

function fmt(value: number | null, unit: CodexStatMetric['unit']): string {
  if (value === null) return '—';
  if (unit === 'percent') return `${value}%`;
  if (unit === 'duration') return duration(value);
  return String(value);
}

/**
 * A change against the month before.
 *
 * A rate is shown as the difference between the two rates with a per-cent sign
 * — 79.3% → 76.4% reads "down 2.9%" (2026-09-16, Destiny). That is only safe
 * because both figures are printed beside it, so the number can always be
 * checked against what it came from; the tile never shows a change without
 * showing "vs 79.3% in Aug 2026" under it.
 *
 * A change from nought prints both figures rather than an infinity dressed up
 * as a percentage.
 */
function Change({ d, unit }: { d: Delta | null; unit: CodexStatMetric['unit'] }) {
  if (!d) return null;
  if (d.direction === 'flat') return <span className="text-[11.5px] text-faint">no change</span>;
  const arrow = d.direction === 'up' ? '↑' : '↓';
  const tone = d.better === null ? 'text-dim' : d.better ? 'text-ok' : 'text-failing';
  const words =
    unit === 'percent'
      ? `${Math.abs(Math.round((d.to - d.from) * 10) / 10)}%`
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

/**
 * The month in view, as a file.
 *
 * A report rather than a flat table, the same shape the Executions report
 * takes: the figures first — each with what it is a figure of, the month
 * before, the change and the caveat — then the logs the figures are about.
 * **Every caveat the screen makes is inside the file**, because a file outlives
 * the screen and a number without its boundary is how a partial month gets
 * quoted as a whole one.
 */
function report(stats: CodexStats, rows: CodexEntry[]): string {
  const lines = [
    csvRow(['BHA Codex statistics']),
    csvRow(['Month in view', stats.selected_label]),
    csvRow(['Compared against', stats.previous_label]),
    csvRow(['Window', stats.window ?? 'no comparison']),
    csvRow([
      'Like for like',
      !stats.covered
        ? 'no comparison was made'
        : stats.like_for_like
          ? 'yes, both months cut to the same elapsed days'
          : 'yes, both months complete',
    ]),
    csvRow(['In words', stats.prose]),
    csvRow(['Note', stats.note]),
    '',
    csvRow(['metric', 'source field', 'value', stats.previous_label, 'change', 'note']),
    ...stats.metrics.map((m) =>
      csvRow([
        m.label,
        m.field,
        // Blank, never a zero, where the month cannot support the figure.
        m.unavailable || m.value === null ? '' : m.unit === 'duration' ? duration(m.value) : m.unit === 'percent' ? `${m.value}%` : m.value,
        m.previous === null ? '' : m.unit === 'duration' ? duration(m.previous) : m.unit === 'percent' ? `${m.previous}%` : m.previous,
        !m.change || m.change.direction === 'flat'
          ? ''
          : `${m.change.direction} ${m.unit === 'percent' ? `${Math.abs(Math.round((m.change.to - m.change.from) * 10) / 10)}%` : m.change.pct === null ? `${m.change.from} to ${m.change.to}` : `${Math.abs(m.change.pct)}%`}`,
        m.note ?? '',
      ]),
    ),
    '',
    csvRow([`Logs written in ${stats.selected_label}`, `${rows.length}`]),
    toCsv(rows, [
      { header: 'codex_entry_id', value: (e) => e.codex_entry_id },
      { header: 'submission_id', value: (e) => e.submission_id },
      { header: 'airtable_record_id', value: (e) => e.id },
      { header: 'builder', value: (e) => e.builder_id },
      { header: 'logged_at', value: (e) => e.logged_at },
      { header: 'jason_status', value: (e) => e.jason_status },
      { header: 'jason_reviewed_at', value: (e) => e.reviewed_at },
      { header: 'stage', value: (e) => e.stage },
      { header: 'paid', value: (e) => (e.paid === null ? null : e.paid ? 'Yes' : 'No') },
      { header: 'session_description', value: (e) => e.description_excerpt },
      { header: 'session_type', value: (e) => e.session_type },
      { header: 'layer0_flagged', value: (e) => e.layer0_flagged },
      { header: 'airtable_url', value: (e) => e.airtable.url },
    ]),
  ];
  return lines.join('\r\n');
}

export default function CodexStatistics({ month, onMonth, entries }: { month: string | null; onMonth: (m: string) => void; entries: CodexEntry[] }) {
  const { status, data, error } = useData(() => getCodexStats(month), [month]);
  const monthly = useData(() => getMonthly('codex'), []);

  if (status === 'error') return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.months.length === 0) {
    return (
      <div className="px-6 pb-6 md:px-8">
        <EmptyPanel>No Codex submission carries a Timestamp, so there is no month to compare.</EmptyPanel>
      </div>
    );
  }

  // The logs the figures are about — the whole month, every builder and every
  // stage, which is what the figures above are computed over. Filtering this by
  // anything the entries tab is doing would make the file disagree with the
  // numbers printed beside the button.
  const rows = entries.filter((e) => e.logged_at?.slice(0, 7) === data.selected);

  return (
    <div className="space-y-4 px-6 pb-6 md:px-8">
      {/*
        The chart leads (2026-09-16, Destiny): every month held, at the top,
        where the shape of the year is the first thing a reader sees. Clicking a
        month is the same act as choosing it in the picker, so there is one
        selection and two ways to make it.
      */}
      {monthly.data && monthly.data.months.length > 0 && (
        <MetricCard
          title="Every month held"
          note={
            <span className="block space-y-1">
              <Legend series={monthly.data} />
              <span className="block text-[11px] leading-snug text-faint">Click a month to put it in view below.</span>
            </span>
          }
          align="top"
        >
          <MonthChart series={monthly.data} selected={data.selected} onSelect={(m) => onMonth(m ?? data.selected)} fill />
        </MetricCard>
      )}

      {/*
        The month picker, the comparison in words, and the export. The sentence
        is written on the server so this tab and the downloaded report cannot
        word the same change differently.
      */}
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker">Month in view</div>
            <div className="mt-1 text-[15px] text-ink">{data.selected_label}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => downloadCsv(`codex-${data.selected}.csv`, report(data, rows))}
              title="The figures above with every caveat, then the logs written in this month"
            >
              Export CSV
            </button>
          </div>
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
