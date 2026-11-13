/**
 * The Codex entry dialog, shared by the Codex page and Pay Tracker (2026-09-23,
 * Destiny). Moved here whole from Codex.tsx rather than copied, so the two
 * pages cannot drift: the same header, stage pills, narration link, review and
 * generated codex, with the page's own write actions left out in read-only use.
 */
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { deleteCodexEntry, getCodexDetail, payChoiceProblem, PAY_REASON_TAGS, rejectCodexLog, setCodexStatus, setPayNote, type CodexEntry, type CodexEntryDetail, type PayNoteChoice } from '../data';
import { Button, Pill, NotLanded, unlanded } from '../components/ui';
import { ENTRY_DEFS, JASON_STATUS_DEFS, PAID_DEFS, QUALITY_DEF, STAGE_DEFS } from './codexDefinitions';

const CODE_CHECK_VERDICT: Record<string, string> = { matches: 'Matches the log', partly: 'Partly matches', overstated: 'Overstated' };
const CODE_CHECK_PAY: Record<string, string> = { as_logged: 'Pay as logged', partly: 'Pay partly', hold: 'Hold' };

export function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

/**
 * The stage, as one pill. Jason Status is shown beside it only where it adds
 * something the stage does not say — "input added" sits inside Approved and is
 * worth distinguishing from a plain approval.
 */
export function StagePill({ entry }: { entry: CodexEntry }) {
  // Pill takes no title, so the definition sits on a wrapper (see codexDefinitions.ts).
  const pill =
    entry.stage === 'rejected' ? <Pill>rejected</Pill> : entry.stage === 'report' ? <Pill>report</Pill> : entry.stage === 'approved' ? <Pill tone="ok">approved</Pill> : entry.stage === 'needs_input' ? <Pill tone="degraded">needs input</Pill> : <Pill>awaiting approval</Pill>;
  return <span title={STAGE_DEFS[entry.stage]}>{pill}</span>;
}

/**
 * "input added" beside the stage. It used to be drawn only at `awaiting`, which
 * Input Added can never reach — mapCodex files it under Approved — so it never
 * showed. It is drawn wherever Jason Status says it.
 */
export function InputAddedPill({ entry }: { entry: CodexEntry }) {
  if (entry.approval !== 'input added') return null;
  return (
    <span title={JASON_STATUS_DEFS['input added']}>
      <Pill tone="accent">input added</Pill>
    </span>
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
            {isHeading && <div className="mb-1 text-[12px] font-medium text-dim">{head}</div>}
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

export function CodexEntryDialog({
  id,
  onClose,
  onSaved,
  onDeleted,
  setToast,
  load,
  readOnly = false,
}: {
  id: string;
  onClose: () => void;
  onSaved?: (e: CodexEntry) => void;
  onDeleted?: (id: string) => void;
  setToast?: (t: { text: string; tone: 'ok' | 'failing' }) => void;
  /**
   * How to find the entry. The Codex page reads by record id; Pay Tracker
   * resolves a pay session to its entry on the server (2026-09-23), because a
   * session's Codex Entry ID is not a key every Codex row carries.
   */
  load?: (id: string) => Promise<CodexEntryDetail>;
  /**
   * Pay Tracker is read-only by rule: no Approve, no Send back, no Delete, and
   * no Airtable button — Airtable is retired and nothing on /pay links to it.
   */
  readOnly?: boolean;
}) {
  const [detail, setDetail] = useState<CodexEntryDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Nothing held (a 404) is a plain statement, not a failure, so it is not drawn in red.
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState('');
  // Reject (2026-10-15): Jason's or Destiny's, with a reason the builder is shown.
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectAs, setRejectAs] = useState<'U0A9V97949F' | 'U0AEW3TBYH1'>('U0A9V97949F');
  // The pay note (9 Nov 2026, Jason's DM 1794237173.152349): Approve asks for it first, default full.
  const [approving, setApproving] = useState(false);
  const [pay, setPay] = useState<PayNoteChoice>({ pay_recommendation: 'full', rest: 'hold' });
  const payProblem = payChoiceProblem(pay);

  useEffect(() => {
    let live = true;
    (load ?? getCodexDetail)(id)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        // LogStream (9 Nov 2026): Approve starts from the review's suggested pay note, not from full.
        const sg = d.pay_suggestion;
        if (sg && !sg.none && sg.pay_recommendation) {
          setPay({
            pay_recommendation: sg.pay_recommendation,
            rest: sg.rest ?? 'hold',
            credited_share: sg.pay_recommendation === 'custom_fraction' ? sg.credited_share : undefined,
            held_share: sg.pay_recommendation === 'custom_fraction' ? sg.held_share : undefined,
            reason_tag: sg.reason_tag ?? null,
            reason_note: sg.reason_note ?? null,
            release_condition: sg.release_condition ?? null,
          });
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        setMissing((e as { status?: number } | null)?.status === 404);
        setErr(e instanceof Error ? e.message : 'Could not load the entry.');
      });
    return () => {
      live = false;
    };
  }, [id, load]);

  async function review(status: string) {
    setBusy(true);
    try {
      const updated = await setCodexStatus(id, status);
      onSaved?.(updated);
      setDetail((d) => (d ? { ...d, ...updated } : d));
      // Saved here either way; if Airtable did not take it, saying so is the
      // point. Same words as the row marker.
      setToast?.(
        unlanded(updated.writeback)
          ? { text: `Saved here, but the write-back did not land: ${updated.writeback!.reason ?? 'no reason given'}`, tone: 'failing' }
          : { text: `Jason Status set to ${status}.`, tone: 'ok' },
      );
    } catch (e) {
      setToast?.({ text: e instanceof Error ? e.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusy(false);
    }
  }

  /** Approve, then the pay note on the approved log. A pay note that does not save is said, never passed over. */
  async function approveWithPay() {
    if (!detail || payProblem) return;
    await review('Approved');
    if (!detail.submission_id) {
      setToast?.({ text: 'Approved, but this log has no Submission ID, so the pay note was not saved. It counts as a full day until one is set.', tone: 'failing' });
      return;
    }
    try {
      const r = await setPayNote({ submission_id: detail.submission_id }, pay);
      setToast?.({ text: `Approved. Pay note: ${r.message}`, tone: 'ok' });
      setApproving(false);
    } catch (e) {
      setToast?.({ text: `Approved, but the pay note was not saved: ${e instanceof Error ? e.message : String(e)} Until it is set the log counts as a full day.`, tone: 'failing' });
    }
  }

  async function reject() {
    setBusy(true);
    try {
      const r = await rejectCodexLog(id, rejectAs, rejectReason.trim());
      const fresh = await getCodexDetail(id);
      setDetail(fresh);
      onSaved?.(fresh);
      setRejecting(false);
      setToast?.(
        r.ok
          ? { text: `Rejected. The builder was sent a message in their log channel, and the review card no longer has buttons.`, tone: 'ok' }
          : { text: r.message ?? 'Rejected, but a Slack message was not rewritten.', tone: 'failing' },
      );
    } catch (e) {
      setToast?.({ text: e instanceof Error ? e.message : 'The log was not rejected.', tone: 'failing' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await deleteCodexEntry(id, confirm.trim());
      onDeleted?.(id);
      // Worded from what actually happened on the other side. It is still an
      // `ok` toast either way — the entry is gone from here, which is what was
      // asked for — but it never claims a deletion Airtable did not make.
      setToast?.({
        text: `${r.identifier} deleted.`,
        tone: 'ok',
      });
      onClose();
    } catch (e) {
      setToast?.({ text: e instanceof Error ? e.message : 'The submission was not deleted.', tone: 'failing' });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Codex entry">
        {err ? (
          <div className="flex items-start justify-between gap-3">
            <div className={`text-[13px] ${missing ? 'text-dim' : 'text-failing'}`}>{err}</div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
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
                  <InputAddedPill entry={detail} />
                  {!detail.has_entry && (
                    <span title={ENTRY_DEFS.none}>
                      <Pill>no codex generated</Pill>
                    </span>
                  )}
                  {detail.narration_quality && <span title={QUALITY_DEF}>narration {detail.narration_quality.toLowerCase()}</span>}
                  {unlanded(detail.writeback) && <NotLanded write={detail.writeback!} />}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!readOnly && detail.stage !== 'report' && detail.approval !== 'approved' && detail.approval !== 'rejected' && (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => setApproving((a) => !a)}>
                    {busy ? 'Writing…' : 'Approve'}
                  </Button>
                )}
                {!readOnly && detail.approval !== 'approved' && detail.approval !== 'input added' && detail.approval !== 'rejected' && !detail.codex_entry_id && !rejecting && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
                    Reject
                  </Button>
                )}
                {!readOnly && detail.approval === 'approved' && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void review('Pending')}>
                    Send back to pending
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>

            {approving && !readOnly && (
              <div className="mt-4 border-t border-line pt-4 text-[12.5px]">
                <div className="mb-2 font-semibold">Pay note</div>
                {detail?.pay_suggestion && (
                  <div className="card mb-3 px-3 py-2 text-[12px]">
                    <div>
                      <span className="text-faint">Suggested from the review: </span>
                      {detail.pay_suggestion.line ?? 'no suggestion'}
                    </div>
                    {(detail.pay_suggestion.flags ?? []).map((f) => (
                      <div key={f} className="mt-1 text-degraded">
                        {f}
                      </div>
                    ))}
                    {!detail.pay_suggestion.none && <div className="mt-1 text-faint">The choice below starts there. Change it if the review got it wrong; both are kept.</div>}
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  {(
                    [
                      ['full', 'Full day (100%)'],
                      ['half', 'Half now (50%)'],
                      ['none', 'None now (0%)'],
                      ['custom_fraction', 'Custom %'],
                    ] as const
                  ).map(([v, label]) => (
                    <label key={v} className="flex items-center gap-1.5">
                      <input type="radio" name="pay_choice" checked={pay.pay_recommendation === v} onChange={() => setPay((p) => ({ ...p, pay_recommendation: v }))} />
                      {label}
                    </label>
                  ))}
                </div>
                {pay.pay_recommendation !== 'full' && (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-faint">The rest of the day</span>
                      <select className="input" value={pay.rest ?? 'hold'} onChange={(e) => setPay((p) => ({ ...p, rest: e.target.value === 'dock' ? 'dock' : 'hold' }))}>
                        <option value="hold">Hold it until the condition is met</option>
                        <option value="dock">Dock it (never paid)</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-faint">Reason</span>
                      <select className="input" value={pay.reason_tag ?? ''} onChange={(e) => setPay((p) => ({ ...p, reason_tag: e.target.value || null }))}>
                        <option value="">Choose a reason</option>
                        {PAY_REASON_TAGS.map((tag) => (
                          <option key={tag} value={tag}>
                            {tag}
                          </option>
                        ))}
                      </select>
                    </label>
                    {pay.pay_recommendation === 'custom_fraction' && (
                      <>
                        <label className="flex flex-col gap-1">
                          <span className="text-faint">Credited now (% of a day)</span>
                          <input className="input" inputMode="decimal" value={pay.credited_share === undefined || pay.credited_share === null ? '' : String(Math.round(pay.credited_share * 1000) / 10)} onChange={(e) => setPay((p) => ({ ...p, credited_share: e.target.value === '' ? undefined : Number(e.target.value) / 100 }))} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-faint">Held (% of a day; left empty: the rest, held or docked as above)</span>
                          <input className="input" inputMode="decimal" value={pay.held_share === undefined || pay.held_share === null ? '' : String(Math.round(pay.held_share * 1000) / 10)} onChange={(e) => setPay((p) => ({ ...p, held_share: e.target.value === '' ? undefined : Number(e.target.value) / 100 }))} />
                        </label>
                      </>
                    )}
                    <label className="flex flex-col gap-1 md:col-span-2">
                      <span className="text-faint">Release condition (needed if anything is held)</span>
                      <textarea className="input py-2" rows={2} value={pay.release_condition ?? ''} onChange={(e) => setPay((p) => ({ ...p, release_condition: e.target.value }))} />
                    </label>
                    <label className="flex flex-col gap-1 md:col-span-2">
                      <span className="text-faint">Reason note (needed if anything is docked)</span>
                      <input className="input" value={pay.reason_note ?? ''} onChange={(e) => setPay((p) => ({ ...p, reason_note: e.target.value }))} />
                    </label>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button variant="primary" size="sm" disabled={busy || !!payProblem} onClick={() => void approveWithPay()}>
                    {busy ? 'Writing…' : 'Yes, approve'}
                  </Button>
                  <span className={payProblem ? 'text-degraded' : 'text-faint'}>{payProblem ?? 'Percent of a day, never money. Kept with who decided it; corrected forward, never removed.'}</span>
                </div>
              </div>
            )}

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
              <div className="min-w-0">
                <div className="text-[11px] text-faint">paid</div>
                {detail.paid === null ? (
                  <div className="text-faint" title="The field was added to the builder tables after this log was written and nothing backfills it.">
                    not recorded
                  </div>
                ) : (
                  <div className="text-ink" title={detail.paid ? PAID_DEFS.paid : PAID_DEFS.unpaid}>
                    {detail.paid ? 'yes' : 'no'}
                  </div>
                )}
              </div>
              {detail.day && (
                <div className="min-w-0 md:col-span-3">
                  <div className="text-[11px] text-faint">This day’s logs ({detail.day.date}, UTC date)</div>
                  <div className="text-dim">
                    {detail.day.logs.length} logs, one working day and one paid day. The first log approved is the day’s entry; the others were added to it and pay nothing of their own.
                  </div>
                  <ol className="mt-1 space-y-1">
                    {detail.day.logs.map((l) => (
                      <li key={l.id} className="text-ink">
                        <a className="text-accent hover:underline" href={`/codex/${encodeURIComponent(l.codex_entry_id ?? l.submission_id)}`}>
                          {l.number}. {l.title}
                        </a>
                        <span className="text-dim">
                          {' '}· {l.merged ? 'added to the day' : 'the day’s entry'} · {l.status}
                          {l.submitted_at ? ` · submitted ${when(l.submitted_at)}` : ''}
                          {l.submission_id === detail.submission_id ? ' · this log' : ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {detail.jason_notes && (
                <div className="min-w-0 md:col-span-3">
                  <div className="text-[11px] text-faint">Jason’s notes</div>
                  <div className="text-ink">{detail.jason_notes}</div>
                </div>
              )}
              {detail.sop_conflict && (
                <div className="min-w-0 md:col-span-3">
                  <div className="text-[11px] text-faint">SOP conflict</div>
                  <div className="text-ink">
                    {detail.sop_conflict.flag} · SOP -- vFarm Hardware Modularity and Swapability ({detail.sop_conflict.sop_id})
                  </div>
                  {detail.sop_conflict.evidence && <div className="text-dim">What the log says: “{detail.sop_conflict.evidence}”</div>}
                  <div className="text-dim">
                    {detail.sop_conflict.reason ? `Deviation reason: ${detail.sop_conflict.reason}` : 'Deviation reason: asked, not answered yet.'}
                    {detail.sop_conflict.reason_at ? ` (${detail.sop_conflict.reason_at.slice(0, 10)})` : ''}
                  </div>
                  {(detail.sop_conflict.reason_link || detail.sop_conflict.prompt_link) && (
                    <a className="text-accent hover:underline" href={(detail.sop_conflict.reason_link || detail.sop_conflict.prompt_link) as string} target="_blank" rel="noreferrer">
                      {detail.sop_conflict.reason_link ? 'The reason in Slack ↗' : 'The question in Slack ↗'}
                    </a>
                  )}
                  <div className="text-[11px] text-faint">Flags the log for review; it does not block pay.</div>
                </div>
              )}
              {detail.code_check && (
                <div className="min-w-0 md:col-span-3">
                  <div className="text-[11px] text-faint">Code check</div>
                  <div className="text-ink">
                    {CODE_CHECK_VERDICT[detail.code_check.verdict ?? ''] ?? detail.code_check.verdict}
                    {detail.code_check.pay_call ? ` · ${CODE_CHECK_PAY[detail.code_check.pay_call] ?? detail.code_check.pay_call}` : ''}
                    {detail.code_check.at ? ` · ${detail.code_check.at.slice(0, 10)}` : ''}
                  </div>
                  {detail.code_check.reason && <div className="text-dim">{detail.code_check.reason}</div>}
                  {detail.code_check.approve && (
                    <div className="text-dim">
                      Approve: {detail.code_check.approve}{detail.code_check.why ? `. ${detail.code_check.why}` : ''}
                      {detail.code_check.lane_check ? ` Lane: ${detail.code_check.lane_check}` : ''}
                    </div>
                  )}
                  {detail.code_check.full && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-accent hover:underline">The full check</summary>
                      <div className="mt-1 whitespace-pre-wrap text-ink">{detail.code_check.full.replace(/\*([^*\n]+)\*/g, '$1')}</div>
                    </details>
                  )}
                  {detail.code_check.link && (
                    <a className="text-accent hover:underline" href={detail.code_check.link} target="_blank" rel="noreferrer">
                      {detail.code_check.full ? 'The summary in Slack ↗' : 'The full check in Slack ↗'}
                    </a>
                  )}
                </div>
              )}
            </div>

            {detail.rejected && (
              <div className="mt-4 rounded-[14px] border border-line px-4 py-3 text-[12.5px] leading-relaxed">
                <div className="font-medium text-ink">
                  Rejected{detail.rejected.by ? ` by ${detail.rejected.by}` : ''}
                  {detail.rejected.at ? ` on ${when(detail.rejected.at)}` : ''}
                </div>
                <div className="text-dim">{detail.rejected.reason ?? 'No reason was recorded.'}</div>
                <div className="mt-1 text-[11.5px] text-faint">It does not go to the Codex and is not counted for pay. Nothing in the engine can change it.</div>
              </div>
            )}

            {/* Reject asks for its reason in a pop-up of its own (2026-10-15, Destiny), over the entry. */}
            {rejecting && !detail.rejected && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!busy) setRejecting(false);
                }}
              >
                <div className="card fade-up w-full max-w-[520px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Reject this log">
                  <h3 className="text-[16px] font-semibold text-ink">Reject this log</h3>
                  <div className="mt-1 text-[12.5px] leading-relaxed text-dim">
                    {detail.session_description ?? detail.submission_id}
                  </div>
                  <div className="mt-3 text-[12.5px] leading-relaxed text-ink">
                    It will never go to the Codex or count for pay. The review card and the sent-back messages lose their buttons, and{' '}
                    <span className="capitalize">{detail.builder_id}</span> gets a message in their log channel with this log's details, your reason and a link to it here.
                  </div>
                  <label className="mt-4 block text-[12px] font-medium text-dim" htmlFor="reject-reason">
                    Why are you rejecting it?
                  </label>
                  <textarea
                    id="reject-reason"
                    autoFocus
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={4}
                    maxLength={1000}
                    placeholder="In a sentence the builder will read. For example: your newer log covers what was asked for."
                    className="input mt-1.5 w-full"
                  />
                  <div className="mt-1 text-right text-[11px] text-faint tabular">{rejectReason.trim().length} / 1,000</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-[12px] text-dim">
                      Rejecting as{' '}
                      <select value={rejectAs} onChange={(e) => setRejectAs(e.target.value as 'U0A9V97949F' | 'U0AEW3TBYH1')} className="input ml-1 inline-block w-auto py-1">
                        <option value="U0A9V97949F">Jason</option>
                        <option value="U0AEW3TBYH1">Destiny</option>
                      </select>
                    </label>
                    <span className="text-[11.5px] text-faint">One shared login, so this is declared, not checked.</span>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRejecting(false); setRejectReason(''); }}>
                      Cancel
                    </Button>
                    <Button variant="destructive" size="sm" loading={busy} disabled={busy || rejectReason.trim().length < 3} onClick={() => void reject()}>
                      Reject log
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* The gate's own verdict, in full, where it stopped the log. */}
            {detail.layer0_flagged && (
              <div className="mt-4 flex items-start gap-3 rounded-[14px] bg-degraded-soft px-4 py-3">
                <span aria-hidden className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-degraded" />
                <div className="text-[12.5px] leading-relaxed text-degraded">
                  <span className="font-medium">The completeness check flagged this log.</span>{' '}
                  {detail.layer0_missing.length ? (
                    <>
                      The check found no <span className="font-medium">{detail.layer0_missing.join(', ')}</span>. The builder fills those in and the log goes back to review — it does not go
                      through the check again.
                    </>
                  ) : (
                    'Layer0 Missing does not name what it found absent, so this row says only that the check stopped it.'
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
                it is what the page exists to show — and the review does
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
                    No builder codex has been written for this submission. The row exists — the log was submitted — but Orchestrator Layer2 Review is empty.{' '}
                    {detail.layer0_flagged ? 'The completeness check flagged it, which is why no codex was written.' : ''}
                  </p>
                )}
              </div>
            </details>

            <details className="mt-5 border-t border-line pt-4">
              <summary className="flex cursor-pointer items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">Review</span>
                <span className="text-[11px] text-faint">{detail.layer1_review ? 'Layer1 Review' : 'not written'}</span>
              </summary>
              <p className="mt-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">
                {detail.layer1_review ?? 'No review has been written for this submission.'}
              </p>
            </details>

            {/*
              Delete exists for production testing: driving a log through
              the completeness check, review and approval deliberately, then clearing the
              fixtures. Confirmed by typing the id back rather than by a yes/no
              dialog — mid-test there are several near-identical rows on screen
              and the id is the only thing that tells them apart.
            */}
            {!readOnly && (
            <div className="mt-5 border-t border-line pt-4">
              {!deleting ? (
                <Button variant="ghost" size="sm" className="text-failing" onClick={() => setDeleting(true)}>
                  Delete this submission
                </Button>
              ) : (
                <div className="rounded-[14px] bg-failing-soft px-4 py-3">
                  <div className="text-[12.5px] leading-relaxed text-failing">
                    This removes the submission from this dashboard. It cannot be undone — the full record is kept in the deletion log and nowhere else. Type{' '}
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
                    <Button
                      variant="destructive"
                      size="sm"
 disabled={busy || confirm.trim() !== (detail.codex_entry_id ?? detail.submission_id ?? '')}
 onClick={() => void remove()}
 >
                      {busy ? 'Deleting…' : 'Delete'}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDeleting(false); setConfirm(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
