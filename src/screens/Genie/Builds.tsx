import { useData } from '../../app/useData';
import { getGenieBuilds } from '../../data';
import { EmptyState, LoadFailed, Loading, Pagination, Pill, usePaged } from '../../components/ui';

/**
 * The build trail (19 Nov 2026, Destiny, Genie rebuild 10.9). Every change Genie asked to make, as plan, decision,
 * built and rating: the goal and the reuse check's matches when it asked, who decided and with what choice (go ahead,
 * extend a match, or use what exists), what the call did, and the asker's rating (not rated after 48 hours). A read:
 * the card in Slack is where a build is decided and rated. Rules: server/src/genieApprovals.ts.
 */

const when = (s: string | null) => (s ? String(s).replace('T', ' ').slice(0, 16) : '');
const CHOICE: Record<string, string> = { go_ahead: 'approved as new', extend: 'approved, extends a match', reuse: 'used what exists' };
const RATING: Record<string, string> = { useful: 'useful', partly: 'partly', not_useful: 'not useful', not_rated: 'not rated' };

export default function Builds() {
  const { status, data, error } = useData(getGenieBuilds, [], { kinds: ['genie_approvals'] });
  const paged = usePaged(data?.builds ?? [], 'builds');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (!data.builds.length) {
    return <div className="px-6 pb-8 md:px-8"><EmptyState>Genie has not asked to make a change yet. Each change it asks for appears here with its plan, the decision, what it built and the rating.</EmptyState></div>;
  }
  const rated = data.builds.filter((b) => b.rating && b.rating !== 'not_rated');
  const useful = rated.filter((b) => b.rating === 'useful').length;
  return (
    <div className="space-y-6 px-6 pb-8 md:px-8">
      <p className="text-sm text-dim">{data.builds.length} change requests. {rated.length} rated, {useful} of {rated.length} useful. A build that ran and was not rated within 48 hours is recorded as not rated.</p>
      <section className="card p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">asked (UTC)</th><th className="px-4 py-2 font-medium">plan</th><th className="px-4 py-2 font-medium">already on record</th><th className="px-4 py-2 font-medium">decision</th><th className="px-4 py-2 font-medium">built</th><th className="px-4 py-2 font-medium">rating</th></tr></thead>
          <tbody>
            {paged.rows.map((b) => {
              const matches = b.plan?.reuse?.matches ?? [];
              return (
                <tr key={b.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 tabular text-faint">{when(b.created_at)}<div>{b.id}</div></td>
                  <td className="px-4 py-2 text-ink">{b.plan?.goal || <span className="text-faint">no goal recorded</span>}<div className="text-faint">{b.server}: {b.tool}</div></td>
                  <td className="px-4 py-2 text-dim">
                    {b.plan?.reuse?.ran === false ? <span className="text-failing">did not run: {b.plan.reuse.reason}</span> : matches.length ? matches.slice(0, 3).map((m) => <div key={m.id}>{m.id} <span className="text-faint">({m.kind})</span></div>) : b.plan ? <span className="text-faint">nothing matched</span> : <span className="text-faint">asked before the trail</span>}
                  </td>
                  <td className="px-4 py-2">{b.status === 'pending' ? <Pill tone="degraded">waiting</Pill> : b.status === 'expired' ? <span className="text-faint">expired</span> : <>{b.status === 'denied' && b.choice !== 'reuse' ? 'denied' : CHOICE[b.choice ?? ''] ?? b.status}{b.decided_by ? <div className="text-faint">by {b.decided_by}</div> : null}</>}</td>
                  <td className="px-4 py-2 text-dim">{b.status === 'done' ? b.built?.what || 'done' : b.status === 'failed' ? <span className="text-failing">failed: {b.built?.error || b.error}</span> : <span className="text-faint">—</span>}</td>
                  <td className="px-4 py-2">{b.rating ? <>{RATING[b.rating] ?? b.rating}{b.rating_reason ? <span className="text-faint"> ({b.rating_reason})</span> : null}</> : b.status === 'done' || b.status === 'failed' ? <span className="text-faint">waiting on the asker</span> : <span className="text-faint">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pagination paged={paged} unit="builds" />
      </section>
    </div>
  );
}
