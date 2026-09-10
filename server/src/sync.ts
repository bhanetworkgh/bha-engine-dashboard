/**
 * Resync: rebuilds the read model from Airtable. One full read per table,
 * upsert by record id, then remove whatever that table no longer contains.
 * Idempotent — running it twice leaves the same rows — and it is the
 * mechanism that rebuilds the dashboard after an ephemeral reset, so it runs
 * on boot whenever a key is present, again on demand (POST /api/resync/:kind),
 * and on a timer.
 *
 * A table that fails to read keeps the rows it had: the purge only happens
 * after a successful full read of that table, so a bad network minute never
 * empties a page.
 */
import * as airtable from './airtable';
import { CODEX_BASE, CODEX_LAYER0, CODEX_TABLES, COMMERCIAL, LOOP_TABLES, LOOPS_BASE, PATTERNS, mapLayer0 } from './sources';
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
    const records = await airtable.listAll(base, table);
    const keep = new Set<string>();
    let inserted = 0;
    let changed = 0;
    for (const rec of records) {
      const m = store.mapRecord(kind, rec, table);
      const r = store.upsert(m, table, 'airtable');
      keep.add(rec.id);
      if (r.inserted) inserted++;
      if (r.changed) changed++;
    }
    const removed = store.purgeMissing(kind, table, keep);
    return { table, label, n: records.length, inserted, changed, removed, error: null, ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { table, label, n: 0, inserted: 0, changed: 0, removed: 0, error: msg, ms: Date.now() - t0 };
  }
}

function tablesFor(kind: RecordKind): { base: string; table: string; label: string }[] {
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
  }
}

/** One resync of one kind. Concurrent calls for the same kind share the run. */
export function resync(kind: RecordKind): Promise<ResyncResult> {
  const inflight = running.get(kind);
  if (inflight) return inflight;
  const p = (async () => {
    const started_at = new Date().toISOString();
    const tables: TableResult[] = [];
    for (const t of tablesFor(kind)) {
      tables.push(await syncTable(kind, t.base, t.table, t.label));
    }
    if (kind === 'codex') {
      // The Layer 0 holding table is not a record kind — it has no status and
      // no write path — so it is read alongside and held whole. A failure here
      // never fails the resync: the entries themselves are what the page needs.
      try {
        store.setLayer0Holds((await airtable.listAll(CODEX_LAYER0.base, CODEX_LAYER0.table)).map(mapLayer0));
      } catch (e) {
        console.log(`resync codex/${CODEX_LAYER0.label}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const failed = tables.filter((t) => t.error);
    const ok = failed.length === 0;
    const prev = store.syncState(kind);
    store.setSyncState(kind, {
      synced_at: ok ? new Date().toISOString() : prev.synced_at,
      error: ok ? null : failed.map((t) => `${t.label}: ${t.error}`).join(' · '),
      tables: tables.map((t) => ({ table: t.table, label: t.label, n: t.error ? (prev.tables.find((p) => p.table === t.table)?.n ?? 0) : t.n })),
    });
    if (ok) recordObservations(kind);
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
function recordObservations(kind: RecordKind): void {
  if (kind === 'patterns') {
    const m = store.patternMetrics();
    if (m.scope.rows) store.observe('patterns', 'canonical_share', (m.canonical / m.scope.rows) * 100);
  }
  if (kind === 'commercial') {
    const m = store.commercialMetrics();
    if (m.unresolved_questions.value !== null) store.observe('commercial', 'unresolved_questions', m.unresolved_questions.value);
    for (const o of store.opportunities()) if (o.missing_research_count !== null) store.observe('commercial', `unresolved:${o.id}`, o.missing_research_count);
  }
}

export async function resyncAll(): Promise<ResyncResult[]> {
  const out: ResyncResult[] = [];
  for (const k of store.KINDS) out.push(await resync(k));
  return out;
}

export function isRunning(kind: RecordKind): boolean {
  return running.has(kind);
}

/** Minutes between timed resyncs; 0 disables. Ten requests per run, well inside Airtable's limits. */
export const RESYNC_MINUTES = Math.max(0, Number(process.env.AIRTABLE_RESYNC_MINUTES ?? 30) || 0);

/** Called at boot. Never throws; a failure is logged and shown on the page. */
export function startBootSync(): void {
  if (!airtable.airtableConfigured()) {
    console.log('  airtable:  NOT configured — set AIRTABLE_API_KEY. Loops, Codex, patterns and commercial pages will be empty.');
    for (const k of store.KINDS) {
      const s = store.syncState(k);
      if (!s.synced_at) store.setSyncState(k, { ...s, error: 'AIRTABLE_API_KEY is not set on the server, so nothing has been read from Airtable.' });
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
