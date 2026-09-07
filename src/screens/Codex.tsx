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

      <div className="grid shrink-0 grid-cols-4 border-b border-line">
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Logged this week</div>
          <div className="tabular text-[17px] leading-tight text-gold">{data.this_week}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Entries held</div>
          <div className="tabular text-[17px] leading-tight">{data.entries.length}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Ingested into BHARAG</div>
          <div className="tabular text-[17px] leading-tight">{data.ingested_rate}</div>
        </div>
        <div className="px-4 py-2">
          <div className="text-[11px] text-faint">Posted only</div>
          <div className="tabular text-[17px] leading-tight text-degraded">
            {data.entries.filter((e) => !e.ingested).length}
          </div>
        </div>
      </div>

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
                <td className="td text-dim">{BUILDER_NAMES[e.builder_id] ?? e.builder_id}</td>
                <td className="td text-faint">{e.session_type}</td>
                <td className="td td-clip" style={{ maxWidth: '46ch' }} title={e.title}>
                  {e.title}
                </td>
                <td className="td"><TagRow tags={e.tags} /></td>
                <td className="td">
                  {e.narration_url ? (
                    <a href={e.narration_url} target="_blank" rel="noreferrer"
                      className="text-faint underline decoration-line underline-offset-2 hover:text-gold hover:decoration-gold-dim">
                      open
                    </a>
                  ) : (
                    <span className="text-degraded">not linked</span>
                  )}
                </td>
                <td className={`td ${e.ingested ? 'text-dim' : 'text-degraded'}`}>
                  {e.ingested ? 'yes' : 'posted only'}
                </td>
                <SpineCells spine={e.spine} />
                <td className="td"><SourceLink source={e.source} /></td>
                <td className="td">
                  <RowActions>
                    <RowAction label="re-ingest" onClick={() => act('codex.reingest', e.id)} />
                    <RowAction label="open in Slack" onClick={() => act('codex.open-slack', e.id)} />
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
