import { useState } from 'react';
import { useData } from '../../app/useData';
import { getVFarm } from '../../data';
import { LoadFailed, Loading, PageHeader, Tabs } from '../../components/ui';
import { Lifecycle } from './Lifecycle';
import { Live } from './Live';
import { Readiness } from './Readiness';

const TABS = ['Live', 'Lifecycle', 'Readiness'] as const;
type Tab = (typeof TABS)[number];

export default function VFarm() {
  const [tab, setTab] = useState<Tab>('Live');
  const { status, data, error } = useData(getVFarm);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  /** A tab whose capability does not exist yet, rather than one that happens to be empty. */
  const soon: Tab[] = [...(data.lifecycle.length === 0 ? (['Lifecycle'] as Tab[]) : []), 'Readiness'];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="vFarm"
        subtitle={`${data.days_to_halloween} days to Halloween`}
        // Lifecycle and Readiness are marked before the reader clicks: nothing
        // emits lifecycle events, and readiness is not computed anywhere yet.
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} soon={soon} />}
      />

      {/*
        vFarm is still phase 1 fixtures, not an Airtable read, so it has no
        resync to report. Saying that is the same promise every other page's
        sync line makes: the reader is told how old what they are looking at
        is, including when the answer is "it is not live data at all".
      */}
      <div className="shrink-0 px-6 pb-3 text-[11.5px] text-faint md:px-8">
        Live readings and alerts on this page are phase 1 fixtures, not read from Airtable — there is no resync behind them. Lifecycle and readiness are not built yet.
      </div>

      {tab === 'Live' && <Live data={data} />}
      {tab === 'Lifecycle' && <Lifecycle data={data} />}
      {tab === 'Readiness' && <Readiness data={data} />}
    </div>
  );
}
