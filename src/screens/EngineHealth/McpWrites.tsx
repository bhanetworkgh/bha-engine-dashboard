import { useData } from '../../app/useData';
import { getMcpWrites, type McpWrite } from '../../data';
import { Card, CardHeader, EmptyState, LoadFailed, Loading, Pagination, Pill, RecordId, TableFrame, Th, usePaged } from '../../components/ui';
import { when } from './parts';

/**
 * Recent MCP writes (2026-09-24, Destiny).
 *
 * Every call to an MCP write tool — create, update, archive, delete — as the
 * server audited it in `engine_mcp_writes`, **refused and dry-run calls
 * included**. A refusal is the guard doing its job, so it is drawn plainly,
 * not as a failure: `possible_duplicate` and `lane_owner_mismatch` are the
 * Tools Router asking a person, which is the point of porting it.
 *
 * Colour marks only what needs somebody: a write the store itself refused
 * after every guard passed, which is a fault rather than a guard. A delete is
 * the accent — something is gone and worth reading — never green.
 */

function OutcomePill({ w }: { w: McpWrite }) {
  if (w.dry_run) return <Pill>dry run</Pill>;
  switch (w.outcome) {
    case 'refused':
      return <Pill>refused{w.reason ? ` · ${w.reason.replace(/_/g, ' ')}` : ''}</Pill>;
    case 'rejected':
      return <Pill tone="failing">store refused</Pill>;
    case 'pending':
      return <Pill tone="degraded">not finished</Pill>;
    case 'deleted':
      return <Pill tone="accent">deleted</Pill>;
    default:
      return <Pill>{w.outcome.replace(/_/g, ' ')}</Pill>;
  }
}

export default function McpWrites() {
  const { status, data, error } = useData(getMcpWrites, [], { kinds: ['loops', 'codex', 'patterns', 'commercial', 'pattern_candidates', 'rt-jobs', 'lane_backlog', 'builder_profiles'] });
  const paged = usePaged(data?.writes ?? [], 'all');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Card className="pb-3">
        <CardHeader title="Recent MCP writes" right={<span className="tabular text-[11.5px] text-faint">last {data.writes.length}, newest first</span>} />
        <p className="px-5 pb-2 text-[12px] text-dim">
          {data.write_configured
            ? 'Every create, update, archive and delete made over the MCP write connection, as the server recorded it — including calls a guard refused and dry runs, which wrote nothing.'
            : 'MCP_WRITE_TOKEN is not set on this server, so no MCP client can write. Anything below is from before it was unset.'}
        </p>
        {data.writes.length === 0 ? (
          <EmptyState compact>No MCP write has been made yet. The first call to create_record, update_record, archive_record or delete_record will appear here, whatever came of it.</EmptyState>
        ) : (
          <TableFrame flat grow={false} label="Recent MCP writes">
            <thead>
              <tr>
                <Th>when</Th>
                <Th>tool</Th>
                <Th>kind</Th>
                <Th>record</Th>
                <Th>outcome</Th>
                <Th>requester</Th>
                <Th>detail</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((w) => (
                <tr key={w.id}>
                  <td className="td tabular whitespace-nowrap text-faint">{when(w.at)}</td>
                  <td className="td whitespace-nowrap">{w.tool.replace(/_record$/, '')}</td>
                  <td className="td text-dim">{w.kind ?? '—'}</td>
                  <td className="td td-clip" style={{ maxWidth: '26ch' }} title={w.natural_id ?? w.record_id ?? undefined}>
                    {w.natural_id || w.record_id ? <RecordId>{w.natural_id ?? `row ${w.record_id}`}</RecordId> : <span className="text-faint">none</span>}
                  </td>
                  <td className="td">
                    <OutcomePill w={w} />
                  </td>
                  <td className="td tabular text-faint">{w.requester_user_id ?? '—'}</td>
                  <td className="td td-clip text-dim" style={{ maxWidth: '56ch' }} title={w.detail ?? undefined}>
                    {w.detail ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </Card>
      <Pagination paged={paged} unit="writes" />
    </div>
  );
}
