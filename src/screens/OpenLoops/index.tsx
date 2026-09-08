import { useEffect, useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import { useSession } from '../../app/session';
import {
  createLoop,
  getOpenLoops,
  setLoopStatus,
  type Loop,
  type LoopStatus,
  type NewLoop,
  type OpenLoopsData,
} from '../../data';
import { Icon, LoadFailed, Loading, PageHeader, Segmented, Tabs } from '../../components/ui';
import { Loops, OwnerPicker, type StatusFilter } from './Loops';
import { NewLoopForm } from './NewLoop';
import { Reconciliation } from './Reconciliation';
import { ReviewQueue } from './ReviewQueue';

const TABS = ['Loops', 'Review queue', 'Reconciliation'] as const;
type Tab = (typeof TABS)[number];

export default function OpenLoops() {
  const { lane } = useSession();
  const [tab, setTab] = useState<Tab>('Loops');
  const [owner, setOwner] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'failing' } | null>(null);
  const { status, data: loaded, error } = useData(getOpenLoops);

  /** A working copy so a status change updates the page without a refetch. */
  const [data, setData] = useState<OpenLoopsData | null>(null);
  useEffect(() => {
    setData(loaded);
  }, [loaded]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(() => {
    const rows = data ? data.loops.filter((l) => owner === 'all' || l.owner === owner) : [];
    return {
      all: rows.length,
      open: rows.filter((l) => l.status === 'open').length,
      'in progress': rows.filter((l) => l.status === 'in progress').length,
      closed: rows.filter((l) => l.status === 'closed').length,
    };
  }, [data, owner]);

  const loops = useMemo(() => {
    if (!data) return [];
    return data.loops
      .filter((l) => owner === 'all' || l.owner === owner)
      .filter((l) => statusFilter === 'all' || l.status === statusFilter)
      .sort((a, b) => b.age_days - a.age_days);
  }, [data, owner, statusFilter]);

  async function changeStatus(loop: Loop, next: LoopStatus) {
    setBusyId(loop.id);
    try {
      const updated = await setLoopStatus(loop.id, next);
      setData((d) => (d ? { ...d, loops: d.loops.map((l) => (l.id === updated.id ? updated : l)) } : d));
      setToast({
        text: next === 'closed' ? 'Loop closed.' : next === 'in progress' ? 'Loop marked in progress.' : 'Loop reopened.',
        tone: 'ok',
      });
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
      setShowNew(false);
      setStatusFilter((s) => (s === 'closed' ? 'open' : s));
      if (owner !== 'all' && owner !== created.owner) setOwner(created.owner);
      setToast({ text: 'Loop opened.', tone: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The loop was not created.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Open loops"
        subtitle="Oldest first. Age is the signal on this page."
        right={
          <button type="button" onClick={() => setShowNew((v) => !v)} className="btn btn-primary gap-1.5">
            <Icon.plus />
            New loop
          </button>
        }
        below={
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            counts={{
              'Review queue': { n: data.review_queue.length },
              Reconciliation: { n: data.reconciliation.length, tone: 'degraded' },
            }}
          />
        }
      />

      {showNew && (
        <div className="shrink-0">
          <NewLoopForm
            defaultOwner={owner === 'all' ? 'destiny' : owner}
            defaultLane={lane === 'all' ? 'ENGINE_INTERNAL' : lane}
            busy={busyId === 'new'}
            onSubmit={openLoop}
            onCancel={() => setShowNew(false)}
          />
        </div>
      )}

      {tab === 'Loops' && (
        <>
          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <OwnerPicker data={data} owner={owner} setOwner={setOwner} />
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
              <span className="text-[11.5px] text-faint">
                Showing <span className="tabular text-dim">{loops.length}</span> held rows
              </span>
            </div>
          </div>
          <Loops data={data} loops={loops} busyId={busyId} onStatus={changeStatus} />
        </>
      )}
      {tab === 'Review queue' && <ReviewQueue data={data} />}
      {tab === 'Reconciliation' && <Reconciliation data={data} />}

      {toast && (
        <div
          role="status"
          className={`fade-up absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-[12.5px] shadow-[var(--shadow-pop)] ${
            toast.tone === 'failing' ? 'bg-failing-soft text-failing' : 'bg-ink text-bg'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
