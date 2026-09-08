import { useData } from '../app/useData';
import { BUILDER_NAMES, getCodexEntries } from '../data';
import {
  EmptyState,
  LoadFailed,
  Loading,
  PageHeader,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  Stat,
  StatCell,
  StatStrip,
  TableFrame,
  TagRow,
  Th,
} from '../components/ui';
import { act } from '../lib';

export default function Codex() {
  const { status, data, error } = useData(getCodexEntries);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Codex entries" subtitle="By builder and week" />

      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Logged this week" value={data.this_week} tone="accent" />
        </StatCell>
        <StatCell>
          <Stat label="Entries held" value={data.entries.length} />
        </StatCell>
        <StatCell>
          <Stat label="Ingested into BHARAG" value={data.ingested_rate} />
        </StatCell>
        <StatCell>
          <Stat
            label="Posted only"
            value={data.entries.filter((e) => !e.ingested).length}
            tone={data.entries.some((e) => !e.ingested) ? 'degraded' : 'default'}
          />
        </StatCell>
      </StatStrip>

      {data.entries.length === 0 ? (
        <EmptyState>No Codex entries recorded for the selected lane.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th>logged</Th>
              <Th>week</Th>
              <Th>builder</Th>
              <Th>type</Th>
              <Th>title</Th>
              <Th>tags</Th>
              <Th>narration</Th>
              <Th>ingested</Th>
              {SPINE_HEADERS.map((h) => <Th key={h}>{h}</Th>)}
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={e.id}>
                <td className="td tabular text-faint">{e.logged_at}</td>
                <td className="td tabular text-faint">{e.week}</td>
                <td className="td card-meta text-dim">{BUILDER_NAMES[e.builder_id] ?? e.builder_id}</td>
                <td className="td text-faint">{e.session_type}</td>
                <td className="td card-title td-clip" style={{ maxWidth: '46ch' }} title={e.title}>
                  {e.title}
                </td>
                <td className="td"><TagRow tags={e.tags} /></td>
                <td className="td">
                  {e.narration_url ? (
                    <a href={e.narration_url} target="_blank" rel="noreferrer" className="text-faint hover:text-accent-ink">
                      Open
                    </a>
                  ) : (
                    <span className="text-degraded">not linked</span>
                  )}
                </td>
                <td className={`td card-meta ${e.ingested ? 'text-dim' : 'text-degraded'}`}>
                  {e.ingested ? 'yes' : 'posted only'}
                </td>
                <SpineCells spine={e.spine} />
                <td className="td"><SourceLink source={e.source} /></td>
                <td className="td card-actions td-actions">
                  <RowActions>
                    <RowAction label="Re-ingest" onClick={() => act('codex.reingest', e.id)} />
                    <RowAction label="Open in Slack" onClick={() => act('codex.open-slack', e.id)} />
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
