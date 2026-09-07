import { useData } from '../app/useData';
import { BUILDER_NAMES, getBuildPatterns } from '../data';
import {
  EmptyState,
  LoadFailed,
  Loading,
  PageHeader,
  RowAction,
  RowActions,
  SourceLink,
  TableFrame,
  Th,
} from '../components/ui';
import { act, laneLabel } from '../lib';

export default function BuildPatterns() {
  const { status, data, error } = useData(getBuildPatterns);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const max = Math.max(1, ...data.patterns.map((p) => p.references));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Build patterns" subtitle="By lane, and how often referenced" />
      <p className="shrink-0 border-b border-line px-4 py-1 text-[11px] text-faint">
        {data.reference_note}
      </p>

      {data.patterns.length === 0 ? (
        <EmptyState>No build patterns recorded for the selected lane.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th>code</Th>
              <Th>title</Th>
              <Th>lane</Th>
              <Th>author</Th>
              <Th className="text-right">references</Th>
              <Th />
              <Th>last referenced</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.patterns.map((p) => (
              <tr key={p.id}>
                <td className="td tabular text-faint">{p.code}</td>
                <td className="td card-title td-clip" style={{ maxWidth: '46ch' }}>{p.title}</td>
                <td className="td card-meta text-faint">{laneLabel(p.lane)}</td>
                <td className="td text-dim">{BUILDER_NAMES[p.author] ?? p.author}</td>
                <td className="td card-meta tabular text-right">{p.references}</td>
                <td className="td w-[90px]">
                  {/* Bar, not a chart. Relative reference weight at a glance. */}
                  <span className="block h-[3px] bg-line">
                    <span
                      className="block h-[3px] bg-gold-dim"
                      style={{ width: `${(p.references / max) * 100}%` }}
                    />
                  </span>
                </td>
                <td className="td tabular text-faint">{p.last_referenced ?? 'never'}</td>
                <td className="td"><SourceLink source={p.source} /></td>
                <td className="td card-actions">
                  <RowActions>
                    <RowAction label="open" onClick={() => act('pattern.open', p.id)} />
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
