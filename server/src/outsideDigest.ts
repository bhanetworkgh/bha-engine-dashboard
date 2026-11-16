/**
 * The outside digest (14 Nov 2026, Destiny — D4, BHA RSS). One digest a day of what came in from outside
 * sources (news feeds, YouTube channels, LinkedIn profiles, web pages), written by the BHA RSS service
 * (bhanetworkgh/bha-rss), which replaces Genie-RSS and ragingester.
 *
 * Destiny's rule: every raw item stays in BHA RSS's own Supabase tables; only the digest leaves. It lands here
 * (`POST /api/engine/outside-digest`, x-dashboard-key, body_b64 accepted), one row per day in
 * `engine_outside_digests`, a repeat for the same day replacing it, and goes on to BHARAG once
 * (`BHARAG_OUTSIDE_KEY`, through the write guard). Media Twin, Genie, Research Twin, North Star and Bays read it
 * with `read_outside_digest`. A digest BHARAG refuses is still stored and says so; it is tried again on the
 * next post for that day.
 */
import { query, withTransaction } from './pg';
import { record } from './engineEvents';
import { changed } from './events';
import * as bharag from './bharag';
import * as rssReports from './rssReports';

export class DigestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface DigestRow {
  digest_date: string;
  title: string;
  body: string;
  period_start: string;
  period_end: string;
  items_used: number;
  sources_used: number;
  model: string | null;
  items: Array<{ title?: string; url?: string; kind?: string; source?: string }>;
  bharag_doc_id: string | null;
  bharag_detail: string | null;
  received_at: string;
  updated_at: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

export function parse(b: Record<string, unknown>): Omit<DigestRow, 'bharag_doc_id' | 'bharag_detail' | 'received_at' | 'updated_at'> {
  const digest_date = str(b.digest_date, 10);
  if (!DATE.test(digest_date)) throw new DigestError(422, 'digest_date is required as YYYY-MM-DD.');
  const title = str(b.title, 300);
  const body = str(b.body, 60_000);
  if (!title) throw new DigestError(422, 'title is required.');
  if (body.length < 50) throw new DigestError(422, 'body is required (at least 50 characters).');
  const ps = new Date(str(b.period_start, 40));
  const pe = new Date(str(b.period_end, 40));
  if (Number.isNaN(ps.getTime()) || Number.isNaN(pe.getTime()) || pe <= ps) throw new DigestError(422, 'period_start and period_end are required ISO times, end after start.');
  const items = Array.isArray(b.items)
    ? (b.items as unknown[]).slice(0, 300).map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return { title: str(o.title, 300), url: str(o.url, 1000), kind: str(o.kind, 20), source: str(o.source, 300) };
      })
    : [];
  return {
    digest_date,
    title,
    body,
    period_start: ps.toISOString(),
    period_end: pe.toISOString(),
    items_used: int(b.items_used),
    sources_used: int(b.sources_used),
    model: str(b.model, 100) || null,
    items,
  };
}

export async function store(b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d = parse(b);
  const dry = b.dry_run === true;
  if (dry) return { ok: true, dry_run: true, digest_date: d.digest_date, inserted: 0, updated: 0, unchanged: 1 };
  const prev = await query<{ body: string; bharag_doc_id: string | null }>('SELECT body, bharag_doc_id FROM engine_outside_digests WHERE digest_date = $1', [d.digest_date]);
  const had = prev.rows[0];
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO engine_outside_digests (digest_date, title, body, period_start, period_end, items_used, sources_used, model, items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (digest_date) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, period_start = EXCLUDED.period_start,
         period_end = EXCLUDED.period_end, items_used = EXCLUDED.items_used, sources_used = EXCLUDED.sources_used,
         model = EXCLUDED.model, items = EXCLUDED.items, updated_at = now(),
         bharag_doc_id = CASE WHEN engine_outside_digests.body = EXCLUDED.body THEN engine_outside_digests.bharag_doc_id ELSE NULL END`,
      [d.digest_date, d.title, d.body, d.period_start, d.period_end, d.items_used, d.sources_used, d.model, JSON.stringify(d.items)],
    );
    await record(
      {
        event_type: 'outside_digest_received',
        subject_id: d.digest_date,
        lane: 'GENIE',
        actor: 'bha-rss',
        source_ref: 'bha-rss',
        detail: { title: d.title, items_used: d.items_used, sources_used: d.sources_used, model: d.model, replaced: Boolean(had) },
        dedupe_key: `outside_digest:${d.digest_date}:${d.body.length}`,
      },
      c,
    );
    changed('outside_digests', d.digest_date, c);
  });

  // BHARAG once per text: an unchanged repeat keeps its document; a new text is sent again.
  let bharagResult: { ok: boolean; id?: string | null; detail: string } = { ok: true, id: had?.bharag_doc_id ?? null, detail: 'already in BHARAG' };
  const keep = had && had.body === d.body && had.bharag_doc_id;
  if (!keep) {
    bharagResult = await bharag.ingest(
      'outside',
      {
        title: d.title,
        content: d.body,
        source_type: 'manual',
        content_type: 'doc',
        project_tags: ['outside-digest', 'bha-rss'],
        metadata: { doc_type: 'outside_digest', digest_date: d.digest_date, items_used: d.items_used, sources_used: d.sources_used, model: d.model },
      },
      { kind: 'record', source: 'bha-rss' },
    );
    await query('UPDATE engine_outside_digests SET bharag_doc_id = $2, bharag_detail = $3 WHERE digest_date = $1', [d.digest_date, bharagResult.ok ? bharagResult.id ?? 'ingested' : null, bharagResult.detail.slice(0, 500)]);
  }
  // Genie rebuild step 4.3 (16 Nov 2026): the day's digest is posted to #bha-engine-digests once.
  const slackPost = await rssReports.postDigest(d);
  return {
    ok: true,
    digest_date: d.digest_date,
    stored: had ? 'updated' : 'inserted',
    posted_to_slack: slackPost.posted === true,
    slack: slackPost,
    ingested_to_bharag: bharagResult.ok,
    bharag: bharagResult.detail,
    bharag_doc_id: bharagResult.ok ? bharagResult.id ?? null : null,
    inserted: had ? 0 : 1,
    updated: had ? 1 : 0,
    unchanged: 0,
  };
}

export async function read(opts: { date?: string; days?: number } = {}): Promise<{ digests: DigestRow[]; held: number; newest: string | null }> {
  const all = await query<{ n: string; newest: string | null }>('SELECT count(*)::text n, max(digest_date)::text newest FROM engine_outside_digests');
  const days = Math.min(Math.max(opts.days ?? 1, 1), 14);
  const r = opts.date
    ? await query<DigestRow>('SELECT digest_date::text, title, body, period_start, period_end, items_used, sources_used, model, items, bharag_doc_id, bharag_detail, received_at, updated_at FROM engine_outside_digests WHERE digest_date = $1', [opts.date])
    : await query<DigestRow>('SELECT digest_date::text, title, body, period_start, period_end, items_used, sources_used, model, items, bharag_doc_id, bharag_detail, received_at, updated_at FROM engine_outside_digests ORDER BY digest_date DESC LIMIT $1', [days]);
  return { digests: r.rows, held: Number(all.rows[0]?.n ?? 0), newest: all.rows[0]?.newest ?? null };
}
