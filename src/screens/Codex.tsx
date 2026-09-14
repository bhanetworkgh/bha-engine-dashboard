import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { deleteCodexEntry, getCodexDetail, getCodexEntries, getRecordMetrics, setCodexStatus, type CodexEntry, type CodexEntryDetail, type CodexMetrics, type CodexTab } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  Bars,
  CountCell,
  CountUp,
  EmptyPanel,
  EmptyState,
  HBar,
  NotLanded,
  LoadFailed,
  Loading,
  MetricCard,
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
  RowsLine,
  Toast,
  unlanded,
  usePaged,
  useToast,
  writeWarning,
} from '../components/ui';

/**
 * Codex entries, read from BHA Submissions & Logs — one table per builder.
 *
 * The finished Codex entry is the Orchestrator Layer2 Review field. It already
 * exists in Airtable for most rows and was not being shown anywhere; it is now
 * the substance of every row and of the entry view.
 *
 * A log moves through three stages, one per layer, and is in exactly one:
 *
 *   Needs input        Layer 0  the gate found something missing
 *   Awaiting approval  Layer 1  codex generated, Jason has not approved
 *   Approved           Layer 2  through and approved
 *
 * Layer0 Flagged wins — a flagged log needs input whatever Jason Status says,
 * because the gate runs first. Otherwise Jason Status decides. The server
 * computes `stage` on the row and the page reads it, so the tabs and the list
 * cannot answer differently.
 */

const TABS: { value: CodexTab | 'all'; label: string }[] = [
  { value: 'needs_input', label: 'Needs input' },
  { value: 'awaiting', label: 'Awaiting approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'all', label: 'All' },
];

type Tab = CodexTab | 'all';

function inTab(e: CodexEntry, tab: Tab): boolean {
  return tab === 'all' || e.stage === tab;
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

/**
 * The stage, as one pill. Jason Status is shown beside it only where it adds
 * something the stage does not say: "input added" means he has asked a
 * question and the log is waiting on the builder, which is worth seeing while
 * it sits in Awaiting approval.
 */
function StagePill({ entry }: { entry: CodexEntry }) {
  if (entry.stage === 'approved') return <Pill tone="ok">approved</Pill>;
  if (entry.stage === 'needs_input') return <Pill tone="degraded">needs input</Pill>;
  return <Pill>awaiting approval</Pill>;
}


/* ---------------------------------------------------------------- metrics */

function CodexMetricsPanel({ metrics, loading, error, view }: { metrics: CodexMetrics | null; loading: boolean; error: string | null; view: string }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Submissions', 'Codex generated', 'Approved', 'Layer 0 flagged'].map((l) => (
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
  const maxStage = Math.max(1, ...m.tabs.map((t) => t.n));
  const maxMissing = Math.max(1, ...m.missing_mix.map((x) => x.n));
  const maxQuality = Math.max(1, ...m.narration_quality_mix.map((x) => x.n));
  const weekAxis = m.per_builder_per_week[0]?.weeks ?? [];

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={4}>
        <CountCell label="Submissions" value={m.entries} replayKey={view} hint={m.scope.builder ? 'In this builder’s table' : `Across ${m.per_builder_per_week.length} builder tables`} />
        {/* Layer 2 is the codex being generated, not a review of it. The
            footnote is the count that is missing one, which is the figure
            worth acting on. */}
        <CountCell label="Codex generated" value={m.with_entry.n} tone="accent" replayKey={view} hint={m.with_entry.note} />
        <CountCell label="Approved" value={tab('approved')} replayKey={view} hint="Jason Status = Approved, and not flagged by Layer 0" />
        <CountCell label="Layer 0 flagged" value={m.layer0.flagged} tone={m.layer0.flagged ? 'degraded' : 'dim'} replayKey={view} hint="the gate found something missing" />
      </StatStrip>

      {/*
        Three cards, one treatment: the same HBar at the same scale, the count
        and the share on every row, the footnote in the same place. They read as
        one set rather than three cards that happened to be built on different
        days.

        "Review status" is gone from here — it was Jason Status as its own
        breakdown, which is now the stage row above the list. Keeping both would
        have meant two places answering the same question with counts that could
        disagree.
      */}
      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Where logs are" align="top" note={m.stage_reconciliation.note}>
          <div className="space-y-2">
            {m.tabs.map((t) => (
              <HBar
                key={t.tab}
                label={
                  <span>
                    {t.label} <span className="text-faint">{t.layer}</span>
                  </span>
                }
                value={t.n}
                max={maxStage}
                tone={t.tab === 'approved' ? 'accent' : t.tab === 'needs_input' ? 'degraded' : 'ink'}
                replayKey={view}
                valueNode={<CountUp value={t.n} replayKey={view} />}
                right={<span className="text-faint">{m.entries ? Math.round((t.n / m.entries) * 100) : 0}%</span>}
              />
            ))}
          </div>
        </MetricCard>

        <MetricCard title="Layer 0 completeness" align="top" note={`${m.layer0.definition} ${m.holds.note}`}>
          {m.layer0.flagged === 0 && m.holds.open === 0 ? (
            <EmptyPanel>Nothing is flagged and nothing is waiting at the gate. Every submission read here passed Layer 0 clean.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              <HBar
                label="Flagged incomplete"
                value={m.layer0.flagged}
                max={Math.max(1, m.entries)}
                tone="degraded"
                replayKey={view}
                valueNode={<CountUp value={m.layer0.flagged} replayKey={view} />}
                right={<span className="text-faint">{m.entries ? Math.round((m.layer0.flagged / m.entries) * 100) : 0}%</span>}
              />
              {m.missing_mix.map((x) => (
                <HBar
                  key={x.element}
                  label={x.element}
                  value={x.n}
                  max={maxMissing}
                  replayKey={view}
                  valueNode={<CountUp value={x.n} replayKey={view} />}
                  right={<span className="text-faint">of {m.layer0.flagged}</span>}
                />
              ))}
              {m.holds.open > 0 && (
                <HBar
                  label={<span className="text-degraded">Parked at the gate</span>}
                  value={m.holds.open}
                  max={Math.max(1, m.entries)}
                  tone="degraded"
                  replayKey={view}
                  valueNode={<CountUp value={m.holds.open} replayKey={view} />}
                  right={<span className="text-faint">not counted above</span>}
                />
              )}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Narration quality" align="top" note={m.narration_quality_note}>
          {m.narration_quality_mix.length === 0 ? (
            <EmptyPanel>No submission carries a narration quality.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {/* Highest tier first, as the pipeline defines them: Excellent,
                  Great, Good. The server orders them; sorting gave Excellent,
                  Good, Great, which reads as Good outranking Great. */}
              {m.narration_quality_mix.map((qq, i) => (
                <HBar
                  key={qq.quality}
                  label={qq.quality}
                  value={qq.n}
                  max={maxQuality}
                  tone={i === 0 ? 'accent' : 'ink'}
                  replayKey={view}
                  valueNode={<CountUp value={qq.n} replayKey={view} />}
                  right={<span className="text-faint">{m.entries ? Math.round((qq.n / m.entries) * 100) : 0}%</span>}
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

function EntryView({
  id,
  onClose,
  onSaved,
  onDeleted,
  setToast,
}: {
  id: string;
  onClose: () => void;
  onSaved: (e: CodexEntry) => void;
  onDeleted: (id: string) => void;
  setToast: (t: { text: string; tone: 'ok' | 'failing' }) => void;
}) {
  const [detail, setDetail] = useState<CodexEntryDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState('');

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
      const updated = await setCodexStatus(id, status);
      onSaved(updated);
      setDetail((d) => (d ? { ...d, ...updated } : d));
      // Saved here either way; if Airtable did not take it, saying so is the
      // point. Same words as the row marker.
      setToast(
        unlanded(updated.writeback)
          ? { text: `Saved here, but Airtable did not take it: ${updated.writeback!.reason ?? 'no reason given'}`, tone: 'failing' }
          : { text: `Jason Status set to ${status}.`, tone: 'ok' },
      );
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await deleteCodexEntry(id, confirm.trim());
      onDeleted(id);
      setToast({ text: `${r.identifier} deleted from Airtable and from here.`, tone: 'ok' });
      onClose();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The submission was not deleted.', tone: 'failing' });
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
                  <StagePill entry={detail} />
                  {detail.stage === 'awaiting' && detail.approval === 'input added' && <Pill tone="accent">input added</Pill>}
                  {!detail.has_entry && <Pill>no codex generated</Pill>}
                  {detail.narration_quality && <span>narration {detail.narration_quality.toLowerCase()}</span>}
                  {unlanded(detail.writeback) && <NotLanded write={detail.writeback!} />}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {detail.approval !== 'approved' && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void review('Approved')}>
                    {busy ? 'Writing…' : 'Approve'}
                  </button>
                )}
                {detail.approval === 'approved' && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void review('Pending')}>
                    Send back to pending
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

            {/* The gate's own verdict, in full, where it stopped the log. */}
            {detail.layer0_flagged && (
              <div className="mt-4 flex items-start gap-3 rounded-[14px] bg-degraded-soft px-4 py-3">
                <span aria-hidden className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-degraded" />
                <div className="text-[12.5px] leading-relaxed text-degraded">
                  <span className="font-medium">Layer 0 flagged this log.</span>{' '}
                  {detail.layer0_missing.length ? (
                    <>
                      The gate found no <span className="font-medium">{detail.layer0_missing.join(', ')}</span>. The builder fills those in and the log re-enters Layer 1 — it does not go back
                      through Layer 0.
                    </>
                  ) : (
                    'Layer0 Missing does not name what it found absent, so this row says only that the gate stopped it.'
                  )}
                </div>
              </div>
            )}

            {detail.session_description && (
              <div className="mt-4">
                <div className="mb-1 text-[11px] text-faint">Session description</div>
                <p className="text-[13px] leading-relaxed text-dim">{detail.session_description}</p>
              </div>
            )}

            {/* Both long fields collapse. The generated codex opens by default —
                it is what the page exists to show — and the Layer 1 review does
                not, because it is the reasoning behind it rather than the thing
                itself. */}
            <details open className="mt-5 border-t border-line pt-4">
              <summary className="flex cursor-pointer items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">Generated codex</span>
                <span className="text-[11px] text-faint">Orchestrator Layer2 Review</span>
              </summary>
              <div className="mt-3">
                {detail.entry ? (
                  <EntryText text={detail.entry} />
                ) : (
                  <p className="text-[12.5px] leading-relaxed text-dim">
                    Layer 2 has not generated a codex for this submission. The row exists — the log was submitted — but Orchestrator Layer2 Review is empty.{' '}
                    {detail.layer0_flagged ? 'Layer 0 flagged it, which is why it never reached Layer 2.' : ''}
                  </p>
                )}
              </div>
            </details>

            <details className="mt-5 border-t border-line pt-4">
              <summary className="flex cursor-pointer items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">Layer 1 review</span>
                <span className="text-[11px] text-faint">{detail.layer1_review ? 'Layer1 Review' : 'not written'}</span>
              </summary>
              <p className="mt-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">
                {detail.layer1_review ?? 'Layer 1 has not written a review for this submission.'}
              </p>
            </details>

            {/*
              Delete exists for production testing: driving a log through
              Layer 0, Layer 1 and approval deliberately, then clearing the
              fixtures. Confirmed by typing the id back rather than by a yes/no
              dialog — mid-test there are several near-identical rows on screen
              and the id is the only thing that tells them apart.
            */}
            <div className="mt-5 border-t border-line pt-4">
              {!deleting ? (
                <button type="button" className="btn btn-ghost btn-sm text-failing" onClick={() => setDeleting(true)}>
                  Delete this submission
                </button>
              ) : (
                <div className="rounded-[14px] bg-failing-soft px-4 py-3">
                  <div className="text-[12.5px] leading-relaxed text-failing">
                    This removes the row from Airtable and from this dashboard. It cannot be undone — the full record is kept in the deletion log and nowhere else. Type{' '}
                    <span className="tabular font-medium">{detail.codex_entry_id ?? detail.submission_id}</span> to confirm.
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <input
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder={detail.codex_entry_id ?? detail.submission_id ?? 'the id'}
                      className="input tabular max-w-[320px] flex-1"
                      aria-label="Type the codex id to confirm"
                    />
                    <button
                      type="button"
                      className="btn btn-sm bg-failing text-bg"
                      disabled={busy || confirm.trim() !== (detail.codex_entry_id ?? detail.submission_id ?? '')}
                      onClick={() => void remove()}
                    >
                      {busy ? 'Deleting…' : 'Delete'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setDeleting(false); setConfirm(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
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
      key: 'stage',
      header: 'stage',
      card: 'meta',
      className: 'card-meta',
      title: (e) =>
        unlanded(e.writeback)
          ? writeWarning(e.writeback!)
          : e.layer0_flagged && e.layer0_missing.length
            ? `Layer 0 found no ${e.layer0_missing.join(', ')}`
            : undefined,
      cell: (e) => (
        <span className="inline-flex items-center gap-1.5">
          <StagePill entry={e} />
          {e.stage === 'awaiting' && e.approval === 'input added' && <Pill tone="accent">input added</Pill>}
          {unlanded(e.writeback) && <NotLanded write={e.writeback!} />}
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
  const { status, data: loaded, error } = useData(getCodexEntries, []);
  const [entries, setEntries] = useState<CodexEntry[]>([]);
  const [builder, setBuilder] = useState('all');
  const [tab, setTab] = useState<Tab>('needs_input');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('codex', query, builder), [builder, tick]);

  useEffect(() => {
    if (loaded) setEntries(loaded.entries);
  }, [loaded]);

  const scoped = useMemo(() => entries.filter((e) => builder === 'all' || e.builder_id === builder), [entries, builder]);
  const rows = useMemo(() => scoped.filter((e) => inTab(e, tab)).filter((e) => matches(e, q.trim())), [scoped, tab, q]);
  const paged = usePaged(rows, `${builder}|${tab}|${q.trim()}`);

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const m = metrics.data;
  const rule = tab === 'all' ? 'Every submission held, in all three stages.' : m?.tabs.find((t) => t.tab === tab)?.rule;
  const holds = loaded.layer0_holds.filter((h) => (builder === 'all' ? true : h.builder_id === builder) && h.open);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Codex entries" subtitle="Every session BHA has logged, as the orchestrator wrote it up" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <RowsLine freshness={loaded.freshness} writes={false} />
          {/* What the pass against Airtable did on this load. Silent when it
              found nothing and everything answered; a removal or a table it
              could not read is worth a line, because both change what is on
              screen. */}
          {(loaded.reconciliation.removed > 0 || loaded.reconciliation.blocked.length > 0 || !loaded.reconciliation.ran) && (
            <p className={`mt-1 text-[11.5px] leading-snug ${loaded.reconciliation.blocked.length || !loaded.reconciliation.ran ? 'text-degraded' : 'text-faint'}`}>
              {loaded.reconciliation.note}
            </p>
          )}
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
            options={[{ value: 'all', label: 'All builders', count: entries.length }, ...loaded.builders.map((b) => ({ value: b.id, label: b.label, count: b.n }))]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Tab> ariaLabel="Stage" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.value, label: t.label, count: scoped.filter((e) => inTab(e, t.value)).length }))} />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search entries" />
            </div>
          </div>
          {rule && <p className="text-[11.5px] leading-snug text-faint">{rule}</p>}
          {tab === 'needs_input' && holds.length > 0 && (
            <p className="text-[11.5px] leading-snug text-faint">
              {holds.length} further {holds.length === 1 ? 'submission is' : 'submissions are'} parked at the Layer 0 gate with no row in a builder table yet
              {holds.some((h) => h.missing.length) ? `, waiting on ${[...new Set(holds.flatMap((h) => h.missing))].join(', ')}` : ''}. They appear here once the builder resubmits.
            </p>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {loaded.freshness.source === 'none'
              ? (loaded.freshness.note ?? 'No Codex submissions are held.')
              : q.trim()
                ? 'No submission matches that search in the selected builder and stage.'
                : tab === 'needs_input'
                  ? `No submission is flagged by Layer 0${builder === 'all' ? '' : ' in this builder’s table'}. ${holds.length ? `${holds.length} ${holds.length === 1 ? 'is' : 'are'} still parked at the gate with no row here yet.` : 'Every submission read passed the completeness gate clean.'}`
                  : tab === 'awaiting'
                    ? 'Nothing is waiting on Jason in this selection.'
                    : tab === 'approved'
                      ? 'No submission is approved in this selection.'
                      : 'No submission is held in this selection.'}
          </EmptyState>
        ) : (
          <>
            <RecordTable columns={codexColumns((e) => setOpen(e.id))} rows={paged.rows} rowKey={(e) => e.id} onOpen={(e) => setOpen(e.id)} label="Codex entries" />
            <Pagination paged={paged} unit="submissions" />
          </>
        )}

      </div>

      {open && (
        <EntryView
          id={open}
          onClose={() => setOpen(null)}
          onSaved={(u) => {
            setEntries((list) => list.map((x) => (x.id === u.id ? u : x)));
            setTick((n) => n + 1);
          }}
          onDeleted={(gone) => {
            setEntries((list) => list.filter((x) => x.id !== gone));
            setTick((n) => n + 1);
          }}
          setToast={setToast}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}
