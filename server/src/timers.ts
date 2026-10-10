/**
 * The dashboard's own background timers (2026-10-09, Destiny — K9B7).
 *
 * Ten things in this process run on a timer. Most ticks do nothing, so a row
 * per tick would bury every other scheduler on the Scheduled runs page. This
 * keeps one line per timer: when it last ticked and how many times since the
 * process started. It is held in memory, so a deploy or a restart starts the
 * counts again, and the page says since when.
 */
export interface TimerInfo {
  name: string;
  what: string;
  every: string;
  last_tick_at: string | null;
  ticks: number;
}

const KNOWN: Array<{ name: string; what: string; every: string }> = [
  { name: 'executions poll', what: 'Reads new n8n executions and checks the execution quota', every: '45 seconds' },
  { name: 'incident ledger poll', what: 'Reads open incidents from BHARAG, one lane at a time', every: '3 minutes' },
  { name: 'monitoring twin', what: 'Judges the latest vFarm readings and syncs monitoring incidents', every: '1 minute' },
  { name: 'recovery watcher', what: 'Re-runs failures whose dependency is back', every: '5 minutes' },
  { name: 'approvals sweep', what: 'Expires approval cards nobody answered in 24 hours', every: '5 minutes' },
  { name: 'vfarm gate sweep', what: 'Fills sensor-backed gate checks and sends the gate cards', every: '2 minutes' },
  { name: 'lane blocker sweep', what: 'Writes an event when a loop blocking a lane is closed', every: '5 minutes' },
  { name: 'quality alert', what: 'Checks the agents\' answer quality against its alert line', every: '15 minutes' },
  { name: 'credit-out watch', what: 'Posts one alert the minute a run fails because the model credit is out', every: '1 minute' },
  { name: 'retention', what: 'Clears personal text past its retention period (acts once a week)', every: '6 hours' },
];

const state = new Map<string, { last: string; ticks: number }>();
export const STARTED_AT = new Date().toISOString();

/** Called at the top of a timer's tick. Never throws. */
export function beat(name: string): void {
  const s = state.get(name);
  const now = new Date().toISOString();
  if (s) {
    s.last = now;
    s.ticks += 1;
  } else state.set(name, { last: now, ticks: 1 });
}

export function list(): TimerInfo[] {
  const names = new Set([...KNOWN.map((k) => k.name), ...state.keys()]);
  return [...names].map((name) => {
    const k = KNOWN.find((x) => x.name === name);
    const s = state.get(name);
    return { name, what: k?.what ?? 'Not described', every: k?.every ?? 'not recorded', last_tick_at: s?.last ?? null, ticks: s?.ticks ?? 0 };
  });
}
