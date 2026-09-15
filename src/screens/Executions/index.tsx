import { useState } from 'react';
import { useData } from '../../app/useData';
import { getExecutions, type ExecutionDelta, type ExecutionGrain, type ExecutionPeriod, type ExecutionSystem, type ExecutionWorkflow, type ExecutionsData } from '../../data';
import { EmptyPanel, LoadFailed, Loading, MetricCard, PageHeader, Segmented, StatCell, StatStrip, Tabs, relativeTime } from '../../components/ui';

/**
 * Executions — every run of every workflow in the engine, as a record kind.
 *
 * It replaced a Bays page that held only Bays' executions (decision
 * 2026-09-15, Destiny). A run is a record like any other and it is the same
 * record whichever system produced it, so one page with a tab per system beats
 * a section repeated on three. Bays, North Star and Research Twin are the tabs
 * because those are the systems running anything today; **All systems** leads,
 * because "every execution across the engine" is what the page is for and the
 * per-system tabs are how you narrow it.
 *
 * **The counts are read from a snapshot in Postgres, never from n8n's own
 * history for a past period.** n8n keeps about three days of executions and
 * then discards them; on 15 Sep 2026 it held 3,673 and none older than the
 * 12th. A live query would answer honestly that August held nothing, and the
 * chart would draw an empty period for one that was busy. So a period before
 * counting started carries no bar at all and the boundary is labelled, exactly
 * as the record pages label theirs.
 *
 * **Weekly, monthly and yearly** come from the same daily rows, so they cannot
 * disagree. Yearly has one partial year in it today, and says so rather than
 * drawing a year's worth of bar from four days.
 */

const GRAINS: { value: ExecutionGrain; label: string }[] = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

const NOUN: Record<ExecutionGrain, string> = { week: 'week', month: 'month', year: 'year' };

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 1000) / 10}%`;
}

/** Milliseconds as something a person reads: 840 ms, 4.2 s, 3 m 12 s. */
function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${s} s`;
}

function rateTone(rate: number | null): string {
  if (rate === null) return 'text-dim';
  if (rate >= 0.1) return 'text-failing';
  if (rate > 0) return 'text-degraded';
  return 'text-ink';
}

/**
 * A change against last period.
 *
 * Amber and red only where the movement is genuinely bad news, never on a
 * direction for its own sake: more executions is up and means nothing on its
 * own, more failures is up and is bad, a faster average is down and is good.
 * A change against nought has no percentage, so it prints the two figures
 * rather than an infinity dressed up as one.
 */
function Delta({ d, format = (n: number) => String(n), suffix = '' }: { d: ExecutionDelta | null; format?: (n: number) => string; suffix?: string }) {
  if (!d) return null;
  if (d.direction === 'flat') return <span className="text-[11.5px] text-faint">no change</span>;
  const arrow = d.direction === 'up' ? '↑' : '↓';
  const tone = d.better === null ? 'text-dim' : d.better ? 'text-ok' : 'text-failing';
  return (
    <span className={`tabular text-[11.5px] ${tone}`} title={`${format(d.from)}${suffix} last period, ${format(d.to)}${suffix} this one`}>
      {arrow} {d.pct === null ? `${format(d.from)}${suffix} → ${format(d.to)}${suffix}` : `${Math.abs(d.pct)}%`}
    </span>
  );
}

/* ------------------------------------------------------------------ chart */

const BAR = 26;
const GAP = 12;
const H = 96;
/** A gutter so the first period's label is not clipped by the edge of the svg. */
const PAD = 16;

/** Executions and failures per period. A period nothing was counted in draws no bar. */
function PeriodChart({ periods, grain, selected, onSelect }: { periods: ExecutionPeriod[]; grain: ExecutionGrain; selected: string; onSelect: (key: string) => void }) {
  const shown = periods.slice(-18);
  const max = Math.max(1, ...shown.map((p) => p.executions));
  const width = shown.length * (BAR + GAP);
  const firstCovered = shown.findIndex((p) => p.coverage !== 'none');
  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg width={Math.max(width, 120) + PAD * 2} height={H + 30} role="img" aria-label={`Executions by ${NOUN[grain]}`} className="block">
        <defs>
          <pattern id="exec-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--ink)" opacity="0.18" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink)" strokeWidth="2.4" />
          </pattern>
        </defs>
        <line x1={PAD} y1={H} x2={PAD + Math.max(width - GAP, 1)} y2={H} stroke="var(--line)" strokeWidth="1" />
        {firstCovered > 0 && (
          <g>
            <line x1={PAD + firstCovered * (BAR + GAP) - GAP / 2} y1="2" x2={PAD + firstCovered * (BAR + GAP) - GAP / 2} y2={H} stroke="var(--degraded)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={PAD + firstCovered * (BAR + GAP) - GAP / 2 + 4} y="11" fontSize="9.5" fill="var(--degraded)">
              counting starts
            </text>
          </g>
        )}
        {shown.map((p, i) => {
          const x = PAD + i * (BAR + GAP);
          const on = selected === p.key;
          const h = p.coverage === 'none' ? 0 : Math.round((p.executions / max) * (H - 16));
          const fh = p.coverage === 'none' || !p.executions ? 0 : Math.round((p.failures / max) * (H - 16));
          return (
            <g key={p.key} className="cursor-pointer" onClick={() => onSelect(p.key)}>
              <rect x={x - GAP / 2} y="0" width={BAR + GAP} height={H + 30} fill={on ? 'var(--hover)' : 'transparent'} />
              {p.coverage === 'none' ? (
                <line x1={x} y1={H - 1} x2={x + BAR} y2={H - 1} stroke="var(--faint)" strokeWidth="2" strokeDasharray="2 2" />
              ) : (
                <>
                  <rect x={x} y={H - h} width={BAR} height={h} rx="2" fill={p.coverage === 'partial' ? 'url(#exec-hatch)' : 'var(--ink)'} opacity={p.coverage === 'partial' ? 0.85 : 1} />
                  {/* Failures sit inside the same bar, so the eye reads a share rather than two totals. */}
                  {fh > 0 && <rect x={x} y={H - fh} width={BAR} height={fh} rx="2" fill="var(--failing)" />}
                </>
              )}
              <text x={x + BAR / 2} y={H + 14} textAnchor="middle" fontSize="10" fill={on ? 'var(--ink)' : 'var(--faint)'}>
                {p.label}
              </text>
              {p.coverage !== 'full' && (
                <text x={x + BAR / 2} y={H + 25} textAnchor="middle" fontSize="9" fill="var(--degraded)">
                  {p.coverage === 'none' ? 'none' : 'part'}
                </text>
              )}
              <title>
                {p.coverage === 'none'
                  ? `${p.label}: nothing was being counted. ${p.note ?? ''}`
                  : `${p.label} (${p.start} to ${p.end}): ${p.executions} executions, ${p.failures} failed, average ${duration(p.avg_ms)}${p.note ? ` — ${p.note}` : ''}`}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------- workflows */

function WorkflowRow({ w, base }: { w: ExecutionWorkflow; base: string | null }) {
  const [open, setOpen] = useState(false);
  const rate = w.executions ? w.failures / w.executions : null;
  return (
    <>
      <tr className={w.failures ? 'cursor-pointer' : ''} onClick={() => w.failures && setOpen((v) => !v)}>
        <td className="td card-title td-clip" style={{ maxWidth: '36ch' }} title={w.workflow_name}>
          {w.n8n_url ? (
            <a href={w.n8n_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="hover:text-accent-ink">
              {w.workflow_name}
            </a>
          ) : (
            w.workflow_name
          )}
        </td>
        <td className="td card-meta tabular text-right text-ink">
          {w.executions}
          <span className="text-faint md:hidden"> executions</span>
        </td>
        <td className={`td card-meta tabular text-right ${w.failures ? 'text-failing' : 'text-faint'}`}>
          {w.failures}
          <span className="text-faint md:hidden"> failed</span>
        </td>
        <td className={`td card-meta tabular text-right ${rateTone(rate)}`}>
          {pct(rate)}
          <span className="text-faint md:hidden"> failure rate</span>
        </td>
        <td className="td card-meta tabular text-right text-dim" title={w.timed ? `Mean over the ${w.timed} of ${w.executions} runs that recorded an end` : 'No run recorded an end, so there is no average'}>
          {duration(w.avg_ms)}
          <span className="text-faint md:hidden"> average</span>
        </td>
        <td className="td card-meta text-right text-[11px] text-faint">{w.failures ? (open ? 'hide ids' : 'show ids') : ''}</td>
      </tr>
      {open && w.failures > 0 && (
        <tr>
          <td colSpan={6} className="td card-full">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[11.5px]">
              <span className="text-faint">failing executions</span>
              {w.failed_ids.map((id) => (
                <a
                  key={id}
                  href={base ? `${base}/workflow/${w.workflow_id}/executions/${id}` : undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="tabular tag hover:text-accent-ink"
                  title="Open this execution in n8n"
                >
                  {id}
                </a>
              ))}
              {w.failed_ids.length < w.failures && (
                <span className="text-faint">
                  — the newest {w.failed_ids.length} of {w.failures}; n8n discards an execution a few days after it runs, so an older id may no longer open.
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ page */

function SystemView({ system, data, grain }: { system: ExecutionSystem; data: ExecutionsData; grain: ExecutionGrain }) {
  const [selected, setSelected] = useState<string | null>(null);
  const key = selected ?? system.period;
  const period = system.periods.find((p) => p.key === key) ?? system.periods[system.periods.length - 1];
  // The comparison is computed for the system's own newest period; selecting an
  // older one shows that period's figures without pretending the comparison
  // moved with it.
  const comparing = key === system.period ? system.comparison : null;
  const nothing = system.periods.every((p) => p.executions === 0);
  const base = data.snapshot.n8n_base;
  const noun = NOUN[grain];

  return (
    <>
      <StatStrip cols={4}>
        <StatCell>
          <div className="kicker truncate">Executions</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{nothing ? '—' : (period?.executions ?? 0)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            {comparing?.executions ? <Delta d={comparing.executions} /> : null}
            <span>{period ? `${period.start} to ${period.end}` : `this ${noun}`}</span>
          </div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Succeeded</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{nothing ? '—' : (period?.successes ?? 0)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            {comparing?.successes ? <Delta d={comparing.successes} /> : null}
            <span>finished without an error</span>
          </div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Failed</div>
          <div className={`font-display tabular mt-1 text-[28px] leading-none ${period?.failures ? 'text-failing' : 'text-dim'}`}>{nothing ? '—' : (period?.failures ?? 0)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            {comparing?.failures ? <Delta d={comparing.failures} /> : null}
            <span>{pct(period?.failure_rate ?? null)} of runs</span>
          </div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Average time</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{duration(period?.avg_ms ?? null)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            {comparing?.avg_ms ? <Delta d={comparing.avg_ms} format={(n) => duration(n)} /> : null}
            <span>
              {period?.timed ? `over the ${period.timed} of ${period.executions} runs that recorded an end` : 'no run recorded an end'}
            </span>
          </div>
        </StatCell>
      </StatStrip>

      {/* What the comparison is actually against. Said once, plainly. */}
      {comparing && (
        <div className="mx-6 mb-4 md:mx-8">
          <p className="text-[11.5px] leading-snug text-faint">
            <span className="text-dim">Compared with last {noun}:</span> {comparing.note}
            {comparing.like_for_like && comparing.executions && ' A whole period against a part of one would read as a collapse every time a new one started.'}
          </p>
        </div>
      )}

      <div className="mx-6 mb-4 md:mx-8">
        <MetricCard
          title={`Executions by ${noun}`}
          right={<span className="text-[11px] text-faint">bar = executions · red = failures · click one to read it</span>}
          note={
            <span className="block space-y-1">
              {period?.note && <span className="block text-[11px] leading-snug text-degraded">{period.note}</span>}
              <span className="block text-[11px] leading-snug text-faint">{data.snapshot.note}</span>
              {data.boundary && <span className="block text-[11px] leading-snug text-degraded">{data.boundary.note}</span>}
              {data.snapshot.at && <span className="block text-[11px] leading-snug text-faint">Last counted {relativeTime(data.snapshot.at) ?? data.snapshot.at}.</span>}
            </span>
          }
        >
          {nothing ? <EmptyPanel>{data.snapshot.note}</EmptyPanel> : <PeriodChart periods={system.periods} grain={grain} selected={key} onSelect={setSelected} />}
        </MetricCard>
      </div>

      <div className="mx-6 mb-6 md:mx-8">
        <div className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3">
            <div className="text-[13px] font-medium text-ink">By workflow</div>
            <div className="tabular text-[11.5px] text-faint">
              {period ? `${period.label} · ${period.start} to ${period.end}` : ''}
            </div>
          </div>
          {system.workflows.length === 0 || key !== system.period ? (
            <div className="px-5 py-8 text-center text-[13px] text-dim">
              {nothing
                ? data.snapshot.note
                : key !== system.period
                  ? `The per-workflow breakdown is kept for ${system.periods.find((p) => p.key === system.period)?.label ?? 'the newest period'}, the newest with anything in it. Clear the selection on the chart to see it.`
                  : `No ${system.label === 'All systems' ? '' : `${system.label} `}workflow ran in this ${noun}.`}
            </div>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="table-cards w-full border-collapse text-[12.5px]" aria-label={`${system.label} workflows`}>
                <thead>
                  <tr>
                    {['workflow', 'executions', 'failed', 'failure rate', 'average time', ''].map((h, i) => (
                      <th key={i} className={`border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-faint ${i > 0 && i < 5 ? 'text-right' : ''}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {system.workflows.map((w) => (
                    <WorkflowRow key={w.workflow_id} w={w} base={base} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function Executions() {
  const [grain, setGrain] = useState<ExecutionGrain>('week');
  const [tab, setTab] = useState('All systems');
  const { status, data, error } = useData(() => getExecutions(grain), [grain]);

  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  const tabs = data.systems.map((s) => s.label);
  const system = data.systems.find((s) => s.label === tab) ?? data.systems[0];
  const counts = Object.fromEntries(
    data.systems.map((s) => [
      s.label,
      { n: s.executions, tone: s.failure_rate !== null && s.failure_rate >= 0.1 ? ('failing' as const) : s.failure_rate ? ('degraded' as const) : ('default' as const) },
    ]),
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Executions"
        subtitle="Every run of every workflow in the engine, and how it went"
        right={<Segmented<ExecutionGrain> ariaLabel="Period" value={grain} onChange={setGrain} options={GRAINS} />}
        below={<Tabs tabs={tabs} value={tab} onChange={setTab} counts={counts} />}
      />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <SystemView key={`${system.system}-${grain}`} system={system} data={data} grain={grain} />

        {/*
          A workflow n8n is running that no registry row names a system for. It
          is counted in All systems and listed here rather than filed under a
          guess: it is a registry row somebody needs to add, which is
          actionable, and the wrong heading would not be.
        */}
        {tab === 'All systems' && data.unregistered.length > 0 && (
          <div className="mx-6 mb-6 md:mx-8">
            <MetricCard
              title="Workflows in no system"
              note="Each of these is running in n8n and has no row in the workflow registry naming its system, so it is counted in All systems and appears under no tab. Adding the registry row files it under the right one — the mapping is a row, not a deploy."
            >
              <div className="space-y-1.5 text-[12.5px]">
                {data.unregistered.map((w) => (
                  <div key={w.workflow_id} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-dim">{w.workflow_name}</span>
                    <span className="tabular shrink-0 text-faint">
                      {w.executions} executions{w.failures ? <span className="text-failing"> · {w.failures} failed</span> : ''}
                    </span>
                  </div>
                ))}
              </div>
            </MetricCard>
          </div>
        )}
      </div>
    </div>
  );
}
