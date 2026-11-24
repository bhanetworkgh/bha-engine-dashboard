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
  /** Heap growth seen in the samples this timer ran in, in MB, since the process started. */
  memory: { grew_mb: number; samples: number; largest_mb: number };
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
  { name: 'outside digest check', what: 'Posts to #bha-pipeline-errors once when the day\'s BHA RSS digest has not arrived by 08:00 UTC', every: '30 minutes' },
  { name: 'genie skip-warn watch', what: 'Reads Genie\'s log for ledger skip warnings, records each as an engine event, and alerts once when one workspace falls back 3 times in 7 days', every: '15 minutes' },
  { name: 'logstream sweep', what: 'Writes Logstream rows and acts on faults that crossed a threshold', every: '5 minutes' },
  { name: 'research signals', what: 'Finds signals that ask for research and opens one job each, within the daily budget', every: '5 minutes' },
  { name: 'skill watch', what: 'Once a day reads the skills on every agent\'s live version and alerts when one has gone, or when an agent cannot be read', every: '1 hour' },
  { name: 'publish check', what: 'Asks for an eval run after an agent version change and alerts if it regressed', every: '2 minutes' },
  { name: 'intake-2 follow-ups', what: 'Sends the Stage 2 follow-up emails at 3 and 7 days and marks a lead Unresponsive at 14', every: '15 minutes' },
  { name: 'pattern capture', what: 'Turns a failure the repair bridge found no build pattern for into one pattern candidate per fault', every: '10 minutes' },
  { name: 'decision watch', what: 'Checks watched decisions and posts a reminder where one has gone quiet past its wait', every: '5 minutes' },
  { name: 'draft eval orphan sweep', what: 'Marks a draft eval interrupted when no live process holds it, so a deploy cannot leave one running for good', every: '1 minute' },
  { name: 'change announcements', what: 'Posts a progress or completion report in #bha-coordination when a loop or Decision Watch changes', every: '5 minutes' },
  { name: 'blocker alerts', what: 'Monday and Friday from 14:00 UTC, tags each person a blocked loop waits on in #bha-coordination as Genie, and writes their thread reply onto the loops', every: '15 minutes' },
  { name: 'held pay watch', what: 'Checks new evidence against held pay and posts a release card in #bha-pay-reviews when it matches', every: '5 minutes' },
  { name: 'genie approvals sweep', what: 'Expires Genie change requests nobody decided in 24 hours, and marks a build nobody rated in 48 hours as not rated', every: '15 minutes' },
  { name: 'loop convergence', what: 'Flags in Logstream a loop or watch with 3 or more progress posts in 7 days and no close', every: '30 minutes' },
  { name: 'pattern trust incident sweep', what: 'Counts an incident on a workflow a Genie build changed within 14 days as a down for the patterns that build used', every: '1 hour' },
  { name: 'intent heal', what: 'Closes a Bays intent-check incident as fixed by the engine when the same ask then passed and landed on the same record', every: '5 minutes' },
  { name: 'codex log gap', what: 'DMs a regular builder once when no Codex log of theirs has reached the engine in 30 hours, with a copy to Destiny', every: '1 hour' },
  { name: 'renewal reminder', what: 'Posts a card in #bha-engine-alerts 7, 3 and 1 day before a paid tool renews, and rolls passed renewal dates forward', every: '1 hour' },
  { name: 'code check watch', what: 'DMs Destiny when Jason approves a log that is owed a code check, then reminds every 3 hours until the check is recorded, and records a prepared check when it is sent', every: '2 minutes' },
  { name: 'sop check', what: 'Checks every new Codex log against the vFarm hardware modularity SOP, asks the author why when a part swap has no service entry, and saves their answer on the log', every: '2 minutes' },
  { name: 'slack apps read', what: 'Once a day reads every Slack app on the workspace, its slash commands and its manifest, for the System registry', every: '1 hour' },
  { name: 'apify usage watch', what: 'Reads Apify\'s usage for the month and posts once at 50%, 80% and 100% of the plan, and once when the month is on pace to run out early', every: '1 hour' },
  { name: 'model spend reading', what: 'Reads OpenRouter\'s usage counter for the Model spend page', every: '1 hour' },
  { name: 'retention', what: 'Clears personal text past its retention period (acts once a week)', every: '6 hours' },
];

const state = new Map<string, { last: string; ticks: number }>();
export const STARTED_AT = new Date().toISOString();

/**
 * Memory measuring (23 Nov 2026, Destiny). The process crashed out of heap three times in
 * 12 days, and the total alone cannot say which job is heavy. Every SAMPLE_MS the heap is
 * read; any growth since the last sample is shared between the timers that ticked in that
 * window, or put down to "requests and other work" when none did. GC makes single samples
 * noisy, so the figures are totals of growth over many windows, read as a ranking, never
 * as an exact cost. Held in memory like the tick counts: a restart starts them again.
 */
const SAMPLE_MS = 10_000;
const SUMMARY_MS = 3_600_000;
const HIGH_HEAP_MB = 320;
const OTHER = 'requests and other work';
const mb = (b: number): number => Math.round((b / 1_048_576) * 10) / 10;
const growth = new Map<string, { grew: number; samples: number; largest: number }>();
let windowNames = new Set<string>();
let lastHeap = process.memoryUsage().heapUsed;
let peakHeap = lastHeap;
let highWarnedAt = 0;

function credit(name: string, bytes: number): void {
  const g = growth.get(name) ?? { grew: 0, samples: 0, largest: 0 };
  g.grew += bytes;
  g.samples += 1;
  if (bytes > g.largest) g.largest = bytes;
  growth.set(name, g);
}

export function memoryTop(n = 8): Array<{ name: string; grew_mb: number; samples: number; largest_mb: number }> {
  return [...growth.entries()]
    .map(([name, g]) => ({ name, grew_mb: mb(g.grew), samples: g.samples, largest_mb: mb(g.largest) }))
    .sort((a, b) => b.grew_mb - a.grew_mb)
    .slice(0, n);
}

function sample(): void {
  try {
    const m = process.memoryUsage();
    const delta = m.heapUsed - lastHeap;
    lastHeap = m.heapUsed;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    const names = windowNames.size ? [...windowNames] : [OTHER];
    windowNames = new Set();
    if (delta > 0) for (const name of names) credit(name, delta / names.length);
    if (mb(m.heapUsed) >= HIGH_HEAP_MB && Date.now() - highWarnedAt > 10 * 60_000) {
      highWarnedAt = Date.now();
      console.warn(
        `[memory] heap ${mb(m.heapUsed)} MB (rss ${mb(m.rss)} MB) is past ${HIGH_HEAP_MB} MB; ran in the last ${SAMPLE_MS / 1000}s: ${names.join(', ')}; most growth so far: ${memoryTop(5).map((t) => `${t.name} ${t.grew_mb} MB`).join('; ')}`,
      );
    }
  } catch {
    /* measuring must never break the process */
  }
}

function summary(): void {
  try {
    const m = process.memoryUsage();
    console.log(
      `[memory] hourly: heap ${mb(m.heapUsed)} MB of ${mb(m.heapTotal)} MB, peak ${mb(peakHeap)} MB, rss ${mb(m.rss)} MB, since ${STARTED_AT}; most growth: ${memoryTop(8).map((t) => `${t.name} ${t.grew_mb} MB over ${t.samples} samples (largest ${t.largest_mb})`).join('; ') || 'none yet'}`,
    );
  } catch {
    /* never throws */
  }
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(sample, SAMPLE_MS).unref();
  setInterval(summary, SUMMARY_MS).unref();
}

/** Called at the top of a timer's tick. Never throws. */
export function beat(name: string): void {
  const s = state.get(name);
  const now = new Date().toISOString();
  if (s) {
    s.last = now;
    s.ticks += 1;
  } else state.set(name, { last: now, ticks: 1 });
  windowNames.add(name);
}

/** The process's memory now, the peak since it started, and the timers that grew it most. */
export function memory(): { heap_mb: number; heap_total_mb: number; rss_mb: number; peak_heap_mb: number; since: string; sample_seconds: number; top: ReturnType<typeof memoryTop>; note: string } {
  const m = process.memoryUsage();
  return {
    heap_mb: mb(m.heapUsed),
    heap_total_mb: mb(m.heapTotal),
    rss_mb: mb(m.rss),
    peak_heap_mb: mb(peakHeap),
    since: STARTED_AT,
    sample_seconds: SAMPLE_MS / 1000,
    top: memoryTop(12),
    note: 'Growth in each 10 second window is shared between the timers that ticked in it; a ranking of what grows the heap, not an exact cost per job. "requests and other work" is growth when no timer ticked.',
  };
}

export function list(): TimerInfo[] {
  const names = new Set([...KNOWN.map((k) => k.name), ...state.keys()]);
  return [...names].map((name) => {
    const k = KNOWN.find((x) => x.name === name);
    const s = state.get(name);
    const g = growth.get(name);
    return {
      name,
      what: k?.what ?? 'Not described',
      every: k?.every ?? 'not recorded',
      last_tick_at: s?.last ?? null,
      ticks: s?.ticks ?? 0,
      memory: { grew_mb: g ? mb(g.grew) : 0, samples: g?.samples ?? 0, largest_mb: g ? mb(g.largest) : 0 },
    };
  });
}
