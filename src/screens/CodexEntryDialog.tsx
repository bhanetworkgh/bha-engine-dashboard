/**
 * The Codex entry dialog, shared by the Codex page and Pay Tracker (2026-09-23,
 * Destiny). Moved here whole from Codex.tsx rather than copied, so the two
 * pages cannot drift: the same header, stage pills, narration link, review and
 * generated codex, with the page's own write actions left out in read-only use.
 */
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { deleteCodexEntry, getCodexDetail, setCodexStatus, type CodexEntry, type CodexEntryDetail } from '../data';
import { Button, Pill, NotLanded, unlanded } from '../components/ui';
import { ENTRY_DEFS, JASON_STATUS_DEFS, PAID_DEFS, QUALITY_DEF, STAGE_DEFS } from './codexDefinitions';

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
    entry.stage === 'approved' ? <Pill tone="ok">approved</Pill> : entry.stage === 'needs_input' ? <Pill tone="degraded">needs input</Pill> : <Pill>awaiting approval</Pill>;
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

  useEffect(() => {
    let live = true;
    (load ?? getCodexDetail)(id)
      .then((d) => live && setDetail(d))
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
                {!readOnly && detail.approval !== 'approved' && (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void review('Approved')}>
                    {busy ? 'Writing…' : 'Approve'}
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
