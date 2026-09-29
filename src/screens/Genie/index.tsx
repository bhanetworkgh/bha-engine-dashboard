import { useState } from 'react';
import { useData } from '../../app/useData';
import { getGenie, type GenieAsk, type GenieData } from '../../data';
import {
  Card,
  CardHeader,
  EmptyState,
  FigureCell,
  LoadFailed,
  Loading,
  MetricCard,
  OutcomeColumns,
  PageHeader,
  Pagination,
  PercentCell,
  PercentileCell,
  Pill,
  RecordId,
  StatStrip,
  TableFrame,
  Tabs,
  Th,
  relativeTime,
  usePaged,
  useReplayKey,
} from '../../components/ui';

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
 * **Before the first event, the page says so** and names who wires it; it never
 * draws sample rows. The figures follow the twins' rules: a rate carries its
 * denominator, a duration is p50 and p95 and never a mean, and an ask that did
 * not send `duration_ms` is left out of the timing rather than counted as
 * instant.
 */

const TABS = ['Asks', 'Statistics'] as const;
type Tab = (typeof TABS)[number];

const OUTCOME_ORDER = ['Answered', 'Incomplete', 'Failed'];
const OUTCOME_COLOUR = (o: string) => (o === 'Answered' ? 'var(--accent)' : o === 'Incomplete' ? 'var(--degraded)' : o === 'Failed' ? 'var(--failing)' : 'var(--dim)');

function OutcomePill({ outcome }: { outcome: string }) {
  if (outcome === 'Failed') return <Pill tone="failing">failed</Pill>;
  if (outcome === 'Incomplete') return <Pill tone="degraded">incomplete</Pill>;
  if (outcome === 'Answered') return <Pill>answered</Pill>;
  return <Pill>{outcome.toLowerCase()}</Pill>;
}

const seconds = (ms: number | null) => (ms === null ? '—' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const handoffLabel = (h: string | null) => (h === 'research_twin' ? 'Research Twin' : h === 'north_star' ? 'North Star' : h);

export default function Genie() {
  const [tab, setTab] = useState<Tab>('Asks');
  useReplayKey(tab);
  const { status, data, error } = useData(getGenie, [], { kinds: ['genie_events'] });

  return (
    <div className="flex h-full min-h-0 flex-col">
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
        <Asks data={data} />
      ) : (
        <Statistics data={data} />
      )}
    </div>
  );
}

function Freshness({ data }: { data: GenieData }) {
  return (
    <p className="text-[12px] text-dim">
      {data.meta.events} event{data.meta.events === 1 ? '' : 's'} held since {when(data.meta.first_event_at)} UTC · last received {relativeTime(data.meta.last_received_at) ?? '—'}
      {data.meta.subagent_events ? ` · ${data.meta.subagent_events} coding-subagent event(s), not counted as asks` : ''}
    </p>
  );
}

function Asks({ data }: { data: GenieData }) {
  const s = data.summary;
  const [open, setOpen] = useState<string | null>(null);
  const paged = usePaged(data.asks, 'all');
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Freshness data={data} />
      <StatStrip cols={5}>
        <FigureCell label="Asks" value={s.asks} caption={`${s.last_7_days} in the last 7 days`} note="One per request id: the latest event Genie sent for it." />
        <PercentCell label="Answered" share={s.answered} caption="Genie's own judge accepted the answer" />
        <PercentCell label="Failed" share={s.failed} bad={(x) => x.n > 0} caption="ended in genie.*.failed or status error" />
        <PercentCell label="Handed to a twin" share={s.handed_off} caption="sent on to Research Twin or North Star" />
        <PercentileCell label="Time to answer" p={s.duration} unit="s" caption={`over ${s.duration.n} of ${s.duration.of} asks that sent it`} />
      </StatStrip>
      <Card className="pb-3">
        <CardHeader title="Asks" right={<span className="tabular text-[11.5px] text-faint">newest first · click a row for the answer</span>} />
        <TableFrame flat grow={false} label="Genie asks">
          <thead>
            <tr>
              <Th>when (UTC)</Th>
              <Th>question</Th>
              <Th>asked by</Th>
              <Th>lane</Th>
              <Th>from</Th>
              <Th>outcome</Th>
              <Th>time</Th>
              <Th>handed to</Th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((a) => (
              <AskRow key={a.event_id} a={a} open={open === a.event_id} onToggle={() => setOpen(open === a.event_id ? null : a.event_id)} />
            ))}
          </tbody>
        </TableFrame>
      </Card>
      <Pagination paged={paged} unit="asks" />
    </div>
  );
}

function AskRow({ a, open, onToggle }: { a: GenieAsk; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td className="td tabular whitespace-nowrap text-faint">{when(a.occurred_at)}</td>
        <td className="td td-clip" style={{ maxWidth: '44ch' }} title={a.question ?? undefined}>
          {a.question ?? <span className="text-faint">not sent</span>}
        </td>
        <td className="td tabular text-dim">{a.builder_id ?? '—'}</td>
        <td className="td text-dim">{a.lane ?? '—'}</td>
        <td className="td text-dim">{a.source ?? '—'}</td>
        <td className="td">
          <OutcomePill outcome={a.outcome} />
        </td>
        <td className="td tabular whitespace-nowrap text-dim">{seconds(a.duration_ms)}</td>
        <td className="td text-dim">{handoffLabel(a.handoff) ?? '—'}</td>
      </tr>
      {open && (
        <tr>
          <td className="td" colSpan={8}>
            <div className="space-y-2 py-1 text-[12.5px]">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
                <span>
                  request <RecordId>{a.request_id ?? '—'}</RecordId>
                </span>
                <span>
                  event <RecordId>{a.event_id}</RecordId>
                </span>
                <span>{a.event_type}</span>
                <span>status {a.status ?? 'not sent'}</span>
                <span>received {when(a.received_at)} UTC</span>
              </div>
              {a.answer && <p className="whitespace-pre-wrap text-ink">{a.answer}</p>}
              {a.error && a.outcome !== 'Answered' && <p className="whitespace-pre-wrap text-dim">{a.error}</p>}
              {!a.answer && !a.error && <p className="text-faint">The event carried no answer text.</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

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

function Statistics({ data }: { data: GenieData }) {
  const s = data.summary;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Freshness data={data} />
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title="Outcome by week" note="The last eight weeks, one column a week. A week with no ask draws nothing: it was not recorded, not quiet." align="top">
          <OutcomeColumns weeks={s.outcome_per_week} order={OUTCOME_ORDER} colour={OUTCOME_COLOUR} />
          <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-dim">
            {s.outcome_mix.map((o) => (
              <span key={o.key}>
                {o.label} {o.n}
              </span>
            ))}
          </div>
        </MetricCard>
        <MetricCard title="By lane" note="Genie's lane on the event, or (no lane). Each lane with its own rates, so one lane failing cannot hide inside the total." align="top">
          <Cohorts rows={s.by_lane} blank="No ask carries a lane." />
        </MetricCard>
        <MetricCard title="By where the ask came from" note="The event's source: Slack, the service API, the browser. (not sent) until Genie sends it." align="top">
          <Cohorts rows={s.by_source} blank="No ask carries a source." />
        </MetricCard>
      </div>
    </div>
  );
}
