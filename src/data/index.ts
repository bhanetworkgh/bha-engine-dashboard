/**
 * The data module. One function per section, each returning one object.
 *
 * This is the only file that knows where data comes from. Every function is
 * async and takes a Query, so wiring the live engine endpoint is a change to
 * the bodies here — components already await, already handle loading and
 * failure, and already pass the lane filter through.
 *
 * Reads come from fixtures in phase 1. Writes (loop status, new loops, asks to
 * Bays, sign-in) go to the engine when it is configured and otherwise act on
 * the in-memory fixtures so the interface behaves. Nothing outside this
 * directory should need to change when the endpoint lands.
 */

import * as f from './fixtures';
import { config, engine, EngineError, request } from './engine';
import type {
  AskBaysData,
  AuthSession,
  BaysAnswer,
  BaysAsk,
  BaysSendResult,
  BaysWiring,
  BuilderDetail,
  BuildersData,
  BuildPatternsData,
  ChatThread,
  CodexData,
  CommercialData,
  EngineHealthData,
  EngineStatus,
  ErrorClass,
  Incident,
  IncidentState,
  Lane,
  Loop,
  LoopStatus,
  NewLoop,
  OpenLoopsData,
  OverviewData,
  Query,
  SeriesPoint,
  SignInResult,
  TwinData,
  VFarmData,
} from './types';

export * from './types';
export { config as engineConfig } from './engine';

/** Reference date the fixtures are written against. */
const REF_DATE = '2026-09-07';

/** Stand-in for network latency, so loading states are real in phase 1. */
const LATENCY_MS = 120;

function deliver<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

/** Lane filtering. Applied here so no component ever filters by hand. */
function laneMatch(q: Query, lane: Lane): boolean {
  return q.lane === 'all' || q.lane === lane;
}

function byLane<T extends { lane: Lane }>(rows: T[], q: Query): T[] {
  return rows.filter((r) => laneMatch(q, r.lane));
}

function bySpineLane<T extends { spine: { lane: Lane } }>(rows: T[], q: Query): T[] {
  return rows.filter((r) => laneMatch(q, r.spine.lane));
}

const LANES: Lane[] = ['VFARM_CORE', 'VFARM_MEDIA', 'CLIENT_CORE', 'ENGINE_INTERNAL'];

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The last `n` calendar days ending on `end`, oldest first, as YYYY-MM-DD. */
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
  return days.map((day) => ({
    label: day.slice(5),
    value: dates.filter((d) => d.slice(0, 10) === day).length,
  }));
}

/* ---------------------------------------------------------------- status */

export function getEngineStatus(q: Query): Promise<EngineStatus> {
  const open = bySpineLane(f.INCIDENTS, q).filter(
    (i) => i.state !== 'resolved' && i.state !== 'failed',
  ).length;
  const failing = bySpineLane(f.INCIDENTS, q).some(
    (i) => i.health === 'failing' && i.state !== 'resolved',
  );
  return deliver({
    last_refresh: '2026-09-07 14:12',
    health: failing ? 'failing' : open > 0 ? 'degraded' : 'ok',
    note: failing
      ? 'Ask Cluster is returning a wrapped 402 — BHARAG credit exhausted.'
      : open > 0
        ? 'Retries pending on the Research Twin BHARAG call.'
        : null,
    open_incidents: open,
  });
}

/* -------------------------------------------------------------- overview */

const loopById = (id: string): Loop => f.LOOPS.find((l) => l.id === id) ?? f.LOOPS[0];

export function getOverview(q: Query): Promise<OverviewData> {
  const loops = byLane(f.LOOPS, q);
  const openLoops = loops.filter((l) => l.status !== 'closed');
  const incidents = bySpineLane(f.INCIDENTS, q);
  const openIncidents = incidents.filter((i) => i.state !== 'resolved' && i.state !== 'failed');
  const owners = f.LOOPS_BY_OWNER;
  const totalOpen =
    q.lane === 'all' ? owners.reduce((n, o) => n + o.open, 0) : openLoops.filter((l) => l.status === 'open').length;
  const oldest = Math.max(...(openLoops.length ? openLoops.map((l) => l.age_days) : [0]));
  const entries = bySpineLane(f.CODEX_ENTRIES, q);
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
  const entriesByWeek: SeriesPoint[] = weeks.map((w) => ({
    label: w.replace('2026-', ''),
    value: entries.filter((e) => e.week === w).length,
  }));

  const classes: ErrorClass[] = ['BILLING_QUOTA', 'NETWORK_TIMEOUT', 'SCHEMA_VALIDATION', 'CONFIG_AUTH', 'UNKNOWN'];
  const states: IncidentState[] = [
    'new',
    'triage',
    'auto-retry pending',
    'resolved',
    'failed',
    'escalated to RT',
    'escalated to human',
  ];

  const opps = byLane(f.OPPORTUNITIES, q);
  const builders = byLane(f.BUILDERS, q);

  return deliver({
    pins: [
      { label: 'Days to Halloween', value: '54', health: 'ok', accent: true },
      {
        label: 'vFarm status',
        value: vfarmVisible ? `${openAlerts.length} alerts open` : 'filtered out',
        health: vfarmVisible && openAlerts.length ? 'degraded' : 'ok',
      },
      {
        label: 'Open incidents',
        value: String(openIncidents.length),
        health: openIncidents.some((i) => i.health === 'failing') ? 'failing' : openIncidents.length ? 'degraded' : 'ok',
      },
      { label: 'Open loops', value: String(totalOpen), health: totalOpen > 200 ? 'degraded' : 'ok' },
      { label: 'Entries this week', value: String(entriesThisWeek), health: 'ok' },
    ],
    tiles: [
      {
        key: 'north-star',
        label: 'North Star',
        to: '/north-star',
        headline: String(ns.length),
        sublabel: 'asks this period',
        signal: `${bySpineLane(f.NS_GAPS, q).length} unanswered`,
        health: bySpineLane(f.NS_GAPS, q).length > 3 ? 'degraded' : 'ok',
        trend: nsByDay,
        share: { value: ns.filter((r) => r.outcome === 'answered').length, total: ns.length, label: 'answered' },
      },
      {
        key: 'research-twin',
        label: 'Research Twin',
        to: '/research-twin',
        headline: String(rt.length),
        sublabel: 'asks this period',
        signal: `${bySpineLane(f.RT_GAPS, q).length} unanswered`,
        health: bySpineLane(f.RT_GAPS, q).length > 3 ? 'degraded' : 'ok',
        trend: rtByDay,
        share: { value: rt.filter((r) => r.outcome === 'answered').length, total: rt.length, label: 'answered' },
      },
      {
        key: 'vfarm',
        label: 'vFarm',
        to: '/vfarm',
        headline: vfarmVisible ? String(f.VFARM_PLACES.length) : '0',
        sublabel: 'places reporting',
        signal: vfarmVisible ? `${openAlerts.length} alerts open · lifecycle not emitting` : 'filtered out',
        health: vfarmVisible && openAlerts.length ? 'degraded' : 'ok',
      },
      {
        key: 'engine-health',
        label: 'Engine health',
        to: '/engine-health',
        headline: String(openIncidents.length),
        sublabel: 'incidents open',
        signal: openIncidents.some((i) => i.error_class === 'BILLING_QUOTA') ? 'quota exhausted upstream' : 'retries pending',
        health: openIncidents.some((i) => i.health === 'failing') ? 'failing' : openIncidents.length ? 'degraded' : 'ok',
        trend: incidents7d.map((p) => p.value),
        share: { value: selfHealed, total: resolved, label: 'self-healed' },
      },
      {
        key: 'open-loops',
        label: 'Open loops',
        to: '/open-loops',
        headline: String(totalOpen),
        sublabel: 'open',
        signal: `oldest ${oldest} days`,
        health: oldest > 30 ? 'degraded' : 'ok',
        trend: loops14d.map((p) => p.value),
      },
      {
        key: 'codex',
        label: 'Codex entries',
        to: '/codex',
        headline: String(entriesThisWeek),
        sublabel: 'logged this week',
        signal: `${entries.filter((e) => !e.ingested).length} posted, not ingested`,
        health: 'ok',
        trend: entriesByWeek.map((p) => p.value),
        share: { value: ingested, total: entries.length, label: 'ingested' },
      },
      {
        key: 'build-patterns',
        label: 'Build patterns',
        to: '/build-patterns',
        headline: String(byLane(f.BUILD_PATTERNS, q).length),
        sublabel: 'patterns',
        signal: 'reference counts are cumulative',
        health: 'ok',
      },
      {
        key: 'commercial',
        label: 'Commercial',
        to: '/commercial',
        headline: String(opps.length),
        sublabel: 'opportunities',
        signal: `${opps.filter((o) => o.readiness === 'blocked').length} blocked`,
        health: opps.some((o) => o.readiness === 'blocked') ? 'failing' : 'ok',
        share: { value: opps.filter((o) => o.readiness === 'ready to pitch').length, total: opps.length, label: 'ready to pitch' },
      },
      {
        key: 'builders',
        label: 'Builders',
        to: '/builders',
        headline: String(builders.length),
        sublabel: 'people',
        signal: `${builders.filter((b) => b.contract_status !== 'signed').length} contract not signed`,
        health: builders.some((b) => b.contract_status !== 'signed') ? 'degraded' : 'ok',
      },
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
        .map((c) => ({
          error_class: c,
          n: incidents.filter((i) => i.error_class === c).length,
          open: openIncidents.filter((i) => i.error_class === c).length,
        }))
        .filter((r) => r.n > 0),
      incidents_by_state: states
        .map((s) => ({ state: s, n: incidents.filter((i) => i.state === s).length }))
        .filter((r) => r.n > 0),
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
  });
}

/* ------------------------------------------------------------------ auth */

/** The one account the team shares, matching BHARAG's console. */
export const TEAM_EMAIL = 'admin@bhanetwork.org';

/**
 * SHA-256 of `<email>\n<password>` for the shared team credential. The password
 * itself is not in this repository; only this digest is, and a digest of a
 * random fourteen-character password is not recoverable from it. Both the
 * email and the digest can be overridden on the host with VITE_AUTH_EMAIL and
 * VITE_AUTH_PASSWORD_SHA256 without a code change.
 *
 * This check runs in the browser, so it gates the interface rather than the
 * data behind it. When VITE_AUTH_URL is set the engine does the verification
 * instead and this constant is not consulted.
 */
const TEAM_CREDENTIAL_SHA256 = 'bd7e7179f981d8116d677eafef9da9daefd81e2d7c17142210da63b6262f3e89';

/** How sign-in is verified: by the engine's login endpoint, or in this browser. */
export type AuthMode = 'engine' | 'local';

export function authMode(): AuthMode {
  return config.authUrl ? 'engine' : 'local';
}

async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new EngineError('This browser cannot verify the credential (no Web Crypto). Use HTTPS or localhost.', null, 'network');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Failed attempts in this tab. After five, sign-in pauses for a short while. */
let failedAttempts = 0;
let lockedUntil = 0;
const LOCK_AFTER = 5;
const LOCK_MS = 30_000;

async function localSignIn(email: string, password: string): Promise<SignInResult> {
  if (Date.now() < lockedUntil) {
    const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
    return { ok: false, reason: 'rejected', message: `Too many attempts. Try again in ${secs} seconds.` };
  }
  const expectedEmail = (config.authEmail ?? TEAM_EMAIL).toLowerCase();
  const expectedHash = (config.authHash ?? TEAM_CREDENTIAL_SHA256).toLowerCase();

  let digest: string;
  try {
    digest = await sha256Hex(`${email}\n${password}`);
  } catch (err) {
    return { ok: false, reason: 'network', message: err instanceof Error ? err.message : 'Could not verify the credential.' };
  }

  // Compare both fields through the digest, so a wrong email and a wrong
  // password produce the same answer in the same time.
  const ok = email === expectedEmail && digest === expectedHash;
  if (!ok) {
    failedAttempts += 1;
    if (failedAttempts >= LOCK_AFTER) {
      failedAttempts = 0;
      lockedUntil = Date.now() + LOCK_MS;
    }
    return { ok: false, reason: 'rejected', message: 'Email or password not recognised.' };
  }
  failedAttempts = 0;
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  return { ok: true, session: { token: randomToken(), expires_at: expires, label: 'BHA team' } };
}

/**
 * Verifies the shared credential. With VITE_AUTH_URL set the email and
 * password are posted to the engine, which returns the session token. Without
 * it the pair is checked in the browser against the team credential digest.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const e = email.trim().toLowerCase();
  if (!e || !password) {
    return { ok: false, reason: 'missing', message: 'Enter an email address and a password.' };
  }

  if (authMode() === 'local') return localSignIn(e, password);

  try {
    const res = await request<Record<string, unknown>>(config.authUrl!, {
      method: 'POST',
      body: { email: e, password },
      anonymous: true,
      timeoutMs: 12000,
    });
    const token =
      (typeof res.token === 'string' && res.token) ||
      (typeof res.session_token === 'string' && res.session_token) ||
      (typeof res.access_token === 'string' && res.access_token) ||
      null;
    if (!token) {
      return { ok: false, reason: 'rejected', message: 'The engine accepted the request but returned no session token.' };
    }
    const session: AuthSession = {
      token,
      expires_at: typeof res.expires_at === 'string' ? res.expires_at : null,
      label: typeof res.label === 'string' ? res.label : null,
    };
    return { ok: true, session };
  } catch (err) {
    if (err instanceof EngineError) {
      if (err.status === 401 || err.status === 403) {
        return { ok: false, reason: 'rejected', message: 'Email or password not recognised.' };
      }
      if (err.kind === 'network' || err.kind === 'timeout') {
        return { ok: false, reason: 'network', message: 'Could not reach the engine to sign in. Check the connection and try again.' };
      }
      return { ok: false, reason: 'rejected', message: err.message };
    }
    return { ok: false, reason: 'network', message: 'Sign-in failed unexpectedly.' };
  }
}

/* -------------------------------------------------------------- ask bays */

const CHATS_KEY = 'bha.chats';

function readLocalThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatThread[]) : [];
  } catch {
    return [];
  }
}

/** Threads typed in this dashboard persist in the browser only. Bays holds no memory. */
export function saveLocalThreads(threads: ChatThread[]): void {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(threads.filter((t) => t.local)));
  } catch {
    // Storage unavailable: the thread lives for this page only.
  }
}

export function getBaysWiring(): BaysWiring {
  const can_send = Boolean(config.baysWebhookUrl && config.baysApiKey);
  const can_read_answers = Boolean(config.baysAnswerUrl);
  const delivery: BaysWiring['delivery'] = config.baysCallbackUrl ? 'callback' : config.baysChannelId ? 'slack' : 'none';

  let note: string;
  if (!can_send) {
    note = 'Bays is not connected to this dashboard: the front door URL and key are not set on this deployment, so nothing you type is sent anywhere.';
  } else if (delivery === 'none') {
    note = 'Messages reach the Bays front door, but no callback URL or Slack channel is configured, so Bays has nowhere to send its answer and will refuse the ask.';
  } else if (!can_read_answers) {
    note =
      delivery === 'callback'
        ? 'Messages reach Bays and answers go to the configured callback. This dashboard has no answer endpoint to read them from yet, so replies will not appear here.'
        : 'Messages reach Bays and answers are posted to the configured Slack channel. This dashboard cannot read Slack, so replies will not appear here.';
  } else {
    note = 'Connected. Messages go to the Bays front door and answers are read back from the callback store.';
  }

  return { can_send, can_read_answers, delivery, note };
}

export function getAskBays(_q: Query): Promise<AskBaysData> {
  const local = readLocalThreads();
  const seeded = f.CHAT_THREADS.filter((t) => !local.some((l) => l.id === t.id));
  return deliver({
    threads: [...local, ...seeded].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
    memory_note:
      'Bays holds no memory between threads. History here is stored by this browser only.',
    wiring: getBaysWiring(),
    builders: f.BUILDERS.map((b) => ({ id: b.id, name: b.name })),
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Sends one ask to the Bays front door in the external-ask shape the workflow's
 * Parse & Classify node expects: prompt, session_id, builder_id, lane_id,
 * source, and a delivery target (callback and/or channel_id). The front door
 * acks with an empty body immediately; the answer arrives later at the
 * callback. The same session_id inside thirty seconds is dropped by the
 * workflow's loop guard, which the screen enforces as a cooldown.
 */
export async function sendToBays(ask: BaysAsk): Promise<BaysSendResult> {
  const w = getBaysWiring();
  if (!w.can_send) return { ok: false, session_id: ask.session_id, error: w.note };
  if (w.delivery === 'none') return { ok: false, session_id: ask.session_id, error: w.note };

  const body: Record<string, string> = {
    prompt: ask.prompt,
    session_id: ask.session_id,
    builder_id: ask.builder_id,
    lane_id: ask.lane,
    source: 'engine_dashboard',
  };
  if (config.baysCallbackUrl) body.callback = config.baysCallbackUrl;
  if (config.baysChannelId) body.channel_id = config.baysChannelId;

  try {
    await request(config.baysWebhookUrl!, {
      method: 'POST',
      body,
      headers: { 'x-api-key': config.baysApiKey! },
      anonymous: true,
      timeoutMs: 15000,
    });
    return { ok: true, session_id: ask.session_id, sent_at: stamp() };
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : 'The front door did not accept the message.';
    return { ok: false, session_id: ask.session_id, error: msg };
  }
}

/**
 * Reads an answer back for a session. Expects the answer store to return
 * { status: 'pending' } or { status: 'answered', answer|response|text, at }.
 */
export async function pollBaysAnswer(session_id: string): Promise<BaysAnswer> {
  if (!config.baysAnswerUrl) {
    return { status: 'unavailable', reason: 'No answer endpoint is configured on this deployment.' };
  }
  try {
    const sep = config.baysAnswerUrl.includes('?') ? '&' : '?';
    const res = await request<Record<string, unknown>>(
      `${config.baysAnswerUrl}${sep}session_id=${encodeURIComponent(session_id)}`,
      { timeoutMs: 10000 },
    );
    const text =
      (typeof res.answer === 'string' && res.answer) ||
      (typeof res.response === 'string' && res.response) ||
      (typeof res.text === 'string' && res.text) ||
      null;
    if (res.status === 'answered' || (text && res.status !== 'pending')) {
      return { status: 'answered', text: text ?? '', at: typeof res.at === 'string' ? res.at : stamp() };
    }
    return { status: 'pending' };
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : 'Could not read the answer store.';
    return { status: 'unavailable', reason: msg };
  }
}

/* -------------------------------------------- north star / research twin */

function twin(
  name: string,
  records: TwinData['records'],
  runs: TwinData['runs'],
  gaps: TwinData['gaps'],
  transitions: TwinData['transitions'],
  q: Query,
): TwinData {
  const r = bySpineLane(records, q);
  const answered = r.filter((x) => x.outcome === 'answered').length;
  const thin = r.filter((x) => x.outcome === 'thin').length;
  const failed = r.filter((x) => x.outcome === 'failed').length;

  const askerCounts = new Map<string, number>();
  for (const x of r) askerCounts.set(x.asked_by, (askerCounts.get(x.asked_by) ?? 0) + 1);

  return {
    name,
    summary: {
      period: 'Last 8 days',
      asks: r.length,
      answered,
      thin,
      failed,
      median_time_to_answer: null,
      median_unavailable_reason:
        'Nothing records when an ask was answered, only that it was. Time to answer arrives with telemetry v1.',
      top_askers: [...askerCounts.entries()]
        .map(([builder_id, asks]) => ({ builder_id, asks }))
        .sort((a, b) => b.asks - a.asks)
        .slice(0, 5),
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
      transitions:
        name === 'North Star'
          ? 'North Star does not record an ask going thin and later being answered. Nothing writes that transition today.'
          : undefined,
    },
  };
}

export function getNorthStar(q: Query): Promise<TwinData> {
  return deliver(twin('North Star', f.NS_RECORDS, f.NS_RUNS, f.NS_GAPS, [], q));
}

export function getResearchTwin(q: Query): Promise<TwinData> {
  return deliver(twin('Research Twin', f.RT_RECORDS, f.RT_RUNS, f.RT_GAPS, f.RT_TRANSITIONS, q));
}

/* ----------------------------------------------------------------- vfarm */

export function getVFarm(q: Query): Promise<VFarmData> {
  const visible = q.lane === 'all' || q.lane === 'VFARM_CORE';
  return deliver({
    readings: visible ? f.VFARM_READINGS : [],
    alerts: visible ? f.VFARM_ALERTS : [],
    places: visible ? f.VFARM_PLACES : [],
    lifecycle: f.VFARM_LIFECYCLE,
    lifecycle_note:
      'Burn-in and growth cycle events are not being emitted. vFarm currently writes sensor rollups, threshold alerts and incident closes to the ledger; no workflow writes a lifecycle event, so there is nothing to show here.',
    readiness_note:
      'Readiness is not computed anywhere yet. The endpoint that would answer it, /clusters/:id/readiness, is specced in the vFarm contract but not built. Until it exists this panel would have to guess, so it does not.',
    days_to_halloween: 54,
  });
}

/* --------------------------------------------------------- engine health */

export function getEngineHealth(q: Query): Promise<EngineHealthData> {
  const incidents = bySpineLane(f.INCIDENTS, q);
  const retriesAttempted = incidents.reduce((n, i) => n + i.retries_attempted, 0);
  const retriesSucceeded = incidents.reduce(
    (n, i) => n + i.actions.filter((a) => a.action_type === 'retry' && a.outcome === 'ok').length,
    0,
  );
  const selfHealed = incidents.filter((i) => i.tags.self_healed).length;
  const resolved = incidents.filter((i) => i.state === 'resolved').length;

  return deliver({
    incidents,
    metrics: {
      self_heal_rate: resolved ? `${Math.round((selfHealed / resolved) * 100)}%` : '—',
      retries_attempted: retriesAttempted,
      retries_succeeded: retriesSucceeded,
      mean_time_to_resolve: '3h 41m',
      escalations: incidents.filter((i) => i.state.startsWith('escalated')).length,
    },
    lanes_at_retry_ceiling: LANES.map((lane) => ({
      lane,
      incidents: incidents.filter((i) => i.spine.lane === lane && i.retries_attempted >= i.max_retries).length,
    })).filter((row) => row.incidents > 0),
  });
}

/* ------------------------------------------------------------ open loops */

export function getOpenLoops(q: Query): Promise<OpenLoopsData> {
  const loops = byLane(f.LOOPS, q).sort((a, b) => b.age_days - a.age_days);
  const visibleOwners = new Set(loops.map((l) => l.owner));
  return deliver({
    loops,
    by_owner:
      q.lane === 'all'
        ? f.LOOPS_BY_OWNER
        : f.LOOPS_BY_OWNER.filter((o) => visibleOwners.has(o.owner)),
    review_queue: f.REVIEW_QUEUE,
    reconciliation: f.RECONCILIATION,
    reconciliation_note:
      'Rows here disagree between the daily digest and the per-builder tables after the September 5 migration. Nothing is corrected automatically.',
    status_history_note:
      'Age is time since the loop was raised. Time in current status is not recorded — nothing writes a status-change timestamp yet.',
  });
}

/** Keeps the per-owner totals in step with a status change on a held row. */
function shiftOwnerCount(owner: string, from: LoopStatus, to: LoopStatus) {
  const o = f.LOOPS_BY_OWNER.find((x) => x.owner === owner);
  if (!o || from === to) return;
  const key = (s: LoopStatus): 'open' | 'in_progress' | 'closed' =>
    s === 'open' ? 'open' : s === 'in progress' ? 'in_progress' : 'closed';
  o[key(from)] = Math.max(0, o[key(from)] - 1);
  o[key(to)] += 1;
}

/**
 * Changes a loop's status. Against the engine this is PATCH /loops/:id; in
 * phase 1 it changes the held row so the interface updates. Either way the
 * caller gets the loop as it now stands.
 */
export async function setLoopStatus(id: string, status: LoopStatus, note?: string): Promise<Loop> {
  if (config.apiUrl) {
    return engine<Loop>(`/loops/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, note } });
  }
  const loop = f.LOOPS.find((l) => l.id === id);
  if (!loop) throw new EngineError('That loop is not held by this dashboard.', 404, 'http');
  const from = loop.status;
  loop.status = status;
  loop.closed_at = status === 'closed' ? stamp().slice(0, 10) : null;
  if (note !== undefined) loop.note = note || null;
  shiftOwnerCount(loop.owner, from, status);
  return deliver({ ...loop });
}

/** Opens a new loop. Against the engine this is POST /loops. */
export async function createLoop(input: NewLoop): Promise<Loop> {
  if (config.apiUrl) {
    return engine<Loop>('/loops', { method: 'POST', body: input });
  }
  const title = input.title.trim();
  if (!title) throw new EngineError('A loop needs a title.', 422, 'http');
  const now = new Date();
  const id = `LOOP-${now.getTime()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const subsystem: Loop['spine']['subsystem'] =
    input.lane === 'VFARM_CORE' ? 'VFARM' : input.lane === 'VFARM_MEDIA' ? 'COMMERCIALOPPS' : input.lane === 'CLIENT_CORE' ? 'RESEARCHTWIN' : 'AGENT';
  const loop: Loop = {
    id,
    title,
    owner: input.owner,
    status: 'open',
    age_days: 0,
    raised_at: stamp().slice(0, 10),
    closed_at: null,
    note: input.note?.trim() || null,
    lane: input.lane,
    spine: {
      session_id: `SES-${stamp().slice(0, 10).replace(/-/g, '')}-${input.owner.slice(0, 2).toUpperCase()}-UI`,
      builder_id: input.owner,
      subsystem,
      lane: input.lane,
    },
    tags: {},
    source: f.airtable(id, 'tblBJekl3ROpNZxQW'),
  };
  f.LOOPS.push(loop);
  const o = f.LOOPS_BY_OWNER.find((x) => x.owner === input.owner);
  if (o) o.open += 1;
  return deliver({ ...loop });
}

/* ------------------------------- codex / patterns / commercial / builders */

export function getCodexEntries(q: Query): Promise<CodexData> {
  const entries = bySpineLane(f.CODEX_ENTRIES, q);
  const ingested = entries.filter((e) => e.ingested).length;
  return deliver({
    entries,
    this_week: entries.filter((e) => e.week === '2026-W36').length,
    ingested_rate: entries.length ? `${Math.round((ingested / entries.length) * 100)}%` : '—',
  });
}

export function getBuildPatterns(q: Query): Promise<BuildPatternsData> {
  return deliver({
    patterns: byLane(f.BUILD_PATTERNS, q).sort((a, b) => b.references - a.references),
    reference_note:
      'Reference counts are cumulative since each pattern was ingested. There is no per-week breakdown — nothing records when a reference happened.',
  });
}

export function getCommercial(q: Query): Promise<CommercialData> {
  return deliver({ opportunities: byLane(f.OPPORTUNITIES, q) });
}

export function getBuilders(q: Query): Promise<BuildersData> {
  return deliver({ builders: byLane(f.BUILDERS, q) });
}

export function getBuilder(id: string, q: Query): Promise<BuilderDetail | null> {
  const builder = f.BUILDERS.find((b) => b.id === id);
  if (!builder) return deliver(null);
  return deliver({
    builder,
    loops: byLane(f.LOOPS, q).filter((l: Loop) => l.owner === id),
    entries: bySpineLane(f.CODEX_ENTRIES, q).filter((e) => e.builder_id === id),
    incidents: bySpineLane(f.INCIDENTS, q).filter((i: Incident) => i.spine.builder_id === id),
  });
}

export const BUILDER_NAMES = f.BUILDER_NAMES;
export const LANE_LIST = LANES;
