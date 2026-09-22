/**
 * Engine Health: is the engine working right now, and if not, what broke, did
 * it fix itself, and does anyone need to do something?
 *
 * Three sources, none of them new — all three were already being written and
 * none had ever been read:
 *
 *   the incident ledger   BHARAG, one call per lane with that lane's own key
 *   error_counts          Airtable, one row per recurring fault signature
 *   retry_attempts        Airtable, one row per incident the healer has touched
 *
 * They are mirrored into Postgres like everything else and the page reads the
 * mirror, so a page load costs nothing external and a refused read never blanks
 * a screen. This module owns their queries directly rather than going through
 * `store.ts`'s record machinery, the way `executions.ts` owns its own: these
 * are not record kinds, they have no monthly rollup and no status ledger.
 *
 * **The distinction this page exists to keep is "nothing is wrong" against
 * "nothing was read".** They look identical from the outside and only one of
 * them is good news. Every read records which lane answered, which refused and
 * which has no credential at all, and every figure carries that with it.
 */
import { nowIso } from './db';
import { query, withTransaction } from './pg';
import * as airtable from './airtable';
import * as bharag from './bharag';
import * as mirror from './mirror';
import {
  ERROR_CLASSES,
  ERROR_COUNTS,
  HEALTH_LANES,
  RETRY_ATTEMPTS,
  RETRY_CAP,
  SEVERITIES,
  RETRY_STATUSES,
  RETRY_TRIGGERS,
  classIsKnown,
  classIsRetryable,
  classMeaning,
  mapErrorCount,
  mapIncident,
  mapRetryAttempt,
  type AtRecord,
} from './sources';
import { executionUrl, n8nHost } from './n8n';
import type {
  ErrorCount,
  Freshness,
  HealthData,
  HealthMetrics,
  HealthWeek,
  Incident,
  IncidentClose,
  IncidentCloseResult,
  LaneRead,
  Percentiles,
  Resync,
  ResyncTable,
  RetryAttempt,
  RetryMetrics,
  RetryResult,
  Share,
  Slice,
  WorkflowFaults,
} from '../../src/data/types';

/* ------------------------------------------------------------------ dates */

function weekStart(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastWeeks(n: number): string[] {
  const out: string[] = [];
  let w = weekStart(nowIso().slice(0, 10));
  for (let i = 0; i < n; i++) {
    out.unshift(w);
    w = addDays(w, -7);
  }
  return out;
}
function weekLabel(start: string): string {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(a);
  b.setUTCDate(a.getUTCDate() + 6);
  const mon = (d: Date) => d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${mon(a)}` : `${a.getUTCDate()} ${mon(a)}–${b.getUTCDate()} ${mon(b)}`;
}
function weekOf(at: string | null): string | null {
  return at ? weekStart(at.slice(0, 10)) : null;
}

/* ------------------------------------------------------------- the shapes */

/** A rate with the denominator it is over. Never a bare percentage. */
function share(n: number, of: number, note: (n: number, of: number) => string): Share {
  return { n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null, note: note(n, of) };
}

/** A distribution in the vocabulary's own order, with anything unexpected appended. */
function slices<T>(items: T[], of: (x: T) => string | null, vocab: readonly string[], blank: string): Slice[] {
  const counts = new Map<string, number>();
  for (const x of items) {
    const key = of(x) ?? blank;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known = vocab.filter((v) => counts.has(v)).map((v) => ({ key: v, label: v, n: counts.get(v)! }));
  const rest = [...counts.entries()]
    .filter(([k]) => !vocab.includes(k))
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, label: key, n }));
  return [...known, ...rest];
}

/** p50 and p95 by nearest rank. Never a mean — a mean hides the slow tail. */
function percentiles(values: number[], of: number, note: (n: number, of: number) => string): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(at(50)), p95: round(at(95)), n: s.length, of, note: note(s.length, of) };
}

/* -------------------------------------------------------------- the reads */

interface HeldRow {
  pk: string;
  airtable_record_id: string | null;
  natural_id: string | null;
  created_time: string | null;
  fields: Record<string, unknown> | null;
  first_seen_at: string;
  updated_at: string;
  open_now?: boolean;
  last_seen_open?: string | null;
}

function asRecord(r: HeldRow): AtRecord {
  return { id: r.airtable_record_id ?? r.natural_id ?? `row-${r.pk}`, createdTime: r.created_time ?? '', fields: r.fields ?? {} };
}

/**
 * Every incident held, open or not.
 *
 * `execution_url` is resolved against the executions this database already
 * holds, so the link is exact where we hold that run and **null where we do
 * not** — a link built from a guessed workflow id would 404, and a page that
 * offers a broken link is worse than one that says it has nothing to offer.
 */
export async function incidents(): Promise<Incident[]> {
  const r = await query<HeldRow>(
    `SELECT id::text AS pk, airtable_record_id, natural_id, created_time, fields, first_seen_at, updated_at, open_now, last_seen_open
       FROM engine_incidents`,
  );
  const mapped = r.rows.map((row) =>
    mapIncident(asRecord(row), { open_now: row.open_now ?? true, last_seen_open: row.last_seen_open ?? null, first_seen_at: row.first_seen_at }),
  );

  // Only numeric ids: `engine_execution_runs.execution_id` is a bigint, so a
  // non-numeric id from the ledger would make the query itself fail rather than
  // simply not match.
  const ids = [...new Set(mapped.map((i) => i.execution_id).filter((v): v is string => typeof v === 'string' && /^\d+$/.test(v)))];
  if (ids.length) {
    const runs = await query<{ execution_id: string; workflow_id: string }>(
      `SELECT execution_id::text AS execution_id, workflow_id FROM engine_execution_runs WHERE execution_id = ANY($1::bigint[])`,
      [ids],
    );
    const byId = new Map(runs.rows.map((x) => [x.execution_id, x.workflow_id]));
    for (const i of mapped) {
      const wf = i.execution_id ? byId.get(i.execution_id) : undefined;
      if (wf && i.execution_id) i.execution_url = executionUrl(wf, i.execution_id);
    }
  }
  // The newest close this dashboard attempted, per incident: who, when, and
  // whether the ledger took it. Read from the one append-only write log.
  const closes = await query<{ record_id: string; state: string; at: string; actor: string | null; reason: string | null; http: number | null }>(
    `SELECT DISTINCT ON (record_id) record_id, state, at, actor, reason, http FROM record_writes WHERE kind = 'incidents' ORDER BY record_id, seq DESC`,
  );
  const closeOf = new Map(closes.rows.map((c) => [c.record_id, c]));
  for (const i of mapped) {
    const c = closeOf.get(i.entity_id);
    if (c) i.close_attempt = { state: c.state === 'ok' ? 'ok' : 'failed', at: c.at, actor: c.actor, reason: c.reason, http: c.http } satisfies IncidentClose;
  }
  // Newest first, and an open incident above a closed one: the open ones are
  // the only rows anybody opens this page to act on.
  return mapped.sort((a, b) => Number(b.open_now) - Number(a.open_now) || (b.first_seen_at ?? '').localeCompare(a.first_seen_at ?? ''));
}

export async function errorCounts(): Promise<ErrorCount[]> {
  const r = await query<HeldRow>(
    `SELECT id::text AS pk, airtable_record_id, natural_id, created_time, fields, first_seen_at, updated_at FROM engine_error_counts`,
  );
  // Ordered by when the fault last fired, which is the question this card
  // answers: what is breaking now, not what has broken most since the counter
  // was last reset.
  return r.rows.map((row) => mapErrorCount(asRecord(row))).sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''));
}

export async function retries(): Promise<RetryAttempt[]> {
  const r = await query<HeldRow>(
    `SELECT id::text AS pk, airtable_record_id, natural_id, created_time, fields, first_seen_at, updated_at FROM engine_retry_attempts`,
  );
  return r.rows.map((row) => mapRetryAttempt(asRecord(row))).sort((a, b) => (b.last_attempt_at ?? '').localeCompare(a.last_attempt_at ?? ''));
}

/** How many rows a table holds and when one last changed, in the shape every page prints. */
async function freshnessOf(table: string, kind: string, label: string): Promise<Freshness> {
  const r = await query<{ n: string; changed_at: string | null; from_engine: string }>(
    `SELECT count(*)::text AS n, max(updated_at) AS changed_at, count(*) FILTER (WHERE source <> 'airtable')::text AS from_engine FROM ${table}`,
  );
  const row = r.rows[0];
  const n = Number(row?.n ?? 0);
  return {
    kind: kind as Freshness['kind'],
    source: n ? 'engine' : 'none',
    changed_at: row?.changed_at ?? null,
    rows: n,
    from_engine: Number(row?.from_engine ?? 0),
    tables: n ? [{ table, label, n }] : [],
    note: n ? null : `Nothing of this kind is held yet. ${label} reaches this dashboard through the Resync from Airtable button above, and through POST /api/engine/${kind}.`,
  };
}

/**
 * Which lanes this server can read, and how the last read of each went.
 *
 * Held in `meta` rather than recomputed, because the only honest answer to "was
 * this lane read" is "the last time somebody asked it, here is what happened" —
 * and that is a fact about a past resync, not about this request.
 */
async function laneReads(open: Incident[]): Promise<LaneRead[]> {
  const r = await query<{ k: string; v: string }>(`SELECT key AS k, value AS v FROM meta WHERE key LIKE 'health.lane.%'`);
  const held = new Map(r.rows.map((x) => [x.k, x.v]));
  return HEALTH_LANES.map((l) => {
    const raw = held.get(`health.lane.${l.key}`);
    let read = false;
    let reason: string | null = null;
    let at: string | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { read?: boolean; reason?: string | null; at?: string | null };
        read = Boolean(parsed.read);
        reason = parsed.reason ?? null;
        at = parsed.at ?? null;
      } catch {
        // A meta row this code cannot parse is a lane that has not been read,
        // which is the safe direction: it never reads as healthy.
      }
    }
    return {
      lane: l.key,
      label: l.label,
      configured: bharag.laneConfigured(l.key),
      read,
      reason: reason ?? (bharag.laneConfigured(l.key) ? (raw ? null : 'never read — press Resync') : `${bharag.LANE_KEY_VARS[l.key]} is not set on this server`),
      at,
      open: open.filter((i) => i.lane === l.key && i.open_now).length,
    };
  });
}

export async function data(): Promise<HealthData> {
  const all = await incidents();
  return {
    incidents: all,
    error_counts: await errorCounts(),
    retries: await retries(),
    lanes: await laneReads(all),
    freshness: await freshnessOf('engine_incidents', 'incidents', 'The incident ledger'),
    retries_freshness: await freshnessOf('engine_retry_attempts', 'retry_attempts', 'retry_attempts'),
    heal_configured: bharag.healConfigured(),
  };
}

/* ------------------------------------------------------------- the resync */

const SWEEP_READ_TIMEOUT_MS = 20_000;

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Reads all five sources and makes this database match them.
 *
 * Two different rules, because the two kinds of source answer different
 * questions:
 *
 *   **The Airtable tables are read whole**, so the sweep is the usual one —
 *   insert what is there and we do not have, update what changed, delete what
 *   is gone. Airtable wins every disagreement.
 *
 *   **The ledger is read with `status=open`**, so an incident that has been
 *   closed simply stops appearing. Deleting those would throw away exactly the
 *   history the time-to-resolve figure is computed from, so **nothing here
 *   deletes an incident**. A row a *successful* read no longer returns is
 *   marked closed-since and keeps everything else it had. A lane that refused
 *   is never treated as a lane with no incidents: nothing under it is touched
 *   and the result names it.
 */
export async function resync(actor = 'dashboard'): Promise<Resync> {
  const started = Date.now();
  const at = nowIso();
  const tables: ResyncTable[] = [];
  let closed = 0;

  /* ---- the ledger, one lane at a time, each with its own credential ---- */
  for (const lane of HEALTH_LANES) {
    if (!bharag.laneConfigured(lane.key)) {
      const reason = `${bharag.LANE_KEY_VARS[lane.key]} is not set on this server`;
      await setLaneRead(lane.key, false, reason, at);
      tables.push({ table: lane.key, label: `${lane.label} incidents`, read: false, reason, rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }
    let rows: bharag.LedgerIncident[];
    try {
      rows = await bharag.openIncidents(lane.key);
    } catch (e) {
      const reason = why(e);
      console.error(`health resync: ${lane.label} incidents could not be read — ${reason}`);
      await setLaneRead(lane.key, false, reason, at);
      tables.push({ table: lane.key, label: `${lane.label} incidents`, read: false, reason, rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let refused = 0;
    const seen: string[] = [];
    for (const inc of rows) {
      const entity = typeof inc.entity_id === 'string' ? inc.entity_id : null;
      if (!entity) {
        refused++;
        console.error(`health resync: ${lane.label} returned an incident with no entity_id; it cannot be identified and was not stored`);
        continue;
      }
      try {
        // The ledger's own object, stored whole and unrenamed — the same rule
        // the Airtable mirrors follow, for the same reason.
        const result = await mirror.upsert('incidents', { fields: inc as Record<string, unknown>, lane_id: lane.key }, 'engine');
        seen.push(entity);
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else unchanged++;
      } catch (e) {
        refused++;
        console.error(`health resync: ${lane.label} incident ${entity} refused — ${why(e)}`);
      }
    }

    // Still open, and stamped now: this is when we last saw it in the answer.
    if (seen.length) {
      await query(`UPDATE engine_incidents SET open_now = true, last_seen_open = $1 WHERE natural_id = ANY($2::text[])`, [at, seen]);
    }
    /**
     * Held as open, but this lane's successful read did not return it. That is
     * the ledger saying it is no longer open — not this code guessing from age
     * — so it is marked and never deleted. Its `resolution_status` and
     * `resolved_at` are left exactly as the ledger last gave them.
     */
    const gone = await query<{ n: string }>(
      `UPDATE engine_incidents SET open_now = false
        WHERE lane_id = $1 AND open_now = true AND NOT (natural_id = ANY($2::text[]))
        RETURNING 1 AS n`,
      [lane.key, seen],
    );
    closed += gone.rows.length;

    await setLaneRead(lane.key, true, null, at);
    tables.push({
      table: lane.key,
      label: `${lane.label} incidents`,
      read: true,
      reason: null,
      rows: rows.length,
      inserted,
      updated,
      unchanged,
      // Counted as deletions in the totals would be a lie: nothing was deleted.
      deleted: 0,
      refused,
    });
  }

  /* ---------------------- the two Airtable tables ---------------------- */
  /**
   * Once Airtable is retired (2026-09-22) these two are the engine's to write
   * through /api/engine/error_counts and /api/engine/retry_attempts, and this
   * pass reads only the ledger. They are left out of the tables rather than
   * listed as unread: nothing failed, and a failure line about a system that
   * is deliberately no longer read is the warning section 4 says not to give.
   */
  const airtableRetired = airtable.retired();
  for (const src of airtableRetired ? [] : [
    { ...ERROR_COUNTS, kind: 'error_counts' as const },
    { ...RETRY_ATTEMPTS, kind: 'retry_attempts' as const },
  ]) {
    if (!airtable.airtableConfigured()) {
      tables.push({ table: src.table, label: src.label, read: false, reason: 'AIRTABLE_TOKEN is not set on this server', rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }
    let records: AtRecord[];
    try {
      records = await airtable.listRecords(src.base, src.table, SWEEP_READ_TIMEOUT_MS);
    } catch (e) {
      const reason = why(e);
      console.error(`health resync: ${src.label} could not be read — ${reason}`);
      tables.push({ table: src.table, label: src.label, read: false, reason, rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let refused = 0;
    for (const rec of records) {
      try {
        const result = await mirror.upsert(src.kind, { record_id: rec.id, created_time: rec.createdTime ?? null, fields: rec.fields ?? {} }, 'airtable');
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else unchanged++;
      } catch (e) {
        refused++;
        console.error(`health resync: ${src.label} ${rec.id} refused — ${why(e)}`);
      }
    }

    // Only inside a table that was actually read. Not read is never empty.
    const table = mirror.KINDS[src.kind].table;
    const held = await query<{ id: string; airtable_record_id: string }>(`SELECT id, airtable_record_id FROM ${table} WHERE airtable_record_id IS NOT NULL`);
    const live = new Set(records.map((r) => r.id));
    const goneRows = held.rows.filter((row) => !live.has(row.airtable_record_id));
    if (goneRows.length) {
      await withTransaction(async (client) => {
        for (const row of goneRows) await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.id]);
      });
    }

    tables.push({ table: src.table, label: src.label, read: true, reason: null, rows: records.length, inserted, updated, unchanged, deleted: goneRows.length, refused });
  }

  const sum = (k: 'inserted' | 'updated' | 'unchanged' | 'deleted' | 'refused') => tables.reduce((n, t) => n + t[k], 0);
  const blocked = tables.filter((t) => !t.read);
  const ran = tables.some((t) => t.read);
  const note = [
    ran ? '' : 'Nothing was read, so nothing was changed.',
    airtableRetired ? 'Incidents were read from BHARAG; error_counts and retry_attempts were not read, because Airtable is retired and the engine writes those directly.' : '',
    ran ? `${sum('inserted')} inserted, ${sum('updated')} updated, ${sum('deleted')} deleted, ${sum('unchanged')} already matching.` : '',
    closed ? `${closed} incident${closed === 1 ? '' : 's'} the ledger no longer returns as open ${closed === 1 ? 'was' : 'were'} marked closed rather than deleted — a closed incident is the history the time-to-resolve figure is computed from.` : '',
    sum('refused') ? `${sum('refused')} row${sum('refused') === 1 ? ' was' : 's were'} read and refused by this database; the server log names each one and why.` : '',
    blocked.length
      ? `${blocked.length} source${blocked.length === 1 ? '' : 's'} could not be read (${blocked.map((b) => b.label).join(', ')}), so nothing under ${blocked.length === 1 ? 'it' : 'them'} was touched — and a lane that was not read is not a lane with no incidents. ${[...new Set(blocked.map((b) => b.reason ?? 'no reason given'))].join(' · ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  console.log(`health resync by ${actor}: ${note} | ` + tables.map((t) => `${t.label} ${t.read ? `${t.rows} rows +${t.inserted}/~${t.updated}/-${t.deleted}` : `UNREAD (${t.reason})`}`).join(' · '));

  return { ran, at, ms: Date.now() - started, tables, inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), deleted: sum('deleted'), refused: sum('refused'), overwritten: [], note };
}

async function setLaneRead(lane: string, read: boolean, reason: string | null, at: string): Promise<void> {
  await query(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
    `health.lane.${lane}`,
    JSON.stringify({ read, reason, at }),
  ]);
}

/* -------------------------------------------------------------- the close */

/** The ledger's terminal states, from BHARAG's `core/incidents/lifecycle.ts`. */
const TERMINAL = new Set(['self_healed', 'manually_resolved', 'wont_fix']);

/**
 * Close incidents a person fixed by hand (2026-09-22, Destiny).
 *
 * **The ledger first, then this database, one incident at a time.** Each is
 * sent to BHARAG with its own lane's key; only an accepted transition marks
 * the row here closed, and the row takes the ledger's own answer as its new
 * blob, so what is held is what BHARAG says rather than what this code hoped.
 * A refusal changes nothing here but the write log, which the page reads to
 * put the reason on the row. Sequential on purpose: a partial failure then
 * names exactly which ones landed, and it is three lanes of somebody else's
 * API rather than a place to go fast.
 *
 * Every attempt, landed or refused, is one line in `record_writes` with
 * `kind = 'incidents'` and the dashboard login as the actor.
 */
export async function closeIncidents(ids: string[], actor: string): Promise<IncidentCloseResult> {
  const at = nowIso();
  const held = await query<{ natural_id: string; lane_id: string | null; open_now: boolean | null; status: string | null }>(
    `SELECT natural_id, lane_id, open_now, fields->>'resolution_status' AS status FROM engine_incidents WHERE natural_id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(held.rows.map((r) => [r.natural_id, r]));
  const results: IncidentCloseResult['results'] = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      results.push({ id, outcome: 'skipped', reason: 'Not held on this dashboard, so there is no lane to close it with.', http: null });
      continue;
    }
    if (row.open_now === false || (row.status && TERMINAL.has(row.status))) {
      results.push({ id, outcome: 'skipped', reason: `Already closed${row.status ? ` (${row.status})` : ''}.`, http: null });
      continue;
    }
    const lane = row.lane_id ?? '';
    try {
      const after = await bharag.closeIncident(lane, id, actor, at);
      const status = typeof after?.resolution_status === 'string' ? after.resolution_status : 'manually_resolved';
      // The ledger's own copy where it sent one back; otherwise the two keys
      // this transition set, merged into what was held.
      const whole = after && typeof after === 'object' && after.entity_id === id;
      await query(
        whole
          ? `UPDATE engine_incidents SET fields = $2::jsonb, open_now = false, updated_at = $3 WHERE natural_id = $1`
          : `UPDATE engine_incidents SET fields = fields || $2::jsonb, open_now = false, updated_at = $3 WHERE natural_id = $1`,
        [id, JSON.stringify(whole ? after : { resolution_status: status }), at],
      );
      await logClose(id, 'ok', status, null, 200, actor, lane);
      results.push({ id, outcome: 'closed', reason: null, http: 200 });
    } catch (e) {
      const http = e instanceof bharag.BharagError ? e.status || null : null;
      const reason = why(e);
      await logClose(id, 'failed', row.status ?? 'open', reason, http, actor, lane);
      results.push({ id, outcome: 'failed', reason, http });
    }
  }

  const n = (o: string) => results.filter((r) => r.outcome === o).length;
  const note = [
    `${n('closed')} of ${ids.length} closed in the BHARAG ledger as manually resolved, from this dashboard by ${actor} — the ledger itself records the lane as the resolver.`,
    n('failed') ? `${n('failed')} refused by the ledger and still open there and here — each row says why.` : '',
    n('skipped') ? `${n('skipped')} skipped (already closed, or not held).` : '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`incident close by ${actor}: ${note}`);
  return { at, actor, requested: ids.length, closed: n('closed'), failed: n('failed'), skipped: n('skipped'), results, note };
}

async function logClose(id: string, state: 'ok' | 'failed', status: string, reason: string | null, http: number | null, actor: string, lane: string): Promise<void> {
  await query(
    `INSERT INTO record_writes (kind, record_id, natural_id, state, status, reason, http, action, detail, actor, at)
     VALUES ('incidents', $1, $1, $2, $3, $4, $5, 'close', $6, $7, $8)`,
    [id, state, status, reason, http, `POST ${bharag.BHARAG_URL}/incidents/${id}/status → manually_resolved (lane ${lane || 'none'})`, actor, nowIso()],
  );
}

/* -------------------------------------------------------------- the retry */

/**
 * One manual retry, through the same path an automatic one takes.
 *
 * The cap is checked here as well as on the button, because a disabled button
 * is a courtesy and the circuit breaker is not: three attempts and a person
 * should look at why before it is asked again.
 */
export async function retryNow(incidentId: string, actor: string): Promise<RetryResult> {
  const held = (await retries()).find((r) => r.incident_id === incidentId);
  if (!held) {
    return { ok: false, incident_id: incidentId, message: `No retry row is held for ${incidentId}. The healer writes one when it first touches an incident; if this is new, the next resync will bring it.` };
  }
  if ((held.attempts ?? 0) >= RETRY_CAP) {
    return { ok: false, incident_id: incidentId, message: held.blocked_reason ?? `This incident has used all ${RETRY_CAP} attempts.` };
  }
  if (!held.execution_id) {
    return { ok: false, incident_id: incidentId, message: 'This row carries no execution id, and the healer refuses without one — there is nothing for it to resume from.' };
  }

  try {
    const res = await bharag.heal({
      incident_id: held.incident_id,
      execution_id: held.execution_id,
      lane: held.lane ?? '',
      workflow: held.workflow ?? '',
      failed_node: held.failed_node ?? '',
      error_class: held.error_class,
      attempts_before: held.attempts ?? 0,
    });
    await mirror.logWrite({
      endpoint: bharag.HEAL_URL,
      kind: 'retry_attempts',
      method: 'POST',
      key_label: null,
      natural_id: incidentId,
      outcome: res.status >= 200 && res.status < 300 ? 'updated' : 'error',
      detail: `manual retry by ${actor} → HTTP ${res.status}`,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, incident_id: incidentId, message: `The healer answered ${res.status}. ${res.body || 'It said nothing else.'}` };
    }
    return {
      ok: true,
      incident_id: incidentId,
      /**
       * Deliberately not "retried successfully". The healer has started the
       * same retry the schedule would have started; whether it *worked* is
       * decided by the retried execution and written to `retry_attempts`, and
       * reaches this page on the next resync.
       */
      message: `Retry ${(held.attempts ?? 0) + 1} of ${RETRY_CAP} was handed to the healer. Whether it worked is decided by the retried run, not by this call — resync to see what it recorded.`,
    };
  } catch (e) {
    return { ok: false, incident_id: incidentId, message: why(e) };
  }
}

/* ------------------------------------------------------------- the figures */

const NO_LANE = '(no lane)';
const NO_SUBSYSTEM = '(no subsystem)';

/**
 * Every figure on the page, for one lane or for all three.
 *
 * Read the rules in CLAUDE.md section 7 alongside this: a percentage always
 * carries its denominator, no duration is ever a mean, every figure says what
 * it excludes, nought is a number and an unread lane is a sentence.
 */
export async function metrics(lane: string | null): Promise<HealthMetrics> {
  const everything = await incidents();
  const allRetries = await retries();
  const faults = await errorCounts();
  const lanes = await laneReads(everything);

  const mine = lane ? everything.filter((i) => i.lane === lane) : everything;
  const open = mine.filter((i) => i.open_now);
  const myRetries = lane ? allRetries.filter((r) => r.lane === lane) : allRetries;
  const weeks = lastWeeks(8);

  const recovered = myRetries.filter((r) => r.status === 'Recovered');
  const exhausted = myRetries.filter((r) => r.status === 'Exhausted');
  const retrying = stillRetrying(myRetries);
  const decided = recovered.length + exhausted.length;
  const stillExhausted = exhaustedStillOpen(myRetries, mine);

  const nonRetryableOpen = open.filter((i) => !i.retryable);
  const resolved = mine.filter((i) => i.hours_to_resolve !== null);
  const newest = mine.filter((i) => i.first_seen_at).sort((a, b) => b.first_seen_at!.localeCompare(a.first_seen_at!))[0] ?? null;
  const sinceNewest = newest?.first_seen_at ? Math.floor((Date.now() - Date.parse(newest.first_seen_at)) / 3_600_000) : null;

  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const recent = myRetries.filter((r) => (r.last_attempt_at ?? '') >= since24h);

  /** Which lanes were actually read, for every note that would otherwise overclaim. */
  const relevant = lane ? lanes.filter((l) => l.lane === lane) : lanes;
  const unread = relevant.filter((l) => !l.read);
  const caveat = unread.length
    ? ` ${unread.length === relevant.length ? (unread.length === 1 ? 'This lane was not read' : 'No lane was read') : `${unread.map((l) => l.label).join(' and ')} could not be read`}, so this figure is over what is held rather than over what exists.`
    : '';

  const classesPresent = [...new Set(mine.map((i) => i.error_class))];
  const classVocab = [...ERROR_CLASSES.map((c) => c.key), ...classesPresent.filter((c) => !classIsKnown(c)).sort()];

  const reclassified = mine.filter((i) => i.reclassified_from);
  const pairs = new Map<string, number>();
  for (const i of reclassified) pairs.set(`${i.reclassified_from}→${i.error_class}`, (pairs.get(`${i.reclassified_from}→${i.error_class}`) ?? 0) + 1);

  /** Per-lane only: open incidents by workflow, then by the node that failed. */
  const workflows: WorkflowFaults[] = lane
    ? [...new Set(open.map((i) => i.workflow ?? '(no workflow named)'))]
        .map((wf) => {
          const ours = open.filter((i) => (i.workflow ?? '(no workflow named)') === wf);
          return {
            workflow: wf,
            open: ours.length,
            nodes: [...new Set(ours.map((i) => i.failed_node ?? '(no node named)'))]
              .map((node) => ({ node, open: ours.filter((i) => (i.failed_node ?? '(no node named)') === node).length, incidents: ours.filter((i) => (i.failed_node ?? '(no node named)') === node) }))
              .sort((a, b) => b.open - a.open),
          };
        })
        .sort((a, b) => b.open - a.open)
    : [];

  const laneFaults = lane
    ? faults.filter((f) => open.some((i) => i.workflow === f.workflow) || mine.some((i) => i.workflow === f.workflow))
    : faults;

  return {
    kind: 'health',
    computed_at: nowIso(),
    lane,
    scope: { incidents: mine.length, open: open.length, retries: myRetries.length },
    lanes,
    open_incidents: {
      n: open.length,
      by_lane: slices(open, (i) => i.lane_label, HEALTH_LANES.map((l) => l.label), NO_LANE),
      note:
        (open.length
          ? `Incidents the ledger's open query still returns${lane ? '' : ', across every lane read'}. Closed ones are kept and counted under time to resolve rather than deleted.`
          : relevant.some((l) => l.read)
            ? `Nothing is open in ${lane ? 'this lane' : 'any lane that was read'}. This is a nought, not an absence: the read succeeded and returned no open incident.`
            : `No lane was read, so this is not nought open incidents — it is no answer at all.`) + caveat,
    },
    healed: share(recovered.length, decided, (_n, of) =>
      of
        ? `Retries that fixed the problem, over retries that reached a verdict. Incidents still retrying are excluded, because they have not finished — ${retrying.length} ${retrying.length === 1 ? 'is' : 'are'} still undecided.${caveat}`
        : myRetries.length
          ? `All ${myRetries.length} retr${myRetries.length === 1 ? 'y is' : 'ies are'} still in flight, so none has reached a verdict and there is no rate — not a rate of nought.`
          : `The healer has not touched an incident${lane ? ' in this lane' : ''} yet, so there is nothing to compute a rate over.`,
    ),
    needing_person: {
      /**
       * A union, not a sum. An incident can be both exhausted and in a
       * non-retryable class, and the note says it is counted once — so it has
       * to actually be counted once, or the note is the lie.
       */
      n: new Set([...stillExhausted.map((r) => r.incident_id), ...nonRetryableOpen.map((i) => i.entity_id)]).size,
      exhausted: stillExhausted.length,
      non_retryable: nonRetryableOpen.length,
      note: `${stillExhausted.length} retr${stillExhausted.length === 1 ? 'y has' : 'ies have'} used all ${RETRY_CAP} attempts on an incident not known to be closed${exhausted.length > stillExhausted.length ? ` (${exhausted.length - stillExhausted.length} more exhausted on incidents the ledger has since closed are left out — they are on the Retries tab)` : ''}, and ${nonRetryableOpen.length} open incident${nonRetryableOpen.length === 1 ? ' is' : 's are'} in a class a retry cannot fix — billing, auth, schema. Nothing in the engine will move either group on its own. An incident can be in both and is counted once here.${caveat}`,
    },
    most_recent: {
      at: newest?.first_seen_at ?? null,
      entity_id: newest?.entity_id ?? null,
      summary: newest?.summary ?? null,
      /**
       * The silence framing starts at three days, not at one.
       *
       * A day without an incident is an ordinary good day, and saying "silence
       * here is itself the signal" about it is the page crying wolf — which is
       * how a reader learns to ignore the sentence by the time it means
       * something. Three days quiet in a lane that normally reports is worth
       * looking at.
       */
      note:
        newest && sinceNewest !== null
          ? sinceNewest < 24
            ? `The most recent incident${lane ? ' in this lane' : ''} arrived ${sinceNewest} hour${sinceNewest === 1 ? '' : 's'} ago.`
            : sinceNewest < 72
              ? `The most recent incident${lane ? ' in this lane' : ''} arrived ${Math.floor(sinceNewest / 24)} day${Math.floor(sinceNewest / 24) === 1 ? '' : 's'} ago.`
              : `Nothing has been recorded${lane ? ' in this lane' : ''} for ${Math.floor(sinceNewest / 24)} days. Silence here is itself the signal — it is either genuine health or a handler that has stopped reporting, and this page cannot tell which. The lane read above says whether anybody asked.`
          : `No incident is held${lane ? ' for this lane' : ''}, so there is nothing to date. That is either a quiet engine or one nothing is reporting from; the lane read above is what distinguishes them.`,
    },
    retries_24h: {
      n: recent.length,
      recovered: recent.filter((r) => r.status === 'Recovered').length,
      retrying: stillRetrying(allRetries).filter((r) => recent.includes(r)).length,
      exhausted: recent.filter((r) => r.status === 'Exhausted').length,
      note: `Retry rows whose last attempt was inside the last 24 hours, by the status they are in now. A row is one incident, not one attempt — the healer updates the row rather than adding one per pass.`,
    },
    per_week_lane: weeks.map((w) => {
      const ours = mine.filter((i) => weekOf(i.first_seen_at) === w);
      return {
        week: w,
        label: weekLabel(w),
        total: ours.length,
        counts: Object.fromEntries(HEALTH_LANES.map((l) => [l.label, ours.filter((i) => i.lane === l.key).length]).concat([[NO_LANE, ours.filter((i) => !i.lane).length]])),
      } as HealthWeek;
    }),
    per_week_class: weeks.map((w) => {
      const ours = mine.filter((i) => weekOf(i.first_seen_at) === w);
      return {
        week: w,
        label: weekLabel(w),
        total: ours.length,
        counts: Object.fromEntries(classVocab.map((c) => [c, ours.filter((i) => i.error_class === c).length])),
      } as HealthWeek;
    }),
    week_note: `Incidents by the week the ledger says they occurred (its occurred_at), Monday to Sunday UTC, over the eight weeks ${weekLabel(weeks[0])} to ${weekLabel(weeks[weeks.length - 1])}. Counted over incidents this dashboard has seen open at least once: the ledger is read with status=open, so one opened and closed between two reads never arrives here.${caveat}`,
    by_lane: HEALTH_LANES.map((l) => {
      const ours = everything.filter((i) => i.lane === l.key && i.open_now);
      return {
        key: l.key,
        label: l.label,
        open: ours.length,
        retryable: ours.filter((i) => i.retryable).length,
        note: lanes.find((x) => x.lane === l.key)?.read ? '' : (lanes.find((x) => x.lane === l.key)?.reason ?? 'not read'),
      };
    }),
    by_lane_note: `Open incidents per lane, with how many of them a retry can act on. The lane with the most incidents is not necessarily the unhealthiest: a lane full of retryable timeouts is in better shape than a lane with one auth failure nobody has touched. A lane that could not be read shows why instead of a count.`,
    by_class: slices(mine, (i) => i.error_class, classVocab, 'UNKNOWN').map((s) => ({
      key: s.key,
      label: s.label,
      n: s.n,
      retryable: classIsRetryable(s.key),
      known: classIsKnown(s.key),
      what: classMeaning(s.key),
    })),
    class_note: `Every incident held${lane ? ' in this lane' : ''} by its class, retryable ones first. The vocabulary is shared by all three handlers as of 17 Sep 2026; error_counts spells it in lower case and the ledger in upper, and both are normalised to one spelling here. A class this dashboard has not heard of keeps its own name rather than being folded into UNKNOWN — UNKNOWN means the handler looked and could not decide, which is a different fact.`,
    by_severity: slices(mine, (i) => i.severity, SEVERITIES, 'info'),
    severity_note: `The severity the ledger itself recorded, where it recorded one; where it did not, the one the error class implies — billing and auth are critical, schema is high, network, model-output and upstream-5xx are warnings. Each incident says which of the two answered for it.`,
    by_subsystem: slices(mine, (i) => i.subsystem, [], NO_SUBSYSTEM),
    subsystem_note: `The subsystem on the incident. The split differs by lane by design: Bays divides into CODEX, CHANNELARCHIVES, COMMERCIALOPPS, BUILDPATTERNS and AGENT, North Star is all AGENT and Research Twin all RESEARCHJOB, so on All systems this is three different granularities in one chart and is most useful inside a lane.`,
    top_faults: laneFaults.slice(0, 10),
    faults_note: `Recurring faults from error_counts, newest first. error_count is a countdown inside a six-hour window that resets once an alert fires, not a lifetime total — a nought there means recently alerted, not never seen. The table is shared by all three lanes and has no lane column, so inside a lane this shows the signatures whose workflow this lane's incidents name.`,
    time_to_resolve: percentiles(resolved.map((i) => i.hours_to_resolve!), mine.length, (n, of) =>
      n
        ? `Hours from first seen to resolved_at, over the ${n} of ${of} incident${of === 1 ? '' : 's'} that carry a resolution time. p50 and p95, never a mean. Open incidents are excluded — they have not finished, and counting them would make a bad week look fast.`
        : of
          ? `None of the ${of} incident${of === 1 ? '' : 's'} held carries a resolved_at, so there is nothing to time. An incident with no resolution time is open; nothing here guesses one from its age.`
          : `No incident is held${lane ? ' for this lane' : ''}.`,
    ),
    reclassified: {
      n: reclassified.length,
      of: mine.length,
      pairs: [...pairs.entries()].map(([k, n]) => ({ from: k.split('→')[0], to: k.split('→')[1], n })).sort((a, b) => b.n - a.n),
      note: reclassified.length
        ? `Incidents where the handler overrode its own first classification, with what it changed from and to. This is how you see whether the classes added on 17 Sep — MODEL_OUTPUT_INVALID and UPSTREAM_5XX — are catching real cases or sitting idle.`
        : `No incident held${lane ? ' in this lane' : ''} carries a reclassified_from, so no handler has overridden its own first answer. This is the card that would show MODEL_OUTPUT_INVALID and UPSTREAM_5XX catching cases that used to be classed as something else; nought means they have not yet.`,
    },
    workflows,
    advice: open.filter((i) => i.self_healing_strategy),
    advice_note: `The self_healing_strategy on every open incident, in full. It is written as plain English for a person to act on, and truncating it to a line would throw away the most useful text on this page. An incident with none is not listed here.`,
  };
}

/**
 * A Retrying row that a later verdict for the same incident has overtaken
 * (2026-09-22). The 5-minute schedule wrote one row per incident and the
 * healer that replaced it on 21 Sep writes its own, so an incident can hold a
 * Retrying row from 17 Sep beside an Exhausted one from 21 Sep. The first is
 * history, not a retry in flight, and counting it as "still retrying" put two
 * finished incidents in the undecided figure.
 */
function stillRetrying(rows: RetryAttempt[]): RetryAttempt[] {
  return rows.filter(
    (r) =>
      r.status === 'Retrying' &&
      !rows.some(
        (o) => o !== r && o.incident_id === r.incident_id && (o.status === 'Recovered' || o.status === 'Exhausted') && (o.last_attempt_at ?? '') >= (r.last_attempt_at ?? ''),
      ),
  );
}

/**
 * Exhausted retries that still want a person (2026-09-22). An exhausted retry
 * whose incident this database holds and the ledger no longer returns as open
 * has been dealt with — 37 were closed by hand on 22 Sep — so it is left out
 * of "needing a person" and of Home's signal. It stays on the Retries tab,
 * which is the retry record. An incident this database does not hold at all
 * is kept in: nothing here says it was closed, and unknown is not closed.
 */
export function exhaustedStillOpen(retryRows: RetryAttempt[], incidents: { entity_id: string; open_now: boolean }[]): RetryAttempt[] {
  const closed = new Set(incidents.filter((i) => !i.open_now).map((i) => i.entity_id));
  return retryRows.filter((r) => r.status === 'Exhausted' && !closed.has(r.incident_id));
}

/** The retry loop's own record. Everything here is `retry_attempts` and nothing else. */
export async function retryMetrics(): Promise<RetryMetrics> {
  const rows = await retries();
  const recovered = rows.filter((r) => r.status === 'Recovered');
  const exhausted = rows.filter((r) => r.status === 'Exhausted');
  const retrying = stillRetrying(rows);
  const overtaken = rows.filter((r) => r.status === 'Retrying').length - retrying.length;
  const decided = recovered.length + exhausted.length;
  const attemptKey = (n: number | null) => (n === null ? '(not recorded)' : String(n));

  return {
    kind: 'retries',
    computed_at: nowIso(),
    scope: { rows: rows.length },
    recovery_rate: share(recovered.length, decided, (_n, of) =>
      of
        ? `Retries that fixed the problem, over the ${of} that reached a verdict. The ${retrying.length} still retrying ${retrying.length === 1 ? 'is' : 'are'} excluded: a retry that ran is not a retry that worked, and until the retried run finishes the outcome is genuinely undecided.`
        : rows.length
          ? `All ${rows.length} retr${rows.length === 1 ? 'y is' : 'ies are'} still in flight, so none has reached a verdict — there is no rate, not a rate of nought.`
          : 'The healer has not touched an incident yet.',
    ),
    retrying: retrying.length,
    exhausted: exhausted.length,
    retrying_note: `Incidents the healer is still working, with attempts left. Undecided rather than optimistic — the status comes from the retried execution's own outcome, and until that finishes this is neither a success nor a failure.${overtaken ? ` ${overtaken} older Retrying row${overtaken === 1 ? ' is' : 's are'} left out: a later Recovered or Exhausted row for the same incident has already decided it.` : ''}`,
    exhausted_note: exhausted.length
      ? `Three attempts without success. Each of these has already been escalated to Slack and the circuit is broken deliberately. Not always a failure of the system: a pruned execution — one n8n no longer holds the data for — lands here immediately and correctly, and last_result on the row says which happened.`
      : `Nothing has used all ${RETRY_CAP} attempts. When something does it is escalated to Slack and the circuit is broken deliberately; a pruned execution lands here immediately and correctly, which is why last_result is shown in full on every row.`,
    attempts_mix: slices(rows, (r) => attemptKey(r.attempts), ['1', '2', '3', '(not recorded)'], '(not recorded)'),
    attempts_note: `How many passes each incident has had, against the cap of ${RETRY_CAP}. Worth reading for where the recoveries land: mostly on the first attempt means the backoff — 1 minute, then 4, then 15, each randomised by a fifth — could be shorter; mostly on the third means these failures clear more slowly than it assumes.`,
    triggered_by: slices(rows, (r) => r.triggered_by, RETRY_TRIGGERS, '(not recorded)'),
    triggered_note: `Whether the schedule or a person started each retry. They are the same mechanism — the button posts to the webhook the 5-minute schedule posts to, and the healer records both identically — so this says who noticed first, not what happened. If Dashboard dominates, the automatic loop is missing cases it should be catching.`,
    // Lower-cased for the page, the same way the lane tabs draw a class, so the
    // same value does not read two ways on two tabs.
    by_class: slices(rows, (r) => r.error_class, ERROR_CLASSES.filter((c) => c.retryable).map((c) => c.key), 'UNKNOWN').map((s) => ({
      ...s,
      label: s.label.toLowerCase().replace(/_/g, ' '),
    })),
    class_note: `Only the retryable classes reach this table at all, so a class here that is not one of the three retryable ones is worth a look — it means something upstream queued a retry for a fault a retry cannot fix.`,
  };
}

/** Where an execution link points when this database does not hold the run. */
export function executionsHost(): string {
  return n8nHost();
}

/** The three lanes' keys, for the route to check a query parameter against. */
export const LANE_KEYS = HEALTH_LANES.map((l) => l.key);

export { RETRY_STATUSES };
