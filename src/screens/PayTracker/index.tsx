import { useCallback, useState } from 'react';
import { useData } from '../../app/useData';
import { getPay, getPayMetrics, resyncPay, type PayData } from '../../data';
import { LoadFailed, Loading, PageHeader, ResyncButton, RowsLine, Tabs, Toast, useResync, useToast } from '../../components/ui';
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
  const { toast, setToast } = useToast();
  const { status, data: loaded, error } = useData(getPay, []);
  const metrics = useData(getPayMetrics, [tick]);

  const data = held ?? loaded;

  const reload = useCallback(async () => {
    setTick((n) => n + 1);
    setHeld(await getPay());
  }, []);

  const resync = useResync({ run: resyncPay, reload, setToast });

  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  // Owed is an explicit Paid = false; a row with no Paid is not known either way.
  const unpaid = data.sessions.filter((s) => s.paid === false).length;
  const openStatements = data.statements.filter((s) => s.open).length;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Pay Tracker"
        subtitle="Who is owed, for what work, and what has already been paid"
        right={<ResyncButton busy={resync.busy} onClick={resync.start} />}
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
      </div>

      {metrics.error ? (
        <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {metrics.error}</div>
      ) : !metrics.data ? (
        <Loading />
      ) : tab === 'Owed' ? (
        <Owed data={data} m={metrics.data} />
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
