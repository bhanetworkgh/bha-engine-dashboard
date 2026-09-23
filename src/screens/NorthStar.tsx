import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getNsTelemetry, getRecordMetrics, resyncRecords, type NsAsk, type NsMetrics } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  CohortTable,
  CountUp,
  Definition,
  DistTile,
  DurationTrend,
  EmptyPanel,
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
  StatCaption,
  StatCell,
  StatLabel,
  StatStrip,
  Tabs,
  thisMonth,
  TileFigure,
  Toast,
  relativeTime,
  usePaged,
  useResync,
  useToast,
} from '../components/ui';
import RecordStatistics from '../components/RecordStatistics';
import { DELIVERY_DEFS, NS_OUTCOME_DEFS } from './twinDefinitions';

/**
 * North Star, read from its own ask ledger (2026-09-17).
 *
 * It used to read `[LEGACY] NS Records`, which nothing has written to since the
 * migration backfill — the amber line on this page was telling the truth, and
 * the fix was to point it somewhere live rather than to make the line go away.
 * Three of the figures that stood here (thin rate at 100%, classified at 42%,
 * unclassified at 58%) were artefacts of a field added late to that table and
 * are not carried across: every row in the new ledger carries an outcome, so
 * there is no unclassified bucket to count.
 *
 * **The headline is now the delivery rate**, and it is the one figure on this
 * page that is coloured. North Star once ran green for six consecutive days
 * while Slack rejected every post, and nothing on any screen reported it:
 * delivery is recorded after the answer is sent, so it is the only figure that
 * says something reached a person rather than that a run finished.
 */

type Filter = 'all' | 'Answered' | 'Thin' | 'Refused (not its lane)' | 'Failed' | 'not-delivered';

/** One line per filter word, from the agent's own code — see twinDefinitions.ts. */
const FILTER_DEF: Record<Filter, string> = {
  all: 'Every ask this month, whatever came back and wherever it went.',
  Answered: NS_OUTCOME_DEFS.Answered,
  Thin: NS_OUTCOME_DEFS.Thin,
  'Refused (not its lane)': NS_OUTCOME_DEFS['Refused (not its lane)'],
  Failed: NS_OUTCOME_DEFS.Failed,
  'not-delivered': DELIVERY_DEFS['Not delivered'],
};

/** One accent, and amber and red only on a genuinely bad state. */
const OUTCOME_ORDER = ['Answered', 'Thin', 'Refused (not its lane)', 'Failed', '(no outcome)'];
const OUTCOME_COLOUR = (o: string) =>
  o === 'Answered' ? 'var(--accent)' : o === 'Thin' ? 'var(--degraded)' : o === 'Failed' ? 'var(--failing)' : 'var(--dim)';

function OutcomePill({ outcome }: { outcome: string | null }) {
  if (!outcome) return <Pill>no outcome</Pill>;
  if (outcome === 'Answered') return <Pill tone="ok">answered</Pill>;
  if (outcome === 'Thin') return <Pill tone="degraded">thin</Pill>;
  if (outcome === 'Failed') return <Pill tone="failing">failed</Pill>;
  return <Pill>{outcome.toLowerCase()}</Pill>;
}

/**
 * Delivery, as a pill. **"No target" is not a failure** — an ask arrived with
 * nowhere to reply to — so only "Not delivered" reads red.
 */
function DeliveredPill({ delivered }: { delivered: string | null }) {
  if (!delivered) return <span className="text-faint">—</span>;
  if (delivered === 'Delivered') return <Pill tone="ok">delivered</Pill>;
  if (delivered === 'Not delivered') return <Pill tone="failing">not delivered</Pill>;
  return <Pill>{delivered.toLowerCase()}</Pill>;
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

function matches(r: NsAsk, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.ask_id, r.lane, r.question, r.answer, r.answer_summary, r.asked_by_system, r.asked_by_person, r.question_type, r.run_id, ...r.tools.map((t) => t.tool)].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

/* ---------------------------------------------------------------- the strip */

/**
 * The five headline figures: one failure metric, one outcome metric, then
 * context.
 *
 * Delivery leads and is the only coloured cell. Everything else is neutral —
 * more asks is not good news and fewer is not bad, and a column of colour on a
 * page where almost everything succeeds is decoration.
 */
function NsStrip({ m, loading, error }: { m: NsMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!m) {
    return (
      <StatStrip cols={5} className="opacity-60">
        {['Delivery rate', 'Answered rate', 'Asks', 'Response time', 'Last ask'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const lastAge = relativeTime(m.last_ask.at);
  const silent = m.last_ask.at ? Date.now() - Date.parse(m.last_ask.at) > 2 * 86_400_000 : true;
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={5}>
        {/* Below 100% is a real failure, and the only thing coloured on this strip. */}
        <PercentCell label="Delivery rate" share={m.delivery_rate} bad={(s) => (s.pct ?? 100) < 100} caption={m.delivery_rate.of ? `${m.delivery_rate.n} of ${m.delivery_rate.of} reached a channel or callback` : 'no ask this month'} />
        <PercentCell label="Answered rate" share={m.answered_rate} caption={m.answered_rate.of ? `${m.answered_rate.n} of ${m.answered_rate.of} carried an [S#] citation` : 'no ask this month'} />
        <FigureCell
          label="Asks"
          value={m.asks}
          caption="this month, any outcome"
          note={`Every ask in the ledger for this month, whatever outcome it carries. The ledger opened on 17 Sep 2026 with nothing carried in, so a month before it holds nothing — which is not a quiet month, it is an unrecorded one.`}
        />
        <PercentileCell label="Response time" p={m.response} unit="s" caption={m.response.p50 === null ? 'no ask recorded a duration' : `median, over the ${m.response.n} timed`} />
        <StatCell>
          <div className="min-w-0">
            <StatLabel label="Last ask" detail={m.last_ask.note} />
            <div className={`mt-1 text-[15px] leading-tight ${silent ? 'text-degraded' : 'text-ink'}`}>{lastAge ?? 'never'}</div>
            <StatCaption>{m.last_ask.at ? `asked ${when(m.last_ask.at)} UTC` : 'no ask held'}</StatCaption>
          </div>
        </StatCell>
      </StatStrip>
    </div>
  );
}

/** Asks per week and outcome over time — what the last eight weeks looked like. */
function NsWeekly({ m, loading }: { m: NsMetrics | null; loading: boolean }) {
  if (!m) return null;
  return (
    <div className={`mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2 ${loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
      <MetricCard title="Asks per week" right="Asked At">
        <SeriesBlock title="" series={m.asks_per_week} tone="accent" total bare />
      </MetricCard>
      <MetricCard
        title="Outcome over time"
        right="Outcome"
        note="The same eight weeks, split by outcome. A week with no asks is drawn as no column rather than as a column of nought — before 17 Sep 2026 this ledger did not exist, so those weeks were not quiet, they were not recorded."
      >
        <OutcomeColumns weeks={m.outcome_per_week} order={OUTCOME_ORDER} colour={OUTCOME_COLOUR} />
      </MetricCard>
    </div>
  );
}

/* ------------------------------------------------------------- statistics */

/**
 * The statistics grid this page brings with it, beside the computed
 * month-against-month tiles.
 *
 * Every card is the same shape: title, source field, one figure, the line
 * saying what it is a share of, the breakdown, and a footnote naming what the
 * number excludes. The headline on each is derived from what that card already
 * shows, so a reader can check it against its own bars.
 */
export function NsStatTiles({ m }: { m: NsMetrics | null }) {
  if (!m) return null;
  const rows = m.scope.rows;
  const pct = (n: number) => `${Math.round(n)}%`;
  const answered = m.outcome_mix.find((o) => o.key === 'Answered')?.n ?? 0;
  const deliveredN = m.delivery_mix.find((d) => d.key === 'Delivered')?.n ?? 0;
  const topType = m.question_types[0];
  const busiestLane = m.by_lane[0];
  const worstSystem = [...m.by_system].sort((a, b) => a.delivered / Math.max(1, a.asks) - b.delivered / Math.max(1, b.asks))[0];
  const toolCalls = m.tools.reduce((n, t) => n + t.calls, 0);
  const toolHits = m.tools.reduce((n, t) => n + (t.hits ?? 0), 0);
  const toolCited = m.tools.reduce((n, t) => n + (t.cited ?? 0), 0);
  const coverage = m.citation;
  const topTier = [...m.priority.mix].sort((a, b) => b.n - a.n)[0];
  const criticalLanes = m.priority.by_lane.filter((l) => l.critical_weeks > 0);

  return (
    <>
      <DistTile
        title="Outcome mix"
        field="Outcome"
        note={m.outcome_note}
        slices={m.outcome_mix}
        headline={rows ? (answered / rows) * 100 : null}
        tone="accent"
        missing="No ask is held for this month, so there is nothing to classify."
        sub={`${answered} of ${rows} answered`}
        toneOf={(s) => (s.key === 'Thin' ? 'degraded' : s.key === 'Failed' ? 'failing' : s.key === 'Answered' ? 'accent' : 'ink')}
      />

      <DistTile
        title="Delivery mix"
        field="Delivered"
        note={m.delivery_note}
        slices={m.delivery_mix}
        headline={rows ? (deliveredN / rows) * 100 : null}
        tone={rows && deliveredN < rows ? 'degraded' : 'accent'}
        missing="No ask is held for this month, so nothing could be delivered."
        sub={`${deliveredN} of ${rows} reached someone`}
        toneOf={(s) => (s.key === 'Not delivered' ? 'failing' : s.key === 'Delivered' ? 'accent' : 'ink')}
      >
        {m.failed_targets.length > 0 && (
          <div className="mt-3 border-t border-line pt-2 text-[11.5px] text-faint">
            <div className="mb-1 text-[10.5px]">where it was aimed</div>
            {m.failed_targets.map((t) => (
              <div key={`${t.target}|${t.outcome}`} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-dim" title={t.target}>
                  {t.target}
                </span>
                <span className="tabular shrink-0">
                  {t.n} · {t.outcome.toLowerCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </DistTile>

      {/*
        The most useful card here, and the reason it exists: the aggregate is
        dominated by the scheduled sweep, and it will keep this page looking
        healthy while a human asking in Slack gets nothing back.
      */}
      <MetricCard title="Who is asking" right="Asked By System" note={m.by_system_note} noteMinLines={5} align="top">
        <TileFigure
          value={m.by_system.length || null}
          format={(n) => String(Math.round(n))}
          missing="No ask is held for this month, so no caller has one."
          sub={worstSystem && m.by_system.length > 1 ? `lowest delivery is ${worstSystem.label}, ${worstSystem.delivered} of ${worstSystem.asks}` : 'callers with an ask this month'}
          replayKey={`ns-systems|${rows}`}
        >
          <CohortTable rows={m.by_system} />
        </TileFigure>
      </MetricCard>

      <DistTile
        title="Question type mix"
        field="Question Type"
        note={m.question_type_note}
        slices={m.question_types}
        headline={rows && topType ? (topType.n / rows) * 100 : null}
        missing="No ask is held for this month."
        sub={topType ? `${topType.n} of ${rows} are ${topType.label.toLowerCase()}, the largest group` : undefined}
      />

      <MetricCard title="Citation coverage" right="Citation Coverage" note={coverage.note} noteMinLines={5} align="top">
        <TileFigure
          value={coverage.mean === null ? null : coverage.mean * 100}
          format={pct}
          tone={coverage.mean !== null && coverage.mean === 0 ? 'degraded' : undefined}
          missing="No ask this month records a coverage figure."
          sub={`mean over the ${coverage.n} of ${coverage.of} asks that recorded one`}
          replayKey={`ns-coverage|${coverage.n}`}
        >
          <div className="space-y-2">
            {coverage.buckets.map((b) => (
              <HBar
                key={b.key}
                label={b.label}
                value={b.n}
                max={Math.max(1, ...coverage.buckets.map((x) => x.n))}
                tone={b.key === 'nothing cited' ? 'degraded' : 'ink'}
                valueNode={<CountUp value={b.n} />}
                right={<span className="text-faint">of {coverage.n}</span>}
              />
            ))}
          </div>
        </TileFigure>
      </MetricCard>

      <MetricCard title="Tool usage" right="Evidence Used" note={m.tools_note} noteMinLines={5} align="top">
        <TileFigure
          value={toolHits ? (toolCited / toolHits) * 100 : null}
          format={pct}
          tone={toolHits && toolCited === 0 ? 'degraded' : undefined}
          missing={toolCalls ? 'Calls were made but none of their lines records hit counts, so there is no rate to compute.' : 'No ask this month records a tool call.'}
          sub={`${toolCited} of ${toolHits} returned rows ended up cited, across ${toolCalls} calls`}
          replayKey={`ns-tools|${toolCalls}`}
        >
          {m.tools.length === 0 ? null : (
            <div className="space-y-2">
              {m.tools.map((t) => (
                <HBar
                  key={t.tool}
                  label={t.tool}
                  value={t.hits ?? t.calls}
                  max={Math.max(1, ...m.tools.map((x) => x.hits ?? x.calls))}
                  tone={t.cited === 0 && (t.hits ?? 0) > 0 ? 'degraded' : 'ink'}
                  valueNode={
                    <span>
                      {t.calls} {t.calls === 1 ? 'call' : 'calls'}
                      {t.hits !== null && (
                        <span className="text-faint">
                          {' '}
                          · {t.hits} hits · {t.cited ?? 0} cited
                        </span>
                      )}
                    </span>
                  }
                  right={<span className="text-faint">{t.cited_rate === null ? 'no counts' : `${t.cited_rate}%`}</span>}
                />
              ))}
            </div>
          )}
        </TileFigure>
      </MetricCard>

      <MetricCard title="Response time" right="Response Seconds" note={m.response.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.response.p50}
          format={(n) => `${Math.round(n * 10) / 10}s`}
          missing="No ask this month recorded a response time."
          sub={m.response.p95 === null ? undefined : `p50, with p95 at ${m.response.p95}s — never a mean`}
          replayKey={`ns-time|${m.response.n}`}
        >
          <DurationTrend weeks={m.response_trend} unit="s" />
        </TileFigure>
      </MetricCard>

      <DistTile
        title="Priority tier claimed"
        field="Claimed Priority Tier"
        note={m.priority.note}
        slices={m.priority.mix}
        headline={rows && topTier ? (topTier.n / rows) * 100 : null}
        missing="No ask is held for this month."
        sub={topTier ? `${topTier.n} of ${rows} claimed ${topTier.label.toLowerCase()}, the largest group` : undefined}
        toneOf={(s) => (s.key === 'Critical' ? 'degraded' : 'ink')}
      >
        {criticalLanes.length > 0 && (
          <div className="mt-3 border-t border-line pt-2 text-[11.5px] text-faint">
            <div className="mb-1 text-[10.5px]">lanes called Critical, by distinct week</div>
            {criticalLanes.slice(0, 5).map((l) => (
              <div key={l.lane} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-dim" title={l.lane}>
                  {l.lane}
                </span>
                <span className={`tabular shrink-0 ${l.critical_weeks >= 3 ? 'text-degraded' : ''}`}>
                  {l.critical_weeks} {l.critical_weeks === 1 ? 'week' : 'weeks'}
                  {l.last_critical ? ` · last ${l.last_critical}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </DistTile>

      <MetricCard title="Architect attention" right="Architect Attention" note={m.architect.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.architect.n}
          format={(n) => String(Math.round(n))}
          tone={m.architect.n ? 'degraded' : undefined}
          missing="No ask is held for this month."
          sub={`of ${m.architect.of} asks this month`}
          replayKey={`ns-architect|${rows}`}
        >
          {m.architect.lanes.length === 0 ? null : (
            <div className="space-y-2">
              {m.architect.lanes.slice(0, 6).map((l) => (
                <HBar
                  key={l.lane}
                  label={l.lane}
                  value={l.n}
                  max={Math.max(1, ...m.architect.lanes.map((x) => x.n))}
                  tone="degraded"
                  valueNode={<CountUp value={l.n} />}
                  right={<span className="text-faint">{l.last_at ? l.last_at.slice(0, 10) : 'undated'}</span>}
                />
              ))}
            </div>
          )}
        </TileFigure>
      </MetricCard>

      <MetricCard title="By lane" right="Lane" note={m.by_lane_note} noteMinLines={5} align="top">
        <TileFigure
          value={m.by_lane.length || null}
          format={(n) => String(Math.round(n))}
          missing="No ask is held for this month, so no lane has one."
          sub={busiestLane ? `busiest is ${busiestLane.label} with ${busiestLane.asks}` : undefined}
          replayKey={`ns-lanes|${rows}`}
        >
          <div className="space-y-2">
            {m.by_lane.slice(0, 8).map((l) => (
              <HBar
                key={l.key}
                label={l.label}
                value={l.asks}
                max={Math.max(1, ...m.by_lane.map((x) => x.asks))}
                valueNode={<CountUp value={l.asks} />}
                right={<span className="text-faint">{l.asks ? Math.round((l.answered / l.asks) * 100) : 0}% answered</span>}
              />
            ))}
          </div>
        </TileFigure>
      </MetricCard>

      <HandoffTile handoffs={m.handoffs} />
    </>
  );
}

/**
 * Twin-to-twin handoffs, drawn the same way on both twins' pages so the one
 * figure cannot be worded two ways.
 */
export function HandoffTile({ handoffs }: { handoffs: NsMetrics['handoffs'] }) {
  return (
    <MetricCard title="Twin-to-twin handoffs" right="Linked Twin Ask" note={handoffs.note} noteMinLines={5} align="top">
      <TileFigure
        value={handoffs.n}
        format={(n) => String(Math.round(n))}
        missing="Neither ledger holds an ask yet."
        sub={`of ${handoffs.of} asks across both ledgers${handoffs.pct === null ? '' : ` · ${handoffs.pct}%`}`}
        replayKey={`handoffs|${handoffs.of}`}
      >
        {handoffs.pairs.length === 0 ? (
          <EmptyPanel min={56}>Neither twin has consulted the other in what is held.</EmptyPanel>
        ) : (
          <div className="space-y-1.5">
            {handoffs.pairs.slice(0, 5).map((pr) => (
              <div key={`${pr.ledger}|${pr.ask_id}`} className="text-[11.5px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className="tabular truncate text-dim"
                    title={
                      pr.direction === 'linked'
                        ? `${pr.ask_id}, in ${pr.ledger}'s ledger. It carries Linked Twin Ask but nothing that says which twin asked first, so no direction is claimed.`
                        : `${pr.ask_id}, in ${pr.ledger}'s ledger`
                    }
                  >
                    {/* "linked" where the row does not say which way it went. */}
                    {pr.direction === 'linked' ? 'linked' : pr.direction} · {pr.ask_id}
                  </span>
                  <span className="shrink-0 text-faint">{pr.ask_at ? pr.ask_at.slice(0, 10) : 'undated'}</span>
                </div>
                <div className="truncate text-faint" title={pr.reply_summary ?? pr.ask_question ?? ''}>
                  {pr.reply_summary ?? pr.ask_question ?? 'no text recorded'}
                </div>
              </div>
            ))}
          </div>
        )}
      </TileFigure>
    </MetricCard>
  );
}

/* ------------------------------------------------------------- the ask view */

function AskView({ r, onClose }: { r: NsAsk; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="North Star ask">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{r.ask_id ?? r.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{r.question_type ?? 'no question type'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="tabular">{when(r.asked_at)}</span>
              <OutcomePill outcome={r.outcome} />
              <DeliveredPill delivered={r.delivered} />
              <span>{r.lane ?? 'no lane'}</span>
              <span>
                {r.asked_by_system ?? 'no system named'}
                {r.asked_by_person ? ` · ${r.asked_by_person}` : ''}
              </span>
              {r.response_seconds !== null && <span className="tabular">{r.response_seconds}s</span>}
              {r.citation_coverage !== null && <span>coverage {r.citation_coverage}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* The permalink where there is one; no placeholder link where there is not. */}
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

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">The question, as it arrived</div>
          <p className="max-h-[24vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.question ?? 'No question text was recorded.'}</p>
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">Answer</div>
          {r.answer ? (
            <p className="max-h-[40vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.answer}</p>
          ) : (
            <p className="text-[12.5px] text-degraded">No answer text was recorded for this ask.</p>
          )}
        </div>

        {(r.claimed_priority_tier || r.claimed_lane_health || r.claimed_strategic_importance || r.claimed_priority_score !== null || r.architect_attention) && (
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            {/* What the answer itself claimed. Shown as claims, because that is what they are. */}
            {r.claimed_priority_score !== null && <Claim label="Claimed priority score" value={String(r.claimed_priority_score)} />}
            {r.claimed_priority_tier && <Claim label="Claimed priority tier" value={r.claimed_priority_tier} />}
            {r.claimed_lane_health && <Claim label="Claimed lane health" value={r.claimed_lane_health} />}
            {r.claimed_strategic_importance && <Claim label="Claimed strategic importance" value={r.claimed_strategic_importance} />}
            {r.confidence_stated && <Claim label="Confidence stated" value={r.confidence_stated} />}
            {r.architect_attention && <Claim label="Architect attention" value="asked for" />}
          </div>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="text-[13px] font-medium text-ink">Tool calls</div>
            <div className="text-[11px] text-faint">rows returned · rows cited</div>
          </div>
          {r.tools.length === 0 ? (
            <p className="text-[12.5px] text-faint">This ask made no tool calls — it was answered from what the agent already had.</p>
          ) : (
            <div className="space-y-1.5">
              {r.tools.map((t, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="truncate text-ink" title={t.args ?? undefined}>
                    {t.tool}
                  </span>
                  <span className="tabular shrink-0 text-dim">
                    {/* Blank rather than nought where the line recorded no counts. */}
                    {t.hits === null ? <span className="text-faint">no counts recorded</span> : <>{t.hits} rows · <span className={t.cited === 0 ? 'text-degraded' : ''}>{t.cited ?? 0} cited</span></>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

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

function Claim({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <div className="mt-0.5 text-[12.5px] text-ink">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------- page */

function nsColumns(open: (r: NsAsk) => void): RecordColumn<NsAsk>[] {
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
      cell: (r) =>
        r.asked_by_system ? (
          <span>
            {r.asked_by_system}
            {r.asked_by_person && <span className="text-faint"> · {r.asked_by_person}</span>}
          </span>
        ) : (
          <span className="text-faint">not named</span>
        ),
    },
    { key: 'type', header: 'type', width: '14ch', clip: true, className: 'text-dim', cell: (r) => r.question_type ?? <span className="text-faint">no type</span> },
    { key: 'lane', header: 'lane', width: '16ch', clip: true, className: 'text-dim', title: (r) => r.lane ?? undefined, cell: (r) => r.lane ?? <span className="text-faint">no lane</span> },
    {
      key: 'question',
      header: 'question',
      card: 'title',
      width: '52ch',
      clip: true,
      title: (r) => r.question ?? undefined,
      cell: (r) => r.answer_summary ?? r.question ?? <span className="text-faint">No question text was recorded.</span>,
    },
    { key: 'outcome', header: 'outcome', card: 'meta', className: 'card-meta', cell: (r) => <OutcomePill outcome={r.outcome} /> },
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
      key: 'coverage',
      header: 'coverage',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (r) => (r.citation_coverage === 0 ? 'text-degraded' : 'text-dim'),
      title: (r) => (r.tools.length ? r.tools.map((t) => `${t.tool}: ${t.hits === null ? 'no counts recorded' : `${t.hits} rows, ${t.cited ?? 0} cited`}`).join('\n') : undefined),
      cell: (r) => (r.citation_coverage === null ? <span className="text-faint">—</span> : r.citation_coverage),
    },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (r) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(r)} />
          {r.slack_link && <RowAction label="Open in Slack" onClick={() => window.open(r.slack_link!, '_blank', 'noreferrer')} />}
        </RowActions>
      ),
    },
  ];
}

const VIEWS = ['Asks', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

export default function NorthStar() {
  const { status, data: loaded, error } = useData(getNsTelemetry, []);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<View>('Asks');
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [tick, setTick] = useState(0);
  const [held, setHeld] = useState<NsAsk[]>([]);
  const { toast, setToast } = useToast();
  const metrics = useData(() => getRecordMetrics('ns', { lane: 'all' }, null, month), [month, tick]);

  useEffect(() => {
    if (loaded) setHeld(loaded.asks);
  }, [loaded]);

  const resync = useResync({
    run: () => resyncRecords('ns'),
    reload: async () => {
      setTick((n) => n + 1);
      setHeld((await getNsTelemetry()).asks);
    },
    setToast,
  });

  const asks = held;
  const months = useMemo(() => monthsFrom(asks.map((r) => r.asked_at)), [asks]);
  const inMonth = useMemo(() => asks.filter((r) => !month || r.asked_at?.slice(0, 7) === month), [asks, month]);
  const rows = useMemo(
    () =>
      inMonth
        .filter((r) => (filter === 'all' ? true : filter === 'not-delivered' ? r.delivered === 'Not delivered' : r.outcome === filter))
        .filter((r) => matches(r, q.trim())),
    [inMonth, filter, q],
  );
  const paged = usePaged(rows, `${filter}|${q.trim()}|${month ?? 'all'}`);

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? asks.find((r) => r.id === open) : null;
  const counts = {
    all: inMonth.length,
    Answered: inMonth.filter((r) => r.outcome === 'Answered').length,
    Thin: inMonth.filter((r) => r.outcome === 'Thin').length,
    'Refused (not its lane)': inMonth.filter((r) => r.outcome === 'Refused (not its lane)').length,
    Failed: inMonth.filter((r) => r.outcome === 'Failed').length,
    'not-delivered': inMonth.filter((r) => r.delivered === 'Not delivered').length,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="North Star"
        subtitle="Reads engine_ns_asks: every question routed through the North Star agent, what came back, and whether it reached anyone"
        right={<ResyncButton busy={resync.busy} onClick={resync.start} />}
        below={<Tabs tabs={VIEWS} value={view} onChange={setView} />}
      />

      {view === 'Statistics' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <RecordStatistics<NsAsk>
            kind="northstar"
            noun="Asks"
            month={month}
            onMonth={setMonth}
            rows={asks}
            dateOf={(r) => r.asked_at}
            extraTiles={<NsStatTiles m={metrics.data} />}
            columns={[
              { header: 'ask_id', value: (r) => r.ask_id },
              { header: 'record_id', value: (r) => r.id },
              { header: 'asked_at', value: (r) => r.asked_at },
              { header: 'asked_by_system', value: (r) => r.asked_by_system },
              { header: 'asked_by_person', value: (r) => r.asked_by_person },
              { header: 'question_type', value: (r) => r.question_type },
              { header: 'lane', value: (r) => r.lane },
              { header: 'outcome', value: (r) => r.outcome },
              { header: 'delivered', value: (r) => r.delivered },
              { header: 'delivery_target', value: (r) => r.delivery_target },
              { header: 'response_seconds', value: (r) => r.response_seconds },
              { header: 'citation_coverage', value: (r) => r.citation_coverage },
              { header: 'confidence_stated', value: (r) => r.confidence_stated },
              { header: 'claimed_priority_tier', value: (r) => r.claimed_priority_tier },
              { header: 'architect_attention', value: (r) => r.architect_attention },
              { header: 'linked_twin_ask', value: (r) => r.linked_twin_ask },
              { header: 'run_id', value: (r) => r.run_id },
              { header: 'question', value: (r) => r.question },
              { header: 'answer_summary', value: (r) => r.answer_summary },
              { header: 'slack_link', value: (r) => r.slack_link },
            ]}
          />
        </div>
      ) : (
        <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          <div className="shrink-0 px-6 pb-3 md:px-8">
            <RowsLine freshness={loaded.freshness} />
          </div>

          <NsStrip m={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />
          <NsWeekly m={metrics.data} loading={metrics.status === 'loading'} />

          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<Filter>
                ariaLabel="Filter asks"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All', count: counts.all, title: FILTER_DEF.all },
                  { value: 'Answered', label: 'Answered', count: counts.Answered, title: FILTER_DEF.Answered },
                  { value: 'Thin', label: 'Thin', count: counts.Thin, title: FILTER_DEF.Thin },
                  { value: 'Refused (not its lane)', label: 'Refused', count: counts['Refused (not its lane)'], title: FILTER_DEF['Refused (not its lane)'] },
                  { value: 'Failed', label: 'Failed', count: counts.Failed, title: FILTER_DEF.Failed },
                  { value: 'not-delivered', label: 'Not delivered', count: counts['not-delivered'], title: FILTER_DEF['not-delivered'] },
                ]}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <MonthPicker months={months} value={month} onChange={setMonth} />
                <SearchBox value={q} onChange={setQ} placeholder="Search questions, answers and callers" />
              </div>
            </div>
            <Definition term={filter === 'all' ? 'All' : filter === 'not-delivered' ? 'Not delivered' : filter === 'Refused (not its lane)' ? 'Refused' : filter}>{FILTER_DEF[filter]}</Definition>
          </div>

          {rows.length === 0 ? (
            <EmptyState>
              {loaded.freshness.source === 'none'
                ? (loaded.freshness.note ??
                  'No North Star ask is held yet. The ledger was created on 17 Sep 2026 with no history carried in, so this fills as the agent runs: it writes each ask here at the end of the run.')
                : q.trim()
                  ? 'No ask matches that search in this filter.'
                  : filter === 'not-delivered'
                    ? 'No ask this month is recorded as not delivered — and none can be yet: the agent stops before logging an ask whose Slack post was refused. Failed runs are on Executions.'
                    : filter === 'all'
                      ? 'No ask is held for this month. Before 17 Sep 2026 this ledger did not exist, so an empty month is an unrecorded one rather than a quiet one.'
                      : `No ask this month came back ${filter === 'Refused (not its lane)' ? 'refused' : filter.toLowerCase()}.`}
            </EmptyState>
          ) : (
            <>
              <RecordTable columns={nsColumns((r) => setOpen(r.id))} rows={paged.rows} rowKey={(r) => r.id} onOpen={(r) => setOpen(r.id)} label="North Star asks" />
              <Pagination paged={paged} unit="asks" />
            </>
          )}
        </div>
      )}

      {current && <AskView r={current} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
