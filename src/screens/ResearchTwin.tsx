import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getRecordMetrics, getRtTelemetry, resyncRecords, type RtAsk, type RtJob, type RtJobMetrics, type RtMetrics } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  CohortTable,
  CountUp,
  DistTile,
  DurationTrend,
  Definition,
  EmptyState,
  FigureCell,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  MonthPicker,
  monthsFrom,
  OutcomeColumns,
  PageHeader,
  Pagination,
  PercentCell,
  PercentileCell,
  Pill,
  RecordId,
  RecordTable,
  ResyncButton,
  RowAction,
  RowActions,
  RowsLine,
  SearchBox,
  Segmented,
  SeriesBlock,
  SourceLink,
  StatCell,
  StatStrip,
  Tabs,
  thisMonth,
  TileFigure,
  Toast,
  usePaged,
  useResync,
  useToast,
} from '../components/ui';
import RecordStatistics from '../components/RecordStatistics';
import { JOB_STATUS_DEFS, RT_OUTCOME_DEFS } from './twinDefinitions';
import { HandoffTile } from './NorthStar';

/**
 * Research Twin, read from its own ledger and its own research queue
 * (2026-09-17).
 *
 * Two things changed at once and both shape this page.
 *
 * **Asks are new.** Until today this page showed the research queue and nothing
 * else; the twin's actual conversations were not recorded anywhere. They have
 * their own tab now, and the first figure on it is whether the ask went outside
 * BHA at all — because Bays and North Star can both query BHARAG directly, so a
 * Research Twin ask that never left the building is one either of them could
 * have answered themselves.
 *
 * **A job is one row.** The queue this replaces held one row per *attempt* with
 * a second table for outcomes, so "attempts" and "cards" were different counts
 * and every figure had to collapse on `card_id` first. `Attempts` is a number
 * on the job now. None of that one-row-per-attempt language is carried across.
 */

type AskFilter = 'all' | 'Answered' | 'Thin' | 'Needs human' | 'Refused (not its lane)' | 'Failed' | 'external' | 'internal';
type JobFilter = 'all' | 'capped' | 'open' | 'Pending' | 'In Progress' | 'Resolved';

/** One line per filter word, from the agent's and the Tools Router's own code — see twinDefinitions.ts. */
const ASK_FILTER_DEF: Record<AskFilter, { term: string; def: string }> = {
  all: { term: 'All', def: 'Every ask this month, whatever came back.' },
  Answered: { term: 'Answered', def: RT_OUTCOME_DEFS.Answered },
  Thin: { term: 'Thin', def: RT_OUTCOME_DEFS.Thin },
  'Needs human': { term: 'Needs human', def: RT_OUTCOME_DEFS['Needs human'] },
  'Refused (not its lane)': { term: 'Refused', def: RT_OUTCOME_DEFS['Refused (not its lane)'] },
  Failed: { term: 'Failed', def: RT_OUTCOME_DEFS.Failed },
  external: { term: 'Went outside', def: 'The run called the Web_Search tool at least once — it looked beyond what BHA already holds.' },
  internal: { term: 'Internal only', def: 'No web search in the run: answered from BHARAG or from what the agent already had.' },
};
const JOB_FILTER_DEF: Record<JobFilter, { term: string; def: string }> = {
  capped: { term: 'Capped', def: JOB_STATUS_DEFS['Capped (needs human)'] },
  open: { term: 'Open', def: 'Pending and In progress together — jobs the weekly sweep will still work on.' },
  Pending: { term: 'Pending', def: JOB_STATUS_DEFS.Pending },
  'In Progress': { term: 'In progress', def: JOB_STATUS_DEFS['In Progress'] },
  Resolved: { term: 'Resolved', def: JOB_STATUS_DEFS.Resolved },
  all: { term: 'All', def: 'Every job opened this month, whatever its status.' },
};

/** What each of the three sections is, in one line, under the tabs. */
const VIEW_LINE: Record<'Asks' | 'Jobs' | 'Statistics', string> = {
  Asks: 'Asks — the questions Research Twin received (from Slack, the other twins and the weekly client clock) and what it answered.',
  Jobs: 'Jobs — research it opened for itself when an answer needed more digging. The weekly sweep works each one until it resolves or is capped at three attempts.',
  Statistics: 'Statistics — the asks, month against month, and what they are made of.',
};

const OUTCOME_ORDER = ['Answered', 'Thin', 'Needs human', 'Refused (not its lane)', 'Failed', '(no outcome)'];
const OUTCOME_COLOUR = (o: string) =>
  o === 'Answered' ? 'var(--accent)' : o === 'Thin' ? 'var(--degraded)' : o === 'Needs human' ? 'var(--ok)' : o === 'Failed' ? 'var(--failing)' : 'var(--dim)';

/**
 * **Needs human is not coloured as a failure.** Escalating correctly is better
 * than a confident wrong answer, and it is the behaviour that was asked of this
 * twin, so it reads as an ordinary outcome rather than a warning.
 */
function OutcomePill({ outcome }: { outcome: string | null }) {
  if (!outcome) return <Pill>no outcome</Pill>;
  if (outcome === 'Answered') return <Pill tone="ok">answered</Pill>;
  if (outcome === 'Thin') return <Pill tone="degraded">thin</Pill>;
  if (outcome === 'Failed') return <Pill tone="failing">failed</Pill>;
  if (outcome === 'Needs human') return <Pill tone="accent">needs human</Pill>;
  return <Pill>{outcome.toLowerCase()}</Pill>;
}

/** Self-delivered is a correct outcome: the weekly report posts its own file. */
function DeliveredPill({ delivered }: { delivered: string | null }) {
  if (!delivered) return <span className="text-faint">—</span>;
  if (delivered === 'Delivered') return <Pill tone="ok">delivered</Pill>;
  if (delivered === 'Not delivered') return <Pill tone="failing">not delivered</Pill>;
  return <Pill>{delivered.toLowerCase()}</Pill>;
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return <Pill>no status</Pill>;
  if (status === 'Capped (needs human)') return <Pill tone="failing">capped</Pill>;
  if (status === 'Resolved') return <Pill tone="ok">resolved</Pill>;
  if (status === 'In Progress') return <Pill tone="accent">in progress</Pill>;
  return <Pill>{status.toLowerCase()}</Pill>;
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

function askMatches(r: RtAsk, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.ask_id, r.card_id, r.lane, r.question, r.answer, r.answer_summary, r.asked_by_system, r.asked_by_person, r.ask_type, r.sources, r.run_id].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

function jobMatches(j: RtJob, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [j.job_id, j.card_id, j.lane, j.question, j.context, j.finding, j.verdict, j.gap_type, j.missing_elements, j.target_source_types, j.opened_by].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

/* ---------------------------------------------------------------- the asks */

function RtStrip({ m, loading, error }: { m: RtMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!m) {
    return (
      <StatStrip cols={5} className="opacity-60">
        {['Went outside BHA', 'Answered rate', 'Needs a human', 'Asks', 'Response time'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={5}>
        {/*
          First on the page, deliberately. This twin's job is the outside world;
          a low figure here means it is being used as a BHARAG lookup. It is not
          coloured — a month of genuinely internal questions is a real month,
          and the trend on the statistics tab is what actually reads.
        */}
        <PercentCell label="Went outside BHA" share={m.external_rate} caption={m.external_rate.of ? `${m.external_rate.n} of ${m.external_rate.of} used web search` : 'no ask this month'} />
        <PercentCell label="Answered rate" share={m.answered_rate} caption={m.answered_rate.of ? `${m.answered_rate.n} of ${m.answered_rate.of} carried an [S#] citation` : 'no ask this month'} />
        {/* Beside the answered rate, and never red: see the note it carries. */}
        <PercentCell label="Needs a human" share={m.needs_human_rate} caption={m.needs_human_rate.of ? `${m.needs_human_rate.n} of ${m.needs_human_rate.of} said a person is needed` : 'no ask this month'} />
        <FigureCell
          label="Asks"
          value={m.asks}
          caption="this month, any outcome"
          note="Every ask in the ledger for this month. The ledger opened on 17 Sep 2026 with no history carried in, so a month before it holds nothing — which is an unrecorded month rather than a quiet one."
        />
        <PercentileCell label="Response time" p={m.response} unit="s" caption={m.response.p50 === null ? 'no ask recorded a duration' : `median, over the ${m.response.n} timed`} />
      </StatStrip>
    </div>
  );
}

function RtWeekly({ m, loading }: { m: RtMetrics | null; loading: boolean }) {
  if (!m) return null;
  return (
    <div className={`mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2 ${loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
      <MetricCard title="Asks per week" right="Asked At">
        <SeriesBlock title="" series={m.asks_per_week} tone="accent" total bare />
      </MetricCard>
      <MetricCard
        title="Outcome over time"
        right="Outcome"
        note="The same eight weeks, split by outcome, with Needs human as its own segment rather than folded into a failure. A week with no asks is drawn as no column, not as a column of nought."
      >
        <OutcomeColumns weeks={m.outcome_per_week} order={OUTCOME_ORDER} colour={OUTCOME_COLOUR} />
      </MetricCard>
    </div>
  );
}

/* -------------------------------------------------------- ask statistics */

export function RtStatTiles({ m }: { m: RtMetrics | null }) {
  if (!m) return null;
  const rows = m.scope.rows;
  const pct = (n: number) => `${Math.round(n)}%`;
  const answered = m.outcome_mix.find((o) => o.key === 'Answered')?.n ?? 0;
  const externalTotal = m.external_per_week.reduce((n, w) => n + w.total, 0);
  const externalUsed = m.external_per_week.reduce((n, w) => n + w.used, 0);
  const topType = m.ask_types[0];
  const deliveredN = m.delivery_mix.filter((d) => d.key === 'Delivered' || d.key === 'Self-delivered').reduce((n, d) => n + d.n, 0);
  const reachable = m.bharag.mix.find((b) => b.key === 'Yes')?.n ?? 0;

  return (
    <>
      <DistTile
        title="Outcome mix"
        field="Outcome"
        note={m.outcome_note}
        slices={m.outcome_mix}
        headline={rows ? (answered / rows) * 100 : null}
        tone="accent"
        missing="No ask is held for this month."
        sub={`${answered} of ${rows} answered`}
        toneOf={(s) => (s.key === 'Thin' ? 'degraded' : s.key === 'Failed' ? 'failing' : s.key === 'Answered' ? 'accent' : 'ink')}
      />

      {/*
        The single most important trend on this page: whether Research Twin is
        actually going outside BHA, week by week.
      */}
      <MetricCard title="External search over time" right="Used Web Search" note={m.external_note} noteMinLines={5} align="top">
        <TileFigure
          value={externalTotal ? (externalUsed / externalTotal) * 100 : null}
          format={pct}
          missing="No ask in the last eight weeks, so there is no trend to draw."
          sub={`${externalUsed} of ${externalTotal} asks over the last eight weeks went outside`}
          replayKey={`rt-ext|${externalTotal}`}
        >
          {externalTotal === 0 ? null : (
            <div className="space-y-2">
              {m.external_per_week
                .filter((w) => w.total > 0)
                .map((w) => (
                  <HBar
                    key={w.week}
                    label={w.label}
                    value={w.used}
                    max={Math.max(1, ...m.external_per_week.map((x) => x.total))}
                    tone={w.used === 0 ? 'degraded' : 'accent'}
                    valueNode={<CountUp value={w.used} />}
                    right={<span className="text-faint">of {w.total}</span>}
                  />
                ))}
            </div>
          )}
        </TileFigure>
      </MetricCard>

      <DistTile
        title="BHARAG reachable"
        field="BHARAG Reachable"
        note={m.bharag.note}
        slices={m.bharag.mix}
        headline={rows ? (reachable / rows) * 100 : null}
        tone={m.bharag.degraded ? 'degraded' : undefined}
        missing="No ask is held for this month, so nothing recorded whether the store answered."
        sub={`${reachable} of ${rows} runs found it reachable · ${m.bharag.degraded} found it degraded`}
        toneOf={(s) => (s.key === 'No (degraded)' ? 'degraded' : s.key === 'Yes' ? 'accent' : 'ink')}
      />

      <DistTile
        title="Sources per answer"
        field="Sources Count"
        note={m.sources.note}
        slices={m.sources.buckets}
        headline={m.sources.of ? (m.sources.none / m.sources.of) * 100 : null}
        tone={m.sources.none ? 'degraded' : undefined}
        missing="No ask this month records a source count."
        sub={`${m.sources.none} of ${m.sources.of} answers cite nothing at all${m.sources.mean === null ? '' : ` · ${m.sources.mean} sources on average`}`}
        toneOf={(s) => (s.key === 'none' ? 'degraded' : 'ink')}
      />

      <MetricCard title="Citation coverage" right="Citation Coverage" note={m.citation.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.citation.mean === null ? null : m.citation.mean * 100}
          format={pct}
          tone={m.citation.mean !== null && m.citation.mean === 0 ? 'degraded' : undefined}
          missing="No ask this month records a coverage figure."
          sub={`mean over the ${m.citation.n} of ${m.citation.of} asks that recorded one`}
          replayKey={`rt-coverage|${m.citation.n}`}
        >
          <div className="space-y-2">
            {m.citation.buckets.map((b) => (
              <HBar
                key={b.key}
                label={b.label}
                value={b.n}
                max={Math.max(1, ...m.citation.buckets.map((x) => x.n))}
                tone={b.key === 'nothing cited' ? 'degraded' : 'ink'}
                valueNode={<CountUp value={b.n} />}
                right={<span className="text-faint">of {m.citation.n}</span>}
              />
            ))}
          </div>
        </TileFigure>
      </MetricCard>

      {/*
        The headline is a **count, not a share**, and nought is a real answer
        rendered as 0 rather than as an empty state — "none of these" and
        "nothing recorded" are different statements and read differently.
      */}
      <DistTile
        title="Confidence mix"
        field="Confidence Stated"
        note={m.confidence.note}
        slices={m.confidence.mix}
        headline={rows ? m.confidence.high_no_sources : null}
        format={(n) => String(Math.round(n))}
        tone={m.confidence.high_no_sources ? 'degraded' : undefined}
        missing="No ask is held for this month."
        sub={`asks at High confidence with no sources at all, of ${rows}`}
        toneOf={(s) => (s.key === 'Low' ? 'degraded' : 'ink')}
      >
        {m.confidence.by_outcome.length > 0 && (
          <div className="mt-3 border-t border-line pt-2 text-[11.5px] text-faint">
            <div className="mb-1 text-[10.5px]">confidence against outcome</div>
            {m.confidence.by_outcome.slice(0, 6).map((c) => (
              <div key={`${c.confidence}|${c.outcome}`} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-dim">
                  {c.confidence} · {c.outcome.toLowerCase()}
                </span>
                <span className="tabular shrink-0">{c.n}</span>
              </div>
            ))}
          </div>
        )}
      </DistTile>

      <DistTile
        title="Ask type mix"
        field="Ask Type"
        note={m.ask_type_note}
        slices={m.ask_types}
        headline={rows && topType ? (topType.n / rows) * 100 : null}
        missing="No ask is held for this month."
        sub={topType ? `${topType.n} of ${rows} are ${topType.label.toLowerCase()}, the largest group` : undefined}
      />

      <MetricCard title="Who is asking" right="Asked By System" note={m.by_system_note} noteMinLines={5} align="top">
        <TileFigure
          value={m.by_system.length || null}
          format={(n) => String(Math.round(n))}
          missing="No ask is held for this month, so no caller has one."
          sub="callers with an ask this month · answered and external-search rates per caller"
          replayKey={`rt-systems|${rows}`}
        >
          <CohortTable rows={m.by_system} externalLabel="outside" />
        </TileFigure>
      </MetricCard>

      <DistTile
        title="Delivery mix"
        field="Delivered"
        note={m.delivery_note}
        slices={m.delivery_mix}
        headline={rows ? (deliveredN / rows) * 100 : null}
        tone={rows && deliveredN < rows ? 'degraded' : 'accent'}
        missing="No ask is held for this month."
        sub={`${deliveredN} of ${rows} reached someone, counting self-delivered`}
        toneOf={(s) => (s.key === 'Not delivered' ? 'failing' : s.key === 'Delivered' || s.key === 'Self-delivered' ? 'accent' : 'ink')}
      />

      <MetricCard title="Response time" right="Response Seconds" note={m.response.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.response.p50}
          format={(n) => `${Math.round(n * 10) / 10}s`}
          missing="No ask this month recorded a response time."
          sub={m.response.p95 === null ? undefined : `p50, with p95 at ${m.response.p95}s — never a mean`}
          replayKey={`rt-time|${m.response.n}`}
        >
          <DurationTrend weeks={m.response_trend} unit="s" />
        </TileFigure>
      </MetricCard>

      <HandoffTile handoffs={m.handoffs} />
    </>
  );
}

/* --------------------------------------------------------------- the jobs */

function JobStrip({ m, loading, error }: { m: RtJobMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!m) {
    return (
      <StatStrip cols={5} className="opacity-60">
        {['Capped', 'Open jobs', 'Resolved this month', 'Time to resolve', 'Oldest open job'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={5}>
        {/* The one figure on this tab that is coloured: anything above nought needs a person. */}
        <PercentCell label="Capped, needs a person" share={m.capped} bad={() => m.capped.n > 0} caption={m.capped.of ? `${m.capped.n} of ${m.capped.of} jobs out of attempts` : 'no job opened this month'} />
        <FigureCell
          label="Open jobs"
          value={m.open}
          caption={`${m.pending} pending · ${m.in_progress} in progress`}
          note={`Pending and In Progress together — ${m.pending} pending, ${m.in_progress} in progress. Resolved and capped jobs are terminal and are not counted here; a capped job is waiting on a person rather than on the queue.`}
        />
        <FigureCell
          label="Resolved this month"
          value={m.resolved_this_month}
          caption="by the day it resolved, not opened"
          note="Jobs whose Resolved At falls in this month, whenever they were opened. Every other figure on this strip is scoped by when the job was opened, which is what the month picker selects — these are deliberately different questions."
        />
        <PercentileCell label="Time to resolve" p={m.time_to_resolve} unit="d" caption={m.time_to_resolve.p50 === null ? 'no job has resolved yet' : `median, over the ${m.time_to_resolve.n} resolved`} />
        <FigureCell
          label="Oldest open job"
          value={m.oldest_open.days}
          unit="d"
          missing="none open"
          tone={(m.oldest_open.days ?? 0) > 14 ? 'degraded' : undefined}
          caption={m.oldest_open.job_id ?? 'no job is open'}
          note={m.oldest_open.note}
        />
      </StatStrip>
    </div>
  );
}

function JobStatTiles({ m }: { m: RtJobMetrics | null }) {
  if (!m) return null;
  const rows = m.scope.rows;
  const pct = (n: number) => `${Math.round(n)}%`;
  const biggestStatus = [...m.status_mix].sort((a, b) => b.n - a.n)[0];
  const atCap = m.attempts_mix.find((a) => a.key.startsWith('3'))?.n ?? 0;
  const topGap = [...m.gap_mix].sort((a, b) => b.n - a.n)[0];
  const topOpener = m.opened_by[0];

  return (
    <div className="grid gap-4 px-6 pb-6 sm:grid-cols-2 md:px-8 lg:grid-cols-3">
      <DistTile
        title="Status depth"
        field="Status"
        note={m.status_note}
        slices={m.status_mix}
        headline={rows && biggestStatus ? (biggestStatus.n / rows) * 100 : null}
        missing="No job is held for this month."
        sub={biggestStatus ? `${biggestStatus.n} of ${rows} jobs are ${biggestStatus.label.toLowerCase()}, the largest group` : undefined}
        toneOf={(s) => (s.key === 'Capped (needs human)' ? 'failing' : s.key === 'Resolved' ? 'accent' : 'ink')}
      />

      <DistTile
        title="Attempts"
        field="Attempts"
        note={m.attempts_note}
        slices={m.attempts_mix}
        headline={rows ? (atCap / rows) * 100 : null}
        tone={atCap ? 'degraded' : undefined}
        missing="No job is held for this month."
        sub={`${atCap} of ${rows} jobs have used all three passes`}
        toneOf={(s) => (s.key.startsWith('3') ? 'degraded' : 'ink')}
      />

      {/* A count of jobs, so it is formatted as one. */}
      <DistTile
        title="Gap types"
        field="Gap Type"
        note={m.gap_note}
        slices={m.gap_mix}
        headline={topGap ? topGap.n : null}
        format={(n) => String(Math.round(n))}
        missing="No job this month is capped or came back Low confidence, so there is no wall to classify."
        sub={topGap ? `jobs at ${topGap.label.toLowerCase()}, the most common wall` : undefined}
      />

      <MetricCard title="Time to resolve" right="Resolved At − Opened At" note={m.time_to_resolve.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.time_to_resolve.p50}
          format={(n) => `${Math.round(n * 10) / 10}d`}
          missing="No job opened this month has been resolved with both stamps."
          sub={m.time_to_resolve.p95 === null ? undefined : `p50, with p95 at ${m.time_to_resolve.p95}d — never a mean`}
          replayKey={`job-time|${m.time_to_resolve.n}`}
        >
          <DurationTrend weeks={m.resolve_trend} unit="d" />
        </TileFigure>
      </MetricCard>

      <DistTile
        title="Opened by"
        field="Opened By"
        note={m.opened_by_note}
        slices={m.opened_by}
        headline={rows && topOpener ? (topOpener.n / rows) * 100 : null}
        missing="No job is held for this month."
        sub={topOpener ? `${topOpener.n} of ${rows} were opened by ${topOpener.label}` : undefined}
      />

      <MetricCard title="Resolution rate" right="Status" note={m.resolution_rate.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.resolution_rate.pct}
          format={pct}
          tone="accent"
          missing="No job opened this month has reached a terminal state yet."
          sub={`${m.resolution_rate.n} of ${m.resolution_rate.of} terminal jobs were resolved rather than capped`}
          replayKey={`job-res|${m.resolution_rate.of}`}
        >
          <HBar
            label="resolved"
            value={m.resolution_rate.n}
            max={Math.max(1, m.resolution_rate.of)}
            tone="accent"
            valueNode={<CountUp value={m.resolution_rate.n} />}
            right={<span className="text-faint">of {m.resolution_rate.of}</span>}
          />
          <div className="mt-2">
            <HBar
              label="capped"
              value={m.resolution_rate.of - m.resolution_rate.n}
              max={Math.max(1, m.resolution_rate.of)}
              tone="failing"
              valueNode={<CountUp value={m.resolution_rate.of - m.resolution_rate.n} />}
              right={<span className="text-faint">of {m.resolution_rate.of}</span>}
            />
          </div>
        </TileFigure>
      </MetricCard>
    </div>
  );
}

/* --------------------------------------------------------------- the views */

function AskView({ r, onClose }: { r: RtAsk; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Research Twin ask">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{r.ask_id ?? r.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{r.ask_type ?? 'no ask type'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="tabular">{when(r.asked_at)}</span>
              <OutcomePill outcome={r.outcome} />
              <DeliveredPill delivered={r.delivered} />
              {r.used_web_search ? <Pill tone="accent">went outside BHA</Pill> : <span>internal only</span>}
              {r.card_id && <span className="tabular">{r.card_id}</span>}
              <span>{r.lane ?? 'no lane'}</span>
              <span>{r.asked_by_system ?? 'no system named'}</span>
              {r.response_seconds !== null && <span className="tabular">{r.response_seconds}s</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {r.slack_link && (
              <a href={r.slack_link} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                Open in Slack
              </a>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {r.error && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">What went wrong</div>
            <p className="text-[13px] leading-relaxed text-failing">{r.error}</p>
          </div>
        )}

        <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Fact label="BHARAG reachable" value={r.bharag_reachable ?? 'not recorded'} tone={r.bharag_reachable === 'No (degraded)' ? 'degraded' : undefined} />
          <Fact label="Sources counted" value={r.sources_count === null ? 'not recorded' : String(r.sources_count)} tone={r.sources_count === 0 ? 'degraded' : undefined} />
          <Fact label="Confidence stated" value={r.confidence_stated ?? 'not stated'} />
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">The request, as it arrived</div>
          <p className="max-h-[24vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.question ?? 'No request text was recorded.'}</p>
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">Answer</div>
          {r.answer ? (
            <p className="max-h-[40vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.answer}</p>
          ) : (
            <p className="text-[12.5px] text-degraded">No answer text was recorded for this ask.</p>
          )}
        </div>

        {r.sources && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-[12.5px] text-dim">Sources ({r.sources_count ?? 'count not recorded'})</summary>
            <p className="mt-2 max-h-[30vh] overflow-y-auto text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{r.sources}</p>
          </details>
        )}

        {r.evidence_used && (
          <details className="mt-3 border-t border-line pt-3">
            <summary className="cursor-pointer text-[12.5px] text-dim">
              Tool calls ({r.tools.length})
              {/* Research Twin's evidence lines carry no hit counts, so the page says so rather than printing nought. */}
              <span className="ml-1.5 text-[11px] text-faint">this ledger records the call and its observation, not hit counts</span>
            </summary>
            <p className="mt-2 max-h-[30vh] overflow-y-auto text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{r.evidence_used}</p>
          </details>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11.5px] text-faint">
          <SourceLink source={r.source} />
          <span>
            {r.run_id ? `n8n execution ${r.run_id}` : 'no run id recorded'}
            {r.delivery_target ? ` · sent to ${r.delivery_target}` : ''}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function JobView({ j, onClose }: { j: RtJob; onClose: () => void }) {
  const fields: { label: string; value: string | null }[] = [
    { label: 'What needs answering', value: j.question },
    { label: 'Why it was raised', value: j.context },
    { label: 'The answer as it stands', value: j.finding },
    { label: 'Verdict', value: j.verdict },
    { label: 'What would actually resolve it', value: j.missing_elements },
    { label: 'What kind of source would settle it', value: j.target_source_types },
    { label: 'Sources', value: j.sources },
    { label: 'Every pass, in order', value: j.answer_history },
  ];
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Research job">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{j.job_id ?? j.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{j.lane ?? j.card_id ?? 'no lane or card'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <StatusPill status={j.status} />
              <span>
                {j.attempts === null ? 'attempts not recorded' : `${j.attempts} of 3 passes`}
              </span>
              {j.confidence && <span>confidence {j.confidence.toLowerCase()}</span>}
              {j.gap_type && <span>{j.gap_type.toLowerCase()}</span>}
              <span className="tabular">opened {when(j.opened_at)}</span>
              {j.resolved_at && <span className="tabular">resolved {when(j.resolved_at)}</span>}
              {j.days_open !== null && <span className={j.days_open > 14 ? 'text-degraded' : ''}>{j.days_open} d open</span>}
              {j.opened_by && <span>opened by {j.opened_by}</span>}
              {j.reported_in_digest && <Pill>in a digest</Pill>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {j.capped && (
          <p className="mt-3 text-[12.5px] leading-snug text-degraded">
            This job used all three passes without a usable answer and is waiting on a person. Nothing else in the engine will move it. That is a real outcome the queue records, not a
            failure it is hiding.
          </p>
        )}

        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {fields.filter((f) => f.value).length === 0 ? (
            <p className="text-[12.5px] text-faint">This job carries only its status and its attempt count — no question text, finding or gap detail has been written to it.</p>
          ) : (
            fields
              .filter((f) => f.value)
              .map((f) => (
                <div key={f.label}>
                  <div className="mb-0.5 text-[11px] text-faint">{f.label}</div>
                  <p className="max-h-[30vh] overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{f.value}</p>
                </div>
              ))
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11.5px] text-faint">
            <SourceLink source={j.source} />
            <span>{j.linked_asks.length ? `worked by ${j.linked_asks.length} ${j.linked_asks.length === 1 ? 'ask' : 'asks'}: ${j.linked_asks.join(', ')}` : 'no ask is linked to this job'}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'degraded' }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <div className={`mt-0.5 text-[12.5px] ${tone === 'degraded' ? 'text-degraded' : 'text-ink'}`}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ tables */

function askColumns(open: (r: RtAsk) => void): RecordColumn<RtAsk>[] {
  return [
    { key: 'date', header: 'date', className: 'tabular text-faint', cell: (r) => when(r.asked_at) },
    { key: 'ask_id', header: 'ask id', width: '22ch', clip: true, title: (r) => r.ask_id ?? r.id, cell: (r) => <RecordId missing="no ask id">{r.ask_id}</RecordId> },
    {
      key: 'asked_by',
      header: 'asked by',
      width: '18ch',
      clip: true,
      className: 'text-dim',
      title: (r) => [r.asked_by_system, r.asked_by_person].filter(Boolean).join(' · ') || undefined,
      cell: (r) => r.asked_by_system ?? <span className="text-faint">not named</span>,
    },
    { key: 'type', header: 'ask type', width: '16ch', clip: true, className: 'text-dim', cell: (r) => r.ask_type ?? <span className="text-faint">no type</span> },
    { key: 'card', header: 'card', width: '18ch', clip: true, className: 'text-dim', title: (r) => r.card_id ?? undefined, cell: (r) => r.card_id ?? <span className="text-faint">no card</span> },
    {
      key: 'question',
      header: 'request',
      card: 'title',
      width: '48ch',
      clip: true,
      title: (r) => r.question ?? undefined,
      cell: (r) => r.answer_summary ?? r.question ?? <span className="text-faint">No request text was recorded.</span>,
    },
    { key: 'outcome', header: 'outcome', card: 'meta', className: 'card-meta', cell: (r) => <OutcomePill outcome={r.outcome} /> },
    {
      key: 'external',
      header: 'went outside',
      card: 'meta',
      className: 'card-meta',
      title: () => 'Whether the run needed a search outside BHA rather than BHARAG alone',
      cell: (r) => (r.used_web_search ? <Pill tone="accent">yes</Pill> : <span className="text-faint">no</span>),
    },
    {
      key: 'sources',
      header: 'sources',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (r) => (r.sources_count === 0 ? 'text-degraded' : 'text-dim'),
      cell: (r) => (r.sources_count === null ? <span className="text-faint">—</span> : r.sources_count),
    },
    { key: 'confidence', header: 'confidence', card: 'meta', className: 'card-meta text-dim', cell: (r) => r.confidence_stated ?? <span className="text-faint">not stated</span> },
    { key: 'delivered', header: 'delivered', card: 'meta', className: 'card-meta', cell: (r) => <DeliveredPill delivered={r.delivered} /> },
    {
      key: 'seconds',
      header: 'seconds',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular text-dim',
      cell: (r) => (r.response_seconds === null ? <span className="text-faint">—</span> : r.response_seconds),
    },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (r) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(r)} />
        </RowActions>
      ),
    },
  ];
}

function jobColumns(open: (j: RtJob) => void): RecordColumn<RtJob>[] {
  return [
    { key: 'opened', header: 'opened', className: 'tabular text-faint', cell: (j) => when(j.opened_at) },
    { key: 'job_id', header: 'job id', width: '22ch', clip: true, title: (j) => j.job_id ?? j.id, cell: (j) => <RecordId missing="no job id">{j.job_id}</RecordId> },
    { key: 'card', header: 'card', width: '18ch', clip: true, className: 'text-dim', title: (j) => j.card_id ?? undefined, cell: (j) => j.card_id ?? <span className="text-faint">no card</span> },
    { key: 'lane', header: 'lane', width: '16ch', clip: true, className: 'text-dim', cell: (j) => j.lane ?? <span className="text-faint">no lane</span> },
    {
      key: 'question',
      header: 'question',
      card: 'title',
      width: '52ch',
      clip: true,
      title: (j) => j.question ?? undefined,
      cell: (j) => j.question ?? <span className="text-faint">No question text was written to this job.</span>,
    },
    { key: 'status', header: 'status', card: 'meta', className: 'card-meta', cell: (j) => <StatusPill status={j.status} /> },
    {
      key: 'attempts',
      header: 'attempts',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (j) => ((j.attempts ?? 0) >= 3 ? 'text-degraded' : 'text-dim'),
      title: () => 'Passes made, against the cap of three',
      cell: (j) => (j.attempts === null ? <span className="text-faint">—</span> : `${j.attempts}/3`),
    },
    { key: 'confidence', header: 'confidence', card: 'meta', className: 'card-meta text-dim', cell: (j) => j.confidence ?? <span className="text-faint">—</span> },
    {
      key: 'age',
      header: 'age',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (j) => ((j.days_open ?? 0) > 14 ? 'text-degraded' : 'text-dim'),
      // A capped job is not open, so it has no waiting time — but it still has
      // an age, and how long ago a job was handed to a person is the thing
      // somebody reading this column wants. A dash there would read as unknown.
      title: (j) =>
        j.days_to_resolve !== null ? `Resolved after ${j.days_to_resolve} days` : j.capped ? `Capped and waiting on a person; opened ${j.age_days} days ago` : undefined,
      cell: (j) =>
        j.days_open !== null ? (
          `${j.days_open} d`
        ) : j.days_to_resolve !== null ? (
          <span className="text-faint">{j.days_to_resolve} d to resolve</span>
        ) : j.age_days !== null ? (
          `${j.age_days} d`
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { key: 'opened_by', header: 'opened by', card: 'meta', className: 'card-meta text-dim', cell: (j) => j.opened_by ?? <span className="text-faint">not recorded</span> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (j) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(j)} />
        </RowActions>
      ),
    },
  ];
}

/* ------------------------------------------------------------------- page */

/**
 * Three views. **Asks** is the conversation log, **Jobs** is the research
 * queue, and **Statistics** is the month-against-month question about the asks.
 * The Jobs tab carries its own figures and its own statistics cards, because a
 * job and an ask are different things counted different ways.
 */
/**
 * How many jobs this database holds and since when, in words (2026-09-22). A
 * near-empty queue must read as "three, since the first on 22 Sep", never as a
 * bare nought on a filter with nothing in it.
 */
function JobsSince({ jobs }: { jobs: RtJob[] }) {
  const firsts = jobs.map((j) => j.opened_at).filter((v): v is string => Boolean(v)).sort();
  if (!jobs.length) return <p className="text-[12px] text-dim">No research job has been recorded yet. Research Twin writes one to /api/engine/rt-jobs when an answer needs more digging.</p>;
  const by = (st: string) => jobs.filter((j) => j.status === st).length;
  const first = firsts[0];
  return (
    <p className="text-[12px] text-dim">
      <span className="font-medium text-ink">{jobs.length}</span> {jobs.length === 1 ? 'job' : 'jobs'} recorded
      {first ? ` since the first arrived on ${new Date(first).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : ''}
      {' · '}
      {by('Pending')} pending · {by('In Progress')} in progress · {by('Resolved')} resolved · {by('Capped (needs human)')} capped
      {by('Pending') === jobs.length ? ' — none has been worked yet; the weekly sweep picks up pending jobs.' : ''}
    </p>
  );
}

const VIEWS = ['Asks', 'Jobs', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

export default function ResearchTwin() {
  const { status, data: loaded, error } = useData(getRtTelemetry, []);
  const [view, setView] = useState<View>('Asks');
  const [askFilter, setAskFilter] = useState<AskFilter>('all');
  const [jobFilterSet, setJobFilter] = useState<JobFilter | null>(null);
  const [q, setQ] = useState('');
  const [openAsk, setOpenAsk] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [tick, setTick] = useState(0);
  const [asks, setAsks] = useState<RtAsk[]>([]);
  const [jobs, setJobs] = useState<RtJob[]>([]);
  const { toast, setToast } = useToast();
  const metrics = useData(() => getRecordMetrics('rt', { lane: 'all' }, null, month), [month, tick]);
  const jobMetrics = useData(() => getRecordMetrics('rt_jobs', { lane: 'all' }, null, month), [month, tick]);

  useEffect(() => {
    if (loaded) {
      setAsks(loaded.asks);
      setJobs(loaded.jobs);
    }
  }, [loaded]);

  /**
   * One button, both tables. The resync sweeps the ask ledger and the research
   * queue together — a job is updated in place and the ask mirror never touches
   * it, so this is the only thing that brings a job's current state across.
   */
  const resync = useResync({
    run: () => resyncRecords('rt'),
    reload: async () => {
      setTick((n) => n + 1);
      const fresh = await getRtTelemetry();
      setAsks(fresh.asks);
      setJobs(fresh.jobs);
    },
    setToast,
  });

  const months = useMemo(() => monthsFrom([...asks.map((r) => r.asked_at), ...jobs.map((j) => j.opened_at)]), [asks, jobs]);
  const asksInMonth = useMemo(() => asks.filter((r) => !month || r.asked_at?.slice(0, 7) === month), [asks, month]);
  const jobsInMonth = useMemo(() => jobs.filter((j) => !month || j.opened_at?.slice(0, 7) === month), [jobs, month]);

  const askRows = useMemo(
    () =>
      asksInMonth
        .filter((r) =>
          askFilter === 'all' ? true : askFilter === 'external' ? r.used_web_search : askFilter === 'internal' ? !r.used_web_search : r.outcome === askFilter,
        )
        .filter((r) => askMatches(r, q.trim())),
    [asksInMonth, askFilter, q],
  );
  // Capped leads when anything is capped; otherwise the whole queue, so a tab
  // holding three pending jobs does not open on an empty filter.
  const jobFilter: JobFilter = jobFilterSet ?? (jobs.some((j) => j.capped) ? 'capped' : 'all');
  const jobRows = useMemo(
    () =>
      jobsInMonth
        .filter((j) => (jobFilter === 'all' ? true : jobFilter === 'capped' ? j.capped : jobFilter === 'open' ? j.open : j.status === jobFilter))
        .filter((j) => jobMatches(j, q.trim())),
    [jobsInMonth, jobFilter, q],
  );

  const pagedAsks = usePaged(askRows, `asks|${askFilter}|${q.trim()}|${month ?? 'all'}`);
  const pagedJobs = usePaged(jobRows, `jobs|${jobFilter}|${q.trim()}|${month ?? 'all'}`);

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const currentAsk = openAsk ? asks.find((r) => r.id === openAsk) : null;
  const currentJob = openJob ? jobs.find((j) => j.id === openJob) : null;

  const askCounts = {
    all: asksInMonth.length,
    Answered: asksInMonth.filter((r) => r.outcome === 'Answered').length,
    Thin: asksInMonth.filter((r) => r.outcome === 'Thin').length,
    'Needs human': asksInMonth.filter((r) => r.outcome === 'Needs human').length,
    'Refused (not its lane)': asksInMonth.filter((r) => r.outcome === 'Refused (not its lane)').length,
    Failed: asksInMonth.filter((r) => r.outcome === 'Failed').length,
    external: asksInMonth.filter((r) => r.used_web_search).length,
    internal: asksInMonth.filter((r) => !r.used_web_search).length,
  };
  const jobCounts = {
    all: jobsInMonth.length,
    capped: jobsInMonth.filter((j) => j.capped).length,
    open: jobsInMonth.filter((j) => j.open).length,
    Pending: jobsInMonth.filter((j) => j.status === 'Pending').length,
    'In Progress': jobsInMonth.filter((j) => j.status === 'In Progress').length,
    Resolved: jobsInMonth.filter((j) => j.status === 'Resolved').length,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Research Twin"
        subtitle="Reads engine_rt_asks and engine_rt_jobs: every question Research Twin was asked, and the research it opened to answer them"
        right={<ResyncButton busy={resync.busy} onClick={resync.start} />}
        below={
          <div className="space-y-2">
            <Tabs tabs={VIEWS} value={view} onChange={setView} counts={{ Jobs: { n: jobCounts.capped, tone: 'failing' } }} titles={VIEW_LINE} />
            <p className="text-[12.5px] text-dim">{VIEW_LINE[view]}</p>
          </div>
        }
      />

      {view === 'Statistics' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <RecordStatistics<RtAsk>
            kind="researchtwin"
            noun="Asks"
            month={month}
            onMonth={setMonth}
            rows={asks}
            dateOf={(r) => r.asked_at}
            extraTiles={<RtStatTiles m={metrics.data} />}
            columns={[
              { header: 'ask_id', value: (r) => r.ask_id },
              { header: 'record_id', value: (r) => r.id },
              { header: 'asked_at', value: (r) => r.asked_at },
              { header: 'asked_by_system', value: (r) => r.asked_by_system },
              { header: 'asked_by_person', value: (r) => r.asked_by_person },
              { header: 'ask_type', value: (r) => r.ask_type },
              { header: 'card_id', value: (r) => r.card_id },
              { header: 'lane', value: (r) => r.lane },
              { header: 'outcome', value: (r) => r.outcome },
              { header: 'used_web_search', value: (r) => r.used_web_search },
              { header: 'bharag_reachable', value: (r) => r.bharag_reachable },
              { header: 'sources_count', value: (r) => r.sources_count },
              { header: 'citation_coverage', value: (r) => r.citation_coverage },
              { header: 'confidence_stated', value: (r) => r.confidence_stated },
              { header: 'delivered', value: (r) => r.delivered },
              { header: 'response_seconds', value: (r) => r.response_seconds },
              { header: 'linked_twin_ask', value: (r) => r.linked_twin_ask },
              { header: 'run_id', value: (r) => r.run_id },
              { header: 'question', value: (r) => r.question },
              { header: 'answer_summary', value: (r) => r.answer_summary },
            ]}
          />
        </div>
      ) : view === 'Jobs' ? (
        <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {/*
            The jobs table has its own freshness line, because it is fed
            differently: an ask is mirrored the moment a run ends, a job is
            updated in place and only arrives here through the resync above.
          */}
          <div className="shrink-0 space-y-1 px-6 pb-3 md:px-8">
            <RowsLine freshness={loaded.jobs_freshness} />
            <JobsSince jobs={jobs} />
          </div>

          <JobStrip m={jobMetrics.data} loading={jobMetrics.status === 'loading'} error={jobMetrics.error} />

          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<JobFilter>
                ariaLabel="Filter jobs"
                value={jobFilter}
                onChange={setJobFilter}
                options={[
                  ...(['capped', 'open', 'Pending', 'In Progress', 'Resolved', 'all'] as JobFilter[]).map((f) => ({ value: f, label: JOB_FILTER_DEF[f].term, count: jobCounts[f], title: JOB_FILTER_DEF[f].def })),
                ]}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <MonthPicker months={months} value={month} onChange={setMonth} />
                <SearchBox value={q} onChange={setQ} placeholder="Search jobs, findings and gaps" />
              </div>
            </div>
            <Definition term={JOB_FILTER_DEF[jobFilter].term}>{JOB_FILTER_DEF[jobFilter].def}</Definition>
          </div>

          {jobRows.length === 0 ? (
            <EmptyState>
              {loaded.jobs_freshness.source === 'none'
                ? (loaded.jobs_freshness.note ??
                  'No research job is held yet. Research Jobs was created on 17 Sep 2026 with no history carried in; the engine writes each job here as it opens one and updates it in place as it is worked.')
                : q.trim()
                  ? 'No job matches that search in this filter.'
                  : jobFilter === 'capped'
                    ? 'No job has used all three passes. Nothing in the queue is waiting on a person.'
                    : jobFilter === 'all'
                      ? jobs.length
                        ? `No job was opened this month. ${jobs.length} ${jobs.length === 1 ? 'job is' : 'jobs are'} held in other months — pick one above.`
                        : 'No research job has been recorded yet.'
                      : `No job this month is ${jobFilter.toLowerCase()}.`}
            </EmptyState>
          ) : (
            <>
              <RecordTable columns={jobColumns((j) => setOpenJob(j.id))} rows={pagedJobs.rows} rowKey={(j) => j.id} onOpen={(j) => setOpenJob(j.id)} label="Research jobs" />
              <Pagination paged={pagedJobs} unit="jobs" />
            </>
          )}

          <div className="mt-4">
            <JobStatTiles m={jobMetrics.data} />
          </div>
        </div>
      ) : (
        <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          <div className="shrink-0 px-6 pb-3 md:px-8">
            <RowsLine freshness={loaded.freshness} />
          </div>

          <RtStrip m={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />
          <RtWeekly m={metrics.data} loading={metrics.status === 'loading'} />

          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<AskFilter>
                ariaLabel="Filter asks"
                value={askFilter}
                onChange={setAskFilter}
                options={(['all', 'Answered', 'Thin', 'Needs human', 'Refused (not its lane)', 'Failed', 'external', 'internal'] as AskFilter[]).map((f) => ({
                  value: f,
                  label: ASK_FILTER_DEF[f].term,
                  count: askCounts[f],
                  title: ASK_FILTER_DEF[f].def,
                }))}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <MonthPicker months={months} value={month} onChange={setMonth} />
                <SearchBox value={q} onChange={setQ} placeholder="Search requests, answers and sources" />
              </div>
            </div>
            <Definition term={ASK_FILTER_DEF[askFilter].term}>{ASK_FILTER_DEF[askFilter].def}</Definition>
          </div>

          {askRows.length === 0 ? (
            <EmptyState>
              {loaded.freshness.source === 'none'
                ? (loaded.freshness.note ??
                  'No Research Twin ask is held yet. The ledger was created on 17 Sep 2026 with no history carried in, so this fills as the agent runs: it writes each ask here at the end of the run.')
                : q.trim()
                  ? 'No ask matches that search in this filter.'
                  : askFilter === 'external'
                    ? 'No ask this month went outside BHA. Every one was answered from what BHA already holds, which Bays and North Star could have done themselves.'
                    : askFilter === 'internal'
                      ? 'Every ask this month went outside BHA.'
                      : askFilter === 'all'
                        ? 'No ask is held for this month. Before 17 Sep 2026 this ledger did not exist, so an empty month is an unrecorded one rather than a quiet one.'
                        : `No ask this month came back ${askFilter === 'Refused (not its lane)' ? 'refused' : askFilter.toLowerCase()}.`}
            </EmptyState>
          ) : (
            <>
              <RecordTable columns={askColumns((r) => setOpenAsk(r.id))} rows={pagedAsks.rows} rowKey={(r) => r.id} onOpen={(r) => setOpenAsk(r.id)} label="Research Twin asks" />
              <Pagination paged={pagedAsks} unit="asks" />
            </>
          )}
        </div>
      )}

      {currentAsk && <AskView r={currentAsk} onClose={() => setOpenAsk(null)} />}
      {currentJob && <JobView j={currentJob} onClose={() => setOpenJob(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
