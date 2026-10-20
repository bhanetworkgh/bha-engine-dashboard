import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getLogstream } from '../data';
import type { LogstreamData, LogstreamRow, LogstreamSignature, LogstreamTrigger, ResearchSignal } from '../data/types';
import { EmptyState, LoadFailed, Loading, PageHeader, Pagination, Pill, Stat, StatCell, StatStrip, TableFrame, Tabs, Th, usePaged } from '../components/ui';

/**
 * Logstream (2026-10-10, Destiny. Jason's go-ahead of 9 Oct).
 *
 * The read and analysis record for engine faults: which faults keep coming back, which crossed
 * one of Jason's locked thresholds, and what was done about it (a research job, an alert, a
 * request to North Star for guidance). It reads and nothing else, and nothing on it pays anybody.
 *
 * Colour marks only what needs somebody: an action that did not land, and a fault at the level
 * that calls a person. A research job opened is the rule doing its job and is the accent, not green.
 */

const TABS = ['Crossings', 'Faults', 'Rows', 'Patterns', 'Research signals'] as const;
type Tab = (typeof TABS)[number];
const SLUG: Record<Tab, string> = { Crossings: 'crossings', Faults: 'faults', Rows: 'rows', Patterns: 'patterns', 'Research signals': 'signals' };

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

const KIND: Record<LogstreamTrigger['kind'], string> = {
  signature_research: 'same fault, 3 in 7 days',
  signature_escalation: 'same fault, 5 in 7 days',
  workflow_rate: 'workflow failing 20% or more',
  shared_outage: 'shared-cause outage',
};

function ActionPill({ t }: { t: LogstreamTrigger }) {
  switch (t.action_state) {
    case 'job_opened':
      return <Pill tone="accent">research job opened</Pill>;
    case 'alerted':
      return <Pill tone="degraded">a person was told</Pill>;
    case 'suppressed_shared_outage':
      return <Pill>no research: part of an outage</Pill>;
    case 'failed':
      return <Pill tone="failing">did not land</Pill>;
    case 'withdrawn':
      return <Pill>withdrawn</Pill>;
    case 'held':
      return <Pill tone="degraded">waiting: budget or credit</Pill>;
    case 'not_reopened':
      return <Pill>not reopened</Pill>;
    default:
      return <Pill tone="degraded">waiting</Pill>;
  }
}

function guidanceWords(t: LogstreamTrigger): string {
  if (t.action !== 'research_job' || t.action_state !== 'job_opened') return '—';
  if (t.guidance_state === 'asked') return `North Star asked ${when(t.guidance_at)}`;
  if (t.guidance_state === 'failed') return `North Star not asked: ${t.guidance_error ?? 'no reason recorded'}`;
  if (t.guidance_state === 'no_finding') return t.guidance_error ?? 'No finding to act on';
  return `Waiting on research (${t.job_status ?? 'job not found'})`;
}

function Crossings({ data }: { data: LogstreamData }) {
  const paged = usePaged<LogstreamTrigger>(data.triggers, 'crossings');
  if (data.triggers.length === 0) return <EmptyState>No fault has crossed a threshold since Logstream started recording crossings on 10 Oct 2026.</EmptyState>;
  return (
    <>
      <TableFrame grow={false} label="Threshold crossings">
        <thead>
          <tr>
            <Th>Seen (UTC)</Th>
            <Th>What crossed</Th>
            <Th>Rule</Th>
            <Th>Count</Th>
            <Th>What was done</Th>
            <Th>Guidance</Th>
          </tr>
        </thead>
        <tbody>
          {paged.rows.map((t) => (
            <tr key={t.trigger_id} className="border-b border-line align-top">
              <td className="tabular px-3 py-2 text-dim">{when(t.detected_at)}</td>
              <td className="px-3 py-2 text-ink">
                {t.kind === 'shared_outage' ? `${t.n} workflows at once` : (t.failed_node ?? t.workflow ?? t.key)}
                <div className="text-[11.5px] text-faint">{t.kind === 'shared_outage' ? t.workflows.join(', ') : `${t.workflow ?? ''}${t.lane_id ? ` · ${t.lane_id}` : ''}`}</div>
              </td>
              <td className="px-3 py-2 text-dim">{KIND[t.kind]}</td>
              <td className="tabular px-3 py-2 text-dim">{t.kind === 'workflow_rate' ? `${t.failures} of ${t.runs} runs` : t.n}</td>
              <td className="px-3 py-2">
                <ActionPill t={t} />
                <div className="mt-1 text-[11.5px] text-faint">{t.action_state === 'withdrawn' || t.action_state === 'held' || t.action_state === 'not_reopened' ? (t.error ?? '') : (t.job_id ?? (t.alert_ts ? 'posted in the engine alerts channel' : (t.error ?? '')))}</div>
              </td>
              <td className="px-3 py-2 text-[12px] text-dim">{guidanceWords(t)}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Pagination paged={paged} unit="rows" />
    </>
  );
}

function Faults({ data }: { data: LogstreamData }) {
  const [params, setParams] = useSearchParams();
  const all = params.get('show') === 'all';
  const rows = useMemo(() => data.signatures.filter((s) => all || !s.excluded_reason), [data, all]);
  const paged = usePaged<LogstreamSignature>(rows, String(all));
  const toggle = () => {
    const next = new URLSearchParams(params);
    if (all) next.delete('show');
    else next.set('show', 'all');
    setParams(next, { replace: true });
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3 text-[12px] text-dim md:px-8">
        <button type="button" className={`tag ${!all ? 'tag-accent' : ''}`} onClick={all ? toggle : undefined}>
          Counted {data.signatures.filter((s) => !s.excluded_reason).length}
        </button>
        <button type="button" className={`tag ${all ? 'tag-accent' : ''}`} onClick={all ? undefined : toggle}>
          Including left out {data.signatures.length}
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyState>No fault is held yet.</EmptyState>
      ) : (
        <>
          <TableFrame grow={false} label="Faults by signature">
            <thead>
              <tr>
                <Th>Step that failed</Th>
                <Th>Workflow</Th>
                <Th>Lane</Th>
                <Th>Last 7 days</Th>
                <Th>Last 30 days</Th>
                <Th>All held</Th>
                <Th>Latest (UTC)</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((s) => (
                <tr key={s.signature} className="border-b border-line align-top">
                  <td className="px-3 py-2 text-ink">
                    {s.failed_node ?? '(no step)'}
                    {s.excluded_reason ? <div className="text-[11.5px] text-faint">left out: {s.excluded_reason.replace('_', ' ')}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-dim">{s.workflow ?? '(no workflow)'}</td>
                  <td className="px-3 py-2 text-dim">{s.lane_id ?? '—'}</td>
                  <td className="tabular px-3 py-2">
                    {!s.excluded_reason && s.last_7d >= data.rule.escalate_at ? <Pill tone="failing">{s.last_7d}</Pill> : !s.excluded_reason && s.last_7d >= data.rule.research_at ? <Pill tone="degraded">{s.last_7d}</Pill> : <span className="text-dim">{s.last_7d}</span>}
                  </td>
                  <td className="tabular px-3 py-2 text-dim">{s.last_30d}</td>
                  <td className="tabular px-3 py-2 text-dim">{s.total}</td>
                  <td className="tabular px-3 py-2 text-dim">{when(s.last_at)}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination paged={paged} unit="rows" />
        </>
      )}
    </>
  );
}

const STATE: Record<LogstreamRow['state'], string> = { observed: 'observed', closed: 'closed', research_opened: 'research opened', patterns_evaluated: 'patterns evaluated' };

function recovery(r: LogstreamRow): string {
  const s = r.objective_outcomes.time_to_recovery_seconds;
  if (r.state === 'observed' || s === null || s === undefined) return '—';
  const words = s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 360) / 10} h` : `${Math.round(s / 8640) / 10} d`;
  return r.objective_outcomes.time_to_recovery_trusted ? words : `${words} (not trusted: closed before 2 Oct)`;
}

function Rows({ data, short }: { data: LogstreamData; short: (id: string) => string }) {
  const paged = usePaged<LogstreamRow>(data.rows, 'rows');
  if (data.rows.length === 0) return <EmptyState>No row has been written yet.</EmptyState>;
  return (
    <>
      <TableFrame grow={false} label="Logstream rows">
        <thead>
          <tr>
            <Th>Written (UTC)</Th>
            <Th>Incident</Th>
            <Th>State</Th>
            <Th>Fault</Th>
            <Th>Same fault, 7 days</Th>
            <Th>Time to recovery</Th>
            <Th>Patterns</Th>
          </tr>
        </thead>
        <tbody>
          {paged.rows.map((r) => (
            <tr key={r.logstream_row_id} className="border-b border-line align-top">
              <td className="tabular px-3 py-2 text-dim">{when(r.written_at)}</td>
              <td className="px-3 py-2 text-ink">
                {r.incident_id}
                <div className="text-[11.5px] text-faint">happened {when(r.occurred_at)}</div>
              </td>
              <td className="px-3 py-2 text-dim">{STATE[r.state]}</td>
              <td className="px-3 py-2 text-dim">
                {r.signature}
                {r.excluded_reason ? <div className="text-[11.5px] text-faint">left out: {r.excluded_reason.replace('_', ' ')}</div> : null}
              </td>
              <td className="tabular px-3 py-2 text-dim">{r.objective_outcomes.incident_frequency_7d ?? '—'}</td>
              <td className="px-3 py-2 text-dim">{recovery(r)}</td>
              <td className="px-3 py-2 text-[12px] text-dim">
                {r.state !== 'patterns_evaluated'
                  ? '—'
                  : r.pattern_ids_applied.length === 0
                    ? 'none applied'
                    : r.pattern_ids_applied.map((p) => (
                        <div key={p} title={r.pattern_adherence[p]?.why}>
                          {short(p)}: {r.pattern_adherence[p]?.result === 'followed' ? 'followed' : <span className="text-failing">not followed</span>}
                        </div>
                      ))}
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Pagination paged={paged} unit="rows" />
      <p className="px-6 pt-2 text-[11.5px] text-faint md:px-8">The newest {data.rows_cap} rows. Rows are only ever added: a later state is a new row, never an edit.</p>
    </>
  );
}

function Patterns({ data, short }: { data: LogstreamData; short: (id: string) => string }) {
  const ids = Object.values(data.patterns);
  const n = (p: string, result: string) => data.adherence.find((a) => a.pattern === p && a.result === result)?.n ?? 0;
  return (
    <TableFrame grow={false} label="Pattern adherence">
      <thead>
        <tr>
          <Th>Pattern</Th>
          <Th>Followed</Th>
          <Th>Not followed</Th>
          <Th>Did not apply</Th>
        </tr>
      </thead>
      <tbody>
        {ids.map((p) => (
          <tr key={p} className="border-b border-line">
            <td className="px-3 py-2 text-ink">
              {short(p)}
              <div className="text-[11.5px] text-faint">{p}</div>
            </td>
            <td className="tabular px-3 py-2 text-dim">{n(p, 'followed')}</td>
            <td className="tabular px-3 py-2">{n(p, 'not_followed') ? <span className="text-failing">{n(p, 'not_followed')}</span> : <span className="text-dim">0</span>}</td>
            <td className="tabular px-3 py-2 text-dim">{n(p, 'not_applicable')}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

/**
 * Research signals (2026-10-11, Destiny. Q9CR). Everything that asked for a research job and what
 * the guard did with it: one job per signal, five new automatic jobs a day, nothing while the model
 * credit is low. Waiting is the only coloured state besides a job that did not land: a signal that
 * got its job is the rule doing its job, and one not reopened is a rule too.
 */
const TRIGGER: Record<ResearchSignal['trigger_code'], string> = {
  T4: 'Engine fault',
  T5: 'Lane health',
  T6: 'Commercial card',
  T8: 'Repeated red flag',
  MONITORING: 'Monitoring Twin',
};

function SignalPill({ s }: { s: ResearchSignal }) {
  switch (s.state) {
    case 'job_opened':
      return <Pill tone="accent">research job opened</Pill>;
    case 'held_budget':
      return <Pill tone="degraded">waiting: daily budget</Pill>;
    case 'held_credit':
      return <Pill tone="degraded">waiting: model credit</Pill>;
    case 'failed':
      return <Pill tone="failing">did not land</Pill>;
    case 'not_reopened':
      return <Pill>not reopened</Pill>;
    default:
      return <Pill tone="degraded">opening</Pill>;
  }
}

function Signals({ data }: { data: LogstreamData }) {
  const rs = data.research_signals;
  const paged = usePaged<ResearchSignal>(rs?.signals ?? [], 'signals');
  if (!rs) return <EmptyState>The server has not sent the research signals yet. Reload in a minute.</EmptyState>;
  const credit = rs.credit.read ? `$${(rs.credit.remaining_usd ?? 0).toFixed(2)} of model credit, read ${when(rs.credit.read_at)} UTC` : `model credit not read: ${rs.credit.error ?? 'no reason recorded'}`;
  return (
    <>
      <p className="px-6 pb-3 text-[12px] text-dim md:px-8">
        {rs.today.opened} of {rs.today.budget} automatic research jobs opened today (UTC {rs.today.utc_day}), {rs.today.backlog_opened} of {rs.rule.backlog_daily_cap} from the backlog. {credit}; nothing opens under ${rs.rule.credit_floor_usd}.
      </p>
      {rs.signals.length === 0 ? (
        <EmptyState>Nothing has asked for a research job since the guard started on 11 Oct 2026.</EmptyState>
      ) : (
        <>
          <TableFrame grow={false} label="Research signals">
            <thead>
              <tr>
                <Th>Seen (UTC)</Th>
                <Th>What asked</Th>
                <Th>Question</Th>
                <Th>What was done</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((s) => (
                <tr key={s.signal_id} className="border-b border-line align-top">
                  <td className="tabular px-3 py-2 text-dim">{when(s.detected_at)}</td>
                  <td className="px-3 py-2 text-ink">
                    {TRIGGER[s.trigger_code]}
                    {s.fixture ? ' (fixture)' : ''}
                    <div className="text-[11.5px] text-faint">
                      {s.source}
                      {s.card_id ? ` · ${s.card_id}` : ''}
                      {s.lane ? ` · ${s.lane}` : ''}
                      {s.occurrences > 1 ? ` · seen ${s.occurrences} times` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[12px] text-dim">{s.question}</td>
                  <td className="px-3 py-2">
                    <SignalPill s={s} />
                    <div className="mt-1 text-[11.5px] text-faint">{s.state === 'job_opened' ? `${s.job_id ?? ''}${s.job_status ? ` · ${s.job_status}` : ''}` : (s.reason ?? '')}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination paged={paged} unit="rows" />
        </>
      )}
      {(rs.last_pass.errors ?? []).length > 0 ? <p className="px-6 pt-3 text-[12px] text-failing md:px-8">The last pass could not read every source: {(rs.last_pass.errors ?? []).join('; ')}</p> : null}
      <div className="mt-4 space-y-1 px-6 text-[11.5px] leading-relaxed text-faint md:px-8">
        {rs.rule.words.map((w) => (
          <p key={w}>{w}</p>
        ))}
        {rs.rule.not_built.map((w) => (
          <p key={w}>Not built: {w}</p>
        ))}
      </div>
    </>
  );
}

export default function Logstream() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => SLUG[t] === params.get('tab')) ?? 'Crossings') as Tab;
  const { status, data, error } = useData(getLogstream, [], { kinds: ['incidents', 'rt-jobs'] });
  const setTab = (t: Tab) => setParams(t === 'Crossings' ? {} : { tab: SLUG[t] }, { replace: true });
  const short = useMemo(() => {
    const names: Record<string, string> = {};
    if (data) for (const [k, v] of Object.entries(data.patterns)) names[v] = k === 'S757' ? 'Closure protocol (S757)' : k === 'BW9S' ? 'Guarded retry (BW9S)' : k === 'GRM8' ? 'Cut-off answer signal (GRM8)' : k;
    return (id: string) => names[id] ?? id;
  }, [data]);
  const signalsWaiting = data ? (data.research_signals?.signals ?? []).filter((s) => s.state === 'failed').length : 0;
  const notLanded = data ? data.triggers.filter((t) => t.action_state === 'failed' || t.guidance_state === 'failed').length : 0;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Logstream"
        subtitle="Engine faults that keep coming back: what crossed a threshold, and what was done about it"
        below={
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            counts={data ? { Crossings: { n: data.triggers.length, tone: notLanded ? 'failing' : 'default' }, Faults: { n: data.signatures.filter((s) => !s.excluded_reason).length }, Rows: { n: data.rows.length }, 'Research signals': { n: (data.research_signals?.signals ?? []).length, tone: signalsWaiting ? 'failing' : 'default' } } : undefined}
          />
        }
      />
      {status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-8">
          <StatStrip cols={4}>
            <StatCell>
              <Stat label="Incidents written down" value={data.summary.incidents} hint={`${data.summary.counted} counted · ${data.summary.excluded} left out (test, simulator, refused ask or click, doctrine)`} size="lg" />
            </StatCell>
            <StatCell>
              <Stat label="Counted in the last 7 days" value={data.summary.last_7d} hint={`Held from ${when(data.summary.first_at)}`} />
            </StatCell>
            <StatCell>
              <Stat label="Over a threshold right now" value={data.holding_now.length} hint="Faults and workflows the rule holds at this moment" tone={data.holding_now.length ? 'degraded' : 'default'} />
            </StatCell>
            <StatCell>
              <Stat label="Actions that did not land" value={notLanded} hint="A job, an alert or a guidance request that failed and is being retried" tone={notLanded ? 'failing' : 'default'} />
            </StatCell>
          </StatStrip>
          {tab === 'Crossings' ? <Crossings data={data} /> : tab === 'Faults' ? <Faults data={data} /> : tab === 'Rows' ? <Rows data={data} short={short} /> : tab === 'Patterns' ? <Patterns data={data} short={short} /> : <Signals data={data} />}
          <div className="mt-4 space-y-1 px-6 text-[11.5px] leading-relaxed text-faint md:px-8">
            {data.rule.words.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <p>{data.rule.locked_by}</p>
            {data.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
