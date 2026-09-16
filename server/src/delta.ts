/**
 * One figure against the same figure a period ago, and the words for it.
 *
 * This lived privately inside `executions.ts` until the Codex statistics tab
 * needed exactly the same arithmetic and exactly the same wording (2026-09-16,
 * Destiny). Two surfaces that compute a change separately will eventually word
 * the same change differently — "up 12%" on one and "+12.4%" on the other — so
 * there is one of each.
 */
import type { Delta } from '../../src/data/types';

/**
 * `better` says whether the movement is good news, which is not the same as up.
 * More executions is neither; more failures is bad; a faster average is good.
 * A change is only coloured on the page where there is an answer here.
 */
export function delta(from: number | null, to: number | null, better: 'up' | 'down' | null): Delta | null {
  if (from === null || to === null) return null;
  const direction = to > from ? 'up' : to < from ? 'down' : 'flat';
  return {
    from,
    to,
    // A ratio against nought has no meaning, so it is null rather than infinite
    // or a hundred per cent. Both raw figures are on the delta, so the page can
    // still say "0 → 4" where it cannot say "+400%".
    pct: from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10,
    direction,
    better: better === null || direction === 'flat' ? null : better === 'up' ? direction === 'up' : direction === 'down',
  };
}

/**
 * "up 12%", "down 40%", "0 → 4" where there is no ratio to take.
 *
 * `points` is for a change in a rate: a percentage of a percentage is not a
 * figure anybody can act on, so an approval rate that moves from 80% to 90%
 * reads "up 10 points" rather than "up 12.5%".
 */
export function movement(d: Delta, unit: 'pct' | 'points' | 'ms' = 'pct'): string {
  if (d.direction === 'flat') return 'unchanged';
  const word = d.direction === 'up' ? 'up' : 'down';
  if (unit === 'points') return `${word} ${Math.abs(Math.round((d.to - d.from) * 10) / 10)} points`;
  if (d.pct === null) return `${d.from} → ${d.to}`;
  return `${word} ${Math.abs(d.pct)}%`;
}
