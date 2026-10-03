import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useData } from '../../app/useData';
import { getVfarmLeads, getVfarmLive, type VfarmLead, type VfarmLeadsData } from '../../data';
import { useReplayKey, LoadFailed, Loading, PageHeader, Tabs } from '../../components/ui';
import EarlyAccess from './EarlyAccess';
import { Alerts, Devices, Overview, reporting } from './Live';

/** The record kinds this page is built from: a change to one re-reads it (live since 2026-09-23). */
const VFARM_KINDS = ['vfarm_leads'] as const;
/** vFarm's own pushes (2026-09-29): its snapshot and its alert fires. */
const LIVE_KINDS = ['vfarm_state', 'vfarm_alerts'] as const;

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
/*
 * 29 Sep 2026 (Destiny, D3): Overview is real now, and Devices and Alerts join
 * it — all three from what vFarm itself pushes (see Live.tsx). Until the first
 * snapshot each says so and names who wires it; nothing is drawn in its place.
 */
const TABS = ['Overview', 'Devices', 'Alerts', 'Early Access'] as const;
type Tab = (typeof TABS)[number];

export default function VFarm() {
  // `?tab=early-access&lead=<id>` lands on a lead — Home's vFarm tile and its
  // "What moved" rows link here (2026-09-23).
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get('tab');
    return t === 'early-access' ? 'Early Access' : t === 'devices' ? 'Devices' : t === 'alerts' ? 'Alerts' : 'Overview';
  });
  /* Switching any of these re-runs the page's count-ups and bars (27 Sep 2026). */
  useReplayKey(`${tab}`);
  const [held, setHeld] = useState<VfarmLeadsData | null>(null);
  const { status, data: loaded, error } = useData(getVfarmLeads, [], { kinds: VFARM_KINDS });
  const live = useData(getVfarmLive, [], { kinds: LIVE_KINDS });
  const liveData = live.data;
  const quiet = liveData ? liveData.devices.filter((d) => !d.gone_at && !reporting(d)).length : 0;

  // A fresh read replaces an optimistic copy: the server has the edit by then,
  // or has refused it, and either way its answer is the one to show.
  useEffect(() => setHeld(null), [loaded]);
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
      const by_stage: Record<string, number> = { '1': 0, '2': 0 };
      for (const l of leads) by_stage[String(l.stage ?? 1)] = (by_stage[String(l.stage ?? 1)] ?? 0) + 1;
      const now = Date.now();
      const since = (days: number) => leads.filter((l) => now - Date.parse(l.created_at) < days * 86_400_000).length;
      setHeld({ leads, summary: { total: leads.length, last_7_days: since(7), last_30_days: since(30), by_status, by_stage } });
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
            counts={{
              'Early Access': data?.summary.total ? { n: data.summary.total } : undefined,
              Devices: liveData?.devices.length ? { n: liveData.devices.length, tone: quiet ? 'degraded' : 'default' } : undefined,
              Alerts: liveData?.open_alerts.length ? { n: liveData.open_alerts.length, tone: 'degraded' } : undefined,
            }}
          />
        }
      />

      {tab !== 'Early Access' ? (
        live.status === 'loading' && !liveData ? (
          <Loading />
        ) : live.status === 'error' && !liveData ? (
          <LoadFailed error={live.error} />
        ) : !liveData ? (
          <Loading />
        ) : tab === 'Overview' ? (
          <Overview data={liveData} />
        ) : tab === 'Devices' ? (
          <Devices data={liveData} />
        ) : (
          <Alerts data={liveData} />
        )
      ) : status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <EarlyAccess initialOpen={params.get('lead')} data={data} onChange={onChange} />
      )}
    </div>
  );
}
