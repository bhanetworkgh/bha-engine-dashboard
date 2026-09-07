import { Link, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getBuilder, getBuilders, type Query } from '../data';
import {
  Dot, EmptyState, Loading, LoadFailed, PageHeader, RowAction, RowActions,
  SourceLink, TableFrame, TagRow, Th, act, healthText,
} from '../components/ui';

function ageTone(days: number): string {
  if (days >= 30) return 'text-failing';
  if (days >= 14) return 'text-degraded';
  return 'text-dim';
}

export function Builders() {
  const { status, data, error } = useData(getBuilders);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Builders" subtitle="One row per person" />
      {data.builders.length === 0 ? (
        <EmptyState>No builders work in the selected lane.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th />
              <Th>name</Th>
              <Th>lane</Th>
              <Th className="text-right">open loops</Th>
              <Th className="text-right">oldest loop</Th>
              <Th>last activity</Th>
              <Th>contract</Th>
              <Th className="text-right">entries this week</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.builders.map((b) => (
              <tr key={b.id}>
                <td className="td"><Dot health={b.health} /></td>
                <td className="td">
                  <Link to={`/builders/${b.id}`} className="hover:text-gold">{b.name}</Link>
                </td>
                <td className="td text-faint">{b.lane.toLowerCase()}</td>
                <td className="td tabular text-right">{b.open_loops}</td>
                <td className={`td tabular text-right ${ageTone(b.oldest_loop_days)}`}>
                  {b.oldest_loop_days}d
                </td>
                <td className="td tabular text-faint">{b.last_activity}</td>
                <td className={`td ${b.contract_status === 'signed' ? 'text-faint' : 'text-degraded'}`}>
                  {b.contract_status}
                </td>
                <td className="td tabular text-right text-dim">{b.entries_this_week}</td>
                <td className="td"><SourceLink source={b.source} /></td>
                <td className="td">
                  <RowActions>
                    <RowAction label="open in Slack" onClick={() => act('builder.open-slack', b.id)} />
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
        subtitle={b.lane.toLowerCase()}
        right={<Link to="/builders" className="text-[12px] text-faint hover:text-ink">← all builders</Link>}
      />

      <div className="grid shrink-0 grid-cols-5 border-b border-line">
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
          <table className="w-full text-[12px]">
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
                  <td className={`td tabular text-right ${ageTone(l.age_days)}`}>{l.age_days}d</td>
                  <td className="td tabular text-faint">{l.id}</td>
                  <td className="td td-clip" style={{ maxWidth: '54ch' }} title={l.title}>{l.title}</td>
                  <td className="td"><TagRow tags={l.tags} /></td>
                  <td className="td text-faint">{l.status}</td>
                  <td className="td"><SourceLink source={l.source} /></td>
                  <td className="td">
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
          <table className="w-full text-[12px]">
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
                  <td className="td text-faint">{e.session_type}</td>
                  <td className="td td-clip" style={{ maxWidth: '54ch' }}>{e.title}</td>
                  <td className={`td ${e.ingested ? 'text-dim' : 'text-degraded'}`}>
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
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                <Th>incident</Th><Th>summary</Th><Th>class</Th><Th>state</Th><Th>opened</Th><Th>source</Th>
              </tr>
            </thead>
            <tbody>
              {data.incidents.map((i) => (
                <tr key={i.id}>
                  <td className="td tabular">{i.id}</td>
                  <td className="td td-clip" style={{ maxWidth: '44ch' }}>{i.summary}</td>
                  <td className={`td ${healthText(i.health)}`}>{i.error_class.toLowerCase()}</td>
                  <td className={`td ${i.state === 'resolved' ? 'text-dim' : healthText(i.health)}`}>
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

export { BUILDER_NAMES };
