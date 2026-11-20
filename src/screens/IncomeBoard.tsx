import { useData } from '../app/useData';
import { getIncomeBoard, type IncomeBlocker } from '../data';
import { EmptyState, LoadFailed, Loading, PageHeader, Pill, Stat, StatCell, StatStrip, TableFrame, Th, relativeTime } from '../components/ui';

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
  const { status, data, error } = useData(getIncomeBoard, [], { kinds: ['loops', 'income_board'] });
  if (!data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const cst = data.cst;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Production-Income Board" subtitle={`${data.board_key} · read ${relativeTime(data.read_at) ?? 'just now'}`} />
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
