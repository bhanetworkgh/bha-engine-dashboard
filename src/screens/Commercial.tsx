import { useData } from '../app/useData';
import { BUILDER_NAMES, getCommercial, type Readiness } from '../data';
import {
  Dot,
  EmptyState,
  LoadFailed,
  Loading,
  PageHeader,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  Th,
} from '../components/ui';
import { act, healthText } from '../lib';

/** Readiness states in order, so a card's position in the run-up is visible. */
const ORDER: Readiness[] = ['idea', 'researching', 'evidence thin', 'ready to pitch', 'blocked'];

export default function Commercial() {
  const { status, data, error } = useData(getCommercial);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const counts = ORDER.map((r) => ({
    readiness: r,
    n: data.opportunities.filter((o) => o.readiness === r).length,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Commercial" subtitle="Opportunities and readiness" />

      <div className="grid shrink-0 grid-cols-5 border-b border-line">
        {counts.map((c) => (
          <div key={c.readiness} className="border-r border-line px-4 py-2 last:border-r-0">
            <div className="text-[11px] text-faint">{c.readiness}</div>
            <div
              className={`tabular text-[17px] leading-tight ${
                c.readiness === 'blocked' && c.n ? 'text-failing'
                  : c.readiness === 'evidence thin' && c.n ? 'text-degraded'
                  : c.readiness === 'ready to pitch' && c.n ? 'text-gold' : ''
              }`}
            >
              {c.n}
            </div>
          </div>
        ))}
      </div>

      {data.opportunities.length === 0 ? (
        <EmptyState>No commercial opportunities recorded for the selected lane.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th />
              <Th>card</Th>
              <Th>title</Th>
              <Th>readiness</Th>
              <Th>blocker</Th>
              <Th>owner</Th>
              {SPINE_HEADERS.map((h) => <Th key={h}>{h}</Th>)}
              <Th>last touched</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.opportunities.map((o) => (
              <tr key={o.id}>
                <td className="td"><Dot health={o.health} /></td>
                <td className="td tabular text-faint">{o.id}</td>
                <td className="td td-clip" style={{ maxWidth: '40ch' }}>{o.title}</td>
                <td className={`td ${healthText(o.health)}`}>{o.readiness}</td>
                <td className="td td-clip text-faint" style={{ maxWidth: '46ch' }}>{o.blocker ?? '—'}</td>
                <td className="td text-dim">{BUILDER_NAMES[o.owner] ?? o.owner}</td>
                <SpineCells spine={o.spine} />
                <td className="td tabular text-faint">{o.last_touched}</td>
                <td className="td"><SourceLink source={o.source} /></td>
                <td className="td">
                  <RowActions>
                    <RowAction label="re-research" onClick={() => act('commercial.reresearch', o.id)} />
                    <RowAction label="open in Slack" onClick={() => act('commercial.open-slack', o.id)} />
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
