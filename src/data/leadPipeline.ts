/**
 * The Early Access pipeline (15 Oct 2026, Destiny: "the entire early access page needs to be
 * rebuilt following CRM standards"). One place for the columns, the time each one should
 * take and the reasons a lead can be closed, read by the page and by the server alike.
 *
 * The columns are worked out from the row, never stored: the stage, whether Intake-2 is in,
 * and whether somebody closed the lead. A stored column would be a second statement of a
 * fact the row already makes, and the two would drift.
 *
 * The limits follow what CRMs call rotting (Pipedrive, HubSpot): past them the days-in-column
 * figure turns amber, which is the only colour on a card. Invited matches Intake-2's own
 * Unresponsive mark at 14 days, so the two never disagree.
 */

export const PIPELINE = [
  { key: 'interest', label: 'Interest', hint: 'Form A in, interest only', limit_days: 7 },
  { key: 'invited', label: 'Invited', hint: 'Stage 2, site specification sent', limit_days: 14 },
  { key: 'spec', label: 'Spec received', hint: 'Intake-2 in, BHA to review', limit_days: 7 },
  { key: 'paying', label: 'Paying', hint: 'placeholder until pricing and checkout are set', limit_days: null },
  { key: 'closed', label: 'Closed', hint: 'with a reason', limit_days: null },
] as const;

export type PipelineKey = (typeof PIPELINE)[number]['key'];

export const CLOSE_REASONS = [
  { key: 'unresponsive', label: 'Unresponsive' },
  { key: 'not_a_fit', label: 'Not a fit' },
  { key: 'timing', label: 'Timing' },
  { key: 'price', label: 'Price' },
  { key: 'other', label: 'Other' },
] as const;

export type CloseReason = (typeof CLOSE_REASONS)[number]['key'];

export const closeReasonLabel = (k: string | null | undefined): string => CLOSE_REASONS.find((r) => r.key === k)?.label ?? String(k ?? '');

/** One line on a lead's timeline that a person wrote or did here. Append-only. */
export interface LeadActivity {
  at: string;
  by: string;
  kind: 'note' | 'next_step' | 'closed' | 'reopened';
  text: string | null;
  due?: string | null;
  reason?: string | null;
}

export interface PipelineFacts {
  stage: number;
  created_at: string;
  stage_changed_at: string | null;
  intake_2_completed_at?: string | null;
  closed_at?: string | null;
}

/** Which column a lead is in, and since when. */
export function pipelineOf(l: PipelineFacts): { key: PipelineKey; since: string } {
  if (l.closed_at) return { key: 'closed', since: l.closed_at };
  if (l.stage === 3) return { key: 'paying', since: l.stage_changed_at ?? l.created_at };
  if (l.stage === 2 && l.intake_2_completed_at) return { key: 'spec', since: l.intake_2_completed_at };
  if (l.stage === 2) return { key: 'invited', since: l.stage_changed_at ?? l.created_at };
  return { key: 'interest', since: l.stage_changed_at ?? l.created_at };
}

const DAY = 86_400_000;

/** Whole days in the column, and whether that is past its limit. */
export function rotting(l: PipelineFacts, now = Date.now()): { days: number; over: boolean; limit: number | null } {
  const p = pipelineOf(l);
  const days = Math.max(0, Math.floor((now - Date.parse(p.since)) / DAY));
  const limit = PIPELINE.find((c) => c.key === p.key)?.limit_days ?? null;
  return { days, over: limit !== null && days > limit, limit };
}
