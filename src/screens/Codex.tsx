import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getCodexEntries, getRecordMetrics, resync, updateRecordFields, type CodexData, type CodexEntry, type CodexLayer, type CodexMetrics } from '../data';
import {
  Band,
  BuilderFilter,
  CountCell,
  CountUp,
  EmptyState,
  LoadFailed,
  Loading,
  MetricCell,
  PageHeader,
  Pill,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SourceLink,
  StatCell,
  StatStrip,
  SyncLine,
  TableFrame,
  TagRow,
  Th,
  Toast,
  useToast,
} from '../components/ui';

/**
 * The Codex Log, structured around its three evaluation layers:
 *   Layer 0  completeness — this dashboard's own check on the row's fields
 *   Layer 1  pending approval — action_required = JASON_SPOTCHECK, the
 *            nearest thing the log records; it is a spot-check request
 *   Layer 2  approved — cannot be filled: the log records no approval
 * Nothing here infers an approval. Where the data cannot distinguish a
 * state, the page says so instead of filling the shape.
 */

type Section = CodexLayer | 'all';
const SECTIONS: { value: Section; label: string }[] = [
  { value: 'pending', label: 'Pending approval' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'complete', label: 'Complete' },
  { value: 'approved', label: 'Approved' },
  { value: 'all', label: 'All' },
];

function isPending(e: CodexEntry): boolean {
  return (e.action_required ?? '').trim().toUpperCase().replace(/\.$/, '') === 'JASON_SPOTCHECK';
}
function inSection(e: CodexEntry, s: Section): boolean {
  if (s === 'all') return true;
  if (s === 'pending') return isPending(e);
  if (s === 'complete') return e.complete;
  if (s === 'incomplete') return !e.complete;
  return false; // 'approved' — the log cannot say
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}
function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
}
function matches(e: CodexEntry, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [e.session_type, e.lane_id, e.card_id, e.pillar_tag, e.verdict, e.action_required, e.builder_name, e.architecture_fit, e.engine_movement, e.needle_moved_evidence, e.red_flags, e.week, e.session_url].some((v) => v && v.toLowerCase().includes(n));
}

/* ---------------------------------------------------------------- metrics */

function CodexMetricsPanel({ metrics, loading, error }: { metrics: CodexMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={6} className="opacity-60">
        {['Entries', 'Pending approval', 'Complete', 'Evaluated', 'Pay eligible', 'Median days to approval'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const tones: ('accent' | 'ink' | 'dim')[] = ['accent', 'ink', 'dim'];
  const maxWeek = Math.max(1, ...m.per_builder_per_week.flatMap((b) => b.weeks.map((w) => w.n)));
  const key = m.scope.builder ?? 'all';
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={6}>
        <CountCell label="Entries" value={m.entries} replayKey={key} hint={m.unattributed ? `${m.unattributed} with no builder recorded` : undefined} />
        <CountCell label="Pending approval" value={m.pending.n} replayKey={key} hint="action_required = JASON_SPOTCHECK" />
        <MetricCell label="Complete" metric={{ value: m.layer0.rate, note: m.layer0.note }} suffix="%" replayKey={key} />
        <CountCell label="Evaluated" value={m.evaluated.n} replayKey={key} hint="has a verdict — not the same as approved" />
        <MetricCell label="Pay eligible" metric={m.pay_eligible_rate} suffix="%" replayKey={key} />
        <MetricCell label="Median days to approval" metric={m.median_days_to_approval} suffix="d" replayKey={key} />
      </StatStrip>

      <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Verdict mix</div>
          {m.verdict_mix.length === 0 ? (
            <div className="text-[12px] text-faint">No verdicts recorded.</div>
          ) : (
            <>
              <Band parts={m.verdict_mix.map((v, i) => ({ value: v.n, tone: tones[i % tones.length], label: v.verdict }))} height={8} />
              <div className="mt-2 space-y-0.5 text-[12px]">
                {m.verdict_mix.map((v) => (
                  <div key={v.verdict} className="flex justify-between gap-3">
                    <span className="truncate text-dim">{v.verdict}</span>
                    <span className="tabular text-ink">
                      <CountUp value={v.n} replayKey={key} /> <span className="text-faint">· {m.entries ? Math.round((v.n / m.entries) * 100) : 0}%</span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-2 text-[11.5px] leading-snug text-faint">{m.verdict_note}</div>
        </div>

        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Narration quality</div>
          {m.narration_quality_mix.length === 0 ? (
            <div className="text-[12px] text-faint">No narration quality recorded.</div>
          ) : (
            <>
              <Band parts={m.narration_quality_mix.map((v, i) => ({ value: v.n, tone: tones[i % tones.length], label: v.quality }))} height={8} />
              <div className="mt-2 space-y-0.5 text-[12px]">
                {m.narration_quality_mix.map((v) => (
                  <div key={v.quality} className="flex justify-between gap-3">
                    <span className="truncate text-dim">{v.quality}</span>
                    <span className="tabular text-ink">
                      <CountUp value={v.n} replayKey={key} />
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-2 text-[11.5px] leading-snug text-faint">From the narration_quality field, on the {m.evaluated.n} evaluated entries.</div>
        </div>

        <div className="card px-5 py-4">
          <div className="mb-2 text-[13px] font-medium text-ink">Entries per builder per week</div>
          {m.per_builder_per_week.length === 0 ? (
            <div className="text-[12px] text-faint">No entry names a builder.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="text-faint">
                    <th className="pb-1 text-left font-medium">builder</th>
                    {m.per_builder_per_week[0].weeks.map((w) => (
                      <th key={w.week} className="whitespace-nowrap pb-1 text-right font-medium" title={w.week}>
                        {w.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.per_builder_per_week.map((b) => (
                    <tr key={b.owner} className="border-t border-line">
                      <td className="py-1 text-dim">{BUILDER_NAMES[b.owner] ?? b.owner}</td>
                      {b.weeks.map((w) => (
                        <td key={w.week} className="tabular py-1 text-right">
                          <span className={w.n === 0 ? 'text-faint' : 'text-ink'} style={{ opacity: w.n === 0 ? 0.5 : 0.55 + (0.45 * w.n) / maxWeek }}>
                            {w.n}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 text-[11.5px] leading-snug text-faint">By the week of each entry’s timestamp, last eight weeks. {m.unattributed ? m.unattributed_note : ''}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- entry view */

const LONG: { key: keyof CodexEntry; label: string }[] = [
  { key: 'architecture_fit', label: 'Architecture fit' },
  { key: 'engine_movement', label: 'Engine movement' },
  { key: 'needle_moved_evidence', label: 'Needle moved — evidence' },
  { key: 'red_flags', label: 'Red flags' },
];
const SHORT: { key: keyof CodexEntry; label: string }[] = [
  { key: 'card_id', label: 'card_id' },
  { key: 'lane_id', label: 'lane_id' },
  { key: 'pillar_tag', label: 'pillar_tag' },
  { key: 'action_required', label: 'action_required' },
  { key: 'flag_name', label: 'flag_name' },
  { key: 'flag_repeat_count', label: 'flag_repeat_count' },
];

type Draft = Record<string, string | boolean>;

/** The full entry, read or edited. Editing writes to Airtable first; the log is a record, so there is no delete. */
function EntryView({ entry, choices, onClose, onSaved, setToast }: { entry: CodexEntry; choices: CodexData['choices']; onClose: () => void; onSaved: (e: CodexEntry) => void; setToast: (t: { text: string; tone: 'ok' | 'failing' }) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>({});

  function start() {
    setDraft({
      session_type: entry.session_type ?? '',
      session_url: entry.session_url ?? '',
      verdict: entry.verdict ?? '',
      narration_quality: entry.narration_quality ?? '',
      pay_eligible: entry.pay_eligible,
      action_required: entry.action_required ?? '',
      card_id: entry.card_id ?? '',
      lane_id: entry.lane_id ?? '',
      pillar_tag: entry.pillar_tag ?? '',
      architecture_fit: entry.architecture_fit ?? '',
      engine_movement: entry.engine_movement ?? '',
      needle_moved_evidence: entry.needle_moved_evidence ?? '',
      red_flags: entry.red_flags ?? '',
    });
    setEditing(true);
  }

  async function save() {
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      const before = (entry as unknown as Record<string, unknown>)[k];
      const norm = typeof v === 'string' ? v.trim() || null : v;
      if (norm !== (before ?? null)) changed[k] = norm;
    }
    if (!Object.keys(changed).length) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await updateRecordFields('codex', entry.id, changed);
      onSaved(updated);
      setEditing(false);
      setToast({ text: `Saved ${Object.keys(changed).length} ${Object.keys(changed).length === 1 ? 'field' : 'fields'} to the Codex Log in Airtable.`, tone: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The edit did not save.', tone: 'failing' });
    } finally {
      setBusy(false);
    }
  }

  const field = (k: string) => (typeof draft[k] === 'string' ? (draft[k] as string) : '');
  const select = (k: string, options: string[]) => (
    <select value={field(k)} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} className="input mt-1">
      <option value="">—</option>
      {[...new Set([...options, field(k)].filter(Boolean))].map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Codex entry">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker">Codex entry</div>
            <h2 className="mt-1 text-[18px] leading-tight">
              {entry.builder_id ? (BUILDER_NAMES[entry.builder_id] ?? entry.builder_id) : 'No builder recorded'} · {entry.session_type ?? 'session type not stated'}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="tabular">{when(entry.logged_at)}</span>
              {entry.week && <span className="tabular">{entry.week}</span>}
              {entry.verdict && <span>{entry.verdict}</span>}
              {entry.narration_quality && <span>narration {entry.narration_quality.toLowerCase()}</span>}
              <TagRow tags={entry.tags} />
              {isPending(entry) && <Pill tone="degraded">pending approval</Pill>}
              {entry.complete ? <Pill tone="ok">complete</Pill> : <Pill>incomplete · missing {entry.missing.join(', ')}</Pill>}
            </div>
            {!entry.builder_id && entry.builder_name && <div className="mt-1 text-[11.5px] text-faint">builder_name in the source reads “{entry.builder_name}”, which is not one of the builders.</div>}
          </div>
          <div className="flex items-center gap-2">
            {!editing && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={start}>
                Edit
              </button>
            )}
            <a href={entry.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {editing ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block text-[11.5px] text-faint">
                session_type
                {select('session_type', choices.session_type)}
              </label>
              <label className="block text-[11.5px] text-faint">
                verdict
                {select('verdict', choices.verdict)}
              </label>
              <label className="block text-[11.5px] text-faint">
                narration_quality
                {select('narration_quality', choices.narration_quality)}
              </label>
              <label className="block text-[11.5px] text-faint">
                pillar_tag
                {select('pillar_tag', choices.pillar_tag)}
              </label>
              <label className="block text-[11.5px] text-faint">
                action_required
                <input value={field('action_required')} onChange={(e) => setDraft((d) => ({ ...d, action_required: e.target.value }))} className="input mt-1" placeholder="JASON_SPOTCHECK, DESTINY_REVIEW, BUILDER_FOLLOWUP, or a sentence" />
              </label>
              <label className="flex items-center gap-2 pt-5 text-[12.5px] text-ink">
                <input type="checkbox" checked={Boolean(draft.pay_eligible)} onChange={(e) => setDraft((d) => ({ ...d, pay_eligible: e.target.checked }))} />
                pay_eligible
              </label>
              <label className="block text-[11.5px] text-faint">
                card_id
                <input value={field('card_id')} onChange={(e) => setDraft((d) => ({ ...d, card_id: e.target.value }))} className="input mt-1" />
              </label>
              <label className="block text-[11.5px] text-faint">
                lane_id
                <input value={field('lane_id')} onChange={(e) => setDraft((d) => ({ ...d, lane_id: e.target.value }))} className="input mt-1" />
              </label>
              <label className="block text-[11.5px] text-faint">
                session_url
                <input value={field('session_url')} onChange={(e) => setDraft((d) => ({ ...d, session_url: e.target.value }))} className="input mt-1" />
              </label>
            </div>
            {LONG.map((f) => (
              <label key={f.key} className="block text-[11.5px] text-faint">
                {f.label}
                <textarea value={field(f.key)} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} rows={4} className="input mt-1 min-h-[88px] resize-y text-[12.5px] leading-relaxed" />
              </label>
            ))}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-faint">Saved to the Codex Log in Airtable first, then shown here from what came back. Entries are never deleted from here.</span>
              <div className="flex gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
                  {busy ? 'Writing to Airtable…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-x-6 gap-y-2 text-[12.5px] md:grid-cols-3">
              {SHORT.map((f) => (
                <div key={f.key} className="min-w-0">
                  <div className="text-[11px] text-faint">{f.label}</div>
                  <div className="truncate text-ink" title={String(entry[f.key] ?? '')}>
                    {entry[f.key] === null || entry[f.key] === undefined || entry[f.key] === '' ? <span className="text-faint">—</span> : String(entry[f.key])}
                  </div>
                </div>
              ))}
              <div className="min-w-0 md:col-span-2">
                <div className="text-[11px] text-faint">narration (session_url)</div>
                {entry.session_url ? (
                  <a href={entry.session_url} target="_blank" rel="noreferrer" className="block truncate text-accent-ink hover:underline" title={entry.session_url}>
                    {entry.session_url}
                  </a>
                ) : (
                  <span className="text-degraded">not linked</span>
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-faint">builder_id (Slack)</div>
                <div className="tabular truncate text-ink">{entry.builder_slack_id ?? <span className="text-faint">—</span>}</div>
              </div>
            </div>
            {LONG.map((f) => (
              <div key={f.key}>
                <div className="mb-1 text-[11px] text-faint">{f.label}</div>
                {entry[f.key] ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{String(entry[f.key])}</p>
                ) : (
                  <p className="text-[12.5px] text-faint">Not written on this entry.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

export default function Codex() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getCodexEntries, [reload]);
  const [entries, setEntries] = useState<CodexEntry[]>([]);
  const [builder, setBuilder] = useState('all');
  const [section, setSection] = useState<Section>('pending');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('codex', query, builder === 'none' ? null : builder), [builder, tick, reload]);

  useEffect(() => {
    if (loaded) setEntries(loaded.entries);
  }, [loaded]);

  const byBuilder = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) if (e.builder_id) c[e.builder_id] = (c[e.builder_id] ?? 0) + 1;
    return c;
  }, [entries]);
  const unattributed = entries.filter((e) => !e.builder_id).length;
  const scoped = useMemo(() => entries.filter((e) => (builder === 'all' ? true : builder === 'none' ? !e.builder_id : e.builder_id === builder)), [entries, builder]);
  const countFor = (s: Section) => (s === 'approved' ? undefined : scoped.filter((e) => inSection(e, s)).length);
  const rows = scoped.filter((e) => inSection(e, section)).filter((e) => matches(e, q.trim()));

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('codex');
      const t = r.results[0]?.tables[0];
      setToast(t?.error ? { text: `Resync failed: ${t.error}`, tone: 'failing' } : { text: `Resync read ${t?.n ?? 0} Codex entries.`, tone: 'ok' });
      setReload((n) => n + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? entries.find((e) => e.id === open) : null;
  const m = metrics.data;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Codex entries" subtitle="The Codex Log in three layers: complete on submission, pending approval, approved" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <CodexMetricsPanel metrics={m} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <BuilderFilter counts={byBuilder} value={builder} onChange={setBuilder} unattributed={unattributed} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Section> ariaLabel="Layer" value={section} onChange={setSection} options={SECTIONS.map((s) => ({ value: s.value, label: s.label, count: countFor(s.value) }))} />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search entries" />
              <span className="tabular whitespace-nowrap text-[11.5px] text-faint">{rows.length} shown</span>
            </div>
          </div>
          {/* What the layer means, from the data's point of view. */}
          {m && (
            <p className="text-[11.5px] leading-snug text-faint">
              {section === 'pending' && m.pending.note}
              {section === 'complete' && m.layer0.definition}
              {section === 'incomplete' && `${m.layer0.definition} These rows fail it; each says what it lacks.`}
              {section === 'approved' && m.approved.note}
              {section === 'all' && `${m.entries} rows in the Codex Log. ${m.unattributed ? m.unattributed_note : ''}`}
            </p>
          )}
        </div>

        {section === 'approved' ? (
          <EmptyState>
            {m?.approved.note ?? 'The Codex Log records no approval.'}{' '}
            What it can distinguish today: {m?.pending.n ?? 0} entries flagged for Jason’s spot-check, {m?.evaluated.n ?? 0} carrying a verdict, {m?.layer0.complete ?? 0} passing the completeness check. None of those is an approval.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>
            {loaded.sync.source === 'none'
              ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.')
              : section === 'pending' && !q
                ? 'No entry has action_required set to JASON_SPOTCHECK right now.'
                : 'No Codex entries match the selected builder, layer and search.'}
          </EmptyState>
        ) : (
          <TableFrame grow={false}>
            <thead>
              <tr>
                <Th>logged</Th>
                <Th>builder</Th>
                <Th>session type</Th>
                <Th>narration</Th>
                <Th>complete</Th>
                <Th>verdict</Th>
                <Th>quality</Th>
                <Th>tags</Th>
                <Th>action required</Th>
                <Th>lane</Th>
                <Th>source</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="cursor-pointer" onClick={() => setOpen(e.id)}>
                  <td className="td tabular whitespace-nowrap text-faint">{when(e.logged_at)}</td>
                  <td className="td card-meta td-clip" style={{ maxWidth: '14ch' }} title={e.builder_id ? '' : `No builder recorded in the source${e.builder_name ? ` (builder_name reads “${e.builder_name}”)` : ''}`}>
                    {e.builder_id ? <span className="text-dim">{BUILDER_NAMES[e.builder_id] ?? e.builder_id}</span> : <span className="text-degraded">none</span>}
                  </td>
                  <td className="td card-title td-clip" style={{ maxWidth: '26ch' }} title={e.session_type ?? ''}>
                    {e.session_type ?? <span className="text-faint">not stated</span>}
                  </td>
                  <td className="td td-clip" style={{ maxWidth: '24ch' }} title={e.session_url ?? ''}>
                    {e.session_url ? (
                      <a href={e.session_url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} className="text-faint hover:text-accent-ink">
                        {shortUrl(e.session_url)}
                      </a>
                    ) : (
                      <span className="text-degraded">not linked</span>
                    )}
                  </td>
                  <td className="td card-meta" title={e.complete ? 'Passes the completeness check' : `Missing ${e.missing.join(', ')}`}>
                    {e.complete ? <Pill tone="ok">complete</Pill> : <Pill>missing {e.missing.length}</Pill>}
                  </td>
                  <td className="td text-faint td-clip" style={{ maxWidth: '20ch' }} title={e.verdict ?? ''}>
                    {e.verdict ?? '—'}
                  </td>
                  <td className="td text-faint">{e.narration_quality?.toLowerCase() ?? '—'}</td>
                  <td className="td">
                    <TagRow tags={e.tags} />
                  </td>
                  <td className="td card-meta td-clip" style={{ maxWidth: '22ch' }} title={e.action_required ?? ''}>
                    {isPending(e) ? <Pill tone="degraded">pending approval</Pill> : e.action_required ? <span className="text-[11.5px] text-dim">{e.action_required}</span> : <span className="text-faint">—</span>}
                  </td>
                  <td className="td text-faint td-clip" style={{ maxWidth: '18ch' }} title={e.lane_id ?? ''}>
                    {e.lane_id ?? '—'}
                  </td>
                  <td className="td">
                    <SourceLink source={e.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      <RowAction label="View" tone="accent" onClick={() => setOpen(e.id)} />
                      <RowAction label="Open in Airtable" onClick={() => window.open(e.airtable.url, '_blank', 'noreferrer')} />
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </div>

      {current && (
        <EntryView
          entry={current}
          choices={loaded.choices}
          onClose={() => setOpen(null)}
          onSaved={(u) => {
            setEntries((list) => list.map((x) => (x.id === u.id ? u : x)));
            setTick((n) => n + 1);
          }}
          setToast={setToast}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}
