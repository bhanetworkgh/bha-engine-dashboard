import { useData } from '../../app/useData';
import { getGenieControls, type GenieControlAction } from '../../data';
import { EmptyState, LoadFailed, Loading, Pill } from '../../components/ui';

/**
 * Genie's controls (16 Nov 2026, Destiny): the channels Genie follows, whether it speaks up there
 * unasked, each channel's daily ask limit and memory, the recurring tasks, and the log of every
 * change and run. A read: the changes are made by asking Genie in Slack. Rules: server/src/genieControl.ts.
 */

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const when = (s: string | null) => (s ? s.replace('T', ' ').slice(0, 16) : '');
const pad = (n: number) => String(n).padStart(2, '0');

const ACTION: Record<string, string> = {
  genie_channel_updated: 'Channel settings changed',
  genie_memory_added: 'Note remembered',
  genie_memory_removed: 'Note forgotten',
  genie_limit_reached: 'Daily limit reached',
  genie_task_created: 'Recurring task set up',
  genie_task_cancelled: 'Recurring task cancelled',
  genie_task_ran: 'Recurring task ran',
  genie_nudge_posted: 'Spoke up on an unanswered question',
};

function detailLine(a: GenieControlAction): string {
  const d = a.detail ?? {};
  if (typeof d.note === 'string') return d.note;
  if (typeof d.prompt === 'string') return d.prompt;
  if (typeof d.result === 'string') return d.result;
  return Object.entries(d).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(', ');
}

export default function Controls() {
  const { status, data, error } = useData(getGenieControls, [], { kinds: ['genie_events'] });
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  const active = data.tasks.filter((t) => t.status === 'active');
  return (
    <div className="space-y-6 px-6 pb-8 md:px-8">
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Channels</h2>
        {data.channels.length === 0 ? (
          <div className="p-4"><EmptyState>No channel has a setting or a note yet. Ask Genie in a channel: "follow this channel", "remember that …" or "limit this channel to 50 asks a day".</EmptyState></div>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">channel</th><th className="px-4 py-2 font-medium">following</th><th className="px-4 py-2 font-medium">speaks up</th><th className="px-4 py-2 font-medium">asks today</th><th className="px-4 py-2 font-medium">memory</th><th className="px-4 py-2 font-medium">last change</th></tr></thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.channel_id} className="border-t border-line align-top">
                  <td className="px-4 py-2 tabular text-ink">{c.channel_id}</td>
                  <td className="px-4 py-2">{c.followed ? <Pill>yes</Pill> : <span className="text-faint">no</span>}</td>
                  <td className="px-4 py-2">{c.proactive ? <Pill>on</Pill> : <span className="text-faint">off</span>}</td>
                  <td className="px-4 py-2 tabular">{c.asks_today}{c.daily_limit !== null ? ` of ${c.daily_limit}` : ' (no limit)'}</td>
                  <td className="px-4 py-2">{c.memory.length === 0 ? <span className="text-faint">none</span> : <ul className="space-y-1">{c.memory.map((n) => <li key={n.id} className="text-ink">{n.note} <span className="text-faint">({n.by}, {when(n.at)})</span></li>)}</ul>}</td>
                  <td className="px-4 py-2 text-dim">{c.updated_by ? `${c.updated_by}, ` : ''}{when(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Recurring tasks</h2>
        {active.length === 0 ? (
          <div className="p-4"><EmptyState>No recurring task is set up. Ask Genie in a channel, for example "every Monday at 9am post my open loops here".</EmptyState></div>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead><tr className="text-left text-dim"><th className="px-4 py-2 font-medium">task</th><th className="px-4 py-2 font-medium">what</th><th className="px-4 py-2 font-medium">when</th><th className="px-4 py-2 font-medium">next run</th><th className="px-4 py-2 font-medium">last run</th></tr></thead>
            <tbody>
              {active.map((t) => (
                <tr key={t.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 tabular text-ink">{t.id}<div className="text-faint">{t.channel_id}, by {t.created_by}</div></td>
                  <td className="px-4 py-2 text-ink">{t.prompt}</td>
                  <td className="px-4 py-2 text-dim">{t.schedule.days.map((d) => DAY[d]).join(', ')} at {pad(t.schedule.hour)}:{pad(t.schedule.minute)} ({t.schedule.tz})</td>
                  <td className="px-4 py-2 tabular">{when(t.next_run_at)} UTC</td>
                  <td className="px-4 py-2 text-dim">{t.last_run_at ? `${when(t.last_run_at)} UTC${t.last_result ? `: ${t.last_result}` : ''}` : <span className="text-faint">not yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">What Genie did, and who asked</h2>
        {data.actions.length === 0 ? (
          <div className="p-4"><EmptyState>Nothing yet. Every change to a channel, every note, every recurring task and every time Genie speaks up unasked is listed here.</EmptyState></div>
        ) : (
          <table className="mt-2 w-full text-sm">
            <tbody>
              {data.actions.map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-4 py-2 tabular text-dim">{when(a.at)} UTC</td>
                  <td className="px-4 py-2 text-ink">{ACTION[a.event_type] ?? a.event_type}</td>
                  <td className="px-4 py-2 tabular text-dim">{a.subject_id}</td>
                  <td className="px-4 py-2 text-dim">{a.actor ?? ''}</td>
                  <td className="px-4 py-2 text-ink">{detailLine(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
