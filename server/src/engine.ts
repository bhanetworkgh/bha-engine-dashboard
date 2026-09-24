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
  PatternCandidate,
  PatternCandidatesData,
  Query,
  RtData,
  SeriesPoint,
} from '../../src/data/types';
import { MODEL_LABEL, askConfigured } from './ask';
import * as health from './health';
import { CODEX_CHOICES, CODEX_TABLES, loopTable, questionNeedsHuman, requestIsOpen } from './sources';
import * as store from './store';
import * as feeds from './feeds';
import { query } from './pg';
import * as candidateActions from './candidateActions';

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
  /**
   * One definition of open (2026-09-23): countOpenLoops(), which the Open
   * loops page and the API use too. The owners are counted from the same rows,
   * so they sum to the total; the oldest age per owner is read from the loops.
   */
  const openCount = await store.countOpenLoops();
  const totalOpen = openCount.total;
  const oldestOf = (owner: string) => Math.max(0, ...openLoops.filter((l) => l.owner === owner).map((l) => l.age_days));
  const owners = openCount.by_builder.map((b) => ({ owner: b.builder_id, open: b.open, in_progress: b.in_progress, oldest_days: oldestOf(b.builder_id) }));
  const oldest = Math.max(...(openLoops.length ? openLoops.map((l) => l.age_days) : [0]));
  const feedNow = Date.now();
  const [broke24, moved24] = await Promise.all([feeds.broke(feedNow), feeds.moved(feedNow)]);

  /**
   * vFarm's tile is real from 2026-09-23: the Early Access leads are rows, so
   * the tile counts them. The rack is still not instrumented, and the tile says
   * leads, never anything about the rack.
   */
  const leadRow = (
    await query<{ n: string; week: string; newest: string | null }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE created_at >= now() - interval '7 days')::text AS week,
              max(created_at)::text AS newest
         FROM engine_vfarm_leads`,
    )
  ).rows[0];
  const leads = { n: Number(leadRow?.n ?? 0), week: Number(leadRow?.week ?? 0), newest: leadRow?.newest ?? null };
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
      /**
       * North Star, as two figures rather than one sentence (2026-09-23).
       *
       * The tile used to say "Every answer reached someone." beside a ring
       * reading "1 of 46 answered", which read as a contradiction because it
       * was two different questions in one breath:
       *
       *   **Delivered** — `Delivered = "Delivered"`: the reply reached a
       *   person in Slack. Recorded after the send, so it is the only figure
       *   that says something arrived rather than that a run finished.
       *   **Answered** — `Outcome = "Answered"`: the reply actually answered
       *   the question, as opposed to Thin, Refused (not its lane) or Failed.
       *
       * Both are over every ask held. A reply can be delivered and still not
       * be an answer, which is exactly the 46-and-1 case. The sentence under
       * them speaks for whichever of the two is weaker, so the tile never
       * reassures about the half that is fine while the other half is not.
       */
      (() => {
        const delivered = ns.filter((r) => r.delivered === 'Delivered').length;
        const answeredNs = ns.filter((r) => r.outcome === 'Answered').length;
        const weaker = delivered <= answeredNs ? 'delivered' : 'answered';
        const weakN = Math.min(delivered, answeredNs);
        return {
          key: 'north-star',
          label: 'North Star',
          to: '/north-star',
          headline: String(ns.length),
          sublabel: ns.length ? 'asks held' : 'no ask held yet',
          signal:
            ns.length === 0
              ? 'The ledger opened on 17 Sep and nothing has arrived yet.'
              : weakN === ns.length
                ? `All ${ns.length} delivered and answered.`
                : weaker === 'delivered'
                  ? `${ns.length - delivered} of ${ns.length} replies never reached a person.`
                  : `Only ${answeredNs} of ${ns.length} asks ${answeredNs === 1 ? "was" : "were"} answered.`,
          health: (ns.length && weakN < ns.length ? 'degraded' : 'ok') as OverviewTile['health'],
          trend: nsByDay,
          figures: [
            { label: 'Delivered (reached a person)', value: delivered, of: ns.length },
            { label: 'Answered', value: answeredNs, of: ns.length },
          ],
        };
      })(),
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
      // Media Twin and Genie write nothing here yet, so their tiles carry no
      // number and are drawn greyed — "Not connected yet", never a figure.
      { key: 'media-twin', label: 'Media Twin', to: '/media-twin', headline: '—', sublabel: 'Not connected yet', signal: 'Nothing Media Twin does writes here yet.', health: 'ok', muted: true },
      { key: 'genie', label: 'Genie', to: '/genie', headline: '—', sublabel: 'Not connected yet', signal: 'Nothing Genie does writes here yet.', health: 'ok', muted: true },
      {
        key: 'vfarm',
        label: 'vFarm',
        to: '/vfarm?tab=early-access',
        headline: String(leads.n),
        sublabel: leads.n === 1 ? 'Early Access lead' : 'Early Access leads',
        signal: leads.n
          ? `${leads.week} in the last 7 days; newest ${leads.newest ? new Date(leads.newest).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'undated'}.`
          : 'No Early Access lead has arrived yet.',
        health: 'ok',
      },
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
      loops_by_owner: owners,
      open_loops_total: totalOpen,
    },
    rates: {
      answered: { value: answered, total: asks.length },
      ingested: { value: ingested, total: entries.length },
    },
    // Read from the tables (2026-09-23); the 22 phase 1 sample rows that
    // stood here are gone. See feeds.ts.
    broke_24h: broke24,
    moved_24h: moved24,
    feeds_window: { since: new Date(feedNow - 24 * 3_600_000).toISOString(), until: new Date(feedNow).toISOString() },
  };
}

/* -------------------------------------------------------------- ask bays */

export function getAskBays(_q: Query): AskBaysData {
  return {
    // No seeded threads (2026-09-23): the history panel held phase 1 sample
    // conversations beside the real ones. It shows only the threads this
    // browser has actually had.
    threads: [],
    model_label: MODEL_LABEL,
    connected: askConfigured(),
    builders: f.BUILDERS.map((b) => ({ id: b.id, name: b.name })),
  };
}

/* -------------------------------------------- north star / research twin */

/*
 * getNorthStar and getResearchTwin, and the `twin()` they shared, are gone
 * (2026-09-23): they served phase 1 fixture asks, runs and gaps at
 * /api/north-star and /api/research-twin, and no page had read either since the
 * twins moved to their own ledgers on 17 Sep. A route that answers with sample
 * rows is one somebody eventually reads as real.
 */

/* ------------------------------------------------------------ open loops */

export async function getOpenLoops(_q: Query): Promise<OpenLoopsData> {
  const freshness = await store.freshness('loops');
  return {
    // Newest first: the loop raised today is at the top, the oldest at the
    // bottom. Age is still on every row and still the signal; it is no longer
    // the sort.
    loops: (await store.loops()).sort((a, b) => (b.raised_at ?? '').localeCompare(a.raised_at ?? '') || a.age_days - b.age_days),
    by_owner: await store.loopsByOwner(),
    open_count: await store.countOpenLoops(),
    freshness,
    status_history_note:
      freshness.source === 'none'
        ? (freshness.note ?? 'No loops are held.')
        : `Across ${freshness.tables.length} builder tables, as the engine has written them into this database. Newest first; age is time since Date Raised. Click a loop to edit it: the change is saved here, where the loop lives.`,
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


/**
 * Pattern candidates (2026-09-23, Destiny): ideas Bays flags from real work
 * before an architect registers them as build patterns. They moved from
 * Airtable into engine_pattern_candidates on 21 Sep and nothing showed them.
 *
 * Read straight from that table — it is a mirror kind with no store mapper —
 * with the column names describe_schema reports (natural_id, fields,
 * updated_at) and the field names exactly as the rows carry them: Candidate,
 * Summary, Lane, Status, Builder, Builder Slack ID, Suggested Architect,
 * Architect Slack ID, Why This Architect, Flagged By, Source Link, Date
 * Flagged, Pattern ID, Registered At. Read only: registering a candidate is
 * the Bays Tools Router's log_build_pattern, not this dashboard's.
 */
export async function getPatternCandidates(): Promise<PatternCandidatesData> {
  const r = await query<{ pk: string; natural_id: string | null; airtable_record_id: string | null; fields: Record<string, unknown> | null; updated_at: string }>(
    'SELECT id::text AS pk, natural_id, airtable_record_id, fields, updated_at FROM engine_pattern_candidates',
  );
  const s = (f: Record<string, unknown>, k: string): string | null => {
    const v = f[k];
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return t ? t : null;
  };
  const candidates: PatternCandidate[] = r.rows.map((row) => {
    const f = row.fields ?? {};
    return {
      id: row.natural_id ?? row.airtable_record_id ?? `row-${row.pk}`,
      candidate: s(f, 'Candidate'),
      summary: s(f, 'Summary'),
      lane: s(f, 'Lane'),
      status: s(f, 'Status'),
      builder: s(f, 'Builder'),
      builder_slack_id: s(f, 'Builder Slack ID'),
      suggested_architect: s(f, 'Suggested Architect'),
      architect_slack_id: s(f, 'Architect Slack ID'),
      why_this_architect: s(f, 'Why This Architect'),
      flagged_by: s(f, 'Flagged By'),
      source_link: s(f, 'Source Link'),
      date_flagged: s(f, 'Date Flagged'),
      pattern_id: s(f, 'Pattern ID'),
      registered_at: s(f, 'Registered At'),
      registered_by: s(f, 'Registered By'),
      announcement_link: s(f, 'Announcement Link'),
      declined_reason: s(f, 'Declined Reason'),
      declined_by: s(f, 'Declined By'),
      declined_at: s(f, 'Declined At'),
      reassigned_by: s(f, 'Reassigned By'),
      reassigned_at: s(f, 'Reassigned At'),
      // Filled by candidateActions.withPipeline, which reads the draft log.
      draft_runs: 0,
      draft_failures: 0,
      days_in_proposed: null,
    };
  });
  // Newest Date Flagged first; within a day, the newer CAND-<ms> id first. Undated last.
  candidates.sort((a, b) => (b.date_flagged ?? '').localeCompare(a.date_flagged ?? '') || b.id.localeCompare(a.id));
  const updated = r.rows.map((x) => x.updated_at).filter(Boolean).sort().pop() ?? null;
  return candidateActions.withPipeline({ candidates, held: r.rows.length, updated_at: updated });
}
