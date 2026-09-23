/**
 * Engine recovery: re-running what failed because something it depends on was
 * down, once that thing is back (2026-09-23, Destiny — brief D2).
 *
 * When OpenRouter runs out of credit, a Slack or Google login lapses, or
 * BHARAG stops answering, every workflow that touches it fails, and each
 * failure is already an open incident in the BHARAG ledger. The healer retries
 * a failure three times over twenty minutes and then stops, which is right for
 * a blip and useless for an outage that lasts an afternoon: once the credit is
 * topped up nothing re-runs the day's failures. This does.
 *
 * **The ledger is the queue.** Nothing here keeps a payload to replay — n8n
 * still holds each failed run's input, and the healer resumes it from the
 * failed step with `loadWorkflow: true`. `engine_recovery` holds only what the
 * watcher decided about each incident and what came of it.
 *
 * Every five minutes, and only while something is waiting:
 *
 *   1. off switch — the page toggle, and `RECOVERY_ENABLED=false` over it;
 *   2. read the live incidents, and note which ones wait on a dependency;
 *      nothing waiting means **no probe**;
 *   3. probe once — the n8n `Engine — Dependency Probe` for OpenRouter, Slack
 *      and Google, and BHARAG from the ledger read this tick already made;
 *   4. for each dependency that is waited on and ok, drain a batch: oldest
 *      first, twenty seconds apart, checking before each re-run that it is not
 *      already done — in the ledger, then in n8n — and never re-running a chat
 *      reply;
 *   5. settle each re-run from `retry_attempts`, where the healer writes it;
 *   6. once a batch is settled, send **one** summary to #bha-self-healing.
 *
 * **Nothing is written to BHARAG but a status**: its `/status` route takes
 * `{ resolution_status, payload_patch }` and refused an extra field on 22 Sep
 * (`LEDGER_PAYLOAD_SCHEMA_MISMATCH`), so what an incident waits on is worked
 * out from what it already carries, every time, and kept here.
 */
import { getMeta, nowIso, setMeta } from './db';
import { query } from './pg';
import * as events from './events';
import * as bharag from './bharag';
import * as mirror from './mirror';
import * as n8n from './n8n';
import type {
  DependencyState,
  RecoveryBatch,
  RecoveryData,
  RecoveryDependency,
  RecoveryPlan,
  RecoveryProbe,
  RecoveryRerunResult,
  RecoveryRow,
  RecoveryRun,
  RecoverySkip,
  RecoveryStatus,
} from '../../src/data/types';

/* ---------------------------------------------------------------- config */

export const TICK_MS = 5 * 60_000;
/** Between two re-runs in one batch, so a recovered dependency is not hit with a day's backlog at once. */
export const GAP_MS = 20_000;
let gapMs = GAP_MS;
/** For `npm run test:recovery` only, so a five-row batch does not take ninety seconds. */
export function setGapForTests(ms: number): void {
  gapMs = ms;
}
/** A 5xx or a timeout younger than this is still the healer's: it retries those itself for about twenty minutes. */
const YOUNG_MS = 30 * 60_000;
/** A re-run the healer has said nothing about after this long is given up on, and says so. */
const GIVE_UP_MS = 45 * 60_000;

export const DEPENDENCIES: RecoveryDependency[] = ['openrouter', 'slack', 'google', 'bharag'];
export const DEPENDENCY_LABEL: Record<RecoveryDependency, string> = { openrouter: 'OpenRouter', slack: 'Slack', google: 'Google', bharag: 'BHARAG' };

export const ENABLED_VAR = 'RECOVERY_ENABLED';
const TOGGLE_KEY = 'recovery.enabled';
const PROBE_KEY = 'recovery.last_probe';
const TICK_KEY = 'recovery.last_tick';

const PROBE_PATH = '/webhook/engine-dependency-probe';
const SUMMARY_PATH = '/webhook/engine-recovery-summary';

function inboundKey(): string | null {
  return process.env.DASHBOARD_INBOUND_KEY?.trim() || null;
}

/** `RECOVERY_ENABLED=false` (or 0 / off / no) is a hard override; anything else leaves it to the toggle. */
export function envDisabled(): boolean {
  const v = (process.env[ENABLED_VAR] ?? '').trim().toLowerCase();
  return ['false', '0', 'off', 'no'].includes(v);
}

interface Toggle {
  on: boolean;
  by: string | null;
  at: string | null;
}

async function toggle(): Promise<Toggle> {
  const raw = await getMeta(TOGGLE_KEY);
  if (!raw) return { on: true, by: null, at: null };
  try {
    const t = JSON.parse(raw) as Partial<Toggle>;
    return { on: t.on !== false, by: t.by ?? null, at: t.at ?? null };
  } catch {
    return { on: true, by: null, at: null };
  }
}

async function enabled(): Promise<{ on: boolean; by: 'env' | 'toggle' | null; toggle: Toggle }> {
  const t = await toggle();
  if (envDisabled()) return { on: false, by: 'env', toggle: t };
  return { on: t.on, by: t.on ? null : 'toggle', toggle: t };
}

/**
 * Flips the page toggle. Stored in Postgres so it flips without a deploy, and
 * every flip is a line in `record_writes` with who made it.
 */
export async function setEnabled(on: boolean, actor: string): Promise<RecoveryData> {
  const at = nowIso();
  await setMeta(TOGGLE_KEY, JSON.stringify({ on, by: actor, at }));
  await query(
    `INSERT INTO record_writes (kind, record_id, natural_id, state, status, reason, http, action, detail, actor, at)
     VALUES ('recovery', 'recovery-switch', 'recovery-switch', 'ok', $1, NULL, NULL, 'toggle', $2, $3, $4)`,
    [on ? 'on' : 'off', `Engine recovery switched ${on ? 'on' : 'off'} from Engine health${envDisabled() ? ` — ${ENABLED_VAR}=false still overrides it` : ''}`, actor, at],
  );
  console.log(`recovery: switched ${on ? 'on' : 'off'} by ${actor}`);
  events.changed('recovery');
  return data();
}

/* ------------------------------------------------------ what it waits on */

interface OpenIncident {
  incident_id: string;
  lane: string | null;
  status: string | null;
  workflow: string | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  execution_id: string | null;
  failed_at: string | null;
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
}

function fromLedger(i: Record<string, unknown>, laneHint: string | null): OpenIncident | null {
  const id = s(i.entity_id) ?? s(i.id);
  if (!id) return null;
  const p = (i.payload && typeof i.payload === 'object' && !Array.isArray(i.payload) ? i.payload : {}) as Record<string, unknown>;
  return {
    incident_id: id,
    lane: s(i.source) ?? s(p.lane) ?? laneHint,
    status: s(i.resolution_status),
    workflow: s(p.workflow_or_scenario),
    failed_node: s(p.failed_node_or_component),
    error_class: s(p.error_class)?.toUpperCase() ?? null,
    error_message: s(p.error_message),
    execution_id: s(p.execution_id),
    failed_at: s(i.occurred_at) ?? s(i.created_at) ?? s(p.timestamp),
  };
}

interface IncidentRead {
  incidents: OpenIncident[];
  /** Lanes whose live read answered this tick. Only those may conclude an incident is gone. */
  live: Set<string>;
  errors: Record<string, string>;
}

/**
 * The live incidents, from the ledger where a lane answers and from the mirror
 * where it does not. A lane read from the mirror is never used to decide that
 * an incident has gone — an unread lane is not an empty one.
 */
async function readIncidents(): Promise<IncidentRead> {
  const out: OpenIncident[] = [];
  const live = new Set<string>();
  const errors: Record<string, string> = {};
  for (const lane of Object.keys(bharag.LANE_KEY_VARS)) {
    if (bharag.laneConfigured(lane)) {
      try {
        const rows = await bharag.liveIncidents(lane);
        for (const r of rows) {
          const inc = fromLedger(r as Record<string, unknown>, lane);
          if (inc) out.push(inc);
        }
        live.add(lane);
        continue;
      } catch (e) {
        errors[lane] = e instanceof Error ? e.message : String(e);
      }
    } else {
      errors[lane] = `${bharag.LANE_KEY_VARS[lane]} is not set`;
    }
    const held = await query<{ fields: Record<string, unknown> }>(`SELECT fields FROM engine_incidents WHERE lane_id = $1 AND open_now IS NOT FALSE`, [lane]);
    for (const r of held.rows) {
      const inc = fromLedger(r.fields ?? {}, lane);
      if (inc) out.push(inc);
    }
  }
  return { incidents: out, live, errors };
}

interface Classified {
  dependency: RecoveryDependency | null;
  from: string;
  workflow_id: string | null;
}

/**
 * What an incident's class, failed node or its credential says it waits on.
 * Cached per incident for the life of the process — the answer is a fact about
 * a run that has finished, and asking n8n for the same execution every five
 * minutes would be the watcher generating load of its own.
 */
const classified = new Map<string, Classified>();

const CLASS_BY_NODE = new Set(['CONFIG_AUTH']);
const CLASS_BY_HOST = new Set(['UPSTREAM_5XX', 'NETWORK_TIMEOUT']);

function hostDependency(host: string): RecoveryDependency | null {
  const h = host.toLowerCase();
  if (h === 'openrouter.ai' || h.endsWith('.openrouter.ai')) return 'openrouter';
  if (h === 'slack.com' || h.endsWith('.slack.com')) return 'slack';
  if (h === 'googleapis.com' || h.endsWith('.googleapis.com')) return 'google';
  if (h === 'bharag2.duckdns.org') return 'bharag';
  return null;
}

function credentialDependency(node: n8n.N8nNode): { dependency: RecoveryDependency; from: string } | null {
  for (const [type, cred] of Object.entries(node.credentials ?? {})) {
    if (type === 'openRouterApi') return { dependency: 'openrouter', from: `credential ${type}` };
    if (type === 'slackApi' || type === 'slackOAuth2Api') return { dependency: 'slack', from: `credential ${type}` };
    if (/^google/i.test(type) || /^gmail/i.test(type)) return { dependency: 'google', from: `credential ${type}` };
    if (type === 'httpHeaderAuth' && /^BHARAG/i.test(cred?.name ?? '')) return { dependency: 'bharag', from: `credential ${type} "${cred?.name}"` };
  }
  return null;
}

function urlDependency(node: n8n.N8nNode): { dependency: RecoveryDependency; from: string } | null {
  const url = node.parameters?.url;
  if (typeof url !== 'string') return null;
  const m = url.match(/https?:\/\/([^/\s'"`{}:?]+)/i);
  if (!m) return null;
  const dep = hostDependency(m[1]);
  return dep ? { dependency: dep, from: `host ${m[1]}` } : null;
}

type ClassifyResult = { kind: 'dependency'; value: Classified } | { kind: 'skip'; reason: string; cache: boolean };

async function classify(inc: OpenIncident): Promise<ClassifyResult> {
  const hit = classified.get(inc.incident_id);
  if (hit) return hit.dependency ? { kind: 'dependency', value: hit } : { kind: 'skip', reason: hit.from, cache: true };

  const cls = inc.error_class ?? '';
  const remember = (c: Classified): ClassifyResult => {
    classified.set(inc.incident_id, c);
    return c.dependency ? { kind: 'dependency', value: c } : { kind: 'skip', reason: c.from, cache: true };
  };

  if (cls === 'BILLING_QUOTA') return remember({ dependency: 'openrouter', from: 'error class BILLING_QUOTA', workflow_id: null });
  if (!CLASS_BY_NODE.has(cls) && !CLASS_BY_HOST.has(cls)) {
    return remember({ dependency: null, from: `${cls ? `${cls} is` : 'An unclassified incident is'} not a class that waits on a dependency — left to the healer and people.`, workflow_id: null });
  }
  if (!inc.execution_id) return remember({ dependency: null, from: 'No execution id on the incident, so there is no failed node to read and nothing to resume.', workflow_id: null });
  if (!inc.failed_node) return remember({ dependency: null, from: 'The incident names no failed node, so what it depends on cannot be read.', workflow_id: null });
  if (!n8n.n8nConfigured()) return { kind: 'skip', reason: `${n8n.N8N_API_VAR} is not set, so the failed node cannot be read.`, cache: false };

  let exec: n8n.N8nExecutionDetail | null;
  try {
    exec = await n8n.executionDetail(inc.execution_id);
  } catch (e) {
    return { kind: 'skip', reason: `Could not read execution ${inc.execution_id}: ${e instanceof Error ? e.message : String(e)}`, cache: false };
  }
  if (!exec) return remember({ dependency: null, from: `n8n no longer holds execution ${inc.execution_id}, so its failed node cannot be read and there is nothing to resume.`, workflow_id: null });
  const wfId = s(exec.workflowId) ?? s(exec.workflowData?.id);
  const node = (exec.workflowData?.nodes ?? []).find((n) => n.name === inc.failed_node);
  if (!node) return remember({ dependency: null, from: `No node named "${inc.failed_node}" in the workflow as it ran.`, workflow_id: wfId });

  // CONFIG_AUTH reads the credential; a 5xx or a timeout reads the host. Each
  // falls back to the other, because an HTTP Request node carrying a Slack
  // credential and a Slack node with no URL both say plainly what they call.
  const first = CLASS_BY_NODE.has(cls) ? credentialDependency(node) ?? urlDependency(node) : urlDependency(node) ?? credentialDependency(node);
  if (!first) return remember({ dependency: null, from: `"${inc.failed_node}" calls nothing this watcher probes (OpenRouter, Slack, Google, BHARAG).`, workflow_id: wfId });
  return remember({ dependency: first.dependency, from: first.from, workflow_id: wfId });
}

/* ------------------------------------------------------------ the rows */

interface HeldRow {
  incident_id: string;
  lane: string | null;
  workflow: string | null;
  workflow_id: string | null;
  execution_id: string | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  failed_at: string | null;
  dependency: RecoveryDependency;
  dependency_from: string | null;
  status: RecoveryStatus;
  batch_id: string | null;
  retry_execution_id: string | null;
  note: string | null;
  replay_started_at: string | null;
  first_seen_at: string;
  updated_at: string;
}

const COLS = `incident_id, lane, workflow, workflow_id, execution_id, failed_node, error_class, error_message, failed_at, dependency, dependency_from, status, batch_id, retry_execution_id, note, replay_started_at, first_seen_at, updated_at`;

function asRow(r: HeldRow): RecoveryRow {
  return {
    incident_id: r.incident_id,
    lane: r.lane,
    workflow: r.workflow,
    workflow_id: r.workflow_id,
    execution_id: r.execution_id,
    failed_node: r.failed_node,
    error_class: r.error_class,
    failed_at: r.failed_at,
    dependency: r.dependency,
    dependency_from: r.dependency_from,
    status: r.status,
    batch_id: r.batch_id,
    retry_execution_id: r.retry_execution_id,
    note: r.note,
    replay_started_at: r.replay_started_at,
    first_seen_at: r.first_seen_at,
    updated_at: r.updated_at,
    execution_url: r.workflow_id && r.execution_id ? n8n.executionUrl(r.workflow_id, r.execution_id) : null,
  };
}

async function setRow(id: string, patch: Partial<Pick<HeldRow, 'status' | 'batch_id' | 'retry_execution_id' | 'note' | 'replay_started_at' | 'workflow_id'>>): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await query(`UPDATE engine_recovery SET ${[...sets, `updated_at = $${keys.length + 2}`].join(', ')} WHERE incident_id = $1`, [id, ...keys.map((k) => patch[k] ?? null), nowIso()]);
  events.changed('recovery');
}

/** The open incidents looked at and passed over on the last refresh, for the plan. */
let lastSkipped: RecoverySkip[] = [];

/**
 * Brings `engine_recovery` up to date with the live incidents. New incidents
 * that wait on something become `waiting`; a waiting incident that a live
 * ledger read no longer returns was closed by somebody else first and is
 * `already_done`. Returns the read, so the tick can use it as BHARAG's probe.
 */
async function refresh(): Promise<IncidentRead> {
  const read = await readIncidents();
  const held = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery`);
  const byId = new Map(held.rows.map((r) => [r.incident_id, r]));
  const skipped: RecoverySkip[] = [];
  const now = Date.now();

  for (const inc of read.incidents) {
    if (byId.has(inc.incident_id)) continue;
    const c = await classify(inc);
    if (c.kind === 'skip') {
      skipped.push({ incident_id: inc.incident_id, lane: inc.lane, workflow: inc.workflow, error_class: inc.error_class, reason: c.reason });
      continue;
    }
    if (CLASS_BY_HOST.has(inc.error_class ?? '')) {
      const t = inc.failed_at ? Date.parse(inc.failed_at) : NaN;
      if (!Number.isFinite(t) || now - t < YOUNG_MS) {
        skipped.push({
          incident_id: inc.incident_id,
          lane: inc.lane,
          workflow: inc.workflow,
          error_class: inc.error_class,
          reason: Number.isFinite(t)
            ? `Waits on ${DEPENDENCY_LABEL[c.value.dependency!]}, but is under 30 minutes old — the healer is still retrying it.`
            : 'Carries no failure time, so whether the healer is still retrying it cannot be told.',
        });
        continue;
      }
    }
    const at = nowIso();
    await query(
      `INSERT INTO engine_recovery (incident_id, lane, workflow, workflow_id, execution_id, failed_node, error_class, error_message, failed_at, dependency, dependency_from, status, first_seen_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'waiting',$12,$12) ON CONFLICT (incident_id) DO NOTHING`,
      [inc.incident_id, inc.lane, inc.workflow, c.value.workflow_id, inc.execution_id, inc.failed_node, inc.error_class, inc.error_message, inc.failed_at, c.value.dependency, c.value.from, at],
    );
    console.log(`recovery: ${inc.incident_id} (${inc.workflow ?? 'unnamed workflow'}) is waiting on ${c.value.dependency} — ${c.value.from}`);
    events.changed('recovery');
  }

  const liveIds = new Set(read.incidents.map((i) => i.incident_id));
  for (const r of held.rows) {
    if (r.status !== 'waiting' || r.batch_id) continue;
    if (!r.lane || !read.live.has(r.lane) || liveIds.has(r.incident_id)) continue;
    await setRow(r.incident_id, { status: 'already_done', note: 'Closed in the ledger — by a person or the healer — before a recovery batch reached it.' });
  }

  lastSkipped = skipped;
  return read;
}

/* ------------------------------------------------------------ the probe */

async function postN8n(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  const key = inboundKey();
  if (!key) throw new Error('DASHBOARD_INBOUND_KEY is not set on this server, and the recovery webhooks are authenticated by it.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${n8n.n8nHost()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-dashboard-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new Error(timedOut ? `n8n did not answer ${path} within ${Math.round(timeoutMs / 1000)} seconds.` : `Could not reach n8n at ${path}.`);
  } finally {
    clearTimeout(timer);
  }
}

function depState(v: unknown): DependencyState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);
  return {
    ok: typeof o.ok === 'boolean' ? o.ok : null,
    status: s(o.status),
    detail: s(o.detail),
    ...(o.remaining_usd !== undefined ? { remaining_usd: num(o.remaining_usd) } : {}),
    ...(o.floor_usd !== undefined ? { floor_usd: num(o.floor_usd) } : {}),
  };
}

/**
 * One probe. OpenRouter, Slack and Google come from the n8n probe workflow;
 * BHARAG comes from the ledger read this tick has just made — ok where any
 * keyed lane answered, unknown where none is keyed.
 */
async function probe(read: IncidentRead): Promise<RecoveryProbe> {
  const unknown: DependencyState = { ok: null, status: null, detail: null };
  const keyed = bharag.configuredLanes();
  const bharagState: DependencyState = !keyed.length
    ? { ok: null, status: 'not configured', detail: 'No BHARAG lane key is set on this server.' }
    : read.live.size
      ? { ok: true, status: 'ok', detail: `The ledger answered for ${[...read.live].join(', ')}.` }
      : { ok: false, status: 'unreachable', detail: Object.values(read.errors).join(' · ') || 'No lane answered.' };
  const result: RecoveryProbe = {
    checked_at: nowIso(),
    dependencies: { openrouter: unknown, slack: unknown, google: unknown, bharag: bharagState },
    error: null,
  };
  try {
    const r = await postN8n(PROBE_PATH, {}, 30_000);
    if (r.status < 200 || r.status >= 300) throw new Error(`The dependency probe answered ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : '.'}`);
    const body = JSON.parse(r.text) as Record<string, unknown>;
    result.checked_at = s(body.checked_at) ?? result.checked_at;
    result.dependencies.openrouter = depState(body.openrouter);
    result.dependencies.slack = depState(body.slack);
    result.dependencies.google = depState(body.google);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  await setMeta(PROBE_KEY, JSON.stringify(result));
  return result;
}

async function lastProbe(): Promise<RecoveryProbe | null> {
  const raw = await getMeta(PROBE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecoveryProbe;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- closing the ledger */

/**
 * Closes one incident the watcher has settled without a re-run. The ledger
 * requires `open -> retrying` before `self_healed`, the same two steps Self
 * Healer Reports takes; `wont_fix` falls back to `manually_resolved` where the
 * ledger refuses it. Mirrored and logged the way a person's close is.
 */
async function closeLedger(row: HeldRow, ledgerStatus: string | null, state: bharag.LedgerTerminal, resolvedBy: string): Promise<{ ok: boolean; state: string; reason: string | null }> {
  const lane = row.lane ?? '';
  const at = nowIso();
  let landed: string = state;
  let reason: string | null = null;
  let http: number | null = 200;
  try {
    if (ledgerStatus !== 'retrying') await bharag.markRetrying(lane, row.incident_id);
    try {
      await bharag.closeIncident(lane, row.incident_id, resolvedBy, at, state);
    } catch (e) {
      if (state !== 'wont_fix') throw e;
      await bharag.closeIncident(lane, row.incident_id, resolvedBy, at, 'manually_resolved');
      landed = 'manually_resolved';
      reason = `The ledger refused wont_fix (${e instanceof Error ? e.message : String(e)}), so it was closed as manually_resolved.`;
    }
  } catch (e) {
    http = e instanceof bharag.BharagError ? e.status || null : null;
    const why = e instanceof Error ? e.message : String(e);
    await logLedger(row, 'failed', ledgerStatus ?? 'open', why, http, state, resolvedBy);
    return { ok: false, state: ledgerStatus ?? 'open', reason: why };
  }
  await query(`UPDATE engine_incidents SET fields = fields || $2::jsonb, open_now = false, updated_at = $3 WHERE natural_id = $1`, [
    row.incident_id,
    JSON.stringify({ resolution_status: landed }),
    at,
  ]);
  events.changed('incidents');
  await logLedger(row, 'ok', landed, reason, http, landed, resolvedBy);
  return { ok: true, state: landed, reason };
}

async function logLedger(row: HeldRow, ok: 'ok' | 'failed', status: string, reason: string | null, http: number | null, target: string, resolvedBy: string): Promise<void> {
  await query(
    `INSERT INTO record_writes (kind, record_id, natural_id, state, status, reason, http, action, detail, actor, at)
     VALUES ('incidents', $1, $1, $2, $3, $4, $5, 'close', $6, 'recovery', $7)`,
    [row.incident_id, ok, status, reason, http, `POST ${bharag.BHARAG_URL}/incidents/${row.incident_id}/status → retrying → ${target} (lane ${row.lane ?? 'none'}, ${resolvedBy})`, nowIso()],
  );
}

/* ------------------------------------------------------------ the re-run */

async function replayPolicy(workflowId: string | null, name: string | null): Promise<'auto' | 'never'> {
  const r = await query<{ replay: string }>(
    `SELECT replay FROM registry_workflows WHERE deleted_at IS NULL AND (id = $1 OR name = $2) ORDER BY (id = $1) DESC LIMIT 1`,
    [workflowId ?? '', name ?? ''],
  );
  return r.rows[0]?.replay === 'never' ? 'never' : 'auto';
}

/**
 * Step 4 for one incident, in the brief's order. Each branch leaves the row
 * in exactly one state; an answer this code could not get (the ledger or n8n
 * not reachable) puts it back to `waiting` outside the batch rather than
 * guessing, so it is tried again once they answer.
 */
async function processOne(row: HeldRow): Promise<RecoveryStatus> {
  const lane = row.lane ?? '';
  const back = async (note: string) => {
    await setRow(row.incident_id, { status: 'waiting', batch_id: null, note });
    return 'waiting' as const;
  };

  // Already done, check 1 — the ledger, read live.
  let ledger: bharag.LedgerIncident | undefined;
  try {
    ledger = (await bharag.liveIncidents(lane)).find((i) => (s(i.entity_id) ?? s(i.id)) === row.incident_id);
  } catch (e) {
    return back(`The ledger could not be read before the re-run: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ledger) {
    await setRow(row.incident_id, { status: 'already_done', note: 'No longer open in the ledger — a person or the healer closed it first.' });
    return 'already_done';
  }
  const ledgerStatus = s(ledger.resolution_status);

  // Already done, check 2 — n8n.
  if (!row.execution_id) {
    await setRow(row.incident_id, { status: 'data_gone', note: 'The incident carries no execution id, so there is nothing to resume.' });
    return 'data_gone';
  }
  let exec: n8n.N8nExecutionDetail | null;
  try {
    exec = await n8n.executionDetail(row.execution_id);
  } catch (e) {
    return back(`n8n could not be asked about execution ${row.execution_id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!exec) {
    await setRow(row.incident_id, { status: 'data_gone', note: `n8n no longer holds execution ${row.execution_id} (404) — it has been pruned, so it can only be re-run from its own trigger.` });
    return 'data_gone';
  }
  const workflowId = s(exec.workflowId) ?? row.workflow_id;
  if (workflowId && workflowId !== row.workflow_id) await setRow(row.incident_id, { workflow_id: workflowId });
  const retried = s(exec.retrySuccessId);
  if (retried) {
    const c = await closeLedger(row, ledgerStatus, 'self_healed', 'recovery:already_done');
    await setRow(row.incident_id, {
      status: 'already_done',
      retry_execution_id: retried,
      note: c.ok ? `n8n already holds a successful retry (${retried}); the ledger incident was closed as self_healed.` : `n8n already holds a successful retry (${retried}), but the ledger refused the close: ${c.reason}`,
    });
    return 'already_done';
  }

  // A chat reply is never re-run.
  if ((await replayPolicy(workflowId, row.workflow)) === 'never') {
    const c = await closeLedger(row, ledgerStatus, 'wont_fix', 'recovery:chat_not_rerun');
    await setRow(row.incident_id, {
      status: 'chat_not_rerun',
      note: c.ok
        ? `A chat reply: the registry says never re-run it. Closed in the ledger as ${c.state}.${c.reason ? ` ${c.reason}` : ''}`
        : `A chat reply: the registry says never re-run it. The ledger refused the close and it is still open there: ${c.reason}`,
    });
    return 'chat_not_rerun';
  }

  // Otherwise, re-run from the failed step.
  const started = nowIso();
  try {
    const res = await bharag.heal({
      execution_id: row.execution_id,
      lane,
      workflow: row.workflow ?? '',
      failed_node: row.failed_node ?? '',
      error_class: row.error_class ?? '',
      incident_id: row.incident_id,
      error_message: row.error_message ?? '',
      recovery: true,
    });
    await mirror.logWrite({
      endpoint: bharag.HEAL_URL,
      kind: 'retry_attempts',
      method: 'POST',
      key_label: null,
      natural_id: row.incident_id,
      outcome: res.status >= 200 && res.status < 300 ? 'updated' : 'error',
      detail: `recovery re-run (recovery: true, ${row.dependency} back) → HTTP ${res.status}`,
    });
    if (res.status < 200 || res.status >= 300) {
      await setRow(row.incident_id, { status: 'failed_again', note: `The healer refused the re-run: HTTP ${res.status}${res.body ? ` — ${res.body.slice(0, 200)}` : ''}` });
      return 'failed_again';
    }
    await setRow(row.incident_id, { status: 'replaying', replay_started_at: started, note: `Handed to the healer with recovery: true at ${started.slice(11, 19)} UTC.` });
    return 'replaying';
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A healer that took over a minute may still have started the retry; the
    // retry record says, and the give-up clock covers it if it never does.
    if (/did not answer/.test(why)) {
      await setRow(row.incident_id, { status: 'replaying', replay_started_at: started, note: why });
      return 'replaying';
    }
    await setRow(row.incident_id, { status: 'failed_again', note: `The healer could not be asked: ${why}` });
    return 'failed_again';
  }
}

/* ------------------------------------------------------------ settling */

/**
 * Settles every `replaying` row from `retry_attempts`, where the healer writes
 * the outcome under the incident id. Only a row written **after** the re-run
 * started counts: an incident the schedule already exhausted carries an old
 * `Exhausted` row, and reading that as this re-run's answer would fail every
 * recovery before it began.
 */
async function settle(): Promise<void> {
  const rows = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE status = 'replaying'`);
  for (const r of rows.rows) {
    const since = r.replay_started_at ?? r.updated_at;
    const att = await query<{ status: string | null; retry_execution_id: string | null; last_result: string | null; last_attempt_at: string | null; updated_at: string }>(
      `SELECT fields->>'status' AS status, fields->>'retry_execution_id' AS retry_execution_id, fields->>'last_result' AS last_result,
              fields->>'last_attempt_at' AS last_attempt_at, updated_at
         FROM engine_retry_attempts WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [r.incident_id],
    );
    const a = att.rows[0];
    const fresh = a && ((a.last_attempt_at ?? '') >= since || a.updated_at >= since);
    if (fresh && a.status === 'Recovered') {
      await setRow(r.incident_id, { status: 'recovered', retry_execution_id: a.retry_execution_id || null, note: a.last_result ?? 'Recovered by the healer; the ledger incident is closed as self_healed.' });
      continue;
    }
    if (fresh && a.status === 'Exhausted') {
      await setRow(r.incident_id, { status: 'failed_again', retry_execution_id: a.retry_execution_id || null, note: a.last_result ?? 'The healer used its three attempts; the incident stays open for a person.' });
      continue;
    }
    if (Date.now() - Date.parse(since) > GIVE_UP_MS) {
      await setRow(r.incident_id, { status: 'failed_again', note: 'no result from the healer' });
    }
  }
}

const OPEN_STATES = ['waiting', 'replaying'];

function asRun(r: HeldRow): RecoveryRun {
  return {
    workflow: r.workflow ?? r.workflow_id ?? 'an unnamed workflow',
    execution_id: r.execution_id ?? '',
    outcome: r.status as RecoveryRun['outcome'],
    ...(r.retry_execution_id ? { retry_execution_id: r.retry_execution_id } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
}

/**
 * Sends the summary for every batch that has settled and has not sent one.
 * The claim and the send are one statement's worth apart — `summary_sent_at`
 * is set where it is still null and only the caller that set it posts — so
 * two ticks, or a tick and a Re-run now, cannot both send.
 */
async function finishBatches(): Promise<void> {
  const open = await query<{ batch_id: string; dependency: RecoveryDependency }>(`SELECT batch_id, dependency FROM engine_recovery_batches WHERE summary_sent_at IS NULL`);
  for (const b of open.rows) {
    const rows = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE batch_id = $1 ORDER BY failed_at NULLS LAST, incident_id`, [b.batch_id]);
    if (rows.rows.some((r) => OPEN_STATES.includes(r.status))) continue;
    const at = nowIso();
    const runs = rows.rows.map(asRun);
    const claimed = await query(`UPDATE engine_recovery_batches SET summary_sent_at = $2, settled_at = $2, runs = $3::jsonb WHERE batch_id = $1 AND summary_sent_at IS NULL`, [
      b.batch_id,
      at,
      JSON.stringify(runs),
    ]);
    if (!claimed.rowCount) continue;
    if (!runs.length) {
      await query(`UPDATE engine_recovery_batches SET summary_detail = $2 WHERE batch_id = $1`, [b.batch_id, 'Nothing in the batch was re-run — every incident went back to waiting — so no summary was sent.']);
      continue;
    }
    let http: number | null = null;
    let detail: string;
    try {
      const r = await postN8n(SUMMARY_PATH, { dependency: b.dependency, recovered_at: at, runs }, 30_000);
      http = r.status;
      detail = r.status >= 200 && r.status < 300 ? `Sent: ${runs.length} run(s).` : `The summary workflow answered ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : '.'}`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    await query(`UPDATE engine_recovery_batches SET summary_http = $2, summary_detail = $3 WHERE batch_id = $1`, [b.batch_id, http, detail]);
    await mirror.logWrite({ endpoint: `${n8n.n8nHost()}${SUMMARY_PATH}`, kind: 'recovery', method: 'POST', key_label: 'DASHBOARD_INBOUND_KEY', natural_id: b.batch_id, outcome: http && http < 300 ? 'updated' : 'error', detail: `${b.dependency}: ${detail}` });
    console.log(`recovery: batch ${b.batch_id} (${b.dependency}) settled — ${detail}`);
    events.changed('recovery');
  }
}

/* ------------------------------------------------------------ the tick */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function batchId(dep: string): string {
  return `rec-${dep}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function startBatch(dep: RecoveryDependency, startedBy: string, p: RecoveryProbe | null, ids: string[]): Promise<string> {
  const id = batchId(dep);
  await query(`INSERT INTO engine_recovery_batches (batch_id, dependency, started_by, probe, started_at) VALUES ($1,$2,$3,$4::jsonb,$5)`, [
    id,
    dep,
    startedBy,
    p ? JSON.stringify(p.dependencies[dep]) : null,
    nowIso(),
  ]);
  await query(`UPDATE engine_recovery SET batch_id = $1, updated_at = $2 WHERE incident_id = ANY($3::text[])`, [id, nowIso(), ids]);
  return id;
}

export interface TickResult {
  ran: boolean;
  at: string;
  note: string;
}

async function tick(): Promise<TickResult> {
  const at = nowIso();
  const e = await enabled();
  if (!e.on) return { ran: false, at, note: e.by === 'env' ? `${ENABLED_VAR}=false` : 'switched off on Engine health' };

  await settle();
  await finishBatches();
  const read = await refresh();

  const waiting = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE status = 'waiting' AND batch_id IS NULL ORDER BY failed_at NULLS LAST, first_seen_at`);
  await setMeta(TICK_KEY, at);
  if (!waiting.rows.length) return { ran: true, at, note: 'nothing waiting — no probe' };

  const p = await probe(read);
  const notes: string[] = [];
  for (const dep of DEPENDENCIES) {
    const rows = waiting.rows.filter((r) => r.dependency === dep);
    if (!rows.length) continue;
    if (p.dependencies[dep]?.ok !== true) {
      notes.push(`${rows.length} waiting on ${dep}, still ${p.dependencies[dep]?.status ?? 'unknown'}`);
      continue;
    }
    const id = await startBatch(dep, 'watcher', p, rows.map((r) => r.incident_id));
    console.log(`recovery: ${DEPENDENCY_LABEL[dep]} is back — batch ${id}, ${rows.length} incident(s), ${gapMs / 1000}s apart`);
    for (let i = 0; i < rows.length; i++) {
      if (i) await sleep(gapMs);
      // Re-read the switch between runs: turning recovery off mid-batch stops
      // the batch, and what is left goes back to waiting.
      if (!(await enabled()).on) {
        await query(`UPDATE engine_recovery SET batch_id = NULL, updated_at = $2 WHERE batch_id = $1 AND status = 'waiting'`, [id, nowIso()]);
        notes.push('switched off mid-batch');
        break;
      }
      try {
        await processOne({ ...rows[i], batch_id: id });
      } catch (err) {
        await setRow(rows[i].incident_id, { status: 'waiting', batch_id: null, note: `The re-run could not be started: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    notes.push(`${dep}: batch ${id} of ${rows.length}`);
  }
  await finishBatches();
  return { ran: true, at, note: notes.join('; ') };
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<TickResult> | null = null;

/** One tick at a time, whoever asks: a batch draining for ten minutes must not be joined by a second. */
export function runTick(): Promise<TickResult> {
  if (!running) {
    running = tick()
      .catch((e) => {
        console.error('recovery tick failed', e);
        return { ran: false, at: nowIso(), note: e instanceof Error ? e.message : String(e) };
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}

export function startWatching(): void {
  if (timer) return;
  timer = setInterval(() => void runTick(), TICK_MS);
  timer.unref?.();
  // A first look shortly after boot, so a deploy mid-outage does not wait five minutes.
  const first = setTimeout(() => void runTick(), 60_000);
  first.unref?.();
}

export function stopWatching(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/* --------------------------------------------------------- Re-run now */

/**
 * Re-run now: step 4 for one waiting incident, **ignoring the probe** — a
 * person has decided the dependency is back. It is its own batch of one and
 * sends its own summary once it settles, so a manual recovery is recorded in
 * the same channel as an automatic one.
 */
export async function rerun(incidentId: string, actor: string): Promise<RecoveryRerunResult> {
  const e = await enabled();
  if (!e.on) {
    return { ok: false, incident_id: incidentId, status: null, message: e.by === 'env' ? `Recovery is off on this server (${ENABLED_VAR}=false), so nothing is re-run from here.` : 'Recovery is switched off. Turn it on above to re-run from here.' };
  }
  const r = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE incident_id = $1`, [incidentId]);
  const row = r.rows[0];
  if (!row) return { ok: false, incident_id: incidentId, status: null, message: 'The recovery watcher is not holding this incident.' };
  if (row.status !== 'waiting') return { ok: false, incident_id: incidentId, status: row.status, message: `This incident is ${row.status.replace(/_/g, ' ')}, not waiting — there is nothing to re-run.` };
  if (row.batch_id) return { ok: false, incident_id: incidentId, status: row.status, message: 'A recovery batch has already picked this incident up.' };
  if (running) return { ok: false, incident_id: incidentId, status: row.status, message: 'A recovery tick is running right now. Try again once it finishes.' };

  const id = await startBatch(row.dependency, `manual:${actor}`, await lastProbe(), [incidentId]);
  console.log(`recovery: Re-run now on ${incidentId} by ${actor} — batch ${id}`);
  let status: RecoveryStatus;
  try {
    status = await processOne({ ...row, batch_id: id });
  } catch (err) {
    await setRow(incidentId, { status: 'waiting', batch_id: null, note: `The re-run could not be started: ${err instanceof Error ? err.message : String(err)}` });
    status = 'waiting';
  }
  await finishBatches();
  const after = (await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE incident_id = $1`, [incidentId])).rows[0];
  const note = after?.note ?? '';
  return {
    ok: status !== 'waiting' && status !== 'failed_again',
    incident_id: incidentId,
    status,
    message:
      status === 'replaying'
        ? 'Handed to the healer with recovery: true. Whether it worked is decided by the re-run, and lands here from retry_attempts.'
        : `${status.replace(/_/g, ' ')}${note ? ` — ${note}` : ''}`,
  };
}

/* ------------------------------------------------------ the plan and the page */

/**
 * What the next tick would do, **without calling anything**: read from what is
 * held — the rows, the last probe, the switch — and nothing else. It is how a
 * test, or a client, sees the watcher's intent before it acts.
 */
export async function plan(): Promise<RecoveryPlan> {
  const e = await enabled();
  const held = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE status IN ('waiting', 'replaying') ORDER BY failed_at NULLS LAST, first_seen_at`);
  const waiting = held.rows.filter((r) => r.status === 'waiting').map(asRow);
  const replaying = held.rows.filter((r) => r.status === 'replaying').map(asRow);
  const probeNow = await lastProbe();

  const known = new Set((await query<{ incident_id: string }>(`SELECT incident_id FROM engine_recovery`)).rows.map((r) => r.incident_id));
  const open = await query<{ id: string | null }>(`SELECT natural_id AS id FROM engine_incidents WHERE open_now IS NOT FALSE`);
  const skippedIds = new Set(lastSkipped.map((x) => x.incident_id));
  const unclassified = open.rows.map((r) => r.id).filter((id): id is string => Boolean(id) && !known.has(id!) && !skippedIds.has(id!) && !classified.has(id!));

  const next: string[] = [];
  if (!e.on) {
    next.push(e.by === 'env' ? `Nothing: ${ENABLED_VAR}=false overrides the page switch.` : `Nothing: recovery is switched off${e.toggle.by ? ` (by ${e.toggle.by})` : ''}.`);
  } else {
    if (replaying.length) next.push(`Settle ${replaying.length} re-run(s) from retry_attempts; give up on any past ${GIVE_UP_MS / 60_000} minutes with "no result from the healer".`);
    next.push(`Re-read the live incidents${unclassified.length ? `, and classify ${unclassified.length} not yet looked at (reading each failed execution from n8n where the class needs it)` : ''}.`);
    const free = waiting.filter((r) => !r.batch_id);
    if (!free.length) next.push('Nothing is waiting, so no probe is sent.');
    else {
      next.push('Probe OpenRouter, Slack and Google once through n8n, and BHARAG through the ledger read.');
      for (const dep of DEPENDENCIES) {
        const n = free.filter((r) => r.dependency === dep).length;
        if (!n) continue;
        const last = probeNow?.dependencies[dep];
        next.push(
          `${DEPENDENCY_LABEL[dep]}: ${n} waiting. If it answers ok, ${n > 1 ? `re-run them oldest first, ${GAP_MS / 1000} seconds apart (about ${Math.max(1, Math.ceil(((n - 1) * GAP_MS) / 60_000))} min).` : 're-run it.'} Last probe: ${last?.ok === true ? 'ok' : last?.ok === false ? `not ok (${last.status ?? 'no status'})` : 'not asked yet'}.`,
        );
      }
    }
  }
  return {
    at: nowIso(),
    enabled: e.on,
    disabled_by: e.by,
    switch_on: e.toggle.on,
    toggled_by: e.toggle.by,
    toggled_at: e.toggle.at,
    waiting,
    replaying,
    skipped: lastSkipped,
    unclassified,
    last_probe: probeNow,
    next_tick: next,
    last_tick_at: await getMeta(TICK_KEY),
    interval_seconds: TICK_MS / 1000,
  };
}

export async function lastBatch(): Promise<RecoveryBatch | null> {
  const b = await query<{
    batch_id: string;
    dependency: RecoveryDependency;
    started_by: string;
    started_at: string;
    settled_at: string | null;
    summary_sent_at: string | null;
    summary_http: number | null;
    summary_detail: string | null;
    runs: RecoveryRun[] | null;
  }>(`SELECT batch_id, dependency, started_by, started_at, settled_at, summary_sent_at, summary_http, summary_detail, runs FROM engine_recovery_batches ORDER BY started_at DESC LIMIT 1`);
  const row = b.rows[0];
  if (!row) return null;
  const rows = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery WHERE batch_id = $1 ORDER BY failed_at NULLS LAST, incident_id`, [row.batch_id]);
  return {
    batch_id: row.batch_id,
    dependency: row.dependency,
    started_by: row.started_by,
    started_at: row.started_at,
    settled_at: row.settled_at,
    summary_sent_at: row.summary_sent_at,
    summary_http: row.summary_http,
    summary_detail: row.summary_detail,
    // The settled batch's own runs where it has them, which is exactly what
    // Slack was sent; the live rows while it is still draining.
    runs: row.runs ?? rows.rows.map(asRun),
    pending: rows.rows.filter((r) => OPEN_STATES.includes(r.status)).length,
  };
}

export async function data(): Promise<RecoveryData> {
  const p = await plan();
  const all = await query<HeldRow>(`SELECT ${COLS} FROM engine_recovery ORDER BY updated_at DESC LIMIT 200`);
  return {
    ...p,
    rows: all.rows.map(asRow),
    last_batch: await lastBatch(),
    heal_configured: bharag.healConfigured(),
    n8n_configured: n8n.n8nConfigured(),
  };
}

/** The boot line. */
export function describe(): string {
  if (envDisabled()) return `  recovery: OFF (${ENABLED_VAR}=false) — nothing waiting on a dependency is re-run, whatever the page switch says.`;
  const missing = [!inboundKey() ? 'DASHBOARD_INBOUND_KEY' : null, !n8n.n8nConfigured() ? n8n.N8N_API_VAR : null].filter(Boolean);
  return `  recovery: watching every ${TICK_MS / 60_000} min while an incident waits on a dependency (page switch decides; ${ENABLED_VAR}=false overrides)${missing.length ? ` — ${missing.join(' and ')} not set, so ${missing.length > 1 ? 'those parts' : 'that part'} cannot run` : ''}`;
}
