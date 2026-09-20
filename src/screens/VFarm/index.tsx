import { useCallback, useState } from 'react';
import { useData } from '../../app/useData';
import { getVfarmLeads, type VfarmLead, type VfarmLeadsData } from '../../data';
import { ComingSoon, LoadFailed, Loading, PageHeader, Tabs } from '../../components/ui';
import EarlyAccess from './EarlyAccess';

/**
 * vFarm: a placeholder with a real tab beside it.
 *
 * **Overview is unchanged and still says the page is not wired up** (decision
 * 2026-09-14, Destiny). Nothing on the rack has ever written a row here, so the
 * live-readings table, the lifecycle timeline and the readiness panel are still
 * gone and the sentence explaining why is still the whole of that tab. The
 * Early Access funnel arriving does not make the rack instrumented, and a tab
 * that quietly started implying it did would be the thing the no-invented-data
 * rule exists to stop.
 *
 * **Early Access is real** (2026-09-20, Destiny). The form on bhanetwork.org
 * posts to this server's one public route and the rows land in
 * `engine_vfarm_leads`; this is where somebody reads and annotates them. It is
 * the first thing on this page that is not a placeholder, which is why it is a
 * second tab rather than a replacement for the first.
 *
 * The leads are held in state here rather than re-fetched on every edit: an
 * inline status change updates the row on screen straight away and puts it back
 * if the server refuses, and re-reading the whole list after each keystroke
 * would make that impossible to feel.
 */
const TABS = ['Overview', 'Early Access'] as const;
type Tab = (typeof TABS)[number];

export default function VFarm() {
  const [tab, setTab] = useState<Tab>('Overview');
  const [held, setHeld] = useState<VfarmLeadsData | null>(null);
  const { status, data: loaded, error } = useData(getVfarmLeads, []);

  const data = held ?? loaded;

  /**
   * Replaces the leads and recomputes the summary from them.
   *
   * The counts have to move with an optimistic edit or the strip would disagree
   * with the table it sits above — which is the reconciliation bug the record
   * pages already learned once. Derived here from the rows on screen rather
   * than kept as a second number.
   */
  const onChange = useCallback(
    (leads: VfarmLead[]) => {
      const by_status: Record<string, number> = { new: 0, contacted: 0, qualified: 0, archived: 0 };
      for (const l of leads) by_status[l.status] = (by_status[l.status] ?? 0) + 1;
      const now = Date.now();
      const since = (days: number) => leads.filter((l) => now - Date.parse(l.created_at) < days * 86_400_000).length;
      setHeld({ leads, summary: { total: leads.length, last_7_days: since(7), last_30_days: since(30), by_status } });
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="vFarm"
        subtitle="The vertical-farm product"
        below={
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            // The lead count, where there is one. Overview carries none: it has
            // nothing to count, which is what it says.
            counts={{ 'Early Access': data?.summary.total ? { n: data.summary.total } : undefined }}
          />
        }
      />

      {tab === 'Overview' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 md:px-8">
          <ComingSoon title="vFarm is not wired to the engine yet" min={200}>
            Nothing on the rack writes to this dashboard today. When burn-in cycles, anomalies, growth cycles and measurements start
            arriving, they will be shown here as they are recorded rather than reconstructed.
          </ComingSoon>
        </div>
      ) : status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <EarlyAccess data={data} onChange={onChange} />
      )}
    </div>
  );
}
