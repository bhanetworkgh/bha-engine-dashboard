import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { useData } from '../../app/useData';
import { createRegistryRow, getAgreements, getRegistry, updateRegistryRow, type RegistryData } from '../../data';
import { EmptyState, LoadFailed, Loading, MetricCard, PageHeader, Toast, relativeTime, useToast } from '../../components/ui';
import { EditableCell, NewRow } from '../Registry/Editable';
import { AgreementPanel, ordered } from './Agreements';

/**
 * Stage 1 status (5 Nov 2026, Destiny; Jason, DM 1793820617.412249: "one clear table" of who is in under the
 * comp plan, so he can plan Stage 1 revenue and further offers without guessing).
 *
 * The rows are registry kind `stage1`: this dashboard is their record, edited here or through write_registry.
 * Behind the admin login from 5 Nov 2026. The table reads; a row opens a window holding every field, edited
 * there, and that person's agreement word for word (`?person=<id>`). The agreements are stored encrypted, and
 * DocuSign stays the record of what was signed. The signed dates are typed from DocuSign's own read-back:
 * nothing here reads DocuSign, so the page says when a row was last changed.
 */
/** Jason's knowledge capture standard, 5 Nov 2026, logged as an SOP in BHARAG. */
const KNOWLEDGE_STANDARD = '/codex?view=sops&sop=7345a32f-7813-45bb-8ccb-cbc7144bfb16';

const PLAN_STATUS = ['In under this plan', 'Out / paused', 'Need X clarified before committing', 'No response, treated as paused'] as const;

const TONE: Record<string, string> = {
  'In under this plan': 'text-accent',
  'Need X clarified before committing': 'text-degraded',
  'Out / paused': 'text-failing',
  'No response, treated as paused': 'text-failing',
};

const FIELDS: { field: string; label: string; type?: 'date' | 'longtext' | 'select'; options?: readonly string[]; wide?: boolean }[] = [
  { field: 'lane', label: 'lane' },
  { field: 'plan_status', label: 'status', type: 'select', options: PLAN_STATUS },
  { field: 'agreement_sent', label: 'sent', type: 'date' },
  { field: 'signed', label: 'signed', type: 'date' },
  { field: 'countersigned', label: 'countersigned', type: 'date' },
  { field: 'hard_constraints', label: 'hard constraints', type: 'longtext', wide: true },
  { field: 'knowledge_capture', label: 'knowledge capture', type: 'longtext', wide: true },
  { field: 'notes', label: 'notes', type: 'longtext', wide: true },
];

export default function Stage1() {
  const { status, data: loaded, error } = useData(() => getRegistry(false), [], { kinds: ['registry'] });
  const [d, setD] = useState<RegistryData | null>(null);
  useEffect(() => {
    if (loaded) setD(loaded);
  }, [loaded]);
  const [nonce, setNonce] = useState(0);
  const held = useData(getAgreements, [nonce]);
  const [params, setParams] = useSearchParams();
  const openId = params.get('person');
  const setOpen = useCallback((id: string | null) => setParams(id ? { person: id } : {}, { replace: true }), [setParams]);
  useEffect(() => {
    if (!openId) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [openId, setOpen]);
  const { toast, setToast } = useToast();
  const fail = useCallback((text: string) => setToast({ text, tone: 'failing' }), [setToast]);

  const save = useCallback(async (id: string, field: string, value: unknown) => {
    const row = await updateRegistryRow('stage1', id, { [field]: value });
    setD((p) => (p ? { ...p, stage1: p.stage1.map((r) => (r.id === id ? row : r)) } : p));
    return row;
  }, []);

  if (status === 'loading' || !d) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  const rows = d.stage1;
  const count = (s: string) => rows.filter((r) => r.plan_status === s).length;
  const signed = rows.filter((r) => r.signed).length;
  const counter = rows.filter((r) => r.countersigned).length;
  const newest = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '');

  const open = rows.find((r) => r.id === openId) ?? null;
  const copiesOf = (id: string) => (held.data?.agreements ?? []).filter((a) => a.person_id === id);
  const tone = (v: string) => <span className={TONE[v] ?? 'text-dim'}>{v}</span>;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Stage 1 status" subtitle="Where each person stands under the comp plan" />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 max-w-[104ch] px-6 pb-3 text-[11.5px] leading-snug text-faint md:px-8">
          Open a person for everything held on them, with their agreement word for word. DocuSign stays the record of what was signed. Signed dates are entered from DocuSign{newest ? `; last changed ${relativeTime(newest) ?? newest.slice(0, 10)}` : ''}. <Link to={KNOWLEDGE_STANDARD} className="text-accent">Knowledge capture standard</Link>.
        </div>
        <div className="mx-6 mb-4 grid grid-cols-2 gap-3 md:mx-8 md:grid-cols-4">
          <MetricCard title="In under this plan"><span className="font-display tabular text-[28px] leading-none text-ink">{count(PLAN_STATUS[0])}</span></MetricCard>
          <MetricCard title="Need something clarified"><span className="font-display tabular text-[28px] leading-none text-ink">{count(PLAN_STATUS[2])}</span></MetricCard>
          <MetricCard title="Out, paused or no response"><span className="font-display tabular text-[28px] leading-none text-ink">{count(PLAN_STATUS[1]) + count(PLAN_STATUS[3])}</span></MetricCard>
          <MetricCard title="Signed / countersigned"><span className="font-display tabular text-[28px] leading-none text-ink">{signed} / {counter}</span><span className="ml-2 text-[12px] text-faint">of {rows.length}</span></MetricCard>
        </div>
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <NewRow
            label="person"
            onError={fail}
            onCreate={async (v) => {
              const row = await createRegistryRow('stage1', v);
              setD((p) => (p ? { ...p, stage1: [...p.stage1, row] } : p));
            }}
            fields={[
              { name: 'name', label: 'name', required: true },
              { name: 'lane', label: 'lane' },
              { name: 'plan_status', label: 'status', type: 'select', options: PLAN_STATUS },
            ]}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState>Nobody is on the table yet.</EmptyState>
        ) : (
          <div className="card mx-6 mb-6 overflow-x-auto md:mx-8">
            <table className="w-full min-w-[1100px] border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[11.5px] text-faint">
                  {['name', 'lane', 'status', 'hard constraints', 'sent', 'signed', 'countersigned', 'knowledge capture', 'agreement'].map((h) => (
                    <th key={h} className="border-b border-line px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const best = ordered(copiesOf(r.id))[0];
                  return (
                    <tr
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${r.name}`}
                      className="cursor-pointer hover:bg-page"
                      onClick={() => setOpen(r.id)}
                      onKeyDown={(e) => e.key === 'Enter' && setOpen(r.id)}
                    >
                      <td className="td card-title">{r.name}</td>
                      <td className="td text-dim">{r.lane ?? '—'}</td>
                      <td className="td">{tone(r.plan_status)}</td>
                      <td className="td td-clip text-dim" style={{ maxWidth: '34ch' }}>{r.hard_constraints ?? '—'}</td>
                      <td className="td tabular text-dim">{r.agreement_sent ?? '—'}</td>
                      <td className="td tabular text-dim">{r.signed ?? '—'}</td>
                      <td className="td tabular text-dim">{r.countersigned ?? '—'}</td>
                      <td className="td td-clip text-dim" style={{ maxWidth: '34ch' }}>{r.knowledge_capture ?? '—'}</td>
                      <td className="td text-dim">{best ? best.status : held.data ? 'none held' : '…'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open && createPortal(
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={() => setOpen(null)}>
          <div className="card fade-up w-full max-w-[960px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={open.name}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[18px] leading-tight">
                <EditableCell value={open.name} onSave={(v) => save(open.id, 'name', v)} onError={fail} />
              </h2>
              <button type="button" aria-label="Close" className="text-[13px] text-dim hover:text-ink" onClick={() => setOpen(null)}>Close</button>
            </div>
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.field} className={f.wide ? 'sm:col-span-2' : ''}>
                  <dt className="text-[11.5px] text-faint">{f.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap text-ink">
                    <EditableCell
                      value={(open as unknown as Record<string, unknown>)[f.field]}
                      type={f.type}
                      options={f.options}
                      width={f.wide ? '100%' : undefined}
                      onSave={(v) => save(open.id, f.field, v)}
                      onError={fail}
                      render={f.field === 'plan_status' ? (v) => tone(String(v)) : f.wide ? (v) => <span className="whitespace-pre-wrap">{v ? String(v) : '—'}</span> : undefined}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <AgreementPanel
              person={{ id: open.id, name: open.name }}
              rows={copiesOf(open.id)}
              keyConfigured={held.data?.key_configured ?? true}
              onSaved={() => setNonce((n) => n + 1)}
              onDone={(text) => setToast({ text, tone: 'ok' })}
              onFail={fail}
            />
          </div>
        </div>,
        document.body,
      )}
      <Toast toast={toast} />
    </div>
  );
}
