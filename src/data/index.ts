/**
 * The data module. One function per section, each returning one object.
 *
 * This is the only file that knows where data comes from: the dashboard's own
 * server, under /api on the same origin. The server holds the fixtures and
 * the record store in phase 1 and will hold the engine connection in phase 2;
 * either way nothing outside this directory changes.
 *
 * Chat threads are the exception. Bays keeps no memory of this dashboard's
 * conversations, so threads typed here persist in this browser only.
 */

import { api, ApiError } from './api';
import type {
  AskBaysData,
  IncidentCloseResult,
  AskReply,
  AuthSession,
  BuildPattern,
  BuildPatternDetail,
  BuildPatternsData,
  ChatThread,
  CodexData,
  CodexEntry,
  CodexEntryDetail,
  RecordStats,
  StatKind,
  ExecutionBackfill,
  ExecutionGrain,
  ExecutionWorkflowDetail,
  ExecutionsData,
  MonthlySeries,
  Resync,
  ClientsData,
  CommercialData,
  Loop,
  LoopEdit,
  LoopStatus,
  Handoffs,
  HealthData,
  HealthMetrics,
  NewLoop,
  NsData,
  PayData,
  PayMetrics,
  OpenLoopsData,
  Opportunity,
  OverviewData,
  Query,
  RecordKind,
  RecordMetrics,
  RegistryData,
  RegistryKind,
  RegistryRowOf,
  RepairsData,
  RetryMetrics,
  RetryResult,
  RevertResult,
  RtData,
  FinalImport,
  ServerStatus,
  SignInResult,
  TwinData,
  VfarmLead,
  VfarmLeadStatus,
  VfarmLeadsData,
} from './types';

export * from './types';
export { ApiError } from './api';

function withLane(path: string, q: Query, extra: Record<string, string | null | undefined> = {}): string {
  const p = new URLSearchParams();
  if (q.lane !== 'all') p.set('lane', q.lane);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** Whole days from today to 31 October, computed at call time. */
export function daysToHalloween(now = new Date()): number {
  const y = now.getFullYear();
  let target = new Date(y, 9, 31);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (target < start) target = new Date(y + 1, 9, 31);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

/* ------------------------------------------------------------------ auth */

/** The one account the team shares, matching BHARAG's console. Shown, never checked, here. */
export const TEAM_EMAIL = 'admin@bhanetwork.org';

/** Asks the server whether this browser's cookie is a live session. */
export async function getSession(): Promise<AuthSession | null> {
  const r = await api<{ signed_in: boolean; session: AuthSession | null }>('/api/auth/session', { quiet401: true });
  return r.signed_in && r.session ? r.session : null;
}

/** Posts the credential to the server. On success the server sets the session cookie. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const e = email.trim().toLowerCase();
  if (!e || !password) return { ok: false, reason: 'missing', message: 'Enter an email address and a password.' };
  try {
    const r = await api<{ ok: true; session: AuthSession }>('/api/auth/login', { body: { email: e, password }, quiet401: true, timeoutMs: 15_000 });
    return { ok: true, session: r.session };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) return { ok: false, reason: 'rejected', message: err.message };
      if (err.status === 429) return { ok: false, reason: 'locked', message: err.message };
      if (err.status === 503) return { ok: false, reason: 'not-configured', message: err.message };
      if (err.kind === 'network' || err.kind === 'timeout') return { ok: false, reason: 'network', message: 'Could not reach the dashboard server to sign in.' };
      return { ok: false, reason: 'rejected', message: err.message };
    }
    return { ok: false, reason: 'network', message: 'Sign-in failed unexpectedly.' };
  }
}

export async function signOutOnServer(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {}, quiet401: true });
  } catch {
    // The cookie is cleared locally regardless.
  }
}

/**
 * The groups the final import runs, in the order the button runs them.
 *
 * Incidents are deliberately absent: they come from BHARAG rather than
 * Airtable, so there is no Airtable copy to import. `engine_events` is the two
 * Airtable tables Engine health reads — `error_counts` and `retry_attempts`,
 * and `bays` is the four tables the Bays workflows use, which are engine-only
 * from here on but each hold real history that has to come across once.
 */
export const FINAL_IMPORT_GROUPS = ['loops', 'codex', 'patterns', 'commercial', 'clients', 'ns', 'rt', 'pay', 'engine_events', 'builders', 'bays'] as const;
export type FinalImportGroup = (typeof FINAL_IMPORT_GROUPS)[number];

export function runFinalImport(group: FinalImportGroup): Promise<FinalImport> {
  // It reads every field of every row in a whole base group, so it is given the
  // same room the resyncs are rather than being cut off mid-sweep.
  return api<FinalImport>(`/api/engine/final-import/${group}`, { method: 'POST', timeoutMs: 180_000 });
}

export function getServerStatus(): Promise<ServerStatus> {
  return api<ServerStatus>('/api/status');
}

/* ----------------------------------------------------------------- reads */

export const getOverview = (q: Query) => api<OverviewData>(withLane('/api/overview', q));
export const getNorthStar = (q: Query) => api<TwinData>(withLane('/api/north-star', q));
export const getResearchTwin = (q: Query) => api<TwinData>(withLane('/api/research-twin', q));
export const getOpenLoops = (q: Query) => api<OpenLoopsData>(withLane('/api/open-loops', q));
export const getCodexEntries = (q: Query) => api<CodexData>(withLane('/api/codex', q));
export const getBuildPatterns = (q: Query) => api<BuildPatternsData>(withLane('/api/build-patterns', q));
export const getCommercial = (q: Query) => api<CommercialData>(withLane('/api/commercial', q));

/**
 * The twins' own ask ledgers, Research Twin's research queue, and the
 * watched-client lanes.
 *
 * Both twins have written to their own ledgers since 17 Sep 2026 — a row per
 * ask, mirrored the moment the run ends. The five `[LEGACY]` tables the pages
 * read until then have no writers left and are read by nothing here.
 */
export const getNsTelemetry = () => api<NsData>('/api/ns-telemetry');
export const getRtTelemetry = () => api<RtData>('/api/rt-telemetry');
export const getClients = () => api<ClientsData>('/api/clients');

/**
 * How often the two twins actually consult each other. One figure about the
 * pair, so it has one route rather than a copy computed on each page.
 */
export const getTwinHandoffs = () => api<Handoffs>('/api/twin-handoffs');

/* -------------------------------------------------------- engine health */

/**
 * `/api/engine-health`, not `/api/health` — that one is the unauthenticated
 * liveness check the host polls, and a page's data route sharing its prefix is
 * how one of them eventually shadows the other.
 */
export const getEngineHealth = () => api<HealthData>('/api/engine-health');

/** Every figure, for one lane or for all three. */
export const getHealthMetrics = (lane?: string | null) =>
  api<HealthMetrics>(`/api/engine-health/metrics${lane ? `?lane=${encodeURIComponent(lane)}` : ''}`);

/** The retry loop's own record. */
export const getRetryMetrics = () => api<RetryMetrics>('/api/engine-health/retries');

/**
 * Reads all five sources — three BHARAG lanes, each with its own credential,
 * and the two Airtable tables — and makes this database match them.
 *
 * Slower than the record resyncs because the ledger is three sequential calls
 * to another host, so it gets the same long timeout they do.
 */
export const resyncHealth = () => api<Resync>('/api/engine-health/resync', { method: 'POST', timeoutMs: 180_000 });

/**
 * The repair record: every automated repair the bridge attempted.
 *
 * One route for the rows and the summary together, because the summary is
 * computed over exactly the rows the list holds — a strip answering one
 * question beside a table answering another is the reconciliation bug the
 * record pages already learned once.
 */
export const getRepairs = () => api<RepairsData>('/api/repairs');

/**
 * Puts one repair back: restores the workflow as it stood before it.
 *
 * Every guard is on the server and the answer names which one refused, so this
 * function never decides whether a revert is allowed — it asks. The message it
 * returns is worded as what happened rather than as success, because a revert
 * also brings back the failure the repair addressed.
 */
export const revertRepair = (repairId: string) => api<RevertResult>(`/api/repairs/${encodeURIComponent(repairId)}/revert`, { method: 'POST', timeoutMs: 90_000 });

/* ------------------------------------------------------------ pay tracker */

/**
 * The pay ledger: who is owed money, for what work, and what has been paid.
 *
 * Read-only from here. Paid status is set by the Slack card or by a monthly
 * statement closing, and two places to change the same fact is how records
 * drift — so there is no write in this module and no route to make one.
 */
export const getPay = () => api<PayData>('/api/pay');
export const getPayMetrics = (month: string | null = null) => api<PayMetrics>(`/api/pay/metrics${month ? `?month=${encodeURIComponent(month)}` : ''}`);
export const resyncPay = () => api<Resync>('/api/pay/resync', { method: 'POST', timeoutMs: 180_000 });

/**
 * Asks the healer to retry one incident — **the same path the 5-minute
 * schedule takes**, not a different mechanism. The answer says the retry was
 * handed over, never that it worked: that is decided by the retried run and
 * arrives on the next resync.
 */
/**
 * Closes incidents a person fixed, in the BHARAG ledger first (2026-09-22).
 * `expected` is the count the confirm dialog named; the server refuses a
 * request whose selection no longer matches it.
 */
export const closeIncidents = (ids: string[]) =>
  api<IncidentCloseResult>('/api/engine-health/incidents/close', { method: 'POST', body: { ids, expected: ids.length }, timeoutMs: 180_000 });

export const retryIncident = (incidentId: string) =>
  api<RetryResult>(`/api/engine-health/retry/${encodeURIComponent(incidentId)}`, { method: 'POST', timeoutMs: 90_000 });

/**
 * Executions, read from the rows this database holds — one row per n8n
 * execution, keyed on n8n's own id.
 *
 * `period` is the week, month or year in view; selecting one on the chart
 * re-reads at that key, so the figures, the workflow table, the comparison and
 * the exported report all describe the same span.
 */
export const getExecutions = (grain: ExecutionGrain = 'week', period?: string) =>
  api<ExecutionsData>(`/api/executions?grain=${grain}${period ? `&period=${encodeURIComponent(period)}` : ''}`);

/** One workflow opened up: its days inside the period, and its individual runs. */
export const getExecutionWorkflow = (workflowId: string, grain: ExecutionGrain, period?: string) =>
  api<ExecutionWorkflowDetail>(`/api/executions/workflow/${encodeURIComponent(workflowId)}?grain=${grain}${period ? `&period=${encodeURIComponent(period)}` : ''}`);

/** Reads n8n's whole history again. Idempotent — every row is keyed on the execution id. */
export const backfillExecutions = () => api<ExecutionBackfill>('/api/executions/backfill', { method: 'POST' });

/** The monthly rollup behind a record page's tracking panel. */
export const getMonthly = (kind: RecordKind) => api<MonthlySeries>(`/api/records/${kind}/monthly`);

/**
 * A record page's statistics tab: one month against the month before it. The
 * month is a parameter so the tab can look at any month held, not only the
 * current one, and the server decides what is honest to compare it against.
 */
export const getRecordStats = (kind: StatKind, month?: string | null) =>
  api<RecordStats>(`/api/records/${kind}/stats${month ? `?month=${encodeURIComponent(month)}` : ''}`);

/* --------------------------------------------------------------- records */

type MetricsOf<K extends RecordKind> = Extract<RecordMetrics, { kind: K }>;

/** The figures on a records page, computed by the server from the rows it holds. Filtered by builder where the kind has one. */
export function getRecordMetrics<K extends RecordKind>(kind: K, q: Query, builder?: string | null, month?: string | null): Promise<MetricsOf<K>> {
  return api<MetricsOf<K>>(
    withLane(`/api/records/${kind}/metrics`, q, { builder: builder && builder !== 'all' ? builder : null, month: month ?? null }),
  );
}

type RecordOf<K extends RecordKind> = K extends 'loops' ? Loop : K extends 'codex' ? CodexEntry : K extends 'patterns' ? BuildPattern : Opportunity;

/**
 * Changes one record's status. The server writes to Airtable first and answers
 * with the row as Airtable now holds it; if Airtable refuses, this throws and
 * nothing changed anywhere.
 */
export function setRecordStatus<K extends RecordKind>(kind: K, id: string, status: string, note?: string): Promise<RecordOf<K>> {
  return api<RecordOf<K>>(`/api/records/${kind}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, note } });
}

export function setLoopStatus(id: string, status: LoopStatus, note?: string): Promise<Loop> {
  return setRecordStatus('loops', id, status, note);
}

/** Edits a record's own fields (Codex entries). Same write-through rule as a status change. */
export function updateRecordFields<K extends RecordKind>(kind: K, id: string, fields: Record<string, unknown>): Promise<RecordOf<K>> {
  return api<RecordOf<K>>(`/api/records/${kind}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { fields } });
}

/**
 * Saves one loop: its What, status, lane, and which builder's table it lives in.
 * The last is a move, not a field — the server recreates the row in the
 * destination table and removes it from the source.
 */
export function saveLoop(id: string, edit: LoopEdit): Promise<Loop> {
  return api<Loop>(`/api/loops/${encodeURIComponent(id)}`, { method: 'PATCH', body: edit, timeoutMs: 60_000 });
}

/**
 * Removes the copy a half-landed move left in the source table, and only that.
 * Nothing is re-created and the destination row is untouched: the loop already
 * lives there.
 */
export function removeLoopDuplicate(id: string): Promise<Loop> {
  return api<Loop>(`/api/loops/${encodeURIComponent(id)}/duplicate`, { method: 'POST', timeoutMs: 60_000 });
}

/**
 * Pulls every Codex row from Airtable and makes the dashboard match it:
 * inserts what Airtable has and we do not, updates what changed there, removes
 * what is gone. Airtable wins every disagreement.
 *
 * Slow on purpose — it reads every field of every row — so it gets its own
 * timeout rather than the default.
 */
export function resyncCodex(): Promise<Resync> {
  return api<Resync>('/api/codex/resync', { method: 'POST', timeoutMs: 180_000 });
}

/**
 * The same pass for Build patterns, Commercial, Clients, Open loops and the two
 * twins. One shared table each for the first two; Clients reads the
 * watched-clients index and then the questions table each index row names in
 * `Table ID`; **Research Twin reads two tables** — its ask ledger and its
 * research queue, because a job is updated in place and the ask mirror never
 * touches it.
 *
 * Airtable wins every disagreement, and a table that could not be read is never
 * read as an emptied one.
 */
export function resyncRecords(kind: 'patterns' | 'commercial' | 'clients' | 'loops' | 'ns' | 'rt'): Promise<Resync> {
  return api<Resync>(`/api/${kind}/resync`, { method: 'POST', timeoutMs: 180_000 });
}

/** Sets Jason Status on one submission: Approved or Pending. */
export function setCodexStatus(id: string, jasonStatus: string): Promise<CodexEntry> {
  return api<CodexEntry>(`/api/codex/${encodeURIComponent(id)}`, { method: 'PATCH', body: { jason_status: jasonStatus }, timeoutMs: 60_000 });
}

/**
 * Deletes one submission from Airtable and from here. `confirm` is the Codex
 * entry id typed back — the server refuses anything else.
 */
/**
 * `airtable.state` is what actually happened on the other side, and the panel
 * words the confirmation from it rather than asserting both sides let go. With
 * AIRTABLE_WRITEBACK off (2026-09-21) the Airtable row is deliberately left in
 * place, and a toast saying "deleted from Airtable and from here" would be a
 * plain untruth.
 */
export function deleteCodexEntry(id: string, confirm: string): Promise<{ ok: true; identifier: string; airtable: { state: 'ok' | 'skipped' | 'failed'; reason: string | null } }> {
  return api(`/api/codex/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirm }, timeoutMs: 60_000 });
}

export function createLoop(input: NewLoop): Promise<Loop> {
  return api<Loop>('/api/records/loops', { method: 'POST', body: input });
}

export function getPatternDetail(id: string): Promise<BuildPatternDetail> {
  return api<BuildPatternDetail>(`/api/build-patterns/${encodeURIComponent(id)}`);
}

/** The full Codex entry text, fetched one entry at a time. The list carries only its opening. */
export function getCodexDetail(id: string): Promise<CodexEntryDetail> {
  return api<CodexEntryDetail>(`/api/codex/${encodeURIComponent(id)}`);
}

/** Server-side search across every text field of every pattern. */
export function searchPatterns(q: string): Promise<{ patterns: BuildPattern[] }> {
  return api<{ patterns: BuildPattern[] }>(`/api/build-patterns/search?q=${encodeURIComponent(q)}`);
}

/* -------------------------------------------------------------- ask bays */

const CHATS_KEY = 'bha.chats';
const CHATS_DELETED_KEY = 'bha.chats.deleted';

function readDeleted(): string[] {
  try {
    const raw = localStorage.getItem(CHATS_DELETED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Remembers that a thread was deleted, so a seeded one does not come back. */
export function forgetThread(id: string): void {
  try {
    const ids = new Set(readDeleted());
    ids.add(id);
    localStorage.setItem(CHATS_DELETED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable.
  }
}

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

/** Threads typed in this dashboard persist in the browser only. */
export function saveLocalThreads(threads: ChatThread[]): void {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(threads.filter((t) => t.local)));
  } catch {
    // Storage unavailable: the thread lives for this page only.
  }
}

export async function getAskBays(q: Query): Promise<AskBaysData> {
  const server = await api<AskBaysData>(withLane('/api/ask-bays', q));
  const local = readLocalThreads();
  const deleted = new Set(readDeleted());
  const seeded = server.threads.filter((t) => !local.some((l) => l.id === t.id) && !deleted.has(t.id));
  return {
    ...server,
    threads: [...local, ...seeded]
      .filter((t) => !deleted.has(t.id))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (a.updated_at < b.updated_at ? 1 : -1)),
  };
}

/**
 * Sends one message to Bays through the server and waits for the answer. The
 * session_id is the thread's, stable for its life, which is what gives Bays
 * its memory of the conversation. Never throws: a failure comes back as an
 * ok:false reply whose answer says what happened and whose `error` says which
 * kind, so the screen can show a refusal as a refusal rather than as Bays.
 *
 * The server allows the agent five minutes; this waits a little longer so a
 * server-side timeout arrives as the server's own answer rather than as this
 * request giving up first and losing the reason.
 */
export async function askBays(message: string, sessionId: string, builderId: string): Promise<AskReply> {
  try {
    return await api<AskReply>('/api/ask', { body: { message, session_id: sessionId, builder_id: builderId }, timeoutMs: 320_000 });
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.kind === 'timeout') return { ok: false, answer: 'Bays did not answer in time.', session_id: sessionId, steps: [], error: 'timeout' };
      if (e.kind === 'network') return { ok: false, answer: 'Could not reach the dashboard server.', session_id: sessionId, steps: [], error: 'unreachable' };
      return { ok: false, answer: e.message, session_id: sessionId, steps: [], error: 'bad_response' };
    }
    return { ok: false, answer: 'Something went wrong sending that.', session_id: sessionId, steps: [], error: 'bad_response' };
  }
}

export { BUILDER_NAMES, LANE_LIST, LOOP_LANE_TAGS } from './names';

/* -------------------------------------------------------------- registry */

/**
 * The System Registry. Unlike the record kinds above, this dashboard is the
 * system of record: a write here goes straight to Postgres, because there is no
 * Airtable base behind these tables to write through to first.
 */
export function getRegistry(includeDeleted = false): Promise<RegistryData> {
  return api<RegistryData>(includeDeleted ? '/api/registry?deleted=true' : '/api/registry');
}

export function createRegistryRow<K extends RegistryKind>(kind: K, fields: Record<string, unknown>): Promise<RegistryRowOf[K]> {
  return api<RegistryRowOf[K]>(`/api/registry/${kind}`, { method: 'POST', body: fields });
}

/** Edits the fields named and leaves every other one alone. */
export function updateRegistryRow<K extends RegistryKind>(kind: K, id: string, fields: Record<string, unknown>): Promise<RegistryRowOf[K]> {
  return api<RegistryRowOf[K]>(`/api/registry/${kind}/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields });
}

/** Soft delete: the row keeps its id and can be restored. Nothing here deletes outright. */
export function deleteRegistryRow<K extends RegistryKind>(kind: K, id: string): Promise<RegistryRowOf[K]> {
  return api<RegistryRowOf[K]>(`/api/registry/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function restoreRegistryRow<K extends RegistryKind>(kind: K, id: string): Promise<RegistryRowOf[K]> {
  return api<RegistryRowOf[K]>(`/api/registry/${kind}/${encodeURIComponent(id)}`, { method: 'POST', body: { restore: true } });
}

/* --------------------------------------------------------- engine writes */


/* ----------------------------------------------- vFarm Early Access */

/**
 * The Early Access leads and the figures over them.
 *
 * Behind the session cookie like every other page read. The route that
 * *writes* these rows is public — it is the form on bhanetwork.org — and it can
 * never read one back; see server/src/earlyAccess.ts.
 */
export const getVfarmLeads = () => api<VfarmLeadsData>('/api/vfarm/leads');

/**
 * A lead's status, or its notes, or both. Nothing else about a lead is
 * editable, and the server refuses anything else rather than ignoring it.
 */
export function editVfarmLead(id: string, changes: { status?: VfarmLeadStatus; notes?: string | null }): Promise<VfarmLead> {
  return api<VfarmLead>(`/api/vfarm/leads/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
}
