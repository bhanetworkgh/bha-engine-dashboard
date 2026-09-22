import { useCallback, useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import { getPay, getPayMetrics, resyncPay, type PayData } from '../../data';
import { LoadFailed, Loading, MonthPicker, monthLabel, monthsFrom, PageHeader, ResyncButton, RowsLine, Tabs, thisMonth, Toast, useResync, useToast } from '../../components/ui';
import Owed from './Owed';
import Statements from './Statements';
import Sessions from './Sessions';
import Statistics from './Statistics';

/**
 * Pay Tracker — built 2026-09-17, against a ledger created the same day.
 *
 * One question: **who is owed money, for what work, and what has already been
 * paid?** Before this, pay was a tick on a Slack card, which meant answering
 * "what do I owe Hardik for September" was a scroll back through weeks of
 * messages.
 *
 * Four things hold across every tab, and they are what the page is for:
 *
 * **It counts work, not money.** There are no rates in this system and none
 * appear here. If a rate is ever added it belongs in the Builders table first;
 * until then, any figure with a currency sign on it would be invented.
 *
 * **It is read-only.** Paid status is set by the Slack card or by a monthly
 * statement closing. Two places to change the same fact is how records drift,
 * so there is no write path from this page and no button that would make one.
 *
 * **Monthly and daily are never summed into one rate.** They are different
 * agreements — a monthly builder is expected to wait until the 1st — so a
 * blended figure describes nobody.
 *
 * **Nothing owed and the sync not having run look identical**, and on a pay
 * page that is the difference between a quiet month and an unpaid builder. The
 * ledger's own age is on the Owed tab and in the line under the header, and
 * every empty state says which of the two it is.
 */
const TABS = ['Owed', 'Statements', 'Sessions', 'Statistics'] as const;
type Tab = (typeof TABS)[number];

export default function PayTracker() {
  const [tab, setTab] = useState<Tab>('Owed');
  const [tick, setTick] = useState(0);
  const [held, setHeld] = useState<PayData | null>(null);
  /**
   * One month for the whole page (2026-09-22, Destiny's brief): Owed,
   * Statements, Sessions and Statistics all answer for the same month, so a
   * figure on one tab cannot be about a different period from its neighbour.
   * It opens on the current month like every record page; `null` is every
   * month. What is outstanding in *other* months is never scoped away — the
   * Owed tab names it — because on the 1st the month just ended is the one
   * being paid.
   */
  const [month, setMonth] = useState<string | null>(thisMonth());
  const { toast, setToast } = useToast();
  const { status, data: loaded, error } = useData(getPay, []);
  const metrics = useData(() => getPayMetrics(month), [tick, month]);

  const all = held ?? loaded;
  const months = useMemo(
    () => (all ? monthsFrom([...all.sessions.map((s) => s.month), ...all.statements.map((s) => s.month)].map((m) => (m ? `${m}-01` : null))) : [thisMonth()]),
    [all],
  );
  /** The rows the tabs list, cut to the month by each row's own Month. */
  const data = useMemo(
    () =>
      all && month
        ? { ...all, sessions: all.sessions.filter((s) => s.month === month), statements: all.statements.filter((s) => s.month === month) }
        : all,
    [all, month],
  );

  const reload = useCallback(async () => {
    setTick((n) => n + 1);
    setHeld(await getPay());
  }, []);

  const resync = useResync({ run: resyncPay, reload, setToast });

  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data || !all) return <Loading />;

  // Owed is an explicit Paid = false; a row with no Paid is not known either way.
  const unpaid = data.sessions.filter((s) => s.paid === false).length;
  const openStatements = data.statements.filter((s) => s.open).length;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Pay Tracker"
        subtitle="Who is owed, for what work, and what has already been paid"
        right={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <MonthPicker months={months} value={month} onChange={setMonth} />
            <ResyncButton busy={resync.busy} onClick={resync.start} />
          </div>
        }
        below={
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            /*
              Counts only where a number above nought is something to act on.
              Sessions and Statistics carry none: a count on every tab is
              decoration, and decoration that looks like a warning is worse.
            */
            counts={{
              Owed: unpaid ? { n: unpaid, tone: 'degraded' } : undefined,
              Statements: openStatements ? { n: openStatements } : undefined,
            }}
          />
        }
      />

      {/*
        The row count and the ledger's age, in the same line every other page
        uses. On this page it is load-bearing rather than polish: an empty Owed
        tab means either nothing is owed or nobody has read the ledger, and this
        is what tells them apart.
      */}
      <div className="shrink-0 px-6 pb-3 md:px-8">
        <RowsLine freshness={tab === 'Statements' ? data.statements_freshness : data.freshness} />
        <div className="mt-1 text-[12px] text-dim">
          {/* Which month every figure below is for, said once in words. */}
          Showing {month ? monthLabel(month) : 'every month'}
          {month ? ` · ${data.sessions.length} of ${all.sessions.length} sessions held` : ` · ${all.sessions.length} sessions held`}
        </div>
      </div>

      {metrics.error ? (
        <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {metrics.error}</div>
      ) : !metrics.data ? (
        <Loading />
      ) : tab === 'Owed' ? (
        <Owed data={data} m={metrics.data} held={all.sessions.length} showAll={() => setMonth(null)} />
      ) : tab === 'Statements' ? (
        <Statements data={data} m={metrics.data} />
      ) : tab === 'Sessions' ? (
        <Sessions data={data} />
      ) : (
        <Statistics m={metrics.data} />
      )}

      <Toast toast={toast} />
    </div>
  );
}
