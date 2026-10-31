import type { HeroBayData, HeroField } from '../../data';

/**
 * The hero bay's freshness, re-checked in the browser (FOCB, 31 Oct 2026).
 *
 * The server decides LIVE / STALE / OFFLINE / NO_FEED once, when it answers. The page keeps that
 * answer when a later re-read fails, so without this a reading that was LIVE could go on saying
 * so long after vFarm stopped looking. This applies the server's own silent-feed rule again with
 * the browser's clock: once `feed.last_snapshot_at` (when vFarm last looked) is more than
 * FEED_SILENT_S old, every REAL reading reads NO_FEED, exactly as `heroBay.buildHeroBay` would.
 *
 * It only ever downgrades: nothing becomes LIVE here, no value or timestamp is changed, and a
 * SIMULATED or NOT_VERIFIED field is never touched. A missing or unreadable snapshot time counts
 * as quiet. Pure, so `npm run test:hero-bay` checks it with a test clock.
 */

/** `monitoringTwin.THRESHOLDS.feed_silent_s`; `npm run test:hero-bay` checks the two agree. */
export const FEED_SILENT_S = 600;
/** How often the page re-checks while the Hero bay is open. */
export const RECHECK_MS = 15_000;
/** The server's own note for a NO_FEED reading, word for word. */
export const QUIET_NOTE = "the last real reading; vFarm's feed has gone quiet, so this is not current";

export function feedQuiet(lastSnapshotAt: string | null, now: number): boolean {
  const at = lastSnapshotAt ? Date.parse(lastSnapshotAt) : Number.NaN;
  return !Number.isFinite(at) || (now - at) / 1000 > FEED_SILENT_S;
}

export function fieldsNow(data: Pick<HeroBayData, 'feed' | 'fields'>, now: number): HeroField[] {
  if (!feedQuiet(data.feed.last_snapshot_at, now)) return data.fields;
  return data.fields.map((f) => (f.class === 'REAL' && f.state !== 'NO_FEED' ? { ...f, state: 'NO_FEED' as const, note: QUIET_NOTE } : f));
}
