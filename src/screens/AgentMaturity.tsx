import { useData } from '../app/useData';
import { getAgentScorecard } from '../data';
import type { AgentMetric } from '../data/types';
import { Card, CardHeader, LoadFailed, Loading, PageHeader, Stat, StatCell, StatStrip, TableFrame, Th } from '../components/ui';

/**
 * Agent maturity (2026-09-28, Destiny — Agent Upgrade Plan, Phase 0). The
 * twelve quality dimensions the agents are scored on, the latest scoring with
 * its evidence, and the live metrics behind them. Every score is a stored row
 * from a scoring; every metric is counted from the engine's own tables. A
 * metric with no instrumentation yet says which plan step brings it.
 */
export default function AgentMaturity() {
  const { status, data, error } = useData(() => getAgentScorecard(), [], { kinds: ['ns-asks', 'rt-asks', 'bays-asks', 'eval-runs', 'incidents'] });
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;
  const d = data;

  const share = (n: number | null, of: number | null) => (n === null || !of ? null : `${n} of ${of}`);
  const tone = (score: number, floor: number) => (score < floor - 2 ? 'failing' : score < floor ? 'degraded' : 'default');

  return (
    <div className="flex flex-col pb-8">
      <PageHeader
        title="Agent maturity"
        subtitle={d.scored_on ? `Bays, North Star and Research Twin, scored on 12 dimensions. Latest scoring ${d.scored_on}.` : 'No scoring recorded yet.'}
      />

      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Average" value={d.average ?? '—'} hint="Floor 8, goal 10" size="lg" />
        </StatCell>
        <StatCell>
          <Stat
            label="Weakest dimension"
            value={d.weakest ? d.weakest.score : '—'}
            hint={d.weakest ? d.weakest.name : 'No scoring yet'}
            tone={d.weakest && d.weakest.score < 7 ? 'degraded' : 'default'}
          />
        </StatCell>
        <StatCell>
          <Stat
            label="Execution quota"
            value={d.quota.pct === null ? '—' : `${Math.round(d.quota.pct * 100)}%`}
            hint={d.quota.used === null ? d.quota.note ?? 'Not configured' : `${d.quota.used} of ${d.quota.quota} this cycle`}
            tone={d.quota.pct !== null && d.quota.pct >= 0.7 ? 'degraded' : 'default'}
          />
        </StatCell>
        <StatCell>
          <Stat label="MCP writes refused, 7 days" value={d.mcp_refusals_7d} hint="Guards doing their job" />
        </StatCell>
      </StatStrip>

      <TableFrame grow={false} label="Dimension scores">
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Dimension</Th>
            <Th>Score</Th>
            <Th>Floor</Th>
            <Th>Goal</Th>
            <Th>Evidence</Th>
          </tr>
        </thead>
        <tbody>
          {d.scores.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-dim">
                No scoring is recorded yet.
              </td>
            </tr>
          ) : (
            d.scores.map((s) => (
              <tr key={s.dimension} className="border-b border-line">
                <td className="px-3 py-2 text-faint tabular">{s.dimension}</td>
                <td className="px-3 py-2 text-ink">{s.name}</td>
                <td className={`px-3 py-2 tabular font-medium ${tone(s.score, s.floor) === 'failing' ? 'text-failing' : tone(s.score, s.floor) === 'degraded' ? 'text-degraded' : 'text-ink'}`}>
                  {s.score}
                </td>
                <td className="px-3 py-2 tabular text-dim">{s.floor}</td>
                <td className="px-3 py-2 tabular text-dim">{s.goal}</td>
                <td className="px-3 py-2 text-dim">{s.evidence}</td>
              </tr>
            ))
          )}
        </tbody>
      </TableFrame>

      <div className="mx-6 grid grid-cols-1 gap-4 md:mx-8 md:grid-cols-2">
        <Card>
          <CardHeader title="Answers per agent, last 30 days" />
          <div className="px-5 pb-4">
            {d.agents.map((a: AgentMetric) => (
              <div key={a.agent} className="flex items-start justify-between gap-4 border-b border-line py-2 last:border-0">
                <div className="text-ink">{a.agent}</div>
                {a.asks === null ? (
                  <div className="text-right text-[12.5px] text-dim">{a.note}</div>
                ) : (
                  <div className="text-right text-[12.5px] text-dim tabular">
                    <div>Delivered {share(a.delivered, a.asks) ?? 'no asks'}</div>
                    <div>{a.thin === null ? '' : `Thin ${share(a.thin, a.asks) ?? '—'} · `}Failed {share(a.failed, a.asks) ?? '—'}</div>
                    {a.note && <div className="text-faint">{a.note}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Open incidents and tests" />
          <div className="px-5 pb-4 text-[12.5px]">
            {d.incidents.length === 0 ? (
              <div className="py-2 text-dim">No open incidents in the ledger copy.</div>
            ) : (
              d.incidents.map((i) => (
                <div key={i.severity} className="flex justify-between border-b border-line py-2">
                  <span className="text-ink">{i.severity}</span>
                  <span className="tabular text-dim">{i.open} open</span>
                </div>
              ))
            )}
            <div className="flex justify-between gap-4 border-b border-line py-2">
              <span className="text-ink">Eval pass rate</span>
              <span className="text-right text-dim">{d.evals.pass_rate === null ? d.evals.note : <>{`${Math.round(d.evals.pass_rate * 100)}%`}<br /><span className="text-faint">{d.evals.note}</span></>}</span>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <span className="text-ink">Injection tests</span>
              <span className="text-right text-dim">{d.injection.pass_rate === null ? d.injection.note : `${Math.round(d.injection.pass_rate * 100)}%`}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
