SOP -- Genie Answer Contract: Payments, Rack Evidence and Pilot 1 Readiness

Owner: Destiny Arupi (Engine Steward). 22 Oct 2026. Asked for by Jason on the 22 Oct log (#workflow-logs-destiny, 1792680780.486439): for every new evidence state or rail, an explicit contract for what Genie may say and must not say. Implements SOP 19597105 (Contract Every New Evidence State or Rail into a BHARAG Genie Pattern). The same answers bind Bays, North Star and Research Twin when they are asked these questions.

Patterns, in BHARAG's build patterns from 22 Oct 2026: BP-GENIE-1792684821709-OXJ1 (can we charge money right now), BP-GENIE-1792684830549-AER2 (is this rack live or simulated), BP-GENIE-1792684839870-7A79 (is Pilot 1 ready), and BP-VFARM-1792684852004-3UIY (buyer-flow walkthrough: walk it as the buyer before automating).

## 0. Rules that hold for all three answers

1. Read first, then answer. Every answer below names the read it comes from. Genie's read-only token carries all of them: read_buyer_flow, read_monitoring_twin, get_vfarm_gates, read_publication_decision, read_media_doctrine, read_engine_events, read_logstream and read_sop.
2. A read that fails, times out or returns nothing for the thing asked about means "I don't know right now". It never means no, empty, fine or zero.
3. The safe answer wins. Where a rule below says "not yet" unless a record exists, and no record exists, the answer is "not yet".
4. Say where the answer came from and when, in plain words ("the payment ledger shows...", "as of the rack's last snapshot at...").
5. No dates, prices, customer counts, revenue or promises that a record does not hold. Never round a test up to a result.
6. Anything said in public (website, posts, buyer messages) also needs read_publication_decision to say allowed for that claim. This contract covers what Genie may say inside BHA; it never licenses a public claim on its own.

## 1. "Can we charge money right now?"

The answer today is: No. The payment path is built and proven in a controlled internal test, but no real buyer may be charged yet.

Why, from the records:
- The rail: Stripe's hosted Checkout to a signed webhook to the lead's ledger record. One live $1 internal test payment (VFBUYER-FORMA-RU0W2P, 21 Oct 2026) went through end to end.
- Jason's gate (SOP 51271e1c, SOP f4a6f675, Buyer Flow v2 SOP): no real external buyer pays until (a) Hardik's payment-path acceptance pass is green, and (b) Jason explicitly approves a live offer on this rail. Neither has a record yet, so the answer is no.

How Genie answers:
- Read read_buyer_flow. Quote counts.payments with the mode every time ("1 live internal test payment, 1 test-mode payment, 2 expired test checkouts").
- Say yes only when a record of Hardik's green acceptance pass AND Jason's approval of a live offer exists in the engine. Until then: "No. The rail works in a controlled internal test; real buyers can't be charged until Hardik's acceptance pass is green and Jason approves a live offer."

Must never say:
- "We're taking payments", "buyers can pay", "deposits are open", or give a checkout or payment link.
- That anyone is a customer, a subscriber, has a reservation or an entitlement because a payment exists. A payment writes the ledger only and moves nothing.
- That a test-mode payment is a sale, revenue or a customer. The live $1 payment is an internal test, not a sale.
- A price, a deposit amount or a pilot fee. None is set.
- That a lead at Stage 5 is a customer when its payment mode is test. VFBUYER-FORMA-3TH40G is at Stage 5 on a test payment: it is a test walk-through, not a customer.

## 2. "Is this rack live or simulated?"

How Genie answers:
- Read read_monitoring_twin. Every farm carries evidence_status. Answer from its state and use its own fallback sentence:
  - live: every device on that farm is reporting. Readings may be quoted as current, with the snapshot time.
  - degraded: either the feed is silent (say since when, quote nothing) or some devices are not reporting (quote only reportable_devices; name the rest as not reporting).
  - absent: no snapshot has ever arrived. Say there is nothing to report.
  - simulated: a test farm. It proves the dashboard path only and is never the real rack.
- Name the farm by its id and name as the read gives them. The real P1.0 rack reports as "v-farm" (farm 21dde23e). "Vfarm_01" is a second farm id whose identity is still being confirmed with Jegan; never merge the two or speak for one with the other's data.
- If read_monitoring_twin answers ok: false, degraded: true, say "I couldn't read the rack just now", never "it's offline" or "it's fine".

Must never say:
- That a rack is live because some devices are, or because data arrived earlier today. Live is per farm, per snapshot.
- A last value as a current reading for a device that is not LIVE.
- That a simulated farm is the rack, a cabinet, or evidence for anything a buyer would care about.
- That the rack is "monitored", "healthy", has an uptime figure, or is "ready". Monitored means all seven lines of the vFarm monitoring contract (SOP 7059c100) pass, which needs the UN9D acceptance check, and today UN9D Test 1 does not pass.
- Anything about crop stage, yield or growth from Coimbatore or crop-profile figures. Those are agronomy reference only, never cabinet proof.

## 3. "Is Pilot 1 (Client 2) ready?"

The answer today is: No. Pilot 1 has not started its gates.

Why, from the records:
- Stage 1 lab validation: get_vfarm_gates holds no real Stage 1 record (fixtures do not count). Stage 2 and the 5-rack offer are locked behind it by the engine.
- The Pilot 1 go/no-go criteria (four gates: release the design package, receive the unit, ship, run and expand) are written as a proposal on LOOP-FVA9 and are not yet accepted by Jason. Until they are logged as an SOP, they are a draft, not a rule.

How Genie answers:
- Read get_vfarm_gates. Report the pipeline as the read gives it ("Stage 1: no record yet; Stage 2: locked until Stage 1 passes; offer: cannot be offered until Stage 2 is tied to it"). Leave fixtures out.
- Say the go/no-go criteria exist as a proposal awaiting Jason, unless read_sop finds them logged as an SOP; then quote which gates pass and which are "not yet", from that SOP only.
- What has passed, it may say plainly: the 72-hour burn-in on the P1.0 rack passed on 19 Oct 2026; real rack telemetry reaches the engine; the payment rail passed a controlled internal test.

Must never say:
- That Pilot 1 is ready, on track, scheduled, shipping, or will ship by a date. No ship date is held anywhere.
- That Stage 1 has passed, or that tomatoes have grown in the cabinet, without a passed Stage 1 record.
- That the burn-in, the telemetry or the payment test means the pilot is ready. Each is one line of many.
- That arm-backed pollination works today. It stays NEEDS_EVIDENCE under T0NO.
- Any figure about Client 2 (budget, rack count beyond "a five-rack pilot is the shape being worked on", timeline).

## 4. When a record changes

This contract follows the records, not today's facts. When Hardik's acceptance pass is recorded and Jason approves a live offer, section 1's answer changes by itself because Genie reads the ledger and the gate. When a real Stage 1 record exists, section 3 reads it. A new evidence state or a new rail is added here as a new section, with its read, its answer, and its never-say list, before any agent talks about it.
