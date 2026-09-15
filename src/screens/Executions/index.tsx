import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../app/useData';
import {
  backfillExecutions,
  getExecutionWorkflow,
  getExecutions,
  type ExecutionDelta,
  type ExecutionGrain,
  type ExecutionPeriod,
  type ExecutionRun,
  type ExecutionSystem,
  type ExecutionWorkflow,
  type ExecutionWorkflowDetail,
  type ExecutionsData,
} from '../../data';
import { buildReport, reportName } from '../../lib/executionReport';
import { downloadCsv } from '../../lib/csv';
import { EmptyPanel, LoadFailed, Loading, MetricCard, PageHeader, Segmented, StatCell, StatStrip, Tabs, Toast, relativeTime, useToast } from '../../components/ui';

/**
 * Executions — every run of every workflow in the engine, one row per run.
 *
 * **The figures here are queries over stored executions, not counters.** The
 * page that shipped this morning kept per-day totals and every number on it was
 * wrong: each figure read sixty times what n8n held, failures read nought, and
 * seven workflows of thirty-one appeared. One paging bug in the reader caused
 * all three, and a counter cannot notice it is being told the same execution
 * twice. Keyed on the execution id, none of that is expressible.
 *
 * **It is a poll, not a live feed.** n8n has nothing to push when an execution
 * finishes, and instrumenting each workflow to report its own runs would make
 * every workflow somebody forgets a silent gap. So the server reads what is
 * above the highest id it holds every 45 seconds, this page re-reads on the
 * same interval, and both say so rather than implying the numbers are live.
 *
 * **Tabs are systems, and Unregistered is one of them.** A workflow the
 * registry names no system for is counted in All systems and listed under its
 * own tab — never dropped, never filed under a guess. A workflow must not be
 * invisible because a registry row is missing.
 */

/** The page re-reads on the same interval the server polls on. */
const REFRESH_MS = 45_000;

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

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19).replace('T', ' ');
}

function rateTone(rate: number | null): string {
  if (rate === null) return 'text-dim';
  if (rate >= 0.1) return 'text-failing';
  if (rate > 0) return 'text-degraded';
  return 'text-ink';
}

/**
 * n8n's own word for how a run ended, coloured only where the word is bad news.
 *
 * Success is the ordinary case and gets no colour: a column of green on a page
 * where almost everything succeeds is decoration, and decoration in the colours
 * that mean "failing" and "degraded" is exactly what the palette rule forbids.
 */
function statusTone(status: string): string {
  if (status === 'error' || status === 'crashed') return 'text-failing';
  if (status === 'running' || status === 'waiting' || status === 'new') return 'text-degraded';
  return 'text-dim';
}

/**
 * A change against the previous period.
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

/** Executions and failures per period. A period nothing is held for draws no bar at all. */
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
              history begins
            </text>
          </g>
        )}
        {shown.map((p, i) => {
          const x = PAD + i * (BAR + GAP);
          const on = selected === p.key;
          const h = p.coverage === 'none' ? 0 : Math.round((p.executions / max) * (H - 16));
          const fh = p.coverage === 'none' || !p.executions ? 0 : Math.round((p.failed / max) * (H - 16));
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
                  ? `${p.label}: nothing is held. ${p.note ?? ''}`
                  : `${p.label} (${p.start} to ${p.end}): ${p.executions} executions, ${p.failed} failed, average ${duration(p.avg_ms)}${p.note ? ` — ${p.note}` : ''}`}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------- one workflow */

/**
 * A workflow opened up: its days inside the period, and its own executions with
 * ids, start times, durations and outcomes.
 *
 * This is the capability the counter tables could not support at all, and the
 * reason every execution is stored as its own row.
 */
function WorkflowPanel({ workflowId, grain, period, onClose }: { workflowId: string; grain: ExecutionGrain; period: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ExecutionWorkflowDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);

  useEffect(() => {
    let live = true;
    setDetail(null);
    getExecutionWorkflow(workflowId, grain, period)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : 'Could not load the workflow.'));
    return () => {
      live = false;
    };
  }, [workflowId, grain, period]);

  const runs: ExecutionRun[] = (detail?.runs ?? []).filter((r) => !failedOnly || r.status === 'error' || r.status === 'crashed');
  const maxDay = Math.max(1, ...(detail?.days ?? []).map((d) => d.executions));

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Workflow executions">
        {err ? (
          <div className="text-[13px] text-failing">{err}</div>
        ) : !detail ? (
          <div className="text-[13px] text-faint">Loading…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="kicker tabular">{detail.workflow.system ?? 'no system in the workflow registry'}</div>
                <h2 className="mt-0.5 truncate text-[17px] font-semibold text-ink">{detail.workflow.workflow_name}</h2>
                <div className="tabular mt-1 text-[11.5px] text-faint">
                  {detail.period.label} · {detail.period.start} to {detail.period.end} · workflow {detail.workflow.workflow_id}
                </div>
              </div>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                { k: 'executions', v: String(detail.workflow.executions), tone: 'text-ink' },
                { k: 'succeeded', v: String(detail.workflow.succeeded), tone: 'text-ink' },
                { k: 'failed', v: String(detail.workflow.failed), tone: detail.workflow.failed ? 'text-failing' : 'text-dim' },
                { k: 'failure rate', v: pct(detail.workflow.failure_rate), tone: rateTone(detail.workflow.failure_rate) },
                { k: 'average time', v: duration(detail.workflow.avg_ms), tone: 'text-ink' },
              ].map((f) => (
                <div key={f.k} className="rounded-[12px] bg-raised px-3 py-2.5">
                  <div className="kicker truncate">{f.k}</div>
                  <div className={`font-display tabular mt-1 text-[19px] leading-none ${f.tone}`}>{f.v}</div>
                </div>
              ))}
            </div>

            {detail.days.length > 0 && (
              <div className="mt-5">
                <div className="text-[12.5px] font-medium text-ink">By day</div>
                <div className="mt-2 space-y-1">
                  {detail.days.map((d) => (
                    <div key={d.day} className="flex items-center gap-3">
                      <span className="tabular w-[84px] shrink-0 text-[11.5px] text-faint">{d.day}</span>
                      <span className="flex h-3 flex-1 items-center gap-0.5">
                        <span className="h-3 rounded-[2px] bg-ink/80" style={{ width: `${Math.round(((d.executions - d.failed) / maxDay) * 100)}%` }} />
                        {d.failed > 0 && <span className="h-3 rounded-[2px] bg-failing" style={{ width: `${Math.round((d.failed / maxDay) * 100)}%` }} />}
                      </span>
                      <span className="tabular w-[150px] shrink-0 text-right text-[11.5px] text-faint">
                        {d.executions} run{d.executions === 1 ? '' : 's'}
                        {d.failed ? <span className="text-failing"> · {d.failed} failed</span> : ''} · {duration(d.avg_ms)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[12.5px] font-medium text-ink">Executions</div>
              <div className="flex items-center gap-3 text-[11.5px] text-faint">
                {detail.workflow.failed > 0 && (
                  <button type="button" className="hover:text-accent-ink" onClick={() => setFailedOnly((v) => !v)}>
                    {failedOnly ? 'show all' : 'failures only'}
                  </button>
                )}
                <span className="tabular">
                  {runs.length} shown{detail.runs_total > detail.runs.length ? ` of ${detail.runs_total}, newest first` : ''}
                </span>
              </div>
            </div>
            <div className="scroll-thin mt-2 max-h-[340px] overflow-y-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    {['execution', 'started', 'duration', 'how it ran', 'outcome'].map((h, i) => (
                      <th key={h} className={`sticky top-0 border-b border-line bg-panel px-2 py-1.5 text-left text-[11px] font-medium whitespace-nowrap text-faint ${i > 1 ? 'text-right' : ''}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.execution_id} className="border-b border-line/60">
                      <td className="tabular px-2 py-1.5">
                        {detail.n8n_base ? (
                          <a href={`${detail.n8n_base}/workflow/${detail.workflow.workflow_id}/executions/${r.execution_id}`} target="_blank" rel="noreferrer" className="hover:text-accent-ink">
                            {r.execution_id}
                          </a>
                        ) : (
                          r.execution_id
                        )}
                      </td>
                      <td className="tabular px-2 py-1.5 text-dim">
                        {r.started_at.slice(0, 10)} {clock(r.started_at)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right text-dim">{r.duration_ms === null ? 'no end recorded' : duration(r.duration_ms)}</td>
                      <td className="px-2 py-1.5 text-right text-faint">{r.mode ?? '—'}</td>
                      <td className={`px-2 py-1.5 text-right ${statusTone(r.status)}`}>{r.status}</td>
                    </tr>
                  ))}
                  {runs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-6 text-center text-[12.5px] text-dim">
                        {failedOnly ? 'No execution of this workflow failed in this period.' : 'This workflow ran nothing in this period.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- workflows */

function WorkflowRow({ w, onOpen }: { w: ExecutionWorkflow; onOpen: () => void }) {
  return (
    <tr className="cursor-pointer" onClick={onOpen}>
      <td className="td card-title td-clip" style={{ maxWidth: '36ch' }} title={w.registered ? w.workflow_name : `${w.workflow_name} — no workflow registry row names a system for this one`}>
        {w.workflow_name}
        {!w.registered && <span className="ml-1.5 text-[10.5px] text-degraded">unregistered</span>}
      </td>
      <td className="td card-meta tabular text-right text-ink">
        {w.executions}
        <span className="text-faint md:hidden"> executions</span>
      </td>
      <td className={`td card-meta tabular text-right ${w.failed ? 'text-failing' : 'text-faint'}`}>
        {w.failed}
        <span className="text-faint md:hidden"> failed</span>
      </td>
      <td className={`td card-meta tabular text-right ${rateTone(w.failure_rate)}`}>
        {pct(w.failure_rate)}
        <span className="text-faint md:hidden"> failure rate</span>
      </td>
      <td className="td card-meta tabular text-right text-dim" title={w.timed ? `Mean over the ${w.timed} of ${w.executions} runs that recorded an end` : 'No run recorded an end, so there is no average'}>
        {duration(w.avg_ms)}
        <span className="text-faint md:hidden"> average</span>
      </td>
      <td className="td card-meta text-right text-[11px] text-faint">open</td>
    </tr>
  );
}

/* ------------------------------------------------------------------ page */

function SystemView({
  system,
  data,
  grain,
  onSelectPeriod,
  onOpenWorkflow,
}: {
  system: ExecutionSystem;
  data: ExecutionsData;
  grain: ExecutionGrain;
  onSelectPeriod: (key: string) => void;
  onOpenWorkflow: (id: string) => void;
}) {
  const period = system.period;
  const c = system.comparison;
  const nothing = system.periods.every((p) => p.executions === 0);
  const noun = NOUN[grain];

  return (
    <>
      {/*
        The period in words, above the figures, because "failures down 40%" is
        how somebody reads a change and "12 against 20" is not. Written by the
        server so this and the downloaded report cannot word it differently.
      */}
      <div className="mx-6 mb-4 md:mx-8">
        <div className="card px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div className="text-[13px] font-medium text-ink">
              {period.label} · {system.label}
            </div>
            <div className="tabular text-[11.5px] text-faint">
              {period.start} to {period.end}
              {period.current ? ` · still running` : ''}
            </div>
          </div>
          <p className={`mt-1.5 text-[13px] leading-relaxed ${c.covered ? 'text-ink' : 'text-degraded'}`}>{c.prose}</p>
          <p className="mt-1 text-[11.5px] leading-snug text-faint">{c.note}</p>
        </div>
      </div>

      <StatStrip cols={4}>
        <StatCell>
          <div className="kicker truncate">Executions</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{nothing ? '—' : period.executions}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            <Delta d={c.executions} />
            <span>{period.unfinished ? `${period.unfinished} still running` : `across ${system.workflows.length} workflow${system.workflows.length === 1 ? '' : 's'}`}</span>
          </div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Succeeded</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{nothing ? '—' : period.succeeded}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            <Delta d={c.successes} />
            <span>{period.canceled ? `${period.canceled} canceled by hand` : 'finished without an error'}</span>
          </div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Failed</div>
          <div className={`font-display tabular mt-1 text-[28px] leading-none ${period.failed ? 'text-failing' : 'text-dim'}`}>{nothing ? '—' : period.failed}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            <Delta d={c.failures} />
            <span>{pct(period.failure_rate)} of {period.finished} finished runs</span>
          </div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Average time</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{duration(period.avg_ms)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-snug text-faint">
            <Delta d={c.avg_ms} format={(n) => duration(n)} />
            <span>{period.timed ? `over the ${period.timed} of ${period.executions} runs that recorded an end` : 'no run recorded an end'}</span>
          </div>
        </StatCell>
      </StatStrip>

      <div className="mx-6 mb-4 md:mx-8">
        <MetricCard
          title={`Executions by ${noun}`}
          right={<span className="text-[11px] text-faint">bar = executions · red = failures · click one to read it</span>}
          note={
            <span className="block space-y-1">
              {period.note && <span className="block text-[11px] leading-snug text-degraded">{period.note}</span>}
              <span className="block text-[11px] leading-snug text-faint">{data.source.note}</span>
              {data.boundary && <span className="block text-[11px] leading-snug text-degraded">{data.boundary.note}</span>}
              {data.source.warning && <span className="block text-[11px] leading-snug text-failing">{data.source.warning}</span>}
              {data.source.at && (
                <span className="block text-[11px] leading-snug text-faint">
                  Last read {relativeTime(data.source.at) ?? data.source.at} · {data.source.held} executions held
                  {data.source.oldest ? `, from ${data.source.oldest}` : ''}
                  {data.source.highest_id ? ` · newest id ${data.source.highest_id}` : ''}.
                </span>
              )}
            </span>
          }
        >
          {nothing ? <EmptyPanel>{data.source.note}</EmptyPanel> : <PeriodChart periods={system.periods} grain={grain} selected={period.key} onSelect={onSelectPeriod} />}
        </MetricCard>
      </div>

      <div className="mx-6 mb-6 md:mx-8">
        <div className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3">
            <div className="text-[13px] font-medium text-ink">By workflow</div>
            <div className="tabular text-[11.5px] text-faint">
              {period.label} · click a workflow for its own executions
            </div>
          </div>
          {system.workflows.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-dim">
              {nothing ? data.source.note : `No ${system.label === 'All systems' ? '' : `${system.label} `}workflow ran in this ${noun}.`}
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
                    <WorkflowRow key={w.workflow_id} w={w} onOpen={() => onOpenWorkflow(w.workflow_id)} />
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
  const [period, setPeriod] = useState<string | null>(null);
  const [tab, setTab] = useState('All systems');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();

  const { status, data, error } = useData(() => getExecutions(grain, period ?? undefined), [grain, period, tick], REFRESH_MS);

  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  const system = data.systems.find((s) => s.label === tab) ?? data.systems[0];
  const counts = Object.fromEntries(
    data.systems.map((s) => [
      s.label,
      { n: s.period.executions, tone: s.period.failure_rate !== null && s.period.failure_rate >= 0.1 ? ('failing' as const) : s.period.failure_rate ? ('degraded' as const) : ('default' as const) },
    ]),
  );

  /** Reads n8n's whole history again. Idempotent — every row is keyed on the execution id. */
  const reread = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const r = await backfillExecutions();
        setTick((n) => n + 1);
        setToast(
          r.ran
            ? { text: `Read ${r.read} executions from n8n in ${(r.ms / 1000).toFixed(1)}s · ${r.inserted} new, ${r.updated} already held${r.warning ? ` · ${r.warning}` : ''}`, tone: r.warning ? 'failing' : 'ok' }
            : { text: r.note, tone: 'failing' },
        );
      } catch (e) {
        setToast({ text: e instanceof Error ? e.message : 'The read did not run.', tone: 'failing' });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Executions"
        subtitle={`Every run of every workflow in the engine — read from n8n every ${data.source.poll_seconds} seconds, not live`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<ExecutionGrain>
              ariaLabel="Period"
              value={grain}
              onChange={(g) => {
                // A period key belongs to its grain: 2026-W38 means nothing to a
                // monthly view, so changing the grain returns to the current one.
                setPeriod(null);
                setGrain(g);
              }}
              options={GRAINS}
            />
            <button type="button" className="btn" onClick={() => downloadCsv(reportName(system, data.period), buildReport(data, system))}>
              Download report
            </button>
            <button type="button" className="btn" disabled={busy} onClick={reread} title="Reads every execution n8n holds again. Safe to run at any time: each row is keyed on its n8n execution id.">
              {busy ? 'Reading n8n…' : 'Read n8n again'}
            </button>
          </div>
        }
        below={<Tabs tabs={data.systems.map((s) => s.label)} value={tab} onChange={setTab} counts={counts} />}
      />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <SystemView key={`${system.system}-${grain}-${data.period}`} system={system} data={data} grain={grain} onSelectPeriod={setPeriod} onOpenWorkflow={setOpen} />

        {/*
          Said once, at the foot of the page: these numbers are as fresh as the
          last poll and no fresher. A dashboard that implies it is live when it
          is not is worse than one that admits the delay.
        */}
        <div className="mx-6 mb-8 text-[11px] leading-snug text-faint md:mx-8">
          n8n has no way to tell this dashboard when an execution finishes, so it is asked every {data.source.poll_seconds} seconds and this page re-reads on the same interval. Nothing here is
          live. Executions are copied into this database, one row per execution, so the record does not depend on what n8n keeps.
        </div>
      </div>

      {open && <WorkflowPanel workflowId={open} grain={grain} period={data.period} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
