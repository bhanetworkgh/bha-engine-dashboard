/** Sub-tab names and outcome-to-health mappings shared by the Twin sub-views. */
export const TABS = ['Summary', 'Records', 'Runs', 'Gaps'] as const;
export type Tab = (typeof TABS)[number];

export const OUTCOME_HEALTH = { answered: 'ok', thin: 'degraded', failed: 'failing' } as const;

export const ENDED_HEALTH = {
  logged: 'ok',
  looping: 'degraded',
  quarantined: 'degraded',
  error: 'failing',
} as const;
