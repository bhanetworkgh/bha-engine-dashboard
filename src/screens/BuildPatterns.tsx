import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getBuildPatterns, getRecordMetrics, setRecordStatus, type BuildPattern, type PatternStatus } from '../data';
import {
  BuilderFilter,
  EmptyState,
  LoadFailed,
  Loading,
  MetricsStrip,
  PageHeader,
  Pill,
  RowAction,
  RowActions,
  Segmented,
  SourceLink,
  TableFrame,
  Th,
  Toast,
  useToast,
} from '../components/ui';
import { laneLabel } from '../lib';

type StatusFilter = 'all' | PatternStatus;

export default function BuildPatterns() {
  const { status, data: loaded, error } = useData(getBuildPatterns);
  const [patterns, setPatterns] = useState<BuildPattern[]>([]);
  const [builder, setBuilder] = useState('all');
  const [filter, setFilter] = useState<StatusFilter>('active');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((q) => getRecordMetrics('patterns', q, builder), [builder, tick]);

  useEffect(() => {
    if (loaded) setPatterns(loaded.patterns);
  }, [loaded]);

  const byBuilder = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of patterns) c[p.author] = (c[p.author] ?? 0) + 1;
    return c;
  }, [patterns]);

  const scoped = useMemo(() => patterns.filter((p) => builder === 'all' || p.author === builder), [patterns, builder]);
  const counts = {
    all: scoped.length,
    active: scoped.filter((p) => p.status === 'active').length,
    retired: scoped.filter((p) => p.status === 'retired').length,
  };
  const rows = scoped.filter((p) => filter === 'all' || p.status === filter);
  const max = Math.max(1, ...rows.map((p) => p.references));

  async function change(p: BuildPattern, next: PatternStatus) {
    setBusyId(p.id);
    try {
      const updated = await setRecordStatus('patterns', p.id, next);
      setPatterns((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setTick((n) => n + 1);
      setToast({ text: next === 'retired' ? 'Pattern retired.' : 'Pattern restored.', tone: 'ok' });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Build patterns" subtitle="By lane, and how often referenced" />

      <MetricsStrip metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <BuilderFilter counts={byBuilder} value={builder} onChange={setBuilder} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<StatusFilter>
            ariaLabel="Filter by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'active', label: 'Active', count: counts.active },
              { value: 'retired', label: 'Retired', count: counts.retired },
              { value: 'all', label: 'All', count: counts.all },
            ]}
          />
          <span className="text-[11.5px] text-faint">{loaded.reference_note}</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No build patterns match the selected lane, author and status.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th>code</Th>
              <Th>title</Th>
              <Th>status</Th>
              <Th>lane</Th>
              <Th>author</Th>
              <Th className="text-right">references</Th>
              <Th />
              <Th>last referenced</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const busy = busyId === p.id;
              return (
                <tr key={p.id} className={busy ? 'opacity-60' : ''}>
                  <td className="td tabular text-faint">{p.code}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '46ch' }}>
                    {p.title}
                  </td>
                  <td className="td card-meta">{p.status === 'retired' ? <Pill>retired</Pill> : <Pill tone="ok">active</Pill>}</td>
                  <td className="td card-meta text-faint">{laneLabel(p.lane)}</td>
                  <td className="td text-dim">{BUILDER_NAMES[p.author] ?? p.author}</td>
                  <td className="td card-meta tabular text-right">{p.references}</td>
                  <td className="td w-[90px]">
                    <span className="block h-[5px] overflow-hidden rounded-full bg-raised">
                      <span className="block h-[5px] rounded-full bg-ink/55" style={{ width: `${(p.references / max) * 100}%` }} />
                    </span>
                  </td>
                  <td className="td tabular text-faint">{p.last_referenced ?? 'never'}</td>
                  <td className="td">
                    <SourceLink source={p.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      {p.status === 'active' ? (
                        <RowAction label="Retire" disabled={busy} onClick={() => change(p, 'retired')} />
                      ) : (
                        <RowAction label="Restore" tone="accent" disabled={busy} onClick={() => change(p, 'active')} />
                      )}
                      <RowAction label="Open in Slack" onClick={() => window.open(p.source.url, '_blank', 'noreferrer')} />
                    </RowActions>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}
      <Toast toast={toast} />
    </div>
  );
}
