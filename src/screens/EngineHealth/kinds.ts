/**
 * The record kinds Engine health is built from, one list for all its tabs: a
 * change to any of them re-reads whichever tab is open (live since 2026-09-23).
 */
export const HEALTH_KINDS = ['incidents', 'error_counts', 'retry_attempts', 'digests', 'repairs'] as const;
