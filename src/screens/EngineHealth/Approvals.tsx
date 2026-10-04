import { useData } from '../../app/useData';
import { getApprovals, type Approval } from '../../data';
import { Card, CardHeader, EmptyState, LoadFailed, Loading, Pagination, Pill, RecordId, TableFrame, Th, usePaged } from '../../components/ui';
import { when } from './parts';

/**
 * Approvals (2026-10-04, Destiny — LOOP-1790969736142-8185).
 *
 * Every time an agent asked to share a doc, give Drive access or delete a
 * record. An agent does none of those on its own: the request is held here, a
 * card is posted in Slack, and only an approver's click decides.
 *
 * Colour marks only what needs somebody: a request still waiting, a card
 * Slack refused (nobody was asked), and an approved action that then failed.
 * Denied and expired are the gate doing its job and are drawn plainly.
 * Approved is the accent, not green: something was shared, granted or deleted,
 * which is worth reading rather than celebrating.
 */

const TOOL_WORDS: Record<string, string> = {
  share_doc: 'share a doc',
  grant_drive_access: 'give Drive access',
  delete_record: 'delete a record',
};

function StatusPill({ a }: { a: Approval }) {
  switch (a.status) {
    case 'pending':
      return <Pill tone="degraded">waiting on a person</Pill>;
    case 'card_failed':
      return <Pill tone="failing">nobody was asked</Pill>;
    case 'approved':
      if (a.result_ok === false) return <Pill tone="failing">approved, then failed</Pill>;
      if (a.result_ok === null) return <Pill tone="degraded">approved, not run</Pill>;
      return <Pill tone="accent">approved and done</Pill>;
    case 'denied':
      return <Pill>denied</Pill>;
    default:
      return <Pill>expired</Pill>;
  }
}

/** The two approvers, by Slack id. Anyone else is shown by id, which is what the row holds. */
const PEOPLE: Record<string, string> = { U0AEW3TBYH1: 'Destiny', U0A9V97949F: 'Jason' };
const person = (id: string | null): string => (id ? (PEOPLE[id] ?? id) : '—');

function cardLink(a: Approval): string | null {
  return a.card_channel && a.card_ts ? `https://bayshorizonnetwork.slack.com/archives/${a.card_channel}/p${a.card_ts.replace('.', '')}` : null;
}

export default function Approvals() {
  const { status, data, error } = useData(getApprovals, []);
  const paged = usePaged(data?.approvals ?? [], 'all');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  const waiting = data.approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Card className="pb-3">
        <CardHeader
          title="Approvals"
          right={
            <span className="tabular text-[11.5px] text-faint">
              {waiting ? `${waiting} waiting · ` : ''}last {data.approvals.length}, newest first
            </span>
          }
        />
        <p className="px-5 pb-2 text-[12px] text-dim">
          An agent never shares a doc, gives Drive access or deletes a record on its own. It asks, a card is posted in Slack, and only {data.approvers.map(person).join(' or ')} can approve. A request nobody
          answers in {data.ttl_hours} hours expires and nothing is done.
        </p>
        {data.approvals.length === 0 ? (
          <EmptyState compact>No agent has asked for approval yet. The first request to share a doc, give Drive access or delete a record will appear here, whatever is decided.</EmptyState>
        ) : (
          <TableFrame flat grow={false} label="Approvals">
            <thead>
              <tr>
                <Th>asked</Th>
                <Th>agent</Th>
                <Th>wanted to</Th>
                <Th>what</Th>
                <Th>state</Th>
                <Th>decided by</Th>
                <Th>decided</Th>
                <Th>request</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((a) => {
                const link = cardLink(a);
                const detail = a.status === 'card_failed' ? a.card_error : a.result_ok === false ? a.result_message : null;
                return (
                  <tr key={a.approval_id}>
                    <td className="td tabular whitespace-nowrap text-faint">{when(a.created_at)}</td>
                    <td className="td whitespace-nowrap text-dim">{a.agent ?? '—'}</td>
                    <td className="td whitespace-nowrap">{TOOL_WORDS[a.tool] ?? a.tool}</td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '52ch' }} title={detail ? `${a.summary} — ${detail}` : a.summary}>
                      {detail ? `${a.summary} — ${detail}` : a.summary}
                    </td>
                    <td className="td">
                      <StatusPill a={a} />
                    </td>
                    <td className="td text-dim">{person(a.decided_by)}</td>
                    <td className="td tabular whitespace-nowrap text-faint">{a.decided_at ? when(a.decided_at) : '—'}</td>
                    <td className="td whitespace-nowrap">
                      {link ? (
                        <a className="link" href={link} target="_blank" rel="noreferrer">
                          <RecordId>{a.approval_id}</RecordId>
                        </a>
                      ) : (
                        <RecordId>{a.approval_id}</RecordId>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
        )}
      </Card>
      <Pagination paged={paged} unit="requests" />
    </div>
  );
}
