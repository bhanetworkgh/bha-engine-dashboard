import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  addVfarmLeadNote,
  closeVfarmLead,
  moveVfarmLeadStage,
  reopenVfarmLead,
  setVfarmLeadNextStep,
  type VfarmLead,
  type VfarmLeadsData,
} from '../../data';
import type { RecordColumn } from '../../components/ui';
import { Button, Pagination, Pill, RecordTable, SearchBox, Segmented, Stat, StatCell, StatStrip, Toast, usePaged, useToast } from '../../components/ui';
import { FORM_A_GROUPS, FORM_A_QUESTIONS } from '../../data/formA';
import { CLOSE_REASONS, PIPELINE, closeReasonLabel, pipelineOf, rotting, type PipelineKey } from '../../data/leadPipeline';
import { Intake2Panel, Intake2Tag } from './Intake2Panel';

/**
 * vFarm Early Access, as a CRM (rebuilt 15 Oct 2026, Destiny: "the entire early access page
 * needs to be completely rebuilt following CRM standards because that's what it is").
 *
 * The shape follows what Pipedrive, HubSpot, Attio and Close share: a board of the pipeline's
 * columns and the same leads as a list; days in the column on every card, amber once past the
 * column's limit (src/data/leadPipeline.ts); one record page per lead with who they are on the
 * left, the next step and the timeline in the middle, and Intake-2 on the right; and a close
 * that needs a reason. No owner field: the dashboard has one login.
 *
 * Nothing here is a commitment. A lead says a person filled in a form, and the five request
 * checks stay open whatever column a lead is in.
 */

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const stamp = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
const today = () => new Date().toISOString().slice(0, 10);

type View = 'board' | 'list';
type ListFilter = 'open' | PipelineKey | 'all';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const colOf = (l: VfarmLead) => pipelineOf({ ...l, stage: l.stage ?? 1 }).key;
const rotOf = (l: VfarmLead) => rotting({ ...l, stage: l.stage ?? 1 });
const overdue = (l: VfarmLead) => !!l.next_step_due && l.next_step_due < today() && !l.closed_at;

export default function EarlyAccess({ data, onChange, initialOpen = null }: { data: VfarmLeadsData; onChange: (leads: VfarmLead[]) => void; initialOpen?: string | null }) {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>(() => (params.get('view') === 'list' ? 'list' : 'board'));
  const [filter, setFilter] = useState<ListFilter>('open');
  const [q, setQ] = useState('');
  const { toast, setToast } = useToast();
  const leads = data.leads;
  const openId = params.get('lead') ?? initialOpen;

  function setOpen(id: string | null) {
    const next = new URLSearchParams(params);
    next.set('tab', 'early-access');
    if (id) next.set('lead', id);
    else next.delete('lead');
    setParams(next, { replace: false });
  }
  function pickView(v: View) {
    setView(v);
    const next = new URLSearchParams(params);
    next.set('tab', 'early-access');
    if (v === 'list') next.set('view', 'list');
    else next.delete('view');
    setParams(next, { replace: true });
  }

  /** Every write answers with the lead as it now is; that row replaces the one on screen. */
  function replace(updated: VfarmLead) {
    onChange(leads.map((l) => (l.id === updated.id ? updated : l)));
  }
  const say = (text: string, tone: 'ok' | 'failing') => setToast({ text, tone });

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return leads;
    return leads.filter(
      (l) => l.full_name.toLowerCase().includes(needle) || l.email.includes(needle) || (l.organization_name ?? '').toLowerCase().includes(needle),
    );
  }, [leads, q]);

  const byCol = useMemo(() => {
    const m = new Map<PipelineKey, VfarmLead[]>(PIPELINE.map((c) => [c.key, []]));
    for (const l of matched) m.get(colOf(l))!.push(l);
    // Longest in the column first: the card most likely to need somebody sits at the top.
    for (const [k, list] of m) list.sort((a, b) => (k === 'closed' ? (b.closed_at ?? '').localeCompare(a.closed_at ?? '') : rotOf(b).days - rotOf(a).days));
    return m;
  }, [matched]);

  const open = leads.filter((l) => !l.closed_at);
  const late = open.filter((l) => rotOf(l).over);
  const due = open.filter(overdue);
  const closed = leads.filter((l) => l.closed_at);
  const reasons = CLOSE_REASONS.map((r) => ({ ...r, n: closed.filter((l) => l.closed_reason === r.key).length })).filter((r) => r.n > 0);

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null;

  if (openId && openLead) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LeadRecord lead={openLead} onBack={() => setOpen(null)} onUpdated={replace} onToast={say} />
        <Toast toast={toast} />
      </div>
    );
  }

  const listRows = matched.filter((l) => (filter === 'all' ? true : filter === 'open' ? !l.closed_at : colOf(l) === filter));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Open leads" value={open.length} hint={`${data.summary.last_7_days} joined in the last 7 days`} />
        </StatCell>
        <StatCell>
          <Stat label="Past their time" value={late.length} tone={late.length ? 'degraded' : undefined} hint="longer in their column than it should take" />
        </StatCell>
        <StatCell>
          <Stat label="Next step overdue" value={due.length} tone={due.length ? 'degraded' : undefined} hint="a due date that has passed" />
        </StatCell>
        <StatCell>
          <Stat label="Closed" value={closed.length} hint={reasons.length ? reasons.map((r) => `${r.label} ${r.n}`).join(' · ') : 'none closed yet'} />
        </StatCell>
      </StatStrip>

      {openId && !openLead && (
        <p className="px-6 pb-2 text-[12.5px] text-dim md:px-8">
          No lead with id {openId} is held. <button className="link" onClick={() => setOpen(null)}>Show the pipeline</button>
        </p>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-3 md:px-8">
        <Segmented
          options={[
            { value: 'board' as View, label: 'Board' },
            { value: 'list' as View, label: 'List' },
          ]}
          value={view}
          onChange={pickView}
          ariaLabel="View"
        />
        {view === 'list' && (
          <Segmented
            options={[
              { value: 'open' as ListFilter, label: 'Open', count: matched.filter((l) => !l.closed_at).length },
              ...PIPELINE.map((c) => ({ value: c.key as ListFilter, label: c.label, count: byCol.get(c.key)!.length })),
              { value: 'all' as ListFilter, label: 'All', count: matched.length },
            ]}
            value={filter}
            onChange={setFilter}
            ariaLabel="Column"
          />
        )}
        <SearchBox value={q} onChange={setQ} placeholder="Search name, email or organisation" />
        <Button
          size="sm"
          disabled={(view === 'list' ? listRows : matched.filter((l) => !l.closed_at)).length === 0}
          onClick={async () => {
            const rows = view === 'list' ? listRows : matched.filter((l) => !l.closed_at);
            const emails = [...new Set(rows.map((l) => l.email))];
            const ok = await copy(emails.join(', '));
            say(ok ? `Copied ${emails.length} ${emails.length === 1 ? 'address' : 'addresses'}` : 'The browser would not let the page write to the clipboard.', ok ? 'ok' : 'failing');
          }}
        >
          Copy emails
        </Button>
      </div>

      <div className="min-h-0 flex-1 pb-8">
        {leads.length === 0 ? (
          <p className="px-6 py-10 text-center text-[13px] text-dim md:px-8">
            No Early Access lead is held. Every lead arrives through Form A, and Hardik&rsquo;s n8n tracker posts each one here as it comes in; this is empty because nothing has arrived, not because nothing is being recorded.
          </p>
        ) : view === 'board' ? (
          <Board byCol={byCol} onOpen={(l) => setOpen(l.id)} />
        ) : (
          <LeadList rows={listRows} filterKey={`${filter}:${q}`} onOpen={(l) => setOpen(l.id)} onToast={say} />
        )}
      </div>
      <Toast toast={toast} />
    </div>
  );
}

/* ───────────────────────────── board ───────────────────────────── */

const BOARD_CAP = 20;

function Board({ byCol, onOpen }: { byCol: Map<PipelineKey, VfarmLead[]>; onOpen: (l: VfarmLead) => void }) {
  return (
    // The board scrolls sideways inside its own frame; the page body never does.
    <div className="overflow-x-auto px-6 md:px-8">
      <div className="grid min-w-[1040px] grid-cols-5 gap-3">
        {PIPELINE.map((c) => {
          const list = byCol.get(c.key)!;
          return (
            <section key={c.key} className="flex min-w-0 flex-col rounded-[14px] bg-hover p-2">
              <header className="px-1.5 pb-2 pt-1">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[13px] font-medium text-ink">{c.label}</h3>
                  <span className="tabular text-[12px] text-faint">{list.length}</span>
                </div>
                <div className="text-[11px] leading-snug text-faint">
                  {c.hint}
                  {c.limit_days ? ` · ${c.limit_days} days` : ''}
                </div>
              </header>
              <div className="space-y-2">
                {list.slice(0, BOARD_CAP).map((l) => (
                  <LeadCard key={l.id} lead={l} onOpen={() => onOpen(l)} />
                ))}
                {list.length === 0 && <p className="px-1.5 py-3 text-[11.5px] text-faint">Nobody here.</p>}
                {list.length > BOARD_CAP && <p className="px-1.5 py-1 text-[11.5px] text-faint">and {list.length - BOARD_CAP} more in the list view</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function LeadCard({ lead: l, onOpen }: { lead: VfarmLead; onOpen: () => void }) {
  const r = rotOf(l);
  const col = colOf(l);
  return (
    <button type="button" onClick={onOpen} className="card block w-full px-3 py-2.5 text-left transition hover:ring-1 hover:ring-accent/40">
      <div className="truncate text-[13px] font-medium text-ink">{l.full_name}</div>
      <div className="truncate text-[11.5px] text-dim">{l.organization_name ?? l.email}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        {col === 'closed' ? (
          <Pill>{closeReasonLabel(l.closed_reason)}</Pill>
        ) : (
          <span className={`tabular ${r.over ? 'text-degraded' : 'text-faint'}`} title={r.limit ? `${r.days} of ${r.limit} days in ${col}` : undefined}>
            {r.days === 0 ? 'today' : `${r.days}d`}
          </span>
        )}
        {(col === 'invited' || col === 'spec') && <Intake2Tag lead={l} />}
        {l.is_repeat_email && <Pill>repeat</Pill>}
      </div>
      {l.next_step && (
        <div className={`mt-1.5 truncate text-[11.5px] ${overdue(l) ? 'text-degraded' : 'text-dim'}`} title={l.next_step}>
          Next: {l.next_step}
          {l.next_step_due ? ` · ${l.next_step_due}` : ''}
        </div>
      )}
    </button>
  );
}

/* ───────────────────────────── list ───────────────────────────── */

function LeadList({ rows, filterKey, onOpen, onToast }: { rows: VfarmLead[]; filterKey: string; onOpen: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const paged = usePaged(rows, filterKey);
  const columns: RecordColumn<VfarmLead>[] = [
    { key: 'joined', header: 'joined', className: 'tabular text-faint', card: 'meta', cell: (l) => day(l.created_at), title: (l) => stamp(l.created_at) },
    { key: 'name', header: 'name', card: 'title', width: '20ch', clip: true, title: (l) => l.full_name, cell: (l) => l.full_name },
    { key: 'org', header: 'organisation', card: 'meta', width: '20ch', clip: true, className: 'text-dim', cell: (l) => l.organization_name ?? <span className="text-faint">—</span> },
    {
      key: 'col',
      header: 'column',
      card: 'meta',
      width: '16ch',
      cell: (l) => <Pill>{l.closed_at ? `Closed · ${closeReasonLabel(l.closed_reason)}` : PIPELINE.find((c) => c.key === colOf(l))!.label}</Pill>,
    },
    {
      key: 'days',
      header: 'days',
      align: 'right',
      card: 'meta',
      className: 'tabular',
      cellClass: (l) => (rotOf(l).over ? 'text-degraded' : 'text-faint'),
      title: (l) => {
        const r = rotOf(l);
        return r.limit ? `${r.days} of ${r.limit} days` : `${r.days} days`;
      },
      cell: (l) => (l.closed_at ? '' : rotOf(l).days),
    },
    { key: 'intake2', header: 'intake-2', card: 'meta', width: '20ch', cell: (l) => <Intake2Tag lead={l} /> },
    {
      key: 'next',
      header: 'next step',
      card: 'full',
      width: '30ch',
      clip: true,
      cellClass: (l) => (overdue(l) ? 'text-degraded' : 'text-dim'),
      title: (l) => l.next_step ?? undefined,
      cell: (l) => (l.next_step ? `${l.next_step_due ? `${l.next_step_due} · ` : ''}${l.next_step}` : <span className="text-faint">—</span>),
    },
    {
      key: 'email',
      header: 'email',
      card: 'meta',
      width: '26ch',
      clip: true,
      title: (l) => l.email,
      cell: (l) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{l.email}</span>
          {l.is_repeat_email && <Pill>repeat</Pill>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (l) => (
        <button
          type="button"
          className="link text-[11.5px]"
          onClick={async (e) => {
            e.stopPropagation();
            const ok = await copy(l.email);
            onToast(ok ? `Copied ${l.email}` : 'The browser would not let the page write to the clipboard.', ok ? 'ok' : 'failing');
          }}
        >
          Copy email
        </button>
      ),
    },
  ];
  return (
    <>
      <RecordTable columns={columns} rows={paged.rows} rowKey={(l) => l.id} onOpen={onOpen} label="vFarm Early Access leads" empty="No lead matches that filter." />
      <Pagination paged={paged} unit="leads" />
    </>
  );
}

/* ───────────────────────────── record ───────────────────────────── */

function LeadRecord({ lead, onBack, onUpdated, onToast }: { lead: VfarmLead; onBack: () => void; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const col = colOf(lead);
  return (
    <div className="px-6 pb-10 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Pipeline
          </Button>
          <h2 className="mt-1 truncate text-[20px] font-semibold text-ink">{lead.full_name}</h2>
          <div className="truncate text-[12.5px] text-dim">
            {lead.organization_name ?? 'No organisation given'} · joined {day(lead.created_at)}
          </div>
        </div>
        <PipelineSteps current={col} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-4">
          <Profile lead={lead} onToast={onToast} />
        </div>
        <div className="min-w-0 space-y-4">
          <Actions lead={lead} onUpdated={onUpdated} onToast={onToast} />
          <NextStep lead={lead} onUpdated={onUpdated} onToast={onToast} />
          <Timeline lead={lead} onUpdated={onUpdated} onToast={onToast} />
        </div>
        <div className="min-w-0 space-y-4">
          {(lead.stage ?? 1) >= 2 || lead.intake_2_invite || lead.intake_2 ? (
            <div className="card px-4 py-3">
              <Intake2Panel lead={lead} onToast={onToast} />
            </div>
          ) : (
            <div className="card px-4 py-3 text-[12.5px] text-dim">
              <h3 className="kicker mb-1.5">Intake-2</h3>
              Not sent. Moving the lead to Invited emails them their own site specification link.
            </div>
          )}
          <div className="card px-4 py-3 text-[12px] text-dim">
            <h3 className="kicker mb-1.5">The five request checks</h3>
            Feasibility, pricing, ownership, licensing and food safety stay open in every column. What a lead tells us is evidence for them, never a decision.
          </div>
        </div>
      </div>
    </div>
  );
}

function PipelineSteps({ current }: { current: PipelineKey }) {
  const steps = PIPELINE.filter((c) => c.key !== 'closed');
  const at = steps.findIndex((c) => c.key === current);
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11.5px]" aria-label="Where this lead is">
      {current === 'closed' ? (
        <li>
          <Pill>Closed</Pill>
        </li>
      ) : (
        steps.map((c, i) => (
          <li key={c.key} className={`rounded-full px-2.5 py-1 ${i === at ? 'bg-accent text-accent-on' : i < at ? 'bg-accent-soft text-accent-ink' : 'bg-hover text-faint'}`}>
            {c.label}
          </li>
        ))
      )}
    </ol>
  );
}

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="kicker">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Forward is the one primary on the record; back and close are secondary. */
function Actions({ lead, onUpdated, onToast }: { lead: VfarmLead; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState<string>('unresponsive');
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const stage = lead.stage ?? 1;
  const col = colOf(lead);
  const forward: { to: 2 | 3; label: string } | null =
    lead.closed_at ? null : stage === 1 ? { to: 2, label: 'Move to Invited and send Intake-2' } : stage === 2 && lead.intake_2_completed_at ? { to: 3, label: 'Move to Paying' } : null;
  const back: { to: 1 | 2; label: string } | null = lead.closed_at ? null : stage === 2 ? { to: 1, label: 'Back to Interest' } : stage === 3 ? { to: 2, label: 'Back to Spec received' } : null;

  async function run(key: string, fn: () => Promise<VfarmLead>, ok: (l: VfarmLead) => string) {
    setBusy(key);
    try {
      const l = await fn();
      onUpdated(l);
      const inv = l.intake_2_invite_result;
      onToast(inv ? `${ok(l)} ${inv.message}` : ok(l), inv && !inv.ok ? 'failing' : 'ok');
      return true;
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'That did not save.', 'failing');
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (lead.closed_at) {
    return (
      <Card title="Closed">
        <p className="text-[12.5px] text-ink">
          {closeReasonLabel(lead.closed_reason)} · {stamp(lead.closed_at)}
        </p>
        {lead.closed_note && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-dim">{lead.closed_note}</p>}
        <div className="mt-3">
          <Button size="sm" loading={busy === 'reopen'} onClick={() => run('reopen', () => reopenVfarmLead(lead.id), () => 'Reopened.')}>
            Reopen
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={PIPELINE.find((c) => c.key === col)!.label}>
      <p className="mb-2 text-[12px] text-dim">
        {col === 'interest' && 'Form A is in. Interest only, nothing promised.'}
        {col === 'invited' && 'Waiting on their site specification. Follow-ups go at 3 and 7 days; Unresponsive at 14.'}
        {col === 'spec' && 'Their site specification is in. BHA reviews it before anything else.'}
        {col === 'paying' && 'A placeholder: no payment is taken here until Jason and Hardik set the price and the checkout.'}
        {stage === 2 && !lead.intake_2_completed_at ? ' Paying opens once their site specification is in.' : ''}
      </p>
      {(forward || back) && (
        <input className="input mb-2 h-8 w-full text-[12.5px]" placeholder="Why (optional, goes on the timeline)" value={why} onChange={(e) => setWhy(e.target.value)} />
      )}
      <div className="flex flex-wrap gap-2">
        {forward && (
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'fwd'}
            onClick={async () => {
              if (await run('fwd', () => moveVfarmLeadStage(lead.id, forward.to, why.trim() || null), () => `Moved to ${forward.to === 2 ? 'Invited' : 'Paying'}.`)) setWhy('');
            }}
          >
            {forward.label}
          </Button>
        )}
        {back && (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'back'}
            onClick={async () => {
              if (await run('back', () => moveVfarmLeadStage(lead.id, back.to, why.trim() || null), () => `${back.label}.`)) setWhy('');
            }}
          >
            {back.label}
          </Button>
        )}
        <Button size="sm" onClick={() => setClosing((v) => !v)}>
          {closing ? 'Cancel' : 'Close lead'}
        </Button>
      </div>
      {closing && (
        <div className="mt-3 space-y-2 rounded-[10px] border border-line p-3">
          <div className="text-[12px] text-dim">Why is it closing?</div>
          <Segmented options={CLOSE_REASONS.map((r) => ({ value: r.key as string, label: r.label }))} value={reason} onChange={setReason} ariaLabel="Close reason" />
          <textarea
            className="input min-h-[60px] w-full py-2 text-[12.5px]"
            placeholder={reason === 'other' ? 'Say why (needed for Other)' : 'A note (optional)'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={reason === 'other' && !note.trim()}
            loading={busy === 'close'}
            onClick={async () => {
              if (await run('close', () => closeVfarmLead(lead.id, reason, note.trim() || null), () => `Closed: ${closeReasonLabel(reason)}.`)) {
                setClosing(false);
                setNote('');
              }
            }}
          >
            Close as {closeReasonLabel(reason)}
          </Button>
          {lead.intake_2_invite && !lead.intake_2 && <p className="text-[11.5px] text-faint">Closing stops Intake-2&rsquo;s follow-ups. If they answer anyway, the lead opens again by itself.</p>}
        </div>
      )}
    </Card>
  );
}

function NextStep({ lead, onUpdated, onToast }: { lead: VfarmLead; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const [step, setStep] = useState(lead.next_step ?? '');
  const [due, setDue] = useState(lead.next_step_due ?? '');
  const [busy, setBusy] = useState(false);
  if (lead.closed_at) return null;
  const changed = step.trim() !== (lead.next_step ?? '') || due !== (lead.next_step_due ?? '');
  async function save(s: string | null, d: string | null) {
    setBusy(true);
    try {
      const l = await setVfarmLeadNextStep(lead.id, s, d);
      onUpdated(l);
      setStep(l.next_step ?? '');
      setDue(l.next_step_due ?? '');
      onToast(s ? 'Next step saved.' : 'Next step cleared.', 'ok');
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'That did not save.', 'failing');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Next step" right={overdue(lead) ? <Pill tone="degraded">overdue</Pill> : undefined}>
      <div className="flex flex-wrap gap-2">
        <input className="input h-8 min-w-[18ch] flex-1 text-[12.5px]" placeholder="What happens next, for example: call to review their site" value={step} onChange={(e) => setStep(e.target.value)} />
        <input type="date" className="input h-8 w-[16ch] text-[12.5px]" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={!changed || !step.trim()} loading={busy} onClick={() => save(step.trim(), due || null)}>
          Save
        </Button>
        {lead.next_step && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(null, null)}>
            Done, clear it
          </Button>
        )}
      </div>
    </Card>
  );
}

/** One line of the timeline, from whichever record holds it. Newest first. */
interface Moment {
  at: string;
  what: ReactNode;
  who?: string;
  tone?: 'failing' | 'degraded';
}

function moments(l: VfarmLead): Moment[] {
  const m: Moment[] = [];
  m.push({ at: l.form_a?.submitted_at && /^\d{4}-/.test(l.form_a.submitted_at) ? l.form_a.submitted_at : l.created_at, what: l.form_a ? 'Form A received' : 'Signed up on the old public form', who: l.form_a ? 'Hardik’s tracker' : undefined });
  for (const s of l.stage_history ?? []) {
    const name = (n: number) => (n === 1 ? 'Interest' : n === 2 ? 'Invited' : 'Paying');
    m.push({ at: s.at, what: `Moved from ${name(s.from)} to ${name(s.to)}${s.reason ? `: ${s.reason}` : ''}`, who: s.via === 'engine' ? `${s.by} (n8n)` : s.by });
  }
  const inv = l.intake_2_invite;
  for (const s of inv?.sends ?? []) {
    m.push({ at: s.at, what: s.outcome === 'sent' ? `Intake-2 invite emailed to ${s.to}` : `Intake-2 invite did not go: ${s.error}`, who: s.by, tone: s.outcome === 'failed' ? 'failing' : undefined });
  }
  if (inv?.opened_at) m.push({ at: inv.opened_at, what: 'They opened the Intake-2 page' });
  (['fu1', 'fu2'] as const).forEach((k, i) => {
    const f = inv?.followups?.[k];
    if (f?.at) m.push({ at: f.at, what: f.outcome === 'sent' ? `Follow-up ${i + 1} emailed` : `Follow-up ${i + 1} did not go: ${f.error}`, tone: f.outcome === 'failed' ? 'failing' : undefined });
  });
  if (inv?.unresponsive_at) m.push({ at: inv.unresponsive_at, what: 'Marked Unresponsive: no answer 14 days after the invite', tone: 'degraded' });
  if (l.intake_2) m.push({ at: l.intake_2.submitted_at, what: 'They sent their site specification', who: 'the buyer' });
  for (const a of l.activity ?? []) {
    const what =
      a.kind === 'note'
        ? <span className="whitespace-pre-wrap text-ink">{a.text}</span>
        : a.kind === 'next_step'
        ? a.text
          ? `Next step: ${a.text}${a.due ? ` (due ${a.due})` : ''}`
          : 'Next step cleared'
        : a.kind === 'closed'
        ? `Closed: ${closeReasonLabel(a.reason)}${a.text ? `. ${a.text}` : ''}`
        : `Reopened${a.text ? `. ${a.text}` : ''}`;
    m.push({ at: a.at, what, who: a.by });
  }
  return m.sort((a, b) => b.at.localeCompare(a.at));
}

function Timeline({ lead, onUpdated, onToast }: { lead: VfarmLead; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const list = moments(lead);
  return (
    <Card title="Timeline">
      <textarea className="input min-h-[60px] w-full py-2 text-[12.5px]" placeholder="Add a note: a call, an email, what they said" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-2">
        <Button
          size="sm"
          disabled={!text.trim()}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onUpdated(await addVfarmLeadNote(lead.id, text.trim()));
              setText('');
            } catch (e) {
              onToast(e instanceof Error ? e.message : 'The note did not save.', 'failing');
            } finally {
              setBusy(false);
            }
          }}
        >
          Add note
        </Button>
      </div>
      <ol className="mt-3 space-y-2 border-l border-line pl-3">
        {list.map((x, i) => (
          <li key={i} className="text-[12.5px]">
            <div className={x.tone === 'failing' ? 'text-failing' : x.tone === 'degraded' ? 'text-degraded' : 'text-dim'}>{x.what}</div>
            <div className="text-[11px] text-faint">
              {stamp(x.at)}
              {x.who ? ` · ${x.who}` : ''}
            </div>
          </li>
        ))}
      </ol>
      {(lead.notes || (lead.status && lead.status !== 'new')) && (
        <p className="mt-3 text-[11.5px] text-faint">
          From before the timeline: status {lead.status}
          {lead.notes ? `; note: ${lead.notes}` : ''}.
        </p>
      )}
    </Card>
  );
}

function answerText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  return JSON.stringify(v);
}

const ATTRIBUTION = ['utm_source', 'utm_medium', 'utm_campaign', 'asset_id', 'source_channel', 'landing_variant', 'contract_version'] as const;

function Profile({ lead: l, onToast }: { lead: VfarmLead; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const f = l.form_a;
  const extra = f ? Object.keys(f.answers).filter((k) => !FORM_A_QUESTIONS.includes(k)) : [];
  const attribution = l.contract_version === null ? null : ATTRIBUTION.map((k) => [k, l[k] || '—'] as const);
  return (
    <>
      <Card title="Contact">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="text-faint">email</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="truncate text-ink">{l.email}</span>
            <button
              type="button"
              className="link text-[11.5px]"
              onClick={async () => {
                const ok = await copy(l.email);
                onToast(ok ? `Copied ${l.email}` : 'The browser would not let the page write to the clipboard.', ok ? 'ok' : 'failing');
              }}
            >
              copy
            </button>
          </dd>
          <dt className="text-faint">organisation</dt>
          <dd className="text-ink">{l.organization_name ?? '—'}</dd>
          <dt className="text-faint">joined</dt>
          <dd className="text-ink">{stamp(l.created_at)}</dd>
          <dt className="text-faint">came from</dt>
          <dd className="text-dim">
            {l.source_page ?? l.source_surface}
            {l.source_campaign ? ` · ${l.source_campaign}` : ''}
          </dd>
          {l.is_repeat_email && (
            <>
              <dt className="text-faint">note</dt>
              <dd className="text-dim">this address is on an earlier lead too</dd>
            </>
          )}
          {l.pilot_offers && l.pilot_offers.length > 0 && (
            <>
              <dt className="text-faint">pilot offer</dt>
              <dd className="text-dim">{l.pilot_offers.map((o) => `${o.id} (${o.status})`).join(', ')}</dd>
            </>
          )}
        </dl>
        {attribution && (
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11.5px]">
            {attribution.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className="truncate text-dim">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card title="Form A">
        {!f ? (
          <p className="text-[12.5px] text-dim">This lead came through the old public form route, which stored only name, email and organisation.</p>
        ) : (
          <div className="space-y-3">
            {FORM_A_GROUPS.map((g) => (
              <section key={g.title}>
                <h4 className="mb-1 text-[11.5px] font-medium text-dim">{g.title}</h4>
                <dl className="space-y-1.5">
                  {g.questions.map((qn) => {
                    const v = f.answers[qn];
                    return (
                      <div key={qn} className="text-[12px]">
                        <dt className="text-faint">{qn.trim()}</dt>
                        <dd className={`whitespace-pre-wrap ${v === undefined ? 'text-faint' : 'text-ink'}`}>{v === undefined ? 'not answered' : answerText(v)}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}
            {extra.length > 0 && (
              <section>
                <h4 className="mb-1 text-[11.5px] font-medium text-dim">Questions this page does not know</h4>
                {extra.map((k) => (
                  <div key={k} className="text-[12px]">
                    <div className="text-faint">{k}</div>
                    <div className="whitespace-pre-wrap text-ink">{answerText(f.answers[k])}</div>
                  </div>
                ))}
              </section>
            )}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t border-line pt-2 text-[11px]">
              {(
                [
                  ['buyer_intake_id', f.buyer_intake_id],
                  ['early_access_lead_id', f.early_access_lead_id],
                  ['correlation_id', f.correlation_id],
                  ['submitted_at', f.submitted_at],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-faint">{k}</dt>
                  <dd className="tabular truncate text-dim">{v ?? 'not sent'}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[11px] text-faint">Headings are this page&rsquo;s, not the form&rsquo;s.</p>
          </div>
        )}
      </Card>
    </>
  );
}
