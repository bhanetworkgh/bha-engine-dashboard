/**
 * Code checks, a tab on the Pay Tracker (29 Oct 2026, Destiny — Jason's yes in DM D0AF0DG8ZPY,
 * thread 1793181986.036119).
 *
 * From 1 Nov 2026 Destiny checks every approved log against what is actually live and makes a pay
 * call, in the format Jason confirmed. This tab answers four questions:
 *
 *   - What is waiting on a check, and what is past Jason's 48 hours? (Amber only for late: that is
 *     the one state here that is genuinely bad, because a late check stalls someone's pay.)
 *   - What did each check find, and what was the pay call?
 *   - The discrepancy catalog: every check that found a log partly true or overstated, with the
 *     claims that were not confirmed. It is read from the checks, never kept by hand.
 *   - Where November's outputs for Jason stand: the catalog, one definition of done checklist per
 *     lane he named, and the v2 spec.
 *
 * Nothing here writes. Checks are recorded over MCP (record_code_check), outputs moved with
 * write_audit_output, both by Destiny or Jason.
 */
import type { ReactNode } from 'react';
import type { AuditOutput, CodeCheck, CodeChecksData } from '../../data';
import { Card, CardHeader, Pill, Stat, StatCell, StatStrip, relativeTime } from '../../components/ui';

const VERDICT: Record<CodeCheck['verdict'], string> = { matches: 'Matches the log', partly: 'Partly matches', overstated: 'Overstated' };
const PAY: Record<CodeCheck['pay_call'], string> = { as_logged: 'Pay as logged', partly: 'Pay partly', hold: 'Hold' };
const RESULT: Record<string, string> = { confirmed: 'Confirmed', partly: 'Partly', not_found: 'Not found' };
const MISSING: Record<string, string> = {
  tested_for_real: 'Tested for real',
  deployed_and_live: 'Deployed and live',
  failures_raised: 'Failures raised, not silent',
  monitored: 'Monitored',
  written_down: 'Written down',
};
const STATUS: Record<AuditOutput['status'], string> = { not_started: 'Not started', drafting: 'Drafting', ready_for_jason: 'With Jason', accepted: 'Accepted by Jason' };
const KIND: Record<AuditOutput['kind'], string> = { catalog: 'Catalog', dod_checklist: 'Definition of done', v2_spec: 'v2 spec' };

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const hours = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : `${h < 10 ? h.toFixed(1) : Math.round(h)} h`);

function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-line px-3 py-2 align-top ${className}`}>{children}</td>;
}
function Th({ children }: { children?: ReactNode }) {
  return <th className="border-b border-line px-3 py-2 text-left text-[11.5px] font-medium text-faint">{children}</th>;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 pb-4 text-[12.5px] text-dim">{children}</p>;
}

function VerdictPill({ v }: { v: CodeCheck['verdict'] }) {
  // Plain: a verdict is a finding, not an alarm. Lateness is the only amber on this tab.
  return <Pill tone={v === 'matches' ? 'ok' : 'default'}>{VERDICT[v]}</Pill>;
}

export default function CodeChecks({ data }: { data: CodeChecksData }) {
  const c = data.counts;
  const started = Date.now() >= Date.parse(data.start);
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <p className="mx-6 mb-3 text-[12px] text-dim md:mx-8">
        Destiny's second review of every approved log against what is live, from {data.start.slice(0, 10)}, within {data.window_hours} hours of Jason's approval.
        {!started && ' It has not started yet, so nothing below is owed a check.'}
      </p>

      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Checks posted" value={c.posted} hint={c.posted ? `${c.verdicts.matches} matched · ${c.verdicts.partly} partly · ${c.verdicts.overstated} overstated` : 'None recorded yet'} />
        </StatCell>
        <StatCell>
          <Stat label="Waiting on a check" value={c.waiting} hint={`${data.approved_since_start} approved since ${data.start.slice(0, 10)}`} />
        </StatCell>
        <StatCell>
          <Stat label={`Past ${data.window_hours} hours`} value={c.late} tone={c.late ? 'degraded' : 'default'} hint="Approved, still waiting" />
        </StatCell>
        <StatCell>
          <Stat
            label="Approval to check"
            value={data.hours_to_check.p50 == null ? '—' : hours(data.hours_to_check.p50)}
            hint={data.hours_to_check.n ? `median of ${data.hours_to_check.n} · ${c.within_window} within ${data.window_hours} h` : 'No timed check yet'}
          />
        </StatCell>
      </StatStrip>

      <div className="flex flex-col gap-4 px-6 pb-6 md:px-8">
        {data.notes.length > 0 && (
          <ul className="flex flex-col gap-1 text-[12px] text-dim">
            {data.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}

        <Card>
          <CardHeader title="Waiting on a check" right={<span className="text-[11.5px] text-faint">oldest first</span>} />
          {data.waiting.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead><tr><Th>Builder</Th><Th>Codex entry</Th><Th>Session</Th><Th>Approved</Th><Th>Waiting</Th></tr></thead>
                <tbody>
                  {data.waiting.map((w, i) => (
                    <tr key={w.codex_entry_id ?? i}>
                      <Td>{w.builder ?? '—'}</Td>
                      <Td className="tabular">{w.codex_entry_id ?? 'No Codex ID on the ledger'}</Td>
                      <Td className="tabular">{w.session_date ?? '—'}</Td>
                      <Td className="tabular">{when(w.approved_at)}</Td>
                      <Td>{w.late ? <Pill tone="degraded">{hours(w.hours_waiting)}, late</Pill> : hours(w.hours_waiting)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{started ? 'Nothing is waiting: every log approved since 1 November has a check.' : 'Nothing is owed a check before 1 November.'}</Empty>
          )}
        </Card>

        <Card>
          <CardHeader title="Checks posted" right={<span className="text-[11.5px] text-faint">newest first</span>} />
          {data.checks.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead><tr><Th>Posted</Th><Th>Builder</Th><Th>Codex entry</Th><Th>Verdict</Th><Th>Pay call</Th><Th>Took</Th><Th /></tr></thead>
                <tbody>
                  {data.checks.map((k) => (
                    <tr key={k.codex_entry_id}>
                      <Td className="tabular">{when(k.posted_at)}</Td>
                      <Td>{k.builder_name ?? '—'}</Td>
                      <Td className="tabular">{k.codex_entry_id}</Td>
                      <Td>
                        <VerdictPill v={k.verdict} />
                        <div className="mt-1 text-[11.5px] text-dim">{k.verdict_reason}</div>
                      </Td>
                      <Td>
                        {PAY[k.pay_call]}
                        {k.follow_ups.length > 0 && <div className="mt-1 text-[11.5px] text-dim">{k.follow_ups.length} follow-up{k.follow_ups.length === 1 ? '' : 's'}</div>}
                      </Td>
                      <Td className="tabular">{hours(k.hours_to_check)}</Td>
                      <Td><a href={k.check_link} target="_blank" rel="noreferrer" className="text-accent hover:underline">Check ↗</a></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No check has been recorded yet. Each one appears here once it is posted in the log's thread.</Empty>
          )}
        </Card>

        <Card>
          <CardHeader title="Discrepancy catalog" right={<span className="text-[11.5px] text-faint">every check marked partly or overstated</span>} />
          {data.catalog.length ? (
            <ul className="flex flex-col gap-4 px-5 pb-5">
              {data.catalog.map((k) => (
                <li key={k.codex_entry_id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{k.builder_name ?? '—'}</span>
                    <span className="tabular text-[12px] text-dim">{k.codex_entry_id}</span>
                    <VerdictPill v={k.verdict} />
                    <span className="text-[12px] text-dim">{PAY[k.pay_call]}</span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1.5 text-[12.5px]">
                    {k.not_confirmed.map((x, i) => (
                      <li key={i}>
                        <span className="font-medium">{RESULT[x.result]}:</span> {x.claim}
                        <span className="text-dim"> · checked in {x.where} · {x.proof}</span>
                      </li>
                    ))}
                  </ul>
                  {k.missing.length > 0 && <div className="mt-2 text-[12px] text-dim">Missing before customer ready: {k.missing.map((m) => MISSING[m] ?? m).join(', ')}</div>}
                  {k.follow_ups.length > 0 && (
                    <div className="mt-1 text-[12px] text-dim">
                      Follow-ups: {k.follow_ups.map((f) => `${f.what} (${f.who}, by ${f.by}${f.loop_id ? `, ${f.loop_id}` : ''})`).join('; ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{data.checks.length ? 'Every check so far matched its log, so nothing is in the catalog.' : 'Empty until the first check finds a log partly true or overstated.'}</Empty>
          )}
        </Card>

        <Card>
          <CardHeader title="November outputs for Jason" right={<span className="text-[11.5px] text-faint">due 30 November</span>} />
          {data.outputs.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead><tr><Th>Output</Th><Th>Kind</Th><Th>State</Th><Th>Due</Th><Th>Updated</Th><Th /></tr></thead>
                <tbody>
                  {data.outputs.map((o) => (
                    <tr key={o.output_id}>
                      <Td>
                        {o.title}
                        {o.note && <div className="mt-1 text-[11.5px] text-dim">{o.note}</div>}
                      </Td>
                      <Td>{KIND[o.kind]}</Td>
                      <Td>{o.status === 'accepted' ? <Pill tone="ok">{STATUS[o.status]}</Pill> : STATUS[o.status]}</Td>
                      <Td className="tabular">{o.due ?? '—'}</Td>
                      <Td className="text-dim">{relativeTime(o.updated_at) ?? when(o.updated_at)}</Td>
                      <Td>{o.link ? <a href={o.link} target="_blank" rel="noreferrer" className="text-accent hover:underline">Open ↗</a> : <span className="text-faint">No document yet</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No output is recorded. Migration 101 seeds them; if this is empty, it has not run.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
