import { useData } from '../../app/useData';
import { getOutsideSources } from '../../data';
import { EmptyState, LoadFailed, Loading, Pagination, Pill, usePaged } from '../../components/ui';

/**
 * BHA RSS's sources (19 Nov 2026, Destiny, Genie rebuild 8.8). Each source's score from real use: how many digest
 * bullets linked one of its items in the last 30 days (cited), and how often those links were then used by Media
 * Twin, Research Twin, North Star or Genie (used). Score = cited + 3 x used. The score sets how often BHA RSS reads
 * a source; every change is listed with its reason, and a candidate source joins only once a person approves it.
 * A read: decisions on candidates are made with decide_rss_candidate. Rules: server/src/outsideSources.ts.
 */

const when = (s: string | null) => (s ? s.replace('T', ' ').slice(0, 16) : '');
const WHERE: Record<string, string> = { media_twin: 'Media Twin', research_twin_job: 'RT job', research_twin_ask: 'RT ask', north_star: 'North Star', genie: 'Genie' };
const ACTION: Record<string, string> = { faster: 'read more often', slower: 'read less often', base: 'back to its usual pace', retire: 'retired' };

export default function Sources() {
  const { status, data, error } = useData(getOutsideSources, [], { kinds: ['outside_sources'] });
  const paged = usePaged(data?.sources ?? [], 'sources');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.sources.length === 0) {
    return (
      <div className="px-6 pb-8 md:px-8">
        <EmptyState>No source has been scored yet. BHA RSS scores its sources once a day, after the morning digest is delivered; the first scores appear here then.</EmptyState>
      </div>
    );
  }
  const active = data.sources.filter((s) => s.active);
  const used = active.filter((s) => s.used > 0).length;
  const cited = active.filter((s) => s.cited > 0).length;
  const proposed = data.candidates.filter((c) => c.status === 'proposed');
  return (
    <div className="space-y-6 px-6 pb-8 md:px-8">
      <p className="text-sm text-dim">
        {active.length} sources read. {cited} of {active.length} had an item cited in a digest in the last {data.rule.window_days} days, and {used} of {active.length} had one used afterwards. Last scored {when(data.sources[0]?.scored_at ?? null)} UTC.
      </p>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Sources by score</h2>
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">source</th><th className="px-4 py-2 font-medium">score</th><th className="px-4 py-2 font-medium">cited</th><th className="px-4 py-2 font-medium">used</th><th className="px-4 py-2 font-medium">read every</th><th className="px-4 py-2 font-medium">why</th></tr></thead>
          <tbody>
            {paged.rows.map((s) => (
              <tr key={s.source_id} className="border-t border-line align-top">
                <td className="px-4 py-2 text-ink">{s.name || s.url}<div className="text-faint">{s.kind}{s.active ? '' : ', retired'}</div></td>
                <td className="px-4 py-2 tabular text-ink">{s.score}</td>
                <td className="px-4 py-2 tabular">{s.cited}</td>
                <td className="px-4 py-2 tabular">{s.used}{s.used > 0 ? <div className="text-faint">{Object.entries(s.used_where).map(([k, v]) => `${WHERE[k] ?? k} ${v}`).join(', ')}</div> : null}</td>
                <td className="px-4 py-2 tabular">{s.every_hours}h{s.base_every_hours && s.base_every_hours !== s.every_hours ? <span className="text-faint"> (usually {s.base_every_hours}h)</span> : null}</td>
                <td className="px-4 py-2 text-dim">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination paged={paged} unit="sources" />
      </section>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Changes to the list</h2>
        {data.changes.length === 0 ? (
          <div className="p-4"><EmptyState>No source has been moved yet.</EmptyState></div>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">day</th><th className="px-4 py-2 font-medium">source</th><th className="px-4 py-2 font-medium">change</th><th className="px-4 py-2 font-medium">reason</th><th className="px-4 py-2 font-medium">applied</th></tr></thead>
            <tbody>
              {data.changes.map((c) => {
                const s = data.sources.find((x) => x.source_id === c.source_id);
                return (
                  <tr key={c.change_id} className="border-t border-line align-top">
                    <td className="px-4 py-2 tabular">{c.tune_date}</td>
                    <td className="px-4 py-2 text-ink">{s?.name || s?.url || c.source_id}</td>
                    <td className="px-4 py-2">{ACTION[c.action] ?? c.action}{c.to_hours ? <span className="text-faint"> ({c.from_hours}h to {c.to_hours}h)</span> : null}</td>
                    <td className="px-4 py-2 text-dim">{c.reason}</td>
                    <td className="px-4 py-2">{c.applied_at ? `${when(c.applied_at)} UTC` : c.error ? <span className="text-failing">not applied: {c.error}</span> : <span className="text-faint">waiting on BHA RSS</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Candidate sources</h2>
        {data.candidates.length === 0 ? (
          <div className="p-4"><EmptyState>No candidate yet. A site is proposed once {data.rule.candidate_min_items} cited items link to it and it is not already a source.</EmptyState></div>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">site</th><th className="px-4 py-2 font-medium">status</th><th className="px-4 py-2 font-medium">linked from</th><th className="px-4 py-2 font-medium">decision</th></tr></thead>
            <tbody>
              {data.candidates.map((c) => (
                <tr key={c.candidate_id} className="border-t border-line align-top">
                  <td className="px-4 py-2 text-ink">{c.host}<div className="text-faint tabular">{c.candidate_id}</div></td>
                  <td className="px-4 py-2">{c.status === 'proposed' ? <Pill>waiting on a person</Pill> : c.status}</td>
                  <td className="px-4 py-2 text-dim">{c.evidence.length} cited items<ul className="mt-1 space-y-0.5">{c.evidence.slice(0, 3).map((u) => <li key={u} className="truncate"><a className="text-accent" href={u} target="_blank" rel="noreferrer">{u}</a></li>)}</ul></td>
                  <td className="px-4 py-2 text-dim">{c.decided_at ? `${c.decided_by === 'U0A9V97949F' ? 'Jason' : 'Destiny'}, ${when(c.decided_at)}${c.reason ? `: ${c.reason}` : ''}${c.added_at ? `; added ${when(c.added_at)}` : c.status === 'approved' ? '; joins on the next pass' : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {proposed.length ? <p className="px-4 pb-4 text-xs text-faint">Approve or decline with decide_rss_candidate (Destiny or Jason). An approved source joins BHA RSS's list on its next daily pass.</p> : null}
      </section>
    </div>
  );
}
