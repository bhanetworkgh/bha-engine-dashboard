import { useState } from 'react';
import { BUILDER_NAMES, LOOP_LANE_TAGS, type LoopLaneTag, type NewLoop } from '../../data';
import { laneLabel } from '../../lib';

/**
 * Opens a loop. The server creates the record in the builder's table in
 * Airtable first and shows it here only from what Airtable sent back.
 */
export function NewLoopForm({ defaultOwner, busy, onSubmit, onCancel }: { defaultOwner: string; busy: boolean; onSubmit: (input: NewLoop) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(defaultOwner);
  const [lane, setLane] = useState<LoopLaneTag>('UNASSIGNED');
  const [raisedBy, setRaisedBy] = useState('');
  const [note, setNote] = useState('');
  const owners = Object.keys(BUILDER_NAMES);

  return (
    <form
      className="card mx-6 mb-4 px-5 py-4 md:mx-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || busy) return;
        onSubmit({ title: title.trim(), owner, lane_tag: lane, raised_by: raisedBy.trim() || undefined, note: note.trim() || undefined });
      }}
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <label className="kicker block" htmlFor="loop-title">
            What
          </label>
          <input id="loop-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to happen, in one line" className="input mt-1.5" />
        </div>
        <div>
          <label className="kicker block" htmlFor="loop-owner">
            Table
          </label>
          <select id="loop-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="input mt-1.5">
            {owners.map((o) => (
              <option key={o} value={o}>
                {BUILDER_NAMES[o]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="kicker block" htmlFor="loop-lane">
            Lane tag
          </label>
          <select id="loop-lane" value={lane} onChange={(e) => setLane(e.target.value as LoopLaneTag)} className="input mt-1.5">
            {LOOP_LANE_TAGS.map((l) => (
              <option key={l} value={l}>
                {laneLabel(l)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="kicker block" htmlFor="loop-raised-by">
            Raised by <span className="text-faint">(optional)</span>
          </label>
          <input id="loop-raised-by" value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)} placeholder="Who asked" className="input mt-1.5" />
        </div>
      </div>
      <div className="mt-3">
        <label className="kicker block" htmlFor="loop-note">
          Note <span className="text-faint">(optional, held here only — not an Airtable field)</span>
        </label>
        <input id="loop-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Context, a link, who asked" className="input mt-1.5" />
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
        <button type="submit" disabled={!title.trim() || busy} className="btn btn-primary btn-sm">
          {busy ? 'Writing to Airtable…' : 'Open loop'}
        </button>
      </div>
    </form>
  );
}
