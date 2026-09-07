import { useState } from 'react';
import { useData } from '../../app/useData';
import { getVFarm } from '../../data';
import { LoadFailed, Loading, PageHeader } from '../../components/ui';
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="vFarm"
        subtitle={`${data.days_to_halloween} days to Halloween`}
        right={
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border-b-2 pb-1 text-[12px] ${
                  tab === t ? 'border-gold text-ink' : 'border-transparent text-faint hover:text-dim'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        }
      />

      {tab === 'Live' && <Live data={data} />}
      {tab === 'Lifecycle' && <Lifecycle data={data} />}
      {tab === 'Readiness' && <Readiness data={data} />}
    </div>
  );
}
