import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getCodexDetail, getCodexEntries, getRecordMetrics, resync, setRecordStatus, type CodexEntry, type CodexEntryDetail, type CodexMetrics, type CodexTab } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  Bars,
  ComingSoon,
  CountCell,
  CountUp,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  MetricCell,
  Pagination,
  PageHeader,
  Pill,
  RecordId,
  RecordTable,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SourceLink,
  StatCell,
  StatStrip,
  SyncLine,
  Toast,
  usePaged,
  useToast,
} from '../components/ui';

/**
 * Codex entries, read from BHA Submissions & Logs — one table per builder.
 *
 * The finished Codex entry is the Orchestrator Layer2 Review field. It already
 * exists in Airtable for most rows and was not being shown anywhere; it is now
 * the substance of every row and of the entry view.
 *
 * Two independent axes decide the tabs, and the page says so rather than
 * implying a single pipeline:
 *   Jason Status   Approved / Pending — the review decision
 *   Layer 0        flagged / clean — the completeness gate, which runs first
 * A row can be Approved and still carry a Layer 0 flag. Both are shown on it.
 */

const TABS: { value: CodexTab; label: string }[] = [
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Pending approval' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'complete', label: 'Complete' },
];

/**
 * The tab rules, exactly as the server computes them. They live here as well
 * so the list and the tab counts cannot drift apart; the wording of each rule
 * comes from the server and is printed under the tabs.
 */
function inTab(e: CodexEntry, tab: CodexTab): boolean {
  switch (tab) {
    case 'approved':
      return e.approval === 'approved';
    case 'pending':
      return e.approval === 'pending' || e.approval === 'unset';
    case 'incomplete':
      return e.layer0_flagged;
    case 'complete':
      return e.complete;
  }
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

function matches(e: CodexEntry, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [e.codex_entry_id, e.submission_id, e.session_type, e.jason_status, e.narration_quality, e.entry_excerpt, e.week, e.session_url, ...e.layer0_missing].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

function ApprovalPill({ entry }: { entry: CodexEntry }) {
  if (entry.approval === 'approved') return <Pill tone="ok">approved</Pill>;
  if (entry.approval === 'input added') return <Pill tone="accent">input added</Pill>;
  if (entry.approval === 'pending') return <Pill>pending</Pill>;
  return <Pill>no status</Pill>;
}

/* ---------------------------------------------------------------- metrics */

function CodexMetricsPanel({ metrics, loading, error, view }: { metrics: CodexMetrics | null; loading: boolean; error: string | null; view: string }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={5} className="opacity-60">
        {['Submissions', 'Entry written', 'Approved', 'Layer 0 flagged', 'Median days to approval'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const tab = (t: CodexTab) => m.tabs.find((x) => x.tab === t)?.n ?? 0;
  const maxWeek = Math.max(1, ...m.per_builder_per_week.flatMap((b) => b.weeks.map((w) => w.n)));
  const maxApproval = Math.max(1, ...m.approval_mix.map((a) => a.n));
  const maxMissing = Math.max(1, ...m.missing_mix.map((x) => x.n));
  const weekAxis = m.per_builder_per_week[0]?.weeks ?? [];

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={5}>
        <CountCell label="Submissions" value={m.entries} replayKey={view} hint={m.scope.builder ? 'In this builder’s table' : `Across ${m.per_builder_per_week.length} builder tables`} />
        <CountCell label="Entry written" value={m.with_entry.n} tone="accent" replayKey={view} hint="Orchestrator Layer2 Review is filled" />
        <CountCell label="Approved" value={tab('approved')} replayKey={view} hint="Jason Status = Approved" />
        <CountCell label="Layer 0 flagged" value={m.layer0.flagged} tone={m.layer0.flagged ? 'degraded' : 'dim'} replayKey={view} hint="the gate found something missing" />
        <MetricCell label="Median days to approval" metric={m.median_days_to_approval} suffix="d" replayKey={view} />
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Review status" note={m.approval_note}>
          {m.approval_mix.length === 0 ? (
            <EmptyPanel>No submission carries a Jason Status yet.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.approval_mix.map((a) => (
                <HBar
                  key={a.approval}
                  label={a.label}
                  value={a.n}
                  max={maxApproval}
                  tone={a.approval === 'approved' ? 'accent' : 'ink'}
                  replayKey={view}
                  valueNode={<CountUp value={a.n} replayKey={view} />}
                  right={<span className="text-faint">{m.entries ? Math.round((a.n / m.entries) * 100) : 0}%</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Layer 0 completeness" right={`${m.layer0.clean}/${m.entries} clean`} note={`${m.layer0.definition} ${m.holds.note}`}>
          {m.layer0.flagged === 0 && m.holds.open === 0 ? (
            <EmptyPanel>Nothing is flagged and nothing is waiting at the gate. Every submission read here passed Layer 0 clean.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              <HBar label="Flagged incomplete" value={m.layer0.flagged} max={Math.max(1, m.entries)} tone="degraded" replayKey={view} valueNode={<CountUp value={m.layer0.flagged} replayKey={view} />} right={<span className="text-faint">of {m.entries}</span>} />
              {m.missing_mix.map((x) => (
                <HBar key={x.element} label={x.element} value={x.n} max={maxMissing} replayKey={view} valueNode={<CountUp value={x.n} replayKey={view} />} />
              ))}
              {m.holds.open > 0 && (
                <div className="pt-1 text-[12px] text-dim">
                  <span className="font-display tabular text-[16px] text-degraded">
                    <CountUp value={m.holds.open} replayKey={view} />
                  </span>{' '}
                  waiting at the gate, with no row in a builder table yet.
                </div>
              )}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Narration quality" note={m.narration_quality_note}>
          {m.narration_quality_mix.length === 0 ? (
            <EmptyPanel>No submission carries a narration quality.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.narration_quality_mix.map((qq) => (
                <HBar
                  key={qq.quality}
                  label={qq.quality}
                  value={qq.n}
                  max={Math.max(1, ...m.narration_quality_mix.map((x) => x.n))}
                  replayKey={view}
                  valueNode={<CountUp value={qq.n} replayKey={view} />}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 md:mx-8">
        <MetricCard
          title="Entries per builder per week"
          right="last eight weeks"
          note="By the week of each submission’s timestamp. The builder is the table the row lives in, so every submission is attributed."
        >
          {m.per_builder_per_week.length === 0 ? (
            <EmptyPanel>No submission has been read from any builder table.</EmptyPanel>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[420px] text-[11.5px]">
                <thead>
                  <tr className="text-faint">
                    <th className="pb-1 text-left font-medium">builder</th>
                    {/* The week start alone. Full ranges crowded the axis to the point of being unreadable. */}
                    {weekAxis.map((w) => (
                      <th key={w.week} className="whitespace-nowrap pb-1 text-right font-medium" title={w.label}>
                        {w.short}
                      </th>
                    ))}
                    <th className="pb-1 text-right font-medium">all</th>
                  </tr>
                </thead>
                <tbody>
                  {m.per_builder_per_week.map((b) => {
                    const total = b.weeks.reduce((n, w) => n + w.n, 0);
                    return (
                      <tr key={b.owner} className="border-t border-line">
                        <td className="py-1 text-dim capitalize">{b.owner}</td>
                        {b.weeks.map((w) => (
                          <td key={w.week} className="tabular py-1 text-right" title={`${w.label}: ${w.n}`}>
                            <span className={w.n === 0 ? 'text-faint' : 'text-ink'} style={{ opacity: w.n === 0 ? 0.5 : 0.55 + (0.45 * w.n) / maxWeek }}>
                              {w.n}
                            </span>
                          </td>
                        ))}
                        <td className="tabular py-1 text-right text-dim">{total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-2">
                <Bars
                  values={weekAxis.map((w) => m.per_builder_per_week.reduce((n, b) => n + (b.weeks.find((x) => x.week === w.week)?.n ?? 0), 0))}
                  labels={weekAxis.map((w) => w.short)}
                  height={44}
                  tone="accent"
                  highlightLast={false}
                  replayKey={view}
                />
              </div>
            </div>
          )}
        </MetricCard>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- entry view */

/**
 * The entry itself. `Orchestrator Layer2 Review` is the completed Codex entry —
 * the thing this page exists to show — and it is rendered whole, with its own
 * headings kept as the orchestrator wrote them.
 */
function EntryText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        // A block whose first line is a short bare phrase is one of the entry's
        // own section headings; the rest of the block is its bullets.
        const head = lines[0].trim();
        const isHeading = lines.length > 1 && head.length < 60 && !head.startsWith('•') && !head.startsWith('-');
        const body = isHeading ? lines.slice(1) : lines;
        return (
          <div key={i}>
            {isHeading && <div className="mb-1 text-[12px] font-medium tracking-wide text-faint uppercase">{head}</div>}
            <div className="space-y-1">
              {body.map((line, j) => {
                const t = line.trim();
                if (!t) return null;
                const bullet = t.startsWith('•') || t.startsWith('-');
                return (
                  <p key={j} className={`text-[13px] leading-relaxed text-ink ${bullet ? 'pl-4 -indent-4' : ''}`}>
                    {t}
                  </p>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EntryView({ id, onClose, onSaved, setToast, writable }: { id: string; onClose: () => void; onSaved: (e: CodexEntry) => void; setToast: (t: { text: string; tone: 'ok' | 'failing' }) => void; writable: boolean }) {
  const [detail, setDetail] = useState<CodexEntryDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getCodexDetail(id)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : 'Could not load the entry.'));
    return () => {
      live = false;
    };
  }, [id]);

  async function review(status: string) {
    setBusy(true);
    try {
      const updated = await setRecordStatus('codex', id, status);
      onSaved(updated);
      setDetail((d) => (d ? { ...d, ...updated } : d));
      setToast({ text: `Jason Status set to ${status} in Airtable.`, tone: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Codex entry">
        {err ? (
          <div className="text-[13px] text-failing">{err}</div>
        ) : !detail ? (
          <div className="text-[13px] text-faint">Loading the entry…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="kicker tabular truncate">{detail.codex_entry_id ?? detail.submission_id ?? detail.id}</div>
                <h2 className="mt-1 text-[18px] leading-tight capitalize">
                  {detail.builder_id} · <span className="normal-case">{detail.session_type ?? 'session type not stated'}</span>
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                  <span className="tabular">{when(detail.logged_at)}</span>
                  {detail.week && <span className="tabular">{detail.week}</span>}
                  <ApprovalPill entry={detail} />
                  {detail.layer0_flagged ? (
                    <Pill tone="degraded">Layer 0: missing {detail.layer0_missing.length ? detail.layer0_missing.join(', ') : 'something the gate did not name'}</Pill>
                  ) : detail.complete ? (
                    <Pill tone="ok">complete</Pill>
                  ) : (
                    <Pill>no entry written</Pill>
                  )}
                  {detail.narration_quality && <span>narration {detail.narration_quality.toLowerCase()}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {writable && detail.approval !== 'approved' && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => review('approved')}>
                    {busy ? 'Writing…' : 'Approve'}
                  </button>
                )}
                {writable && detail.approval === 'approved' && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => review('pending')}>
                    Back to pending
                  </button>
                )}
                <a href={detail.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                  Open in Airtable
                </a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-x-6 gap-y-2 border-t border-line pt-4 text-[12.5px] md:grid-cols-3">
              <div className="min-w-0 md:col-span-2">
                <div className="text-[11px] text-faint">narration (session url)</div>
                {detail.session_url ? (
                  <a href={detail.session_url} target="_blank" rel="noreferrer" className="block truncate text-accent-ink hover:underline" title={detail.session_url}>
                    {detail.session_url}
                  </a>
                ) : (
                  <span className="text-degraded">not linked</span>
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-faint">submission id</div>
                <div className="tabular truncate text-ink">{detail.submission_id ?? <span className="text-faint">—</span>}</div>
              </div>
              {detail.jason_notes && (
                <div className="min-w-0 md:col-span-3">
                  <div className="text-[11px] text-faint">Jason’s notes</div>
                  <div className="text-ink">{detail.jason_notes}</div>
                </div>
              )}
            </div>

            {detail.session_description && (
              <div className="mt-4">
                <div className="mb-1 text-[11px] text-faint">Session description</div>
                <p className="text-[13px] leading-relaxed text-dim">{detail.session_description}</p>
              </div>
            )}

            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <div className="text-[13px] font-medium text-ink">Codex entry</div>
                <div className="text-[11px] text-faint">Orchestrator Layer2 Review</div>
              </div>
              {detail.entry ? (
                <EntryText text={detail.entry} />
              ) : (
                <p className="text-[12.5px] leading-relaxed text-dim">
                  The orchestrator has not written an entry for this submission. The row exists — the log was submitted — but Orchestrator Layer2 Review is empty, so there is no Codex entry to
                  show. {detail.layer0_flagged ? 'Layer 0 flagged it as incomplete, which is why it never reached Layer 2.' : ''}
                </p>
              )}
            </div>

            {detail.layer1_review && (
              <details className="mt-5 border-t border-line pt-4">
                <summary className="cursor-pointer text-[12.5px] text-dim">Layer 1 review</summary>
                <p className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">{detail.layer1_review}</p>
              </details>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The list, as columns. Date, builder and the Codex id read first; the
 * breakthroughs are the substance of the entry and take the wide column;
 * flags carry the review decision and the Layer 0 state, which are two axes
 * and both shown.
 */
function codexColumns(open: (e: CodexEntry) => void): RecordColumn<CodexEntry>[] {
  return [
    { key: 'date', header: 'date', className: 'tabular text-faint', cell: (e) => when(e.logged_at) },
    { key: 'builder', header: 'builder', card: 'meta', className: 'card-meta capitalize text-dim', cell: (e) => e.builder_id },
    {
      key: 'codex_id',
      header: 'codex id',
      width: '22ch',
      clip: true,
      title: (e) => e.codex_entry_id ?? e.submission_id ?? e.id,
      cell: (e) => <RecordId missing="no codex id">{e.codex_entry_id ?? e.submission_id}</RecordId>,
    },
    {
      key: 'session_type',
      header: 'session type',
      width: '20ch',
      clip: true,
      className: 'text-dim',
      title: (e) => e.session_type ?? undefined,
      cell: (e) => e.session_type ?? <span className="text-faint">not stated</span>,
    },
    {
      key: 'breakthroughs',
      header: 'breakthroughs',
      card: 'title',
      width: '54ch',
      clip: true,
      title: (e) => e.breakthroughs ?? undefined,
      cell: (e) => e.breakthroughs ?? <span className="text-faint">No Codex entry written — Orchestrator Layer2 Review is empty.</span>,
    },
    {
      key: 'flags',
      header: 'flags',
      card: 'meta',
      className: 'card-meta',
      title: (e) => (e.layer0_flagged && e.layer0_missing.length ? `Layer 0 found no ${e.layer0_missing.join(', ')}` : undefined),
      cell: (e) => (
        <span className="inline-flex items-center gap-1">
          <ApprovalPill entry={e} />
          {e.layer0_flagged && <Pill tone="degraded">layer 0</Pill>}
          {e.complete && <Pill tone="ok">complete</Pill>}
        </span>
      ),
    },
    { key: 'quality', header: 'quality', className: 'text-faint', cell: (e) => e.narration_quality?.toLowerCase() ?? '—' },
    { key: 'source', header: 'source', cell: (e) => <SourceLink source={e.source} /> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (e) => (
        <RowActions>
          <RowAction label="Read entry" tone="accent" onClick={() => open(e)} />
          <RowAction label="Open in Airtable" onClick={() => window.open(e.airtable.url, '_blank', 'noreferrer')} />
        </RowActions>
      ),
    },
  ];
}

/* ------------------------------------------------------------------ page */

export default function Codex() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getCodexEntries, [reload]);
  const [entries, setEntries] = useState<CodexEntry[]>([]);
  const [builder, setBuilder] = useState('all');
  const [tab, setTab] = useState<CodexTab>('approved');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('codex', query, builder), [builder, tick, reload]);

  useEffect(() => {
    if (loaded) setEntries(loaded.entries);
  }, [loaded]);

  const scoped = useMemo(() => entries.filter((e) => builder === 'all' || e.builder_id === builder), [entries, builder]);
  const rows = useMemo(() => scoped.filter((e) => inTab(e, tab)).filter((e) => matches(e, q.trim())), [scoped, tab, q]);
  const paged = usePaged(rows, `${builder}|${tab}|${q.trim()}`);

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('codex');
      const t = r.results[0]?.tables ?? [];
      const n = t.reduce((s2, x) => s2 + x.n, 0);
      const failed = t.filter((x) => x.error);
      setToast(
        failed.length
          ? { text: `Resync read ${n} submissions but ${failed.map((x) => x.label).join(', ')} failed: ${failed[0].error}`, tone: 'failing' }
          : { text: `Resync read ${n} submissions across ${t.length} builder tables.`, tone: 'ok' },
      );
      setReload((v) => v + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const m = metrics.data;
  const writable = loaded.sync.write_through;
  const rule = m?.tabs.find((t) => t.tab === tab)?.rule;
  const holds = loaded.layer0_holds.filter((h) => (builder === 'all' ? true : h.builder_id === builder) && h.open);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Codex entries" subtitle="Every session BHA has logged, as the orchestrator wrote it up" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <CodexMetricsPanel metrics={m} loading={metrics.status === 'loading'} error={metrics.error} view={builder} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          {/* One tab per submissions table. There is no Jason tab — he reviews
              logs rather than submitting them — and no "no builder" tab, since
              the table a row lives in is its builder. */}
          <Segmented
            ariaLabel="Filter by builder"
            value={builder}
            onChange={setBuilder}
            options={[{ value: 'all', label: 'Everyone', count: entries.length }, ...loaded.builders.map((b) => ({ value: b.id, label: b.label, count: b.n }))]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<CodexTab> ariaLabel="Tab" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.value, label: t.label, count: scoped.filter((e) => inTab(e, t.value)).length }))} />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search entries" />
            </div>
          </div>
          {rule && <p className="text-[11.5px] leading-snug text-faint">{rule}</p>}
          {tab === 'incomplete' && holds.length > 0 && (
            <p className="text-[11.5px] leading-snug text-faint">
              {holds.length} further {holds.length === 1 ? 'submission is' : 'submissions are'} parked at the Layer 0 gate with no row in a builder table yet
              {holds.some((h) => h.missing.length) ? `, waiting on ${[...new Set(holds.flatMap((h) => h.missing))].join(', ')}` : ''}. They appear here once the builder resubmits.
            </p>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {loaded.sync.source === 'none'
              ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.')
              : q.trim()
                ? 'No submission matches that search in the selected builder and tab.'
                : tab === 'incomplete'
                  ? `No submission is flagged by Layer 0${builder === 'all' ? '' : ' in this builder’s table'}. ${holds.length ? `${holds.length} ${holds.length === 1 ? 'is' : 'are'} still parked at the gate and has no row here yet.` : 'Every submission read passed the completeness gate clean.'}`
                  : tab === 'complete'
                    ? 'No submission is both clean at Layer 0 and carries a written Codex entry in this selection.'
                    : `No submission is ${tab === 'approved' ? 'approved' : 'awaiting approval'} in this selection.`}
          </EmptyState>
        ) : (
          <>
            <RecordTable columns={codexColumns((e) => setOpen(e.id))} rows={paged.rows} rowKey={(e) => e.id} onOpen={(e) => setOpen(e.id)} label="Codex entries" />
            <Pagination paged={paged} unit="submissions" />
          </>
        )}

        <div className="shrink-0 px-6 pb-6 md:px-8">
          <ComingSoon title="Pay eligibility and verdicts" min={120}>
            The submission tables record the review decision and the narration quality, but not a pay decision or an alignment verdict. Until a field exists for them, this page does not show one.
          </ComingSoon>
        </div>
      </div>

      {open && (
        <EntryView
          id={open}
          writable={writable}
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
