/**
 * The Early Access pipeline (15 Oct 2026, Destiny: "the entire early access page needs to be
 * rebuilt following CRM standards"). One place for the columns, the time each one should
 * take and the reasons a lead can be closed, read by the page and by the server alike.
 *
 * The columns are worked out from the row, never stored: the stage, whether Intake-2 is in,
 * and whether somebody closed the lead. A stored column would be a second statement of a
 * fact the row already makes, and the two would drift.
 *
 * 15 Oct 2026 (Destiny): the columns lead with his own stage numbers, and the days-in-column
 * limits are gone; the follow-up tracker is what says whether a lead needs somebody.
 *
 * 17 Oct 2026 (Jason, buyer flow v2, SOP 09cb58a7): five stages. Stage 3 is the proposal (was
 * the "paying" placeholder), 4 the agreement and Stripe deposit, 5 the customer.
 */

export const PIPELINE = [
  { key: 'interest', stage: 'Stage 1', label: 'Interest', hint: 'Filled in Form A. Waiting on Jason to clear them.' },
  { key: 'invited', stage: 'Stage 2', label: 'Invited', hint: 'Cleared by Jason and sent Form 2. Waiting on their answers.' },
  { key: 'spec', stage: 'Stage 2', label: 'Spec received', hint: 'Sent Form 2 back. Jason and Hardik run the five checks.' },
  { key: 'proposal', stage: 'Stage 3', label: 'Proposal', hint: 'Shown the setup that fits and its price. They accept, ask or ask for a call.' },
  { key: 'agreement', stage: 'Stage 4', label: 'Agreement & deposit', hint: 'Accepted. The agreement and their own Stripe link go out.' },
  { key: 'customer', stage: 'Stage 5', label: 'Customer', hint: 'Agreement and payment both in.' },
  { key: 'closed', stage: '', label: 'Closed', hint: 'Ended, with a reason.' },
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
  kind: 'note' | 'next_step' | 'closed' | 'reopened' | 'resubmitted';
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
  if (l.stage === 5) return { key: 'customer', since: l.stage_changed_at ?? l.created_at };
  if (l.stage === 4) return { key: 'agreement', since: l.stage_changed_at ?? l.created_at };
  if (l.stage === 3) return { key: 'proposal', since: l.stage_changed_at ?? l.created_at };
  if (l.stage === 2 && l.intake_2_completed_at) return { key: 'spec', since: l.intake_2_completed_at };
  if (l.stage === 2) return { key: 'invited', since: l.stage_changed_at ?? l.created_at };
  return { key: 'interest', since: l.stage_changed_at ?? l.created_at };
}
