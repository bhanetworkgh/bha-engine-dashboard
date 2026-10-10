import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getScheduledRuns } from '../data';
import type { AgentRunState, ScheduledAgentRun, ScheduledRunsData } from '../data/types';
import { EmptyState, LoadFailed, Loading, PageHeader, Pagination, Pill, Stat, StatCell, StatStrip, TableFrame, Tabs, Th, usePaged } from '../components/ui';

/**
 * Scheduled runs (2026-10-09, Destiny — LOOP-1791498530857-K9B7).
 *
 * Jason asked for a minimal run log after a reminder silently did not happen on 8 Oct: time,
 * task, success or failure, error. This is every scheduler the engine has on one page. For the
 * agent's tasks it draws one row per time a task was DUE, whether or not anything ran, so a miss
 * is a row and not an absence: "never started" (no line at all) is the platform, "started, not
 * finished" and "failed" are the task.
 *
 * It reads and nothing else. Colour marks only what needs somebody: never started, started and
 * not finished, failed. A finished run is the normal state and carries none.
 */

const TABS = ['Agent tasks', 'Workflows', 'Reminders', 'Background timers'] as const;
type Tab = (typeof TABS)[number];
const SLUG: Record<Tab, string> = { 'Agent tasks': 'agent', Workflows: 'workflows', Reminders: 'reminders', 'Background timers': 'timers' };

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 6) / 10} min`);

const STATE: Record<AgentRunState, { label: string; tone: 'default' | 'degraded' | 'failing' | 'accent'; title: string }> = {
  finished: { label: 'finished', tone: 'default', title: 'The task started and recorded its finish.' },
  failed: { label: 'failed', tone: 'failing', title: 'The task ran and recorded itself as failed.' },
  started_not_finished: { label: 'started, not finished', tone: 'failing', title: 'A start line was written and no finish followed. The task itself stopped part-way.' },
  never_started: { label: 'never started', tone: 'failing', title: 'No line at all for this due time. The timer did not fire, or the agent stopped before its first step.' },
  no_record: { label: 'no record', tone: 'default', title: 'Before the run log began. Only a finish line was written then, so nothing can be said about this one.' },
  due_soon: { label: 'due, not yet seen', tone: 'default', title: 'Due within the last 45 minutes. Not counted as a miss yet.' },
  unscheduled: { label: 'off schedule', tone: 'accent', title: 'A run no due time accounts for: a re-run by the watch, a hand run or a test.' },
};

function AgentTasks({ data }: { data: ScheduledRunsData }) {
  const [params, setParams] = useSearchParams();
  const only = params.get('state');
  const task = params.get('task');
  const rows = useMemo(
    () => data.agent.runs.filter((r) => (!only || (only === 'problems' ? ['failed', 'started_not_finished', 'never_started'].includes(r.state) : r.state === only)) && (!task || r.task === task)),
    [data, only, task],
  );
  const paged = usePaged<ScheduledAgentRun>(rows, `${only}|${task}`);
  const s = data.agent.summary;
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const problems = s.never_started + s.started_not_finished + s.failed;
  return (
    <>
      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Times a task was due" value={s.due} hint={`${data.agent.tasks.length} tasks on the schedule, last ${data.window.days} days`} size="lg" />
        </StatCell>
        <StatCell>
          <Stat label="Never started" value={s.never_started} hint="No line at all: the timer or the agent, not the task" tone={s.never_started ? 'failing' : 'default'} />
        </StatCell>
        <StatCell>
          <Stat label="Started, not finished" value={s.started_not_finished} hint="A start line with no finish: the task stopped part-way" tone={s.started_not_finished ? 'failing' : 'default'} />
        </StatCell>
        <StatCell>
          <Stat label="Recorded as failed" value={s.failed} hint={`${s.finished} finished · ${s.no_record} before the run log · ${s.unscheduled} off schedule`} tone={s.failed ? 'failing' : 'default'} />
        </StatCell>
      </StatStrip>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-3 text-[12px] text-dim md:px-8">
        <button type="button" className={`tag ${!only ? 'tag-accent' : ''}`} onClick={() => set('state', null)}>
          All {data.agent.runs.length}
        </button>
        <button type="button" className={`tag ${only === 'problems' ? 'tag-accent' : ''}`} onClick={() => set('state', 'problems')}>
          Needs a look {problems}
        </button>
        <label className="ml-2 flex items-center gap-1.5">
          <span className="text-faint">Task</span>
          <select className="rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink" value={task ?? ''} onChange={(e) => set('task', e.target.value || null)}>
            <option value="">All tasks</option>
            {data.agent.tasks.map((t) => (
              <option key={`${t.agent}:${t.task}`} value={t.task}>
                {t.task}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState>{data.agent.runs.length === 0 ? 'No agent has a scheduled task in the inventory, and no scheduled run is recorded in the last 7 days.' : 'No run matches this filter.'}</EmptyState>
      ) : (
        <>
          <TableFrame grow={false} label="Agent task runs">
            <thead>
              <tr>
                <Th>Due (UTC)</Th>
                <Th>Task</Th>
                <Th>State</Th>
                <Th>Started</Th>
                <Th>Finished</Th>
                <Th>Took</Th>
                <Th>What it recorded</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((r) => {
                const st = STATE[r.state];
                return (
                  <tr key={r.key} className="border-b border-line align-top">
                    <td className="tabular px-3 py-2 text-dim">{r.due_at ? when(r.due_at) : <span className="text-faint">not on the schedule</span>}</td>
                    <td className="px-3 py-2 text-ink">
                      {r.task}
                      <div className="text-[11.5px] text-faint">{r.agent}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span title={st.title}>
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-dim">{r.started_at ? when(r.started_at).slice(11) : r.finish_only ? <span className="text-faint" title="Written before the run log: only the finish was recorded.">not recorded</span> : '—'}</td>
                    <td className="tabular px-3 py-2 text-dim">{r.finished_at ? when(r.finished_at).slice(11) : '—'}</td>
                    <td className="tabular px-3 py-2 text-dim">{dur(r.seconds)}</td>
                    <td className="max-w-[64ch] px-3 py-2 text-dim">
                      {r.error ? <span className="text-failing">{r.error}</span> : r.summary ? r.summary.slice(0, 220) : r.state === 'never_started' ? 'Nothing. No start line and no finish line.' : r.state === 'started_not_finished' ? 'A start line only.' : <span className="text-faint">nothing</span>}
                      {r.tool_issues && <div className="text-[11.5px] text-faint">Tool issues: {r.tool_issues.slice(0, 200)}</div>}
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
                        {r.ask_id && <span className="tabular">{r.ask_id}</span>}
                        {r.slack_link && (
                          <a className="text-accent" href={r.slack_link} target="_blank" rel="noreferrer">
                            Slack post
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
          <Pagination paged={paged} unit="runs" />
        </>
      )}
    </>
  );
}

function Workflows({ data }: { data: ScheduledRunsData }) {
  const paged = usePaged(data.workflows.runs, 'workflows');
  const s = data.workflows.summary;
  return (
    <>
      <StatStrip cols={3}>
        <StatCell>
          <Stat label="Runs started by a trigger" value={s.runs} hint={`Last ${data.window.days} days`} size="lg" />
        </StatCell>
        <StatCell>
          <Stat label="Workflows" value={s.workflows} hint={data.workflows.by_workflow.slice(0, 3).map((w) => `${w.workflow} ${w.runs}`).join(' · ') || 'None'} />
        </StatCell>
        <StatCell>
          <Stat label="Failed" value={s.failed} hint="Status error or crashed, as n8n recorded it" tone={s.failed ? 'failing' : 'default'} />
        </StatCell>
      </StatStrip>
      {data.workflows.runs.length === 0 ? (
        <EmptyState>No workflow run started by a trigger is held for the last 7 days. The executions poll copies them from n8n; if it has not read n8n, the Executions page says so.</EmptyState>
      ) : (
        <>
          <TableFrame grow={false} label="Workflow runs started by a trigger">
            <thead>
              <tr>
                <Th>Started (UTC)</Th>
                <Th>Workflow</Th>
                <Th>Result</Th>
                <Th>Took</Th>
                <Th>Execution</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((r) => (
                <tr key={r.execution_id} className="border-b border-line">
                  <td className="tabular px-3 py-2 text-dim">{when(r.started_at)}</td>
                  <td className="px-3 py-2 text-ink">{r.workflow}</td>
                  <td className="px-3 py-2">{r.status === 'error' || r.status === 'crashed' ? <Pill tone="failing">{r.status}</Pill> : r.status === 'success' ? <span className="text-dim">success</span> : <Pill tone="degraded">{r.status}</Pill>}</td>
                  <td className="tabular px-3 py-2 text-dim">{dur(r.seconds)}</td>
                  <td className="tabular px-3 py-2 text-faint">{r.execution_id}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination paged={paged} unit="runs" />
        </>
      )}
    </>
  );
}

function Reminders({ data }: { data: ScheduledRunsData }) {
  const paged = usePaged(data.reminders, 'reminders');
  if (data.reminders.length === 0) return <EmptyState>No reminder post is waiting, and none was due in the last 7 days. These are the posts Bays hands to Slack to send on a date.</EmptyState>;
  return (
    <>
      <p className="px-6 pb-3 text-[12px] text-faint md:px-8">Slack holds these messages and posts them. Bays cannot read the channel back, so a past one reads "handed to Slack", never "posted".</p>
      <TableFrame grow={false} label="Reminder posts">
        <thead>
          <tr>
            <Th>Posts (UTC)</Th>
            <Th>State</Th>
            <Th>Message</Th>
            <Th>Where</Th>
            <Th>Asked by</Th>
          </tr>
        </thead>
        <tbody>
          {paged.rows.map((r) => (
            <tr key={r.reminder_id} className="border-b border-line align-top">
              <td className="tabular px-3 py-2 text-dim">{when(r.post_at)}</td>
              <td className="px-3 py-2 text-dim">{r.state}</td>
              <td className="max-w-[60ch] px-3 py-2 text-ink">{r.text}</td>
              <td className="tabular px-3 py-2 text-dim">{r.channel_id}</td>
              <td className="tabular px-3 py-2 text-dim">{r.requested_by ?? <span className="text-faint">not named</span>}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Pagination paged={paged} unit="reminders" />
    </>
  );
}

function Timers({ data }: { data: ScheduledRunsData }) {
  return (
    <>
      <p className="px-6 pb-3 text-[12px] text-faint md:px-8">
        The dashboard's own timers. Most ticks find nothing to do, so each has one line here and not a row per tick. Counted since this process started, {when(data.timers.since)} UTC; a deploy starts the count again.
      </p>
      <TableFrame grow={false} label="Background timers">
        <thead>
          <tr>
            <Th>Timer</Th>
            <Th>What it does</Th>
            <Th>Every</Th>
            <Th>Last ticked (UTC)</Th>
            <Th>Ticks since start</Th>
          </tr>
        </thead>
        <tbody>
          {data.timers.list.map((t) => (
            <tr key={t.name} className="border-b border-line align-top">
              <td className="px-3 py-2 text-ink">{t.name}</td>
              <td className="max-w-[56ch] px-3 py-2 text-dim">{t.what}</td>
              <td className="px-3 py-2 text-dim">{t.every}</td>
              <td className="tabular px-3 py-2 text-dim">{t.last_tick_at ? when(t.last_tick_at) : <span className="text-faint">not yet since the process started</span>}</td>
              <td className="tabular px-3 py-2 text-dim">{t.ticks}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </>
  );
}

export default function ScheduledRuns() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => SLUG[t] === params.get('tab')) ?? 'Agent tasks') as Tab;
  const { status, data, error } = useData(getScheduledRuns, [], { kinds: ['bays-asks'] });
  const setTab = (t: Tab) => setParams(t === 'Agent tasks' ? {} : { tab: SLUG[t] }, { replace: true });
  const problems = data ? data.agent.summary.never_started + data.agent.summary.started_not_finished + data.agent.summary.failed : 0;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Scheduled runs"
        subtitle="Every run of every scheduler in the engine, last 7 days: agent tasks, timed workflows, reminder posts and the dashboard's own timers"
        below={
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            counts={
              data
                ? {
                    'Agent tasks': { n: data.agent.runs.length, tone: problems ? 'failing' : 'default' },
                    Workflows: { n: data.workflows.runs.length, tone: data.workflows.summary.failed ? 'failing' : 'default' },
                    Reminders: { n: data.reminders.length },
                    'Background timers': { n: data.timers.list.length },
                  }
                : undefined
            }
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
          {tab === 'Agent tasks' ? <AgentTasks data={data} /> : tab === 'Workflows' ? <Workflows data={data} /> : tab === 'Reminders' ? <Reminders data={data} /> : <Timers data={data} />}
          <div className="mt-4 space-y-1 px-6 text-[11.5px] leading-relaxed text-faint md:px-8">
            {data.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
