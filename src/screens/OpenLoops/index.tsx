import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../app/useData';
import { BUILDER_NAMES, createLoop, getOpenLoops, getRecordMetrics, removeLoopDuplicate, saveLoop, type Loop, type LoopEdit, type LoopMetrics, type LoopStatus, type NewLoop, type OpenLoopsData } from '../../data';
import { Icon, LoadFailed, Loading, MonthPicker, monthsFrom, thisMonth, PageHeader, Tabs, Pagination, SearchBox, Segmented, RowsLine, Toast, usePaged, useToast } from '../../components/ui';
import { LoopPanel } from './LoopPanel';
import { Loops, type StatusFilter } from './Loops';
import { LoopMetricsPanel, LoopStatusStrip } from './Metrics';
import { NewLoopForm } from './NewLoop';
import RecordStatistics from '../../components/RecordStatistics';

/** Case-insensitive match on loop_id, title, who raised it and where. */
function matches(l: Loop, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [l.loop_id, l.title, l.raised_by, l.raised_in, l.lane_tag, l.id].some((v) => v && v.toLowerCase().includes(needle));
}

/** How long the panel shows its transition state when the builder changes. */
const SWITCH_MS = 220;

/**
 * Two views of the same records (2026-09-16, Destiny), tabbed at the top the
 * way the System Registry tabs its four registries.
 *
 * **Loops** is the working surface: the list and its filters. **Statistics**
 * answers the other question — is this getting better or worse — which needs
 * month-against-month figures rather than rows. Everything month-shaped lives
 * there: the chart, the month in view and the export.
 */
const VIEWS = ['Loops', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

export default function OpenLoops() {
  const [owner, setOwner] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [q, setQ] = useState('');
  /**
   * The month the loops tab is showing, and the month the statistics tab is
   * comparing — deliberately one selection, so choosing September on one and
   * coming back to the other does not show you August.
   *
   * It opens on the current month (2026-09-16, Destiny). The page used to open
   * on every loop ever raised, so the figures never moved. The status strip
   * above the tabs is the exception and stays all-time, because "how many
   * loops are open" is a question about today.
   */
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [view, setView] = useState<View>('Loops');
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { toast, setToast } = useToast();
  const { status, data: loaded, error } = useData(getOpenLoops, []);

  /**
   * The figures arrive once, unscoped, carrying every builder's figures with
   * them (`by_builder`). A tab change picks from that in memory — no request,
   * no recompute over the rows — and shows a short transition while the counts
   * run up again.
   */
  const [metricsTick, setMetricsTick] = useState(0);
  const metrics = useData((query) => getRecordMetrics('loops', query, null, month), [metricsTick, month]);
  /**
   * The figures for the builder tab in view — the status strip at the top, which
   * follows both the builder and the month.
   */
  const current: LoopMetrics | null = useMemo(() => {
    const m = metrics.data;
    if (!m) return null;
    return owner === 'all' ? m : (m.by_builder?.[owner] ?? null);
  }, [metrics.data, owner]);
  /**
   * The figures across **every** builder, for the two comparison cards
   * (2026-09-16, Destiny).
   *
   * Close rate by builder and How long these have been sitting exist to set the
   * builders against each other. Narrowing them to one builder left a chart
   * with a single bar, which is the one thing they cannot answer. They follow
   * the month like everything else; they just never follow the builder tab.
   */
  const allBuilders: LoopMetrics | null = metrics.data ?? null;
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

  // Every month a loop was raised in, newest first, and how many each holds —
  // read off the rows the page already has rather than asked for.
  const months = useMemo(() => monthsFrom((data?.loops ?? []).map((l) => l.raised_at)), [data]);
  const monthCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const l of data?.loops ?? []) {
      const m = l.raised_at?.slice(0, 7);
      if (m) out[m] = (out[m] ?? 0) + 1;
    }
    return out;
  }, [data]);
  const inMonth = useMemo(() => (data?.loops ?? []).filter((l) => !month || l.raised_at?.slice(0, 7) === month), [data, month]);
  // One count per builder table, for the month in view.
  const ownerCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const l of inMonth) out[l.owner] = (out[l.owner] ?? 0) + 1;
    return out;
  }, [inMonth]);
  const scoped = useMemo(() => inMonth.filter((l) => owner === 'all' || l.owner === owner), [inMonth, owner]);
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
        // Newest first, oldest last. Age stays on every row as the signal;
        // it is no longer what decides the order.
        .filter((l) => matches(l, q.trim()))
        .sort((a, b) => (b.raised_at ?? '').localeCompare(a.raised_at ?? '') || a.age_days - b.age_days),
    [scoped, statusFilter, q, month],
  );

  const paged = usePaged(loops, `${owner}|${statusFilter}|${q.trim()}|${month ?? 'all'}`);

  /**
   * One save, whether it came from a row action or the panel.
   *
   * A move gives the loop a new Airtable record id, so the row that comes back
   * may not have the id that went in — the list is keyed by id and so is the
   * open panel, and both follow the returned loop rather than the one clicked.
   */
  async function save(loop: Loop, edit: LoopEdit, said: string) {
    setBusyId(loop.id);
    try {
      const updated = await saveLoop(loop.id, edit);
      setData((d) => (d ? { ...d, loops: d.loops.map((l) => (l.id === loop.id ? updated : l)) } : d));
      if (openId === loop.id) setOpenId(updated.id);
      setMetricsTick((n) => n + 1);
      // The change saved here either way — but if it did not land in Airtable,
      // saying "Closed." and nothing else is the lie this path exists to stop
      // telling. The row and the panel carry the detail; this says look at it.
      const wb = updated.writeback;
      setToast(
        wb?.state === 'duplicate'
          ? { text: wb.reason ?? 'The loop is now in two tables.', tone: 'failing' }
          : wb?.state === 'failed'
            ? { text: `Saved here, but Airtable did not take it: ${wb.reason ?? 'no reason given'}`, tone: 'failing' }
            : { text: said, tone: 'ok' },
      );
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The one repair for a half-landed move: delete the copy left in the source
   * table. It is not a save — nothing about the loop changes — so it does not
   * go through save() and never re-runs the move.
   *
   * A retry that fails leaves the loop where it was, in two tables, and comes
   * back still `duplicate` with the new reason on it. The action stays.
   */
  async function removeDuplicate(loop: Loop) {
    setBusyId(loop.id);
    try {
      const updated = await removeLoopDuplicate(loop.id);
      setData((d) => (d ? { ...d, loops: d.loops.map((l) => (l.id === loop.id ? updated : l)) } : d));
      const wb = updated.writeback;
      setToast(
        wb?.state === 'duplicate'
          ? { text: wb.reason ?? 'The copy is still there.', tone: 'failing' }
          : { text: 'The copy is gone. This loop is in one table again.', tone: 'ok' },
      );
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The copy was not removed.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  function changeStatus(loop: Loop, next: LoopStatus) {
    return save(loop, { status: next }, next === 'closed' ? 'Closed.' : next === 'in progress' ? 'Marked in progress.' : 'Reopened.');
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
      setToast({ text: `Loop created in ${created.owner}’s loops.`, tone: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The loop was not created.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  // The panel follows the list's own copy, so a save redraws it with what came
  // back rather than with what was on screen when it opened.
  const panelLoop = openId ? (data.loops.find((l) => l.id === openId) ?? null) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Open loops"
        subtitle="Every commitment BHA has made, across every system"
        right={
          <button type="button" onClick={() => setShowNew((v) => !v)} className="btn btn-primary gap-1.5">
            <Icon.plus />
            New loop
          </button>
        }
        below={<Tabs tabs={VIEWS} value={view} onChange={setView} />}
      />

      {showNew && (
        <div className="shrink-0">
          <NewLoopForm defaultOwner={owner === 'all' ? 'destiny' : owner} busy={busyId === 'new'} onSubmit={openLoop} onCancel={() => setShowNew(false)} />
        </div>
      )}

      {/*
        Everything month-shaped lives on the statistics tab: the chart, the
        month in view and the export. This tab is the list and its filters.
      */}
      {view === 'Statistics' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <RecordStatistics<Loop>
            kind="loops"
            noun="Loops"
            monthlyKind="loops"
            month={month}
            onMonth={setMonth}
            rows={data.loops}
            dateOf={(l) => l.raised_at}
            columns={[
              { header: 'loop_id', value: (l) => l.loop_id },
              { header: 'airtable_record_id', value: (l) => l.id },
              { header: 'what', value: (l) => l.title },
              { header: 'owner', value: (l) => l.owner },
              { header: 'status', value: (l) => l.status },
              { header: 'lane_tag', value: (l) => l.lane_tag },
              { header: 'raised_by', value: (l) => l.raised_by },
              { header: 'date_raised', value: (l) => l.raised_at },
              { header: 'closed_at', value: (l) => l.closed_at },
              { header: 'age_days', value: (l) => l.age_days },
              { header: 'airtable_url', value: (l) => l.airtable.url },
            ]}
          />
        </div>
      ) : (
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <RowsLine freshness={data.freshness} writes={false} />
        </div>

        {/*
          Where the backlog stands, all time, above the builder tabs
          (2026-09-16, Destiny). Everything below it follows the month.
        */}
        <LoopStatusStrip metrics={current} view={owner} loading={metrics.status === 'loading'} />

        <LoopMetricsPanel metrics={allBuilders} loading={metrics.status === 'loading'} switching={switching} error={metrics.error} view={month ?? 'all'} />


        {/*
          The two filter rows, in the order the Codex page puts them
          (2026-09-16, Destiny): the builder tables and the month above, the
          status and the search below. The tall tile strip that used to carry
          the builders is gone; a headline number per builder was a lot of
          furniture for a filter.
        */}
        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              ariaLabel="Filter by builder table"
              value={owner}
              onChange={setOwner}
              options={[
                { value: 'all', label: 'All tables', count: inMonth.length },
                ...data.by_owner.map((o) => ({ value: o.owner, label: BUILDER_NAMES[o.owner] ?? o.owner, count: ownerCounts[o.owner] ?? 0 })),
              ]}
            />
            <MonthPicker months={months} value={month} onChange={setMonth} counts={monthCounts} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              ariaLabel="Filter by status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'open', label: 'Open', count: counts.open },
                { value: 'in progress', label: 'In progress', count: counts['in progress'] },
                { value: 'closed', label: 'Closed', count: counts.closed },
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search by loop id or text" />
            </div>
          </div>
        </div>
        <Loops
          data={data}
          loops={paged.rows}
          total={loops.length}
          busyId={busyId}
          onStatus={changeStatus}
          onOpen={(l) => setOpenId(l.id)}
          onRemoveDuplicate={(l) => void removeDuplicate(l)}
          searching={Boolean(q.trim())}
        />
        <Pagination paged={paged} unit="loops" />
      </div>
      )}

      {panelLoop && (
        <LoopPanel
          loop={panelLoop}
          busy={busyId === panelLoop.id}
          onClose={() => setOpenId(null)}
          onSave={(edit) => void save(panelLoop, edit, edit.builder && edit.builder !== panelLoop.owner ? `Moved to ${BUILDER_NAMES[edit.builder] ?? edit.builder}.` : 'Saved.')}
          onRemoveDuplicate={() => void removeDuplicate(panelLoop)}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}
