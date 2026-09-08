/**
 * Every read the dashboard makes, derived here. One function per section,
 * each taking the lane filter and returning one object in the shapes from
 * src/data/types.ts.
 *
 * Incidents, twins, vFarm and builders still come from the phase 1 fixtures;
 * loops, Codex entries, patterns and commercial cards come from the store so
 * a status changed in the interface is the status every screen sees. When the
 * engine endpoint lands, the fixture reads here become fetches and the shapes
 * stay the same.
 */
import * as f from '../../src/data/fixtures';
import type {
  AskBaysData,
  BuilderDetail,
  BuildersData,
  BuildPatternsData,
  CodexData,
  CommercialData,
  EngineHealthData,
  EngineStatus,
  ErrorClass,
  IncidentState,
  Lane,
  LaneFilter,
  Loop,
  OpenLoopsData,
  OverviewData,
  Query,
  SeriesPoint,
  TwinData,
  VFarmData,
} from '../../src/data/types';
import { MODEL_LABEL, askConfigured } from './ask';
import * as store from './store';

/** Reference date the fixtures are written against. */
const REF_DATE = '2026-09-07';

export const LANES: Lane[] = ['VFARM_CORE', 'VFARM_MEDIA', 'CLIENT_CORE', 'ENGINE_INTERNAL'];

export function parseLane(v: string | null | undefined): LaneFilter {
  return v && (LANES as string[]).includes(v) ? (v as Lane) : 'all';
}

export function daysToHalloween(now = new Date()): number {
  const y = now.getFullYear();
  let target = new Date(y, 9, 31);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (target < start) target = new Date(y + 1, 9, 31);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

function laneMatch(q: Query, lane: Lane): boolean {
  return q.lane === 'all' || q.lane === lane;
}
function byLane<T extends { lane: Lane }>(rows: T[], q: Query): T[] {
  return rows.filter((r) => laneMatch(q, r.lane));
}
function bySpineLane<T extends { spine: { lane: Lane } }>(rows: T[], q: Query): T[] {
  return rows.filter((r) => laneMatch(q, r.spine.lane));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function lastDays(end: string, n: number): string[] {
  const out: string[] = [];
  const e = new Date(`${end}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(e);
    d.setUTCDate(e.getUTCDate() - i);
    out.push(isoDay(d));
  }
  return out;
}
function countByDay(days: string[], dates: string[]): SeriesPoint[] {
  return days.map((day) => ({ label: day.slice(5), value: dates.filter((d) => d.slice(0, 10) === day).length }));
}

/* ---------------------------------------------------------------- status */

export function getEngineStatus(q: Query): EngineStatus {
  const inc = bySpineLane(f.INCIDENTS, q);
  const open = inc.filter((i) => i.state !== 'resolved' && i.state !== 'failed').length;
  const failing = inc.some((i) => i.health === 'failing' && i.state !== 'resolved');
  return {
    last_refresh: '2026-09-07 14:12',
    health: failing ? 'failing' : open > 0 ? 'degraded' : 'ok',
    note: failing
      ? 'Ask Cluster is returning a wrapped 402 — BHARAG credit exhausted.'
      : open > 0
        ? 'Retries pending on the Research Twin BHARAG call.'
        : null,
    open_incidents: open,
  };
}

/* -------------------------------------------------------------- overview */

export function getOverview(q: Query): OverviewData {
  const allLoops = store.loops();
  const loopById = (id: string): Loop => allLoops.find((l) => l.id === id) ?? allLoops[0];
  const loops = byLane(allLoops, q);
  const openLoops = loops.filter((l) => l.status !== 'closed');
  const incidents = bySpineLane(f.INCIDENTS, q);
  const openIncidents = incidents.filter((i) => i.state !== 'resolved' && i.state !== 'failed');
  const owners = store.loopsByOwner();
  const totalOpen = q.lane === 'all' ? owners.reduce((n, o) => n + o.open + o.in_progress, 0) : openLoops.length;
  const oldest = Math.max(...(openLoops.length ? openLoops.map((l) => l.age_days) : [0]));
  const entries = bySpineLane(store.codexEntries(), q);
  const entriesThisWeek = entries.filter((e) => e.week === '2026-W36').length;
  const ingested = entries.filter((e) => e.ingested).length;
  const openAlerts = f.VFARM_ALERTS.filter((a) => a.state === 'open');
  const vfarmVisible = q.lane === 'all' || q.lane === 'VFARM_CORE';

  const ns = bySpineLane(f.NS_RECORDS, q);
  const rt = bySpineLane(f.RT_RECORDS, q);
  const asks = [...ns, ...rt];
  const answered = asks.filter((a) => a.outcome === 'answered').length;
  const thin = asks.filter((a) => a.outcome === 'thin').length;
  const failed = asks.filter((a) => a.outcome === 'failed').length;

  const resolved = incidents.filter((i) => i.state === 'resolved').length;
  const selfHealed = incidents.filter((i) => i.tags.self_healed).length;
  const retriesAttempted = incidents.reduce((n, i) => n + i.retries_attempted, 0);
  const retriesSucceeded = incidents.reduce(
    (n, i) => n + i.actions.filter((a) => a.action_type === 'retry' && a.outcome === 'ok').length,
    0,
  );

  const days7 = lastDays(REF_DATE, 7);
  const days14 = lastDays(REF_DATE, 14);
  const incidents7d = countByDay(days7, incidents.map((i) => i.opened_at));
  const loops14d = countByDay(days14, loops.map((l) => l.raised_at));
  const nsByDay = countByDay(days7, ns.map((r) => r.at)).map((p) => p.value);
  const rtByDay = countByDay(days7, rt.map((r) => r.at)).map((p) => p.value);

  const weeks = [...new Set(entries.map((e) => e.week))].sort();
  const entriesByWeek: SeriesPoint[] = weeks.map((w) => ({ label: w.replace('2026-', ''), value: entries.filter((e) => e.week === w).length }));

  const classes: ErrorClass[] = ['BILLING_QUOTA', 'NETWORK_TIMEOUT', 'SCHEMA_VALIDATION', 'CONFIG_AUTH', 'UNKNOWN'];
  const states: IncidentState[] = ['new', 'triage', 'auto-retry pending', 'resolved', 'failed', 'escalated to RT', 'escalated to human'];

  const opps = byLane(store.opportunities(), q).filter((o) => o.readiness !== 'closed');
  const builders = byLane(f.BUILDERS, q);
  const patterns = byLane(store.patterns(), q).filter((p) => p.status === 'active');

  return {
    pins: [
      { label: 'Days to Halloween', value: String(daysToHalloween()), health: 'ok', accent: true },
      { label: 'vFarm status', value: vfarmVisible ? `${openAlerts.length} alerts open` : 'filtered out', health: vfarmVisible && openAlerts.length ? 'degraded' : 'ok' },
      { label: 'Open incidents', value: String(openIncidents.length), health: openIncidents.some((i) => i.health === 'failing') ? 'failing' : openIncidents.length ? 'degraded' : 'ok' },
      { label: 'Open loops', value: String(totalOpen), health: totalOpen > 200 ? 'degraded' : 'ok' },
      { label: 'Entries this week', value: String(entriesThisWeek), health: 'ok' },
    ],
    tiles: [
      { key: 'north-star', label: 'North Star', to: '/north-star', headline: String(ns.length), sublabel: 'asks this period', signal: `${bySpineLane(f.NS_GAPS, q).length} unanswered`, health: bySpineLane(f.NS_GAPS, q).length > 3 ? 'degraded' : 'ok', trend: nsByDay, share: { value: ns.filter((r) => r.outcome === 'answered').length, total: ns.length, label: 'answered' } },
      { key: 'research-twin', label: 'Research Twin', to: '/research-twin', headline: String(rt.length), sublabel: 'asks this period', signal: `${bySpineLane(f.RT_GAPS, q).length} unanswered`, health: bySpineLane(f.RT_GAPS, q).length > 3 ? 'degraded' : 'ok', trend: rtByDay, share: { value: rt.filter((r) => r.outcome === 'answered').length, total: rt.length, label: 'answered' } },
      { key: 'vfarm', label: 'vFarm', to: '/vfarm', headline: vfarmVisible ? String(f.VFARM_PLACES.length) : '0', sublabel: 'places reporting', signal: vfarmVisible ? `${openAlerts.length} alerts open · lifecycle not emitting` : 'filtered out', health: vfarmVisible && openAlerts.length ? 'degraded' : 'ok' },
      { key: 'engine-health', label: 'Engine health', to: '/engine-health', headline: String(openIncidents.length), sublabel: 'incidents open', signal: openIncidents.some((i) => i.error_class === 'BILLING_QUOTA') ? 'quota exhausted upstream' : 'retries pending', health: openIncidents.some((i) => i.health === 'failing') ? 'failing' : openIncidents.length ? 'degraded' : 'ok', trend: incidents7d.map((p) => p.value), share: { value: selfHealed, total: resolved, label: 'self-healed' } },
      { key: 'open-loops', label: 'Open loops', to: '/open-loops', headline: String(totalOpen), sublabel: 'open', signal: `oldest ${oldest} days`, health: oldest > 30 ? 'degraded' : 'ok', trend: loops14d.map((p) => p.value) },
      { key: 'codex', label: 'Codex entries', to: '/codex', headline: String(entriesThisWeek), sublabel: 'logged this week', signal: `${entries.filter((e) => !e.ingested).length} posted, not ingested`, health: 'ok', trend: entriesByWeek.map((p) => p.value), share: { value: ingested, total: entries.length, label: 'ingested' } },
      { key: 'build-patterns', label: 'Build patterns', to: '/build-patterns', headline: String(patterns.length), sublabel: 'patterns', signal: 'reference counts are cumulative', health: 'ok' },
      { key: 'commercial', label: 'Commercial', to: '/commercial', headline: String(opps.length), sublabel: 'opportunities', signal: `${opps.filter((o) => o.readiness === 'blocked').length} blocked`, health: opps.some((o) => o.readiness === 'blocked') ? 'failing' : 'ok', share: { value: opps.filter((o) => o.readiness === 'ready to pitch').length, total: opps.length, label: 'ready to pitch' } },
      { key: 'builders', label: 'Builders', to: '/builders', headline: String(builders.length), sublabel: 'people', signal: `${builders.filter((b) => b.contract_status !== 'signed').length} contract not signed`, health: builders.some((b) => b.contract_status !== 'signed') ? 'degraded' : 'ok' },
    ],
    series: {
      loops_raised_14d: loops14d,
      incidents_7d: incidents7d,
      entries_by_week: entriesByWeek,
      asks_by_outcome: { answered, thin, failed },
      loops_by_owner:
        q.lane === 'all'
          ? owners
          : owners
              .map((o) => ({
                ...o,
                open: openLoops.filter((l) => l.owner === o.owner && l.status === 'open').length,
                in_progress: openLoops.filter((l) => l.owner === o.owner && l.status === 'in progress').length,
              }))
              .filter((o) => o.open + o.in_progress > 0),
      incidents_by_class: classes
        .map((c) => ({ error_class: c, n: incidents.filter((i) => i.error_class === c).length, open: openIncidents.filter((i) => i.error_class === c).length }))
        .filter((r) => r.n > 0),
      incidents_by_state: states.map((s) => ({ state: s, n: incidents.filter((i) => i.state === s).length })).filter((r) => r.n > 0),
    },
    rates: {
      self_heal: { value: selfHealed, total: resolved },
      answered: { value: answered, total: asks.length },
      ingested: { value: ingested, total: entries.length },
      retries: { value: retriesSucceeded, total: retriesAttempted },
    },
    broke_24h: [
      { id: 'B1', at: '11:42', title: 'Ask Cluster returning a wrapped 402', detail: 'BHARAG credit exhausted. No retry attempted — billing never auto-retries.', health: 'failing', spine: f.INCIDENTS[0].spine, source: f.INCIDENTS[0].source },
      { id: 'B2', at: '09:15', title: 'Research Twin cannot resolve bharag2', detail: 'ENOTFOUND on two of three retries. Third pending.', health: 'degraded', spine: f.INCIDENTS[1].spine, source: f.INCIDENTS[1].source },
      { id: 'B3', at: '13:48', title: 'pH above ceiling on rack-a/tier-3', detail: 'Held at 6.31 across three consecutive rollups.', health: 'degraded', spine: f.VFARM_ALERTS[0].spine, source: f.VFARM_ALERTS[0].source },
      { id: 'B4', at: '09:06', title: 'Burn-in bench above temperature ceiling', detail: '23.1°C for 21 minutes against a 22.6°C ceiling.', health: 'degraded', spine: f.VFARM_ALERTS[1].spine, source: f.VFARM_ALERTS[1].source },
      { id: 'B5', at: '08:14', title: 'Kaiqi digest disagreed with Kaiqi table', detail: 'Digest named three loops; the table returned none. Raised for reconciliation.', health: 'degraded', spine: loopById('LOOP-1788787118330-A6RT').spine, source: loopById('LOOP-1788787118330-A6RT').source },
      { id: 'B6', at: '07:55', title: 'Commercial extractor hit its retry ceiling', detail: 'Three attempts, all failed. Classifier never derived a fix lane.', health: 'failing', spine: f.INCIDENTS[7].spine, source: f.INCIDENTS[7].source },
      { id: 'B7', at: '06:20', title: 'Four Codex entries posted without ingest', detail: 'Reached Slack but not BHARAG, so no twin can cite them.', health: 'degraded', spine: f.CODEX_ENTRIES[3].spine, source: f.CODEX_ENTRIES[3].source },
      { id: 'B8', at: '05:02', title: 'Founding-buyer card still blocked', detail: 'No authorised payment account. Unchanged for 31 days.', health: 'failing', spine: f.OPPORTUNITIES[0].spine, source: f.OPPORTUNITIES[0].source },
      { id: 'B9', at: '02:41', title: 'Two loops named by the digest exist in no table', detail: 'Present in the Sept 7 digest, absent from all seven builder tables.', health: 'degraded', spine: loopById('LOOP-1786885900326-2NLZ').spine, source: loopById('LOOP-1786885900326-2NLZ').source },
      { id: 'B10', at: '23:52', title: 'Ledger batch ingest rejected on schema', detail: 'incidents.v0 is strict; an added field fails the whole batch.', health: 'degraded', spine: f.INCIDENTS[2].spine, source: f.INCIDENTS[2].source },
      { id: 'B11', at: '22:18', title: 'Research Twin quarantined an ask at three cycles', detail: 'Evidence stayed thin across three narrowing passes; handed to a human.', health: 'degraded', spine: f.RT_RECORDS[4].spine, source: f.RT_RECORDS[4].source },
    ],
    moved_24h: [
      { id: 'M1', at: '14:02', title: 'North Star credential rotated', detail: 'INC-5A3C77 resolved after 26 hours of silent failure.', health: 'ok', spine: f.INCIDENTS[3].spine, source: f.INCIDENTS[3].source },
      { id: 'M2', at: '11:20', title: 'Four blocking loops identified', detail: 'Bays narrowed 96 open loops to the 4 that block telemetry v1.', health: 'ok', spine: f.LOOPS[0].spine, source: f.LOOPS[0].source },
      { id: 'M3', at: '10:07', title: 'Ledger corpora confirmed current', detail: 'vfarm.sensor and vfarm.alert both current, dead-letter queue at zero.', health: 'ok', spine: f.VFARM_ALERTS[2].spine, source: f.VFARM_ALERTS[2].source },
      { id: 'M4', at: '08:17', title: 'Codex digest self-healed', detail: 'Empty render caught by assertion; second attempt posted.', health: 'ok', spine: f.INCIDENTS[4].spine, source: f.INCIDENTS[4].source },
      { id: 'M5', at: '23:15', title: 'Three Codex entries ingested', detail: 'Destiny, Jegan and Kaiqi entries reached BHARAG rather than only posting.', health: 'ok', spine: f.CODEX_ENTRIES[0].spine, source: f.CODEX_ENTRIES[0].source },
      { id: 'M6', at: '13:00', title: 'Per-builder loop digests delivered', detail: 'Seven builders, one digest each, prioritised by North Star.', health: 'ok', spine: f.LOOPS[5].spine, source: f.LOOPS[5].source },
      { id: 'M7', at: '11:38', title: 'Ambient range question answered after going thin', detail: 'Two cycles. First transition recorded on the Research Twin gaps tab.', health: 'ok', spine: f.RT_TRANSITIONS[0].spine, source: f.RT_TRANSITIONS[0].source },
      { id: 'M8', at: '10:30', title: 'pH by place confirmed present in the ledger', detail: 'Twenty-four hours of rollups readable across four places.', health: 'ok', spine: f.RT_RECORDS[0].spine, source: f.RT_RECORDS[0].source },
      { id: 'M9', at: '09:20', title: 'Watched clients weekly clock completed', detail: 'Three client memos posted; contradiction state updated on Client 9.', health: 'ok', spine: f.INCIDENTS[6].spine, source: f.INCIDENTS[6].source },
      { id: 'M10', at: '08:41', title: 'North Star answered both standing questions', detail: 'Top build lanes and where the Architect should look, both first cycle.', health: 'ok', spine: f.NS_RECORDS[1].spine, source: f.NS_RECORDS[1].source },
      { id: 'M11', at: '21:10', title: 'Research Twin field rename mapped', detail: 'card_id to trace_id at the write node; queue writes green since.', health: 'ok', spine: f.INCIDENTS[5].spine, source: f.INCIDENTS[5].source },
    ],
  };
}

/* -------------------------------------------------------------- ask bays */

export function getAskBays(_q: Query): AskBaysData {
  return {
    threads: f.CHAT_THREADS,
    model_label: MODEL_LABEL,
    connected: askConfigured(),
    builders: f.BUILDERS.map((b) => ({ id: b.id, name: b.name })),
  };
}

/* -------------------------------------------- north star / research twin */

function twin(name: string, records: TwinData['records'], runs: TwinData['runs'], gaps: TwinData['gaps'], transitions: TwinData['transitions'], q: Query): TwinData {
  const r = bySpineLane(records, q);
  const askerCounts = new Map<string, number>();
  for (const x of r) askerCounts.set(x.asked_by, (askerCounts.get(x.asked_by) ?? 0) + 1);
  return {
    name,
    summary: {
      period: 'Last 8 days',
      asks: r.length,
      answered: r.filter((x) => x.outcome === 'answered').length,
      thin: r.filter((x) => x.outcome === 'thin').length,
      failed: r.filter((x) => x.outcome === 'failed').length,
      median_time_to_answer: null,
      median_unavailable_reason: 'Nothing records when an ask was answered, only that it was. Time to answer arrives with telemetry v1.',
      top_askers: [...askerCounts.entries()].map(([builder_id, asks]) => ({ builder_id, asks })).sort((a, b) => b.asks - a.asks).slice(0, 5),
      by_lane: LANES.map((lane) => ({
        lane,
        asks: r.filter((x) => x.spine.lane === lane).length,
        thin: r.filter((x) => x.spine.lane === lane && x.outcome === 'thin').length,
        failed: r.filter((x) => x.spine.lane === lane && x.outcome === 'failed').length,
      })).filter((row) => row.asks > 0),
    },
    records: r,
    runs: bySpineLane(runs, q),
    gaps: bySpineLane(gaps, q),
    transitions: bySpineLane(transitions, q),
    notes: {
      transitions: name === 'North Star' ? 'North Star does not record an ask going thin and later being answered. Nothing writes that transition today.' : undefined,
    },
  };
}

export function getNorthStar(q: Query): TwinData {
  return twin('North Star', f.NS_RECORDS, f.NS_RUNS, f.NS_GAPS, [], q);
}
export function getResearchTwin(q: Query): TwinData {
  return twin('Research Twin', f.RT_RECORDS, f.RT_RUNS, f.RT_GAPS, f.RT_TRANSITIONS, q);
}

/* ----------------------------------------------------------------- vfarm */

export function getVFarm(q: Query): VFarmData {
  const visible = q.lane === 'all' || q.lane === 'VFARM_CORE';
  return {
    readings: visible ? f.VFARM_READINGS : [],
    alerts: visible ? f.VFARM_ALERTS : [],
    places: visible ? f.VFARM_PLACES : [],
    lifecycle: f.VFARM_LIFECYCLE,
    lifecycle_note:
      'Burn-in and growth cycle events are not being emitted. vFarm currently writes sensor rollups, threshold alerts and incident closes to the ledger; no workflow writes a lifecycle event, so there is nothing to show here.',
    readiness_note:
      'Readiness is not computed anywhere yet. The endpoint that would answer it, /clusters/:id/readiness, is specced in the vFarm contract but not built. Until it exists this panel would have to guess, so it does not.',
    days_to_halloween: daysToHalloween(),
  };
}

/* --------------------------------------------------------- engine health */

export function getEngineHealth(q: Query): EngineHealthData {
  const incidents = bySpineLane(f.INCIDENTS, q);
  const retriesAttempted = incidents.reduce((n, i) => n + i.retries_attempted, 0);
  const retriesSucceeded = incidents.reduce((n, i) => n + i.actions.filter((a) => a.action_type === 'retry' && a.outcome === 'ok').length, 0);
  const selfHealed = incidents.filter((i) => i.tags.self_healed).length;
  const resolved = incidents.filter((i) => i.state === 'resolved').length;
  return {
    incidents,
    metrics: {
      self_heal_rate: resolved ? `${Math.round((selfHealed / resolved) * 100)}%` : '—',
      retries_attempted: retriesAttempted,
      retries_succeeded: retriesSucceeded,
      mean_time_to_resolve: '3h 41m',
      escalations: incidents.filter((i) => i.state.startsWith('escalated')).length,
    },
    lanes_at_retry_ceiling: LANES.map((lane) => ({ lane, incidents: incidents.filter((i) => i.spine.lane === lane && i.retries_attempted >= i.max_retries).length })).filter((row) => row.incidents > 0),
  };
}

/* ------------------------------------------------------------ open loops */

export function getOpenLoops(q: Query): OpenLoopsData {
  const loops = byLane(store.loops(), q).sort((a, b) => b.age_days - a.age_days);
  const visibleOwners = new Set(loops.map((l) => l.owner));
  const owners = store.loopsByOwner();
  return {
    loops,
    by_owner: q.lane === 'all' ? owners : owners.filter((o) => visibleOwners.has(o.owner)),
    review_queue: f.REVIEW_QUEUE,
    reconciliation: f.RECONCILIATION,
    reconciliation_note: 'Rows here disagree between the daily digest and the per-builder tables after the September 5 migration. Nothing is corrected automatically.',
    status_history_note: `Age is time since the loop was raised. Status changes made here are recorded since ${(store.historySince() ?? '').slice(0, 10) || 'first boot'}; nothing upstream records them.`,
  };
}

/* ------------------------------- codex / patterns / commercial / builders */

export function getCodexEntries(q: Query): CodexData {
  const entries = bySpineLane(store.codexEntries(), q).sort((a, b) => (a.logged_at < b.logged_at ? 1 : -1));
  const ingested = entries.filter((e) => e.ingested).length;
  return {
    entries,
    this_week: entries.filter((e) => e.week === '2026-W36').length,
    ingested_rate: entries.length ? `${Math.round((ingested / entries.length) * 100)}%` : '—',
  };
}

export function getBuildPatterns(q: Query): BuildPatternsData {
  return {
    patterns: byLane(store.patterns(), q).sort((a, b) => b.references - a.references),
    reference_note: 'Reference counts are cumulative since each pattern was ingested. There is no per-week breakdown — nothing records when a reference happened.',
  };
}

export function getCommercial(q: Query): CommercialData {
  return { opportunities: byLane(store.opportunities(), q) };
}

/** Builders with their open-loop counts read from the owner totals, not the fixture. */
function buildersLive() {
  const owners = store.loopsByOwner();
  return f.BUILDERS.map((b) => {
    const o = owners.find((x) => x.owner === b.id);
    return o ? { ...b, open_loops: o.open + o.in_progress, oldest_loop_days: o.oldest_days } : b;
  });
}

export function getBuilders(q: Query): BuildersData {
  return { builders: byLane(buildersLive(), q) };
}

export function getBuilder(id: string, q: Query): BuilderDetail | null {
  const builder = buildersLive().find((b) => b.id === id);
  if (!builder) return null;
  return {
    builder,
    loops: byLane(store.loops(), q).filter((l) => l.owner === id),
    entries: bySpineLane(store.codexEntries(), q).filter((e) => e.builder_id === id),
    incidents: bySpineLane(f.INCIDENTS, q).filter((i) => i.spine.builder_id === id),
  };
}
