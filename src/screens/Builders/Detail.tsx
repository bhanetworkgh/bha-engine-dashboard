import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData } from '../../app/useData';
import { getBuilder, type Query } from '../../data';
import {
  EmptyState,
  LoadFailed,
  Loading,
  PageHeader,
  RowAction,
  RowActions,
  SourceLink,
  TagRow,
  Th,
} from '../../components/ui';
import { act, ageTone, errorClassLabel, healthText, laneLabel } from '../../lib';

export function BuilderPage() {
  const { id = '' } = useParams();
  const fetcher = useCallback((q: Query) => getBuilder(id, q), [id]);
  const { status, data, error } = useData(fetcher, [id]);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;
  if (!data) return <EmptyState>No builder is recorded under that id.</EmptyState>;

  const b = data.builder;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={b.name}
        subtitle={laneLabel(b.lane)}
        right={<Link to="/builders" className="text-[12px] text-faint hover:text-ink">← all builders</Link>}
      />

      <div className="grid shrink-0 grid-cols-2 border-b border-line md:grid-cols-5">
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Open loops</div>
          <div className="tabular text-[17px] leading-tight text-gold">{b.open_loops}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Oldest loop</div>
          <div className={`tabular text-[17px] leading-tight ${ageTone(b.oldest_loop_days)}`}>
            {b.oldest_loop_days}d
          </div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Entries this week</div>
          <div className="tabular text-[17px] leading-tight">{b.entries_this_week}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Contract</div>
          <div className={`text-[17px] leading-tight ${b.contract_status === 'signed' ? '' : 'text-degraded'}`}>
            {b.contract_status}
          </div>
        </div>
        <div className="px-4 py-2">
          <div className="text-[11px] text-faint">Last activity</div>
          <div className="tabular text-[13px] leading-tight text-dim">{b.last_activity}</div>
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <h3 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
          Loops held here
        </h3>
        {data.loops.length === 0 ? (
          <EmptyState>
            This dashboard holds no individual loop rows for {b.name} in the selected lane.
            The count above is the table total; the rows are what has been pulled through.
          </EmptyState>
        ) : (
          <table className="table-cards w-full text-[12px]">
            <thead>
              <tr>
                <Th className="text-right">age</Th>
                <Th>loop</Th>
                <Th>title</Th>
                <Th>tags</Th>
                <Th>status</Th>
                <Th>source</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.loops.map((l) => (
                <tr key={l.id}>
                  <td className={`td card-meta tabular text-right ${ageTone(l.age_days)}`}>{l.age_days}d</td>
                  <td className="td tabular text-faint">{l.id}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '54ch' }} title={l.title}>{l.title}</td>
                  <td className="td"><TagRow tags={l.tags} /></td>
                  <td className="td card-meta text-faint">{l.status}</td>
                  <td className="td"><SourceLink source={l.source} /></td>
                  <td className="td card-actions">
                    <RowActions>
                      <RowAction label="close" onClick={() => act('loop.close', l.id)} />
                      <RowAction label="update" onClick={() => act('loop.update', l.id)} />
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 className="border-y border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
          Codex entries
        </h3>
        {data.entries.length === 0 ? (
          <EmptyState>No Codex entries from {b.name} in the selected lane.</EmptyState>
        ) : (
          <table className="table-cards w-full text-[12px]">
            <thead>
              <tr>
                <Th>logged</Th><Th>week</Th><Th>type</Th><Th>title</Th><Th>ingested</Th><Th>source</Th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="td tabular text-faint">{e.logged_at}</td>
                  <td className="td tabular text-faint">{e.week}</td>
                  <td className="td card-meta text-faint">{e.session_type}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '54ch' }}>{e.title}</td>
                  <td className={`td card-meta ${e.ingested ? 'text-dim' : 'text-degraded'}`}>
                    {e.ingested ? 'yes' : 'posted only'}
                  </td>
                  <td className="td"><SourceLink source={e.source} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 className="border-y border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
          Incidents opened on their work
        </h3>
        {data.incidents.length === 0 ? (
          <EmptyState>No incidents are attributed to {b.name} in the selected lane.</EmptyState>
        ) : (
          <table className="table-cards w-full text-[12px]">
            <thead>
              <tr>
                <Th>incident</Th><Th>summary</Th><Th>class</Th><Th>state</Th><Th>opened</Th><Th>source</Th>
              </tr>
            </thead>
            <tbody>
              {data.incidents.map((i) => (
                <tr key={i.id}>
                  <td className="td tabular">{i.id}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '44ch' }}>{i.summary}</td>
                  <td className={`td card-meta ${healthText(i.health)}`}>{errorClassLabel(i.error_class)}</td>
                  <td className={`td card-meta ${i.state === 'resolved' ? 'text-dim' : healthText(i.health)}`}>
                    {i.state}
                  </td>
                  <td className="td tabular text-faint">{i.opened_at}</td>
                  <td className="td"><SourceLink source={i.source} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
