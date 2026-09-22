import type { PayMetrics } from '../../data';
import { CountUp, DistTile, HBar, MetricCard, OutcomeColumns, TileFigure } from '../../components/ui';

/**
 * The shape of the pay ledger over time.
 *
 * Two rules do most of the work here. **Monthly and daily are never averaged
 * together** — time to pay is two figures, never one, because a daily session
 * is answered within days and a monthly one waits for the 1st by agreement, so
 * a blended number would describe nobody. And **working days and session count
 * are both shown**, because they are different numbers and the whole point of
 * the working-days card is that it is not a session count.
 */

const MODE_COLOUR = (mode: string) => (mode === 'Monthly' ? 'var(--accent)' : mode === 'Daily' ? 'var(--ok)' : 'var(--dim)');
const PAID_COLOUR = (k: string) => (k === 'paid' ? 'var(--accent)' : k === 'unpaid' ? 'var(--degraded)' : 'var(--dim)');

export default function Statistics({ m }: { m: PayMetrics }) {
  const monthKeys = m.per_month[0] ? Object.keys(m.per_month[0].counts) : [];
  const paidTotal = m.paid_by.reduce((n, s) => n + s.n, 0);
  const topPayer = [...m.paid_by].sort((a, b) => b.n - a.n)[0];
  const over60 = m.ageing.find((a) => a.key.startsWith('over'))?.n ?? 0;
  const agedTotal = m.ageing.reduce((n, a) => n + a.n, 0);
  const maxDays = Math.max(1, ...m.working_days.map((w) => w.total_days));

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Sessions per month" right="Month" note={m.per_month_note}>
          <OutcomeColumns weeks={m.per_month.map((x) => ({ week: x.month, label: x.label, total: x.total, counts: x.counts }))} order={monthKeys} colour={MODE_COLOUR} />
        </MetricCard>
        <MetricCard title="Paid against unpaid" right="Paid" note={m.paid_week_note}>
          <OutcomeColumns weeks={m.paid_per_week} order={['paid', 'unpaid', 'not recorded']} colour={PAID_COLOUR} />
        </MetricCard>
      </div>

      <div className="grid gap-4 px-6 pb-6 md:grid-cols-2 md:px-8">
        <MetricCard title="Working days per builder" right="Session Date, distinct" note={m.working_days_note} noteMinLines={5} align="top">
          <TileFigure
            value={m.working_days.length || null}
            format={(n) => String(Math.round(n))}
            missing="No session is held, so nobody has a working day recorded."
            sub="builders with an approved session"
            replayKey={`wd|${m.working_days.length}`}
          >
            <div className="space-y-2">
              {m.working_days.slice(0, 8).map((w) => (
                <HBar
                  key={w.builder}
                  label={
                    <span>
                      {w.builder}
                      <span className="ml-1.5 text-[11px] text-faint">{w.pay_mode ?? 'no pay mode on the session'}</span>
                    </span>
                  }
                  value={w.total_days}
                  max={maxDays}
                  tone={w.pay_mode === 'Monthly' ? 'accent' : 'ink'}
                  valueNode={<CountUp value={w.total_days} />}
                  // Both numbers, never one standing in for the other.
                  right={<span className="text-faint">{w.total_sessions} sessions</span>}
                />
              ))}
            </div>
          </TileFigure>
        </MetricCard>

        <DistTile
          title="Who marks things paid"
          field="Paid By"
          note={m.paid_by_note}
          slices={m.paid_by}
          headline={paidTotal && topPayer ? (topPayer.n / paidTotal) * 100 : null}
          missing="No session is marked paid yet, so there is nobody to attribute."
          sub={topPayer ? `${topPayer.n} of ${paidTotal} were marked by ${topPayer.label}` : undefined}
        />

        {/*
          Two figures, never one. A daily session and a monthly one are answered
          on different clocks by different agreements.
        */}
        <MetricCard title="Time to pay" right="Session Date → Paid At" note={m.time_to_pay_note} noteMinLines={5} align="top">
          <TileFigure
            value={null}
            format={() => ''}
            missing=""
            sub="p50, with p95 beside it — split by mode and never blended"
          >
            <div className="space-y-3">
              {m.time_to_pay.map((t) => (
                <div key={t.mode}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] text-ink">{t.mode}</span>
                    <span className="tabular text-[12.5px] text-dim">
                      {t.p.p50 === null ? (
                        <span className="text-faint">not recorded</span>
                      ) : (
                        <>
                          p50 {t.p.p50} d <span className="text-faint">· p95 {t.p.p95 === null ? '—' : `${t.p.p95} d`}</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-faint">{t.p.note}</div>
                </div>
              ))}
            </div>
          </TileFigure>
        </MetricCard>

        <DistTile
          title="Unpaid ageing"
          field="Session Date"
          note={m.ageing_note}
          slices={m.ageing}
          headline={agedTotal ? over60 : null}
          format={(n) => String(Math.round(n))}
          tone={over60 ? 'failing' : undefined}
          missing="Nothing is unpaid, so there is nothing to age."
          sub={`unpaid past 60 days, of ${agedTotal} unpaid sessions`}
          // Only the last bucket. The first two are the agreement working.
          toneOf={(s) => (s.key.startsWith('over') ? 'failing' : s.key.startsWith('31') ? 'degraded' : 'ink')}
        />

        <MetricCard title="Sessions with no roster match" right="Builder Slack ID" note={m.no_roster_match.note} noteMinLines={5} align="top">
          <TileFigure
            value={m.no_roster_match.of ? m.no_roster_match.n : null}
            format={(n) => String(Math.round(n))}
            tone={m.no_roster_match.n ? 'failing' : undefined}
            missing="No session is held, so there is nothing to match against the roster."
            sub={`of ${m.no_roster_match.of} sessions held — this should be nought`}
            replayKey={`orphan|${m.no_roster_match.of}`}
          >
            {m.no_roster_match.sessions.length === 0 ? null : (
              <div className="space-y-1">
                {m.no_roster_match.sessions.map((s) => (
                  <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px]">
                    <span className="truncate text-ink" title={s.codex_entry_id}>
                      {s.builder}
                    </span>
                    <span className="tabular shrink-0 text-faint">{s.builder_slack_id ?? 'no slack id'}</span>
                  </div>
                ))}
              </div>
            )}
          </TileFigure>
        </MetricCard>

        <MetricCard
          title="Statement turnaround"
          right="Sent At → Payment Sent At"
          note={m.statement_time_to_pay.note}
          noteMinLines={5}
          align="top"
        >
          <TileFigure
            value={m.statement_time_to_pay.p50}
            format={(n) => `${Math.round(n * 10) / 10}d`}
            missing="No statement carries both a sent and a paid stamp yet."
            sub={m.statement_time_to_pay.p95 === null ? undefined : `p50, with p95 at ${m.statement_time_to_pay.p95}d — never a mean`}
            replayKey={`stp|${m.statement_time_to_pay.n}`}
          >
            {m.statement_time_to_pay.n === 0 ? null : (
              <HBar
                label="statements timed"
                value={m.statement_time_to_pay.n}
                max={Math.max(1, m.statement_time_to_pay.of)}
                tone="accent"
                valueNode={<CountUp value={m.statement_time_to_pay.n} />}
                right={<span className="text-faint">of {m.statement_time_to_pay.of} held</span>}
              />
            )}
          </TileFigure>
        </MetricCard>
      </div>
    </div>
  );
}
