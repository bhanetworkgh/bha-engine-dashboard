/**
 * Resync: rebuilds the read model from Airtable. One full read per table,
 * upsert by record id, then remove whatever that table no longer contains.
 * Idempotent — running it twice leaves the same rows — and it is how the
 * dashboard picks up anything written to Airtable outside it, so it runs on
 * boot whenever a key is present, again on demand (POST /api/resync/:kind),
 * and on a timer.
 *
 * A table that fails to read keeps the rows it had: one transaction per
 * table, and the purge only happens after a successful full read of that
 * table, so a bad network minute never empties a page and never leaves a page
 * half-rebuilt.
 */
import * as airtable from './airtable';
import { withTransaction } from './pg';
import { CLIENTS_INDEX, CODEX_BASE, CODEX_LAYER0, CODEX_TABLES, COMMERCIAL, LOOP_TABLES, LOOPS_BASE, NORTH_STAR, PATTERNS, RESEARCH_QUEUE, mapLayer0 } from './sources';
import * as store from './store';
import type { RecordKind } from '../../src/data/types';

export interface TableResult {
  table: string;
  label: string;
  n: number;
  inserted: number;
  changed: number;
  removed: number;
  error: string | null;
  ms: number;
}
export interface ResyncResult {
  kind: RecordKind;
  ok: boolean;
  started_at: string;
  finished_at: string;
  tables: TableResult[];
}

const running = new Map<RecordKind, Promise<ResyncResult>>();

async function syncTable(kind: RecordKind, base: string, table: string, label: string): Promise<TableResult> {
  const t0 = Date.now();
  try {
    // Read the whole table before touching the store. A partial read must not
    // reach the purge, which is what makes the rebuild safe.
    const records = await airtable.listAll(base, table);
    const keep = new Set<string>();
    let inserted = 0;
    let changed = 0;
    // One transaction for the table: every row and the purge land together, or
    // none of them do, and the page never renders a half-rebuilt table.
    const removed = await withTransaction(async (db) => {
      for (const rec of records) {
        const m = await store.mapRecord(kind, rec, table);
        const r = await store.upsert(m, table, 'airtable', undefined, db);
        keep.add(rec.id);
        if (r.inserted) inserted++;
        if (r.changed) changed++;
      }
      return store.purgeMissing(kind, table, keep, db);
    });
    return { table, label, n: records.length, inserted, changed, removed, error: null, ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { table, label, n: 0, inserted: 0, changed: 0, removed: 0, error: msg, ms: Date.now() - t0 };
  }
}

/**
 * Which tables a kind lives in.
 *
 * All static except `client_questions`, whose tables are named by the index
 * rows themselves — see `clientQuestionTables`. That is deliberate: the
 * pipeline dropped its hardcoded lane-to-table map on 2026-09-10 so that
 * adding a lane is a row rather than a deploy, and this follows the same rule.
 */
async function tablesFor(kind: RecordKind): Promise<{ base: string; table: string; label: string }[]> {
  switch (kind) {
    case 'loops':
      return LOOP_TABLES.map((t) => ({ base: LOOPS_BASE, table: t.table, label: t.label }));
    case 'codex':
      // One table per builder, exactly as for loops. Which table a submission
      // lives in is its builder identity, so there is nothing to attribute.
      return CODEX_TABLES.map((t) => ({ base: CODEX_BASE, table: t.table, label: t.label }));
    case 'patterns':
      return [PATTERNS];
    case 'commercial':
      return [COMMERCIAL];
    case 'ns':
      return [NORTH_STAR];
    case 'rt':
      return [RESEARCH_QUEUE];
    case 'clients':
      return [CLIENTS_INDEX];
    case 'client_questions':
      return clientQuestionTables();
  }
}

/**
 * The per-lane question tables, as the index currently names them.
 *
 * Read from the lanes already held: a `clients` resync runs first and records
 * the mapping, so this never guesses which table belongs to which lane. A lane
 * whose index row leaves Table ID empty is skipped and reported on the page,
 * rather than silently dropping its questions.
 */
async function clientQuestionTables(): Promise<{ base: string; table: string; label: string }[]> {
  const map: Record<string, string> = {};
  const out: { base: string; table: string; label: string }[] = [];
  for (const lane of await store.clientLanes()) {
    if (!lane.questions_table) continue;
    map[lane.questions_table] = lane.lane_id ?? lane.id;
    out.push({ base: CLIENTS_INDEX.base, table: lane.questions_table, label: lane.name });
  }
  await store.setQuestionTables(map);
  return out;
}

/** One resync of one kind. Concurrent calls for the same kind share the run. */
export function resync(kind: RecordKind): Promise<ResyncResult> {
  const inflight = running.get(kind);
  if (inflight) return inflight;
  const p = (async () => {
    const started_at = new Date().toISOString();
    const tables: TableResult[] = [];
    for (const t of await tablesFor(kind)) {
      tables.push(await syncTable(kind, t.base, t.table, t.label));
    }
    if (kind === 'codex') {
      // The Layer 0 holding table is not a record kind — it has no status and
      // no write path — so it is read alongside and held whole. A failure here
      // never fails the resync: the entries themselves are what the page needs.
      try {
        await store.setLayer0Holds((await airtable.listAll(CODEX_LAYER0.base, CODEX_LAYER0.table)).map(mapLayer0));
      } catch (e) {
        console.log(`resync codex/${CODEX_LAYER0.label}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const failed = tables.filter((t) => t.error);
    const ok = failed.length === 0;
    if (kind === 'clients' && ok) {
      // Following the index is the point of this kind; a lane read that does
      // not then read its questions leaves the page half-built.
      tables.push(...(await resync('client_questions')).tables);
    }
    const prev = await store.syncState(kind);
    await store.setSyncState(kind, {
      synced_at: ok ? new Date().toISOString() : prev.synced_at,
      error: ok ? null : failed.map((t) => `${t.label}: ${t.error}`).join(' · '),
      tables: tables.map((t) => ({ table: t.table, label: t.label, n: t.error ? (prev.tables.find((p) => p.table === t.table)?.n ?? 0) : t.n })),
    });
    if (ok) await recordObservations(kind);
    for (const t of tables) {
      console.log(
        t.error
          ? `resync ${kind}/${t.label}: FAILED after ${t.ms}ms — ${t.error}`
          : `resync ${kind}/${t.label}: ${t.n} rows (${t.inserted} new, ${t.changed} changed status, ${t.removed} removed) in ${t.ms}ms`,
      );
    }
    return { kind, ok, started_at, finished_at: new Date().toISOString(), tables };
  })().finally(() => running.delete(kind));
  running.set(kind, p);
  return p;
}

/** The two figures a trend needs history for, observed at each successful resync. */
async function recordObservations(kind: RecordKind): Promise<void> {
  if (kind === 'patterns') {
    const m = await store.patternMetrics();
    if (m.scope.rows) await store.observe('patterns', 'canonical_share', (m.canonical / m.scope.rows) * 100);
  }
  if (kind === 'commercial') {
    const m = await store.commercialMetrics();
    if (m.unresolved_questions.value !== null) await store.observe('commercial', 'unresolved_questions', m.unresolved_questions.value);
    for (const o of await store.opportunities()) if (o.missing_research_count !== null) await store.observe('commercial', `unresolved:${o.id}`, o.missing_research_count);
  }
}

/**
 * Every kind, in order.
 *
 * `client_questions` is skipped here: a `clients` resync reads the index and
 * then follows each row's Table ID itself, so running it again in this loop
 * would read the same four tables a second time every cycle for nothing.
 */
export async function resyncAll(): Promise<ResyncResult[]> {
  const out: ResyncResult[] = [];
  for (const k of store.KINDS) {
    if (k === 'client_questions') continue;
    out.push(await resync(k));
  }
  return out;
}

export function isRunning(kind: RecordKind): boolean {
  return running.has(kind);
}

/**
 * Minutes between timed resyncs; 0 disables.
 *
 * Fifteen, not the 1440 the service was running. A figure on an engine-health
 * surface that can be a day old, with nothing on screen saying so, is worse
 * than no figure: it reads as current and is not. Every page now prints how
 * old its rows are, and this is how old they can get. The rows survive a
 * restart since 2026-09-12 (they are in Postgres), which changes nothing
 * here: a row written four hours ago is stale whether or not it was written
 * by this process.
 *
 * The cost of fifteen minutes, counted against Airtable's limits:
 *
 *   loops        7 tables, ~773 rows      12 requests (100 rows a page)
 *   codex        6 tables + Layer 0        7
 *   patterns     1 table, 149 rows         2
 *   commercial   1 table, 21 rows          1
 *   ns           1 table, 34 rows          1
 *   rt           1 table, 213 rows         3
 *   clients      index + 4 lane tables     5
 *                                         --
 *                                         31 requests per full resync
 *
 * Airtable's hard limit is five requests a second per base. These 31 are
 * spread over seven bases and paced at PACE_MS (220 ms) inside this process, so
 * a full resync takes about seven seconds and never approaches it — the
 * per-second limit is not the binding constraint at any interval we would
 * choose.
 *
 * What is worth watching is the monthly call count, which some Airtable plans
 * cap per workspace: 31 requests every fifteen minutes is roughly 3,000 a day
 * and 89,000 a month from this dashboard alone, before n8n's own traffic on
 * the same workspace. If that ceiling is a problem, this one variable is the
 * lever — 20 minutes is ~67,000 a month, 30 minutes ~45,000 — and nothing
 * else has to change.
 */
export const RESYNC_MINUTES = Math.max(0, Number(process.env.AIRTABLE_RESYNC_MINUTES ?? 15) || 0);

/** Called at boot. Never throws; a failure is logged and shown on the page. */
export async function startBootSync(): Promise<void> {
  if (!airtable.airtableConfigured()) {
    console.log('  airtable:  NOT configured — set AIRTABLE_API_KEY. Loops, Codex, patterns and commercial pages will be empty.');
    for (const k of store.KINDS) {
      const s = await store.syncState(k);
      if (!s.synced_at) await store.setSyncState(k, { ...s, error: 'AIRTABLE_API_KEY is not set on the server, so nothing has been read from Airtable.' });
    }
    return;
  }
  console.log(`  airtable:  ${airtable.AIRTABLE_URL} — resync on boot${RESYNC_MINUTES ? `, then every ${RESYNC_MINUTES} min` : ''}`);
  void resyncAll().catch((e) => console.error('resync on boot failed', e));
  if (RESYNC_MINUTES) {
    const t = setInterval(() => void resyncAll().catch((e) => console.error('timed resync failed', e)), RESYNC_MINUTES * 60_000);
    t.unref();
  }
}
