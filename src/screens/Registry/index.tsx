import { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import {
  createRegistryRow,
  deleteRegistryRow,
  getRegistry,
  restoreRegistryRow,
  updateRegistryRow,
  type RegistryData,
  type RegistryKind,
  type RegistryRowOf,
  type Spend,
} from '../../data';
import {
  CountCell,
  EmptyState,
  LoadFailed,
  Loading,
  MetricCard,
  PageHeader,
  Pagination,
  Pill,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  StatStrip,
  Tabs,
  Toast,
  relativeTime,
  usePaged,
  useToast,
} from '../../components/ui';
import { DASH, EditableCell, NewRow, type CellType } from './Editable';

/**
 * The System Registry: which workflow does what and who owns it, and what BHA
 * pays for.
 *
 * Two questions nobody could answer without asking Destiny, on one page. The
 * second half — services, plans, cost, renewal, who pays — did not exist
 * anywhere before this, which is why the billing tab leads with a total that
 * states in the same breath how much of itself is missing.
 *
 * **This dashboard is the system of record here.** Every other records page in
 * this app is a read model over Airtable and writes through to it first; these
 * six tables have no upstream, so a change made in a cell goes straight to
 * Postgres and stays there. That is the one place this page deliberately does
 * not follow the pattern the rest of the app follows, and it is why there is no
 * "resync" control on it.
 *
 * Nothing here holds a secret. The credentials table has names, types, owners
 * and uses, and no column a value could go in — see the banner on that tab and
 * the schema in server/src/registry.ts.
 */

const TABS = ['Workflows', 'Services & billing', 'Credentials', 'Endpoints', 'People'] as const;
type Tab = (typeof TABS)[number];

const WORKFLOW_STATUS = ['production', 'experimental', 'retired'] as const;
const SERVICE_STATUS = ['active', 'trial', 'retired'] as const;
const CATEGORIES = ['hosting', 'automation', 'data', 'ai', 'comms', 'storage', 'other'] as const;
const CYCLES = ['monthly', 'quarterly', 'yearly', 'one-off'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type AnyRow = { id: string; updated_at: string; deleted_at: string | null };

function when(iso: string | null): string {
  return iso ? (relativeTime(iso) ?? iso.slice(0, 10)) : DASH;
}

function Th({ children, right, width }: { children?: React.ReactNode; right?: boolean; width?: string }) {
  return (
    <th
      className={`sticky top-0 z-10 border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-faint ${right ? 'text-right' : ''}`}
      style={width ? { width } : undefined}
    >
      {children}
    </th>
  );
}

/**
 * The frame every tab's table sits in, so all five read identically.
 *
 * `min` is the width below which the table stops fitting and the card scrolls
 * sideways inside itself. Without it the browser squeezes thirteen columns into
 * whatever is there and "active" becomes "a…" — a column narrow enough to need
 * an ellipsis on one word is not a column, it is a gap. The page body still
 * never scrolls sideways; only this card does.
 */
function Grid({ head, children, label, min }: { head: React.ReactNode; children: React.ReactNode; label: string; min: number }) {
  return (
    <div className="scroll-thin card mx-6 mb-4 shrink-0 overflow-x-auto md:mx-8">
      <table className="table-cards w-full border-collapse text-[12.5px]" style={{ minWidth: min }} aria-label={label}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- the page */

export default function Registry() {
  const [showDeleted, setShowDeleted] = useState(false);
  const load = useCallback(() => getRegistry(showDeleted), [showDeleted]);
  const { status, data: loaded, error } = useData(load, [showDeleted]);

  // A local mirror so an edit shows the moment the server takes it, rather than
  // waiting on a refetch of all six tables.
  const [d, setD] = useState<RegistryData | null>(null);
  useEffect(() => {
    if (loaded) setD(loaded);
  }, [loaded]);

  const [tab, setTab] = useState<Tab>('Workflows');
  const { toast, setToast } = useToast();
  const fail = useCallback((message: string) => setToast({ text: message, tone: 'failing' }), [setToast]);

  /** Re-reads everything. Used after a change that moves a figure the server computes. */
  const refresh = useCallback(async () => {
    try {
      setD(await getRegistry(showDeleted));
    } catch {
      // The row itself already saved; a stale total is not worth a second error.
    }
  }, [showDeleted]);

  /** Writes one field and folds the row the server sent back into the mirror. */
  const save = useCallback(
    async <K extends RegistryKind>(kind: K, id: string, field: string, value: unknown) => {
      const row = await updateRegistryRow(kind, id, { [field]: value });
      setD((prev) => (prev ? { ...prev, [kind]: (prev[kind] as AnyRow[]).map((r) => (r.id === id ? row : r)) } : prev));
      // The monthly total is computed by the server from these five fields.
      if (kind === 'services' && ['cost_amount', 'cost_currency', 'billing_cycle', 'renewal_date', 'status'].includes(field)) void refresh();
      return row;
    },
    [refresh],
  );

  const add = useCallback(
    async (kind: RegistryKind, values: Record<string, unknown>) => {
      const row = await createRegistryRow(kind, values);
      setD((prev) => (prev ? { ...prev, [kind]: [...(prev[kind] as AnyRow[]), row] } : prev));
      if (kind === 'services') void refresh();
      return row;
    },
    [refresh],
  );

  const remove = useCallback(
    async (kind: RegistryKind, id: string) => {
      try {
        const row = await deleteRegistryRow(kind, id);
        setD((prev) =>
          prev
            ? {
                ...prev,
                [kind]: showDeleted
                  ? (prev[kind] as AnyRow[]).map((r) => (r.id === id ? row : r))
                  : (prev[kind] as AnyRow[]).filter((r) => r.id !== id),
              }
            : prev,
        );
        setToast({ text: `Removed. It keeps its history — turn on “show removed” to put it back.`, tone: 'ok' });
        if (kind === 'services') void refresh();
      } catch (e) {
        fail(e instanceof Error ? e.message : 'That row was not removed.');
      }
    },
    [showDeleted, setToast, fail, refresh],
  );

  const restore = useCallback(
    async (kind: RegistryKind, id: string) => {
      try {
        const row = await restoreRegistryRow(kind, id);
        setD((prev) => (prev ? { ...prev, [kind]: (prev[kind] as AnyRow[]).map((r) => (r.id === id ? row : r)) } : prev));
        setToast({ text: 'Restored.', tone: 'ok' });
        if (kind === 'services') void refresh();
      } catch (e) {
        fail(e instanceof Error ? e.message : 'That row was not restored.');
      }
    },
    [setToast, fail, refresh],
  );

  if (status === 'loading' || !d) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  const counts = {
    Workflows: { n: d.workflows.filter((w) => !w.deleted_at).length },
    'Services & billing': { n: d.services.filter((s) => !s.deleted_at).length },
    Credentials: { n: d.credentials.filter((c) => !c.deleted_at).length },
    Endpoints: { n: d.endpoints.filter((e) => !e.deleted_at).length + d.bases.filter((b) => !b.deleted_at).length },
    People: { n: d.people.filter((p) => !p.deleted_at).length },
  } as Partial<Record<Tab, { n: number }>>;

  const shared = { save, remove, restore, fail, add, showDeleted };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="System registry"
        subtitle="Which workflow does what and who owns it, and what BHA pays for"
        right={
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-dim">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="accent-[var(--accent)]" />
            Show removed
          </label>
        }
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={counts} />}
      />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 text-[11.5px] leading-snug text-faint md:px-8">
          Every cell here is editable — click one, type, press Enter. This dashboard is the system of record for these
          tables: there is no Airtable base behind them, so a change is saved to Postgres and stays there. A field nobody
          has filled in shows a dash rather than a guess.
        </div>

        {tab === 'Workflows' && <WorkflowsTab rows={d.workflows} {...shared} />}
        {tab === 'Services & billing' && <ServicesTab rows={d.services} spend={d.spend} {...shared} />}
        {tab === 'Credentials' && <CredentialsTab rows={d.credentials} workflows={d.workflows} {...shared} />}
        {tab === 'Endpoints' && <EndpointsTab rows={d.endpoints} bases={d.bases} {...shared} />}
        {tab === 'People' && <PeopleTab rows={d.people} {...shared} />}
      </div>

      <Toast toast={toast} />
    </div>
  );
}

/* ------------------------------------------------------------------ tabs */

interface TabProps {
  save: <K extends RegistryKind>(kind: K, id: string, field: string, value: unknown) => Promise<RegistryRowOf[K]>;
  add: (kind: RegistryKind, values: Record<string, unknown>) => Promise<unknown>;
  remove: (kind: RegistryKind, id: string) => Promise<void>;
  restore: (kind: RegistryKind, id: string) => Promise<void>;
  fail: (message: string) => void;
  showDeleted: boolean;
}

/** The remove / restore pair every row carries, revealed on hover like every other row in the app. */
function RowTools({ kind, row, extra, ...p }: TabProps & { kind: RegistryKind; row: AnyRow; extra?: React.ReactNode }) {
  return (
    <RowActions>
      {extra}
      {row.deleted_at ? (
        <RowAction label="Restore" tone="accent" onClick={() => void p.restore(kind, row.id)} />
      ) : (
        <RowAction label="Remove" tone="danger" onClick={() => void p.remove(kind, row.id)} />
      )}
    </RowActions>
  );
}

function cell<K extends RegistryKind>(
  p: TabProps,
  kind: K,
  row: AnyRow,
  field: string,
  opts: { type?: CellType; options?: readonly string[]; align?: 'left' | 'right'; width?: string } = {},
) {
  return (
    <EditableCell
      value={(row as unknown as Record<string, unknown>)[field]}
      type={opts.type}
      options={opts.options}
      align={opts.align}
      width={opts.width}
      disabled={Boolean(row.deleted_at)}
      onSave={(v) => p.save(kind, row.id, field, v)}
      onError={p.fail}
    />
  );
}

/* ------------------------------------------------------------- workflows */

function WorkflowsTab({ rows, ...p }: TabProps & { rows: RegistryData['workflows'] }) {
  const [system, setSystem] = useState('all');
  const [pillar, setPillar] = useState('all');
  const [owner, setOwner] = useState('all');
  const [wfStatus, setWfStatus] = useState('all');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const uniq = (get: (w: RegistryData['workflows'][number]) => string | null) =>
    [...new Set(rows.map(get).filter((v): v is string => Boolean(v)))].sort();

  const systems = useMemo(() => uniq((w) => w.system), [rows]);
  const pillars = useMemo(() => uniq((w) => w.pillar), [rows]);
  const owners = useMemo(() => uniq((w) => w.owner), [rows]);

  const term = q.trim().toLowerCase();
  const shown = rows.filter(
    (w) =>
      (system === 'all' || w.system === system) &&
      (pillar === 'all' || w.pillar === pillar) &&
      (owner === 'all' || w.owner === owner) &&
      (wfStatus === 'all' || w.status === wfStatus) &&
      (!term || [w.name, w.purpose, w.id, w.trigger_detail].some((v) => v && v.toLowerCase().includes(term))),
  );

  // Grouped by system, newest-first inside each group is meaningless for a
  // registry, so these stay in the server's order: system, folder, name.
  const groups = new Map<string, typeof shown>();
  for (const w of shown) {
    const key = w.system ?? 'No system recorded';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
  }

  const withoutPillar = rows.filter((w) => !w.pillar && !w.deleted_at).length;

  return (
    <>
      <StatStrip cols={4}>
        <CountCell label="Workflows" value={rows.filter((w) => !w.deleted_at).length} hint={`${systems.length} systems`} />
        <CountCell label="Production" value={rows.filter((w) => w.status === 'production' && !w.deleted_at).length} />
        <CountCell label="Retired" value={rows.filter((w) => w.status === 'retired').length} tone="dim" />
        <CountCell label="No pillar set" value={withoutPillar} tone={withoutPillar ? 'degraded' : 'dim'} hint="left blank rather than guessed" />
      </StatStrip>

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <Segmented
          ariaLabel="Filter by system"
          value={system}
          onChange={setSystem}
          options={[{ value: 'all', label: 'All systems', count: rows.length }, ...systems.map((s) => ({ value: s, label: s, count: rows.filter((w) => w.system === s).length }))]}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              ariaLabel="Filter by status"
              value={wfStatus}
              onChange={setWfStatus}
              options={[{ value: 'all', label: 'Any status' }, ...WORKFLOW_STATUS.map((s) => ({ value: s, label: s, count: rows.filter((w) => w.status === s).length }))]}
            />
            <select className="input h-[30px] w-auto py-0 text-[12px]" value={pillar} onChange={(e) => setPillar(e.target.value)} aria-label="Filter by pillar">
              <option value="all">Any pillar</option>
              {pillars.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <select className="input h-[30px] w-auto py-0 text-[12px]" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner">
              <option value="all">Any owner</option>
              {owners.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 items-center justify-end gap-3">
            <SearchBox value={q} onChange={setQ} placeholder="Search name and purpose" />
          </div>
        </div>
        <NewRow
          label="workflow"
          onError={p.fail}
          onCreate={(v) => p.add('workflows', v)}
          fields={[
            { name: 'id', label: 'n8n workflow id', required: true, placeholder: 'u2jfe2eRQYIEtuZQ' },
            { name: 'name', label: 'name', required: true },
            { name: 'system', label: 'system' },
            { name: 'folder', label: 'folder' },
            { name: 'pillar', label: 'pillar' },
            { name: 'owner', label: 'owner' },
            { name: 'status', label: 'status', type: 'select', options: WORKFLOW_STATUS },
          ]}
        />
      </div>

      {shown.length === 0 ? (
        <EmptyState>No workflow matches those filters. Clear the search or widen the system and status filters.</EmptyState>
      ) : (
        [...groups.entries()].map(([name, list]) => (
          <div key={name} className="shrink-0">
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
              className="flex w-full items-center gap-2 px-6 pt-2 pb-1 text-left md:px-8"
              aria-expanded={!collapsed[name]}
            >
              <span className="text-[13px] font-medium text-ink">{name}</span>
              <span className="tabular text-[11.5px] text-faint">{list.length}</span>
              <span className="text-[11px] text-faint">{collapsed[name] ? 'show' : 'hide'}</span>
            </button>
            {!collapsed[name] && (
              <Grid
                label={`${name} workflows`}
                min={1320}
                head={
                  <>
                    <Th width="22%">workflow</Th>
                    <Th>pillar</Th>
                    <Th>owner</Th>
                    <Th>trigger</Th>
                    <Th>when it runs</Th>
                    <Th>status</Th>
                    <Th width="26%">purpose</Th>
                    <Th>updated</Th>
                    <Th />
                  </>
                }
              >
                {list.map((w) => (
                  <tr key={w.id} className={w.deleted_at ? 'opacity-50' : ''}>
                    <td className="td card-title td-clip" style={{ maxWidth: '30ch' }}>
                      {cell(p, 'workflows', w, 'name')}
                      <div className="tabular truncate text-[10.5px] text-faint" title={`${w.folder ?? 'no folder'} · ${w.id}`}>
                        {w.folder ?? DASH} · {w.id}
                      </div>
                    </td>
                    <td className="td">{cell(p, 'workflows', w, 'pillar')}</td>
                    <td className="td text-dim">{cell(p, 'workflows', w, 'owner')}</td>
                    <td className="td text-dim">{cell(p, 'workflows', w, 'trigger_type')}</td>
                    <td className="td td-clip text-faint" style={{ maxWidth: '28ch' }}>
                      {cell(p, 'workflows', w, 'trigger_detail', { width: '28ch' })}
                    </td>
                    <td className="td card-meta">
                      {cell(p, 'workflows', w, 'status', { type: 'select', options: WORKFLOW_STATUS })}
                    </td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '46ch' }}>
                      {cell(p, 'workflows', w, 'purpose', { type: 'longtext', width: '46ch' })}
                    </td>
                    <td className="td tabular whitespace-nowrap text-faint" title={w.updated_at}>
                      {when(w.updated_at)}
                    </td>
                    <td className="td card-actions td-actions">
                      <RowTools
                        {...p}
                        kind="workflows"
                        row={w}
                        extra={
                          w.n8n_url ? <RowAction label="Open in n8n" onClick={() => window.open(w.n8n_url!, '_blank', 'noreferrer')} /> : undefined
                        }
                      />
                    </td>
                  </tr>
                ))}
              </Grid>
            )}
          </div>
        ))
      )}
    </>
  );
}

/* -------------------------------------------------- services and billing */

/**
 * The half that did not exist anywhere before this page.
 *
 * The total is the whole design problem. A monthly figure built from two of
 * eleven services is not what BHA spends, and a reader who takes it for one
 * will plan against a number that is wrong by however much is missing. So the
 * number never appears on its own: the count of unpriced services sits beside
 * it, in the same card, at the same weight, and when nothing is priced at all
 * there is no number at all — just the sentence saying so.
 */
function SpendPanel({ spend }: { spend: Spend }) {
  const complete = spend.unpriced === 0 && spend.not_monthly === 0;
  return (
    <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-3">
      <MetricCard
        title="Total monthly spend"
        className="md:col-span-2"
        note={
          complete
            ? `Every one of the ${spend.active} active services carries a cost and a billing cycle, so this is the whole monthly bill.`
            : `Computed from ${spend.priced} of ${spend.active} active services. ${
                spend.unpriced > 0 ? `${spend.unpriced} ${spend.unpriced === 1 ? 'has' : 'have'} no cost recorded` : ''
              }${spend.unpriced > 0 && spend.not_monthly > 0 ? ', and ' : ''}${
                spend.not_monthly > 0 ? `${spend.not_monthly} ${spend.not_monthly === 1 ? 'is' : 'are'} one-off or have no billing cycle` : ''
              }. This is not the whole bill.`
        }
      >
        {spend.totals.length === 0 ? (
          <div className="text-[14px] leading-relaxed text-dim">
            Not recorded. No active service has a cost against it yet, so there is no total to show — a zero here would
            claim BHA spends nothing, which is a different thing entirely. Fill in <span className="text-ink">cost</span>,{' '}
            <span className="text-ink">currency</span> and <span className="text-ink">billing cycle</span> on any row below
            and it starts counting.
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
            {spend.totals.map((t) => (
              <div key={t.currency}>
                <div className="font-display tabular text-[34px] leading-none text-ink">
                  {t.currency === '—' ? '' : `${t.currency} `}
                  {t.monthly.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
                <div className="mt-1 text-[11.5px] text-faint">
                  per month · {t.services} {t.services === 1 ? 'service' : 'services'}
                  {t.currency === '—' && ' · no currency recorded'}
                </div>
              </div>
            ))}
          </div>
        )}
      </MetricCard>

      <MetricCard
        title="Renewing in 30 days"
        note={
          spend.with_renewal_date === 0
            ? 'No service has a renewal date recorded, so nothing can be flagged. This panel stays blank until one does.'
            : `${spend.with_renewal_date} of ${spend.active} active services have a renewal date. The rest cannot be checked.`
        }
      >
        <div className="flex items-baseline gap-3">
          <span className={`font-display tabular text-[34px] leading-none ${spend.renewing_soon.length ? 'text-degraded' : 'text-ink'}`}>
            {spend.renewing_soon.length}
          </span>
          {spend.overdue.length > 0 && (
            <span className="text-[12px] text-failing">
              {spend.overdue.length} already past
            </span>
          )}
        </div>
      </MetricCard>
    </div>
  );
}

function ServicesTab({ rows, spend, ...p }: TabProps & { rows: RegistryData['services']; spend: Spend }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const term = q.trim().toLowerCase();

  const shown = rows.filter(
    (s) =>
      (category === 'all' || s.category === category) &&
      (!term || [s.name, s.what_it_is_for, s.managed_by, s.plan, s.billing_owner].some((v) => v && v.toLowerCase().includes(term))),
  );
  const paged = usePaged(shown, `${category}|${term}`);

  const soon = new Set(spend.renewing_soon);
  const late = new Set(spend.overdue);

  return (
    <>
      <SpendPanel spend={spend} />

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            ariaLabel="Filter by category"
            value={category}
            onChange={setCategory}
            options={[
              { value: 'all', label: 'All', count: rows.length },
              ...CATEGORIES.filter((c) => rows.some((s) => s.category === c)).map((c) => ({
                value: c,
                label: c,
                count: rows.filter((s) => s.category === c).length,
              })),
            ]}
          />
          <div className="flex flex-1 items-center justify-end gap-3">
            <SearchBox value={q} onChange={setQ} placeholder="Search services" />
          </div>
        </div>
        <NewRow
          label="service"
          onError={p.fail}
          onCreate={(v) => p.add('services', v)}
          fields={[
            { name: 'name', label: 'name', required: true },
            { name: 'category', label: 'category', type: 'select', options: CATEGORIES },
            { name: 'managed_by', label: 'managed by' },
            { name: 'plan', label: 'plan' },
            { name: 'cost_amount', label: 'cost', type: 'number' },
            { name: 'cost_currency', label: 'currency', placeholder: 'USD' },
            { name: 'billing_cycle', label: 'billing cycle', type: 'select', options: CYCLES },
            { name: 'renewal_date', label: 'renews', type: 'date' },
          ]}
        />
      </div>

      <Grid
        label="Services and billing"
        min={1400}
        head={
          <>
            <Th width="16%">service</Th>
            <Th>category</Th>
            <Th width="15%">what it is for</Th>
            <Th>managed by</Th>
            <Th>plan</Th>
            <Th right>cost</Th>
            <Th>currency</Th>
            <Th>cycle</Th>
            <Th>renews</Th>
            <Th>who pays</Th>
            <Th>status</Th>
            <Th>updated</Th>
            <Th />
          </>
        }
      >
        {paged.rows.map((s) => {
          const flagged = soon.has(s.id) || late.has(s.id);
          return (
            <tr key={s.id} className={s.deleted_at ? 'opacity-50' : ''}>
              <td className="td card-title td-clip" style={{ maxWidth: '24ch' }}>
                {cell(p, 'services', s, 'name')}
                {s.url && (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-[10.5px] text-faint hover:text-accent-ink"
                    title={s.url}
                  >
                    {s.url.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </td>
              <td className="td card-meta">{cell(p, 'services', s, 'category', { type: 'select', options: CATEGORIES })}</td>
              <td className="td td-clip text-dim" style={{ maxWidth: '30ch' }}>
                {cell(p, 'services', s, 'what_it_is_for', { type: 'longtext', width: '30ch' })}
              </td>
              <td className="td text-dim">{cell(p, 'services', s, 'managed_by')}</td>
              <td className="td text-dim">{cell(p, 'services', s, 'plan')}</td>
              <td className="td tabular text-right">{cell(p, 'services', s, 'cost_amount', { type: 'number', align: 'right' })}</td>
              <td className="td text-faint">{cell(p, 'services', s, 'cost_currency')}</td>
              <td className="td text-faint">{cell(p, 'services', s, 'billing_cycle', { type: 'select', options: CYCLES })}</td>
              <td className={`td tabular whitespace-nowrap ${late.has(s.id) ? 'text-failing' : soon.has(s.id) ? 'text-degraded' : 'text-faint'}`}>
                {cell(p, 'services', s, 'renewal_date', { type: 'date' })}
                {flagged && (
                  <span className="ml-1 text-[10.5px]">{late.has(s.id) ? 'past' : 'soon'}</span>
                )}
              </td>
              <td className="td text-dim">{cell(p, 'services', s, 'billing_owner')}</td>
              <td className="td card-meta">{cell(p, 'services', s, 'status', { type: 'select', options: SERVICE_STATUS })}</td>
              <td className="td tabular whitespace-nowrap text-faint" title={s.updated_at}>
                {when(s.updated_at)}
              </td>
              <td className="td card-actions td-actions">
                <RowTools {...p} kind="services" row={s} />
              </td>
            </tr>
          );
        })}
      </Grid>
      <Pagination paged={paged} unit="services" />

      {rows.some((s) => s.notes) && (
        <div className="shrink-0 px-6 pb-6 md:px-8">
          <MetricCard title="Notes on these services">
            <div className="space-y-2.5 text-[12.5px] leading-relaxed">
              {rows
                .filter((s) => s.notes)
                .map((s) => (
                  <div key={s.id} className="text-dim">
                    <span className="text-ink">{s.name}</span> — {s.notes}
                  </div>
                ))}
            </div>
          </MetricCard>
        </div>
      )}
    </>
  );
}

/* ----------------------------------------------------------- credentials */

function CredentialsTab({ rows, workflows, ...p }: TabProps & { rows: RegistryData['credentials']; workflows: RegistryData['workflows'] }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const nameOf = useMemo(() => new Map(workflows.map((w) => [w.id, w.name])), [workflows]);

  const shown = rows.filter((c) => !term || [c.name, c.type, c.owner].some((v) => v && v.toLowerCase().includes(term)));
  const paged = usePaged(shown, term);
  const unused = rows.filter((c) => !c.deleted_at && c.used_by.length === 0).length;

  return (
    <>
      {/*
        The banner is not decoration. This table is exactly the place someone
        would reach for when they want somewhere to "keep the key safe", and the
        schema has no column to put one in — saying so here is what stops the
        attempt before it becomes a request to add one.
      */}
      <div className="mx-6 mb-4 md:mx-8">
        <div className="flex items-start gap-3 rounded-[14px] bg-accent-soft px-4 py-3">
          <span className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
          <p className="text-[12.5px] leading-relaxed text-ink">
            <span className="font-medium">No secret value is stored here, and none is ever to be added.</span> This table
            holds names, types, owners and what uses them — there is no column a key, token or password could go in, and
            adding one would take a schema migration and a decision, not an edit. Values live in n8n credentials and in
            instance Variables. If you need to share one, share it the way you already do; never here.
          </p>
        </div>
      </div>

      <StatStrip cols={3}>
        <CountCell label="Credentials" value={rows.filter((c) => !c.deleted_at).length} hint="read from the n8n BHA Engine project" />
        <CountCell label="No workflow uses it" value={unused} tone={unused ? 'degraded' : 'dim'} hint="none found across the readable workflows" />
        <CountCell label="Types" value={new Set(rows.map((c) => c.type).filter(Boolean)).size} />
      </StatStrip>

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SearchBox value={q} onChange={setQ} placeholder="Search credentials" />
        </div>
        <NewRow
          label="credential"
          onError={p.fail}
          onCreate={(v) => p.add('credentials', v)}
          fields={[
            { name: 'name', label: 'name', required: true },
            { name: 'type', label: 'type', placeholder: 'httpHeaderAuth' },
            { name: 'owner', label: 'owner' },
            { name: 'used_by', label: 'used by (workflow ids, comma separated)', type: 'array' },
          ]}
        />
      </div>

      <Grid
        label="Credentials"
        min={1120}
        head={
          <>
            <Th width="20%">name</Th>
            <Th>type</Th>
            <Th>owner</Th>
            <Th right>uses</Th>
            <Th width="34%">what uses it</Th>
            <Th>updated</Th>
            <Th />
          </>
        }
      >
        {paged.rows.map((c) => (
          <tr key={c.id} className={c.deleted_at ? 'opacity-50' : ''}>
            <td className="td card-title td-clip" style={{ maxWidth: '26ch' }}>
              {cell(p, 'credentials', c, 'name')}
            </td>
            <td className="td tabular text-faint">{cell(p, 'credentials', c, 'type')}</td>
            <td className="td text-dim">{cell(p, 'credentials', c, 'owner')}</td>
            <td className={`td tabular text-right ${c.used_by.length ? 'text-ink' : 'text-degraded'}`}>{c.used_by.length}</td>
            <td className="td td-clip text-dim" style={{ maxWidth: '54ch' }}>
              {c.used_by.length === 0 ? (
                <span className="text-faint">no workflow found using it</span>
              ) : (
                <span title={c.used_by.map((id) => nameOf.get(id) ?? id).join(', ')}>
                  {c.used_by.map((id) => nameOf.get(id) ?? id).join(', ')}
                </span>
              )}
            </td>
            <td className="td tabular whitespace-nowrap text-faint" title={c.updated_at}>
              {when(c.updated_at)}
            </td>
            <td className="td card-actions td-actions">
              <RowTools {...p} kind="credentials" row={c} />
            </td>
          </tr>
        ))}
      </Grid>
      <Pagination paged={paged} unit="credentials" />

      <div className="shrink-0 px-6 pb-6 md:px-8">
        <p className="max-w-[80ch] text-[11.5px] leading-relaxed text-faint">
          “What uses it” was read from the n8n BHA Engine project on 13 September 2026, across the twenty-nine workflows
          that could be read. An empty list means no use was found — not that none exists. Two workflows could not be
          read at all: the archived North Star — Capacity Intelligence, and the vFarm funnel workflow, which has MCP
          access turned off.
        </p>
      </div>
    </>
  );
}

/* ------------------------------------------------- endpoints and bases */

function EndpointsTab({ rows, bases, ...p }: TabProps & { rows: RegistryData['endpoints']; bases: RegistryData['bases'] }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const shown = rows.filter((e) => !term || [e.name, e.url, e.owned_by_service, e.what_calls_it].some((v) => v && v.toLowerCase().includes(term)));
  const paged = usePaged(shown, term);

  return (
    <>
      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SearchBox value={q} onChange={setQ} placeholder="Search endpoints" />
        </div>
        <NewRow
          label="endpoint"
          onError={p.fail}
          onCreate={(v) => p.add('endpoints', v)}
          fields={[
            { name: 'name', label: 'name', required: true },
            { name: 'url', label: 'url', required: true, placeholder: 'https://…' },
            { name: 'method', label: 'method', type: 'select', options: METHODS },
            { name: 'auth_type', label: 'auth' },
            { name: 'owned_by_service', label: 'owned by' },
          ]}
        />
      </div>

      <Grid
        label="Endpoints"
        min={1280}
        head={
          <>
            <Th>method</Th>
            <Th width="18%">endpoint</Th>
            <Th width="26%">url</Th>
            <Th>auth</Th>
            <Th>owned by</Th>
            <Th width="26%">what calls it</Th>
            <Th>updated</Th>
            <Th />
          </>
        }
      >
        {paged.rows.map((e) => (
          <tr key={e.id} className={e.deleted_at ? 'opacity-50' : ''}>
            <td className="td card-meta">{cell(p, 'endpoints', e, 'method', { type: 'select', options: METHODS })}</td>
            <td className="td card-title td-clip" style={{ maxWidth: '24ch' }}>
              {cell(p, 'endpoints', e, 'name')}
            </td>
            <td className="td td-clip text-faint" style={{ maxWidth: '44ch' }}>
              {cell(p, 'endpoints', e, 'url', { type: 'url', width: '44ch' })}
            </td>
            <td className="td text-dim">{cell(p, 'endpoints', e, 'auth_type')}</td>
            <td className="td text-dim">{cell(p, 'endpoints', e, 'owned_by_service')}</td>
            <td className="td td-clip text-dim" style={{ maxWidth: '44ch' }}>
              {cell(p, 'endpoints', e, 'what_calls_it', { type: 'longtext', width: '44ch' })}
            </td>
            <td className="td tabular whitespace-nowrap text-faint" title={e.updated_at}>
              {when(e.updated_at)}
            </td>
            <td className="td card-actions td-actions">
              <RowTools {...p} kind="endpoints" row={e} />
            </td>
          </tr>
        ))}
      </Grid>
      <Pagination paged={paged} unit="endpoints" />

      {/*
        Airtable bases sit here rather than under Services because they are the
        other half of the same question — the addresses the engine talks to —
        and not something anyone is billed for. Putting them among the services
        would have added ten unpriced rows to the spend denominator and made an
        already-incomplete total read as far worse than it is.
      */}
      <div className="shrink-0 px-6 pb-2 md:px-8">
        <div className="flex items-baseline gap-2 pt-2">
          <span className="text-[13px] font-medium text-ink">Airtable bases</span>
          <span className="tabular text-[11.5px] text-faint">{bases.filter((b) => !b.deleted_at).length}</span>
        </div>
        <p className="mt-1 mb-2 max-w-[80ch] text-[11.5px] leading-relaxed text-faint">
          The other set of addresses the engine reads and writes. They are not billed separately — Airtable is one
          service on the billing tab — so they are listed here rather than there.
        </p>
      </div>

      <Grid
        label="Airtable bases"
        min={1100}
        head={
          <>
            <Th width="18%">base</Th>
            <Th>base id</Th>
            <Th width="34%">what it is for</Th>
            <Th width="26%">notes</Th>
            <Th />
          </>
        }
      >
        {bases.map((b) => (
          <tr key={b.id} className={b.deleted_at ? 'opacity-50' : ''}>
            <td className="td card-title td-clip" style={{ maxWidth: '26ch' }}>
              {cell(p, 'bases', b, 'name')}
            </td>
            <td className="td tabular text-faint">{b.id}</td>
            <td className="td td-clip text-dim" style={{ maxWidth: '54ch' }}>
              {cell(p, 'bases', b, 'what_it_is_for', { type: 'longtext', width: '54ch' })}
            </td>
            <td className="td td-clip text-faint" style={{ maxWidth: '44ch' }}>
              {cell(p, 'bases', b, 'notes', { type: 'longtext', width: '44ch' })}
            </td>
            <td className="td card-actions td-actions">
              <RowTools
                {...p}
                kind="bases"
                row={b}
                extra={b.url ? <RowAction label="Open in Airtable" onClick={() => window.open(b.url!, '_blank', 'noreferrer')} /> : undefined}
              />
            </td>
          </tr>
        ))}
      </Grid>

      <div className="shrink-0 px-6 pb-6 md:px-8">
        <NewRow
          label="Airtable base"
          onError={p.fail}
          onCreate={(v) => p.add('bases', v)}
          fields={[
            { name: 'id', label: 'base id', required: true, placeholder: 'appUVlBSGGPHw6DGh' },
            { name: 'name', label: 'name', required: true },
            { name: 'what_it_is_for', label: 'what it is for' },
          ]}
        />
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- people */

function PeopleTab({ rows, ...p }: TabProps & { rows: RegistryData['people'] }) {
  return (
    <>
      <div className="shrink-0 px-6 pb-3 md:px-8">
        <NewRow
          label="person"
          onError={p.fail}
          onCreate={(v) => p.add('people', v)}
          fields={[
            { name: 'name', label: 'name', required: true },
            { name: 'role', label: 'role' },
            { name: 'slack_user_id', label: 'slack id', placeholder: 'U0…' },
            { name: 'email', label: 'email' },
            { name: 'lanes_owned', label: 'lanes (comma separated)', type: 'array' },
          ]}
        />
      </div>

      <Grid
        label="People"
        min={1080}
        head={
          <>
            <Th width="18%">name</Th>
            <Th width="20%">role</Th>
            <Th width="20%">lanes owned</Th>
            <Th>slack id</Th>
            <Th>email</Th>
            <Th>updated</Th>
            <Th />
          </>
        }
      >
        {rows.map((person) => (
          <tr key={person.id} className={person.deleted_at ? 'opacity-50' : ''}>
            <td className="td card-title td-clip" style={{ maxWidth: '26ch' }}>
              {cell(p, 'people', person, 'name')}
            </td>
            <td className="td text-dim">{cell(p, 'people', person, 'role')}</td>
            <td className="td card-meta">
              {person.lanes_owned.length === 0 ? (
                <EditableCell
                  value={person.lanes_owned}
                  type="array"
                  disabled={Boolean(person.deleted_at)}
                  onSave={(v) => p.save('people', person.id, 'lanes_owned', v)}
                  onError={p.fail}
                />
              ) : (
                <span className="inline-flex flex-wrap gap-1">
                  {person.lanes_owned.map((l) => (
                    <Pill key={l}>{l}</Pill>
                  ))}
                  <EditableCell
                    value={person.lanes_owned}
                    type="array"
                    disabled={Boolean(person.deleted_at)}
                    onSave={(v) => p.save('people', person.id, 'lanes_owned', v)}
                    onError={p.fail}
                    inline
                    render={() => <span className="text-[10.5px] text-faint">edit</span>}
                  />
                </span>
              )}
            </td>
            <td className="td tabular text-faint">{cell(p, 'people', person, 'slack_user_id')}</td>
            <td className="td td-clip text-dim" style={{ maxWidth: '28ch' }}>
              {cell(p, 'people', person, 'email', { width: '28ch' })}
            </td>
            <td className="td tabular whitespace-nowrap text-faint" title={person.updated_at}>
              {when(person.updated_at)}
            </td>
            <td className="td card-actions td-actions">
              <RowTools {...p} kind="people" row={person} />
            </td>
          </tr>
        ))}
      </Grid>

      {rows.some((x) => x.notes) && (
        <div className="shrink-0 px-6 pb-6 md:px-8">
          <MetricCard title="Notes">
            <div className="space-y-2.5 text-[12.5px] leading-relaxed">
              {rows
                .filter((x) => x.notes)
                .map((x) => (
                  <div key={x.id} className="text-dim">
                    <span className="text-ink">{x.name}</span> — {x.notes}
                  </div>
                ))}
            </div>
          </MetricCard>
        </div>
      )}
    </>
  );
}
