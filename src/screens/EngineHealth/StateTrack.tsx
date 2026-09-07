import type { Incident } from '../../data';

const STATES: Incident['state'][] = [
  'new',
  'triage',
  'auto-retry pending',
  'resolved',
  'failed',
  'escalated to RT',
  'escalated to human',
];

export function StateTrack({ state }: { state: Incident['state'] }) {
  const idx = STATES.indexOf(state);
  return (
    <span className="inline-flex items-center gap-[3px]" title={STATES.join(' → ')}>
      {STATES.map((s, i) => (
        <span
          key={s}
          className={`h-[3px] w-[9px] ${
            i === idx
              ? state === 'failed' || state === 'escalated to human'
                ? 'bg-failing'
                : state === 'resolved'
                  ? 'bg-dim'
                  : 'bg-degraded'
              : i < idx
                ? 'bg-line-strong'
                : 'bg-line'
          }`}
        />
      ))}
    </span>
  );
}
