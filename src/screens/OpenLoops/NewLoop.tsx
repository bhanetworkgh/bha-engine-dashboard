import { useState } from 'react';
import { BUILDER_NAMES, LANE_LIST, type Lane, type NewLoop } from '../../data';
import { Icon } from '../../components/ui';
import { laneLabel } from '../../lib';

/** Inline form for opening a loop from the interface. */
export function NewLoopForm({
  defaultOwner,
  defaultLane,
  busy,
  onSubmit,
  onCancel,
}: {
  defaultOwner: string;
  defaultLane: Lane;
  busy: boolean;
  onSubmit: (input: NewLoop) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(defaultOwner);
  const [lane, setLane] = useState<Lane>(defaultLane);
  const [note, setNote] = useState('');
  const owners = Object.keys(BUILDER_NAMES);

  return (
    <form
      className="card fade-up mx-6 mb-4 p-4 md:mx-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || busy) return;
        onSubmit({ title: title.trim(), owner, lane, note: note.trim() || undefined });
      }}
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_180px]">
        <div>
          <label className="kicker block" htmlFor="loop-title">
            Loop
          </label>
          <input
            id="loop-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to happen, in one line"
            className="input mt-1.5"
          />
        </div>
        <div>
          <label className="kicker block" htmlFor="loop-owner">
            Owner
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
            Lane
          </label>
          <select id="loop-lane" value={lane} onChange={(e) => setLane(e.target.value as Lane)} className="input mt-1.5">
            {LANE_LIST.map((l) => (
              <option key={l} value={l}>
                {laneLabel(l)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label className="kicker block" htmlFor="loop-note">
          Note <span className="text-faint">(optional)</span>
        </label>
        <input id="loop-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Context, a link, who asked" className="input mt-1.5" />
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-ghost" disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary gap-1.5" disabled={busy || !title.trim()}>
          <Icon.plus />
          {busy ? 'Opening' : 'Open loop'}
        </button>
      </div>
    </form>
  );
}
