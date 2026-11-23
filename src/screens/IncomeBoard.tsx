import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getBlockers, getIncomeBoard, setBlocked, type BlockedLoop, type IncomeBlocker } from '../data';
import { Button, EmptyState, LoadFailed, Loading, PageHeader, Pill, SearchBox, Stat, StatCell, StatStrip, TableFrame, Tabs, Th, Toast, relativeTime, useToast } from '../components/ui';

const VIEWS = ['Board', 'Blockers'] as const;
type View = (typeof VIEWS)[number];

/** Every blocked loop: what blocks it, when it unblocks, lane, tag, why and owner (23 Nov 2026, Destiny). */
function Blockers() {
  const [bump, setBump] = useState(0);
  const { status, data, error } = useData(getBlockers, [bump], { kinds: ['loops'] });
  const [owner, setOwner] = useState('all');
  const [sort, setSort] = useState<'late' | 'builder' | 'date'>('late');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<BlockedLoop | 'new' | null>(null);
  const { toast, setToast } = useToast();
  const owners = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) m.set(r.owner ?? 'none', (m.get(r.owner ?? 'none') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.rows ?? []).filter((r) => (owner === 'all' || (r.owner ?? 'none') === owner) && (!needle || [r.loop_id, r.title, r.blocked_by, r.lane, r.tag, r.why, r.owner].some((v) => (v ?? '').toLowerCase().includes(needle))));
    const byDate = (a: BlockedLoop, b: BlockedLoop) => (a.unblock_date ?? '9999').localeCompare(b.unblock_date ?? '9999');
    if (sort === 'builder') return [...list].sort((a, b) => (a.owner ?? '~').localeCompare(b.owner ?? '~') || byDate(a, b));
    if (sort === 'date') return [...list].sort(byDate);
    return list;
  }, [data, owner, sort, q]);
  if (!data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const done = (text: string) => {
    setEditing(null);
    setToast({ text, tone: 'ok' });
    setBump((n) => n + 1);
  };
  return (
    <>
      <p className="px-6 pb-3 pt-4 text-[13px] text-dim md:px-8">
        {data.rows.length} blocked loop{data.rows.length === 1 ? '' : 's'}
        {data.late > 0 && <>, <span className="text-failing">{data.late} late</span></>}
        {data.no_date > 0 && <>, {data.no_date} with no unblock date</>}. {data.rule}
      </p>
      <div className="flex flex-wrap items-center gap-3 px-6 pb-3 md:px-8">
        <SearchBox value={q} onChange={setQ} placeholder="Search loops, blockers, tags" />
        <label className="text-[12.5px] text-dim">
          Builder{' '}
          <select className="input ml-1 inline-block w-auto py-1 text-[12.5px]" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="all">Everyone ({data.rows.length})</option>
            {owners.map(([o, n]) => <option key={o} value={o}>{o === 'none' ? 'No owner' : o} ({n})</option>)}
          </select>
        </label>
        <label className="text-[12.5px] text-dim">
          Sort{' '}
          <select className="input ml-1 inline-block w-auto py-1 text-[12.5px]" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="late">Late first</option>
            <option value="builder">By builder</option>
            <option value="date">By unblock date</option>
          </select>
        </label>
        <Button size="sm" onClick={() => setEditing('new')}>Mark a loop blocked</Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState>{data.rows.length === 0 ? 'No loop is marked blocked yet.' : 'No blocked loop matches.'}</EmptyState>
      ) : (
        <TableFrame grow={false} label="Blocked loops">
          <thead>
            <tr><Th>Loop</Th><Th>Blocked by</Th><Th>Unblocks on</Th><Th>Lane</Th><Th>Tag</Th><Th>Why</Th><Th>Owner</Th></tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.loop_id} className="cursor-pointer border-b border-line align-top hover:bg-hover" onClick={() => setEditing(b)}>
                <td className="max-w-[40ch] px-3 py-2">
                  <span className="tabular text-accent">{b.loop_id.slice(-4)}</span>
                  <div className="text-ink">{b.title.length > 140 ? `${b.title.slice(0, 140)}…` : b.title}</div>
                </td>
                <td className="max-w-[36ch] px-3 py-2 text-ink">{b.blocked_by}</td>
                <td className="tabular whitespace-nowrap px-3 py-2">
                  {b.unblock_date ? (b.late ? <Pill tone="failing">{b.unblock_date} · {b.days_late}d late</Pill> : <span className="text-dim">{b.unblock_date}</span>) : <span className="text-faint">not set</span>}
                </td>
                <td className="px-3 py-2 text-dim">{b.lane ?? <span className="text-faint">none</span>}</td>
                <td className="px-3 py-2 text-dim">{b.tag ?? <span className="text-faint">none</span>}</td>
                <td className="max-w-[36ch] px-3 py-2 text-dim">{b.why ?? <span className="text-faint">not given</span>}</td>
                <td className="px-3 py-2 text-dim">{b.owner ?? <span className="text-faint">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
      {editing && <BlockedDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={done} onError={(text) => setToast({ text, tone: 'failing' })} />}
      <Toast toast={toast} />
      <div className="h-8" />
    </>
  );
}

/** Edit a blocked loop, mark a new one blocked, or take one off the page. */
function BlockedDialog({ row, onClose, onDone, onError }: { row: BlockedLoop | null; onClose: () => void; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [loopId, setLoopId] = useState(row?.loop_id ?? '');
  const [by, setBy] = useState(row?.blocked_by ?? '');
  const [date, setDate] = useState(row?.unblock_date ?? '');
  const [tag, setTag] = useState(row?.tag ?? '');
  const [why, setWhy] = useState(row?.why ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const run = async (clear: boolean) => {
    setBusy(true);
    try {
      const id = loopId.trim();
      await setBlocked(id, clear ? { clear: true } : { blocked_by: by, unblock_date: date, tag, why });
      onDone(clear ? `${id} taken off the blockers page.` : `${id} saved.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'It could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const field = 'input mt-1 w-full py-1.5 text-[13px]';
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[640px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Blocked loop">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{row ? row.loop_id : 'Mark a loop blocked'}</div>
            {row && <div className="mt-1 text-[14px] text-ink">{row.title.length > 300 ? `${row.title.slice(0, 300)}…` : row.title}</div>}
            {row && <div className="mt-1 text-[12px] text-dim">{row.lane ?? 'no lane'} · {row.owner ?? 'no owner'} · {row.status} · <a className="text-accent hover:underline" href={row.link}>open the loop</a></div>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="mt-4 grid gap-3">
          {!row && <label className="text-[12.5px] text-dim">Loop id<input className={field} value={loopId} onChange={(e) => setLoopId(e.target.value)} placeholder="LOOP-1794856066847-5DX1" /></label>}
          <label className="text-[12.5px] text-dim">Blocked by<textarea className={field} rows={2} value={by} onChange={(e) => setBy(e.target.value)} placeholder="What is in the way, e.g. LOOP-… (Jegan): the Stage 1 run" /></label>
          <label className="text-[12.5px] text-dim">Unblocks on<input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="text-[12.5px] text-dim">Tag<input className={field} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. rover, Stage 1 gate, monitoring" /></label>
          <label className="text-[12.5px] text-dim">Why it is blocked<textarea className={field} rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why, and whether it stops the paid pilot" /></label>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          {row ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(true)}>Unblock (take it off the page)</Button> : <span />}
          <Button variant="primary" loading={busy} disabled={!by.trim() || !loopId.trim()} onClick={() => void run(false)}>Save</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The Production-Income Board, BOARD_PROD_INCOME_VFARM_CST (2026-11-20, Destiny; Jason in #bha-coordination
 * 1795202126.334919). One question, Yes or No, and when No every loop, watch or gate in the way by id, with its
 * lane, owner and target date. A read: items are put on the board by Destiny or Jason (set_income_board_item).
 * Colour marks only what blocks: an open item and a gate not passed.
 */
function Rows({ rows, label }: { rows: IncomeBlocker[]; label: string }) {
  return (
    <TableFrame grow={false} label={label}>
      <thead>
        <tr>
          <Th>Id</Th>
          <Th>What</Th>
          <Th>Status</Th>
          <Th>Lane</Th>
          <Th>Owner</Th>
          <Th>Target date</Th>
          <Th>Why it is on the board</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} className="border-b border-line align-top">
            <td className="tabular whitespace-nowrap px-3 py-2">{b.link ? <a className="text-accent hover:underline" href={b.link}>{b.id}</a> : <span className="text-ink">{b.id}</span>}</td>
            <td className="max-w-[48ch] px-3 py-2 text-ink">{b.title}</td>
            <td className="px-3 py-2">{b.open ? <Pill tone="failing">{b.status}</Pill> : <span className="text-dim">{b.status}</span>}</td>
            <td className="px-3 py-2 text-dim">{b.lane ?? <span className="text-faint">none</span>}</td>
            <td className="px-3 py-2 text-dim">{b.owner ?? <span className="text-faint">none</span>}</td>
            <td className="tabular px-3 py-2 text-dim">{b.target_date ?? <span className="text-faint">not set</span>}</td>
            <td className="max-w-[44ch] px-3 py-2 text-dim">{b.reason}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

export default function IncomeBoard() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get('tab') === 'blockers' ? 'Blockers' : 'Board';
  const setView = (v: View) => setParams(v === 'Blockers' ? { tab: 'blockers' } : {}, { replace: true });
  const tabs = <div className="px-6 md:px-8"><Tabs tabs={VIEWS} value={view} onChange={setView} /></div>;
  if (view === 'Blockers') {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        <PageHeader title="Production-Income Board" subtitle="Blocked loops" />
        {tabs}
        <Blockers />
      </div>
    );
  }
  return <BoardView tabs={tabs} />;
}

function BoardView({ tabs }: { tabs: ReactNode }) {
  const { status, data, error } = useData(getIncomeBoard, [], { kinds: ['loops', 'income_board'] });
  if (!data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const cst = data.cst;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Production-Income Board" subtitle={`${data.board_key} · read ${relativeTime(data.read_at) ?? 'just now'}`} />
      {tabs}
      <div className="px-6 pb-4 md:px-8">
        <div className="card p-5">
          <div className="text-[13px] text-dim">{data.question}?</div>
          <div className={`mt-1 text-[30px] font-semibold ${data.ready === 'Yes' ? 'text-ink' : 'text-failing'}`}>{data.ready}</div>
          <div className="mt-1 text-[13px] text-dim">{data.why}</div>
          <div className="mt-3 text-[12px] text-faint">{data.rule}</div>
          {data.read_errors.length > 0 && <div className="mt-2 text-[12px] text-degraded">Could not read: {data.read_errors.join('; ')}</div>}
        </div>
      </div>
      <StatStrip cols={4}>
        <StatCell><Stat label="Blocking now" value={data.blocking.length} hint="gates not passed and items still open" size="lg" /></StatCell>
        <StatCell><Stat label="Items on the board" value={data.items.length} hint={`${data.items_closed} closed`} size="lg" /></StatCell>
        <StatCell><Stat label="CST loops open" value={cst ? cst.open_loops : '—'} hint={cst ? `${cst.moving} moving, ${cst.stalled} stalled` : 'not read'} size="lg" /></StatCell>
        <StatCell><Stat label="CST watches open" value={cst ? cst.open_watches : '—'} hint="Decision Watches on the CST lane" size="lg" /></StatCell>
      </StatStrip>
      <h2 className="px-6 pb-2 pt-4 text-[15px] font-semibold text-ink md:px-8">What is blocking</h2>
      {data.blocking.length === 0 ? <EmptyState>Nothing is blocking.</EmptyState> : <Rows rows={data.blocking} label="Blocking" />}
      <h2 className="px-6 pb-2 pt-6 text-[15px] font-semibold text-ink md:px-8">Everything on the board</h2>
      {data.items.length === 0 ? <EmptyState>No loop or watch has been put on the board yet.</EmptyState> : <Rows rows={[...data.gates, ...data.items]} label="All items" />}
      <h2 className="px-6 pb-2 pt-6 text-[15px] font-semibold text-ink md:px-8">CST lane: stalled loops</h2>
      <p className="px-6 pb-3 text-[12px] text-faint md:px-8">{cst?.stalled_rule ?? 'The CST summary could not be read.'}</p>
      {cst && cst.stalled_loops.length > 0 ? (
        <TableFrame grow={false} label="Stalled CST loops">
          <thead><tr><Th>Loop</Th><Th>What</Th><Th>Owner</Th><Th>Days since a change</Th></tr></thead>
          <tbody>
            {cst.stalled_loops.map((l) => (
              <tr key={l.loop_id} className="border-b border-line align-top">
                <td className="tabular whitespace-nowrap px-3 py-2"><a className="text-accent hover:underline" href={l.link}>{l.loop_id}</a></td>
                <td className="max-w-[60ch] px-3 py-2 text-ink">{l.what}</td>
                <td className="px-3 py-2 text-dim">{l.owner ?? <span className="text-faint">none</span>}</td>
                <td className="tabular px-3 py-2 text-dim">{l.days_since_change}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      ) : cst ? <EmptyState>No CST loop is stalled.</EmptyState> : null}
      <div className="h-8" />
    </div>
  );
}
