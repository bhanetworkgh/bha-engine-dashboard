/**
 * SE8L: who has really used a doctrine claim, for the Research Twin escalation rule (SOP 192331ee,
 * Jason, 27 Oct 2026: "a verified active consumer" and "at least one real query or watcher behavior"
 * on the gap).
 *
 * A use counts only as an engine event of type doctrine_claim_used, schema doctrine.claim.use.v1, for
 * exactly this doctrine and claim, written by an actor on VERIFIED_CONSUMER_WRITERS, and not marked
 * synthetic, fixture, test or drill. The doctrine-gap sweep is never a use: it is the watcher looking,
 * not anything consuming the claim.
 *
 * VERIFIED_CONSUMER_WRITERS is empty, and stays empty in production until an authorized producer of
 * consumer-use events exists (the read receipt and delivery check prototyped as consumerUse.ts,
 * unmerged). Empty, every answer is "no verified consumer, no real hit", so no doctrine gap can reach
 * Research Twin. Only a test passes its own writer list. A read; it writes nothing.
 */
import { query } from './pg';
import type { ConsumerEvidence } from './doctrineGap';

export const USE_EVENT = 'doctrine_claim_used';
export const USE_SCHEMA = 'doctrine.claim.use.v1';
export const VERIFIED_CONSUMER_WRITERS: readonly string[] = Object.freeze([]);

const NOT_REAL = ['synthetic', 'fixture', 'test', 'drill'];

/**
 * Verified uses of one claim. `verified_consumer` is any verified use ever recorded for the claim;
 * `real_hits` are those at or after `since`, the episode's start, so a hit always falls inside the gap.
 */
export async function consumerEvidence(doctrineId: string, claimId: string, since: string, writers: readonly string[] = VERIFIED_CONSUMER_WRITERS): Promise<ConsumerEvidence> {
  if (writers.length === 0)
    return { ok: true, verified_consumer: false, consumer: null, real_hits: 0, hit_refs: [], note: 'no authorized consumer-use writer exists, so no use can be verified; this fails closed' };
  try {
    const r = await query<{ id: string; actor: string; inside: boolean }>(
      `SELECT id::text, actor, (at >= $4::timestamptz) AS inside FROM engine_events
        WHERE event_type = $1 AND detail->>'schema' = $2 AND detail->>'doctrine_id' = $3 AND detail->>'claim_id' = $5 AND actor = ANY($6::text[])
          AND NOT EXISTS (SELECT 1 FROM unnest($7::text[]) AS k WHERE lower(coalesce(detail->>k, '')) IN ('true', 'yes', '1'))
        ORDER BY at DESC, id DESC LIMIT 200`,
      [USE_EVENT, USE_SCHEMA, doctrineId, since, claimId, [...writers], NOT_REAL],
    );
    const hits = r.rows.filter((x) => x.inside);
    return { ok: true, verified_consumer: r.rows.length > 0, consumer: r.rows[0]?.actor ?? null, real_hits: hits.length, hit_refs: hits.map((x) => x.id).slice(0, 50), note: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
