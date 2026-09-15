import { useState } from 'react';
import type { ExecutionMonth, ExecutionSystem, ExecutionWorkflow, ExecutionsData } from '../../data';
import { MetricCard, StatCell, StatStrip } from './Card';
import { EmptyPanel } from './EmptyState';
import { relativeTime } from './Records';

/**
 * Execution health for one system, as it appears inside that system's own page.
 *
 * It lives here rather than pooled on Engine Health because a workflow belongs
 * to exactly one system, and the system page is where somebody goes to debug
 * it. Engine Health keeps a roll-up — one figure per system and a link through
 * — and none of the per-workflow detail.
 *
 * **These counts are read from a snapshot in Postgres, never from n8n's own
 * history for a past month.** n8n keeps about three days of executions and then
 * discards them; on 15 Sep 2026 it held 3,673 and none older than the 12th. A
 * live query would answer honestly that August held nothing, and the chart
 * would draw an empty month for a month that was busy. So the months before the
 * snapshot began carry no bar at all and the boundary is labelled, exactly as
 * the record pages label theirs.
 */

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 1000) / 10}%`;
}

function rateTone(rate: number | null): string {
  if (rate === null) return 'text-dim';
  if (rate >= 0.1) return 'text-failing';
  if (rate > 0) return 'text-degraded';
  return 'text-ink';
}

const BAR = 26;
const GAP = 12;
const H = 92;

/** Executions and failures per month. A month nothing was recording draws no bar. */
function ExecutionChart({ months, system }: { months: ExecutionMonth[]; system: string }) {
  const max = Math.max(1, ...months.map((m) => m.executions));
  const width = months.length * (BAR + GAP);
  const firstCovered = months.findIndex((m) => m.coverage !== 'none');
  const uid = `x-${system.replace(/\W+/g, '')}`;
  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg width={Math.max(width, Number(120))} height={H + 30} role="img" aria-label={`${system} executions by month`} className="block">
        <defs>
          <pattern id={`${uid}-h`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--ink)" opacity="0.18" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink)" strokeWidth="2.4" />
          </pattern>
        </defs>
        <line x1="0" y1={H} x2={width - GAP} y2={H} stroke="var(--line)" strokeWidth="1" />
        {firstCovered > 0 && (
          <g>
            <line x1={firstCovered * (BAR + GAP) - GAP / 2} y1="2" x2={firstCovered * (BAR + GAP) - GAP / 2} y2={H} stroke="var(--degraded)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={firstCovered * (BAR + GAP) - GAP / 2 + 4} y="11" fontSize="9.5" fill="var(--degraded)">
              counting starts
            </text>
          </g>
        )}
        {months.map((m, i) => {
          const x = i * (BAR + GAP);
          const h = m.coverage === 'none' ? 0 : Math.round((m.executions / max) * (H - 16));
          const fh = m.coverage === 'none' || !m.executions ? 0 : Math.round((m.failures / max) * (H - 16));
          return (
            <g key={m.month}>
              {m.coverage === 'none' ? (
                <line x1={x} y1={H - 1} x2={x + BAR} y2={H - 1} stroke="var(--faint)" strokeWidth="2" strokeDasharray="2 2" />
              ) : (
                <>
                  <rect x={x} y={H - h} width={BAR} height={h} rx="2" fill={m.coverage === 'partial' ? `url(#${uid}-h)` : 'var(--ink)'} opacity={m.coverage === 'partial' ? 0.85 : 1} />
                  {/* Failures sit inside the same bar, so the eye reads a share rather than two totals. */}
                  {fh > 0 && <rect x={x} y={H - fh} width={BAR} height={fh} rx="2" fill="var(--failing)" />}
                </>
              )}
              <text x={x + BAR / 2} y={H + 14} textAnchor="middle" fontSize="10" fill="var(--faint)">
                {m.label}
              </text>
              {m.coverage !== 'full' && (
                <text x={x + BAR / 2} y={H + 25} textAnchor="middle" fontSize="9" fill="var(--degraded)">
                  {m.coverage === 'none' ? 'none' : 'part'}
                </text>
              )}
              <title>
                {m.coverage === 'none'
                  ? `${m.label}: nothing was being counted. ${m.note ?? ''}`
                  : `${m.label}: ${m.executions} executions, ${m.failures} failed${m.note ? ` — ${m.note}` : ''}`}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One workflow's row, with its failing execution ids revealed on click. */
function WorkflowRow({ w, base }: { w: ExecutionWorkflow; base: string | null }) {
  const [open, setOpen] = useState(false);
  const rate = w.executions ? w.failures / w.executions : null;
  return (
    <>
      <tr className={w.failures ? 'cursor-pointer' : ''} onClick={() => w.failures && setOpen((v) => !v)}>
        <td className="td card-title td-clip" style={{ maxWidth: '38ch' }} title={w.workflow_name}>
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
        <td className="td card-meta text-right text-[11px] text-faint">{w.failures ? (open ? 'hide ids' : 'show ids') : ''}</td>
      </tr>
      {open && w.failures > 0 && (
        <tr>
          <td colSpan={5} className="td card-full">
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
              <span className="text-faint">
                {w.failed_ids.length < w.failures ? `— the newest ${w.failed_ids.length} of ${w.failures}; n8n discards an execution a few days after it runs, so an older id may no longer open.` : ''}
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The whole execution-health section for one system. */
export function ExecutionHealth({ system, data, base }: { system: ExecutionSystem | undefined; data: ExecutionsData; base: string | null }) {
  if (!system) return null;
  /**
   * "Nothing" means the table holds no count, not that the key is missing.
   *
   * A snapshot that ran for a month and then lost its key still holds a month
   * of real executions, and blanking them would hide history this database
   * genuinely has. The note above says the key is unset — so nothing new is
   * being counted — and the figures already taken stay on screen.
   */
  const nothing = system.months.every((m) => m.executions === 0);
  return (
    <>
      <StatStrip cols={3}>
        <StatCell>
          <div className="kicker truncate">Executions</div>
          <div className="font-display tabular mt-1 text-[28px] leading-none text-ink">{nothing ? '—' : system.executions}</div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint">in {system.month}, from the snapshot</div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Failed</div>
          <div className={`font-display tabular mt-1 text-[28px] leading-none ${system.failures ? 'text-failing' : 'text-dim'}`}>{nothing ? '—' : system.failures}</div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint">error or crashed; a cancellation is a person, not a fault</div>
        </StatCell>
        <StatCell>
          <div className="kicker truncate">Failure rate</div>
          <div className={`font-display tabular mt-1 text-[28px] leading-none ${rateTone(system.failure_rate)}`}>{nothing ? '—' : pct(system.failure_rate)}</div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{system.executions ? `${system.failures} of ${system.executions}` : 'no execution ran in this month'}</div>
        </StatCell>
      </StatStrip>

      <div className="mx-6 mb-4 md:mx-8">
        <MetricCard
          title="Executions by month"
          note={
            <span className="block space-y-1">
              <span className="block text-[11px] leading-snug text-faint">{data.snapshot.note}</span>
              {data.boundary && <span className="block text-[11px] leading-snug text-degraded">{data.boundary.note}</span>}
              {data.snapshot.at && <span className="block text-[11px] leading-snug text-faint">Last counted {relativeTime(data.snapshot.at) ?? data.snapshot.at}.</span>}
            </span>
          }
        >
          {nothing ? <EmptyPanel>{data.snapshot.note}</EmptyPanel> : <ExecutionChart months={system.months} system={system.label} />}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 md:mx-8">
        <div className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3">
            <div className="text-[13px] font-medium text-ink">By workflow</div>
            <div className="tabular text-[11.5px] text-faint">{system.month}</div>
          </div>
          {system.workflows.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-dim">
              {nothing ? data.snapshot.note : `No ${system.label} workflow has run in ${system.month}.`}
            </div>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="table-cards w-full border-collapse text-[12.5px]" aria-label={`${system.label} workflows`}>
                <thead>
                  <tr>
                    {['workflow', 'executions', 'failed', 'failure rate', ''].map((h, i) => (
                      <th
                        key={i}
                        className={`border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-faint ${i > 0 && i < 4 ? 'text-right' : ''}`}
                      >
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
