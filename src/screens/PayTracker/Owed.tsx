import { useState } from 'react';
import type { OwedBuilder, PayData, PayMetrics } from '../../data';
import { CodexEntryDialog } from '../CodexEntryDialog';
import { getPaySessionCodex } from '../../data';
import { CountUp, EmptyPanel, FigureCell, LiveIndicator, monthLabel, Pill, StatCaption, StatCell, StatLabel, StatStrip, relativeTime } from '../../components/ui';

/**
 * The question the page exists for: who is owed, for what, and how long.
 *
 * **One row per builder, not per session.** This is the view Jason wants on
 * payday — a list of sessions is the evidence behind that answer, not the
 * answer — so the sessions are behind a click on the row.
 *
 * **Monthly and daily are separate tables**, not two colours in one. They are
 * answered on different days by different agreements, so a combined total is a
 * number nobody acts on: a monthly builder with nine sessions owed on the 20th
 * is the agreement working, and a daily builder with one is not.
 */

const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/** Colour only past a full cycle. A monthly builder waiting for the 1st is not late. */
function ageTone(days: number | null): string {
  if (days === null) return 'text-faint';
  if (days > 60) return 'text-failing';
  if (days > 30) return 'text-degraded';
  return 'text-dim';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `data` arrives cut to the page's month; `held` is every session held, which
 * is what tells "the ledger is unread" from "nothing counts toward this month".
 */
export default function Owed({ data, m, held, showAll }: { data: PayData; m: PayMetrics; held: number; showAll: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const period = m.selected ? monthLabel(m.selected) : 'any month';
  const outside = m.outside.sessions_owed + m.outside.sessions_unconfirmed;
  /** Why a mode group has nobody in it, in the order that decides it. */
  const emptyFor = (word: string) =>
    held === 0
      ? 'No session is held at all — which on this page most likely means nothing has posted the ledger here yet, not that nothing is owed. Sessions arrive through POST /api/engine/pay.'
      : data.sessions.length === 0
        ? `No session counts toward ${period}, so nobody can be owed for it.`
        : `Every ${word} builder is paid up for ${period}.`;
  const monthly = m.owed.filter((o) => o.pay_mode === 'Monthly');
  const daily = m.owed.filter((o) => o.pay_mode === 'Daily');
  const other = m.owed.filter((o) => o.pay_mode !== 'Monthly' && o.pay_mode !== 'Daily');
  const lastSynced = relativeTime(data.synced.at);

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      {/*
        One caption line per figure (2026-09-22, rule (a)); the full notes are
        behind each label's mark. Owed is an explicit Paid = false, and a
        session with no Paid at all has its own figure rather than being added
        to owed.
      */}
      <StatStrip cols={6}>
        <FigureCell
          label="Sessions owed"
          value={m.sessions_owed.n}
          tone={m.sessions_owed.n ? 'degraded' : undefined}
          caption={`${m.sessions_owed.monthly} monthly · ${m.sessions_owed.daily} daily${m.sessions_owed.no_mode ? ` · ${m.sessions_owed.no_mode} no mode` : ''}`}
          note={m.sessions_owed.note}
        />
        <FigureCell
          label="Paid not recorded"
          value={m.sessions_unconfirmed.n}
          caption={m.sessions_unconfirmed.n ? `${m.sessions_unconfirmed.monthly} monthly · ${m.sessions_unconfirmed.daily} daily · not counted as owed` : 'every session carries a Paid value'}
          note={m.sessions_unconfirmed.note}
        />
        <FigureCell
          label="Builders owed"
          value={m.builders_owed.n}
          caption={`${m.builders_owed.monthly} monthly · ${m.builders_owed.daily} daily`}
          note={m.builders_owed.note}
        />
        <FigureCell
          label="Oldest unpaid"
          value={m.oldest_unpaid.days}
          unit="d"
          missing="nothing unpaid"
          tone={(m.oldest_unpaid.days ?? 0) > 30 ? 'degraded' : undefined}
          caption={m.oldest_unpaid.builder ? `${m.oldest_unpaid.builder} · ${m.oldest_unpaid.pay_mode ?? 'no pay mode'}` : 'no session is explicitly unpaid'}
          note={m.oldest_unpaid.note}
        />
        <FigureCell
          label={m.selected ? `Sessions in ${monthLabel(m.selected)}` : 'Sessions, all months'}
          value={m.this_month.n}
          caption={`${m.this_month.monthly} monthly · ${m.this_month.daily} daily, paid or not`}
          note={m.this_month.note}
        />
        {/*
          The freshness cell, and the reason this page has one at all: nothing
          owed and nothing ever written look identical, and on a pay page that
          is the difference between a quiet month and an unpaid builder. The
          ledger is written with the session log now (2026-09-23), so what is
          worth saying is whether this page is live, and when the ledger last
          changed.
        */}
        <StatCell>
          <div className="min-w-0">
            <StatLabel label="Ledger" detail={data.synced.note} />
            <div className="mt-1 text-[15px] leading-tight">
              <LiveIndicator />
            </div>
            <StatCaption>{data.synced.at ? `last written ${lastSynced ?? data.synced.at.slice(0, 16).replace('T', ' ') + ' UTC'}` : 'nothing has written it yet'}</StatCaption>
          </div>
        </StatCell>
      </StatStrip>

      <div className="space-y-4 px-6 pb-6 md:px-8">
        {/*
          What the list is, said once (2026-09-22, Destiny's brief): the people
          with something outstanding, not the roster. A builder whose only
          outstanding thing is an unrecorded payment is listed, and reads as
          exactly that rather than as a debt.
        */}
        <p className="text-[12px] leading-snug text-dim">
          Builders with something outstanding for {period}: a session owed, or a payment that was never recorded. This is not the roster — a builder with
          nothing outstanding is not listed.
        </p>
        {/*
          Never scoped away. On the 1st the month just ended is the one being
          paid, and a picker left on the new month would otherwise hide it.
        */}
        {m.selected && outside > 0 && (
          <div className="card flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[12.5px]">
            <span className="text-dim">
              Outside {period}:{' '}
              {[
                m.outside.sessions_owed ? `${plural(m.outside.sessions_owed, 'session')} owed` : null,
                m.outside.sessions_unconfirmed ? `${plural(m.outside.sessions_unconfirmed, 'payment')} not recorded` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              {m.outside.months.length ? ` in ${m.outside.months.map(monthLabel).join(', ')}` : ''} — not in the figures above.
            </span>
            <button type="button" className="link text-[12px]" onClick={showAll}>
              Show every month
            </button>
          </div>
        )}
        <Group
          title="Monthly builders"
          sub="One statement on the 1st. Waiting is the agreement, not a delay — these only read as late past a full cycle."
          word="monthly"
          period={period}
          rows={monthly}
          open={open}
          setOpen={setOpen}
          empty={emptyFor('monthly')}
        />
        <Group
          title="Daily builders"
          sub="A card per session, answered as they go. An unpaid daily session ages against nothing but somebody forgetting."
          word="daily"
          period={period}
          rows={daily}
          open={open}
          setOpen={setOpen}
          empty={held === 0 ? null : emptyFor('daily')}
        />
        {/*
          A session whose pay mode was never written. Shown rather than filed
          under one of the two, because guessing which agreement somebody is on
          is exactly the guess this page must not make.
        */}
        {other.length > 0 && (
          <Group
            title="No pay mode on the session"
            sub="The pay mode is frozen onto a session when it is approved. These rows carry none, so there is no way to tell which agreement they fall under — and this page will not guess."
            word="unmoded"
            period={period}
            rows={other}
            open={open}
            setOpen={setOpen}
            empty={null}
          />
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  sub,
  word,
  period,
  rows,
  open,
  setOpen,
  empty,
}: {
  title: string;
  sub: string;
  word: string;
  period: string;
  rows: OwedBuilder[];
  open: string | null;
  setOpen: (v: string | null) => void;
  empty: string | null;
}) {
  /** The pay session whose Codex entry is open, by its Codex Entry ID. */
  const [codexFor, setCodexFor] = useState<string | null>(null);
  if (rows.length === 0 && empty === null) return null;
  const total = rows.reduce((n, r) => n + r.sessions_owed, 0);
  const unknown = rows.reduce((n, r) => n + r.sessions_unconfirmed, 0);
  const days = rows.reduce((n, r) => n + r.working_days_owed, 0);
  return (
    <div className="card px-5 py-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-ink">{title}</h2>
        {rows.length > 0 && total > 0 && (
          <span className="tabular text-[11.5px] text-faint">
            {/* Both numbers, never one standing for the other. */}
            {plural(total, 'session')} owed · {plural(days, 'working day')}
            {unknown ? ` · ${plural(unknown, 'payment')} not recorded` : ''} · {plural(rows.filter((r) => r.sessions_owed > 0).length, 'builder')} owed
          </span>
        )}
      </div>
      <p className="mb-3 text-[11.5px] leading-snug text-faint">{sub}</p>
      {/*
        Nobody owed, but somebody listed: every row here is an unrecorded
        payment, which is not a debt. Said first so the rows under it cannot be
        read as one.
      */}
      {rows.length > 0 && total === 0 && (
        <p className="mb-2 text-[12.5px] text-ink">
          Every {word} builder is paid up for {period}.{' '}
          <span className="text-dim">
            {plural(unknown, 'payment')} {unknown === 1 ? 'was' : 'were'} never recorded as paid or unpaid, listed below — not owed.
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyPanel min={64}>{empty}</EmptyPanel>
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-line">
          <div className="grid grid-cols-[minmax(0,2fr)_auto_auto_auto_auto_minmax(0,1fr)] items-baseline gap-x-4 border-b border-line bg-raised px-3 py-1.5 text-[10.5px] text-faint">
            <span>builder</span>
            <span className="text-right">sessions</span>
            <span className="text-right">working days</span>
            <span className="text-right">oldest</span>
            <span className="text-right">days</span>
            <span>months</span>
          </div>
          {rows.map((r) => {
            const isOpen = open === (r.slack_user_id ?? r.builder);
            const key = r.slack_user_id ?? r.builder;
            return (
              <div key={key} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : key)}
                  aria-expanded={isOpen}
                  className="rowlike grid w-full grid-cols-[minmax(0,2fr)_auto_auto_auto_auto_minmax(0,1fr)] items-baseline gap-x-4 px-3 py-2 text-left text-[12.5px]"
                >
                  <span className="min-w-0 truncate text-ink">
                    {r.builder}
                    {/* Surfaced, never dropped: somebody is building and the pay system does not know who. */}
                    {!r.on_roster && (
                      <span className="ml-2 text-[11px] text-degraded" title="This session's Slack id matches nobody in the Builders table">
                        not on the roster
                      </span>
                    )}
                    {r.on_roster && !r.active && <span className="ml-2 text-[11px] text-faint">inactive</span>}
                    {/*
                      A row with nothing owed and an unrecorded payment reads as
                      exactly that (2026-09-22, Destiny's brief) — never as a
                      debt of nought beside a number that looks like one.
                    */}
                    {r.sessions_unconfirmed > 0 && (
                      <span className="ml-2 text-[11px] text-faint" title="Sessions whose row carries no Paid value — not known either way, so not counted in this builder's owed figure">
                        {r.sessions_owed === 0 ? 'nothing owed · ' : ''}
                        {plural(r.sessions_unconfirmed, 'payment')} not recorded
                      </span>
                    )}
                    {r.mode_mismatch > 0 && (
                      <span className="ml-2 text-[11px] text-degraded" title={`Listed under the roster's pay mode (${r.pay_mode}). ${r.mode_mismatch} of these sessions carry a different mode, frozen on them when they were approved.`}>
                        {r.mode_mismatch} on another mode
                      </span>
                    )}
                    {/*
                      Rows are grouped on the Slack id where there is one, so a
                      session carrying none cannot be matched to one that does
                      and lands here on its own. Without this the same name on
                      two rows reads as a duplicate.
                    */}
                    {!r.has_slack_id && (
                      <span className="ml-2 text-[11px] text-faint" title="These sessions carry no Builder Slack ID, so they cannot be matched to the rows that do">
                        no Slack id
                      </span>
                    )}
                  </span>
                  <span className={`tabular text-right ${r.sessions_owed ? 'text-ink' : 'text-faint'}`}>{r.sessions_owed || '—'}</span>
                  <span className="tabular text-right text-dim">{r.sessions_owed ? r.working_days_owed : '—'}</span>
                  <span className="tabular text-right text-faint">{when(r.oldest_unpaid)}</span>
                  <span className={`tabular text-right ${ageTone(r.oldest_unpaid_days)}`}>{r.oldest_unpaid_days === null ? '—' : `${r.oldest_unpaid_days} d`}</span>
                  <span className="min-w-0 truncate text-faint" title={r.months.join(', ')}>
                    {r.months.join(', ') || 'no month'}
                  </span>
                </button>

                {isOpen && (
                  <div className="bg-raised px-3 py-2">
                    <div className="mb-1 text-[10.5px] text-faint">the sessions behind that figure</div>
                    <div className="space-y-1">
                      {r.sessions.map((s) => (
                        <div key={s.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[12px]">
                          <span className="tabular text-faint">{when(s.session_date)}</span>
                          <span className="tabular truncate text-dim" title={s.codex_entry_id}>
                            {s.codex_entry_id}
                            {s.paid === null && <span className="ml-2 text-faint">· paid not recorded</span>}
                          </span>
                          <span className="flex items-center gap-2">
                            {s.codex_entry_id && (
                              <button
                                type="button"
                                className="link text-[11.5px]"
                                title="Opens this session's Codex entry here. The recording is linked inside it."
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCodexFor(s.codex_entry_id);
                                }}
                              >
                                Open
                              </button>
                            )}
                            {s.slack_card_link && (
                              <a href={s.slack_card_link} target="_blank" rel="noreferrer" className="link text-[11.5px]" onClick={(e) => e.stopPropagation()}>
                                Slack card
                              </a>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* Read-only: Pay Tracker has no write path, so no Approve, Send back or Delete here. */}
      {codexFor && <CodexEntryDialog id={codexFor} load={getPaySessionCodex} readOnly onClose={() => setCodexFor(null)} />}
    </div>
  );
}

/** Kept for the tabs that show a count beside a figure. */
export function OwedCount({ n }: { n: number }) {
  return (
    <span className="tabular">
      <CountUp value={n} />
    </span>
  );
}

export { Pill };
