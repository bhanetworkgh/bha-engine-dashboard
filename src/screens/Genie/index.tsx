import { createPortal } from 'react-dom';
import { useMemo, useState, type ReactNode } from 'react';
import { useData } from '../../app/useData';
import { getGenie, type GenieAsk, type GenieData, type Percentiles, type Share } from '../../data';
import type { RecordColumn } from '../../components/ui';
import {
  Button,
  Definition,
  EmptyState,
  FacetPicker,
  facetOptions,
  FigureCell,
  LoadFailed,
  Loading,
  MetricCard,
  MonthPicker,
  monthLabel,
  monthsFrom,
  OutcomeColumns,
  PageHeader,
  Pagination,
  PercentCell,
  PercentileCell,
  Pill,
  RecordId,
  RecordTable,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  StatStrip,
  Tabs,
  relativeTime,
  thisMonth,
  usePaged,
  useReplayKey,
} from '../../components/ui';
import RecordStatistics from '../../components/RecordStatistics';

/**
 * Genie (2026-09-29, Destiny — D3). Until then a placeholder: nothing Genie did
 * reached this dashboard. Now Genie posts one event per ask to
 * `POST /api/engine/genie-events` — its own service-callback envelope, sent to
 * one more receiver — and this page reads them the moment they land.
 *
 * **Shaped like North Star and Research Twin**: Asks, the working surface, and
 * Statistics. One row per ask — the latest event held for its request id — so
 * a message that was accepted and then completed is one ask, not two.
 *
 * **Brought level with the twins' pages on 2026-10-05 (Destiny)**, the day the
 * first real ask arrived and the page read thin beside them: an ask opens in
 * the same panel a North Star ask does rather than unfolding inside the table;
 * the Asks tab shows one month at a time, with an outcome filter, a
 * where-it-came-from picker and a search; and Statistics is the shared
 * month-against-month tab with its chart of every month held and its CSV
 * export. The strip follows the month in view, like the list under it: a strip
 * answering all time beside a list answering one month is two right numbers to
 * two different questions.
 *
 * **Before the first event, the page says so** and names who wires it; it never
 * draws sample rows. The figures follow the twins' rules: a rate carries its
 * denominator, a duration is p50 and p95 and never a mean, and an ask that did
 * not send `duration_ms` is left out of the timing rather than counted as
 * instant.
 */

const TABS = ['Asks', 'Statistics'] as const;
type Tab = (typeof TABS)[number];

type Filter = 'all' | 'Answered' | 'Incomplete' | 'Failed' | 'handed';

/** One line per filter word, from the rules in server/src/systemFeeds.ts. */
const FILTER_DEF: Record<Filter, { term: string; def: string }> = {
  all: { term: 'All', def: 'Every ask Genie reported in this month, whatever came back.' },
  Answered: { term: 'Answered', def: "The ask's last event says satisfied: Genie's own judge accepted the answer." },
  Incomplete: { term: 'Incomplete', def: 'Genie stopped at its iteration limit. It answered something, but its judge did not accept it. Not a failure.' },
  Failed: { term: 'Failed', def: 'The last event is genie.*.failed or carries status error. Genie also opens a BHARAG incident for these.' },
  handed: { term: 'Handed to a twin', def: 'Genie sent the question on to Research Twin or North Star, and the event names which.' },
};

const OUTCOME_ORDER = ['Answered', 'Incomplete', 'Failed'];
const OUTCOME_COLOUR = (o: string) => (o === 'Answered' ? 'var(--accent)' : o === 'Incomplete' ? 'var(--degraded)' : o === 'Failed' ? 'var(--failing)' : 'var(--dim)');

/** What the where-from picker calls an ask whose event carried no source. */
const NOT_SENT = '(not sent)';

function OutcomePill({ outcome }: { outcome: string }) {
  if (outcome === 'Failed') return <Pill tone="failing">failed</Pill>;
  if (outcome === 'Incomplete') return <Pill tone="degraded">incomplete</Pill>;
  if (outcome === 'Answered') return <Pill>answered</Pill>;
  return <Pill>{outcome.toLowerCase()}</Pill>;
}

const seconds = (ms: number | null) => (ms === null ? '—' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const handoffLabel = (h: string | null) => (h === 'research_twin' ? 'Research Twin' : h === 'north_star' ? 'North Star' : h);
/** The row's own key: its request id, or the event id where Genie sent none. */
const keyOf = (a: GenieAsk) => a.request_id ?? a.event_id;

function matches(a: GenieAsk, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [a.request_id, a.event_id, a.question, a.answer, a.error, a.builder_id, a.lane, a.source, a.handoff, a.status].some((v) => v && v.toLowerCase().includes(n));
}

/* ------------------------------------------------------- the month's figures */

const share = (n: number, of: number, note: string): Share => ({ n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null, note });

/** Nearest-rank p50 and p95 in seconds, as the server computes them: a real observation, never an interpolation. */
function percentiles(ms: number[], of: number, note: string): Percentiles {
  const s = ms.map((v) => v / 1000).sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(at(50)), p95: round(at(95)), n: s.length, of, note };
}

/**
 * The five figures, over the asks in the month in view and nothing else — not
 * the outcome filter, the source or the search, which narrow the list and not
 * the month. Computed here from the rows on the page, with the same arithmetic
 * the server uses for its all-time summary, so the strip and the list under it
 * are always about the same asks.
 */
function Strip({ rows, month }: { rows: GenieAsk[]; month: string | null }) {
  const n = rows.length;
  const scope = month ? `in ${monthLabel(month)}` : 'held';
  const timed = rows.filter((a) => a.duration_ms !== null).map((a) => a.duration_ms as number);
  const last7 = rows.filter((a) => Date.now() - Date.parse(a.occurred_at) < 7 * 86_400_000).length;
  return (
    <StatStrip cols={5} flush>
      <FigureCell label="Asks" value={n} caption={`${scope} · ${last7} in the last 7 days`} note="One per request id: the latest event Genie sent for it. Genie pushes these; nothing here polls it." />
      <PercentCell
        label="Answered"
        share={share(rows.filter((a) => a.outcome === 'Answered').length, n, "Asks whose last event says satisfied — Genie's own judge accepted the answer. An ask that stopped at its iteration limit is Incomplete, not Answered and not Failed.")}
        caption="Genie's own judge accepted the answer"
      />
      <PercentCell
        label="Failed"
        share={share(rows.filter((a) => a.outcome === 'Failed').length, n, 'Asks whose last event is genie.*.failed or carries status error. Genie also opens a BHARAG incident for these.')}
        bad={(x) => x.n > 0}
        caption="ended in genie.*.failed or status error"
      />
      <PercentCell
        label="Handed to a twin"
        share={share(rows.filter((a) => a.handoff).length, n, 'Asks Genie sent on to Research Twin or North Star, where the event names the hand-off. Counted only where Genie says so.')}
        caption="sent on to Research Twin or North Star"
      />
      <PercentileCell
        label="Time to answer"
        p={percentiles(timed, n, `Over the ${timed.length} of ${n} asks ${scope} that sent a duration. Never a mean. An ask that sent none is left out, not counted as instant.`)}
        unit="s"
        caption={`over ${timed.length} of ${n} asks that sent it`}
      />
    </StatStrip>
  );
}

/* --------------------------------------------------------------- the ask view */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <div className="mt-0.5 text-[12.5px] text-ink">{children}</div>
    </div>
  );
}

/** One ask, in the panel a North Star ask opens in — the question, the answer and what Genie said about the run. */
function AskView({ a, onClose }: { a: GenieAsk; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Genie ask">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{a.request_id ?? a.event_id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{a.source ? `Asked from ${a.source}` : 'Where it was asked from was not sent'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="tabular">{when(a.occurred_at)} UTC</span>
              <OutcomePill outcome={a.outcome} />
              <span>{a.lane ?? 'no lane'}</span>
              <span>{a.builder_id ?? 'no builder named'}</span>
              {a.duration_ms !== null && <span className="tabular">{seconds(a.duration_ms)}</span>}
              {a.handoff && <span>handed to {handoffLabel(a.handoff)}</span>}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {a.error && a.outcome !== 'Answered' && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">{a.outcome === 'Failed' ? 'What went wrong' : "Genie's judge said"}</div>
            <p className={`text-[13px] leading-relaxed whitespace-pre-wrap ${a.outcome === 'Failed' ? 'text-failing' : 'text-dim'}`}>{a.error}</p>
          </div>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">The question, as Genie sent it</div>
          {a.question ? (
            <p className="max-h-[24vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{a.question}</p>
          ) : (
            <p className="text-[12.5px] text-faint">{a.retention_cleared_at ? `Cleared after 180 days, on ${when(a.retention_cleared_at)} UTC.` : 'The event carried no question text.'}</p>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">Answer</div>
          {a.answer ? (
            <p className="max-h-[40vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{a.answer}</p>
          ) : (
            <p className="text-[12.5px] text-faint">{a.retention_cleared_at ? 'Cleared after 180 days.' : 'The event carried no answer text.'}</p>
          )}
        </div>

        {a.error && a.outcome === 'Answered' && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">Genie's judge said</div>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">{a.error}</p>
          </div>
        )}

        <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Field label="Request id">
            <RecordId>{a.request_id ?? '—'}</RecordId>
          </Field>
          <Field label="Event id">
            <RecordId>{a.event_id}</RecordId>
          </Field>
          <Field label="Run id">{a.run_id ? <RecordId>{a.run_id}</RecordId> : <span className="text-faint">not sent</span>}</Field>
          <Field label="Event type">{a.event_type}</Field>
          <Field label="Status">{a.status ?? <span className="text-faint">not sent</span>}</Field>
          <Field label="Received here">{when(a.received_at)} UTC</Field>
        </div>

        <div className="mt-4 border-t border-line pt-3 text-[11.5px] text-faint">Pushed by Genie to /api/engine/genie-events. This page shows the latest event held for the request.</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ the asks */

function columns(open: (a: GenieAsk) => void): RecordColumn<GenieAsk>[] {
  return [
    { key: 'when', header: 'when (UTC)', className: 'tabular text-faint', cell: (a) => when(a.occurred_at) },
    {
      key: 'question',
      header: 'question',
      card: 'title',
      width: '52ch',
      clip: true,
      title: (a) => a.question ?? undefined,
      cell: (a) => a.question ?? <span className="text-faint">{a.retention_cleared_at ? 'cleared after 180 days' : 'not sent'}</span>,
    },
    { key: 'asked_by', header: 'asked by', width: '14ch', clip: true, className: 'tabular text-dim', cell: (a) => a.builder_id ?? <span className="text-faint">not named</span> },
    { key: 'lane', header: 'lane', width: '18ch', clip: true, className: 'text-dim', title: (a) => a.lane ?? undefined, cell: (a) => a.lane ?? <span className="text-faint">no lane</span> },
    { key: 'from', header: 'from', className: 'text-dim', cell: (a) => a.source ?? <span className="text-faint">not sent</span> },
    { key: 'outcome', header: 'outcome', card: 'meta', className: 'card-meta', cell: (a) => <OutcomePill outcome={a.outcome} /> },
    { key: 'time', header: 'time', align: 'right', card: 'meta', className: 'card-meta tabular text-dim', cell: (a) => (a.duration_ms === null ? <span className="text-faint">—</span> : seconds(a.duration_ms)) },
    { key: 'handed', header: 'handed to', className: 'text-dim', cell: (a) => handoffLabel(a.handoff) ?? <span className="text-faint">—</span> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (a) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(a)} />
        </RowActions>
      ),
    },
  ];
}

function Freshness({ data }: { data: GenieData }) {
  return (
    <p className="text-[12px] text-dim">
      {data.meta.events} event{data.meta.events === 1 ? '' : 's'} held since {when(data.meta.first_event_at)} UTC · last received {relativeTime(data.meta.last_received_at) ?? '—'}
      {data.meta.subagent_events ? ` · ${data.meta.subagent_events} coding-subagent event(s), not counted as asks` : ''}
    </p>
  );
}

function Asks({ data, month, onMonth, onOpen }: { data: GenieData; month: string | null; onMonth: (m: string | null) => void; onOpen: (a: GenieAsk) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [from, setFrom] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useReplayKey(`${month}|${filter}|${from}`);

  const months = useMemo(() => monthsFrom(data.asks.map((a) => a.occurred_at)), [data.asks]);
  const inMonth = useMemo(() => data.asks.filter((a) => !month || a.occurred_at.slice(0, 7) === month), [data.asks, month]);
  const byFilter = (a: GenieAsk, f: Filter) => (f === 'all' ? true : f === 'handed' ? Boolean(a.handoff) : a.outcome === f);
  // Everything but where it came from, so each option in that picker counts what picking it would show.
  const beforeFrom = useMemo(() => inMonth.filter((a) => byFilter(a, filter)).filter((a) => matches(a, q.trim())), [inMonth, filter, q]);
  const fromOptions = useMemo(() => facetOptions(beforeFrom, (a) => a.source, NOT_SENT), [beforeFrom]);
  const rows = useMemo(() => beforeFrom.filter((a) => !from || (a.source || NOT_SENT) === from), [beforeFrom, from]);
  const forCounts = useMemo(() => inMonth.filter((a) => !from || (a.source || NOT_SENT) === from), [inMonth, from]);
  const paged = usePaged(rows, `${filter}|${from ?? 'all'}|${q.trim()}|${month ?? 'all'}`);

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="shrink-0 space-y-4 px-6 pb-4 md:px-8">
        <Freshness data={data} />
        <Strip rows={inMonth} month={month} />
      </div>

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<Filter>
            ariaLabel="Filter asks"
            value={filter}
            onChange={setFilter}
            options={(['all', 'Answered', 'Incomplete', 'Failed', 'handed'] as Filter[]).map((f) => ({
              value: f,
              label: FILTER_DEF[f].term,
              count: forCounts.filter((a) => byFilter(a, f)).length,
              title: FILTER_DEF[f].def,
            }))}
          />
          <div className="flex flex-1 flex-wrap items-center justify-end gap-3">
            <FacetPicker label="From" allLabel="Everywhere" value={from} options={fromOptions} onChange={setFrom} />
            <MonthPicker months={months} value={month} onChange={onMonth} />
            <SearchBox value={q} onChange={setQ} placeholder="Search questions, answers and ids" />
          </div>
        </div>
        <Definition term={FILTER_DEF[filter].term}>{FILTER_DEF[filter].def}</Definition>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {q.trim()
            ? 'No ask matches that search in this filter.'
            : from
              ? `No ask in this filter came from ${from}.`
              : filter === 'all'
                ? month
                  ? `Genie reported no ask in ${monthLabel(month)}. Its first event here is dated ${when(data.meta.first_event_at)} UTC, so a month before that was not quiet, it was not recorded.`
                  : 'No ask is held.'
                : filter === 'handed'
                  ? 'No ask this month was handed to a twin.'
                  : `No ask this month came back ${filter.toLowerCase()}.`}
        </EmptyState>
      ) : (
        <>
          <RecordTable columns={columns(onOpen)} rows={paged.rows} rowKey={keyOf} onOpen={onOpen} label="Genie asks" />
          <Pagination paged={paged} unit="asks" />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- statistics */

function Cohorts({ rows, blank }: { rows: GenieData['summary']['by_lane']; blank: string }) {
  if (rows.length === 0) return <p className="text-[12px] text-faint">{blank}</p>;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[10.5px] text-faint">
        <span />
        <span className="text-right">asks</span>
        <span className="text-right">answered</span>
        <span className="text-right">not failed</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[12.5px]">
          <span className="truncate text-ink">{r.label}</span>
          <span className="tabular text-right text-dim">{r.asks}</span>
          <span className="tabular text-right text-dim" title={`${r.answered} of ${r.asks}`}>
            {pct(r.answered, r.asks)}
          </span>
          <span className={`tabular text-right ${r.delivered < r.asks ? 'text-degraded' : 'text-dim'}`} title={`${r.asks - r.delivered} failed`}>
            {pct(r.delivered, r.asks)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The three cards this page brings to the shared statistics grid. **They are
 * over every ask held, not the month in view**, and each footnote says so: the
 * weekly chart is the last eight weeks whichever month is picked, and a lane's
 * or a source's rates are only readable once it has more than a month's asks.
 */
function GenieTiles({ data }: { data: GenieData }) {
  const s = data.summary;
  return (
    <>
      <MetricCard title="Outcome by week" right="status" note="The last eight weeks, one column a week, whichever month is in view. A week with no ask draws nothing: it was not recorded, not quiet." align="top">
        <OutcomeColumns weeks={s.outcome_per_week} order={OUTCOME_ORDER} colour={OUTCOME_COLOUR} />
        <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-dim">
          {s.outcome_mix.map((o) => (
            <span key={o.key}>
              {o.label} {o.n}
            </span>
          ))}
        </div>
      </MetricCard>
      <MetricCard title="By lane" right="lane" note={`Over all ${s.asks} asks held, not only the month in view. Genie's lane on the event, or (no lane). Each lane with its own rates, so one lane failing cannot hide inside the total.`} align="top">
        <Cohorts rows={s.by_lane} blank="No ask carries a lane." />
      </MetricCard>
      <MetricCard title="By where the ask came from" right="source" note={`Over all ${s.asks} asks held, not only the month in view. The event's source: Slack, the service API, the browser, voice. (not sent) until Genie sends it.`} align="top">
        <Cohorts rows={s.by_source} blank="No ask carries a source." />
      </MetricCard>
    </>
  );
}

/* --------------------------------------------------------------------- page */

export default function Genie() {
  const [tab, setTab] = useState<Tab>('Asks');
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [open, setOpen] = useState<string | null>(null);
  useReplayKey(`${tab}|${month}`);
  const { status, data, error } = useData(getGenie, [], { kinds: ['genie_events'] });
  const current = open && data ? data.asks.find((a) => keyOf(a) === open) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Genie"
        subtitle="Genie's asks, as Genie reports them"
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={{ Asks: data?.summary.asks ? { n: data.summary.asks } : undefined }} />}
      />
      {status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : data.meta.events === 0 ? (
        <div className="px-6 pb-8 md:px-8">
          <EmptyState>
            No Genie event has arrived yet. Genie posts one event per ask to <code>/api/engine/genie-events</code> once Kaiqi wires it (the contract is
            docs/contracts/genie-events.md in this repo). The first one appears here the moment it lands — there is nothing to press.
          </EmptyState>
        </div>
      ) : tab === 'Asks' ? (
        <Asks data={data} month={month} onMonth={setMonth} onOpen={(a) => setOpen(keyOf(a))} />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <div className="px-6 pb-3 md:px-8">
            <Freshness data={data} />
          </div>
          <RecordStatistics<GenieAsk>
            kind="genie"
            noun="Asks"
            month={month}
            onMonth={setMonth}
            rows={data.asks}
            dateOf={(a) => a.occurred_at}
            extraTiles={<GenieTiles data={data} />}
            columns={[
              { header: 'request_id', value: (a) => a.request_id },
              { header: 'event_id', value: (a) => a.event_id },
              { header: 'run_id', value: (a) => a.run_id },
              { header: 'occurred_at', value: (a) => a.occurred_at },
              { header: 'received_at', value: (a) => a.received_at },
              { header: 'builder_id', value: (a) => a.builder_id },
              { header: 'lane', value: (a) => a.lane },
              { header: 'source', value: (a) => a.source },
              { header: 'event_type', value: (a) => a.event_type },
              { header: 'status', value: (a) => a.status },
              { header: 'outcome', value: (a) => a.outcome },
              { header: 'duration_ms', value: (a) => a.duration_ms },
              { header: 'handoff', value: (a) => a.handoff },
              { header: 'question', value: (a) => a.question },
              { header: 'answer', value: (a) => a.answer },
              { header: 'error', value: (a) => a.error },
            ]}
          />
        </div>
      )}

      {current && <AskView a={current} onClose={() => setOpen(null)} />}
    </div>
  );
}
