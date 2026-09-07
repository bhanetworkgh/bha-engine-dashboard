import { useState } from 'react';
import { useData } from '../../app/useData';
import { getNorthStar, getResearchTwin, type Query, type TwinData } from '../../data';
import { LoadFailed, Loading, PageHeader } from '../../components/ui';
import { Gaps } from './Gaps';
import { Records } from './Records';
import { Runs } from './Runs';
import { Summary } from './Summary';
import { TABS, type Tab } from './shared';

function TwinScreen({ fetcher }: { fetcher: (q: Query) => Promise<TwinData> }) {
  const [tab, setTab] = useState<Tab>('Summary');
  const { status, data, error } = useData(fetcher, [fetcher]);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={data.name}
        subtitle={data.summary.period}
        right={
          /* Sub-tabs live inside the page, not the sidebar. */
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border-b-2 pb-1 text-[12px] ${
                  tab === t
                    ? 'border-gold text-ink'
                    : 'border-transparent text-faint hover:text-dim'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        }
      />
      {tab === 'Summary' && <Summary d={data} />}
      {tab === 'Records' && <Records d={data} />}
      {tab === 'Runs' && <Runs d={data} />}
      {tab === 'Gaps' && <Gaps d={data} />}
    </div>
  );
}

export function NorthStar() {
  return <TwinScreen fetcher={getNorthStar} />;
}

export function ResearchTwin() {
  return <TwinScreen fetcher={getResearchTwin} />;
}
