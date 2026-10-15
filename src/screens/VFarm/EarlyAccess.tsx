import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  addVfarmLeadNote,
  clearIntake2Unresponsive,
  closeVfarmLead,
  moveVfarmLeadStage,
  reopenVfarmLead,
  sendIntake2Invite,
  type VfarmLead,
  type VfarmLeadsData,
} from '../../data';
import type { RecordColumn } from '../../components/ui';
import { Button, Pagination, Pill, RecordTable, SearchBox, Segmented, Stat, StatCell, StatStrip, Toast, usePaged, useToast } from '../../components/ui';
import { FORM_A_GROUPS, FORM_A_QUESTIONS } from '../../data/formA';
import { CLOSE_REASONS, PIPELINE, closeReasonLabel, pipelineOf, type PipelineKey } from '../../data/leadPipeline';
import { FollowUpTracker, Form2Answers, followUpLine } from './Intake2Panel';

/**
 * vFarm Early Access, as a CRM (rebuilt 15 Oct 2026, simplified the same morning on Destiny's
 * read of it: "I can't tell stage 1 from 2 from 3 clearly").
 *
 * The columns lead with his stage numbers: Stage 1 · Interest (filled in Form A), Stage 2 ·
 * Invited (Jason cleared them and Form 2 went out), Stage 2 · Spec received (they sent Form 2
 * back), Stage 3 · Paying (a placeholder) and Closed. Form 2 is the buyer's site specification,
 * Intake-2 in the code; on screen it is Form 2 everywhere.
 *
 * A lead's page reads top to bottom: where they are and the one thing to do next, the follow-up
 * tracker while we wait on Form 2, their answers, then notes and history.
 */

const stamp = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

type View = 'board' | 'list';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const colOf = (l: VfarmLead) => pipelineOf({ ...l, stage: l.stage ?? 1 }).key;
const colName = (k: PipelineKey) => {
  const c = PIPELINE.find((x) => x.key === k)!;
  return c.stage ? `${c.stage} · ${c.label}` : c.label;
};

export default function EarlyAccess({ data, onChange, initialOpen = null }: { data: VfarmLeadsData; onChange: (leads: VfarmLead[]) => void; initialOpen?: string | null }) {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>(() => (params.get('view') === 'list' ? 'list' : 'board'));
  const [filter, setFilter] = useState<PipelineKey>('interest');
  const [q, setQ] = useState('');
  const { toast, setToast } = useToast();
  const leads = data.leads;
  const openId = params.get('lead') ?? initialOpen;

  function setOpen(id: string | null) {
    const next = new URLSearchParams(params);
    next.set('tab', 'early-access');
    if (id) next.set('lead', id);
    else next.delete('lead');
    setParams(next);
  }
  function pickView(v: View) {
    setView(v);
    const next = new URLSearchParams(params);
    next.set('tab', 'early-access');
    if (v === 'list') next.set('view', 'list');
    else next.delete('view');
    setParams(next, { replace: true });
  }

  function replace(updated: VfarmLead) {
    onChange(leads.map((l) => (l.id === updated.id ? updated : l)));
  }
  const say = (text: string, tone: 'ok' | 'failing') => setToast({ text, tone });

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return leads;
    return leads.filter((l) => l.full_name.toLowerCase().includes(needle) || l.email.includes(needle) || (l.organization_name ?? '').toLowerCase().includes(needle));
  }, [leads, q]);

  const byCol = useMemo(() => {
    const m = new Map<PipelineKey, VfarmLead[]>(PIPELINE.map((c) => [c.key, []]));
    for (const l of matched) m.get(colOf(l))!.push(l);
    return m; // newest first, as the server sends them
  }, [matched]);

  const count = (k: PipelineKey) => leads.filter((l) => colOf(l) === k).length;
  const unresponsive = leads.filter((l) => !l.closed_at && !l.intake_2 && l.intake_2_invite?.unresponsive_at).length;

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null;
  if (openId && openLead) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LeadRecord lead={openLead} onBack={() => setOpen(null)} onUpdated={replace} onToast={say} />
        <Toast toast={toast} />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Stage 1 · interest" value={count('interest')} hint="waiting on Jason to clear them" />
        </StatCell>
        <StatCell>
          <Stat label="Stage 2 · invited" value={count('invited')} hint={unresponsive ? `${unresponsive} unresponsive` : 'waiting on their Form 2'} tone={unresponsive ? 'degraded' : undefined} />
        </StatCell>
        <StatCell>
          <Stat label="Stage 2 · spec received" value={count('spec')} hint="Form 2 back, for BHA to review" />
        </StatCell>
        <StatCell>
          <Stat label="Closed" value={count('closed')} hint={`${data.summary.last_7_days} new leads in the last 7 days`} />
        </StatCell>
      </StatStrip>

      {openId && !openLead && (
        <p className="px-6 pb-2 text-[12.5px] text-dim md:px-8">
          No lead with id {openId} is held.{' '}
          <button className="link" onClick={() => setOpen(null)}>
            Show all leads
          </button>
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
          <Segmented options={PIPELINE.map((c) => ({ value: c.key as PipelineKey, label: colName(c.key), count: byCol.get(c.key)!.length }))} value={filter} onChange={setFilter} ariaLabel="Stage" />
        )}
        <SearchBox value={q} onChange={setQ} placeholder="Search name, email or organisation" />
      </div>

      <div className="min-h-0 flex-1 pb-8">
        {leads.length === 0 ? (
          <p className="px-6 py-10 text-center text-[13px] text-dim md:px-8">
            No Early Access lead is held. Every lead arrives through Form A, and Hardik&rsquo;s n8n tracker posts each one here as it comes in; this is empty because nothing has arrived, not because nothing is being recorded.
          </p>
        ) : view === 'board' ? (
          <Board byCol={byCol} onOpen={(l) => setOpen(l.id)} />
        ) : (
          <LeadList rows={byCol.get(filter)!} filterKey={`${filter}:${q}`} stage={filter} onOpen={(l) => setOpen(l.id)} onToast={say} />
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
                {c.stage && <div className="text-[11px] font-medium text-accent-ink">{c.stage}</div>}
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[13.5px] font-semibold text-ink">{c.label}</h3>
                  <span className="tabular text-[12px] text-faint">{list.length}</span>
                </div>
                <div className="text-[11px] leading-snug text-faint">{c.hint}</div>
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
  const col = colOf(l);
  const fu = col === 'invited' || col === 'spec' ? followUpLine(l) : null;
  return (
    <button type="button" onClick={onOpen} className="card block w-full px-3 py-2.5 text-left transition hover:ring-1 hover:ring-accent/40">
      <div className="truncate text-[13px] font-medium text-ink">{l.full_name}</div>
      <div className="truncate text-[11.5px] text-dim">{l.organization_name ?? l.email}</div>
      <div className="mt-1 text-[11px] text-faint">Form A {day(l.created_at)}</div>
      {fu && <div className={`mt-1 text-[11.5px] ${fu.tone === 'failing' ? 'text-failing' : fu.tone === 'degraded' ? 'text-degraded' : 'text-dim'}`}>{fu.text}</div>}
      {col === 'closed' && (
        <div className="mt-1.5">
          <Pill>{closeReasonLabel(l.closed_reason)}</Pill>
        </div>
      )}
    </button>
  );
}

/* ───────────────────────────── list ───────────────────────────── */

function LeadList({ rows, filterKey, stage, onOpen, onToast }: { rows: VfarmLead[]; filterKey: string; stage: PipelineKey; onOpen: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const paged = usePaged(rows, filterKey);
  const columns: RecordColumn<VfarmLead>[] = [
    { key: 'joined', header: 'joined', className: 'tabular text-faint', card: 'meta', cell: (l) => day(l.created_at), title: (l) => stamp(l.created_at) },
    { key: 'name', header: 'name', card: 'title', width: '20ch', clip: true, title: (l) => l.full_name, cell: (l) => l.full_name },
    { key: 'org', header: 'organisation', card: 'meta', width: '20ch', clip: true, className: 'text-dim', cell: (l) => l.organization_name ?? <span className="text-faint">—</span> },
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
  ];
  if (stage === 'invited' || stage === 'spec') {
    columns.push({
      key: 'fu',
      header: 'follow-ups',
      card: 'meta',
      width: '34ch',
      clip: true,
      cell: (l) => {
        const f = followUpLine(l);
        return f ? <span className={f.tone === 'failing' ? 'text-failing' : f.tone === 'degraded' ? 'text-degraded' : 'text-dim'}>{f.text}</span> : null;
      },
    });
  }
  if (stage === 'closed') {
    columns.push({ key: 'reason', header: 'why closed', card: 'meta', width: '20ch', cell: (l) => <Pill>{closeReasonLabel(l.closed_reason)}</Pill> });
  }
  columns.push({
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
  });
  return (
    <>
      <RecordTable columns={columns} rows={paged.rows} rowKey={(l) => l.id} onOpen={onOpen} label="vFarm Early Access leads" empty={`Nobody is at ${colName(stage)}.`} />
      <Pagination paged={paged} unit="leads" />
    </>
  );
}

/* ───────────────────────────── one lead ───────────────────────────── */

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function LeadRecord({ lead, onBack, onUpdated, onToast }: { lead: VfarmLead; onBack: () => void; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const col = colOf(lead);
  return (
    <div className="mx-auto w-full max-w-[900px] space-y-4 px-6 pb-10 md:px-8">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← All leads
        </Button>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[22px] font-semibold text-ink">{lead.full_name}</h2>
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-dim">
              <span>{lead.organization_name ?? 'No organisation given'}</span>
              <span>·</span>
              <span>{lead.email}</span>
              <button
                type="button"
                className="link text-[11.5px]"
                onClick={async () => {
                  const ok = await copy(lead.email);
                  onToast(ok ? `Copied ${lead.email}` : 'The browser would not let the page write to the clipboard.', ok ? 'ok' : 'failing');
                }}
              >
                copy
              </button>
              {lead.is_repeat_email && <Pill>this address is on an earlier lead too</Pill>}
            </div>
          </div>
          <StageSteps current={col} />
        </div>
      </div>

      <NextUp lead={lead} onUpdated={onUpdated} onToast={onToast} />

      {lead.intake_2 && (
        <Section title="Their Form 2 answers" right={<span className="text-[12px] text-faint">sent {day(lead.intake_2.submitted_at)}</span>}>
          <Form2Answers lead={lead} />
        </Section>
      )}

      <FormASection lead={lead} startOpen={col === 'interest'} />

      <History lead={lead} onUpdated={onUpdated} onToast={onToast} />
    </div>
  );
}

function StageSteps({ current }: { current: PipelineKey }) {
  if (current === 'closed') return <Pill>Closed</Pill>;
  const steps = PIPELINE.filter((c) => c.key !== 'closed');
  const at = steps.findIndex((c) => c.key === current);
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11.5px]" aria-label="Where this lead is">
      {steps.map((c, i) => (
        <li key={c.key} className={`rounded-full px-2.5 py-1 ${i === at ? 'bg-accent text-accent-on' : i < at ? 'bg-accent-soft text-accent-ink' : 'bg-hover text-faint'}`}>
          {c.stage} · {c.label}
        </li>
      ))}
    </ol>
  );
}

/** Where the lead is, in words, and the one thing to do. Close lives here too, as the quiet option. */
function NextUp({ lead, onUpdated, onToast }: { lead: VfarmLead; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState<string>('unresponsive');
  const [note, setNote] = useState('');
  const col = colOf(lead);
  const inv = lead.intake_2_invite;

  async function run(key: string, fn: () => Promise<VfarmLead | { ok: boolean; message: string }>, ok: string) {
    setBusy(key);
    try {
      const r = await fn();
      if ('id' in r) {
        onUpdated(r);
        const invRes = r.intake_2_invite_result;
        onToast(invRes ? `${ok} ${invRes.message}` : ok, invRes && !invRes.ok ? 'failing' : 'ok');
      } else onToast(r.message, r.ok ? 'ok' : 'failing');
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
      <Section title="Closed">
        <p className="text-[13px] text-ink">
          {closeReasonLabel(lead.closed_reason)} · closed {day(lead.closed_at)}
        </p>
        {lead.closed_note && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-dim">{lead.closed_note}</p>}
        <p className="mt-1 text-[12px] text-faint">No reminders go to a closed lead. If they send Form 2 anyway, the lead opens again by itself.</p>
        <div className="mt-3">
          <Button size="sm" loading={busy === 'reopen'} onClick={() => run('reopen', () => reopenVfarmLead(lead.id), 'Reopened.')}>
            Reopen
          </Button>
        </div>
      </Section>
    );
  }

  const closeControl = (
    <div className="mt-4 border-t border-line pt-3">
      {!closing ? (
        <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
          Close this lead
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="text-[12.5px] text-dim">Why is it closing?</div>
          <Segmented options={CLOSE_REASONS.map((r) => ({ value: r.key as string, label: r.label }))} value={reason} onChange={setReason} ariaLabel="Why closed" />
          <textarea className="input min-h-[56px] w-full py-2 text-[12.5px]" placeholder={reason === 'other' ? 'Say why (needed for Other)' : 'A note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={reason === 'other' && !note.trim()}
              loading={busy === 'close'}
              onClick={async () => {
                if (await run('close', () => closeVfarmLead(lead.id, reason, note.trim() || null), `Closed: ${closeReasonLabel(reason)}.`)) {
                  setClosing(false);
                  setNote('');
                }
              }}
            >
              Close as {closeReasonLabel(reason)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  if (col === 'interest') {
    return (
      <Section title="Stage 1 · Interest">
        <p className="text-[13px] text-ink">They filled in Form A on {day(lead.created_at)}. Read their answers below.</p>
        <p className="mt-1 text-[12.5px] text-dim">Next: Jason clears them for Stage 2. That emails them Form 2 (their site specification) and starts the reminders.</p>
        <div className="mt-3">
          {lead.form_a ? (
            <Button variant="primary" size="sm" loading={busy === 'fwd'} onClick={() => run('fwd', () => moveVfarmLeadStage(lead.id, 2, null), 'Cleared for Stage 2.')}>
              Clear for Stage 2 and send Form 2
            </Button>
          ) : (
            <p className="text-[12px] text-faint">This lead came through the old public form, not Form A, so Form 2 cannot be sent to it.</p>
          )}
        </div>
        {closeControl}
      </Section>
    );
  }

  if (col === 'invited') {
    const sentOnce = (inv?.sends ?? []).some((s) => s.outcome === 'sent');
    return (
      <Section title="Stage 2 · Invited: waiting on their Form 2">
        <FollowUpTracker lead={lead} />
        <div className="mt-3 flex flex-wrap gap-2">
          {inv?.unresponsive_at && (
            <Button size="sm" loading={busy === 'clear'} onClick={() => run('clear', () => clearIntake2Unresponsive(lead.id), 'Cleared.')}>
              They replied: clear unresponsive
            </Button>
          )}
          <Button size="sm" variant={inv ? 'secondary' : 'primary'} loading={busy === 'send'} onClick={() => run('send', () => sendIntake2Invite(lead.id, sentOnce), sentOnce ? 'Sent again.' : 'Sent.')}>
            {sentOnce ? 'Send Form 2 again' : 'Send Form 2'}
          </Button>
          {inv?.link && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const ok = await copy(inv.link);
                onToast(ok ? 'Their Form 2 link is copied. It is theirs alone: do not share it.' : 'Could not copy the link.', ok ? 'ok' : 'failing');
              }}
            >
              Copy their link
            </Button>
          )}
          <Button size="sm" variant="ghost" loading={busy === 'back'} onClick={() => run('back', () => moveVfarmLeadStage(lead.id, 1, null), 'Back to Stage 1.')}>
            Back to Stage 1
          </Button>
        </div>
        {closeControl}
      </Section>
    );
  }

  if (col === 'spec') {
    const done = lead.intake_2!;
    return (
      <Section title="Stage 2 · Spec received">
        <p className="text-[13px] text-ink">They sent Form 2 back on {day(done.submitted_at)}. Their answers are below.</p>
        <ul className="mt-1 space-y-0.5 text-[12.5px] text-dim">
          <li>
            {done.notified?.ts ? 'Posted in #vfarm-early-access.' : done.notified?.error ? <span className="text-failing">Not posted in Slack: {done.notified.error}</span> : 'Slack post not recorded.'}
          </li>
          <li>
            {done.confirmation_email?.outcome === 'sent' ? (
              `Receipt emailed to ${done.confirmation_email.to}.`
            ) : done.confirmation_email?.outcome === 'failed' ? (
              <span className="text-failing">Receipt email did not go: {done.confirmation_email.error}</span>
            ) : (
              'Receipt email not recorded.'
            )}
          </li>
        </ul>
        <p className="mt-2 text-[12.5px] text-dim">Next: BHA reviews it. Nothing here confirms feasibility, pricing or anything else; their answers are information, not a decision.</p>
        <div className="mt-3">
          <Button variant="primary" size="sm" loading={busy === 'fwd'} onClick={() => run('fwd', () => moveVfarmLeadStage(lead.id, 3, null), 'Moved to Stage 3.')}>
            Move to Stage 3 · Paying
          </Button>
        </div>
        {closeControl}
      </Section>
    );
  }

  // paying
  return (
    <Section title="Stage 3 · Paying">
      <p className="text-[13px] text-ink">A placeholder. No payment is taken here until Jason and Hardik set the price and the checkout.</p>
      <div className="mt-3">
        <Button size="sm" variant="ghost" loading={busy === 'back'} onClick={() => run('back', () => moveVfarmLeadStage(lead.id, 2, null), 'Back to Stage 2.')}>
          Back to Stage 2
        </Button>
      </div>
      {closeControl}
    </Section>
  );
}

function answerText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  return JSON.stringify(v);
}

function FormASection({ lead: l, startOpen }: { lead: VfarmLead; startOpen: boolean }) {
  const f = l.form_a;
  const extra = f ? Object.keys(f.answers).filter((k) => !FORM_A_QUESTIONS.includes(k)) : [];
  return (
    <details className="card px-5 py-4" open={startOpen}>
      <summary className="cursor-pointer text-[14px] font-semibold text-ink">
        Their Form A answers <span className="text-[12px] font-normal text-faint">· sent {day(f?.submitted_at && /^\d{4}-/.test(f.submitted_at) ? f.submitted_at : l.created_at)}</span>
      </summary>
      <div className="mt-3">
        {!f ? (
          <p className="text-[12.5px] text-dim">This lead came through the old public form, which stored only name, email and organisation.</p>
        ) : (
          <div className="space-y-4">
            {FORM_A_GROUPS.map((g) => (
              <section key={g.title}>
                <h4 className="mb-1.5 text-[12px] font-medium text-dim">{g.title}</h4>
                <dl className="divide-y divide-line rounded-[10px] border border-line">
                  {g.questions.map((qn) => {
                    const v = f.answers[qn];
                    return (
                      <div key={qn} className="grid gap-x-4 px-3 py-2 text-[12.5px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                        <dt className="text-dim">{qn.trim()}</dt>
                        <dd className={`whitespace-pre-wrap ${v === undefined ? 'text-faint' : 'text-ink'}`}>{v === undefined ? 'not answered' : answerText(v)}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}
            {extra.length > 0 && (
              <section>
                <h4 className="mb-1.5 text-[12px] font-medium text-dim">Questions this page does not know</h4>
                <dl className="divide-y divide-line rounded-[10px] border border-line">
                  {extra.map((k) => (
                    <div key={k} className="grid gap-x-4 px-3 py-2 text-[12.5px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                      <dt className="text-dim">{k}</dt>
                      <dd className="whitespace-pre-wrap text-ink">{answerText(f.answers[k])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <p className="text-[11px] text-faint">
              Buyer id {f.buyer_intake_id}
              {l.source_campaign ? ` · campaign ${l.source_campaign}` : ''}. Section headings are this page&rsquo;s, not the form&rsquo;s.
            </p>
          </div>
        )}
      </div>
    </details>
  );
}

/** One line of history. Newest first. */
interface Moment {
  at: string;
  what: ReactNode;
  who?: string;
  tone?: 'failing' | 'degraded';
}

function moments(l: VfarmLead): Moment[] {
  const name = (n: number) => (n === 1 ? 'Stage 1' : n === 2 ? 'Stage 2' : 'Stage 3');
  const m: Moment[] = [{ at: l.form_a?.submitted_at && /^\d{4}-/.test(l.form_a.submitted_at) ? l.form_a.submitted_at : l.created_at, what: l.form_a ? 'Filled in Form A' : 'Signed up on the old public form' }];
  for (const s of l.stage_history ?? []) m.push({ at: s.at, what: `Moved from ${name(s.from)} to ${name(s.to)}${s.reason ? `: ${s.reason}` : ''}`, who: s.via === 'engine' ? `${s.by} (n8n)` : s.by });
  const inv = l.intake_2_invite;
  for (const s of inv?.sends ?? []) m.push({ at: s.at, what: s.outcome === 'sent' ? `Form 2 emailed to ${s.to}` : `Form 2 email did not go: ${s.error}`, tone: s.outcome === 'failed' ? 'failing' : undefined });
  if (inv?.opened_at) m.push({ at: inv.opened_at, what: 'Opened Form 2' });
  (['fu1', 'fu2'] as const).forEach((k, i) => {
    const f = inv?.followups?.[k];
    if (f?.at && f.outcome) m.push({ at: f.at, what: f.outcome === 'sent' ? `Reminder ${i + 1} emailed` : `Reminder ${i + 1} did not go: ${f.error}`, tone: f.outcome === 'failed' ? 'failing' : undefined });
  });
  if (inv?.unresponsive_at) m.push({ at: inv.unresponsive_at, what: 'Marked unresponsive: no answer 14 days after Form 2', tone: 'degraded' });
  for (const c of inv?.unresponsive_cleared ?? []) m.push({ at: c.at, what: 'Unresponsive cleared', who: c.by });
  if (l.intake_2) m.push({ at: l.intake_2.submitted_at, what: 'Sent Form 2 back' });
  for (const a of l.activity ?? []) {
    if (a.kind === 'next_step') continue;
    const what = a.kind === 'note' ? <span className="whitespace-pre-wrap text-ink">{a.text}</span> : a.kind === 'closed' ? `Closed: ${closeReasonLabel(a.reason)}${a.text ? `. ${a.text}` : ''}` : `Reopened${a.text ? `. ${a.text}` : ''}`;
    m.push({ at: a.at, what, who: a.by });
  }
  return m.sort((a, b) => b.at.localeCompare(a.at));
}

function History({ lead, onUpdated, onToast }: { lead: VfarmLead; onUpdated: (l: VfarmLead) => void; onToast: (t: string, tone: 'ok' | 'failing') => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Notes and history">
      <textarea className="input min-h-[56px] w-full py-2 text-[12.5px]" placeholder="Add a note: a call, an email, what they said" value={text} onChange={(e) => setText(e.target.value)} />
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
      <ol className="mt-4 space-y-2 border-l border-line pl-3">
        {moments(lead).map((x, i) => (
          <li key={i} className="text-[12.5px]">
            <div className={x.tone === 'failing' ? 'text-failing' : x.tone === 'degraded' ? 'text-degraded' : 'text-dim'}>{x.what}</div>
            <div className="text-[11px] text-faint">
              {stamp(x.at)}
              {x.who ? ` · ${x.who}` : ''}
            </div>
          </li>
        ))}
      </ol>
      {lead.notes && <p className="mt-3 text-[11.5px] text-faint">Note from before: {lead.notes}</p>}
    </Section>
  );
}
