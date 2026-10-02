import { useData } from '../app/useData';
import { getAgentScorecard } from '../data';
import type { AgentMetric } from '../data/types';
import { Card, CardHeader, LoadFailed, Loading, PageHeader, Pill, Stat, StatCell, StatStrip, TableFrame, Th } from '../components/ui';

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

      {/* The agent inventory (plan 5.2, 2 Oct 2026): every row is what n8n's get_agent
          returned, recorded through record_agent_inventory; the tier is derived from it in
          code. A row older than the stale window says so rather than reading as current. */}
      <TableFrame grow={false} label="Agent inventory">
        <thead>
          <tr>
            <Th>Agent</Th>
            <Th>Autonomy tier</Th>
            <Th>Model</Th>
            <Th>Tools</Th>
            <Th>Dashboard token</Th>
            <Th>Scheduled</Th>
            <Th>Last eval</Th>
            <Th>Read</Th>
          </tr>
        </thead>
        <tbody>
          {d.inventory.agents.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-dim">
                {d.inventory.note}
              </td>
            </tr>
          ) : (
            d.inventory.agents.map((a) => (
              <tr key={a.agent_id} className="border-b border-line align-top">
                <td className="px-3 py-2 text-ink">
                  <div>{a.name}</div>
                  <div className="text-[12px] text-faint">
                    {a.owner ? `Owner ${a.owner} · ` : ''}
                    {a.published === false ? 'draft only' : `v${(a.active_version_id ?? '').slice(0, 8)}`}
                    {a.memory_enabled ? ' · memory on' : ''}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Pill tone={a.autonomy_tier.startsWith('T3') ? 'accent' : 'default'}>{a.autonomy_tier}</Pill>
                  <div className="mt-1 text-[12px] text-faint">{a.tier_reason}</div>
                </td>
                <td className="px-3 py-2 text-dim">
                  {a.model ?? '—'}
                  {a.reasoning ? <div className="text-[12px] text-faint">reasoning {a.reasoning}{a.max_iterations ? ` · ${a.max_iterations} iterations` : ''}</div> : null}
                </td>
                <td className="px-3 py-2 tabular text-dim">
                  {a.tools.length} · {a.write_tools} write
                  {a.unapproved_write_tools > 0 ? <div className="text-[12px] text-faint">{a.unapproved_write_tools} without approval</div> : <div className="text-[12px] text-faint">all writes approved</div>}
                </td>
                <td className="px-3 py-2">
                  {a.mcp_servers.length === 0 ? (
                    <span className="text-faint">none</span>
                  ) : a.tokens_in_url > 0 ? (
                    <Pill tone="degraded">in the URL</Pill>
                  ) : (
                    <span className="text-dim">{a.mcp_servers.map((m) => m.token_in).join(', ')}</span>
                  )}
                  <div className="text-[12px] text-faint">{a.mcp_servers.map((m) => `${m.tools.length} tools, ${m.approval.length} approved`).join('; ')}</div>
                </td>
                <td className="px-3 py-2 tabular text-dim">
                  {a.scheduled_tasks}
                  {a.tasks.filter((t) => t.enabled).length ? <div className="text-[12px] text-faint">{a.tasks.filter((t) => t.enabled).map((t) => t.name ?? t.id).join(' · ')}</div> : null}
                </td>
                <td className="px-3 py-2 tabular text-dim">
                  {a.last_eval ? `${a.last_eval.passed} of ${a.last_eval.cases}` : <span className="text-faint">no finished run</span>}
                </td>
                <td className="px-3 py-2 text-dim">
                  {a.read_at.slice(0, 16).replace('T', ' ')}
                  {a.stale ? <div><Pill tone="degraded">stale, over {d.inventory.stale_after_days} days</Pill></div> : null}
                  <div className="text-[12px] text-faint">{a.read_from}</div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </TableFrame>
      {d.inventory.agents.length > 0 && (
        <p className="mx-6 -mt-2 mb-4 text-[12px] text-faint md:mx-8">
          {d.inventory.tiers.map((t) => `${t.tier}: ${t.meaning}`).join(' ')} {d.inventory.note}
        </p>
      )}

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
            <div className="flex justify-between gap-4 border-b border-line py-2">
              <span className="text-ink">Injection tests</span>
              <span className="text-right text-dim">{d.injection.pass_rate === null ? d.injection.note : <>{`${Math.round(d.injection.pass_rate * 100)}%`}<br /><span className="text-faint">{d.injection.note}</span></>}</span>
            </div>
            <div className="flex justify-between gap-4 border-b border-line py-2">
              <span className="text-ink">Time to resolve an incident</span>
              <span className="text-right text-dim">{d.resolve.p50_minutes === null ? d.resolve.note : <>{`p50 ${d.resolve.p50_minutes} min · p95 ${d.resolve.p95_minutes} min`}<br /><span className="text-faint">{d.resolve.note}</span></>}</span>
            </div>
            <div className="flex justify-between gap-4 border-b border-line py-2">
              <span className="text-ink">BHARAG write-backs, 7 days</span>
              <span className="text-right text-dim">
                {d.governance.bharag.recording_since === null ? (
                  'Nothing has written to BHARAG through the guard yet.'
                ) : (
                  <>
                    {`${d.governance.bharag.allowed} allowed · ${d.governance.bharag.redacted} with secrets redacted · ${d.governance.bharag.refused} refused`}
                    <br />
                    <span className="text-faint">
                      {d.governance.bharag.refused_by_reason.length
                        ? `Refused: ${d.governance.bharag.refused_by_reason.map((r) => `${r.reason} ${r.n}`).join(', ')}. `
                        : ''}
                      Guarded since {d.governance.bharag.recording_since.slice(0, 16)} UTC.
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <span className="text-ink">Personal data retention</span>
              <span className="text-right text-dim">
                {d.governance.retention.last_run
                  ? `Last run ${d.governance.retention.last_run.at.slice(0, 16).replace('T', ' ')} UTC, ${d.governance.retention.last_run.cleared} row${d.governance.retention.last_run.cleared === 1 ? '' : 's'} cleared`
                  : 'The weekly job has not run yet.'}
                <br />
                <span className="text-faint">{d.governance.retention.policy.map((r) => `${r.store} ${r.days} days`).join(' · ')}</span>
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
