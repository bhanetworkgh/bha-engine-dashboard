/**
 * Home's two 24-hour columns, read from the tables (2026-09-23, Destiny).
 *
 * Until today "What broke in the last 24 hours" and "What moved in the last 24
 * hours" were twenty-two hard-coded rows in engine.ts — "pH above ceiling on
 * rack-a/tier-3", a burn-in bench, a North Star credential rotated — written in
 * phase 1 and never replaced, so the one part of Home that claimed to be about
 * today was the one part that was about nothing. Section 2's first rule forbids
 * exactly that. Every item here is a row, the window is the last 24 hours from
 * the moment of the read, and an empty window is an empty list the page says in
 * words.
 *
 * **What broke** is the engine's own failure record:
 *   - an incident whose own date (`occurred_at`, else `created_at`) falls in the
 *     window — never the time this database inserted it, which is a fact about
 *     the resync;
 *   - an `error_counts` row changed in the window;
 *   - a `retry_attempts` row changed in the window.
 * A retry or an error count about an incident already in the list is folded
 * into that incident rather than listed again: three rows about one fault read
 * as three faults. Each item says "Recovered" or "Needs a person" only where
 * its row says so — a retry `Recovered`, a retry `Exhausted`, or an open
 * incident in a class no retry can fix — and nothing where it does not.
 *
 * **What moved** is work that finished or arrived: a Codex log approved (its
 * `Jason Reviewed At`), a loop closed (the status ledger, `via` engine, ui or
 * inbound — a `mirror` event is a reconcile noticing a change it cannot date,
 * so it is left out, as it is from every close-rate figure), a build pattern
 * created, a pattern candidate flagged, a commercial card created, and a vFarm
 * Early Access lead received.
 *
 * Every item carries `to`, the address that opens it: the record's own page
 * with the record open, or Engine health with the incident open.
 */
import { query } from './pg';
import * as health from './health';
import * as store from './store';
import { getPatternCandidates } from './engine';
import type { FeedItem, Health } from '../../src/data/types';

const WINDOW_MS = 24 * 3_600_000;

function ms(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function inWindow(v: unknown, since: number, until: number): boolean {
  const t = ms(v);
  return t !== null && t >= since && t <= until;
}

function iso(v: unknown): string {
  const t = ms(v);
  return t === null ? String(v) : new Date(t).toISOString();
}

function newestFirst(a: FeedItem, b: FeedItem): number {
  return b.at.localeCompare(a.at);
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------- what broke */

export async function broke(now = Date.now()): Promise<FeedItem[]> {
  const since = now - WINDOW_MS;
  const sinceIso = new Date(since).toISOString();
  const [incidents, errorCounts, retries] = await Promise.all([health.incidents(), health.errorCounts(), health.retries()]);

  // Which error_counts and retry_attempts rows changed in the window, by the
  // same id the mapped rows carry (Airtable record id, else natural id, else row-<pk>).
  const changed = async (table: string) => {
    const r = await query<{ rid: string; updated_at: string }>(
      `SELECT COALESCE(airtable_record_id, natural_id, 'row-' || id) AS rid, updated_at FROM ${table} WHERE updated_at >= $1`,
      [sinceIso],
    );
    return new Map(r.rows.map((x) => [x.rid, x.updated_at]));
  };
  const [countsChanged, retriesChanged] = await Promise.all([changed('engine_error_counts'), changed('engine_retry_attempts')]);

  const retryOf = new Map(retries.map((r) => [r.incident_id, r]));
  const items: FeedItem[] = [];
  const listed = new Set<string>();

  for (const i of incidents) {
    if (!inWindow(i.first_seen_at, since, now)) continue;
    const retry = retryOf.get(i.entity_id);
    const status: FeedItem['status'] =
      retry?.status === 'Recovered' ? 'Recovered' : retry?.status === 'Exhausted' || (i.open_now && !i.retryable) ? 'Needs a person' : null;
    const where = [i.lane_label, i.workflow].filter(Boolean).join(' · ');
    items.push({
      id: `incident:${i.entity_id}`,
      at: iso(i.first_seen_at),
      what: 'Incident',
      title: i.summary ?? i.error_message ?? `${i.error_class} in ${i.workflow ?? 'an unnamed workflow'}`,
      detail: [i.error_class, i.failed_node ? `at ${i.failed_node}` : null, i.open_now ? 'still open' : 'closed since'].filter(Boolean).join(' · '),
      where: where || null,
      status,
      health: (status === 'Recovered' ? 'ok' : i.severity === 'critical' ? 'failing' : 'degraded') as Health,
      to: `/engine-health?incident=${enc(i.entity_id)}`,
    });
    listed.add(i.entity_id);
  }

  for (const r of retries) {
    const at = retriesChanged.get(r.id);
    if (!at || listed.has(r.incident_id)) continue;
    const own = r.last_attempt_at && inWindow(r.last_attempt_at, since, now) ? r.last_attempt_at : at;
    const status: FeedItem['status'] = r.status === 'Recovered' ? 'Recovered' : r.status === 'Exhausted' ? 'Needs a person' : null;
    items.push({
      id: `retry:${r.id}`,
      at: iso(own),
      what: 'Retry',
      title: `${r.status === 'Recovered' ? 'Retried and recovered' : r.status === 'Exhausted' ? 'Retries exhausted' : 'Retrying'}: ${r.workflow ?? r.incident_id}`,
      detail: [r.error_class, r.attempts !== null ? `attempt ${r.attempts} of 3` : null, r.last_result].filter(Boolean).join(' · '),
      where: [r.lane_label, r.failed_node].filter(Boolean).join(' · ') || null,
      status,
      health: (r.status === 'Recovered' ? 'ok' : r.status === 'Exhausted' ? 'failing' : 'degraded') as Health,
      to: r.incident_id && r.incident_id !== '(no incident id)' ? `/engine-health?incident=${enc(r.incident_id)}` : '/engine-health?tab=retries',
    });
    listed.add(r.incident_id);
  }

  for (const c of errorCounts) {
    const at = countsChanged.get(c.id);
    if (!at || (c.incident_id && listed.has(c.incident_id))) continue;
    const own = c.last_seen && inWindow(c.last_seen, since, now) ? c.last_seen : at;
    items.push({
      id: `count:${c.id}`,
      at: iso(own),
      what: 'Recurring fault',
      title: `${c.error_class} in ${c.workflow ?? 'an unnamed workflow'}`,
      detail: [c.failed_node ? `at ${c.failed_node}` : null, c.error_count !== null ? `${c.error_count} in the current six-hour window` : null].filter(Boolean).join(' · ') || c.signature,
      where: c.workflow,
      status: null,
      health: 'degraded',
      to: c.incident_id ? `/engine-health?incident=${enc(c.incident_id)}` : '/engine-health',
    });
  }

  return items.sort(newestFirst);
}

/* ------------------------------------------------------------- what moved */

export async function moved(now = Date.now()): Promise<FeedItem[]> {
  const since = now - WINDOW_MS;
  const sinceIso = new Date(since).toISOString();
  const items: FeedItem[] = [];

  // Codex logs approved: Jason Reviewed At in the window, on a log he approved.
  const codex = await query<{ fields: Record<string, unknown> }>(
    `SELECT fields FROM engine_codex_submissions
      WHERE fields ? 'Jason Reviewed At' AND fields->>'Jason Status' IN ('Approved', 'Input Added')`,
  );
  for (const { fields: f } of codex.rows) {
    const at = f['Jason Reviewed At'];
    if (!inWindow(at, since, now)) continue;
    const key = String(f['Codex Entry ID'] ?? f['Submission ID'] ?? '');
    const title = String(f['Session Description'] ?? f.Summary ?? key).split('\n')[0];
    items.push({
      id: `codex:${key}`,
      at: iso(at),
      what: 'Log approved',
      title,
      detail: [f['Jason Status'] === 'Input Added' ? 'Approved with Jason’s input' : 'Approved by Jason', key].join(' · '),
      where: typeof f['Builder Name'] === 'string' ? f['Builder Name'] : null,
      status: null,
      health: 'ok',
      to: key ? `/codex/${enc(key)}` : '/codex',
    });
  }

  // Loops closed, from the status ledger — the only place a close is dated.
  const closes = await query<{ at: string; builder: string | null; loop_id: string | null; what: string | null; via: string }>(
    `SELECT e.at, e.builder, e.via, l.natural_id AS loop_id, l.fields->>'What' AS what
       FROM events e
       LEFT JOIN engine_loops l ON l.airtable_record_id = e.record_id OR ('row-' || l.id) = e.record_id OR l.natural_id = e.record_id
      WHERE e.kind = 'loops' AND e.to_status = 'closed' AND e.via IN ('engine', 'ui', 'inbound') AND e.at >= $1
      ORDER BY e.at DESC`,
    [sinceIso],
  );
  for (const c of closes.rows) {
    items.push({
      id: `loop:${c.loop_id ?? c.at}`,
      at: iso(c.at),
      what: 'Loop closed',
      title: c.what ?? c.loop_id ?? 'A loop this database no longer holds',
      detail: c.loop_id ?? 'no loop_id',
      where: c.builder,
      status: null,
      health: 'ok',
      to: c.loop_id ? `/open-loops/${enc(c.loop_id)}` : '/open-loops',
    });
  }

  for (const p of await store.patterns()) {
    if (!inWindow(p.created_at, since, now)) continue;
    items.push({
      id: `pattern:${p.id}`,
      at: iso(p.created_at),
      what: 'Pattern registered',
      title: p.title,
      detail: p.pattern_id ?? 'no pattern_id',
      where: p.system ?? null,
      status: null,
      health: 'ok',
      to: `/build-patterns?open=${enc(p.id)}`,
    });
  }

  for (const c of (await getPatternCandidates()).candidates) {
    // A date on its own is the start of that day in UTC, so a candidate
    // flagged today is in the window and one flagged the day before yesterday
    // is not.
    if (!inWindow(c.date_flagged, since, now)) continue;
    items.push({
      id: `candidate:${c.id}`,
      at: iso(c.date_flagged),
      what: 'Candidate flagged',
      title: c.candidate ?? c.id,
      detail: [c.status, c.flagged_by ? `flagged by ${c.flagged_by}` : null].filter(Boolean).join(' · ') || c.id,
      where: c.lane,
      status: null,
      health: 'ok',
      to: `/build-patterns?view=candidates&open=${enc(c.id)}`,
    });
  }

  for (const o of await store.opportunities()) {
    if (!inWindow(o.created_at, since, now)) continue;
    items.push({
      id: `commercial:${o.id}`,
      at: iso(o.created_at),
      what: 'Commercial card',
      title: o.title,
      detail: o.card_id ?? 'no card_id',
      where: o.lane_id,
      status: null,
      health: 'ok',
      to: `/commercial?open=${enc(o.id)}`,
    });
  }

  const leads = await query<{ id: string; full_name: string; organization_name: string | null; source_surface: string; created_at: string }>(
    `SELECT id::text AS id, full_name, organization_name, source_surface, created_at::text AS created_at
       FROM engine_vfarm_leads WHERE created_at >= $1::timestamptz ORDER BY created_at DESC`,
    [sinceIso],
  );
  for (const l of leads.rows) {
    items.push({
      id: `lead:${l.id}`,
      at: iso(l.created_at),
      what: 'Early Access lead',
      title: l.full_name,
      detail: [l.organization_name, l.source_surface === 'form_a' ? 'Form A' : l.source_surface].filter(Boolean).join(' · '),
      where: 'vFarm',
      status: null,
      health: 'ok',
      to: `/vfarm?tab=early-access&lead=${enc(l.id)}`,
    });
  }

  return items.filter((i) => ms(i.at) !== null).sort(newestFirst);
}
