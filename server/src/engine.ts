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
  BuildPatternsData,
  ClientLaneRow,
  ClientsData,
  CodexData,
  CodexEntryDetail,
  CommercialData,
  Lane,
  LaneFilter,
  Handoffs,
  NsData,
  OpenLoopsData,
  OverviewData,
  OverviewTile,
  Query,
  RtData,
  SeriesPoint,
  TwinData,
} from '../../src/data/types';
import { MODEL_LABEL, askConfigured } from './ask';
import * as health from './health';
import { CODEX_CHOICES, CODEX_TABLES, loopTable, questionNeedsHuman, requestIsOpen } from './sources';
import * as store from './store';

/** The builder's loops table id, for inbound payloads that name a builder rather than a table. */
export function loopTableFor(owner: string): string | null {
  return loopTable(owner)?.table ?? null;
}

/** The builder's submissions table id, for the same reason. */
export function codexTableFor(owner: string): string | null {
  return CODEX_TABLES.find((t) => t.owner === owner)?.table ?? null;
}

/** Today, for the live kinds. (The fixtures' own date, 7 Sep, is no longer read by any tile.) */
const REF_TODAY = () => new Date().toISOString().slice(0, 10);

/** The Codex tile's signal, counted by the page's own stage rule rather than by Jason Status alone. */
function awaitingSentence(n: number): string {
  return n === 0 ? 'Nothing is awaiting Jason’s approval.' : `${n} ${n === 1 ? 'is' : 'are'} awaiting Jason’s approval.`;
}

function isoWeekOf(dayStr: string): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y = d.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const w = Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

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

function laneMatch(q: Query, lane: string | null): boolean {
  return q.lane === 'all' || q.lane === lane;
}
function bySpineLane<T extends { spine: { lane: string | null } }>(rows: T[], q: Query): T[] {
  return rows.filter((r) => laneMatch(q, r.spine.lane));
}

/**
 * The four Airtable-backed kinds carry their source's own lane vocabulary
 * (lane_tag, lane_id, bha_system), none of which is the engine's Lane union,
 * so the global lane filter does not apply to them. It was removed from the
 * shell on 2026-09-08 and is 'all' in practice.
 */

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

/* -------------------------------------------------------------- overview */

/**
 * The Overview reads no lane filter any more.
 *
 * It took one so the phase 1 fixtures on this page could be narrowed by lane.
 * Those fixtures are gone from the twins' tiles (2026-09-17) and the rest of
 * this page has read Postgres since the migration, so there is nothing left
 * here that a lane would narrow. The parameter stays in the signature because
 * the route passes it and the shell still holds a lane in session state; it is
 * simply not read, rather than pretending to filter.
 */
export async function getOverview(_q: Query): Promise<OverviewData> {
  const loops = await store.loops();
  const openLoops = loops.filter((l) => l.status !== 'closed');
  const owners = await store.loopsByOwner();
  const totalOpen = openLoops.length;
  const oldest = Math.max(...(openLoops.length ? openLoops.map((l) => l.age_days) : [0]));
  const entries = await store.codexEntries();
  const thisWeek = isoWeekOf(REF_TODAY());
  const entriesThisWeek = entries.filter((e) => e.week === thisWeek).length;
  const ingested = entries.filter((e) => e.has_entry).length;
  const loopsFreshness = await store.freshness('loops');

  /**
   * The twins, read from their own ledgers (2026-09-17) rather than from the
   * phase 1 fixtures that stood here.
   *
   * Those fixtures were the last thing on this page still inventing an ask
   * count, and they were harmless only while the twins genuinely wrote nothing
   * — which stopped being true today. A tile whose headline came from a fixture
   * and whose page now shows real rows is exactly the disagreement section 2
   * forbids.
   */
  const ns = await store.nsAsks();
  const rt = await store.rtAsks();
  const jobs = await store.rtJobs();
  const handoffs = await store.twinHandoffs();
  const asks = [...ns, ...rt];
  const answered = asks.filter((a) => a.outcome === 'Answered').length;
  const thin = asks.filter((a) => a.outcome === 'Thin').length;
  const failed = asks.filter((a) => a.outcome === 'Failed').length;
  const refused = asks.filter((a) => a.outcome === 'Refused (not its lane)').length;
  const needsHuman = rt.filter((a) => a.outcome === 'Needs human').length;
  /**
   * The failure signal on each twin's tile is the one its own page leads with:
   * an answer that never reached anyone, and a job nothing but a person will
   * move. Both are read from the rows, and both are nought until they are not.
   */
  const nsUndelivered = ns.filter((a) => a.delivered === 'Not delivered').length;
  const cappedJobs = jobs.filter((j) => j.capped).length;

  /** Engine Health, for its own tile. Read the same way its page reads it. */
  const healthData = await health.data();
  const healthIncidents = healthData.incidents;
  const healthRetries = healthData.retries;
  const healthLanes = healthData.lanes;

  // The twins' ledgers are live rows, so their week is this week — not the fixture date.
  const days7 = lastDays(REF_TODAY(), 7);
  const days14 = lastDays(REF_TODAY(), 14);
  const loops14d = countByDay(days14, loops.map((l) => l.raised_at).filter((d): d is string => Boolean(d)));
  const nsByDay = countByDay(days7, ns.map((r) => r.asked_at).filter((d): d is string => Boolean(d))).map((p) => p.value);
  const rtByDay = countByDay(days7, rt.map((r) => r.asked_at).filter((d): d is string => Boolean(d))).map((p) => p.value);

  const weeks = [...new Set(entries.map((e) => e.week).filter((w): w is string => Boolean(w)))].sort().slice(-8);
  const entriesByWeek: SeriesPoint[] = weeks.map((w) => ({ label: w.replace(/^\d{4}-/, ''), value: entries.filter((e) => e.week === w).length }));

  const opps = await store.opportunities();
  const patterns = await store.patterns();
  // pattern_status is gone from the base (2026-09-15), so the tile's signal is
  // reusability — the field on that table that actually varies.
  const broad = patterns.filter((p) => p.reusability?.trim().toLowerCase() === 'broad').length;
  // Cards blocked on research used to read lane_state_blocked_reason, which is
  // dead scaffold: a single-select whose only options are English sentences and
  // which the extractor has never populated. The open research count is real.
  // The same per-card rule the Commercial page counts by (open_questions).
  const openQuestions = opps.reduce((n, o) => n + (o.open_questions ?? 0), 0);

  return {
    pins: [
      { label: 'Days to Halloween', value: String(daysToHalloween()), health: 'ok', accent: true },
      { label: 'Open loops', value: loopsFreshness.source === 'none' ? 'none held' : String(totalOpen), health: loopsFreshness.source === 'none' ? 'degraded' : totalOpen > 200 ? 'degraded' : 'ok' },
      { label: 'Entries this week', value: String(entriesThisWeek), health: 'ok' },
    ],
    tiles: [
      {
        key: 'north-star',
        label: 'North Star',
        to: '/north-star',
        headline: String(ns.length),
        sublabel: ns.length ? 'asks held' : 'no ask held yet',
        // Delivery is the page's own failure metric, so it is the tile's too.
        signal: ns.length === 0 ? 'The ledger opened on 17 Sep and nothing has arrived yet.' : nsUndelivered ? `${nsUndelivered} answer${nsUndelivered === 1 ? '' : 's'} never reached anyone.` : 'Every answer reached someone.',
        health: nsUndelivered ? 'degraded' : 'ok',
        trend: nsByDay,
        share: { value: ns.filter((r) => r.outcome === 'Answered').length, total: ns.length, label: 'answered' },
      },
      {
        key: 'research-twin',
        label: 'Research Twin',
        to: '/research-twin',
        headline: String(rt.length),
        sublabel: rt.length ? 'asks held' : 'no ask held yet',
        // A capped job is the one thing on that page nothing else will move.
        signal:
          rt.length === 0 && jobs.length === 0
            ? 'The ledger opened on 17 Sep and nothing has arrived yet.'
            : cappedJobs
              ? `${cappedJobs} research job${cappedJobs === 1 ? ' is' : 's are'} waiting on a person.`
              : `${jobs.filter((j) => j.open).length} research job${jobs.filter((j) => j.open).length === 1 ? ' is' : 's are'} open, none capped.`,
        health: cappedJobs ? 'degraded' : 'ok',
        trend: rtByDay,
        share: { value: rt.filter((r) => r.outcome === 'Answered').length, total: rt.length, label: 'answered' },
      },
      // vFarm and Engine health are placeholders (2026-09-14, Destiny), so
      // their tiles carry no number. A headline figure for a page that says
      // "coming soon" would be a figure about nothing, which is the rule in
      // section 2 rather than a matter of taste.
      { key: 'media-twin', label: 'Media Twin', to: '/media-twin', headline: '—', sublabel: 'not wired up', signal: 'Nothing Media Twin does writes here yet.', health: 'ok' },
      { key: 'genie', label: 'Genie', to: '/genie', headline: '—', sublabel: 'not wired up', signal: 'Nothing Genie does writes here yet.', health: 'ok' },
      { key: 'vfarm', label: 'vFarm', to: '/vfarm', headline: '—', sublabel: 'not wired up', signal: 'Nothing on the rack writes here yet.', health: 'ok' },
      /**
       * Real from 2026-09-17: the incident ledger, its occurrence counts and
       * its retries are read now, so the tile carries the figure its page
       * leads with instead of a dash.
       *
       * **An unread lane is never drawn as health.** Where no lane answered,
       * the headline is a dash and the signal says so — nought open incidents
       * and nobody asked look identical, and only one of them is good news.
       */
      (() => {
        const read = healthLanes.filter((l) => l.read);
        const unread = healthLanes.filter((l) => !l.read);
        const openIncidents = healthIncidents.filter((i) => i.open_now).length;
        // The page's own "needing a person": an exhausted retry on an incident
        // since closed is finished, not waiting on anybody.
        const capped = health.exhaustedStillOpen(healthRetries, healthIncidents).length;
        return {
          key: 'engine-health',
          label: 'Engine health',
          to: '/engine-health',
          headline: read.length ? String(openIncidents) : '—',
          sublabel: read.length ? (openIncidents === 1 ? 'incident open' : 'incidents open') : 'no lane was read',
          signal: !read.length
            ? `No lane answered: ${unread.map((l) => l.label).join(', ')} ${unread.length === 1 ? 'was' : 'were'} not read.`
            : unread.length
              ? `${unread.map((l) => l.label).join(' and ')} could not be read, so this counts what is held.`
              : capped
                ? `${capped} exhausted retr${capped === 1 ? 'y needs' : 'ies need'} a person.`
                : openIncidents
                  ? 'The healer is working on what it can.'
                  : 'Nothing is open in any lane.',
          health: (!read.length || openIncidents || capped ? 'degraded' : 'ok') as OverviewTile['health'],
        };
      })(),
      {
        key: 'open-loops',
        label: 'Open loops',
        to: '/open-loops',
        headline: loopsFreshness.source === 'none' ? '—' : String(totalOpen),
        sublabel: loopsFreshness.source === 'none' ? 'none held' : 'open',
        signal: loopsFreshness.source === 'none' ? (loopsFreshness.note ?? 'No loop is held.') : `The oldest has been open ${oldest} day${oldest === 1 ? '' : 's'}.`,
        health: loopsFreshness.source === 'none' ? 'degraded' : oldest > 30 ? 'degraded' : 'ok',
        trend: loops14d.map((p) => p.value),
      },
      { key: 'codex', label: 'Codex entries', to: '/codex', headline: String(entriesThisWeek), sublabel: 'logged this week', signal: awaitingSentence(entries.filter((e) => e.stage === 'awaiting').length), health: 'ok', trend: entriesByWeek.map((p) => p.value), share: { value: ingested, total: entries.length, label: 'with an entry written' } },
      { key: 'build-patterns', label: 'Build patterns', to: '/build-patterns', headline: String(patterns.length), sublabel: 'patterns', signal: `${broad} ${broad === 1 ? 'is' : 'are'} broadly reusable.`, health: 'ok', share: { value: broad, total: patterns.length, label: 'broadly reusable' } },
      { key: 'commercial', label: 'Commercial', to: '/commercial', headline: String(opps.length), sublabel: 'cards', signal: `${openQuestions} research question${openQuestions === 1 ? ' is' : 's are'} still open.`, health: 'ok', share: { value: opps.filter((o) => o.readiness_state === 'Media-Ready').length, total: opps.length, label: 'media-ready' } },
    ],
    series: {
      loops_raised_14d: loops14d,
      entries_by_week: entriesByWeek,
      asks_by_outcome: { answered, thin, failed, refused, needs_human: needsHuman },
      twin_handoffs: { n: handoffs.n, of: handoffs.of, note: handoffs.note },
      loops_by_owner: owners.map(({ owner, open, in_progress, oldest_days }) => ({ owner, open, in_progress, oldest_days })),
    },
    rates: {
      answered: { value: answered, total: asks.length },
      ingested: { value: ingested, total: entries.length },
    },
    broke_24h: [
      { id: 'B1', at: '11:42', title: 'Ask Cluster returning a wrapped 402', detail: 'BHARAG credit exhausted. No retry attempted — billing never auto-retries.', health: 'failing', spine: f.INCIDENTS[0].spine, source: f.INCIDENTS[0].source },
      { id: 'B2', at: '09:15', title: 'Research Twin cannot resolve bharag2', detail: 'ENOTFOUND on two of three retries. Third pending.', health: 'degraded', spine: f.INCIDENTS[1].spine, source: f.INCIDENTS[1].source },
      { id: 'B3', at: '13:48', title: 'pH above ceiling on rack-a/tier-3', detail: 'Held at 6.31 across three consecutive rollups.', health: 'degraded', spine: f.VFARM_ALERTS[0].spine, source: f.VFARM_ALERTS[0].source },
      { id: 'B4', at: '09:06', title: 'Burn-in bench above temperature ceiling', detail: '23.1°C for 21 minutes against a 22.6°C ceiling.', health: 'degraded', spine: f.VFARM_ALERTS[1].spine, source: f.VFARM_ALERTS[1].source },
      { id: 'B5', at: '08:14', title: 'Kaiqi digest disagreed with Kaiqi table', detail: 'Digest named three loops; the table returned none. Raised for reconciliation.', health: 'degraded', spine: f.INCIDENTS[2].spine, source: f.INCIDENTS[2].source },
      { id: 'B6', at: '07:55', title: 'Commercial extractor hit its retry ceiling', detail: 'Three attempts, all failed. Classifier never derived a fix lane.', health: 'failing', spine: f.INCIDENTS[7].spine, source: f.INCIDENTS[7].source },
      { id: 'B7', at: '06:20', title: 'Four Codex entries posted without ingest', detail: 'Reached Slack but not BHARAG, so no twin can cite them.', health: 'degraded', spine: f.INCIDENTS[4].spine, source: f.INCIDENTS[4].source },
      { id: 'B8', at: '05:02', title: 'Founding-buyer card still blocked', detail: 'No authorised payment account. Unchanged for 31 days.', health: 'failing', spine: f.INCIDENTS[7].spine, source: f.INCIDENTS[7].source },
      { id: 'B9', at: '02:41', title: 'Two loops named by the digest exist in no table', detail: 'Present in the Sept 7 digest, absent from all seven builder tables.', health: 'degraded', spine: f.INCIDENTS[2].spine, source: f.INCIDENTS[2].source },
      { id: 'B10', at: '23:52', title: 'Ledger batch ingest rejected on schema', detail: 'incidents.v0 is strict; an added field fails the whole batch.', health: 'degraded', spine: f.INCIDENTS[2].spine, source: f.INCIDENTS[2].source },
      { id: 'B11', at: '22:18', title: 'Research Twin quarantined an ask at three cycles', detail: 'Evidence stayed thin across three narrowing passes; handed to a human.', health: 'degraded', spine: f.RT_RECORDS[4].spine, source: f.RT_RECORDS[4].source },
    ],
    moved_24h: [
      { id: 'M1', at: '14:02', title: 'North Star credential rotated', detail: 'INC-5A3C77 resolved after 26 hours of silent failure.', health: 'ok', spine: f.INCIDENTS[3].spine, source: f.INCIDENTS[3].source },
      { id: 'M2', at: '11:20', title: 'Four blocking loops identified', detail: 'Bays narrowed 96 open loops to the 4 that block telemetry v1.', health: 'ok', spine: f.INCIDENTS[0].spine, source: f.INCIDENTS[0].source },
      { id: 'M3', at: '10:07', title: 'Ledger corpora confirmed current', detail: 'vfarm.sensor and vfarm.alert both current, dead-letter queue at zero.', health: 'ok', spine: f.VFARM_ALERTS[2].spine, source: f.VFARM_ALERTS[2].source },
      { id: 'M4', at: '08:17', title: 'Codex digest self-healed', detail: 'Empty render caught by assertion; second attempt posted.', health: 'ok', spine: f.INCIDENTS[4].spine, source: f.INCIDENTS[4].source },
      { id: 'M5', at: '23:15', title: 'Three Codex entries ingested', detail: 'Destiny, Jegan and Kaiqi entries reached BHARAG rather than only posting.', health: 'ok', spine: f.INCIDENTS[4].spine, source: f.INCIDENTS[4].source },
      { id: 'M6', at: '13:00', title: 'Per-builder loop digests delivered', detail: 'Seven builders, one digest each, prioritised by North Star.', health: 'ok', spine: f.INCIDENTS[0].spine, source: f.INCIDENTS[0].source },
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

/* ------------------------------------------------------------ open loops */

export async function getOpenLoops(_q: Query): Promise<OpenLoopsData> {
  const freshness = await store.freshness('loops');
  return {
    // Newest first: the loop raised today is at the top, the oldest at the
    // bottom. Age is still on every row and still the signal; it is no longer
    // the sort.
    loops: (await store.loops()).sort((a, b) => (b.raised_at ?? '').localeCompare(a.raised_at ?? '') || a.age_days - b.age_days),
    by_owner: await store.loopsByOwner(),
    freshness,
    status_history_note:
      freshness.source === 'none'
        ? (freshness.note ?? 'No loops are held.')
        : `Across ${freshness.tables.length} builder tables, as the engine has written them into this database. Newest first; age is time since Date Raised. Click a loop to edit it: the change is saved here and then written straight to Airtable, and a loop marked in the status column is one that did not land there.`,
  };
}

/* ------------------------------- codex / patterns / commercial / builders */

export async function getCodexEntries(_q: Query): Promise<CodexData> {
  /**
   * Reconciled first, then read.
   *
   * A row deleted by hand in Airtable notifies nothing, so this compares the
   * record ids Airtable holds against the rows here and removes what is gone
   * before the list is built — otherwise the page would show it, and a click
   * on it would fail against a record that does not exist. One pass, on load,
   * no background job. A failed read removes nothing.
   *
   * Its result is deliberately not returned any more (2026-09-14, Destiny).
   * The page carried it as a standing amber line, which is a banner about
   * housekeeping on a page whose rows were never in doubt. It goes to the
   * server log, where the reason belongs, and the Resync button is what a
   * person uses when they want to see what the two sides hold.
   */
  await store.reconcileCodex();
  // Newest first: the most recent submission is the one anyone opens this page for.
  const entries = (await store.codexEntries()).sort((a, b) => ((a.logged_at ?? '') < (b.logged_at ?? '') ? 1 : -1));
  return {
    entries,
    freshness: await store.freshness('codex'),
    // One tab per table that exists, whether or not it has rows yet. There is
    // no Jason tab and no "no builder" tab: the table a row lives in is its
    // builder, and Jason reviews logs rather than submitting them.
    builders: CODEX_TABLES.map((t) => ({ id: t.owner, label: t.label, table: t.table, n: entries.filter((e) => e.builder_id === t.owner).length })),
    layer0_holds: (await store.layer0Holds()).sort((a, b) => ((a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1)),
    choices: CODEX_CHOICES,
  };
}

export function getCodexDetail(id: string): Promise<CodexEntryDetail | null> {
  return store.codexDetail(id);
}

/* --------------------------------------------------- the twins' ledgers */

/**
 * North Star's ask log, as its own ledger has recorded it since 17 Sep 2026.
 *
 * Newest first: the most recent ask is what says whether North Star is being
 * used at all, and silence here is itself the signal.
 */
export async function getNorthStarTelemetry(): Promise<NsData> {
  return {
    asks: (await store.nsAsks()).sort((a, b) => (b.asked_at ?? '').localeCompare(a.asked_at ?? '')),
    freshness: await store.freshness('ns'),
  };
}

/**
 * Research Twin's asks and its research queue.
 *
 * Two kinds, two mirror tables, and **two freshness lines**, because they are
 * fed differently: an ask is mirrored the moment the run ends, while a job is
 * updated in place and only reaches this database through the resync. One age
 * printed above both would be quietly wrong about whichever was not written
 * last, which is exactly the class of figure this dashboard exists to remove.
 */
export async function getResearchTwinTelemetry(): Promise<RtData> {
  return {
    asks: (await store.rtAsks()).sort((a, b) => (b.asked_at ?? '').localeCompare(a.asked_at ?? '')),
    // Newest first, and a job waiting on a person sorts above the rest: it is
    // the only thing on that tab nothing else in the engine will move.
    jobs: (await store.rtJobs()).sort((a, b) => Number(b.capped) - Number(a.capped) || (b.opened_at ?? '').localeCompare(a.opened_at ?? '')),
    freshness: await store.freshness('rt'),
    jobs_freshness: await store.freshness('rt_jobs'),
  };
}

/** How often the two twins actually consult each other, across both ledgers. */
export function getTwinHandoffs(): Promise<Handoffs> {
  return store.twinHandoffs();
}

/* --------------------------------------------------------- clients */

/** Midnight today, in whole days, for the overdue comparison. */
function startOfToday(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function getClients(): Promise<ClientsData> {
  const lanes = await store.clientLanes();
  const questions = await store.clientQuestions();
  /**
   * What each client has asked for (2026-09-17). A new table in the same base,
   * keyed on the same `Client ID` the index is, which is what lets a request
   * sit under the client that made it rather than in a list of its own.
   */
  const requests = await store.clientRequests();
  const today = startOfToday();

  const rows: ClientLaneRow[] = lanes
    .map((lane) => {
      const key = lane.lane_id ?? lane.id;
      const mine = questions.filter((q) => q.lane_id === key);
      const needsHuman = mine.filter((q) => questionNeedsHuman(q, lane)).length;
      const everRun = Boolean(lane.last_run_at);
      /**
       * Overdue is `Next Run Due` against today, not the age of the last run.
       * That field is what the weekly clock reads, so it is the one that says a
       * lane is late; a lane with no due date is not overdue, it is undated.
       *
       * Those stamps were frozen for weeks because nothing wrote them back.
       * That was fixed upstream on 15 Sep, so they become real from the next
       * weekly run; until then the page shows the history, which is every
       * running lane overdue since 31 Aug.
       */
      const due = lane.next_run_due ? Date.parse(lane.next_run_due) : null;
      const overdue = due !== null && Number.isFinite(due) && due < today;
      return {
        ...lane,
        questions: mine.length,
        // "Active" is a question the loop is still working: it has not been
        // parked for a human and is not already answered with enough evidence.
        active_questions: mine.filter((q) => !questionNeedsHuman(q, lane)).length,
        needs_human: needsHuman,
        missing_research: mine.filter((q) => q.missing_research).length,
        capped: mine.filter((q) => q.run_count >= 3).length,
        overdue,
        days_overdue: overdue && due !== null ? Math.floor((today - due) / 86_400_000) : null,
        // A lane with no run yet is warming up, not failing. The distinction
        // matters: Client 2's kiosk lane was added on 10 Sep and has never run.
        warming_up: !everRun,
        // The newest of the lane's own row and its questions' rows, so a lane
        // whose questions moved yesterday does not read as untouched.
        last_update: [lane.held, ...mine.map((q) => q.held)].filter((h): h is NonNullable<typeof h> => Boolean(h)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null,
      };
    })
    .sort((a, b) => (b.last_run_at ?? '').localeCompare(a.last_run_at ?? '') || a.name.localeCompare(b.name));

  // Group by Client ID. Two lanes sharing one id are one client with two
  // lanes, and must appear once with both beneath — not twice.
  const groups = new Map<string, ClientLaneRow[]>();
  for (const r of rows) {
    const id = r.client_id ?? `(no client id) ${r.lane_id ?? r.id}`;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  /**
   * A request carrying a client id no index row has gets a group of its own,
   * with no lanes under it (2026-09-17). It is a real thing a real client asked
   * for; dropping it because the index has not caught up would be this
   * dashboard deciding a request does not exist, which is the opposite of what
   * the table is for.
   */
  for (const r of requests) {
    const id = r.client_id ?? '(no client id) requests';
    if (!groups.has(id)) groups.set(id, []);
  }

  return {
    clients: [...groups.entries()]
      .map(([client_id, ls]) => {
        const number = clientNumber(client_id);
        /**
         * A request belongs to the client whose id it carries. One whose id
         * matches no index row still appears, in the lane-less group made for
         * it above — a request nobody can see is worse than one under an odd
         * heading.
         */
        const mine = requests
          .filter((r) => (r.client_id ?? '') === client_id)
          .sort((a, b) => (b.date_requested ?? '').localeCompare(a.date_requested ?? '') || a.request.localeCompare(b.request));
        return {
          client_id,
          label: number === null ? (ls.length === 1 ? ls[0].name : client_id) : `Client ${number}`,
          number,
          lanes: ls,
          questions: ls.reduce((n, l) => n + l.questions, 0),
          needs_human: ls.reduce((n, l) => n + l.needs_human, 0),
          requests: mine,
          open_requests: mine.filter((r) => requestIsOpen(r.status)).length,
        };
      })
      // Numerically, so the page reads Client 2, Client 9, Client 12 — and not
      // the 002 / 009 / 012 order a string sort would give, which happens to
      // agree today and would stop agreeing at Client 100.
      .sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label)),
    lanes: rows,
    questions,
    requests,
    freshness: await store.freshness('clients'),
    requests_freshness: await store.freshness('client_requests'),
    engine_last_write: {
      lanes: await store.lastEngineWrite('client_lanes'),
      questions: await store.lastEngineWrite('client_questions'),
      requests: await store.lastEngineWrite('client_requests'),
    },
    unreadable: lanes
      .filter((l) => !l.questions_table)
      .map((l) => ({
        lane_id: l.lane_id,
        name: l.name,
        reason: 'The index row names no Table ID, so this lane’s questions have nowhere to arrive from. Add the table id to the index row and point the engine at it.',
      })),
  };
}

/**
 * The number inside a Client ID — CLIENT-009 gives 9 — and null where the id
 * does not carry one. The id is the grouping key and the label both, because it
 * is the field that actually says which client a lane belongs to; the lane's
 * own name is prose and two lanes of one client do not share it.
 */
function clientNumber(clientId: string): number | null {
  const m = /(\d+)/.exec(clientId);
  return m ? Number(m[1]) : null;
}

/**
 * Build patterns, newest first.
 *
 * No `systems` list any more (2026-09-15, Destiny): the strip of BP-BHARAG,
 * BP-CAPACITY, BP-CST and the rest grouped rows by the domain segment of their
 * own id, which tells a reader nothing they cannot see in the id itself. And no
 * `unset` count, because `pattern_status` no longer exists to be unset.
 */
export async function getBuildPatterns(_q: Query): Promise<BuildPatternsData> {
  // Newest first, by created_at; a pattern with no date sorts last, then by id.
  const patterns = (await store.patterns()).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || (a.pattern_id ?? '').localeCompare(b.pattern_id ?? ''));
  return { patterns, freshness: await store.freshness('patterns') };
}

/**
 * Commercial cards.
 *
 * No `lanes` list any more (2026-09-15, Destiny): lane_id is 1:1 with the card
 * — 21 distinct lanes across 21 records — so grouping by it grouped nothing,
 * and the per-lane strip it fed read "1 · 3 open" per lane, which is one card
 * and three open questions rather than any kind of average.
 */
export async function getCommercial(_q: Query): Promise<CommercialData> {
  // Newest first, by created_at; a card with no date sorts last, then by id.
  const opportunities = (await store.opportunities()).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || (a.card_id ?? '').localeCompare(b.card_id ?? ''));
  return {
    opportunities,
    freshness: await store.freshness('commercial'),
    trends: Object.fromEntries(await Promise.all(opportunities.map(async (o) => [o.id, await store.cardTrend(o.id)] as const))),
  };
}

