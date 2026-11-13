/**
 * Outage classification for the rack's sensor path (13 Nov 2026, Destiny — Jason on 408M, 2 Nov,
 * C0BT41XUWG7 1793290686.159989: "encode the classification ... so 408M becomes the reference pattern").
 *
 * Pure: no database, no network. Jegan's method (his 2 Nov post, 1793617155.681509), as code:
 *   - an outage of the sensor path is a window where the UNO board's health is stale (under 80);
 *   - the Pi stale in the same window makes it a gateway event, the Pi healthy makes it a board event;
 *   - a gateway event the Pi's boot record shows as a power loss is POWER_CUT; one inside the boot
 *     record's coverage with no reboot is GATEWAY_LINK (the Pi stayed up and its link dropped);
 *     one before the boot record existed cannot be told apart from the API, so it is left unresolved
 *     with both candidates named, until the Pi journal (an annotation) settles it;
 *   - a board event is BOARD_HARDWARE or VALVE_COIL only from an annotation (a builder's log or the Pi
 *     journal); without one it is unresolved, never guessed;
 *   - a deploy or clean reboot on the boot record is its own incident, DEPLOY_REBOOT or CLEAN_REBOOT.
 *
 * The stability rule for a run (Jegan's November run, 2 Nov): power cuts the unit recovered from on its
 * own, deploy reboots and clean reboots are excluded; gateway link drops, board hardware and valve coil
 * outages count. An unresolved outage inside the run counts until it is resolved, because it may be a
 * link drop and an SLA must not quietly assume the kinder reading. Changing a rule is a decision from
 * Jason, then an edit to RULE here, the doc (docs/contracts/outage-classification.md) and the tests.
 */

export const OUTAGE_TYPES = ['POWER_CUT', 'GATEWAY_LINK', 'BOARD_HARDWARE', 'VALVE_COIL', 'DEPLOY_REBOOT', 'CLEAN_REBOOT'] as const;
export type OutageType = (typeof OUTAGE_TYPES)[number];

/** Which outage types count against a run, and which are excluded, with the reason in words. */
export const RULE = {
  counts: ['GATEWAY_LINK', 'BOARD_HARDWARE', 'VALVE_COIL'] as OutageType[],
  excluded: {
    POWER_CUT: 'site mains power, which the unit recovered from on its own',
    DEPLOY_REBOOT: 'our own deploy, logged as ours',
    CLEAN_REBOOT: 'a planned, clean reboot',
  } as Partial<Record<OutageType, string>>,
  unresolved_counts: true,
};

export interface Window { start: string; end: string }
export interface BootRecord {
  /** When the Pi came back. */
  at: string;
  cause: 'deploy' | 'clean' | 'power_loss';
  down_s: number;
  /** Power loss only: when the Pi was last alive before it went down. */
  last_alive?: string;
}
export interface Annotation extends Window { outage_type: OutageType; source: string }

export interface ClassifyInput {
  /** Windows where the UNO board's health was stale. */
  board: Window[];
  /** Windows where the Pi's own health was stale. */
  pi: Window[];
  boot: BootRecord[];
  /** From when the Pi's boot record exists; before it, a gateway event's cause cannot be read from it. */
  boot_record_since: string | null;
  annotations?: Annotation[];
  /** The window being judged, e.g. the 16 Oct burn-in start to now. */
  from?: string;
  to?: string;
  run?: { name: string; start: string };
}

export interface Incident {
  start: string;
  end: string;
  duration_min: number;
  path: 'gateway' | 'board' | 'pi_only';
  outage_type: OutageType | null;
  candidates: OutageType[];
  resolved_by: 'boot_record' | 'annotation' | 'boot_record_no_reboot' | null;
  needs: string | null;
  source: string | null;
  counts_against_run: boolean | null;
  reason: string;
}

const ms = (s: string) => Date.parse(s);
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const overlaps = (a: Window, b: Window) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
const minutes = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 60000);

function bootWindow(b: BootRecord): Window {
  const back = ms(b.at);
  const start = b.cause === 'power_loss' && b.last_alive ? ms(b.last_alive) : back - b.down_s * 1000;
  return { start: iso(start), end: iso(back) };
}

function judge(type: OutageType | null, start: string, run?: { name: string; start: string }): { counts: boolean | null; why: string } {
  if (!run) return { counts: null, why: 'no run given' };
  if (ms(start) < ms(run.start)) return { counts: false, why: `before the ${run.name} started` };
  if (type === null) return { counts: RULE.unresolved_counts, why: 'unresolved: counted until it is shown to be an excluded kind' };
  if (RULE.counts.includes(type)) return { counts: true, why: `${type} counts against the ${run.name}` };
  return { counts: false, why: `excluded: ${RULE.excluded[type] ?? type}` };
}

export function classify(input: ClassifyInput): { incidents: Incident[]; summary: ReturnType<typeof summarise> } {
  const from = input.from ? ms(input.from) : -Infinity;
  const to = input.to ? ms(input.to) : Infinity;
  const inRange = (w: Window) => ms(w.start) >= from && ms(w.start) <= to;
  const notes = input.annotations ?? [];
  const since = input.boot_record_since ? ms(input.boot_record_since) : Infinity;
  const used = new Set<BootRecord>();
  const out: Incident[] = [];

  for (const w of input.board.filter(inRange)) {
    const gateway = input.pi.some((p) => overlaps(p, w));
    const note = notes.find((a) => overlaps(a, w));
    let type: OutageType | null = null;
    let candidates: OutageType[] = [];
    let resolved: Incident['resolved_by'] = null;
    let needs: string | null = null;
    let source: string | null = null;
    if (gateway) {
      const power = input.boot.find((b) => b.cause === 'power_loss' && overlaps(bootWindow(b), w));
      if (power) { type = 'POWER_CUT'; resolved = 'boot_record'; source = `boot record: power loss, back ${power.at}, ${power.down_s} s down`; used.add(power); }
      else if (note && (note.outage_type === 'POWER_CUT' || note.outage_type === 'GATEWAY_LINK')) { type = note.outage_type; resolved = 'annotation'; source = note.source; }
      else if (ms(w.start) >= since) { type = 'GATEWAY_LINK'; resolved = 'boot_record_no_reboot'; source = 'boot record shows no reboot: the Pi stayed up and its link dropped'; }
      else { candidates = ['POWER_CUT', 'GATEWAY_LINK']; needs = 'the Pi journal for this window (before the boot record existed)'; }
    } else if (note && (note.outage_type === 'BOARD_HARDWARE' || note.outage_type === 'VALVE_COIL')) {
      type = note.outage_type; resolved = 'annotation'; source = note.source;
    } else {
      candidates = ['BOARD_HARDWARE', 'VALVE_COIL']; needs = 'a builder log or Pi journal naming the cause';
    }
    const j = judge(type, w.start, input.run);
    out.push({
      start: w.start, end: w.end, duration_min: minutes(w.start, w.end), path: gateway ? 'gateway' : 'board',
      outage_type: type, candidates, resolved_by: resolved, needs, source, counts_against_run: j.counts, reason: j.why,
    });
  }

  for (const b of input.boot) {
    if (used.has(b)) continue;
    const w = bootWindow(b);
    if (!inRange(w)) continue;
    const type: OutageType = b.cause === 'deploy' ? 'DEPLOY_REBOOT' : b.cause === 'clean' ? 'CLEAN_REBOOT' : 'POWER_CUT';
    const staled = input.board.some((x) => overlaps(x, w));
    const j = judge(type, w.start, input.run);
    out.push({
      start: w.start, end: w.end, duration_min: Math.round(b.down_s / 60), path: 'pi_only', outage_type: type, candidates: [],
      resolved_by: 'boot_record', needs: null, source: `boot record: ${b.cause}, ${b.down_s} s down${staled ? ', the board was stale too' : ', the board did not go stale'}`,
      counts_against_run: j.counts, reason: j.why,
    });
  }

  out.sort((a, b) => ms(a.start) - ms(b.start));
  return { incidents: out, summary: summarise(out, input.run) };
}

function summarise(incidents: Incident[], run?: { name: string; start: string }) {
  const by_type: Record<string, { count: number; minutes: number }> = {};
  for (const i of incidents) {
    const k = i.outage_type ?? `UNRESOLVED (${i.candidates.join(' or ')})`;
    by_type[k] = by_type[k] ?? { count: 0, minutes: 0 };
    by_type[k].count += 1;
    by_type[k].minutes += i.duration_min;
  }
  const sensor = incidents.filter((i) => i.path !== 'pi_only');
  const counted = run ? incidents.filter((i) => i.counts_against_run === true) : [];
  const excluded = run ? incidents.filter((i) => i.counts_against_run === false && ms(i.start) >= ms(run.start)) : [];
  return {
    sensor_path_outages: sensor.length,
    gateway: sensor.filter((i) => i.path === 'gateway').length,
    board: sensor.filter((i) => i.path === 'board').length,
    reboots_without_outage: incidents.filter((i) => i.path === 'pi_only').length,
    unresolved: incidents.filter((i) => i.outage_type === null).length,
    by_type,
    run: run ? {
      name: run.name, start: run.start,
      counted: counted.map((i) => ({ start: i.start, outage_type: i.outage_type, duration_min: i.duration_min })),
      counted_minutes: counted.reduce((s, i) => s + i.duration_min, 0),
      excluded: excluded.map((i) => ({ start: i.start, outage_type: i.outage_type, duration_min: i.duration_min, reason: i.reason })),
      excluded_minutes: excluded.reduce((s, i) => s + i.duration_min, 0),
    } : null,
  };
}

/**
 * The 408M reference dataset: Jegan's production read of 2 Nov 2026 (C0BT41XUWG7 1793617155.681509),
 * burn-in 16 Oct 13:01 UTC to 2 Nov, November run from 29 Oct with the plants. The Pi windows for the
 * five gateway events are the board windows (he reports them stale together). The annotations are the
 * causes he named from Kavin's log and the board replacement (EREM); nothing here is inferred.
 */
export const REFERENCE_408M: ClassifyInput = {
  from: '2026-10-16T13:01:00Z',
  to: '2026-11-02T23:59:59Z',
  boot_record_since: '2026-10-29T09:40:00Z',
  run: { name: 'November run', start: '2026-10-29T00:00:00Z' },
  board: [
    { start: '2026-10-19T15:44:00Z', end: '2026-10-19T16:24:00Z' },
    { start: '2026-10-20T13:26:00Z', end: '2026-10-20T14:11:00Z' },
    { start: '2026-10-21T00:56:00Z', end: '2026-10-21T08:55:00Z' },
    { start: '2026-10-21T15:59:00Z', end: '2026-10-21T16:19:00Z' },
    { start: '2026-10-21T16:44:00Z', end: '2026-10-21T21:29:00Z' },
    { start: '2026-10-28T10:53:00Z', end: '2026-10-28T11:08:00Z' },
    { start: '2026-10-30T16:30:00Z', end: '2026-10-31T07:35:00Z' },
    { start: '2026-11-02T05:50:00Z', end: '2026-11-02T06:06:00Z' },
  ],
  pi: [
    { start: '2026-10-19T15:44:00Z', end: '2026-10-19T16:24:00Z' },
    { start: '2026-10-20T13:26:00Z', end: '2026-10-20T14:11:00Z' },
    { start: '2026-10-21T16:44:00Z', end: '2026-10-21T21:29:00Z' },
    { start: '2026-10-30T16:30:00Z', end: '2026-10-31T07:35:00Z' },
    { start: '2026-11-02T05:50:00Z', end: '2026-11-02T06:06:00Z' },
  ],
  boot: [
    { at: '2026-10-29T09:40:00Z', cause: 'deploy', down_s: 289 },
    { at: '2026-10-29T10:43:00Z', cause: 'clean', down_s: 597 },
    { at: '2026-10-30T06:58:00Z', cause: 'deploy', down_s: 85 },
    { at: '2026-10-31T07:23:00Z', cause: 'power_loss', down_s: 54683, last_alive: '2026-10-30T16:12:00Z' },
    { at: '2026-11-02T08:26:00Z', cause: 'deploy', down_s: 26 },
  ],
  annotations: [
    { start: '2026-10-21T00:56:00Z', end: '2026-10-21T08:55:00Z', outage_type: 'BOARD_HARDWARE', source: "Jegan 2 Nov: the UNO's USB port failure and the board replacement (EREM)" },
    { start: '2026-10-21T15:59:00Z', end: '2026-10-21T16:19:00Z', outage_type: 'BOARD_HARDWARE', source: 'Jegan 2 Nov: the board replacement (EREM)' },
    { start: '2026-10-28T10:53:00Z', end: '2026-10-28T11:08:00Z', outage_type: 'VALVE_COIL', source: "Jegan 2 Nov, from Kavin's log: drain valve coil spike, fix on J660" },
  ],
};
