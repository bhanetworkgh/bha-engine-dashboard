import { useState } from 'react';
import { useData } from '../../app/useData';
import { getEngineHealth } from '../../data';
import { LoadFailed, Loading, PageHeader } from '../../components/ui';
import { IncidentTable } from './IncidentTable';
import { MetricsRow } from './MetricsRow';

export default function EngineHealth() {
  const { status, data, error } = useData(getEngineHealth);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Engine health" subtitle="Incidents and self-healing" />
      <MetricsRow data={data} />
      <IncidentTable data={data} expanded={expanded} setExpanded={setExpanded} />
    </div>
  );
}
