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
  Stat,
  StatCell,
  StatStrip,
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
  if (!data) return <EmptyState compact>No builder is recorded under that id.</EmptyState>;

  const b = data.builder;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={b.name}
        subtitle={laneLabel(b.lane)}
        right={<Link to="/builders" className="btn btn-ghost btn-sm">All builders</Link>}
      />

      <StatStrip cols={5}>
        <StatCell>
          <Stat label="Open loops" value={b.open_loops} tone="accent" />
        </StatCell>
        <StatCell>
          <Stat label="Oldest loop" value={`${b.oldest_loop_days}d`} tone={b.oldest_loop_days >= 30 ? 'failing' : b.oldest_loop_days >= 14 ? 'degraded' : 'default'} />
        </StatCell>
        <StatCell>
          <Stat label="Entries this week" value={b.entries_this_week} />
        </StatCell>
        <StatCell>
          <Stat label="Contract" value={b.contract_status} tone={b.contract_status === 'signed' ? 'default' : 'degraded'} />
        </StatCell>
        <StatCell>
          <Stat label="Last activity" value={<span className="text-[16px]">{b.last_activity}</span>} tone="dim" />
        </StatCell>
      </StatStrip>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6 md:px-8">
        <h3 className="pb-2 text-[13px] font-medium">Loops held here</h3>
        {data.loops.length === 0 ? (
          <EmptyState compact>
            This dashboard holds no individual loop rows for {b.name} in the selected lane.
            The count above is the table total; the rows are what has been pulled through.
          </EmptyState>
        ) : (
          <div className="card overflow-hidden"><table className="table-cards w-full text-[12.5px]">
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
                  <td className="td card-actions td-actions">
                    <RowActions>
                      <RowAction label="Close" onClick={() => act('loop.close', l.id)} />
                      <RowAction label="Update" onClick={() => act('loop.update', l.id)} />
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}

        <h3 className="pt-6 pb-2 text-[13px] font-medium">Codex entries</h3>
        {data.entries.length === 0 ? (
          <EmptyState compact>No Codex entries from {b.name} in the selected lane.</EmptyState>
        ) : (
          <div className="card overflow-hidden"><table className="table-cards w-full text-[12.5px]">
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
          </table></div>
        )}

        <h3 className="pt-6 pb-2 text-[13px] font-medium">Incidents opened on their work</h3>
        {data.incidents.length === 0 ? (
          <EmptyState compact>No incidents are attributed to {b.name} in the selected lane.</EmptyState>
        ) : (
          <div className="card overflow-hidden"><table className="table-cards w-full text-[12.5px]">
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
          </table></div>
        )}
      </div>
    </div>
  );
}
