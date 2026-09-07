import { useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import { getOpenLoops } from '../../data';
import { LoadFailed, Loading, PageHeader } from '../../components/ui';
import { Loops } from './Loops';
import { Reconciliation } from './Reconciliation';
import { ReviewQueue } from './ReviewQueue';

const TABS = ['Loops', 'Review queue', 'Reconciliation'] as const;
type Tab = (typeof TABS)[number];

export default function OpenLoops() {
  const [tab, setTab] = useState<Tab>('Loops');
  const [owner, setOwner] = useState<string>('all');
  const { status, data, error } = useData(getOpenLoops);

  const loops = useMemo(
    () => (data ? data.loops.filter((l) => owner === 'all' || l.owner === owner) : []),
    [data, owner],
  );

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Open loops"
        subtitle="Oldest first"
        right={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
                {t === 'Review queue' && data.review_queue.length > 0 && (
                  <span className="tabular ml-1.5 text-faint">{data.review_queue.length}</span>
                )}
                {t === 'Reconciliation' && data.reconciliation.length > 0 && (
                  <span className="tabular ml-1.5 text-degraded">{data.reconciliation.length}</span>
                )}
              </button>
            ))}
          </div>
        }
      />

      {tab === 'Loops' && (
        <Loops data={data} loops={loops} owner={owner} setOwner={setOwner} />
      )}
      {tab === 'Review queue' && <ReviewQueue data={data} />}
      {tab === 'Reconciliation' && <Reconciliation data={data} />}
    </div>
  );
}
