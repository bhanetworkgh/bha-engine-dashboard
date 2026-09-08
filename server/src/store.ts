/**
 * The record store: loops, Codex entries, build patterns and commercial cards,
 * each with a status the interface can change, plus the history that makes
 * the counts on the records pages real.
 *
 * Decision (2026-09-08): the engine hands over raw rows and this server
 * aggregates them. Nothing upstream keeps a status-change history, so the
 * server keeps its own — an events table written on every change, a daily
 * snapshot per kind, and the date history began — and computes "this week
 * versus last", "open versus closed" and "median days raised to closed" from
 * those. Where a kind carries no date for a metric the metric is null with a
 * note saying what is missing; the interface prints the note rather than a
 * number.
 *
 * Phase 1 seeds the store from the fixtures on first boot. Seeding is
 * idempotent: rows already present keep whatever status they have reached.
 */
import * as f from '../../src/data/fixtures';
import type { BuildPattern, CodexEntry, Lane, Loop, LoopStatus, Metric, NewLoop, Opportunity, RecordKind, RecordMetrics } from '../../src/data/types';
import { getMeta, nowIso, openDb, setMeta, today } from './db';

export type { RecordKind, RecordMetrics, Metric };
export const KINDS: RecordKind[] = ['loops', 'codex', 'patterns', 'commercial'];

/** Status vocabularies. The last entry of each is the terminal ("closed") state. */
export const STATUSES: Record<RecordKind, readonly string[]> = {
  loops: ['open', 'in progress', 'closed'],
  codex: ['posted', 'ingested', 'archived'],
  patterns: ['active', 'retired'],
  commercial: ['idea', 'researching', 'evidence thin', 'ready to pitch', 'blocked', 'closed'],
};

/** What "closed" means for each kind, in the word the interface uses. */
export const TERMINAL: Record<RecordKind, { status: string; label: string }> = {
  loops: { status: 'closed', label: 'closed' },
  codex: { status: 'ingested', label: 'ingested' },
  patterns: { status: 'retired', label: 'retired' },
  commercial: { status: 'closed', label: 'closed' },
};

interface Row {
  kind: RecordKind;
  id: string;
  json: string;
  status: string;
  builder: string | null;
  raised_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

/* ------------------------------------------------------------------ dates */

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** Monday of the week containing `day` (YYYY-MM-DD), as YYYY-MM-DD. */
function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------- seed */

const SEED_VERSION = '1';

function seedRow(kind: RecordKind, id: string, obj: unknown, status: string, builder: string | null, raised: string | null, closed: string | null): void {
  openDb()
    .prepare(
      `INSERT OR IGNORE INTO records (kind, id, json, status, builder, raised_at, closed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(kind, id, JSON.stringify(obj), status, builder, raised, closed, nowIso());
}

export function seed(): void {
  const db = openDb();
  if (!getMeta('history_since')) setMeta('history_since', nowIso());
  if (getMeta('seed_version') === SEED_VERSION && getMeta('seeded_at')) {
    snapshotAll();
    return;
  }
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    for (const l of f.LOOPS) {
      seedRow('loops', l.id, { ...l, age_days: undefined }, l.status, l.owner, l.raised_at, l.closed_at ?? null);
    }
    for (const e of f.CODEX_ENTRIES) {
      // Ingest time is not recorded anywhere upstream, so an ingested seed has
      // no closed_at. Only rows ingested from this interface get one.
      seedRow('codex', e.id, { ...e, status: e.ingested ? 'ingested' : 'posted' }, e.ingested ? 'ingested' : 'posted', e.builder_id, e.logged_at.slice(0, 10), null);
    }
    for (const p of f.BUILD_PATTERNS) {
      // Patterns carry no creation date: the source records only the last reference.
      seedRow('patterns', p.id, { ...p, status: 'active' }, 'active', p.author, null, null);
    }
    for (const o of f.OPPORTUNITIES) {
      // Cards carry last_touched only; nothing records when one was raised.
      seedRow('commercial', o.id, o, o.readiness, o.owner, null, null);
    }
    if (!getMeta('loops_by_owner')) setMeta('loops_by_owner', JSON.stringify(f.LOOPS_BY_OWNER));
    setMeta('seed_version', SEED_VERSION);
    setMeta('seeded_at', nowIso());
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  snapshotAll();
}

/* ------------------------------------------------------------------ reads */

function rows(kind: RecordKind): Row[] {
  return openDb().prepare('SELECT * FROM records WHERE kind = ?').all(kind) as unknown as Row[];
}

function rowById(kind: RecordKind, id: string): Row | null {
  return (openDb().prepare('SELECT * FROM records WHERE kind = ? AND id = ?').get(kind, id) as unknown as Row | undefined) ?? null;
}

function hydrateLoop(r: Row): Loop {
  const base = JSON.parse(r.json) as Loop;
  const end = r.closed_at ?? today();
  return {
    ...base,
    status: r.status as LoopStatus,
    closed_at: r.closed_at,
    age_days: r.raised_at ? Math.max(0, dayDiff(r.raised_at, end)) : 0,
  };
}

function hydrateCodex(r: Row): CodexEntry {
  const base = JSON.parse(r.json) as CodexEntry;
  return { ...base, status: r.status as CodexEntry['status'], ingested: r.status === 'ingested', closed_at: r.closed_at };
}

function hydratePattern(r: Row): BuildPattern {
  const base = JSON.parse(r.json) as BuildPattern;
  return { ...base, status: r.status as BuildPattern['status'], closed_at: r.closed_at };
}

function hydrateOpportunity(r: Row): Opportunity {
  const base = JSON.parse(r.json) as Opportunity;
  return { ...base, readiness: r.status as Opportunity['readiness'], closed_at: r.closed_at };
}

export function loops(): Loop[] {
  return rows('loops').map(hydrateLoop);
}
export function codexEntries(): CodexEntry[] {
  return rows('codex').map(hydrateCodex);
}
export function patterns(): BuildPattern[] {
  return rows('patterns').map(hydratePattern);
}
export function opportunities(): Opportunity[] {
  return rows('commercial').map(hydrateOpportunity);
}

export type OwnerTotals = { owner: string; open: number; in_progress: number; closed: number; oldest_days: number }[];

export function loopsByOwner(): OwnerTotals {
  const raw = getMeta('loops_by_owner');
  return raw ? (JSON.parse(raw) as OwnerTotals) : [];
}

function saveLoopsByOwner(t: OwnerTotals): void {
  setMeta('loops_by_owner', JSON.stringify(t));
}

/* ----------------------------------------------------------------- writes */

export class StoreError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function hydrateAny(r: Row): Loop | CodexEntry | BuildPattern | Opportunity {
  switch (r.kind) {
    case 'loops':
      return hydrateLoop(r);
    case 'codex':
      return hydrateCodex(r);
    case 'patterns':
      return hydratePattern(r);
    case 'commercial':
      return hydrateOpportunity(r);
  }
}

function ownerKey(s: string): 'open' | 'in_progress' | 'closed' {
  return s === 'open' ? 'open' : s === 'in progress' ? 'in_progress' : 'closed';
}

/** Changes one record's status, records the event, and returns the record as it now stands. */
export function setStatus(kind: RecordKind, id: string, status: string, note?: string): Loop | CodexEntry | BuildPattern | Opportunity {
  if (!STATUSES[kind].includes(status)) {
    throw new StoreError(`"${status}" is not a status a ${kind === 'loops' ? 'loop' : kind === 'codex' ? 'Codex entry' : kind === 'patterns' ? 'pattern' : 'card'} can have.`, 422);
  }
  const r = rowById(kind, id);
  if (!r) throw new StoreError('That record is not held by this dashboard.', 404);
  const db = openDb();
  const at = nowIso();
  const from = r.status;
  const terminal = TERMINAL[kind].status;
  const obj = JSON.parse(r.json) as Record<string, unknown>;
  if (note !== undefined) obj.note = note.trim() || null;
  if (kind === 'commercial') {
    obj.readiness = status;
    obj.health = status === 'blocked' ? 'failing' : status === 'evidence thin' ? 'degraded' : 'ok';
    obj.last_touched = at.slice(0, 10);
    if (status !== 'blocked' && status !== 'evidence thin') obj.blocker = null;
  }
  if (kind === 'codex') obj.ingested = status === 'ingested';
  obj.status = status;

  let closedAt = r.closed_at;
  if (status === terminal && from !== terminal) closedAt = at.slice(0, 10);
  if (status !== terminal && from === terminal) closedAt = null;

  db.prepare('UPDATE records SET json = ?, status = ?, closed_at = ?, updated_at = ? WHERE kind = ? AND id = ?').run(
    JSON.stringify(obj),
    status,
    closedAt,
    at,
    kind,
    id,
  );
  if (from !== status) {
    db.prepare('INSERT INTO events (kind, record_id, from_status, to_status, at) VALUES (?, ?, ?, ?, ?)').run(kind, id, from, status, at);
    if (kind === 'loops' && r.builder) {
      const totals = loopsByOwner();
      const o = totals.find((x) => x.owner === r.builder);
      if (o) {
        o[ownerKey(from)] = Math.max(0, o[ownerKey(from)] - 1);
        o[ownerKey(status)] += 1;
        saveLoopsByOwner(totals);
      }
    }
  }
  snapshot(kind);
  return hydrateAny(rowById(kind, id)!);
}

const SUBSYSTEM_BY_LANE: Record<Lane, Loop['spine']['subsystem']> = {
  VFARM_CORE: 'VFARM',
  VFARM_MEDIA: 'COMMERCIALOPPS',
  CLIENT_CORE: 'RESEARCHTWIN',
  ENGINE_INTERNAL: 'AGENT',
};

export function createLoop(input: NewLoop): Loop {
  const title = (input.title ?? '').trim();
  if (!title) throw new StoreError('A loop needs a title.', 422);
  if (!(input.lane in SUBSYSTEM_BY_LANE)) throw new StoreError('That lane is not one the engine knows.', 422);
  if (!input.owner || !(input.owner in f.BUILDER_NAMES)) throw new StoreError('The owner must be one of the builders.', 422);
  const at = nowIso();
  const day = at.slice(0, 10);
  const id = `LOOP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const loop: Loop = {
    id,
    title,
    owner: input.owner,
    status: 'open',
    age_days: 0,
    raised_at: day,
    closed_at: null,
    note: input.note?.trim() || null,
    lane: input.lane,
    spine: {
      session_id: `SES-${day.replace(/-/g, '')}-${input.owner.slice(0, 2).toUpperCase()}-UI`,
      builder_id: input.owner,
      subsystem: SUBSYSTEM_BY_LANE[input.lane],
      lane: input.lane,
    },
    tags: {},
    source: f.airtable(id, 'tblBJekl3ROpNZxQW'),
  };
  const db = openDb();
  db.prepare('INSERT INTO records (kind, id, json, status, builder, raised_at, closed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'loops',
    id,
    JSON.stringify({ ...loop, age_days: undefined }),
    'open',
    input.owner,
    day,
    null,
    at,
  );
  db.prepare('INSERT INTO events (kind, record_id, from_status, to_status, at) VALUES (?, ?, ?, ?, ?)').run('loops', id, null, 'open', at);
  const totals = loopsByOwner();
  const o = totals.find((x) => x.owner === input.owner);
  if (o) o.open += 1;
  else totals.push({ owner: input.owner, open: 1, in_progress: 0, closed: 0, oldest_days: 0 });
  saveLoopsByOwner(totals);
  snapshot('loops');
  return hydrateLoop(rowById('loops', id)!);
}

/* -------------------------------------------------------------- snapshots */

function snapshot(kind: RecordKind): void {
  const all = rows(kind);
  const terminal = TERMINAL[kind].status;
  const closed = all.filter((r) => r.status === terminal).length;
  const inProgress = kind === 'loops' ? all.filter((r) => r.status === 'in progress').length : 0;
  openDb()
    .prepare(
      `INSERT INTO snapshots (day, kind, open, in_progress, closed, total) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, kind) DO UPDATE SET open = excluded.open, in_progress = excluded.in_progress, closed = excluded.closed, total = excluded.total`,
    )
    .run(today(), kind, all.length - closed - inProgress, inProgress, closed, all.length);
}

export function snapshotAll(): void {
  for (const k of KINDS) snapshot(k);
}

/* ---------------------------------------------------------------- metrics */

const NOUN: Record<RecordKind, string> = { loops: 'loops', codex: 'Codex entries', patterns: 'patterns', commercial: 'cards' };
const NOUN_ONE: Record<RecordKind, string> = { loops: 'loop', codex: 'Codex entry', patterns: 'pattern', commercial: 'card' };

export function metrics(kind: RecordKind, filter: { builder?: string | null; lanes?: Lane[] | null } = {}): RecordMetrics {
  let all = rows(kind);
  if (filter.builder) all = all.filter((r) => r.builder === filter.builder);
  if (filter.lanes) {
    const lanes = new Set<string>(filter.lanes);
    all = all.filter((r) => {
      const o = JSON.parse(r.json) as { lane?: string; spine?: { lane?: string } };
      return lanes.has(o.lane ?? o.spine?.lane ?? '');
    });
  }
  const t = TERMINAL[kind];
  const now = today();
  const thisStart = weekStart(now);
  const lastStart = addDays(thisStart, -7);
  const inWeek = (day: string | null, start: string) => Boolean(day && day >= start && day < addDays(start, 7));
  const historySince = getMeta('history_since');
  const noun = NOUN[kind];

  const hasRaised = all.some((r) => r.raised_at);
  const raised: Metric = hasRaised
    ? { value: all.filter((r) => inWeek(r.raised_at, thisStart)).length, compare: all.filter((r) => inWeek(r.raised_at, lastStart)).length, note: null }
    : {
        value: null,
        compare: null,
        note:
          kind === 'patterns'
            ? 'Patterns carry no creation date. The source records only when each was last referenced.'
            : kind === 'commercial'
              ? 'Cards carry a last-touched date but not a raised date, so weekly volume cannot be counted.'
              : `Nothing records when these ${noun} were raised.`,
      };

  const closedRows = all.filter((r) => r.closed_at);
  const closed: Metric = {
    value: closedRows.filter((r) => inWeek(r.closed_at, thisStart)).length,
    compare: closedRows.filter((r) => inWeek(r.closed_at, lastStart)).length,
    note:
      kind === 'codex'
        ? 'Ingest time is not recorded upstream; only entries ingested from this dashboard carry a date.'
        : kind === 'patterns' || kind === 'commercial'
          ? `Counted from changes made in this dashboard, recorded since ${historySince ? historySince.slice(0, 10) : 'first boot'}. Nothing upstream records when a ${kind === 'patterns' ? 'pattern was retired' : 'card was closed'}.`
          : null,
  };

  let open = all.filter((r) => r.status !== t.status).length;
  let closedCount = all.length - open;
  let ovcNote: string | null = null;
  if (kind === 'loops' && !filter.builder && !filter.lanes) {
    const totals = loopsByOwner();
    open = totals.reduce((n, o) => n + o.open + o.in_progress, 0);
    closedCount = totals.reduce((n, o) => n + o.closed, 0);
    ovcNote = 'Totals from the per-builder tables. The rows below are the loops this dashboard holds.';
  } else if (kind === 'loops' && filter.builder && !filter.lanes) {
    const o = loopsByOwner().find((x) => x.owner === filter.builder);
    if (o) {
      open = o.open + o.in_progress;
      closedCount = o.closed;
      ovcNote = 'Totals from this builder’s table. The rows below are the loops this dashboard holds.';
    }
  }

  const spans = all
    .filter((r) => r.raised_at && r.closed_at)
    .map((r) => dayDiff(r.raised_at!, r.closed_at!))
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  const median: Metric = spans.length
    ? { value: spans.length % 2 ? spans[(spans.length - 1) / 2] : Math.round((spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2), note: `Over ${spans.length} ${spans.length === 1 ? NOUN_ONE[kind] : noun} with both raised and ${t.label} dates recorded.` }
    : {
        value: null,
        note: !hasRaised
          ? `Needs both a raised date and a ${t.label === 'ingested' ? 'date of ingest' : `${t.label} date`}; ${noun} carry neither.`
          : kind === 'codex'
            ? 'Needs an ingest date. None is recorded upstream; the first entry ingested from here will start this.'
            : `No ${noun} have both a raised and a ${t.label} date yet.`,
      };

  return {
    kind,
    terminal_label: t.label,
    history_since: historySince,
    week_start: thisStart,
    raised,
    closed,
    open_vs_closed: { open, closed: closedCount, note: ovcNote },
    median_days_to_close: median,
    by_status: STATUSES[kind].map((s) => ({ status: s, n: all.filter((r) => r.status === s).length })),
  };
}

export function historySince(): string | null {
  return getMeta('history_since');
}
