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
  AskReply,
  AuthSession,
  BuilderDetail,
  BuildersData,
  BuildPattern,
  BuildPatternDetail,
  BuildPatternsData,
  ChatThread,
  CodexData,
  CodexEntry,
  CodexEntryDetail,
  ClientsData,
  CommercialData,
  EngineHealthData,
  EngineStatus,
  Loop,
  LoopStatus,
  NewLoop,
  NsData,
  OpenLoopsData,
  Opportunity,
  OverviewData,
  Query,
  RecordKind,
  RecordMetrics,
  ResyncResponse,
  RtData,
  ServerStatus,
  SignInResult,
  TwinData,
  VFarmData,
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

export function getServerStatus(): Promise<ServerStatus> {
  return api<ServerStatus>('/api/status');
}

/* ----------------------------------------------------------------- reads */

export const getEngineStatus = (q: Query) => api<EngineStatus>(withLane('/api/engine-status', q));
export const getOverview = (q: Query) => api<OverviewData>(withLane('/api/overview', q));
export const getNorthStar = (q: Query) => api<TwinData>(withLane('/api/north-star', q));
export const getResearchTwin = (q: Query) => api<TwinData>(withLane('/api/research-twin', q));
export const getVFarm = (q: Query) => api<VFarmData>(withLane('/api/vfarm', q));
export const getEngineHealth = (q: Query) => api<EngineHealthData>(withLane('/api/engine-health', q));
export const getOpenLoops = (q: Query) => api<OpenLoopsData>(withLane('/api/open-loops', q));
export const getCodexEntries = (q: Query) => api<CodexData>(withLane('/api/codex', q));
export const getBuildPatterns = (q: Query) => api<BuildPatternsData>(withLane('/api/build-patterns', q));
export const getCommercial = (q: Query) => api<CommercialData>(withLane('/api/commercial', q));
export const getBuilders = (q: Query) => api<BuildersData>(withLane('/api/builders', q));

/** North Star's ask log, Research Twin's queue, and the watched-client lanes. */
export const getNsTelemetry = () => api<NsData>('/api/ns-telemetry');
export const getRtTelemetry = () => api<RtData>('/api/rt-telemetry');
export const getClients = () => api<ClientsData>('/api/clients');

export async function getBuilder(id: string, q: Query): Promise<BuilderDetail | null> {
  try {
    return await api<BuilderDetail>(withLane(`/api/builders/${encodeURIComponent(id)}`, q));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/* --------------------------------------------------------------- records */

type MetricsOf<K extends RecordKind> = Extract<RecordMetrics, { kind: K }>;

/** The figures on a records page, computed by the server from the rows it holds. Filtered by builder where the kind has one. */
export function getRecordMetrics<K extends RecordKind>(kind: K, q: Query, builder?: string | null): Promise<MetricsOf<K>> {
  return api<MetricsOf<K>>(withLane(`/api/records/${kind}/metrics`, q, { builder: builder && builder !== 'all' ? builder : null }));
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

export function createLoop(input: NewLoop): Promise<Loop> {
  return api<Loop>('/api/records/loops', { method: 'POST', body: input });
}

/** Rebuilds one kind (or every kind) from Airtable. Slow: a full read of each table. */
export function resync(kind?: RecordKind): Promise<ResyncResponse> {
  return api<ResyncResponse>(kind ? `/api/resync/${kind}` : '/api/resync', { method: 'POST', body: {}, timeoutMs: 180_000 });
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
