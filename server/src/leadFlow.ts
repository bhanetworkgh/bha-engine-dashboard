/**
 * The vFarm buyer flow, as other surfaces read it (18 Oct 2026, Destiny — Jason's Engine
 * Surfaces Contract, #bha-coordination 1792267743.990519; docs/contracts/engine-surfaces-buyer-flow.md).
 *
 * Two things, both closing gaps the contract named:
 *
 * 1. **Every stage move, close and reopen writes one engine event, in the same transaction as
 *    the row change.** `vfarm_flow_stage_moved`, `vfarm_flow_closed`, `vfarm_flow_reopened`.
 *    Until this a move changed the row and `stage_history` and told nobody, so no agent could
 *    know where a lead was. The names start `vfarm_flow_` on purpose: anything starting
 *    `VFARM_LEAD_`, `VFARM_BUYER_` or `VFARM_SUBSCRIBER_` (any case) is the customer-events
 *    contract, whose buyer states (intake_submitted, qualified, reserved, declined) are Jason's
 *    v0 proposal and do not map onto the five stages. Mapping them would be inventing.
 *
 * 2. **`read()`, the one read of where leads are and what Stripe has seen, with no personal
 *    field.** No name, email, organisation, phone, Form A or Form 2 answer, note or proposal
 *    text is selected, so none can leak. The position is `pipelineOf`, the board's own.
 */
import { query, type Queryable } from './pg';
import * as engineEvents from './engineEvents';
import { pipelineOf, PIPELINE, type PipelineKey } from '../../src/data/leadPipeline';

export const CONTRACT = 'engine-surfaces-buyer-flow v1';
export const STAGE_NAMES: Record<number, string> = { 1: 'Interest', 2: 'Site specification', 3: 'Proposal', 4: 'Agreement and deposit', 5: 'Customer' };

/** One move, written by every path that changes `stage`. `by` is never a buyer's name. */
export async function recordStageMove(
  db: Queryable,
  m: { lead_id: string; buyer_intake_id: string | null; from: number; to: number; at: string; by: string; via: string; reason: string | null; test_payment?: boolean },
): Promise<void> {
  await engineEvents.record(
    {
      event_type: 'vfarm_flow_stage_moved',
      at: m.at,
      subject_id: m.buyer_intake_id ?? m.lead_id,
      lane: 'VFARM',
      actor: m.via === 'buyer' ? 'buyer' : m.by,
      detail: { lead_id: m.lead_id, buyer_intake_id: m.buyer_intake_id, from_stage: m.from, to_stage: m.to, to_stage_name: STAGE_NAMES[m.to] ?? null, via: m.via, reason: m.reason, ...(m.test_payment ? { test_payment: true, team_test: true, grants: 'nothing' } : {}) },
    },
    db,
  );
}

export async function recordClosed(db: Queryable, c: { lead_id: string; buyer_intake_id: string | null; stage: number; reason: string; by: string }): Promise<void> {
  await engineEvents.record(
    { event_type: 'vfarm_flow_closed', subject_id: c.buyer_intake_id ?? c.lead_id, lane: 'VFARM', actor: c.by, detail: { lead_id: c.lead_id, buyer_intake_id: c.buyer_intake_id, stage: c.stage, closed_reason: c.reason } },
    db,
  );
}

export async function recordReopened(db: Queryable, c: { lead_id: string; buyer_intake_id: string | null; stage: number; by: string; why: string | null }): Promise<void> {
  await engineEvents.record(
    { event_type: 'vfarm_flow_reopened', subject_id: c.buyer_intake_id ?? c.lead_id, lane: 'VFARM', actor: c.by, detail: { lead_id: c.lead_id, buyer_intake_id: c.buyer_intake_id, stage: c.stage, why: c.why } },
    db,
  );
}

/* ----------------------------------------------------------------- read */

export interface FlowLead {
  lead_id: string;
  buyer_intake_id: string | null;
  source_campaign: string | null;
  stage: number;
  stage_name: string;
  position: PipelineKey;
  position_label: string;
  position_since: string;
  form_2_in_at: string | null;
  /** The lead's address is an @bhanetwork.org one: a team test, never a buyer. Worked out in SQL so no address leaves the database. */
  team_test: boolean;
  proposal: { made_at: string | null; accepted_at: string | null; test: true } | null;
  payment: { state: string; mode: string; amount: number | null; amount_minor_units: number | null; amount_text: string | null; currency: string | null; paid_at: string | null; updated_at: string | null } | null;
  closed: { at: string; reason: string | null } | null;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export async function read(opts: { buyer_intake_id?: string | null; position?: string | null; include_closed?: boolean } = {}): Promise<{
  contract: string;
  leads: FlowLead[];
  counts: { total: number; by_position: Record<string, number>; payments: Record<string, number> };
}> {
  const r = await query<{
    id: string; buyer: string | null; campaign: string | null; stage: number; stage_changed_at: Date | null; created_at: Date;
    intake_2_completed_at: Date | null; closed_at: Date | null; closed_reason: string | null;
    proposal_made: string | null; proposal_accepted: string | null; pay: Record<string, unknown> | null; team_test: boolean;
  }>(
    `SELECT id::text AS id, form_a->>'buyer_intake_id' AS buyer, COALESCE(source_campaign, form_a->>'source_campaign') AS campaign,
            stage, stage_changed_at, created_at, intake_2_completed_at, closed_at, closed_reason,
            lower(COALESCE(email, form_a->>'email', '')) LIKE '%@bhanetwork.org' AS team_test,
            proposal->>'created_at' AS proposal_made, proposal->>'accepted_at' AS proposal_accepted,
            CASE WHEN stripe_payment IS NULL THEN NULL ELSE jsonb_build_object(
              'state', stripe_payment->>'state', 'mode', stripe_payment->>'mode', 'amount', stripe_payment->'amount',
              'currency', stripe_payment->>'currency', 'paid_at', stripe_payment->>'paid_at', 'updated_at', stripe_payment->>'updated_at') END AS pay
       FROM engine_vfarm_leads
      WHERE ($1::text IS NULL OR form_a->>'buyer_intake_id' = $1)
      ORDER BY COALESCE(stage_changed_at, created_at) DESC`,
    [opts.buyer_intake_id ?? null],
  );
  const all: FlowLead[] = r.rows.map((x) => {
    const pos = pipelineOf({
      stage: x.stage, stage_changed_at: iso(x.stage_changed_at), created_at: iso(x.created_at) as string,
      intake_2_completed_at: iso(x.intake_2_completed_at), closed_at: iso(x.closed_at),
    } as Parameters<typeof pipelineOf>[0]);
    const p = x.pay;
    return {
      lead_id: x.id,
      buyer_intake_id: x.buyer,
      source_campaign: x.campaign,
      stage: x.stage,
      stage_name: STAGE_NAMES[x.stage] ?? String(x.stage),
      position: pos.key,
      position_label: PIPELINE.find((s) => s.key === pos.key)?.label ?? pos.key,
      position_since: pos.since,
      form_2_in_at: iso(x.intake_2_completed_at),
      team_test: x.team_test === true,
      proposal: x.proposal_made || x.proposal_accepted ? { made_at: x.proposal_made, accepted_at: x.proposal_accepted, test: true } : null,
      payment: p ? { state: String(p.state), mode: String(p.mode), ...money(p.amount == null ? null : Number(p.amount), (p.currency as string) ?? null), paid_at: (p.paid_at as string) ?? null, updated_at: (p.updated_at as string) ?? null } : null,
      closed: x.closed_at ? { at: iso(x.closed_at) as string, reason: x.closed_reason } : null,
    };
  });
  const by_position: Record<string, number> = {};
  for (const s of PIPELINE) by_position[s.key] = 0;
  const payments: Record<string, number> = {};
  for (const l of all) {
    by_position[l.position] = (by_position[l.position] ?? 0) + 1;
    if (l.payment) payments[`${l.payment.state}_${l.payment.mode}`] = (payments[`${l.payment.state}_${l.payment.mode}`] ?? 0) + 1;
  }
  let leads = all;
  if (opts.position) leads = leads.filter((l) => l.position === opts.position);
  else if (!opts.include_closed && !opts.buyer_intake_id) leads = leads.filter((l) => l.position !== 'closed');
  return { contract: CONTRACT, leads, counts: { total: all.length, by_position, payments } };
}

/** The contract's never-infer rules, returned with every read so the reader has them beside the data. */
export const RULES = [
  'The engine decides where a lead is and what Stripe has seen. Show these values as written; if this read fails, say you do not know.',
  'A stage number proves its gate held: 3 needs Form 2 in, 4 an accepted proposal, 5 a paid Stripe payment. Never work a stage out from a thread, a form reply, an email or an open proposal.',
  'A payment sets no stage, entitlement, subscriber or reservation. mode "test" is never a customer payment and is never described as a sale.',
  'A proposal is a test only on a team test lead (an @bhanetwork.org address). A real buyer gets a real proposal only once Jason has approved a live offer, and it carries that offer_id; an accepted proposal is still not an agreement or a payment.',
  'Stage 5 is not a subscriber. Subscriber state comes only from VFARM_SUBSCRIBER_* events, which have no writer yet: "none recorded", not "none exist".',
  'No entitlement, reservation or delivery is recorded anywhere. Never claim one.',
  'Moves, closes and reopens are dated in engine_events as vfarm_flow_stage_moved, vfarm_flow_closed and vfarm_flow_reopened (from 18 Oct 2026; earlier moves are only in this read).',
];

/**
 * Stripe sends amounts in the currency's smallest unit. Bays read a live 100 (1.00 USD) as "$100"
 * in the Genie drill of 24 Oct 2026, so the read says the unit and gives the figure to quote.
 */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export function money(amount: number | null, currency: string | null): { amount: number | null; amount_minor_units: number | null; amount_text: string | null; currency: string | null } {
  if (amount == null || !Number.isFinite(amount)) return { amount: null, amount_minor_units: null, amount_text: null, currency };
  const cur = (currency ?? '').toLowerCase();
  const major = ZERO_DECIMAL.has(cur) ? amount.toFixed(0) : (amount / 100).toFixed(2);
  return { amount, amount_minor_units: amount, amount_text: `${major} ${cur.toUpperCase()}`.trim(), currency };
}
