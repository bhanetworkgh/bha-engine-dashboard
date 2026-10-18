# Engine Surfaces Contract: the vFarm buyer flow and Stripe

Version 0, 18 Oct 2026. Asked for by Jason in #bha-coordination (thread 1792267743.990519): which fields and states another surface may rely on to know where a lead is in the five-stage flow and what Stripe has actually seen for it, per consumer, and what no surface may work out for itself. No new build: this writes down what the engine holds today and names the gaps.

## 1. The one rule

The engine is the only place that decides where a lead is and what Stripe has seen. Every other surface reads the engine's answer and shows it as written. A surface that cannot read the answer says it does not know. It never works out a stage, a payment or an entitlement from anything else: a Slack thread, a form reply, a Stripe redirect page, a farm reporting, a proposal being open.

## 2. Where a lead is: the five stages

Held on the lead's own row, `engine_vfarm_leads`. Written only by `earlyAccess.moveStage`, the Form 2 submit, the proposal's Accept and the close and reopen actions. Nothing else writes these fields.

| Field | Values | Meaning |
|---|---|---|
| `stage` | 1, 2, 3, 4, 5 | 1 Interest (Form A), 2 Site specification, 3 Proposal, 4 Agreement and deposit, 5 Customer |
| `stage_changed_at` | time | When the current stage began |
| `stage_history` | list of `{from, to, at, by, reason, via}` | Every move, oldest first, never rewritten. `via: "buyer"` is the buyer's own Accept |
| `intake_2_completed_at` | time or null | Form 2 is in. Splits Stage 2 into Invited (null) and Spec received (set) |
| `proposal.accepted_at` | time or null | The buyer accepted the proposal. Proposals are `test: true` until Canon Lock |
| `closed_at`, `closed_reason` | time or null; `unresponsive`, `not_a_fit`, `timing`, `price`, `other` | A closed lead is closed whatever its stage says |

The board position is computed, never stored, by `pipelineOf` in `src/data/leadPipeline.ts`, in this order: closed, customer (5), agreement (4), proposal (3), spec (2 with Form 2 in), invited (2), interest (1). A surface that shows the position uses those seven keys.

The gates are enforced by the engine on every forward move: Stage 3 needs Form 2 in, Stage 4 needs an accepted proposal, Stage 5 needs a paid Stripe payment on the lead. Moving back is always allowed. So a stage number is itself proof that its gate held.

## 3. What Stripe has seen

Two places, both written only by the signed webhook (`POST /api/public/stripe/webhook`):

- `engine_stripe_events`: one row per Stripe event, keyed on Stripe's event id. `type`, `mode` (test or live), `session_id`, `payment_intent`, `amount`, `currency`, `outcome` (`recorded`, `duplicate`, `unmatched`, `ignored`), `lead_id`.
- The lead's `stripe_payment`: `state` (`paid`, `failed`, `expired`, `pending`), `mode`, `amount`, `currency`, `session_id`, `payment_intent`, `paid_at`, `last_event_type`, `failure`, `events`.

Rules a reader can rely on: paid is never undone by a later event; a live event never overwrites a test payment; an event is stored once. `unmatched` means money arrived that names no lead, and it is alerted.

Rules a reader must respect: a payment sets no stage, no entitlement, no subscriber and no reservation. `mode: "test"` is never a customer payment. The `/checkout/done` page says nothing about a payment, by design.

## 4. Events another surface can read

All in `engine_events`, readable through `read_engine_events`:

- `vfarm_payment_recorded`, `vfarm_payment_failed`, `vfarm_payment_expired`, with `lead_id`, `mode`, `amount`, `session_id`.
- `vfarm_proposal_made`, `vfarm_proposal_accepted` (with `moved_to_stage_4`), `vfarm_proposal_question`, `vfarm_proposal_call`. All `test: true`.
- `serious_buyer_spec_intake_invited`, `serious_buyer_spec_intake_completed`, `serious_buyer_spec_intake_unresponsive`.
- `VFARM_LEAD_CAPTURED`, through `catalog: "vfarm_customers"`: leads by campaign, no name or email.

## 5. Per consumer

**Slack Genie.** Reads `read_engine_events` with its read-only token, including `catalog: "vfarm_customers"` and the payment and proposal events above. It may say that a lead was captured, that Form 2 came in, that a proposal was accepted, and that Stripe recorded a payment, and in which mode. It must not say that a lead is at a stage, or is a customer, or is owed anything, from any of those. A stage is only what the engine's stage read says (gap 1). A test payment is never described as a sale.

**Monitoring Twin.** Reads farms and devices only (`vfarm.snapshot.v1`, `vfarm.alert.v1`). It never reads leads or payments, and it never treats a farm reporting as evidence that anyone bought, paid or became a subscriber. The link from a farm to a customer is `config_hash` on a `VFARM_SUBSCRIBER_*` event, not a guess from farm id or name.

**Media and subscriber surfaces.** What may be said in public comes from `read_media_doctrine` and `read_publication_decision`, never from the lead flow. Subscriber state comes from `VFARM_SUBSCRIBER_STATE_CHANGED`, `_DELIVERY` and `_UPGRADED`, which have no writer yet, so today the answer is "none recorded", not "none exist". A stage 5 lead is not a subscriber until that event says so. Customer counts, revenue or "first customer" claims are not made from Stripe or from stages.

**Kiosk and app.** Read `GET /api/public/vfarm-doctrine` only. It answers approved wording, or the safe fallback `interest_only_live` with `paid_subscription_url: null`. No kiosk or app reads a lead, a stage or a payment, and none links to a payment. Form A is the only thing they send.

**Internal people tools.** The dashboard's Early Access tab and `GET /api/engine/vfarm-payments` (`x-dashboard-key`, `?lead_id=`) are the read-back for people and n8n. Neither is for an agent: both carry names and emails.

## 6. Never infer locally

- A stage from a Slack thread, a form reply, a Form 2 email or an open proposal.
- A payment from a Stripe redirect, a checkout link having been sent, an invoice, or someone saying they paid.
- A customer or subscriber from a stage, a payment, or a farm reporting.
- An entitlement, a reservation or a delivery from anything at all: no writer exists for them.
- Live from test, or test from missing `mode`.
- An offer from a proposal: every proposal is a test until Canon Lock.

## 7. Gaps, named, not built

1. **A stage move writes no event.** `moveStage` updates the row and `stage_history` but writes nothing to `engine_events`, and `VFARM_BUYER_STATE_CHANGED` has no writer. So no agent can read a lead's stage today except through the page. The fix is one event per move, written in the same statement, through `engineEvents.record`.
2. **No agent-scoped stage read.** `get_page_data` on `/vfarm` would return stages, but with names and emails. It is not the read for this and should not be used for it. The read, when built, returns stage, position and payment state by `buyer_intake_id`, without personal fields.
3. **Subscriber events have no writer.** They wait on the signed agreement and the config identity.
4. **The agreement is not built.** Stage 5 currently needs only a paid payment; the signed agreement half of its gate is missing and the stage says so.

Any change to a field, value or rule here is a new version of this contract and a BUILD_LOG line.
