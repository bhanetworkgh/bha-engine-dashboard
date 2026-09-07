import type { OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import {
  EmptyState,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  TagRow,
  Th,
} from '../../components/ui';
import { act, ageTone } from '../../lib';

/** The loop list itself, grouped by owner and sorted oldest first. */
export function Loops({
  data,
  loops,
  owner,
  setOwner,
}: {
  data: OpenLoopsData;
  loops: OpenLoopsData['loops'];
  owner: string;
  setOwner: (o: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Grouped by owner, so where work is piling up is visible at a glance. */}
      <div className="scroll-thin flex shrink-0 items-stretch overflow-x-auto border-b border-line md:overflow-x-visible">
        <button
          type="button"
          onClick={() => setOwner('all')}
          className={`border-r border-line px-3 py-1.5 text-left ${
            owner === 'all' ? 'bg-raised' : 'hover:bg-hover'
          }`}
        >
          <div className="text-[11px] text-faint">All owners</div>
          <div className="tabular text-[15px] leading-tight">
            {data.by_owner.reduce((n, o) => n + o.open, 0)}
          </div>
        </button>
        {data.by_owner.map((o) => (
          <button
            key={o.owner}
            type="button"
            onClick={() => setOwner(o.owner)}
            className={`shrink-0 border-r border-line px-3 py-1.5 text-left last:border-r-0 md:flex-1 md:shrink ${
              owner === o.owner ? 'bg-raised' : 'hover:bg-hover'
            }`}
          >
            <div className="text-[11px] text-faint">{BUILDER_NAMES[o.owner] ?? o.owner}</div>
            <div className="flex items-baseline gap-2">
              <span className="tabular text-[15px] leading-tight">{o.open}</span>
              <span className={`tabular text-[11px] ${ageTone(o.oldest_days)}`}>
                {o.oldest_days}d
              </span>
            </div>
          </button>
        ))}
      </div>

      <p className="shrink-0 border-b border-line px-4 py-1 text-[11px] text-faint">
        {data.status_history_note}
      </p>

      {loops.length === 0 ? (
        <EmptyState>
          No loops match the selected lane and owner. The per-owner counts above are
          totals; the rows here are the loops this dashboard currently holds.
        </EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th className="text-right">age</Th>
              <Th>loop</Th>
              <Th>title</Th>
              <Th>tags</Th>
              <Th>owner</Th>
              <Th>status</Th>
              {SPINE_HEADERS.map((h) => (
                <Th key={h}>{h}</Th>
              ))}
              <Th>raised</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {loops.map((l) => (
              <tr key={l.id}>
                <td className={`td card-meta tabular text-right ${ageTone(l.age_days)}`} title="Days since raised">
                  {l.age_days}d
                </td>
                <td className="td tabular text-faint">{l.id}</td>
                <td className="td card-title td-clip" style={{ maxWidth: '52ch' }} title={l.title}>
                  {l.title}
                </td>
                <td className="td"><TagRow tags={l.tags} /></td>
                <td className="td card-meta text-dim">{BUILDER_NAMES[l.owner] ?? l.owner}</td>
                <td className={`td card-meta ${l.status === 'in progress' ? 'text-dim' : 'text-faint'}`}>
                  {l.status}
                </td>
                <SpineCells spine={l.spine} />
                <td className="td tabular text-faint">{l.raised_at}</td>
                <td className="td">
                  <SourceLink source={l.source} />
                </td>
                <td className="td card-actions">
                  <RowActions>
                    <RowAction label="close" onClick={() => act('loop.close', l.id)} />
                    <RowAction label="update" onClick={() => act('loop.update', l.id)} />
                    <RowAction
                      label="open in Slack"
                      onClick={() => act('loop.open-slack', l.id)}
                    />
                  </RowActions>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </div>
  );
}
