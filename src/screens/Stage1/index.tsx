import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../../app/useData';
import { createRegistryRow, getRegistry, updateRegistryRow, type RegistryData } from '../../data';
import { EmptyState, LoadFailed, Loading, MetricCard, PageHeader, Toast, relativeTime, useToast } from '../../components/ui';
import { EditableCell, NewRow } from '../Registry/Editable';
import { Agreements } from './Agreements';

/**
 * Stage 1 status (5 Nov 2026, Destiny; Jason, DM 1793820617.412249: "one clear table" of who is in under the
 * comp plan, so he can plan Stage 1 revenue and further offers without guessing).
 *
 * The rows are registry kind `stage1`: this dashboard is their record, edited here or through write_registry.
 * Behind the admin login from 5 Nov 2026. The table holds where each person stands and never a pay figure or
 * contract text; the agreements themselves sit under it, encrypted, and DocuSign stays the record of what was signed. The signed dates are typed from DocuSign's
 * own read-back: nothing here reads DocuSign, so the page says when a row was last changed.
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

export default function Stage1() {
  const { status, data: loaded, error } = useData(() => getRegistry(false), [], { kinds: ['registry'] });
  const [d, setD] = useState<RegistryData | null>(null);
  useEffect(() => {
    if (loaded) setD(loaded);
  }, [loaded]);
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

  const edit = (r: RegistryData['stage1'][number], field: string, opts: { type?: 'date' | 'longtext' | 'select'; options?: readonly string[]; width?: string } = {}) => (
    <EditableCell
      value={(r as unknown as Record<string, unknown>)[field]}
      type={opts.type}
      options={opts.options}
      width={opts.width}
      onSave={(v) => save(r.id, field, v)}
      onError={fail}
      render={field === 'plan_status' ? (v) => <span className={TONE[String(v)] ?? 'text-dim'}>{String(v)}</span> : undefined}
    />
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Stage 1 status" subtitle="Where each person stands under the comp plan" />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 max-w-[104ch] px-6 pb-3 text-[11.5px] leading-snug text-faint md:px-8">
          No pay figures and no contract text here: those stay in DocuSign. Signed dates are entered from DocuSign{newest ? `; last changed ${relativeTime(newest) ?? newest.slice(0, 10)}` : ''}. <Link to={KNOWLEDGE_STANDARD} className="text-accent">Knowledge capture standard</Link>.
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
            <table className="w-full min-w-[1320px] border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[11.5px] text-faint">
                  {['name', 'lane', 'status', 'hard constraints', 'sent', 'signed', 'countersigned', 'knowledge capture', 'notes'].map((h) => (
                    <th key={h} className="border-b border-line px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="td card-title">{edit(r, 'name')}</td>
                    <td className="td text-dim">{edit(r, 'lane')}</td>
                    <td className="td">{edit(r, 'plan_status', { type: 'select', options: PLAN_STATUS })}</td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '34ch' }}>{edit(r, 'hard_constraints', { type: 'longtext', width: '34ch' })}</td>
                    <td className="td tabular text-dim">{edit(r, 'agreement_sent', { type: 'date' })}</td>
                    <td className="td tabular text-dim">{edit(r, 'signed', { type: 'date' })}</td>
                    <td className="td tabular text-dim">{edit(r, 'countersigned', { type: 'date' })}</td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '34ch' }}>{edit(r, 'knowledge_capture', { type: 'longtext', width: '34ch' })}</td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '34ch' }}>{edit(r, 'notes', { type: 'longtext', width: '34ch' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Agreements people={rows.map((r) => ({ id: r.id, name: r.name }))} onDone={(text) => setToast({ text, tone: 'ok' })} onFail={fail} />
      <Toast toast={toast} />
    </div>
  );
}
