import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getBlockers, getIncomeBoard, getKnowledge, setBlocked, setKnowledge, type BlockedLoop, type IncomeBlocker, type KnowledgeRow } from '../data';
import { Button, EmptyState, LoadFailed, Loading, PageHeader, Pill, SearchBox, Stat, StatCell, StatStrip, TableFrame, Tabs, Th, Toast, relativeTime, useToast } from '../components/ui';

const VIEWS = ['Board', 'Blockers', 'Knowledge capture'] as const;
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
function DateCell({ b }: { b: IncomeBlocker }) {
  if (b.date_state === 'slipped') return <Pill tone="failing">{b.target_date} · slipped {b.days_slipped}d</Pill>;
  if (b.date_state === 'date_to_set') return <span className="text-degraded">date_to_set</span>;
  return b.target_date ? <span className="text-dim">{b.target_date}</span> : <span className="text-faint">none</span>;
}

function Rows({ rows, label }: { rows: IncomeBlocker[]; label: string }) {
  return (
    <TableFrame grow={false} label={label}>
      <thead>
        <tr>
          <Th>Id</Th>
          <Th>What</Th>
          <Th>Status</Th>
          <Th>Owner</Th>
          <Th>Target date</Th>
          <Th>Impact</Th>
          <Th>Why it is on the board</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} className="border-b border-line align-top">
            <td className="tabular whitespace-nowrap px-3 py-2">{b.link ? <a className="text-accent hover:underline" href={b.link}>{b.id.length > 12 ? b.id.slice(-4) : b.id}</a> : <span className="text-ink">{b.id}</span>}</td>
            <td className="max-w-[48ch] px-3 py-2 text-ink">{b.title}</td>
            <td className="px-3 py-2">{b.open ? <Pill tone="failing">{b.status}</Pill> : <span className="text-dim">{b.status}</span>}</td>
            <td className="px-3 py-2 text-dim">{b.owner ?? <span className="text-faint">none</span>}</td>
            <td className="tabular whitespace-nowrap px-3 py-2"><DateCell b={b} /></td>
            <td className="whitespace-nowrap px-3 py-2">{b.kind === 'gate' ? <span className="text-faint">gate</span> : b.impact === 'BLOCKS_PILOT_1' ? <span className="font-medium text-ink">BLOCKS_PILOT_1</span> : <span className="text-dim">QUALITY_OF_LIFE</span>}</td>
            <td className="max-w-[44ch] px-3 py-2 text-dim">{b.reason}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

export default function IncomeBoard() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab');
  const view: View = tab === 'blockers' ? 'Blockers' : tab === 'knowledge' ? 'Knowledge capture' : 'Board';
  const setView = (v: View) => setParams(v === 'Blockers' ? { tab: 'blockers' } : v === 'Knowledge capture' ? { tab: 'knowledge' } : {}, { replace: true });
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
  if (view === 'Knowledge capture') {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        <PageHeader title="Production-Income Board" subtitle="Knowledge capture" />
        {tabs}
        <Knowledge />
      </div>
    );
  }
  return <BoardView tabs={tabs} />;
}

const PEOPLE: [string, string][] = [['U0AEW3TBYH1', 'Destiny'], ['U0A9V97949F', 'Jason'], ['U0AF011R821', 'Jegan'], ['U0BKT6MAW2Y', 'Hardik'], ['U0AC6RFNP3P', 'Ahad'], ['U0BNQGG020Y', 'Kavin']];
const STATUS_TEXT: Record<KnowledgeRow['status'], string> = { not_started: 'Not started', in_progress: 'In progress', captured: 'Captured' };
const MARK_TEXT: Record<KnowledgeRow['mark'], string> = { BLOCKS_PILOT_1: 'Blocks Pilot 1', KNOWLEDGE_CAPTURE_REQUIRED: 'Capture required' };

/** What only one person knows that the paid pilot needs written down (23 Nov 2026, Destiny). */
function Knowledge() {
  const [bump, setBump] = useState(0);
  const { status, data, error } = useData(getKnowledge, [bump], { kinds: ['income_board'] });
  const [holder, setHolder] = useState('all');
  const [mark, setMark] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<KnowledgeRow | null>(null);
  const { toast, setToast } = useToast();
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => (holder === 'all' || r.holder === holder) && (mark === 'all' || r.mark === mark)
      && (!needle || [r.item_id, r.area, r.piece, r.notes, r.picked_up_by_name, ...r.lives_in.map((l) => l.ref)].some((v) => (v ?? '').toLowerCase().includes(needle))));
  }, [data, holder, mark, q]);
  if (!data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const holders = Object.entries(data.by_holder).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <>
      <StatStrip cols={4}>
        <StatCell><Stat label="Pieces of knowledge" value={data.total} hint={`${data.blocks_pilot} block Pilot 1`} size="lg" /></StatCell>
        <StatCell><Stat label="Captured" value={data.captured} hint={`of ${data.total}, each with proof`} size="lg" /></StatCell>
        <StatCell><Stat label="Nobody picking up" value={data.no_pickup} hint={`${data.no_date} with no handover date`} size="lg" /></StatCell>
        <StatCell><Stat label="To confirm" value={data.to_confirm} hint={data.late ? `${data.late} past their handover date` : 'drafted from the records'} size="lg" /></StatCell>
      </StatStrip>
      <p className="px-6 pb-3 pt-3 text-[12px] text-faint md:px-8">{data.rule}</p>
      <div className="flex flex-wrap items-center gap-3 px-6 pb-3 md:px-8">
        <SearchBox value={q} onChange={setQ} placeholder="Search areas, repos, loops" />
        <label className="text-[12.5px] text-dim">
          Holder{' '}
          <select className="input ml-1 inline-block w-auto py-1 text-[12.5px]" value={holder} onChange={(e) => setHolder(e.target.value)}>
            <option value="all">Everyone ({data.total})</option>
            {holders.map(([name, n]) => { const id = PEOPLE.find((p) => p[1] === name)?.[0] ?? name; return <option key={id} value={id}>{name} ({n})</option>; })}
          </select>
        </label>
        <label className="text-[12.5px] text-dim">
          Mark{' '}
          <select className="input ml-1 inline-block w-auto py-1 text-[12.5px]" value={mark} onChange={(e) => setMark(e.target.value)}>
            <option value="all">Both</option>
            <option value="BLOCKS_PILOT_1">Blocks Pilot 1</option>
            <option value="KNOWLEDGE_CAPTURE_REQUIRED">Capture required</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <EmptyState>{data.total === 0 ? 'No knowledge capture row has been written yet.' : 'No row matches.'}</EmptyState>
      ) : (
        <TableFrame grow={false} label="Knowledge capture">
          <thead><tr><Th>Area</Th><Th>What has to be written down</Th><Th>Holder</Th><Th>Mark</Th><Th>Picked up by</Th><Th>Handover</Th><Th>Status</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_id} className="cursor-pointer border-b border-line align-top hover:bg-hover" onClick={() => setOpen(r)}>
                <td className="px-3 py-2 text-ink">{r.area}</td>
                <td className="max-w-[56ch] px-3 py-2 text-ink">{r.piece.length > 180 ? `${r.piece.slice(0, 180)}…` : r.piece}{r.to_confirm && <div className="mt-1 text-[12px] text-degraded">To confirm: {r.to_confirm}</div>}</td>
                <td className="px-3 py-2 text-dim">{r.holder_name}</td>
                <td className="px-3 py-2"><span className={r.mark === 'BLOCKS_PILOT_1' ? 'font-medium text-ink' : 'text-dim'}>{MARK_TEXT[r.mark]}</span></td>
                <td className="px-3 py-2 text-dim">{r.picked_up_by_name ?? <span className="text-faint">nobody yet</span>}</td>
                <td className="tabular whitespace-nowrap px-3 py-2">{r.handover_date ? (r.late ? <Pill tone="failing">{r.handover_date} · late</Pill> : <span className="text-dim">{r.handover_date}</span>) : <span className="text-faint">not set</span>}</td>
                <td className="px-3 py-2 text-dim">{STATUS_TEXT[r.status]}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
      {open && <KnowledgeDialog row={open} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); setToast({ text: t, tone: 'ok' }); setBump((n) => n + 1); }} onError={(t) => setToast({ text: t, tone: 'failing' })} />}
      <Toast toast={toast} />
      <div className="h-8" />
    </>
  );
}

/** One row: where the knowledge lives, and the handover fields Destiny or Jason edit (behind the admin login). */
function KnowledgeDialog({ row, onClose, onDone, onError }: { row: KnowledgeRow; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [pick, setPick] = useState(row.picked_up_by ?? '');
  const [date, setDate] = useState(row.handover_date ?? '');
  const [st, setSt] = useState(row.status);
  const [proof, setProof] = useState(row.proof_ref ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const save = async () => {
    setBusy(true);
    try {
      await setKnowledge({ item_id: row.item_id, picked_up_by: pick, handover_date: date, status: st, proof_ref: proof, notes });
      onDone(`${row.area} saved.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'It could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const field = 'input mt-1 w-full py-1.5 text-[13px]';
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[720px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Knowledge capture">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{row.item_id} · {MARK_TEXT[row.mark]}</div>
            <div className="mt-1 text-[15px] font-semibold text-ink">{row.area}</div>
            <div className="mt-1 text-[13px] text-ink">{row.piece}</div>
            <div className="mt-1 text-[12px] text-dim">Held by {row.holder_name}</div>
            {row.to_confirm && <div className="mt-1 text-[12px] text-degraded">To confirm: {row.to_confirm}</div>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="mt-4 text-[12.5px] font-medium text-ink">Where it lives</div>
        {row.lives_in.length === 0 ? <div className="mt-1 text-[12.5px] text-faint">Nothing named yet.</div> : (
          <ul className="mt-1 grid gap-1 text-[12.5px]">
            {row.lives_in.map((l, i) => <li key={i} className="text-dim"><span className="text-faint">{l.kind}</span> {l.url ? <a className="text-accent hover:underline" href={l.url} target="_blank" rel="noreferrer">{l.ref}</a> : <span className="text-ink">{l.ref}</span>}</li>)}
          </ul>
        )}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-[12.5px] text-dim">Picked up by
            <select className={field} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Nobody yet</option>
              {PEOPLE.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
          </label>
          <label className="text-[12.5px] text-dim">Handover date<input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="text-[12.5px] text-dim">Status
            <select className={field} value={st} onChange={(e) => setSt(e.target.value as KnowledgeRow['status'])}>
              {(Object.keys(STATUS_TEXT) as KnowledgeRow['status'][]).map((k) => <option key={k} value={k}>{STATUS_TEXT[k]}</option>)}
            </select>
          </label>
          <label className="text-[12.5px] text-dim">Proof (EV- id, SOP id or link)<input className={field} value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Needed to mark it captured" /></label>
        </div>
        <label className="mt-3 block text-[12.5px] text-dim">Notes<textarea className={field} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div className="mt-2 text-[12px] text-faint">Saving is behind the admin login.</div>
        <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></div>
      </div>
    </div>,
    document.body,
  );
}

function BoardView({ tabs }: { tabs: ReactNode }) {
  const { status, data, error } = useData(getIncomeBoard, [], { kinds: ['loops', 'income_board'] });
  const [params, setParams] = useSearchParams();
  const ownerKey = params.get('owner') ?? 'everyone';
  if (!data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const cst = data.cst;
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const view = data.owner_views.find((v) => v.key === ownerKey) ?? null;
  const mine = view ? new Set([...view.blocks_pilot_1, ...view.quality_of_life]) : null;
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((x): x is IncomeBlocker => !!x && (!mine || mine.has(x.id)));
  const ownerTabs = [{ key: 'everyone', label: 'Everyone' }, ...data.owner_views.map((v) => ({ key: v.key, label: v.label }))];
  const openBlocking = data.items.filter((i) => i.open && i.impact === 'BLOCKS_PILOT_1');
  const Gate = ({ id }: { id: 'STAGE1_PASSED' | 'CHARGE_GATE_OPEN' }) => {
    const g = data.gates.find((x) => x.id === id);
    return (
      <div className="mt-3 border-t border-line pt-3">
        <div className="text-[13px]"><span className="tabular font-medium text-ink">{id}</span>: <span className={data.fields[id] ? 'text-ink' : 'text-failing'}>{data.fields[id] ? 'true' : 'false'}</span></div>
        {g && <div className="mt-0.5 text-[12.5px] text-dim">{g.reason}</div>}
      </div>
    );
  };
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Production-Income Board" subtitle={`${data.board_key} · read ${relativeTime(data.read_at) ?? 'just now'}`} />
      {tabs}
      <div className="px-6 pb-4 md:px-8">
        <div className="card p-5">
          <div className="text-[13px] text-dim">{data.question}?</div>
          <div className={`mt-1 text-[30px] font-semibold ${data.ready === 'Yes' ? 'text-ink' : 'text-failing'}`}>{data.ready}</div>
          <div className="mt-1 text-[13px] text-dim">{data.why}</div>
          <Gate id="STAGE1_PASSED" />
          <Gate id="CHARGE_GATE_OPEN" />
          <div className="mt-3 text-[12px] text-faint">{data.rule}</div>
          {data.read_errors.length > 0 && <div className="mt-2 text-[12px] text-degraded">Could not read: {data.read_errors.join('; ')}</div>}
        </div>
      </div>
      <StatStrip cols={4}>
        <StatCell><Stat label="Blocking Pilot 1" value={openBlocking.length} hint={`open items marked BLOCKS_PILOT_1, of ${data.items.length} on the board`} size="lg" /></StatCell>
        <StatCell><Stat label="Slipped" value={data.this_week.slipped.length} hint="open and past their target date" size="lg" /></StatCell>
        <StatCell><Stat label="Date to set" value={data.this_week.date_to_set} hint="open with no target date" size="lg" /></StatCell>
        <StatCell><Stat label="Moved this week" value={data.this_week.moved.length} hint={cst ? `${cst.stalled} CST loops stalled 7 days or more` : `since ${data.this_week.since}`} size="lg" /></StatCell>
      </StatStrip>
      <div className="px-6 pt-4 md:px-8">
        <Tabs tabs={ownerTabs.map((t) => t.label)} value={ownerTabs.find((t) => t.key === (view ? view.key : 'everyone'))?.label ?? 'Everyone'} onChange={(label) => { const k = ownerTabs.find((t) => t.label === label)?.key ?? 'everyone'; const next = new URLSearchParams(params); if (k === 'everyone') next.delete('owner'); else next.set('owner', k); setParams(next, { replace: true }); }} />
      </div>
      {view && (
        <p className="px-6 pt-3 text-[13px] text-dim md:px-8">
          {view.label} owe{view.label.includes(' and ') ? '' : 's'} {view.blocks_pilot_1.length} item{view.blocks_pilot_1.length === 1 ? '' : 's'} that block Pilot 1{view.quality_of_life.length ? ` and ${view.quality_of_life.length} quality of life` : ''}
          {view.slipped ? <>, <span className="text-failing">{view.slipped} slipped</span></> : ''}{view.date_to_set ? `, ${view.date_to_set} with no date` : ''}. Soonest first within each section.
        </p>
      )}
      {data.sections.map((sec) => {
        const rem = pick(sec.remaining);
        const done = pick(sec.done);
        if (view && !rem.length && !done.length) return null;
        return (
          <section key={sec.key}>
            <h2 className="px-6 pb-1 pt-6 text-[15px] font-semibold text-ink md:px-8">{sec.label} <span className="text-[12.5px] font-normal text-dim">· {rem.length} remaining, {done.length} done</span></h2>
            <p className="px-6 pb-2 text-[12px] text-faint md:px-8">{sec.covers}</p>
            {sec.empty_note ? <EmptyState>{sec.empty_note}</EmptyState> : <Rows rows={[...rem, ...done]} label={sec.label} />}
          </section>
        );
      })}
      {!view && (
        <>
          <h2 className="px-6 pb-2 pt-6 text-[15px] font-semibold text-ink md:px-8">This week</h2>
          <p className="px-6 pb-2 text-[12px] text-faint md:px-8">Since {data.this_week.since}. {data.this_week.rule}</p>
          <div className="px-6 text-[13px] text-dim md:px-8">
            <div><span className="text-ink">Moved:</span> {data.this_week.moved.length ? data.this_week.moved.map((m, k) => <span key={m.id}>{k ? ', ' : ''}{m.link ? <a className="text-accent hover:underline" href={m.link}>{m.id.slice(-4)}</a> : m.id.slice(-4)} ({m.owner ?? 'no owner'})</span>) : 'nothing on the board moved.'}</div>
            <div className="mt-1"><span className="text-ink">Slipped:</span> {data.this_week.slipped.length ? data.this_week.slipped.map((m, k) => <span key={m.id}>{k ? ', ' : ''}{m.link ? <a className="text-accent hover:underline" href={m.link}>{m.id.slice(-4)}</a> : m.id.slice(-4)} ({m.owner ?? 'no owner'}, {m.days_slipped}d past {m.target_date})</span>) : 'no date has slipped.'}</div>
          </div>
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
        </>
      )}
      <div className="h-8" />
    </div>
  );
}
