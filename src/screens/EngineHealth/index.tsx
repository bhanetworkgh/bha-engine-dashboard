import { Link } from 'react-router-dom';
import { useData } from '../../app/useData';
import { getExecutions } from '../../data';
import { ComingSoon, Icon, LoadFailed, Loading, MetricCard, PageHeader, relativeTime } from '../../components/ui';

/**
 * Engine health.
 *
 * **Incidents are still a placeholder** (2026-09-14, Destiny). Nothing upstream
 * records an incident into this dashboard, so there is no self-heal rate, no
 * retry count and no time to resolve — the page said so plainly rather than
 * drawing phase 1 fixtures, and it still does.
 *
 * **Execution health is real, and this page keeps only the roll-up**
 * (2026-09-15, Destiny): one figure per system and a link through to the
 * Executions page. Engine Health answers "is something failing somewhere"; the
 * Executions page answers "what, and which". The per-workflow breakdown and the
 * failing execution ids live there and are deliberately not repeated here — two
 * drawings of the same counts drift, and the one a person happens to open
 * first becomes the one they trust.
 */

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 1000) / 10}%`;
}

function tone(rate: number | null): string {
  if (rate === null) return 'text-dim';
  if (rate >= 0.1) return 'text-failing';
  if (rate > 0) return 'text-degraded';
  return 'text-ink';
}

export default function EngineHealth() {
  // Weekly, because "is something failing right now" is a this-week question.
  const { status, data, error } = useData(() => getExecutions('week'), []);
  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  // Nothing held, rather than nothing configured: counts already taken are real
  // history and stay on screen even if the key is later removed. The note says
  // whether anything new is being counted.
  const nothing = data.systems.every((s) => s.periods.every((p) => p.executions === 0)) && data.unregistered.length === 0;
  const worst = data.systems
    .filter((s) => s.system !== 'all')
    .reduce<number | null>((w, s) => (s.failure_rate === null ? w : w === null ? s.failure_rate : Math.max(w, s.failure_rate)), null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Engine health" subtitle="Where something is failing, and where to go and look at it" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="mx-6 mb-4 md:mx-8">
          <MetricCard
            title="Workflow executions by system, this week"
            right={<span className={`tabular text-[12px] ${tone(worst)}`}>{nothing ? '' : `worst failure rate ${pct(worst)}`}</span>}
            note={
              <span className="block space-y-1">
                <span className="block text-[11px] leading-snug text-faint">{data.snapshot.note}</span>
                {data.boundary && <span className="block text-[11px] leading-snug text-degraded">{data.boundary.note}</span>}
                {data.snapshot.at && <span className="block text-[11px] leading-snug text-faint">Last counted {relativeTime(data.snapshot.at) ?? data.snapshot.at}.</span>}
              </span>
            }
          >
            {nothing ? (
              <p className="text-[12.5px] leading-relaxed text-dim">{data.snapshot.note}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                {data.systems.filter((s) => s.system !== 'all').map((s) => (
                  <Link key={s.system} to="/executions" className="flex items-start justify-between gap-3 rounded-[12px] bg-raised px-4 py-3 transition-colors hover:bg-hover">
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{s.label}</span>
                      <span className={`font-display tabular mt-1 block text-[24px] leading-none ${tone(s.failure_rate)}`}>{pct(s.failure_rate)}</span>
                      <span className="mt-1 block text-[11px] leading-snug text-faint">
                        {s.executions ? `${s.failures} of ${s.executions} failed this week` : 'nothing ran this week'}
                      </span>
                    </span>
                    <Icon.chevron className="mt-0.5 shrink-0 text-faint" />
                  </Link>
                ))}
              </div>
            )}
          </MetricCard>
        </div>

        {/*
          A workflow n8n is running that no registry row names a system for.
          Counted and named rather than filed under a guess: it is a registry
          row somebody needs to add, which is actionable.
        */}
        {data.unregistered.length > 0 && (
          <div className="mx-6 mb-4 md:mx-8">
            <MetricCard title="Workflows in no system" note="Each of these is running in n8n and has no row in the workflow registry naming its system, so it appears under no system tab on Executions. Adding the registry row files it under the right one.">
              <div className="space-y-1.5 text-[12.5px]">
                {data.unregistered.map((w) => (
                  <div key={w.workflow_id} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-dim">{w.workflow_name}</span>
                    <span className="tabular shrink-0 text-faint">
                      {w.executions} executions{w.failures ? <span className="text-failing"> · {w.failures} failed</span> : ''}
                    </span>
                  </div>
                ))}
              </div>
            </MetricCard>
          </div>
        )}

        <div className="mx-6 mb-8 md:mx-8">
          <ComingSoon title="No incident reaches this dashboard yet" min={160}>
            Nothing upstream records an incident here, so there is no self-heal rate, no retry count and no time to resolve to report. The failure counts above are workflow executions, which
            is a different thing: an execution that failed and was retried successfully is one failure here and would be one self-healed incident there.
          </ComingSoon>
        </div>
      </div>
    </div>
  );
}
