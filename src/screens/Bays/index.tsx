import { Link } from 'react-router-dom';
import { useData } from '../../app/useData';
import { getExecutions } from '../../data';
import { ExecutionHealth, LoadFailed, Loading, MetricCard, PageHeader } from '../../components/ui';

/**
 * Bays, as a system page (decision 2026-09-15, Destiny).
 *
 * It did not have one, and the reasoning for that was sound as far as it went:
 * **Bays' output is already split across four record pages** — the logs it
 * takes are Codex entries, the loops it opens are Open loops, and its two
 * extractors write Build patterns and Commercial. There was nothing left to put
 * on a page of its own.
 *
 * That reasoning holds for output and does not hold for health. Executions are
 * the system's own, not its output, and Bays owns the largest set of workflows
 * in the engine — the Front Door, the Tools Router, Submit Actions, the Error
 * Handler, the Callback Receiver, the digests, seventeen in all. There was
 * nowhere any of those executions could surface. This page is that place, and
 * execution health is deliberately the whole of it: the output keeps its own
 * pages, and is linked rather than copied.
 */

const OUTPUT: { to: string; label: string; what: string }[] = [
  { to: '/codex', label: 'Codex entries', what: 'every session log Bays takes in, through to the entry the orchestrator writes' },
  { to: '/open-loops', label: 'Open loops', what: 'the loops Bays opens, chases in the daily digest, and closes' },
  { to: '/build-patterns', label: 'Build patterns', what: 'what the pattern extractor finds in an approved log' },
  { to: '/commercial', label: 'Commercial', what: 'what the commercial extractor finds in the same log' },
];

export default function Bays() {
  const { status, data, error } = useData(getExecutions, []);
  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const system = data.systems.find((s) => s.system === 'Bays');


  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Bays" subtitle="The Slack-facing agent and the workflows behind it — how they are running" />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <ExecutionHealth system={system} data={data} base={data.snapshot.n8n_base} />

        {/*
          Said once, plainly, rather than by drawing Bays' output twice. The
          record pages are the record; this page is the health.
        */}
        <div className="mx-6 mb-6 md:mx-8">
          <MetricCard title="What Bays produces is on the record pages" note="Linked rather than copied: a second drawing of the same rows would drift from the first.">
            <div className="grid gap-2 sm:grid-cols-2">
              {OUTPUT.map((o) => (
                <Link key={o.to} to={o.to} className="flex items-start gap-3 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-hover">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-accent-ink">{o.label}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">{o.what}</span>
                  </span>
                </Link>
              ))}
            </div>
          </MetricCard>
        </div>
      </div>
    </div>
  );
}
