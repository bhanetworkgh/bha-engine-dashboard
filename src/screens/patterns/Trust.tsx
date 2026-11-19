import { useData } from '../../app/useData';
import { getPatternTrust } from '../../data';
import { EmptyState, LoadFailed, Loading, Pagination, Pill, usePaged } from '../../components/ui';

/**
 * Which patterns Genie offers first (19 Nov 2026, Destiny, Genie rebuild 10.11). Every pattern the reuse check shows,
 * and every up or down it gets from real use, with the reason. Score is ups minus downs over 90 days; a pattern with
 * no use is unscored, never at nought. A pattern that meets the demotion rule comes off the trusted-first list and is
 * put to Destiny or Jason, who retire it or keep it; nothing is retired by itself. Rules: server/src/patternTrust.ts.
 */

const when = (s: string | null) => (s ? String(s).replace('T', ' ').slice(0, 16) : '');

export default function Trust() {
  const { status, data, error } = useData(getPatternTrust, [], { kinds: ['patterns'] });
  const paged = usePaged(data?.all ?? [], 'patterns');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-6 px-6 pb-8 md:px-8">
      <p className="text-sm text-dim">
        {data.trusted_first.length} patterns on the trusted-first list. {data.unscored_patterns} have not been offered or voted on yet. A pattern is put up for retirement only after {data.rule.min_downs} downs from {data.rule.min_voters} different people or threads in {data.rule.window_days} days, at least {data.rule.min_shown} showings with downs at least {Math.round(data.rule.min_down_share * 100)}% of them, and no up since. A down for the wrong ask never counts against the pattern.
      </p>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Put up for retirement</h2>
        {data.demoted.length === 0 ? <div className="p-4"><EmptyState>No pattern meets the retirement rule.</EmptyState></div> : (
          <table className="mt-2 w-full text-sm"><tbody>
            {data.demoted.map((d) => <tr key={d.pattern_id} className="border-t border-line"><td className="px-4 py-2 text-ink">{d.name || d.pattern_id}<div className="text-faint">{d.pattern_id}</div></td><td className="px-4 py-2 text-dim">{d.why}</td></tr>)}
          </tbody></table>
        )}
      </section>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Every pattern with a record</h2>
        {data.all.length === 0 ? <div className="p-4"><EmptyState>No pattern has been offered by the reuse check or voted on yet.</EmptyState></div> : (
          <>
            <table className="mt-2 w-full text-sm">
              <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">pattern</th><th className="px-4 py-2 font-medium">score</th><th className="px-4 py-2 font-medium">shown</th><th className="px-4 py-2 font-medium">ups</th><th className="px-4 py-2 font-medium">downs</th><th className="px-4 py-2 font-medium">wrong ask</th></tr></thead>
              <tbody>
                {paged.rows.map((p) => (
                  <tr key={p.pattern_id} className="border-t border-line">
                    <td className="px-4 py-2 text-ink">{p.name || p.pattern_id}<div className="text-faint">{p.pattern_id}</div></td>
                    <td className="px-4 py-2 tabular">{p.score === null ? <span className="text-faint">unscored</span> : p.score}{p.demoted ? <> <Pill tone="degraded">up for retirement</Pill></> : null}</td>
                    <td className="px-4 py-2 tabular">{p.shown}</td>
                    <td className="px-4 py-2 tabular">{p.ups}</td>
                    <td className="px-4 py-2 tabular">{p.downs}</td>
                    <td className="px-4 py-2 tabular text-faint">{p.misrouted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination paged={paged} unit="patterns" />
          </>
        )}
      </section>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Every move</h2>
        {data.moves.length === 0 ? <div className="p-4"><EmptyState>No up or down has been recorded yet.</EmptyState></div> : (
          <table className="mt-2 w-full text-sm"><tbody>
            {data.moves.map((m, i) => <tr key={i} className="border-t border-line"><td className="px-4 py-2 tabular text-faint">{when(m.at)}</td><td className="px-4 py-2 text-ink">{m.pattern_id}</td><td className="px-4 py-2">{m.kind}{m.reason ? <span className="text-faint"> ({m.reason})</span> : null}</td><td className="px-4 py-2 text-dim">{m.voter} · {m.source_ref}</td></tr>)}
          </tbody></table>
        )}
      </section>
    </div>
  );
}
