/**
 * The dashboard's own background timers (2026-10-09, Destiny — K9B7).
 *
 * Several things in this process run on a timer. Most ticks do nothing, so a row
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
  { name: 'credit-out watch', what: 'Posts one alert the minute a run fails because the model credit is out, and one when OpenRouter stops responding', every: '1 minute' },
  { name: 'logstream sweep', what: 'Writes Logstream rows and acts on faults that crossed a threshold', every: '5 minutes' },
  { name: 'research signals', what: 'Finds signals that ask for research and opens one job each, within the daily budget', every: '5 minutes' },
  { name: 'skill watch', what: 'Once a day reads the skills on every agent\'s live version and alerts when one has gone, or when an agent cannot be read', every: '1 hour' },
  { name: 'publish check', what: 'Asks for an eval run after an agent version change and alerts if it regressed', every: '2 minutes' },
  { name: 'intake-2 follow-ups', what: 'Sends the Stage 2 follow-up emails at 3 and 7 days and marks a lead Unresponsive at 14', every: '15 minutes' },
  { name: 'pattern capture', what: 'Turns a failure the repair bridge found no build pattern for into one pattern candidate per fault', every: '10 minutes' },
  { name: 'decision watch', what: 'Checks watched decisions and posts a reminder where one has gone quiet past its wait', every: '5 minutes' },
  { name: 'draft eval orphan sweep', what: 'Marks a draft eval interrupted when no live process holds it, so a deploy cannot leave one running for good', every: '1 minute' },
  { name: 'codex log gap', what: 'DMs a regular builder once when no Codex log of theirs has reached the engine in 30 hours, with a copy to Destiny', every: '1 hour' },
  { name: 'renewal reminder', what: 'Posts a card in #bha-engine-alerts 7, 3 and 1 day before a paid tool renews, and rolls passed renewal dates forward', every: '1 hour' },
  { name: 'code check watch', what: 'DMs Destiny when Jason approves a log that is owed a code check, then reminds every 3 hours until the check is recorded, and records a prepared check when it is sent', every: '2 minutes' },
  { name: 'model spend reading', what: 'Reads OpenRouter\'s usage counter for the Model spend page', every: '1 hour' },
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
