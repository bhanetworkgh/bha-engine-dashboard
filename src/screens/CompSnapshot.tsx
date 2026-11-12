import type { ReactNode } from 'react';
import { useData } from '../app/useData';
import { getCompSnapshot } from '../data';
import { EmptyState, LoadFailed, Loading, PageHeader, relativeTime } from '../components/ui';

/**
 * The founder comp snapshot (12 Nov 2026, Destiny — Jason, DM D0AF0DG8ZPY 1794498144.803619): equity, stages and
 * pay, the waterfall, knowledge capture and production income, on one page he can read. Behind the admin login,
 * because it holds every founder's day rate and equity.
 *
 * The sections are Destiny's, written through write_comp_snapshot; every change keeps the text it replaced. The day
 * rates and the Stage 1 table are read live from the pay card's rates and the Stage 1 page, so they cannot drift.
 */
const WHO: Record<string, string> = { U0AEW3TBYH1: 'Destiny', U0A9V97949F: 'Jason' };

/** **bold** inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i} className="font-semibold text-ink">{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
  );
}

/** "## " headings, "- " bullets, "  - " sub-bullets, blank lines between paragraphs. */
function Body({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: { depth: number; text: string }[] = [];
  const flush = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    out.push(
      <ul key={`l${out.length}`} className="my-1.5 space-y-1">
        {items.map((it, i) => (
          <li key={i} className={`flex gap-2 ${it.depth ? 'pl-5' : ''}`}>
            <span className="text-faint">{it.depth ? '◦' : '•'}</span>
            <span>{inline(it.text)}</span>
          </li>
        ))}
      </ul>,
    );
  };
  for (const raw of text.split('\n')) {
    const bullet = /^(\s*)[-•]\s+(.*)$/.exec(raw);
    if (bullet) {
      list.push({ depth: bullet[1].length >= 2 ? 1 : 0, text: bullet[2] });
      continue;
    }
    flush();
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('## ')) out.push(<h3 key={`h${out.length}`} className="mt-4 mb-1 text-[13.5px] font-semibold text-ink">{inline(line.slice(3))}</h3>);
    else out.push(<p key={`p${out.length}`} className="my-1.5">{inline(line)}</p>);
  }
  flush();
  return <div className="text-[13px] leading-relaxed text-dim">{out}</div>;
}

const money = (v: string) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export default function CompSnapshot() {
  const { status, data, error } = useData(getCompSnapshot, []);
  if (status === 'loading' || !data) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Comp snapshot" subtitle="Equity, stages and pay, the waterfall and production income, for every founder" />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 max-w-[104ch] px-6 pb-3 text-[11.5px] leading-snug text-faint md:px-8">
          Kept by Destiny for Jason{data.updated_at ? `; last changed ${relativeTime(data.updated_at) ?? data.updated_at.slice(0, 10)}` : ''}. Day rates and the Stage 1 table below are read live from the pay rates and the Stage 1 page. Every earlier version of a section is kept.
        </div>

        {data.sections.length === 0 ? (
          <EmptyState>No section has been written yet.</EmptyState>
        ) : (
          data.sections.map((s) => (
            <section key={s.section_id} className="card mx-6 mb-4 max-w-[110ch] px-6 py-5 md:mx-8">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="card-title text-[15px]">{s.title}</h2>
                <span className="text-[11px] text-faint whitespace-nowrap">{WHO[s.updated_by] ?? s.updated_by}, {relativeTime(s.updated_at) ?? s.updated_at.slice(0, 10)}</span>
              </div>
              <Body text={s.body} />
            </section>
          ))
        )}

        <section className="card mx-6 mb-4 max-w-[110ch] overflow-x-auto px-6 py-5 md:mx-8">
          <h2 className="card-title text-[15px]">Day rates by start date</h2>
          <p className="mt-1 text-[11.5px] text-faint">The rates the pay cards use. A change is a new row, so every past day keeps the rate it was worked at. Only daily-rate people are here; Jegan is paid through the Stacx24 retainer.</p>
          <table className="mt-3 w-full min-w-[640px] border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] text-faint">
                {['person', 'day rate', 'from', 'in effect', 'note'].map((h) => <th key={h} className="border-b border-line px-3 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.rates.map((r) => {
                const later = data.rates.filter((x) => x.builder_slack_id === r.builder_slack_id && x.effective_from > r.effective_from && x.effective_from <= today);
                const state = r.effective_from > today ? 'scheduled' : later.length ? 'ended' : 'now';
                return (
                  <tr key={`${r.builder_slack_id}-${r.effective_from}`}>
                    <td className="td card-title">{r.builder}</td>
                    <td className="td tabular">{money(r.day_rate_usd)}</td>
                    <td className="td tabular text-dim">{r.effective_from.slice(0, 10)}</td>
                    <td className={`td ${state === 'now' ? 'text-accent' : 'text-dim'}`}>{state}</td>
                    <td className="td text-dim">{r.note ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card mx-6 mb-6 max-w-[110ch] overflow-x-auto px-6 py-5 md:mx-8">
          <h2 className="card-title text-[15px]">Stage 1 table</h2>
          <p className="mt-1 text-[11.5px] text-faint">Read from the Stage 1 page, where each row is edited.</p>
          <table className="mt-3 w-full min-w-[760px] border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] text-faint">
                {['person', 'status', 'sent', 'signed', 'countersigned', 'knowledge capture'].map((h) => <th key={h} className="border-b border-line px-3 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.stage1.map((r) => (
                <tr key={r.id}>
                  <td className="td card-title">{r.name}</td>
                  <td className="td text-dim">{r.plan_status ?? '—'}</td>
                  <td className="td tabular text-dim">{r.agreement_sent ?? '—'}</td>
                  <td className="td tabular text-dim">{r.signed ?? '—'}</td>
                  <td className="td tabular text-dim">{r.countersigned ?? '—'}</td>
                  <td className="td text-dim" style={{ maxWidth: '48ch' }}>{r.knowledge_capture ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
