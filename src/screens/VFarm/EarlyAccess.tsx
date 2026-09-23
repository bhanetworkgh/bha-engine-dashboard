import { useMemo, useState } from 'react';
import { editVfarmLead, VFARM_LEAD_STATUSES, type VfarmLead, type VfarmLeadStatus, type VfarmLeadsData } from '../../data';
import type { RecordColumn } from '../../components/ui';
import { Pagination, Button, Pill, Toast, RecordTable, SearchBox, Segmented, Stat, StatCell, StatStrip, usePaged, useToast } from '../../components/ui';
import { EditableCell } from '../Registry/Editable';
import { FORM_A_GROUPS, FORM_A_QUESTIONS } from '../../data/formA';

/**
 * The receiving end of the vFarm Early Access funnel, as a small CRM.
 *
 * A record to read and annotate, and nothing more. There is no export, no
 * sending, and no bulk action beyond copying addresses out — the moment this
 * page could email somebody it would need to know who had already been emailed,
 * and that is a second system, not a tab.
 *
 * **Nothing here is a commitment.** A row says a person filled in a form. It is
 * not a subscription, a payment, a reservation or a place in a queue, and
 * `status` is this dashboard's own note about whether anybody has replied — not
 * a state the funnel or any other system reads back.
 *
 * Two fields are editable, in place: status and notes. Everything else is what
 * the person told the site about themselves, and a record somebody can quietly
 * rewrite is not a record.
 */

const when = (iso: string) => iso.slice(0, 10);
const whenFull = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);

type Filter = 'all' | VfarmLeadStatus;

/**
 * The attribution fields, in the order the lead envelope lists them.
 *
 * Every clip between now and 31 Oct points at /vfarm, so which clip a lead
 * came from is the question this page exists to answer next.
 */
const ATTRIBUTION = [
  ['utm_source', 'utm_source'],
  ['utm_medium', 'utm_medium'],
  ['utm_campaign', 'utm_campaign'],
  ['asset_id', 'asset_id'],
  ['source_channel', 'source_channel'],
  ['landing_variant', 'landing_variant'],
  ['contract_version', 'contract_version'],
] as const satisfies readonly (readonly [keyof VfarmLead, string])[];

/**
 * Puts text on the clipboard.
 *
 * `navigator.clipboard` needs a secure context, which this dashboard has, but a
 * browser can still refuse it — so the outcome is reported rather than assumed.
 * A "copied" toast over an empty clipboard is the kind of small lie that wastes
 * somebody's afternoon.
 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function EarlyAccess({ data, onChange, initialOpen = null }: { data: VfarmLeadsData; onChange: (leads: VfarmLead[]) => void; initialOpen?: string | null }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  /** The lead whose answers are open. Clicking a row opens it; the panel sits above the list. */
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const { toast, setToast } = useToast();

  const leads = data.leads;

  /**
   * An edit lands on screen first and is put back if the server refuses it.
   *
   * The optimism is the point: a status is a two-click job somebody does to
   * twenty rows in a row, and a spinner on each one makes that a chore. The
   * revert is what keeps it honest — a cell showing something that was never
   * saved is worse than a slow cell.
   */
  async function save(lead: VfarmLead, changes: { status?: VfarmLeadStatus; notes?: string | null }): Promise<void> {
    const before = leads;
    onChange(leads.map((l) => (l.id === lead.id ? { ...l, ...changes } : l)));
    try {
      const updated = await editVfarmLead(lead.id, changes);
      onChange(before.map((l) => (l.id === lead.id ? updated : l)));
    } catch (e) {
      onChange(before);
      throw e instanceof Error ? e : new Error('That change did not save.');
    }
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (filter !== 'all' && l.status !== filter) return false;
      if (!needle) return true;
      return (
        l.full_name.toLowerCase().includes(needle) ||
        l.email.includes(needle) ||
        (l.organization_name ?? '').toLowerCase().includes(needle)
      );
    });
  }, [leads, filter, q]);

  const paged = usePaged(shown, `${filter}:${q}`);
  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null;

  const counts = data.summary.by_status;
  const options: { value: Filter; label: string; count?: number }[] = [
    { value: 'all', label: 'All', count: data.summary.total },
    ...VFARM_LEAD_STATUSES.map((s) => ({ value: s as Filter, label: s, count: counts[s] ?? 0 })),
  ];

  const columns: RecordColumn<VfarmLead>[] = [
    {
      key: 'created',
      header: 'joined',
      className: 'tabular text-faint',
      card: 'meta',
      /*
        A null notified_at means this lead was never announced in Slack. It is
        the one thing about the row a reader cannot see anywhere else, and it is
        exactly what somebody wants when they are wondering why they missed one.
        Only for the old public route: a Form A lead is announced by Hardik's
        n8n tracker, never by this server, so its null says nothing.
      */
      title: (l) =>
        `${whenFull(l.created_at)}${l.submitted_at && l.submitted_at.slice(0, 16) !== l.created_at.slice(0, 16) ? ` · the browser said ${whenFull(l.submitted_at)}` : ''}${
          l.notified_at || l.form_a ? '' : ' · never announced in Slack'
        }`,
      cell: (l) => (
        <span className="flex items-center gap-1.5">
          {when(l.created_at)}
          {!l.notified_at && !l.form_a && <span className="text-[10.5px] text-faint">not announced</span>}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'name',
      card: 'title',
      width: '20ch',
      clip: true,
      title: (l) => l.full_name,
      cell: (l) => l.full_name,
    },
    {
      key: 'email',
      header: 'email',
      card: 'meta',
      width: '26ch',
      clip: true,
      title: (l) => (l.is_repeat_email ? `${l.email} — this address is already on an earlier row` : l.email),
      cell: (l) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{l.email}</span>
          {/*
            Informational, not a fault: somebody asking twice is a real signal
            and a neutral tag is what it deserves. Amber and red are for a bad
            state, and this is not one.
          */}
          {l.is_repeat_email && <Pill>repeat</Pill>}
        </span>
      ),
    },
    {
      key: 'org',
      header: 'organisation',
      card: 'meta',
      width: '20ch',
      clip: true,
      className: 'text-dim',
      title: (l) => l.organization_name ?? undefined,
      cell: (l) => l.organization_name ?? <span className="text-faint">—</span>,
    },
    {
      key: 'from',
      header: 'came from',
      card: 'meta',
      width: '24ch',
      clip: true,
      className: 'text-dim',
      title: (l) =>
        [
          `surface ${l.source_surface}`,
          l.source_page ? `page ${l.source_page}` : null,
          l.source_campaign ? `campaign ${l.source_campaign}` : null,
          l.claim_state ? `the page was in state "${l.claim_state}"` : null,
          l.page_contract_version ? `page contract ${l.page_contract_version}` : null,
          l.mechanics_contract_version ? `mechanics contract ${l.mechanics_contract_version}` : null,
          l.contract_version ? `attribution contract ${l.contract_version}` : null,
          l.landing_variant ? `landing variant ${l.landing_variant}` : null,
          l.source_channel ? `channel ${l.source_channel}` : null,
          l.utm_campaign ? `utm_campaign ${l.utm_campaign}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      cell: (l) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{l.source_page ?? l.source_surface}</span>
          {l.source_campaign && <span className="truncate text-faint">{l.source_campaign}</span>}
        </span>
      ),
    },
    {
      /*
        Attribution, as captured. An empty string is a link that carried no
        value and shows as "—"; a null is a row written before these columns
        existed and shows as "not captured". Conflating the two would make the
        older rows look like badly tagged links.
      */
      key: 'attribution',
      header: 'attribution',
      card: 'meta',
      width: '22ch',
      clip: true,
      className: 'text-dim',
      title: (l) => {
        if (l.contract_version === null) return 'Recorded before attribution was captured.';
        const shown = ATTRIBUTION.map(([key, label]) => `${label} ${l[key] || '—'}`);
        return shown.join(' · ');
      },
      cell: (l) => {
        if (l.contract_version === null) {
          return <span className="text-faint">not captured</span>;
        }
        const asset = l.asset_id || '';
        const utm = [l.utm_source, l.utm_medium].filter(Boolean).join(' / ');
        if (!asset && !utm) return <span className="text-faint">—</span>;
        return (
          <span className="flex items-center gap-1.5">
            {asset && <Pill>{asset}</Pill>}
            {utm && <span className="truncate">{utm}</span>}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'status',
      card: 'meta',
      width: '14ch',
      cell: (l) => (
        <EditableCell
          value={l.status}
          type="select"
          options={VFARM_LEAD_STATUSES}
          inline
          onSave={(v) => save(l, { status: (v as VfarmLeadStatus) ?? 'new' })}
          onError={(m) => setToast({ text: m, tone: 'failing' })}
          render={(v) => <Pill>{String(v)}</Pill>}
        />
      ),
    },
    {
      key: 'notes',
      header: 'notes',
      card: 'full',
      width: '30ch',
      title: (l) => l.notes ?? undefined,
      cell: (l) => (
        <EditableCell
          value={l.notes}
          type="longtext"
          width="30ch"
          placeholder="Add a note"
          onSave={(v) => save(l, { notes: (v as string | null) ?? null })}
          onError={(m) => setToast({ text: m, tone: 'failing' })}
        />
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
            setToast(ok ? { text: `Copied ${l.email}`, tone: 'ok' } : { text: 'The browser would not let the page write to the clipboard.', tone: 'failing' });
          }}
        >
          Copy email
        </button>
      ),
    },
  ];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <StatStrip cols={4}>
        <StatCell>
          <Stat label="Leads" value={data.summary.total} hint={data.summary.total === 1 ? 'one expression of interest' : 'expressions of interest, not commitments'} />
        </StatCell>
        <StatCell>
          <Stat label="Last 7 days" value={data.summary.last_7_days} hint="joined in the last week" />
        </StatCell>
        <StatCell>
          <Stat label="Last 30 days" value={data.summary.last_30_days} hint="joined in the last month" />
        </StatCell>
        <StatCell>
          <Stat
            label="New / contacted"
            value={`${counts.new ?? 0} / ${counts.contacted ?? 0}`}
            hint={`${counts.qualified ?? 0} qualified, ${counts.archived ?? 0} archived`}
          />
        </StatCell>
      </StatStrip>

      <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-3 md:px-8">
        <Segmented options={options} value={filter} onChange={setFilter} ariaLabel="Filter by status" />
        <SearchBox value={q} onChange={setQ} placeholder="Search name, email or organisation" />
        <Button
 className="h-8 px-3 text-[12.5px]"
 disabled={shown.length === 0}
 onClick={async () => {
 // The filtered set, in the order on screen — so what lands on the
 // clipboard is what the reader was looking at, not the whole table.
 const emails = [...new Set(shown.map((l) => l.email))];
 const ok = await copy(emails.join(', '));
 setToast(
 ok
 ? { text: `Copied ${emails.length} ${emails.length === 1 ? 'address' : 'addresses'}`, tone: 'ok' }
 : { text: 'The browser would not let the page write to the clipboard.', tone: 'failing' },
 );
 }}
 >
          Copy all emails
        </Button>
        {shown.length !== leads.length && (
          <span className="text-[12px] text-faint">
            {shown.length} of {leads.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 md:px-8">
        {openLead && <LeadAnswers lead={openLead} onClose={() => setOpenId(null)} />}
        <RecordTable
          columns={columns}
          rows={paged.rows}
          rowKey={(l) => l.id}
          onOpen={(l) => setOpenId(l.id === openId ? null : l.id)}
          label="vFarm Early Access leads"
          empty={
            leads.length === 0
              ? 'No Early Access lead is held. Every lead arrives through Form A, and Hardik’s n8n tracker posts each one here as it comes in; until one does, this is empty because nothing has arrived, not because nothing is being recorded.'
              : 'No lead matches that filter.'
          }
        />
        <Pagination paged={paged} unit="leads" />
      </div>

      <Toast toast={toast} />
    </div>
  );
}

/** An answer as it was sent: text as text, a checkbox list as a list, anything else as JSON. */
function answerText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  return JSON.stringify(v);
}

/**
 * Every answer a lead gave, grouped the way FORM_A_GROUPS groups Form A
 * (2026-09-23). A question the lead left blank says so in words — an empty
 * cell would read as "not captured". A key the tracker sent that is not one of
 * Form A's questions is shown under its own heading rather than dropped: a
 * renamed question should be visible, not lost.
 */
function LeadAnswers({ lead, onClose }: { lead: VfarmLead; onClose: () => void }) {
  const f = lead.form_a;
  const extra = f ? Object.keys(f.answers).filter((k) => !FORM_A_QUESTIONS.includes(k)) : [];
  const ids: [string, string | null][] = f
    ? [
        ['buyer_intake_id', f.buyer_intake_id],
        ['early_access_lead_id', f.early_access_lead_id],
        ['correlation_id', f.correlation_id],
        ['source_campaign', f.source_campaign],
        ['submitted_at', f.submitted_at],
      ]
    : [];
  return (
    <div className="card mb-4 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-medium text-ink">{lead.full_name}</h2>
          <div className="truncate text-[12px] text-dim">
            {lead.email}
            {lead.organization_name ? ` · ${lead.organization_name}` : ''}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {!f ? (
        <p className="text-[12.5px] text-dim">
          This lead came through the old public form route, which stored only name, email and organisation. There are no Form A answers for it.
        </p>
      ) : (
        <div className="space-y-4">
          {FORM_A_GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="kicker mb-1.5">{g.title}</h3>
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
              <h3 className="kicker mb-1.5">Answers to questions this page does not know</h3>
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
          <section>
            <h3 className="kicker mb-1.5">From the tracker</h3>
            <dl className="grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
              {ids.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-faint">{k}</dt>
                  <dd className={`tabular truncate ${v ? 'text-dim' : 'text-faint'}`}>{v ?? 'not sent'}</dd>
                </div>
              ))}
            </dl>
          </section>
          <p className="text-[11.5px] text-faint">
            Grouped by subject in Form A&rsquo;s own order. These headings are this page&rsquo;s, not the form&rsquo;s section titles, which nothing here can read.
          </p>
        </div>
      )}
    </div>
  );
}
