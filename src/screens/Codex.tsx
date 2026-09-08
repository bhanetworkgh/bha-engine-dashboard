import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getCodexEntries, getRecordMetrics, setRecordStatus, type CodexEntry, type CodexStatus } from '../data';
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
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  TagRow,
  Th,
  Toast,
  useToast,
} from '../components/ui';

type StatusFilter = 'all' | CodexStatus;

function StatusPill({ status }: { status: CodexStatus }) {
  if (status === 'ingested') return <Pill tone="ok">ingested</Pill>;
  if (status === 'archived') return <Pill>archived</Pill>;
  return <Pill tone="degraded">posted only</Pill>;
}

export default function Codex() {
  const { status, data: loaded, error } = useData(getCodexEntries);
  const [entries, setEntries] = useState<CodexEntry[]>([]);
  const [builder, setBuilder] = useState('all');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((q) => getRecordMetrics('codex', q, builder), [builder, tick]);

  useEffect(() => {
    if (loaded) setEntries(loaded.entries);
  }, [loaded]);

  const byBuilder = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.builder_id] = (c[e.builder_id] ?? 0) + 1;
    return c;
  }, [entries]);

  const scoped = useMemo(() => entries.filter((e) => builder === 'all' || e.builder_id === builder), [entries, builder]);
  const counts = {
    all: scoped.length,
    posted: scoped.filter((e) => e.status === 'posted').length,
    ingested: scoped.filter((e) => e.status === 'ingested').length,
    archived: scoped.filter((e) => e.status === 'archived').length,
  };
  const rows = scoped.filter((e) => filter === 'all' || e.status === filter);

  async function change(e: CodexEntry, next: CodexStatus) {
    setBusyId(e.id);
    try {
      const updated = await setRecordStatus('codex', e.id, next);
      setEntries((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setTick((n) => n + 1);
      setToast({ text: next === 'ingested' ? 'Marked as ingested.' : next === 'archived' ? 'Entry archived.' : 'Marked as posted only.', tone: 'ok' });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Codex entries" subtitle="By builder and week, and whether each reached BHARAG or only Slack" />

      <MetricsStrip metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BuilderFilter counts={byBuilder} value={builder} onChange={setBuilder} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<StatusFilter>
            ariaLabel="Filter by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'posted', label: 'Posted only', count: counts.posted },
              { value: 'ingested', label: 'Ingested', count: counts.ingested },
              { value: 'archived', label: 'Archived', count: counts.archived },
            ]}
          />
          <span className="text-[11.5px] text-faint">
            Showing <span className="tabular text-dim">{rows.length}</span> entries · {loaded.this_week} logged this week
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No Codex entries match the selected lane, builder and status.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th>logged</Th>
              <Th>week</Th>
              <Th>builder</Th>
              <Th>type</Th>
              <Th>title</Th>
              <Th>status</Th>
              <Th>tags</Th>
              <Th>narration</Th>
              {SPINE_HEADERS.map((h) => (
                <Th key={h}>{h}</Th>
              ))}
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const busy = busyId === e.id;
              return (
                <tr key={e.id} className={busy ? 'opacity-60' : ''}>
                  <td className="td tabular text-faint">{e.logged_at}</td>
                  <td className="td tabular text-faint">{e.week}</td>
                  <td className="td card-meta text-dim">{BUILDER_NAMES[e.builder_id] ?? e.builder_id}</td>
                  <td className="td text-faint">{e.session_type}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '46ch' }} title={e.title}>
                    {e.title}
                  </td>
                  <td className="td card-meta">
                    <StatusPill status={e.status} />
                    {e.closed_at && <span className="ml-1.5 tabular text-[11px] text-faint">{e.closed_at}</span>}
                  </td>
                  <td className="td">
                    <TagRow tags={e.tags} />
                  </td>
                  <td className="td">
                    {e.narration_url ? (
                      <a href={e.narration_url} target="_blank" rel="noreferrer" className="text-faint hover:text-accent-ink">
                        Open
                      </a>
                    ) : (
                      <span className="text-degraded">not linked</span>
                    )}
                  </td>
                  <SpineCells spine={e.spine} />
                  <td className="td">
                    <SourceLink source={e.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      {e.status === 'posted' && <RowAction label="Mark ingested" tone="accent" disabled={busy} onClick={() => change(e, 'ingested')} />}
                      {e.status === 'ingested' && <RowAction label="Mark posted only" disabled={busy} onClick={() => change(e, 'posted')} />}
                      {e.status !== 'archived' && <RowAction label="Archive" disabled={busy} onClick={() => change(e, 'archived')} />}
                      {e.status === 'archived' && <RowAction label="Restore" tone="accent" disabled={busy} onClick={() => change(e, 'posted')} />}
                      <RowAction label="Open in Slack" onClick={() => window.open(e.source.url, '_blank', 'noreferrer')} />
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
