import type { Health } from '../data';

/**
 * Colour carries meaning only. A healthy row gets no colour — it returns the
 * ordinary dim text class, not a green.
 */
export function healthText(h: Health): string {
  return h === 'failing' ? 'text-failing' : h === 'degraded' ? 'text-degraded' : 'text-dim';
}

/** Background class for a status dot, on the same rule. */
export function healthDot(h: Health): string {
  return h === 'failing' ? 'bg-failing' : h === 'degraded' ? 'bg-degraded' : 'bg-faint';
}
