import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BUILDER_NAMES, LOOP_LANE_TAGS, type Loop, type LoopEdit, type LoopLaneTag, type LoopStatus } from '../../data';
import { laneLabel } from '../../lib';

/**
 * One loop, opened from its row.
 *
 * The list clips everything to one line because it has to; this is where the
 * whole What is readable and every field on the row is visible. Four things are
 * editable and the rest are shown as what they are — read-only, because nothing
 * in this dashboard should be the place someone rewrites a loop's id or the
 * Slack message it came from.
 *
 * **Builder is a move, not a field.** There is no builder column in Airtable:
 * the builder is which of the seven tables the row sits in. Changing it
 * recreates the row in the destination table and deletes it from the source, in
 * that order, so the worst case is a duplicate rather than a lost loop. The
 * panel says so before the save, because "Builder" in a dropdown looks exactly
 * like every other field and is the one that is not.
 */

const STATUSES: LoopStatus[] = ['open', 'in progress', 'closed'];

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="kicker block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-faint">{hint}</span>}
    </label>
  );
}

function ReadOnly({ label, value, href }: { label: string; value: string | null; href?: string | null }) {
  return (
    <div className="min-w-0">
      <span className="kicker block">{label}</span>
      <div className="mt-1 text-[13px] break-words text-dim">
        {value ? (
          href ? (
            <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          <span className="text-faint">—</span>
        )}
      </div>
    </div>
  );
}

export function LoopPanel({
  loop,
  busy,
  onSave,
  onClose,
}: {
  loop: Loop;
  busy: boolean;
  onSave: (edit: LoopEdit) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(loop.title);
  const [status, setStatus] = useState<LoopStatus>(loop.status);
  const [lane, setLane] = useState<LoopLaneTag | ''>(loop.lane_tag ?? '');
  const [builder, setBuilder] = useState(loop.owner);

  // The row can change under the panel — a save comes back with the server's
  // own copy, and after a move it comes back under a new record id.
  useEffect(() => {
    setTitle(loop.title);
    setStatus(loop.status);
    setLane(loop.lane_tag ?? '');
    setBuilder(loop.owner);
  }, [loop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const moving = builder !== loop.owner;
  const dirty = title.trim() !== loop.title || status !== loop.status || (lane || null) !== (loop.lane_tag ?? null) || moving;
  const wb = loop.writeback;

  function save(over?: Partial<LoopEdit>) {
    const edit: LoopEdit = {
      title: title.trim(),
      status,
      lane_tag: (lane || null) as LoopLaneTag | null,
      builder,
      ...over,
    };
    onSave(edit);
  }

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[820px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Loop">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{loop.loop_id ?? loop.id}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span>{BUILDER_NAMES[loop.owner] ?? loop.owner}</span>
              {loop.raised_at && <span className="tabular">raised {loop.raised_at}</span>}
              <span className="tabular">{loop.age_days}d old</span>
              {loop.closed_at && <span className="tabular">closed {loop.closed_at}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={loop.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close">
              Close panel
            </button>
          </div>
        </div>

        {/*
          The last write, where it did not cleanly land. Same words as the row
          marker and the banner — one pattern, said here in full because this is
          where there is room for the reason and the steps that completed.
        */}
        {wb && (wb.state === 'failed' || wb.state === 'duplicate') && (
          <div className="mt-4 flex items-start gap-3 rounded-[14px] bg-failing-soft px-4 py-3">
            <span aria-hidden className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-failing" />
            <div className="text-[12.5px] leading-relaxed text-failing">
              <span className="font-medium">{wb.state === 'duplicate' ? 'This loop is in two tables.' : 'The last change did not reach Airtable.'}</span>{' '}
              {wb.reason}
              {wb.steps && <div className="mt-1 text-[11.5px] text-failing/90">Completed: {wb.steps}.</div>}
            </div>
          </div>
        )}

        <div className="mt-4 space-y-4">
          <Field label="What">
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={4}
              className="input mt-1.5 min-h-[92px] resize-y leading-relaxed"
              placeholder="What this loop is"
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as LoopStatus)} className="input mt-1.5">
                {STATUSES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Lane">
              <select value={lane} onChange={(e) => setLane(e.target.value as LoopLaneTag | '')} className="input mt-1.5">
                <option value="">— no lane —</option>
                {LOOP_LANE_TAGS.map((l) => (
                  <option key={l} value={l}>
                    {laneLabel(l)}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Builder"
              hint={moving ? `Moves this loop out of ${BUILDER_NAMES[loop.owner] ?? loop.owner}’s table into ${BUILDER_NAMES[builder] ?? builder}’s. It is recreated there and removed here — the record id changes.` : 'The table the loop sits in. Changing it moves the row.'}
            >
              <select value={builder} onChange={(e) => setBuilder(e.target.value)} className={`input mt-1.5 ${moving ? 'text-degraded' : ''}`}>
                {Object.keys(BUILDER_NAMES).map((b) => (
                  <option key={b} value={b}>
                    {BUILDER_NAMES[b]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid gap-4 border-t border-line pt-4 md:grid-cols-4">
            <ReadOnly label="loop_id" value={loop.loop_id} />
            <ReadOnly label="Raised by" value={loop.raised_by} />
            <ReadOnly label="Date raised" value={loop.raised_at} />
            <ReadOnly label="Source link" value={loop.source.kind === 'slack' ? loop.source.ref : null} href={loop.source.kind === 'slack' ? loop.source.url : null} />
            <ReadOnly label="Raised in" value={loop.raised_in} />
            <ReadOnly label="Assignee Slack id" value={loop.assignee_slack_id} />
            <ReadOnly label="Last modified" value={loop.last_modified ? loop.last_modified.replace('T', ' ').slice(0, 16) : null} />
            <ReadOnly label="Airtable record" value={loop.airtable.record_id} href={loop.airtable.url} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="text-[11.5px] text-faint">
            {loop.note ? `Note: ${loop.note}` : 'Saved here first, then written to Airtable.'}
          </div>
          <div className="flex items-center gap-2">
            {status !== 'closed' && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save({ status: 'closed' })}>
                Close loop
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => save()}>
              {busy ? 'Saving…' : moving ? `Move to ${BUILDER_NAMES[builder] ?? builder}` : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
