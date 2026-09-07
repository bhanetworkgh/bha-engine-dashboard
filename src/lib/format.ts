/**
 * Display formatting. Sentence case everywhere, so the engine's SCREAMING_SNAKE
 * vocabularies are lowered at the edge rather than stored differently.
 */

/** `VFARM_CORE` renders as `vfarm_core`. */
export function laneLabel(lane: string): string {
  return lane.toLowerCase();
}

/** `COMMERCIALOPPS` renders as `commercialopps`. */
export function subsystemLabel(subsystem: string): string {
  return subsystem.toLowerCase();
}

/** `BILLING_QUOTA` renders as `billing_quota`. */
export function errorClassLabel(errorClass: string): string {
  return errorClass.toLowerCase();
}

/**
 * Age is the headline signal wherever it appears, so it carries colour on its
 * own scale: a month old is failing, a fortnight is degraded, newer is neither.
 */
export function ageTone(days: number): string {
  if (days >= 30) return 'text-failing';
  if (days >= 14) return 'text-degraded';
  return 'text-dim';
}
