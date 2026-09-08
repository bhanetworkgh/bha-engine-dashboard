import { useState } from 'react';
import { useData } from '../../app/useData';
import { getNorthStar, getResearchTwin, type Query, type TwinData } from '../../data';
import { LoadFailed, Loading, PageHeader, Tabs } from '../../components/ui';
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
        below={
          /* Sub-tabs live inside the page, not the sidebar. */
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            counts={{ Gaps: { n: data.gaps.length, tone: data.gaps.length ? 'degraded' : 'default' } }}
          />
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
