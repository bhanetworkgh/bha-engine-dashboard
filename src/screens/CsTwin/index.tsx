import { useState } from 'react';
import { useData } from '../../app/useData';
import { getCsTwin, type CstCohort, type CstData, type CstTurn } from '../../data';
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
 * Customer Service Twin (2026-09-29, Destiny). A placeholder from 22 Sep until
 * then: nothing CST did reached this dashboard. Now CST posts two events per
 * customer turn to `POST /api/engine/cst-events` — the turn itself (the message
 * in, CST's reply, the intent and the status CST already computes) and, from
 * its outbound queue and Twilio's callback, what became of the reply — and this
 * page reads them the moment they land.
 *
 * **Shaped like Genie and the twins**: Turns, the working surface, and
 * Statistics. One row per turn; the delivery sits on the same row.
 *
 * **The whole record is kept** (Destiny's call): the message, the reply and the
 * customer's number. The list shows the number cut to its last four digits and
 * the row opens to the full record — the page is read on a second screen all
 * day, and a column of full numbers is more than a glance needs.
 *
 * **Delivered is the one coloured figure**, as on North Star: a reply CST wrote
 * that never reached the customer is the failure that looks like success from
 * inside CST. Refused, unknown caller and escalated stay neutral — each is a
 * guard or a hand-off doing its job.
 */

const TABS = ['Turns', 'Statistics'] as const;
type Tab = (typeof TABS)[number];

const OUTCOME_ORDER = ['Answered', 'Escalated', 'Refused', 'Needs verification', 'Unknown caller', 'Failed'];
const OUTCOME_COLOUR = (o: string) =>
  o === 'Answered' ? 'var(--accent)' : o === 'Failed' ? 'var(--failing)' : o === 'Escalated' ? 'var(--ink)' : 'var(--dim)';

function OutcomePill({ outcome }: { outcome: string }) {
  if (outcome === 'Failed') return <Pill tone="failing">failed</Pill>;
  return <Pill>{outcome.toLowerCase()}</Pill>;
}

function DeliveryCell({ t }: { t: CstTurn }) {
  if (!t.delivery_status) return <span className="text-faint">{t.channel === 'sms' ? 'waiting' : '—'}</span>;
  if (t.delivery_status === 'failed' || t.delivery_status === 'undelivered') return <Pill tone="failing">{t.delivery_status}</Pill>;
  return <span className="text-dim">{t.delivery_status}</span>;
}

const seconds = (ms: number | null) => (ms === null ? '—' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const lastFour = (p: string | null) => (p ? `…${p.slice(-4)}` : null);
const who = (t: CstTurn) => t.customer_name ?? lastFour(t.phone_e164) ?? t.customer_ref ?? '—';

export default function CsTwin() {
  const [tab, setTab] = useState<Tab>('Turns');
  useReplayKey(tab);
  const { status, data, error } = useData(getCsTwin, [], { kinds: ['cst_turns'] });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Customer Service Twin"
        subtitle="Every customer text, call and web message, and what CST did with it"
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={{ Turns: data?.summary.turns ? { n: data.summary.turns } : undefined }} />}
      />
      {status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : data.meta.rows === 0 ? (
        <div className="px-6 pb-8 md:px-8">
          <EmptyState>
            No Customer Service Twin event has arrived yet. CST posts each customer turn, and what became of its reply, to{' '}
            <code>/api/engine/cst-events</code> once Ahad wires it (the contract is docs/contracts/cst-events.md in this repo). The first one appears
            here the moment it lands — there is nothing to press.
          </EmptyState>
        </div>
      ) : tab === 'Turns' ? (
        <Turns data={data} />
      ) : (
        <Statistics data={data} />
      )}
    </div>
  );
}

function Freshness({ data }: { data: CstData }) {
  return (
    <p className="text-[12px] text-dim">
      {data.summary.turns} turn{data.summary.turns === 1 ? '' : 's'} held since {when(data.meta.first_at)} UTC · last received{' '}
      {relativeTime(data.meta.last_received_at) ?? '—'}
      {data.meta.deliveries_without_turn
        ? ` · ${data.meta.deliveries_without_turn} delivery update(s) whose turn has not arrived, shown as "turn not received" and left out of every figure`
        : ''}
    </p>
  );
}

function Turns({ data }: { data: CstData }) {
  const s = data.summary;
  const [open, setOpen] = useState<string | null>(null);
  const paged = usePaged(data.turns, 'all');
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Freshness data={data} />
      <StatStrip cols={5} flush>
        <FigureCell
          label="Turns"
          value={s.turns}
          caption={`${s.conversations} conversation${s.conversations === 1 ? '' : 's'} · ${s.customers} customer${s.customers === 1 ? '' : 's'}`}
          note={`${s.last_7_days} in the last 7 days. One turn is one message in and CST's reply to it.`}
        />
        <PercentCell label="Answered" share={s.answered} caption="CST answered it itself" />
        <PercentCell label="Sent to a person" share={s.escalated} caption="escalated, with an incident filed" />
        <PercentCell label="Delivered" share={s.delivered} bad={() => s.lost.n > 0} caption={s.lost.n ? `${s.lost.n} never reached the customer` : 'reply reached the customer'} />
        <PercentileCell label="Time to reply" p={s.duration} unit="s" caption={`over ${s.duration.n} of ${s.duration.of} turns that sent it`} />
      </StatStrip>
      <Card className="pb-3">
        <CardHeader title="Turns" right={<span className="tabular text-[11.5px] text-faint">newest first · click a row for the whole record</span>} />
        <TableFrame flat grow={false} label="Customer Service Twin turns">
          <thead>
            <tr>
              <Th>when (UTC)</Th>
              <Th>customer</Th>
              <Th>via</Th>
              <Th>message</Th>
              <Th>intent</Th>
              <Th>outcome</Th>
              <Th>time</Th>
              <Th>delivery</Th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((t) => (
              <TurnRow key={t.turn_id} t={t} open={open === t.turn_id} onToggle={() => setOpen(open === t.turn_id ? null : t.turn_id)} />
            ))}
          </tbody>
        </TableFrame>
      </Card>
      <Pagination paged={paged} unit="turns" />
    </div>
  );
}

function TurnRow({ t, open, onToggle }: { t: CstTurn; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td className="td tabular whitespace-nowrap text-faint">{when(t.occurred_at ?? t.received_at)}</td>
        <td className="td tabular text-dim">{who(t)}</td>
        <td className="td text-dim">{t.channel ?? '—'}</td>
        <td className="td td-clip" style={{ maxWidth: '44ch' }} title={t.message ?? undefined}>
          {t.message ?? <span className="text-faint">{t.retention_cleared_at ? 'cleared after 180 days' : t.status === null ? 'turn not received' : 'not sent'}</span>}
        </td>
        <td className="td text-dim">{t.intent ?? '—'}</td>
        <td className="td">
          <OutcomePill outcome={t.outcome} />
        </td>
        <td className="td tabular whitespace-nowrap text-dim">{seconds(t.duration_ms)}</td>
        <td className="td">
          <DeliveryCell t={t} />
        </td>
      </tr>
      {open && (
        <tr>
          <td className="td" colSpan={8}>
            <div className="space-y-2 py-1 text-[12.5px]">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
                <span>{t.phone_e164 ?? (t.retention_cleared_at ? `number cleared ${when(t.retention_cleared_at)} UTC` : 'no number sent')}</span>
                {t.customer_ref && <span>customer {t.customer_ref}</span>}
                {t.role && <span>role {t.role}</span>}
                <span>{t.is_known === false ? 'not known to vFarm' : t.is_known ? 'known to vFarm' : 'known: not sent'}</span>
                {t.project_id && <span>project {t.project_id}</span>}
                <span>
                  turn <RecordId>{t.turn_id}</RecordId>
                </span>
                {t.conversation_id && (
                  <span>
                    conversation <RecordId>{t.conversation_id}</RecordId>
                  </span>
                )}
                {t.incident_id && (
                  <span>
                    incident <RecordId>{t.incident_id}</RecordId>
                  </span>
                )}
                <span>received {when(t.received_at)} UTC</span>
              </div>
              <div>
                <div className="text-[11px] text-faint">Customer</div>
                <p className="whitespace-pre-wrap text-ink">{t.message ?? '—'}</p>
              </div>
              <div>
                <div className="text-[11px] text-faint">CST replied</div>
                <p className="whitespace-pre-wrap text-ink">{t.reply ?? '—'}</p>
              </div>
              {t.reason && <p className="whitespace-pre-wrap text-dim">Why: {t.reason}</p>}
              {t.delivery_status && (
                <p className="text-dim">
                  Delivery: {t.delivery_status}
                  {t.delivery_attempts !== null ? ` after ${t.delivery_attempts} attempt${t.delivery_attempts === 1 ? '' : 's'}` : ''}
                  {t.delivery_at ? `, ${when(t.delivery_at)} UTC` : ''}
                  {t.delivery_error ? ` — ${t.delivery_error}` : ''}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Cohorts({ rows, blank }: { rows: CstCohort[]; blank: string }) {
  if (rows.length === 0) return <p className="text-[12px] text-faint">{blank}</p>;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[10.5px] text-faint">
        <span />
        <span className="text-right">turns</span>
        <span className="text-right">answered</span>
        <span className="text-right">not delivered</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[12.5px]">
          <span className="truncate text-ink">{r.label}</span>
          <span className="tabular text-right text-dim">{r.turns}</span>
          <span className="tabular text-right text-dim" title={`${r.answered} of ${r.turns}`}>
            {pct(r.answered, r.turns)}
          </span>
          <span className={`tabular text-right ${r.lost ? 'text-failing' : 'text-dim'}`} title={`${r.lost} of ${r.with_delivery} with a delivery status`}>
            {r.with_delivery ? `${r.lost} of ${r.with_delivery}` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function Statistics({ data }: { data: CstData }) {
  const s = data.summary;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Freshness data={data} />
      <StatStrip cols={4} flush>
        <PercentCell label="Refused or held for verification" share={s.refused} caption="a guard doing its job" />
        <PercentCell label="Unknown caller" share={s.unknown} caption="onboarding reply, no farm data" />
        <PercentCell label="Failed" share={s.failed} bad={(x) => x.n > 0} caption="CST errored before replying" />
        <PercentCell label="Not delivered" share={s.lost} bad={(x) => x.n > 0} caption="Twilio: failed or undelivered" />
      </StatStrip>
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard title="Outcome by week" note="The last eight weeks, one column a week. A week with no turn draws nothing: it was not recorded, not quiet." align="top">
          <OutcomeColumns weeks={s.outcome_per_week} order={OUTCOME_ORDER} colour={OUTCOME_COLOUR} />
          <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-dim">
            {s.outcome_mix.map((o) => (
              <span key={o.key}>
                {o.label} {o.n}
              </span>
            ))}
          </div>
        </MetricCard>
        <MetricCard title="By what the customer wanted" note="CST's own intent router: status, knowledge, images, escalate, default. Each with its own rates." align="top">
          <Cohorts rows={s.by_intent} blank="No turn carries an intent." />
        </MetricCard>
        <MetricCard title="By channel" note="SMS, voice or web. Only SMS replies get a Twilio delivery status, so voice and web show a dash there." align="top">
          <Cohorts rows={s.by_channel} blank="No turn carries a channel." />
        </MetricCard>
        <MetricCard title="By project" note="The vFarm project the receiving number is bound to, as CST sends it." align="top">
          <Cohorts rows={s.by_project} blank="No turn carries a project." />
        </MetricCard>
      </div>
    </div>
  );
}
