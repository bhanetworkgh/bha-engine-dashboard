import { useState } from 'react';
import { useData } from '../../app/useData';
import { getEngineStrain, type Health } from '../../data';
import { Dot } from '../../components/ui';
import { HEALTH_KINDS } from './kinds';

/**
 * One line above every Engine health tab (27 Oct 2026, Destiny — 7RZT): is the engine short of AI credit or
 * answering on its backup right now, from `/api/engine-health/strain` (the read `read_engine_strain` gives Genie).
 * Normal is grey and says so; strained is amber; recovering is grey with the reason. Opening it shows the counts in
 * words and the exact line each audience is told, so the team can see what a pilot, a buyer and Genie would say.
 * A read that fails says so in place rather than hiding the line: no line could be read as "nothing wrong".
 */
const HEALTH: Record<string, Health> = { normal: 'ok', recovering: 'ok', strained: 'degraded' };
const LABEL: Record<string, string> = { normal: 'Normal', recovering: 'Recovering', strained: 'Under strain' };
const WHO: Array<[string, string]> = [
  ['pilot_operator', 'Pilot operator'],
  ['early_buyer', 'Early buyer'],
  ['media_twin', 'Media Twin'],
  ['genie', 'Slack Genie'],
];

export function StrainLine() {
  const { status, data, error } = useData(getEngineStrain, [], { kinds: HEALTH_KINDS });
  const [open, setOpen] = useState(false);
  if (status === 'error' && !data) {
    return <p className="shrink-0 px-6 pb-2 text-[11.5px] text-degraded md:px-8">Engine strain could not be read: {String(error ?? 'no reason given')}</p>;
  }
  if (!data) return null;
  return (
    <div className="shrink-0 px-6 pb-2 md:px-8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left text-[12px] leading-snug"
      >
        <span className="mt-[5px]"><Dot health={HEALTH[data.state] ?? 'ok'} title={LABEL[data.state]} /></span>
        <span className={data.state === 'strained' ? 'text-degraded' : 'text-dim'}>
          <span className="font-medium">{LABEL[data.state] ?? data.state}.</span> {data.summary}
        </span>
        <span className="ml-auto shrink-0 text-faint">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-4 text-[11.5px] leading-snug text-faint">
          <p><span className="text-dim">Team:</span> {data.audiences.team}</p>
          {WHO.map(([k, label]) => (
            <p key={k}><span className="text-dim">{label}:</span> {data.audiences[k as keyof typeof data.audiences]}</p>
          ))}
        </div>
      )}
    </div>
  );
}
