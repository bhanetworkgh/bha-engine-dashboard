/**
 * The Help pages tab on the Customer Service Twin (27 Oct 2026, Destiny).
 *
 * The pages CST will answer vFarm pilot operators from, each at one address
 * (`/cs-twin?tab=help&page=<id>`) so the team can share it. Each page says its
 * stage in words: a draft with its open gaps named and who owes them, checked by
 * Hardik against Honest Gate, or in cst-help-manuals. Nothing here edits a page:
 * Destiny writes them over MCP, and Hardik's check is recorded on his own Slack
 * message. CST itself never reads these rows; it reads cst-help-manuals.
 */
import { Fragment, type ReactNode } from 'react';
import type { HelpPage, HelpPagesData } from '../../data';
import { Button, Card, CardHeader, Pill, relativeTime } from '../../components/ui';

const NAMES: Record<string, string> = { U0AEW3TBYH1: 'Destiny', U0A9V97949F: 'Jason', U0BKT6MAW2Y: 'Hardik' };
const nameOf = (id: string | null) => (id ? NAMES[id] ?? id : '—');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

function StagePill({ p }: { p: HelpPage }) {
  if (p.stage === 'in_corpus') return <Pill tone="accent">{p.stage_label}</Pill>;
  if (p.stage === 'checked') return <Pill>{p.stage_label}</Pill>;
  return <Pill>{p.stage_label}</Pill>;
}

/** **bold** inside a line. Nothing else is interpreted: the text is a record, not a template. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((s, i) => (s.startsWith('**') && s.endsWith('**') ? <strong key={i}>{s.slice(2, -2)}</strong> : <Fragment key={i}>{s}</Fragment>));
}

/** The small markdown the pages are written in: ## and ### headings, - bullets, 1. steps, - [ ] checks, paragraphs. */
export function HelpBody({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      blocks.push(
        h[1].length === 2 ? (
          <h3 key={i} className="mt-5 text-[15px] font-semibold first:mt-0">{inline(h[2])}</h3>
        ) : (
          <h4 key={i} className="mt-4 text-[13.5px] font-semibold">{inline(h[2])}</h4>
        ),
      );
      i++;
      continue;
    }
    const kind = /^- \[[ x]\]\s/.test(line) ? 'check' : /^- /.test(line) ? 'bullet' : /^\d+\.\s/.test(line) ? 'step' : null;
    if (kind) {
      const items: string[] = [];
      const re = kind === 'check' ? /^- \[[ x]\]\s+/ : kind === 'bullet' ? /^- / : /^\d+\.\s+/;
      while (i < lines.length && re.test(lines[i]) && (kind !== 'bullet' || !/^- \[[ x]\]\s/.test(lines[i]))) {
        items.push(lines[i].replace(re, ''));
        i++;
      }
      const key = `l${i}`;
      if (kind === 'step')
        blocks.push(
          <ol key={key} className="mt-2 list-decimal space-y-1 pl-5">
            {items.map((t, j) => <li key={j}>{inline(t)}</li>)}
          </ol>,
        );
      else
        blocks.push(
          <ul key={key} className={`mt-2 space-y-1 ${kind === 'check' ? 'pl-1' : 'list-disc pl-5'}`}>
            {items.map((t, j) => (
              <li key={j}>
                {kind === 'check' && <span className="mr-2 text-faint" aria-hidden>☐</span>}
                {inline(t)}
              </li>
            ))}
          </ul>,
        );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{2,3}\s|- |\d+\.\s)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={`p${i}`} className="mt-2">{inline(para.join(' '))}</p>);
  }
  return <div className="text-[13.5px] leading-relaxed">{blocks}</div>;
}

function PageList({ data, onOpen }: { data: HelpPagesData; onOpen: (id: string) => void }) {
  const c = data.counts;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-dim">
        {data.pages.length} page{data.pages.length === 1 ? '' : 's'} · {c.draft} draft · {c.checked} checked by Hardik · {c.in_corpus} in cst-help-manuals ·{' '}
        {c.gaps_open} gap{c.gaps_open === 1 ? '' : 's'} open. CST answers customers only from cst-help-manuals, never from this tab.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {data.pages.map((p) => (
          <button key={p.page_id} type="button" onClick={() => onOpen(p.page_id)} className="card flex h-full flex-col gap-2 px-5 py-4 text-left transition hover:shadow-md">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[14px] font-semibold leading-snug">{p.title}</span>
            </div>
            <div><StagePill p={p} /></div>
            <span className="text-[12px] text-dim">
              {p.gaps.length ? `Waiting on ${[...new Set(p.gaps.map((g) => g.owner))].join(', ')}` : p.stage === 'draft' ? 'Waiting on Hardik\'s check' : p.stage === 'checked' ? 'Ready for cst-help-manuals' : 'Live in the help library'}
            </span>
            <span className="mt-auto text-[11.5px] text-faint">updated {relativeTime(p.updated_at) ?? day(p.updated_at)} by {nameOf(p.updated_by)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PageView({ p, data, onBack }: { p: HelpPage; data: HelpPagesData; onBack: () => void }) {
  const hist = data.history.filter((h) => h.page_id === p.page_id);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <div className="px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="kicker tabular">{p.page_id}</div>
              <h2 className="mt-1 text-[19px] leading-tight">{p.title}</h2>
            </div>
            <Button variant="ghost" size="sm" onClick={onBack}>All pages</Button>
          </div>
          {!p.customer_safe && (
            <p className="mt-3 rounded-md bg-accent-soft px-3 py-2 text-[12px] text-dim">
              {p.stage === 'draft' ? 'Draft: not reviewed. Do not send this to a customer or pilot operator as BHA\'s answer.' : 'Checked by Hardik, not yet in cst-help-manuals: CST does not answer from it yet.'}
            </p>
          )}
          <div className="mt-4 border-t border-line pt-4">
            <HelpBody body={p.body} />
          </div>
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Stage" />
          <div className="flex flex-col gap-2 px-5 pb-4 text-[12.5px]">
            <div><StagePill p={p} /></div>
            {p.checked_by && (
              <span className="text-dim">
                Checked by {nameOf(p.checked_by)} on {day(p.checked_at)}
                {p.check_evidence && (
                  <>
                    {' · '}
                    <a href={p.check_evidence} target="_blank" rel="noreferrer" className="text-accent hover:underline">his message ↗</a>
                  </>
                )}
              </span>
            )}
            {p.bharag_doc_id && <span className="text-dim">In cst-help-manuals as {p.bharag_doc_id}, {day(p.in_corpus_at)}</span>}
            <span className="text-faint">Last changed {relativeTime(p.updated_at) ?? day(p.updated_at)} by {nameOf(p.updated_by)}</span>
          </div>
        </Card>
        <Card>
          <CardHeader title="Open gaps" />
          <div className="px-5 pb-4 text-[12.5px]">
            {p.gaps.length ? (
              <ul className="flex flex-col gap-3">
                {p.gaps.map((g) => (
                  <li key={g.id}>
                    <div className="font-medium">{g.owner}</div>
                    <div className="text-dim">{g.note}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-dim">None. Every part of this page is written.</span>
            )}
          </div>
        </Card>
        {p.sources && (
          <Card>
            <CardHeader title="Written from" />
            <p className="px-5 pb-4 text-[12.5px] text-dim">{p.sources}</p>
          </Card>
        )}
        <Card>
          <CardHeader title="History" />
          <ul className="flex flex-col gap-2 px-5 pb-4 text-[12px]">
            {hist.length ? hist.map((h) => (
              <li key={h.id} className="text-dim">
                <span className="tabular text-faint">{day(h.at)}</span> {h.action.replace(/_/g, ' ')} by {nameOf(h.actor)}
                {h.note ? `: ${h.note}` : ''}
              </li>
            )) : <li className="text-faint">Nothing recorded.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

export default function HelpPages({ data, openId, setOpenId }: { data: HelpPagesData; openId: string | null; setOpenId: (id: string | null) => void }) {
  if (!data.pages.length) return <p className="text-[13px] text-dim">No help page is written yet.</p>;
  const p = openId ? data.pages.find((x) => x.page_id === openId) : null;
  if (openId && !p) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-dim">There is no help page called "{openId}". These are the pages there are:</p>
        <PageList data={data} onOpen={setOpenId} />
      </div>
    );
  }
  return p ? <PageView p={p} data={data} onBack={() => setOpenId(null)} /> : <PageList data={data} onOpen={setOpenId} />;
}
