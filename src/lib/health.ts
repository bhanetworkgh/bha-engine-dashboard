import type { Health } from '../data';

/**
 * Colour carries meaning only. Healthy text stays the ordinary dim colour; a
 * healthy status dot is green, degraded amber, failing red.
 */
export function healthText(h: Health): string {
  return h === 'failing' ? 'text-failing' : h === 'degraded' ? 'text-degraded' : 'text-dim';
}

/** Background class for a status dot, on the same rule. */
export function healthDot(h: Health): string {
  return h === 'failing' ? 'bg-failing' : h === 'degraded' ? 'bg-degraded' : 'bg-ok';
}

/** One word for a health value. */
export function healthLabel(h: Health): string {
  return h === 'failing' ? 'Failing' : h === 'degraded' ? 'Degraded' : 'Healthy';
}
