import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getEvalRun, getEvalRuns } from '../data';
import type { EvalRun } from '../data/types';
import { Button, EmptyState, LoadFailed, Loading, Pagination, Pill, Stat, StatCell, StatStrip, TableFrame, Th, usePaged } from '../components/ui';

/**
 * The eval history (2026-10-05, Destiny). Until this tab the dashboard showed
 * the latest run's pass rate and nothing before it, so "did yesterday's change
 * break a case" meant asking somebody to query the ledger. Every run
 * `Agent Evals — Runner` has written is listed here, newest first, and a run
 * opens case by case, failed cases first, with each repeat's checks and answer.
 *
 * The scorecard's rules: a case passes only if every repeat passed, and a run
 * still writing is marked in progress and never read as a final figure.
 */

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const AGENT: Record<string, string> = { bays: 'Bays', north_star: 'North Star', research_twin: 'Research Twin' };
const agentLabel = (a: string | null) => (a ? (AGENT[a] ?? a) : 'not named');

function RunView({ runId, summary, onClose }: { runId: string; summary: EvalRun | undefined; onClose: () => void }) {
  const { status, data, error } = useData(() => getEvalRun(runId), [runId]);
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[960px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Eval run">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{runId}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{summary ? `${summary.passed} of ${summary.cases} cases passed` : 'Eval run'}</h2>
            {summary && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                <span className="tabular">{when(summary.started_at)} UTC</span>
                {!summary.complete && <Pill tone="degraded">{summary.stalled ? 'did not finish' : 'in progress'}</Pill>}
                <span>{summary.results} results</span>
                {summary.by_agent.map((a) => (
                  <span key={a.agent}>
                    {agentLabel(a.agent)} {a.passed} of {a.cases}
                  </span>
                ))}
                {summary.execution && <span>n8n execution {summary.execution}</span>}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          {status === 'loading' && !data ? (
            <Loading />
          ) : status === 'error' && !data ? (
            <LoadFailed error={error} />
          ) : !data || !data.found ? (
            <p className="py-6 text-center text-[12.5px] text-dim">No result is held for run {runId}.</p>
          ) : (
            data.cases.map((c) => (
              <details key={c.case_id} className="border-b border-line py-2" open={!c.passed}>
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px]">
                  <span className="tabular text-ink">{c.case_id}</span>
                  {c.passed ? <Pill>passed</Pill> : <Pill tone="failing">failed</Pill>}
                  <span className="text-faint">{agentLabel(c.agent)}</span>
                  <span className="min-w-0 flex-1 truncate text-dim" title={c.question ?? undefined}>
                    {c.question ?? 'no question text'}
                  </span>
                  <span className="text-faint">
                    {c.repeats.filter((r) => r.passed).length} of {c.repeats.length} repeats
                  </span>
                </summary>
                <div className="mt-2 space-y-3 pl-1">
                  {c.question && <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{c.question}</p>}
                  {c.repeats.map((r) => (
                    <div key={r.result_id ?? `${c.case_id}-${r.repeat}`} className="rounded-[10px] bg-raised px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-3 text-[11.5px] text-faint">
                        <span>repeat {r.repeat ?? '—'}</span>
                        <span className={r.passed ? '' : 'text-failing'}>{r.passed ? 'passed' : 'failed'}</span>
                        <span className="tabular">{when(r.run_at)} UTC</span>
                      </div>
                      {r.checks.length > 0 ? (
                        <ul className="mt-1.5 space-y-0.5 text-[12px]">
                          {r.checks.map((k, i) => (
                            <li key={i} className={k.ok ? 'text-dim' : 'text-failing'}>
                              {k.ok ? 'ok' : 'failed'} · <code className="break-all">{k.name}</code>
                              {k.detail ? ` · ${k.detail}` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        r.failed_checks && <p className="mt-1.5 text-[12px] break-all text-failing">Failed: {r.failed_checks}</p>
                      )}
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[11.5px] text-accent">The answer the agent gave</summary>
                        {r.answer ? (
                          <>
                            <p className="mt-1 max-h-[32vh] overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{r.answer}</p>
                            {r.answer_chars !== null && r.answer_chars > r.answer.length && (
                              <p className="mt-1 text-[11px] text-faint">
                                Showing the first {r.answer.length.toLocaleString()} of {r.answer_chars.toLocaleString()} characters.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="mt-1 text-[12px] text-faint">The result carries no answer text.</p>
                        )}
                      </details>
                    </div>
                  ))}
                </div>
              </details>
            ))
          )}
        </div>
        <div className="mt-3 text-[11.5px] text-faint">Written by the n8n workflow Agent Evals — Runner. Failed cases are listed first and open on their own.</div>
      </div>
    </div>,
    document.body,
  );
}

export default function EvalHistory() {
  const [params, setParams] = useSearchParams();
  const open = params.get('run');
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('run', id);
    else next.delete('run');
    setParams(next, { replace: true });
  };
  const { status, data, error } = useData(getEvalRuns, [], { kinds: ['eval-runs'] });
  const paged = usePaged(data?.runs ?? [], 'evals');
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.runs.length === 0)
    return (
      <div className="px-6 md:px-8">
        <EmptyState>No eval run is held. Runs are written by the n8n workflow Agent Evals — Runner; nothing here starts one.</EmptyState>
      </div>
    );

  const done = data.runs.filter((r) => r.complete);
  const latest = done[0];
  const clean = done.filter((r) => r.passed === r.cases).length;
  const lastFail = done.find((r) => r.passed < r.cases);

  return (
    <>
      <StatStrip cols={4}>
        <StatCell>
          <Stat
            label="Latest finished run"
            value={latest ? `${latest.passed} of ${latest.cases}` : '—'}
            hint={latest ? `${latest.run_id} · ${when(latest.started_at)} UTC` : 'No run has finished yet'}
            tone={latest && latest.passed < latest.cases ? 'failing' : 'default'}
            size="lg"
          />
        </StatCell>
        <StatCell>
          <Stat label="Runs held" value={data.runs.length} hint={`${data.results} results since ${when(data.first_run_at)} UTC`} />
        </StatCell>
        <StatCell>
          <Stat label="Finished runs with every case passing" value={`${clean} of ${done.length}`} hint="A case passes only if every repeat passed" />
        </StatCell>
        <StatCell>
          <Stat
            label="Last run with a failed case"
            value={lastFail ? when(lastFail.started_at).slice(0, 10) : 'None'}
            hint={lastFail ? `${lastFail.run_id}: ${lastFail.failed_cases.join(', ')}` : 'No finished run held has a failed case'}
          />
        </StatCell>
      </StatStrip>

      <TableFrame grow={false} label="Eval runs">
        <thead>
          <tr>
            <Th>Run</Th>
            <Th>Started (UTC)</Th>
            <Th>Cases passed</Th>
            <Th>By agent</Th>
            <Th>Failed cases</Th>
            <Th>Results</Th>
          </tr>
        </thead>
        <tbody>
          {paged.rows.map((r) => (
            <tr
              key={r.run_id}
              className="cursor-pointer border-b border-line align-top hover:bg-hover"
              tabIndex={0}
              onClick={() => setOpen(r.run_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setOpen(r.run_id);
              }}
            >
              <td className="tabular px-3 py-2 text-ink">
                {r.run_id} {!r.complete && <Pill tone="degraded">{r.stalled ? 'did not finish' : 'in progress'}</Pill>}
              </td>
              <td className="tabular px-3 py-2 text-dim">{when(r.started_at)}</td>
              <td className={`tabular px-3 py-2 ${r.complete && r.passed < r.cases ? 'text-failing' : 'text-ink'}`}>
                {r.passed} of {r.cases}
              </td>
              <td className="px-3 py-2 text-dim">{r.by_agent.map((a) => `${agentLabel(a.agent)} ${a.passed}/${a.cases}`).join(' · ')}</td>
              <td className="px-3 py-2 text-dim">{r.failed_cases.length ? r.failed_cases.join(', ') : <span className="text-faint">none</span>}</td>
              <td className="tabular px-3 py-2 text-dim">
                {r.results}
                {r.run_size !== null && r.results < r.run_size ? ` of ${r.run_size}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Pagination paged={paged} unit="runs" />

      {open && <RunView runId={open} summary={data.runs.find((r) => r.run_id === open)} onClose={() => setOpen(null)} />}
    </>
  );
}
