import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../app/useData';
import { createLoop, getOpenLoops, getRecordMetrics, resync, setLoopStatus, type Loop, type LoopMetrics, type LoopStatus, type NewLoop, type OpenLoopsData } from '../../data';
import { Icon, LoadFailed, Loading, PageHeader, SearchBox, Segmented, SyncLine, Toast, useToast } from '../../components/ui';
import { Loops, OwnerPicker, type StatusFilter } from './Loops';
import { LoopMetricsPanel } from './Metrics';
import { NewLoopForm } from './NewLoop';

/** Case-insensitive match on loop_id, title, who raised it and where. */
function matches(l: Loop, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [l.loop_id, l.title, l.raised_by, l.raised_in, l.lane_tag, l.id].some((v) => v && v.toLowerCase().includes(needle));
}

/** How long the panel shows its transition state when the builder changes. */
const SWITCH_MS = 220;

export default function OpenLoops() {
  const [owner, setOwner] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { toast, setToast } = useToast();
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getOpenLoops, [reload]);

  /**
   * The figures arrive once, unscoped, carrying every builder's figures with
   * them (`by_builder`). A tab change picks from that in memory — no request,
   * no recompute over the rows — and shows a short transition while the counts
   * run up again.
   */
  const [metricsTick, setMetricsTick] = useState(0);
  const metrics = useData((query) => getRecordMetrics('loops', query), [metricsTick, reload]);
  const current: LoopMetrics | null = useMemo(() => {
    const m = metrics.data;
    if (!m) return null;
    return owner === 'all' ? m : (m.by_builder?.[owner] ?? null);
  }, [metrics.data, owner]);
  const [switching, setSwitching] = useState(false);
  const firstOwner = useRef(true);
  useEffect(() => {
    if (firstOwner.current) {
      firstOwner.current = false;
      return;
    }
    setSwitching(true);
    const t = setTimeout(() => setSwitching(false), SWITCH_MS);
    return () => clearTimeout(t);
  }, [owner]);

  /** A working copy so a status change updates the page without a refetch. */
  const [data, setData] = useState<OpenLoopsData | null>(null);
  useEffect(() => {
    setData(loaded);
  }, [loaded]);

  const scoped = useMemo(() => (data ? data.loops.filter((l) => owner === 'all' || l.owner === owner) : []), [data, owner]);
  const counts = useMemo(
    () => ({
      all: scoped.length,
      open: scoped.filter((l) => l.status === 'open').length,
      'in progress': scoped.filter((l) => l.status === 'in progress').length,
      closed: scoped.filter((l) => l.status === 'closed').length,
    }),
    [scoped],
  );
  const loops = useMemo(
    () =>
      scoped
        .filter((l) => statusFilter === 'all' || l.status === statusFilter)
        .filter((l) => matches(l, q.trim()))
        .sort((a, b) => b.age_days - a.age_days),
    [scoped, statusFilter, q],
  );

  async function changeStatus(loop: Loop, next: LoopStatus) {
    setBusyId(loop.id);
    try {
      const updated = await setLoopStatus(loop.id, next);
      setData((d) => (d ? { ...d, loops: d.loops.map((l) => (l.id === updated.id ? updated : l)) } : d));
      setMetricsTick((n) => n + 1);
      setToast({ text: next === 'closed' ? 'Closed in Airtable.' : next === 'in progress' ? 'Marked in progress in Airtable.' : 'Reopened in Airtable.', tone: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  async function openLoop(input: NewLoop) {
    setBusyId('new');
    try {
      const created = await createLoop(input);
      setData((d) => (d ? { ...d, loops: [created, ...d.loops] } : d));
      setMetricsTick((n) => n + 1);
      setShowNew(false);
      setStatusFilter((s) => (s === 'closed' ? 'open' : s));
      if (owner !== 'all' && owner !== created.owner) setOwner(created.owner);
      setToast({ text: `Loop created in ${created.owner}’s table in Airtable.`, tone: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The loop was not created.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('loops');
      const t = r.results[0]?.tables ?? [];
      const n = t.reduce((s, x) => s + x.n, 0);
      const failed = t.filter((x) => x.error);
      setToast(
        failed.length
          ? { text: `Resync read ${n} loops but ${failed.map((x) => x.label).join(', ')} failed: ${failed[0].error}`, tone: 'failing' }
          : { text: `Resync read ${n} loops across ${t.length} tables (${t.reduce((s, x) => s + x.changed, 0)} status changes, ${t.reduce((s, x) => s + x.removed, 0)} removed).`, tone: 'ok' },
      );
      setReload((n) => n + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Open loops"
        subtitle="Oldest first. Age is the signal on this page."
        right={
          <button type="button" onClick={() => setShowNew((v) => !v)} className="btn btn-primary gap-1.5" disabled={!data.sync.write_through}>
            <Icon.plus />
            New loop
          </button>
        }
      />

      {showNew && (
        <div className="shrink-0">
          <NewLoopForm defaultOwner={owner === 'all' ? 'destiny' : owner} busy={busyId === 'new'} onSubmit={openLoop} onCancel={() => setShowNew(false)} />
        </div>
      )}

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <SyncLine sync={data.sync} onResync={pull} busy={syncing} />
          <OwnerPicker data={data} owner={owner} setOwner={setOwner} />
        </div>

        <LoopMetricsPanel metrics={current} loading={metrics.status === 'loading'} switching={switching} error={metrics.error} view={owner} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              ariaLabel="Filter by status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'open', label: 'Open', count: counts.open },
                { value: 'in progress', label: 'In progress', count: counts['in progress'] },
                { value: 'closed', label: 'Closed', count: counts.closed },
                { value: 'all', label: 'All', count: counts.all },
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search by loop id or text" />
              <span className="tabular whitespace-nowrap text-[11.5px] text-faint">{loops.length} shown</span>
            </div>
          </div>
        </div>
        <Loops data={data} loops={loops} busyId={busyId} onStatus={changeStatus} searching={Boolean(q.trim())} writable={data.sync.write_through} />
      </div>

      <Toast toast={toast} />
    </div>
  );
}
