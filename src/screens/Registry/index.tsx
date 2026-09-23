import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import {
  createRegistryRow,
  deleteRegistryRow,
  getRegistry,
  restoreRegistryRow,
  updateRegistryRow,
  type DigestHealth,
  type RegistryData,
  type ShownKind,
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
 * The System Registry: four registries on one page — who the builders are, what
 * BHA pays for, what it calls, and what runs.
 *
 * Questions nobody could answer without asking Destiny. Services, plans, cost,
 * renewal and who pays did not exist anywhere before this, which is why the
 * Tools tab leads with a total that states in the same breath how much of
 * itself is missing.
 *
 * **Nobody writes these but us.** Every other records page in this app shows
 * rows the engine writes through /api/engine, and a change made there is a
 * change to a row n8n also writes; these tables have no upstream at all, so a
 * change made in a cell is the only statement there will ever be about it. That
 * is why they are editable in place. The three live figures on Builders are the
 * exception in the other direction — they are read from the record tables on
 * every load, so there is nothing to type.
 *
 * **Nothing here holds a secret, and there is no credentials registry**
 * (decision 2026-09-14, Destiny). The tab that listed credential names, types
 * and owners is gone rather than carried over: it had no column a value could
 * go in and was still the place somebody would reach for when they wanted
 * somewhere to keep a key.
 */

/**
 * Four registries and one surface (decision 2026-09-14, Destiny). Builders
 * first, because it is the one a person looks up most and the one that absorbed
 * the Builders page. **Engine writes is not a registry** — it is the dual-write
 * comparison surface — which is why it sits last and behind a different source.
 *
 * There is no credentials registry and there is not to be one. The tab that
 * stood here listed names, types and owners with no column a value could go in,
 * and it was still the place somebody would reach for when they wanted
 * somewhere to keep a key. The table is not dropped, because nothing drops a
 * table; it is simply neither read nor served.
 */
/**
 * Engine writes came off on 2026-09-22 (Destiny). It compared this database
 * against Airtable's copy while both were written; Airtable is retired, so it
 * compared against nothing. The write log itself (`engine_writes`) is kept and
 * still read — by the Clients and Pay pages and by the MCP tools.
 */
const TABS = ['Builders', 'Tools', 'Endpoint', 'Workflow'] as const;
type Tab = (typeof TABS)[number];

const WORKFLOW_STATUS = ['production', 'experimental', 'retired'] as const;
/** Whether the recovery watcher may re-run this workflow's failures once a dependency is back (2026-09-23). */
const WORKFLOW_REPLAY = ['auto', 'never'] as const;
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
function Grid({
  head,
  children,
  label,
  min,
  empty,
  cols,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  label: string;
  min: number;
  /**
   * What this registry says when it holds nothing, drawn inside the table
   * rather than instead of it. The frame and its headers stay, so a registry
   * with no source yet reads as a registry with nothing in it rather than as a
   * page that failed to load.
   */
  empty?: React.ReactNode;
  /** Column count, so the empty line can span the header. */
  cols?: number;
}) {
  const rows = React.Children.toArray(children);
  return (
    <div className="scroll-thin card mx-6 mb-4 shrink-0 overflow-x-auto md:mx-8">
      <table className="table-cards w-full border-collapse text-[12.5px]" style={{ minWidth: min }} aria-label={label}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty !== undefined ? (
            <tr className="row-empty">
              <td colSpan={cols ?? 1} className="td td-empty px-6 text-center align-middle text-[13px] text-dim">
                {empty}
              </td>
            </tr>
          ) : (
            rows
          )}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- the page */

export default function Registry() {
  const [showDeleted, setShowDeleted] = useState(false);
  const load = useCallback(() => getRegistry(showDeleted), [showDeleted]);
  const { status, data: loaded, error } = useData(load, [showDeleted], { kinds: ['registry', 'loops', 'codex'] });

  // A local mirror so an edit shows the moment the server takes it, rather than
  // waiting on a refetch of all six tables.
  const [d, setD] = useState<RegistryData | null>(null);
  useEffect(() => {
    if (loaded) setD(loaded);
  }, [loaded]);

  const [tab, setTab] = useState<Tab>('Builders');
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
    async <K extends ShownKind>(kind: K, id: string, field: string, value: unknown) => {
      const row = await updateRegistryRow(kind, id, { [field]: value });
      setD((prev) => (prev ? { ...prev, [kind]: (prev[kind] as AnyRow[]).map((r) => (r.id === id ? row : r)) } : prev));
      // The monthly total is computed by the server from these five fields.
      if (kind === 'services' && ['cost_amount', 'cost_currency', 'billing_cycle', 'renewal_date', 'status'].includes(field)) void refresh();
      return row;
    },
    [refresh],
  );

  const add = useCallback(
    async (kind: ShownKind, values: Record<string, unknown>) => {
      const row = await createRegistryRow(kind, values);
      setD((prev) => (prev ? { ...prev, [kind]: [...(prev[kind] as AnyRow[]), row] } : prev));
      if (kind === 'services') void refresh();
      return row;
    },
    [refresh],
  );

  const remove = useCallback(
    async (kind: ShownKind, id: string) => {
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
    async (kind: ShownKind, id: string) => {
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
    Builders: { n: d.people.filter((p) => !p.deleted_at).length },
    Tools: { n: d.services.filter((s) => !s.deleted_at).length },
    Endpoint: { n: d.endpoints.filter((e) => !e.deleted_at).length + d.bases.filter((b) => !b.deleted_at).length },
    Workflow: { n: d.workflows.filter((w) => !w.deleted_at).length },
  } as Partial<Record<Tab, { n: number }>>;

  const shared = { save, remove, restore, fail, add, showDeleted };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="System registry"
        subtitle="Who the builders are, what BHA pays for, what it calls, and what runs"
        right={
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-dim">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="accent-[var(--accent)]" />
            Show removed
          </label>
        }
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={counts} />}
      />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 max-w-[104ch] px-6 pb-3 text-[11.5px] leading-snug text-faint md:px-8">
          Every typed cell here is editable — click one, type, press Enter. This dashboard is the system of record for
          these tables: nothing upstream writes them, so a change is saved to Postgres and stays there. A field nobody
          has filled in shows a dash rather than a guess.
        </div>

        {tab === 'Builders' && <BuildersTab rows={d.people} {...shared} />}
        {tab === 'Tools' && <ServicesTab rows={d.services} spend={d.spend} {...shared} />}
        {tab === 'Endpoint' && <EndpointsTab rows={d.endpoints} bases={d.bases} digests={d.digest_health} {...shared} />}
        {tab === 'Workflow' && <WorkflowsTab rows={d.workflows} {...shared} />}
      </div>

      <Toast toast={toast} />
    </div>
  );
}

/* ------------------------------------------------------------------ tabs */

interface TabProps {
  save: <K extends ShownKind>(kind: K, id: string, field: string, value: unknown) => Promise<RegistryRowOf[K]>;
  add: (kind: ShownKind, values: Record<string, unknown>) => Promise<unknown>;
  remove: (kind: ShownKind, id: string) => Promise<void>;
  restore: (kind: ShownKind, id: string) => Promise<void>;
  fail: (message: string) => void;
  showDeleted: boolean;
}

/** The remove / restore pair every row carries, revealed on hover like every other row in the app. */
function RowTools({ kind, row, extra, ...p }: TabProps & { kind: ShownKind; row: AnyRow; extra?: React.ReactNode }) {
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

function cell<K extends ShownKind>(
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
        <CountCell label="Workflows" value={rows.filter((w) => !w.deleted_at).length} hint={`${systems.length} systems`} hintMinLines={2} />
        <CountCell label="Production" value={rows.filter((w) => w.status === 'production' && !w.deleted_at).length} hintMinLines={2} />
        <CountCell label="Retired" value={rows.filter((w) => w.status === 'retired').length} tone="dim" hintMinLines={2} />
        <CountCell label="No pillar set" value={withoutPillar} tone={withoutPillar ? 'degraded' : 'dim'} hint="left blank rather than guessed" hintMinLines={2} />
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
                min={1400}
                cols={10}
                empty="No workflow is registered under this pillar."

                head={
                  <>
                    <Th width="22%">workflow</Th>
                    <Th>pillar</Th>
                    <Th>owner</Th>
                    <Th>trigger</Th>
                    <Th>when it runs</Th>
                    <Th>status</Th>
                    <Th>replay</Th>
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
                    {/*
                      Whether a failure of this workflow is re-run once the
                      dependency it waited on is back. "never" is for chat
                      replies: an answer hours late to a thread that has moved
                      on is worse than none.
                    */}
                    <td className="td card-meta" title={w.replay === 'never' ? 'Never re-run by the recovery watcher: its failed runs are closed as won’t fix once the dependency is back.' : 'Re-run from the failed step by the recovery watcher once the dependency it waited on is back.'}>
                      {cell(p, 'workflows', w, 'replay', { type: 'select', options: WORKFLOW_REPLAY })}
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
function SpendPanel({ spend, services }: { spend: Spend; services: RegistryData['services'] }) {
  const complete = spend.unpriced === 0 && spend.not_monthly === 0;
  /**
   * The services a cost was typed onto that no monthly figure can use, by name
   * (2026-09-16, Destiny). "3 are one-off or have no billing cycle" is true and
   * unactionable: it takes a reader down a table of ten rows looking for which
   * three. A cost with no cycle is not a monthly cost — sixty dollars is not
   * sixty dollars a month until somebody says which — so the total is right to
   * leave it out, and the card has to say so by name or it reads as the total
   * being broken.
   */
  const pending = spend.not_monthly_ids
    .map((id) => services.find((x) => x.id === id)?.name)
    .filter((n): n is string => Boolean(n));
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
            {/*
              Two reasons there is no total, and they are not the same sentence
              (2026-09-16, Destiny). "No service has a cost against it" is a lie
              on a page where one does and simply has no billing cycle, and it
              is the lie that reads as the total being broken.
            */}
            {spend.priced === 0 ? (
              <>
                Not recorded. No active service has a cost against it yet, so there is no total to show — a zero here would
                claim BHA spends nothing, which is a different thing entirely. Fill in <span className="text-ink">cost</span>,{' '}
                <span className="text-ink">currency</span> and <span className="text-ink">billing cycle</span> on any row below
                and it starts counting.
              </>
            ) : (
              <>
                No monthly total yet. {spend.priced} {spend.priced === 1 ? 'service carries' : 'services carry'} a cost, but{' '}
                {spend.priced === 1 ? 'it has no' : 'not one of them has a'} <span className="text-ink">billing cycle</span>, and a cost with
                no cycle is not a monthly cost — sixty dollars is not sixty dollars a month until somebody says which.
              </>
            )}
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
        {pending.length > 0 && (
          <div className="mt-3 text-[11.5px] leading-snug text-degraded">
            Priced but not counted, because {pending.length === 1 ? 'it carries' : 'they carry'} no billing cycle:{' '}
            <span className="text-ink">{pending.join(', ')}</span>. Set a cycle on {pending.length === 1 ? 'that row' : 'those rows'} and the total picks {pending.length === 1 ? 'it' : 'them'} up.
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
  const uncounted = new Set(spend.not_monthly_ids);

  /*
    The notes card below, in its own order: a service that carries a note
    first, then the ones that do not, each group still in the table's order
    because sort is stable. Deleted rows are left out — a note on something
    nobody runs any more is history, and this card is the standing reference.
    Deliberately not filtered by the search box or the category tabs: these
    are read as a set, and a note that disappears because somebody typed in
    an unrelated filter is a note nobody finds twice.
  */
  const noteworthy = rows.filter((s) => !s.deleted_at).sort((a, b) => Number(Boolean(b.notes)) - Number(Boolean(a.notes)));

  return (
    <>
      <SpendPanel spend={spend} services={rows} />

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
          /*
            url and notes were missing here until 18 Sep 2026, and they are the
            two fields nothing else on this tab could fill either: every other
            column is editable in the row, so a service added without one of
            these had no way of ever getting it. GoDaddy is how that surfaced.
          */
          fields={[
            { name: 'name', label: 'name', required: true },
            { name: 'category', label: 'category', type: 'select', options: CATEGORIES },
            { name: 'url', label: 'url', type: 'url', placeholder: 'https://…' },
            { name: 'managed_by', label: 'managed by' },
            { name: 'plan', label: 'plan' },
            { name: 'cost_amount', label: 'cost', type: 'number' },
            { name: 'cost_currency', label: 'currency', placeholder: 'USD' },
            { name: 'billing_cycle', label: 'billing cycle', type: 'select', options: CYCLES },
            { name: 'renewal_date', label: 'renews', type: 'date' },
            { name: 'notes', label: 'notes' },
          ]}
        />
      </div>

      {/*
        Twelve columns at 1040 rather than thirteen at 1400 (2026-09-16,
        Destiny): the table scrolled sideways inside itself on a normal screen,
        and "updated" was the column paying for it — a timestamp nobody reads on
        a table whose whole point is what it costs and who pays.
      */}
      <Grid
        label="Tools"
        min={1040}
        cols={12}
        empty="No tool is registered yet."

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
                {/*
                  The url is editable here, not only readable. It was neither
                  on the add form nor anywhere in the row, so a service created
                  from the form above could never be given one — which is how
                  GoDaddy came to sit here with a blank where its console link
                  belongs. The link stays clickable and the editor sits beside
                  it, the same shape the Builders tab uses for lanes owned.
                */}
                {/*
                  The url is shown, not edited here (2026-09-22, Destiny): the
                  small "edit" beside it came off. The link stays clickable —
                  except on a retired service (2026-09-23): Airtable is kept as
                  the tool BHA paid for, but nothing here sends anybody to it.
                */}
                {s.url && s.status === 'retired' ? (
                  <span className="block min-w-0 truncate text-[10.5px] text-faint" title="Retired — kept as a record, not linked">
                    {s.url.replace(/^https?:\/\//, '')}
                  </span>
                ) : s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block min-w-0 truncate text-[10.5px] text-faint hover:text-accent-ink"
                    title={s.url}
                  >
                    {s.url.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span className="text-[10.5px] text-faint">no url recorded</span>
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
              {/*
                Amber where a cost was typed and no cycle was, because that row
                is the reason the monthly total is not the whole bill. Amber on
                a genuinely bad state, never on a blank one: a row with no cost
                either is simply not priced yet and stays quiet.
              */}
              <td className={`td ${uncounted.has(s.id) ? 'text-degraded' : 'text-faint'}`} title={uncounted.has(s.id) ? 'A cost with no billing cycle cannot be part of a monthly total.' : undefined}>
                {cell(p, 'services', s, 'billing_cycle', { type: 'select', options: CYCLES })}
              </td>
              <td className={`td tabular whitespace-nowrap ${late.has(s.id) ? 'text-failing' : soon.has(s.id) ? 'text-degraded' : 'text-faint'}`}>
                {cell(p, 'services', s, 'renewal_date', { type: 'date' })}
                {flagged && (
                  <span className="ml-1 text-[10.5px]">{late.has(s.id) ? 'past' : 'soon'}</span>
                )}
              </td>
              <td className="td text-dim">{cell(p, 'services', s, 'billing_owner')}</td>
              <td className="td card-meta">{cell(p, 'services', s, 'status', { type: 'select', options: SERVICE_STATUS })}</td>
              <td className="td card-actions td-actions">
                <RowTools {...p} kind="services" row={s} />
              </td>
            </tr>
          );
        })}
      </Grid>
      <Pagination paged={paged} unit="services" />

      {/*
        Every live service, not only the ones that already carry a note, and
        every note editable in place (18 Sep 2026). `notes` was a registered
        field with no interface at all — not on the add form, not in the row —
        so the only notes that could ever exist were the ones seeded in this
        repo, and a service added from the page could never be annotated.
        Noted services lead, because this is a card for reading notes; the
        rest keep their line with a dash on it, which says nobody has written
        one rather than hiding that there is nothing to read.
      */}
      {noteworthy.length > 0 && (
        <div className="shrink-0 px-6 pb-6 md:px-8">
          <MetricCard title="Notes on these services">
            <div className="space-y-2.5 text-[12.5px] leading-relaxed">
              {noteworthy.map((s) => (
                <div key={s.id} className="text-dim">
                  <span className="text-ink">{s.name}</span>{' '}
                  {s.notes ? (
                    <>
                      {'— '}{s.notes}{' '}
                      <EditableCell
                        value={s.notes}
                        type="longtext"
                        onSave={(v) => p.save('services', s.id, 'notes', v)}
                        onError={p.fail}
                        inline
                        render={() => <span className="text-[10.5px] text-faint">edit</span>}
                      />
                    </>
                  ) : (
                    <EditableCell
                      value={null}
                      type="longtext"
                      onSave={(v) => p.save('services', s.id, 'notes', v)}
                      onError={p.fail}
                      inline
                    />
                  )}
                </div>
              ))}
            </div>
          </MetricCard>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------- endpoints and bases */

function EndpointsTab({ rows, bases, digests, ...p }: TabProps & { rows: RegistryData['endpoints']; bases: RegistryData['bases']; digests: DigestHealth }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const shown = rows.filter((e) => !term || [e.name, e.url, e.owned_by_service, e.what_calls_it].some((v) => v && v.toLowerCase().includes(term)));
  const paged = usePaged(shown, term);

  return (
    <>
      <div className="mx-6 mb-4 md:mx-8">
        <MetricCard
          title="Open Loops digests that never reached Slack"
          right={`last ${digests.window_days} days`}
          note={
            digests.rows === 0
              ? 'Nothing has been read into digest_deliveries yet, so this is not a count of zero — it is nothing to count. Run the backfill, or let Bays — Digest Delivery Check write its first row.'
              : `The 08:00 open-loops digest is handed to North Star, which posts it to each builder in Slack; a row is written when it is sent and updated when the Callback Receiver confirms it posted. ${digests.sent} sent in the window, ${digests.delivered} confirmed. Every other signal in the stack stops at North Star accepting the hand-off, which is four hops short of a builder reading it — this is the only measure that goes the rest of the way.`
          }
        >
          {digests.rows === 0 ? (
            <div className="text-[15px] leading-relaxed text-faint">Not recorded</div>
          ) : (
            <div className="flex items-baseline gap-3">
              <span className={`font-display tabular text-[34px] leading-none ${digests.missing ? 'text-failing' : 'text-ink'}`}>{digests.missing}</span>
              <span className="text-[12px] text-faint">
                of {digests.sent} sent{digests.latest_sent_at ? ` · newest ${digests.latest_sent_at.slice(0, 10)}` : ''}
              </span>
            </div>
          )}
        </MetricCard>
      </div>

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
        cols={8}
        empty="No endpoint is registered yet."

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
          <span className="text-[13px] font-medium text-ink">Airtable bases — history</span>
          <span className="tabular text-[11.5px] text-faint">{bases.filter((b) => !b.deleted_at).length}</span>
        </div>
        <p className="mt-1 mb-2 max-w-[80ch] text-[11.5px] leading-relaxed text-faint">
          <span className="font-medium text-dim">Not live.</span> These are the Airtable bases and tables the engine read and wrote before
          the migration. Airtable was retired on 22 Sep 2026 and the engine now reads and writes this dashboard’s own tables through
          /api/engine; the list is kept because the history in these bases is real and a base that vanished from here would read as one
          that never existed.
        </p>
      </div>

      <Grid
        label="Airtable bases"
        min={1100}
        cols={5}
        empty="No Airtable base is registered yet."

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

/* -------------------------------------------------------------- builders */

/**
 * The roster.
 *
 * This is where the Builders page went (decision 2026-09-14, Destiny). The
 * open-loop count, the oldest-loop age and entries-this-week came with it and
 * went again on 2026-09-16: they are what Open loops and Codex entries are
 * *for*, and repeating them on a roster meant three figures nobody would think
 * to keep looking at here. What is left is who the team are, which is the one
 * thing this table is the only source of.
 */
function BuildersTab({ rows, ...p }: TabProps & { rows: RegistryData['people'] }) {
  const live = rows.filter((r) => !r.deleted_at);
  const withRole = live.filter((r) => (r.role ?? '').trim()).length;
  const withLanes = live.filter((r) => r.lanes_owned.length > 0).length;
  const withSlack = live.filter((r) => (r.slack_user_id ?? '').trim()).length;
  return (
    <>
      {/*
        Four figures about the roster itself, not about the work (2026-09-16,
        Destiny). Open loops, oldest loop and entries this week were figures
        about other pages, shown on the one page nobody goes to for them. These
        three say how complete the roster is — the only question this table is
        the source of an answer to.
      */}
      <StatStrip cols={4}>
        <CountCell label="People" value={live.length} hint="the roster, typed here and nowhere else" hintMinLines={2} />
        <CountCell label="With a role" value={withRole} tone={withRole < live.length ? 'degraded' : 'dim'} hint="a row with no role says nothing about what the person owns" hintMinLines={2} />
        <CountCell label="Lanes assigned" value={withLanes} tone={withLanes < live.length ? 'degraded' : 'dim'} hint="people carrying at least one lane" hintMinLines={2} />
        <CountCell label="Slack ids" value={withSlack} tone={withSlack < live.length ? 'degraded' : 'dim'} hint="needed to route a digest to the person" hintMinLines={2} />
      </StatStrip>

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
        label="Builders"
        min={880}
        cols={6}
        empty="Nobody is on the roster yet."

        head={
          <>
            <Th width="20%">name</Th>
            <Th width="22%">role</Th>
            <Th width="20%">lanes owned</Th>
            <Th>slack id</Th>
            <Th>email</Th>
            <Th />
          </>
        }
      >
        {rows.map((person) => {
          return (
          <tr key={person.id} className={person.deleted_at ? 'opacity-50' : ''}>
            <td className="td card-title td-clip" style={{ maxWidth: '26ch' }}>
              {cell(p, 'people', person, 'name')}
            </td>
            <td className="td card-meta text-dim">{cell(p, 'people', person, 'role')}</td>
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
            <td className="td td-clip text-dim" style={{ maxWidth: '26ch' }}>
              {cell(p, 'people', person, 'email', { width: '26ch' })}
            </td>
            <td className="td card-actions td-actions">
              <RowTools {...p} kind="people" row={person} />
            </td>
          </tr>
          );
        })}
      </Grid>

    </>
  );
}
