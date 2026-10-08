import { Link, useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getAskTrace, getAskTraces } from '../data';
import { Button, EmptyState, LoadFailed, Loading, PageHeader, Pagination, Pill, Stat, StatCell, StatStrip, TableFrame, Th, usePaged } from '../components/ui';

/**
 * The ask trace (2026-10-08, Destiny — UDC7). One ask can pass through more
 * than one agent: a person asks Bays, Bays asks Research Twin, Research Twin
 * asks North Star. Each agent records its own row on its own ledger, and from
 * 8 Oct every row carries the origin id of the ask that started it and the
 * chain of agents it came through. This page puts one origin's rows in order.
 *
 * It reads the three ledgers and changes nothing. Rows from before 8 Oct carry
 * no origin id and are not shown; nothing here guesses a link.
 */

const when = (iso: string | null) => (iso ? iso.slice(0, 19).replace('T', ' ') : '—');
const AGENT: Record<string, string> = { bays: 'Bays', north_star: 'North Star', research_twin: 'Research Twin' };
const chainLabel = (c: string[]) => (c.length ? c.map((a) => AGENT[a] ?? a).join(' → ') : 'not recorded');
const bad = (o: string | null) => o === 'Failed';

function Hops({ origin, onClose }: { origin: string; onClose: () => void }) {
  const { status, data, error } = useData(() => getAskTrace(origin), [origin], { kinds: ['bays-asks', 'ns-asks', 'rt-asks'] });
  return (
    <div className="card mx-6 mb-6 px-6 py-5 md:mx-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="kicker tabular truncate">{origin}</div>
          <h2 className="mt-1 text-[18px] leading-tight">{data && data.found ? `${data.hops.length} ${data.hops.length === 1 ? 'hop' : 'hops'}` : 'Ask trace'}</h2>
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
          <p className="py-6 text-center text-[12.5px] text-dim">{data?.note ?? 'No ask is held under this origin id.'}</p>
        ) : (
          <ol className="space-y-3">
            {data.hops.map((h, i) => (
              <li key={`${h.agent}-${h.row_id}`} className="rounded-[10px] bg-raised px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                  <span className="tabular text-faint">{i + 1}</span>
                  <span className="font-medium text-ink">{h.agent_label}</span>
                  {h.outcome && (bad(h.outcome) ? <Pill tone="failing">{h.outcome}</Pill> : <Pill>{h.outcome}</Pill>)}
                  {h.delivered && h.delivered !== 'Delivered' && h.delivered !== 'Self-delivered' && <Pill tone="degraded">{h.delivered}</Pill>}
                  <span className="tabular text-faint">{when(h.asked_at)} UTC</span>
                  {h.response_seconds !== null && <span className="text-faint">{h.response_seconds}s</span>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
                  <span>Chain: {chainLabel(h.call_chain)}</span>
                  {h.asked_by_system && <span>Asked by: {h.asked_by_system}</span>}
                  {h.ask_id && <span className="tabular">{h.ask_id}</span>}
                  {h.run_id && <span>n8n execution {h.run_id}</span>}
                  <Link className="text-accent-ink hover:underline" to={h.page}>
                    {h.agent_label} page
                  </Link>
                  {h.slack_link && (
                    <a className="text-accent-ink hover:underline" href={h.slack_link} target="_blank" rel="noreferrer">
                      Slack reply
                    </a>
                  )}
                </div>
                {h.question && <p className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{h.question}</p>}
                {h.answer ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[12px] text-dim">Answer</summary>
                    <p className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">{h.answer}</p>
                    {h.answer_chars > h.answer.length && (
                      <p className="mt-1 text-[11.5px] text-faint">
                        Showing the first {h.answer.length.toLocaleString()} of {h.answer_chars.toLocaleString()} characters. The whole answer is on the {h.agent_label} page.
                      </p>
                    )}
                  </details>
                ) : (
                  <p className="mt-2 text-[12px] text-faint">This row carries no answer text.</p>
                )}
                {h.error && <p className="mt-2 text-[12px] text-failing">{h.error}</p>}
              </li>
            ))}
          </ol>
        )}
        {data && data.found && <p className="mt-3 text-[11.5px] text-faint">{data.note}</p>}
      </div>
    </div>
  );
}

export default function AskTrace() {
  const [params, setParams] = useSearchParams();
  const open = params.get('origin');
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('origin', id);
    else next.delete('origin');
    setParams(next, { replace: true });
  };
  const { status, data, error } = useData(getAskTraces, [], { kinds: ['bays-asks', 'ns-asks', 'rt-asks'] });
  const paged = usePaged(data?.origins ?? [], 'ask-trace');

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Ask trace" subtitle="One ask followed across Bays, North Star and Research Twin, by the origin id it started with" />
      {open && <Hops origin={open} onClose={() => setOpen(null)} />}
      {status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : data.origins.length === 0 ? (
        <div className="px-6 pb-8 md:px-8">
          <EmptyState>No ask carrying an origin id is held yet. The three delivery workflows have written one on every ask since {data.since}; earlier asks carry none.</EmptyState>
        </div>
      ) : (
        <>
          <StatStrip cols={2}>
            <StatCell>
              <Stat label="Asks traced" value={data.summary.origins} hint={`Origins held since ${data.since}, newest ${data.summary.cap} at most`} />
            </StatCell>
            <StatCell>
              <Stat label="Passed through more than one agent" value={`${data.summary.multi_hop} of ${data.summary.origins}`} hint="Origins with two or more ledger rows" />
            </StatCell>
          </StatStrip>
          <TableFrame grow={false} label="Ask traces">
            <thead>
              <tr>
                <Th>Last hop (UTC)</Th>
                <Th>Hops</Th>
                <Th>Chain</Th>
                <Th>First question</Th>
                <Th>Origin id</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((o) => (
                <tr
                  key={o.origin}
                  className="cursor-pointer border-b border-line align-top hover:bg-hover"
                  tabIndex={0}
                  onClick={() => setOpen(o.origin)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setOpen(o.origin);
                  }}
                >
                  <td className="tabular px-3 py-2 text-dim">{when(o.last_at)}</td>
                  <td className="tabular px-3 py-2 text-ink">{o.hops}</td>
                  <td className="px-3 py-2 text-ink">{chainLabel(o.call_chain)}</td>
                  <td className="max-w-[420px] truncate px-3 py-2 text-dim" title={o.question ?? undefined}>
                    {o.question ?? <span className="text-faint">no question text</span>}
                  </td>
                  <td className="tabular px-3 py-2 text-faint">{o.origin}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination paged={paged} unit="asks" />
          <p className="px-6 pb-6 text-[11.5px] text-faint md:px-8">{data.note}</p>
        </>
      )}
    </div>
  );
}
