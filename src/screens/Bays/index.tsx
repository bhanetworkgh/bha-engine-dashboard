import { createPortal } from 'react-dom';
import { useMemo, useState, type ReactNode } from 'react';
import { useData } from '../../app/useData';
import { getBays, getBaysReminders, type BaysAsk, type BaysData, type BaysReminder, type Percentiles, type Share } from '../../data';
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
 * Bays (2026-10-05, Destiny). Bays' ask ledger has been written since 28 Sep
 * 2026 and no page listed it: the scorecard and the quality alert were its only
 * readers. From 5 Oct it also holds every scheduled task run and every Ask Bays
 * panel question, and a record nobody can open is one nobody can check.
 *
 * **The same shape as North Star, Research Twin and Genie**: Asks, one month at
 * a time, and the shared Statistics tab. The picker that matters here is
 * **From** — Slack, a scheduled task, the dashboard panel — because those are
 * three different kinds of work and a failure in one hides inside the others.
 *
 * Read only. The rows are written by n8n; nothing here changes one.
 */

const TABS = ['Asks', 'Statistics', 'Reminders'] as const;
type Tab = (typeof TABS)[number];

type Filter = 'all' | 'Answered' | 'issues' | 'Failed' | 'undelivered';

const FILTER_DEF: Record<Filter, { term: string; def: string }> = {
  all: { term: 'All', def: 'Every row Bays wrote in this month: Slack turns, scheduled task runs and panel questions.' },
  Answered: { term: 'Answered', def: 'Outcome is Answered: Bays replied and no tool call failed on the way.' },
  issues: { term: 'Tool issues', def: 'Outcome is Answered with tool issues: Bays replied, but a tool call failed along the way. The row names which.' },
  Failed: { term: 'Failed', def: 'Outcome is Failed: the run ended without a usable answer, or a scheduled task reported it failed.' },
  undelivered: { term: 'Not delivered', def: 'Delivered is anything but Delivered. A scheduled run that had nothing to post is left out: that is not a missed delivery.' },
};

const OUTCOME_ORDER = ['Answered', 'Answered with tool issues', 'Failed'];
const OUTCOME_COLOUR = (o: string) => (o === 'Answered' ? 'var(--accent)' : o === 'Answered with tool issues' ? 'var(--degraded)' : o === 'Failed' ? 'var(--failing)' : 'var(--dim)');

const NOT_SENT = '(not sent)';
const SOURCE_LABEL: Record<string, string> = { slack_direct: 'Slack', scheduled: 'Scheduled task', dashboard_panel: 'Ask Bays panel' };
const sourceLabel = (s: string | null) => (s ? (SOURCE_LABEL[s] ?? s) : NOT_SENT);

const failed = (a: BaysAsk) => a.outcome === 'Failed';
const undelivered = (a: BaysAsk) => a.delivered !== null && a.delivered !== 'Delivered' && !(a.source === 'scheduled' && a.delivered === 'Nothing posted');
const byFilter = (a: BaysAsk, f: Filter) =>
  f === 'all' ? true : f === 'issues' ? a.outcome === 'Answered with tool issues' : f === 'undelivered' ? undelivered(a) : a.outcome === f;

function OutcomePill({ outcome }: { outcome: string | null }) {
  if (outcome === 'Failed') return <Pill tone="failing">failed</Pill>;
  if (outcome === 'Answered with tool issues') return <Pill tone="degraded">tool issues</Pill>;
  if (!outcome) return <span className="text-faint">not sent</span>;
  return <Pill>{outcome.toLowerCase()}</Pill>;
}

const seconds = (s: number | null) => (s === null ? '—' : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
/** What the row is about: the task for a scheduled run, the question otherwise. */
const subject = (a: BaysAsk) => (a.source === 'scheduled' && a.task_name ? a.task_name : a.question);

function matches(a: BaysAsk, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [a.ask_id, a.question, a.answer, a.error, a.tool_issues, a.asked_by_person, a.lane, a.task_name, a.run_id, a.delivery_target].some((v) => v && v.toLowerCase().includes(n));
}

/* ------------------------------------------------------- the month's figures */

const share = (n: number, of: number, note: string): Share => ({ n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null, note });

/** Nearest-rank p50 and p95, as the server computes them: a real observation, never an interpolation. */
function percentiles(values: number[], of: number, note: string): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(at(50)), p95: round(at(95)), n: s.length, of, note };
}

/** Five figures over the month in view and nothing else, computed from the rows on the page so the strip and the list agree. */
function Strip({ rows, month }: { rows: BaysAsk[]; month: string | null }) {
  const n = rows.length;
  const scope = month ? `in ${monthLabel(month)}` : 'held';
  const timed = rows.filter((a) => a.response_seconds !== null).map((a) => a.response_seconds as number);
  const count = (s: string) => rows.filter((a) => a.source === s).length;
  return (
    <StatStrip cols={5} flush>
      <FigureCell
        label="Asks"
        value={n}
        caption={`${count('slack_direct')} Slack · ${count('scheduled')} scheduled · ${count('dashboard_panel')} panel`}
        note={`Every row Bays wrote ${scope}. Scheduled task runs and panel questions are recorded from 5 Oct 2026; before that only Slack turns were.`}
      />
      <PercentCell label="Failed" share={share(rows.filter(failed).length, n, `Rows whose Outcome is Failed, over all ${n} ${scope}.`)} bad={(x) => x.n > 0} caption="ended without a usable answer" />
      <PercentCell
        label="Tool issues"
        share={share(rows.filter((a) => a.outcome === 'Answered with tool issues').length, n, `Rows where Bays answered but a tool call failed on the way, over all ${n} ${scope}.`)}
        caption="answered, but a tool call failed"
      />
      <PercentCell
        label="Not delivered"
        share={share(rows.filter(undelivered).length, n, `Rows whose Delivered is anything but Delivered, over all ${n} ${scope}. A scheduled run that had nothing to post is left out.`)}
        bad={(x) => x.n > 0}
        caption="a reply that did not reach anyone"
      />
      <PercentileCell
        label="Response time"
        p={percentiles(timed, n, `Over the ${timed.length} of ${n} rows ${scope} that carry Response Seconds. Never a mean.`)}
        unit="s"
        caption={`over ${timed.length} of ${n} rows that carry it`}
      />
    </StatStrip>
  );
}

/* --------------------------------------------------------------- the ask view */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <div className="mt-0.5 text-[12.5px] break-words text-ink">{children}</div>
    </div>
  );
}

const blank = <span className="text-faint">not sent</span>;

function AskView({ a, cap, onClose }: { a: BaysAsk; cap: number; onClose: () => void }) {
  const scheduled = a.source === 'scheduled';
  const cut = a.answer_chars !== null && a.answer !== null && a.answer_chars > a.answer.length;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Bays ask">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{a.ask_id ?? `row ${a.id}`}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{scheduled ? `Scheduled task: ${a.task_name ?? 'not named'}` : `Asked from ${sourceLabel(a.source)}`}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="tabular">{when(a.asked_at)} UTC</span>
              <OutcomePill outcome={a.outcome} />
              {a.delivered && <span className={undelivered(a) ? 'text-failing' : ''}>{a.delivered.toLowerCase()}</span>}
              <span>{a.asked_by_person ?? a.asked_by_system ?? 'asker not named'}</span>
              <span>{a.lane ?? 'no lane'}</span>
              {a.response_seconds !== null && <span className="tabular">{seconds(a.response_seconds)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {a.slack_link && (
              <a className="text-[12.5px] text-accent hover:underline" href={a.slack_link} target="_blank" rel="noreferrer">
                Open in Slack ↗
              </a>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {a.error && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">What went wrong</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-failing">{a.error}</p>
          </div>
        )}
        {a.tool_issues && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">Tool issues</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-dim">{a.tool_issues}</p>
          </div>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">{scheduled ? 'What the task was' : 'The question'}</div>
          {a.question ? (
            <p className="max-h-[24vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{a.question}</p>
          ) : (
            <p className="text-[12.5px] text-faint">{a.retention_cleared_at ? `Cleared after 180 days, on ${when(a.retention_cleared_at)} UTC.` : 'The row carries no question text.'}</p>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">{scheduled ? 'What Bays reported' : 'Answer'}</div>
          {a.answer ? (
            <>
              <p className="max-h-[40vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{a.answer}</p>
              {cut && (
                <p className="mt-2 text-[11.5px] text-faint">
                  Showing the first {cap.toLocaleString()} of {a.answer_chars?.toLocaleString()} characters. The ledger holds the rest.
                </p>
              )}
            </>
          ) : (
            <p className="text-[12.5px] text-faint">{a.retention_cleared_at ? 'Cleared after 180 days.' : 'The row carries no answer text.'}</p>
          )}
        </div>

        <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Field label="Ask id">{a.ask_id ? <RecordId>{a.ask_id}</RecordId> : blank}</Field>
          <Field label="Run id">{a.run_id ? <RecordId>{a.run_id}</RecordId> : blank}</Field>
          <Field label="Asked by system">{a.asked_by_system ?? blank}</Field>
          <Field label="Delivered as">{a.delivered_as ?? blank}</Field>
          <Field label="Delivery target">{a.delivery_target ?? blank}</Field>
          {scheduled && <Field label="Task outcome">{a.task_outcome ?? blank}</Field>}
        </div>

        <div className="mt-4 border-t border-line pt-3 text-[11.5px] text-faint">Written by n8n to /api/engine/bays-asks. This page reads the row and changes nothing.</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ the asks */

function columns(open: (a: BaysAsk) => void): RecordColumn<BaysAsk>[] {
  return [
    { key: 'when', header: 'when (UTC)', className: 'tabular text-faint', cell: (a) => when(a.asked_at) },
    {
      key: 'question',
      header: 'question or task',
      card: 'title',
      width: '52ch',
      clip: true,
      title: (a) => subject(a) ?? undefined,
      cell: (a) => subject(a) ?? <span className="text-faint">{a.retention_cleared_at ? 'cleared after 180 days' : 'not sent'}</span>,
    },
    { key: 'from', header: 'from', className: 'text-dim', cell: (a) => sourceLabel(a.source) },
    { key: 'asked_by', header: 'asked by', width: '16ch', clip: true, className: 'text-dim', cell: (a) => a.asked_by_person ?? <span className="text-faint">not named</span> },
    { key: 'outcome', header: 'outcome', card: 'meta', className: 'card-meta', cell: (a) => <OutcomePill outcome={a.outcome} /> },
    {
      key: 'delivered',
      header: 'delivered',
      className: 'text-dim',
      cell: (a) => (a.delivered ? <span className={undelivered(a) ? 'text-failing' : ''}>{a.delivered.toLowerCase()}</span> : <span className="text-faint">not sent</span>),
    },
    { key: 'time', header: 'time', align: 'right', card: 'meta', className: 'card-meta tabular text-dim', cell: (a) => (a.response_seconds === null ? <span className="text-faint">—</span> : seconds(a.response_seconds)) },
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

function Freshness({ data }: { data: BaysData }) {
  return (
    <p className="text-[12px] text-dim">
      {data.meta.rows} row{data.meta.rows === 1 ? '' : 's'} held since {when(data.meta.first_ask_at)} UTC · last written {relativeTime(data.meta.last_ask_at) ?? '—'}
      {data.meta.undated ? ` · ${data.meta.undated} with no usable date, in no month` : ''}
    </p>
  );
}

function Asks({ data, month, onMonth, onOpen }: { data: BaysData; month: string | null; onMonth: (m: string | null) => void; onOpen: (a: BaysAsk) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [from, setFrom] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useReplayKey(`${month}|${filter}|${from}`);

  const months = useMemo(() => monthsFrom(data.asks.map((a) => a.asked_at).filter((d): d is string => Boolean(d))), [data.asks]);
  const inMonth = useMemo(() => data.asks.filter((a) => !month || a.asked_at?.slice(0, 7) === month), [data.asks, month]);
  const beforeFrom = useMemo(() => inMonth.filter((a) => byFilter(a, filter)).filter((a) => matches(a, q.trim())), [inMonth, filter, q]);
  const fromOptions = useMemo(() => facetOptions(beforeFrom, (a) => sourceLabel(a.source), NOT_SENT), [beforeFrom]);
  const rows = useMemo(() => beforeFrom.filter((a) => !from || sourceLabel(a.source) === from), [beforeFrom, from]);
  const forCounts = useMemo(() => inMonth.filter((a) => !from || sourceLabel(a.source) === from), [inMonth, from]);
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
            options={(['all', 'Answered', 'issues', 'Failed', 'undelivered'] as Filter[]).map((f) => ({
              value: f,
              label: FILTER_DEF[f].term,
              count: forCounts.filter((a) => byFilter(a, f)).length,
              title: FILTER_DEF[f].def,
            }))}
          />
          <div className="flex flex-1 flex-wrap items-center justify-end gap-3">
            <FacetPicker label="From" allLabel="Everywhere" value={from} options={fromOptions} onChange={setFrom} />
            <MonthPicker months={months} value={month} onChange={onMonth} />
            <SearchBox value={q} onChange={setQ} placeholder="Search questions, answers, tasks and ids" />
          </div>
        </div>
        <Definition term={FILTER_DEF[filter].term}>{FILTER_DEF[filter].def}</Definition>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {q.trim()
            ? 'No row matches that search in this filter.'
            : from
              ? `No row in this filter came from ${from}.`
              : filter === 'all'
                ? month
                  ? `Bays wrote no row in ${monthLabel(month)}. The ledger starts on ${when(data.meta.first_ask_at)} UTC, so a month before that was not quiet, it was not recorded.`
                  : 'No row is held.'
                : `No row this month is ${FILTER_DEF[filter].term.toLowerCase()}.`}
        </EmptyState>
      ) : (
        <>
          <RecordTable columns={columns(onOpen)} rows={paged.rows} rowKey={(a) => a.id} onOpen={onOpen} label="Bays asks" />
          <Pagination paged={paged} unit="asks" />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- statistics */

function BaysTiles({ data }: { data: BaysData }) {
  const s = data.summary;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  return (
    <>
      <MetricCard title="Outcome by week" right="Outcome" note="The last eight weeks, one column a week, whichever month is in view. A week with no row draws nothing: it was not recorded, not quiet." align="top">
        <OutcomeColumns weeks={s.outcome_per_week} order={OUTCOME_ORDER} colour={OUTCOME_COLOUR} />
      </MetricCard>
      <MetricCard
        title="By where it came from"
        right="Source"
        note={`Over all ${s.asks} rows held, not only the month in view. Each source with its own rates, so a scheduled task failing cannot hide behind hundreds of Slack turns. Scheduled and panel rows start on 5 Oct 2026.`}
        align="top"
      >
        <div className="space-y-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[10.5px] text-faint">
            <span />
            <span className="text-right">rows</span>
            <span className="text-right">not failed</span>
            <span className="text-right">delivered</span>
          </div>
          {s.by_source.map((r) => (
            <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[12.5px]">
              <span className="truncate text-ink">{sourceLabel(r.key === NOT_SENT ? null : r.key)}</span>
              <span className="tabular text-right text-dim">{r.asks}</span>
              <span className={`tabular text-right ${r.answered < r.asks ? 'text-degraded' : 'text-dim'}`} title={`${r.answered} of ${r.asks}`}>
                {pct(r.answered, r.asks)}
              </span>
              <span className={`tabular text-right ${r.delivered < r.asks ? 'text-degraded' : 'text-dim'}`} title={`${r.delivered} of ${r.asks}`}>
                {pct(r.delivered, r.asks)}
              </span>
            </div>
          ))}
        </div>
      </MetricCard>
    </>
  );
}

/* ---------------------------------------------------------------- reminders */

/**
 * Reminder posts scheduled through Bays (2026-10-05, Destiny). Slack holds each
 * message and posts it as Bays, so a reminder whose time has passed reads
 * "handed to Slack": this dashboard cannot read the channel back, and saying
 * "posted" would be a claim nothing here checked. Read only; a reminder is
 * scheduled or cancelled by asking Bays.
 */
function ReminderState({ r }: { r: BaysReminder }) {
  if (r.state === 'waiting') return <Pill tone="accent">waiting</Pill>;
  if (r.state === 'cancelled') return <Pill>cancelled</Pill>;
  return <Pill>handed to Slack</Pill>;
}

function Reminders() {
  const { status, data, error } = useData(getBaysReminders, []);
  const paged = usePaged(data?.reminders ?? [], 'reminders');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="shrink-0 space-y-2 px-6 pb-4 md:px-8">
        <p className="text-[12px] text-dim">
          {data.waiting} waiting to go out · {data.reminders.length} held in all
        </p>
        <p className="text-[12px] text-faint">{data.note} To schedule or cancel one, ask Bays in Slack.</p>
      </div>
      {data.reminders.length === 0 ? (
        <EmptyState>No reminder has been scheduled through Bays yet. Ask Bays in Slack to post one on a date, and it appears here once you confirm it.</EmptyState>
      ) : (
        <>
          <RecordTable<BaysReminder>
            label="Scheduled reminders"
            rowKey={(r) => r.reminder_id}
            rows={paged.rows}
            columns={[
              { key: 'when', header: 'posts', className: 'tabular text-dim', cell: (r) => r.when },
              { key: 'state', header: 'state', card: 'meta', className: 'card-meta', cell: (r) => <ReminderState r={r} /> },
              { key: 'text', header: 'message', card: 'title', width: '60ch', clip: true, title: (r) => r.text, cell: (r) => r.text },
              { key: 'where', header: 'where', className: 'tabular text-dim', cell: (r) => (r.thread_ts ? `${r.channel_id} (thread)` : r.channel_id) },
              { key: 'by', header: 'asked by', className: 'tabular text-dim', cell: (r) => r.requested_by ?? <span className="text-faint">not named</span> },
              { key: 'id', header: 'id', className: 'tabular text-faint', cell: (r) => r.reminder_id },
            ]}
          />
          <Pagination paged={paged} unit="reminders" />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- page */

export default function Bays() {
  const [tab, setTab] = useState<Tab>('Asks');
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [open, setOpen] = useState<string | null>(null);
  useReplayKey(`${tab}|${month}`);
  const { status, data, error } = useData(getBays, [], { kinds: ['bays-asks'] });
  const current = open && data ? data.asks.find((a) => a.id === open) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Bays"
        subtitle="Every Slack turn, scheduled task run and panel question Bays recorded"
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={{ Asks: data?.summary.asks ? { n: data.summary.asks } : undefined }} />}
      />
      {tab === 'Reminders' ? (
        <Reminders />
      ) : status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : data.meta.rows === 0 ? (
        <div className="px-6 pb-8 md:px-8">
          <EmptyState>Bays has written no row to its ledger. Bays — Agent Delivery writes one after every reply, so an empty ledger means it has stopped writing, not that nobody asked.</EmptyState>
        </div>
      ) : tab === 'Asks' ? (
        <Asks data={data} month={month} onMonth={setMonth} onOpen={(a) => setOpen(a.id)} />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <div className="px-6 pb-3 md:px-8">
            <Freshness data={data} />
          </div>
          <RecordStatistics<BaysAsk>
            kind="bays"
            noun="Asks"
            month={month}
            onMonth={setMonth}
            rows={data.asks}
            dateOf={(a) => a.asked_at}
            extraTiles={<BaysTiles data={data} />}
            columns={[
              { header: 'ask_id', value: (a) => a.ask_id },
              { header: 'asked_at', value: (a) => a.asked_at },
              { header: 'source', value: (a) => a.source },
              { header: 'asked_by_system', value: (a) => a.asked_by_system },
              { header: 'asked_by_person', value: (a) => a.asked_by_person },
              { header: 'task_name', value: (a) => a.task_name },
              { header: 'task_outcome', value: (a) => a.task_outcome },
              { header: 'outcome', value: (a) => a.outcome },
              { header: 'tool_issues', value: (a) => a.tool_issues },
              { header: 'delivered', value: (a) => a.delivered },
              { header: 'delivered_as', value: (a) => a.delivered_as },
              { header: 'delivery_target', value: (a) => a.delivery_target },
              { header: 'slack_link', value: (a) => a.slack_link },
              { header: 'response_seconds', value: (a) => a.response_seconds },
              { header: 'lane', value: (a) => a.lane },
              { header: 'run_id', value: (a) => a.run_id },
              { header: 'question', value: (a) => a.question },
              { header: 'answer', value: (a) => a.answer },
              { header: 'error', value: (a) => a.error },
            ]}
          />
        </div>
      )}

      {current && <AskView a={current} cap={data?.meta.answer_cap ?? 6000} onClose={() => setOpen(null)} />}
    </div>
  );
}
