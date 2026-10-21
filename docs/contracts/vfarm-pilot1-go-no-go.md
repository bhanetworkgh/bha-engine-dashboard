# vFarm Pilot 1 (Client 2): go/no-go criteria

Loop LOOP-1792528168754-FVA9 (raised by Jason, 20 Oct 2026, owner Destiny). **Status: PROPOSED
for Jason, 21 Oct 2026.** Every line below either restates a rule Jason has already locked
(the source is named) or is marked **PROPOSED**. Nothing here is in force until Jason accepts
it; then it is logged as a BHARAG SOP so the agents read it, and this file says so.

## 1. What this decides

Four decisions, each a separate go/no-go, taken in this order. A later one is never taken
while an earlier one is open.

| Gate | Decision | Decided by |
|---|---|---|
| A | Release the design package (spec, BOM, CAD, config) to sovereign contacts, Onshape and Stratasys | Jason, on Hardik's and Jegan's evidence |
| B | Accept the assembled unit on receipt | The named receiver (PROPOSED below), signed off by Jegan |
| C | Ship to Pilot 1 (Client 2) | Jason |
| D | Keep the pilot running, and expand it | Jason, from the Stage 2 record |

Every line is answered **pass**, **fail** or **not yet**, with the evidence that answers it. A
line with no evidence is **not yet**, never pass. A gate is go only when every line is pass.
Nothing is described to Client 2 as ready on the strength of a partial gate (SOP 048f0d71:
"nothing gets described to a customer as production- or pilot-ready until they're green").

"Pilot 1" here is Client 2's five-rack Stage 2 pilot on his own site (LOOP-1791748317868-HJ22).
Pilot House is judged rack by rack: each of the five racks is its own farm, and the pilot is
monitored only when every rack is (SOP 7059c100).

## 2. Gate A: release the design package

The package does not leave BHA until the thing being built is one fixed, read-back identity.

| # | Line | Evidence | Owner | Source |
|---|---|---|---|---|
| A1 | Config row `VFARM_CAB_2TIER_1200x500_P1` published and its `config_hash` read back | read-back on the config route | Jegan (LM7W) | CLLJ DELTA-006 |
| A2 | `cad_revision` pinned on one immutable Onshape version that matches the rack as built | Onshape version id, read back | Hardik | CLLJ DELTA-005 |
| A3 | BOM v0.2 at part-code parity: every row has `fab_method` (fabricate, buy, print), its LM7W code and its Onshape parameter name | parity table | Jegan, Hardik | CLLJ DELTA-007, non-negotiables 1 and 4 |
| A4 | CAD, BOM and every customer-facing claim carry the same `config_hash` | Hardik's parity check | Hardik | CLLJ non-negotiable 3 |
| A5 | All eight CLLJ deltas (DELTA-CLLJ-001 to 008) resolved in writing | the conflict log in VFARM-FABRICATION-PIPELINE-V1 | Hardik | CLLJ |
| A6 | The first print part has a complete provenance packet (DHT11 casing) | packet with export SHA-256 | Hardik | CLLJ, 14 Oct |
| A7 | The E1 spec is written: yield per sq ft target, labour budget (15 to 30 min/week/unit), uptime target, allowed owner interactions, minimum sensor set and alerting, safety gates (GFCI, cabinet sealing, cleaning) | the spec doc | Jegan, Jason | SOP 8fef67ab |
| A8 | "Five racks" defined with Client 2: five cabinets, or five multi-tier racks | Client 2's written answer | Jason | SOP 8fef67ab |
| A9 | The 72-hour burn-in passed on the P1.0 rack | burn-in record | Jegan | 8E8D, passed 19 Oct 2026 |

**Today:** A9 pass. A1 to A8 not yet (CLLJ's own state on 15 Oct: "CANON LOCK INCOMPLETE /
FABRICATION RELEASE NOT AUTHORIZED").

## 3. Gate B: receiving the assembled unit

Hardik's DHT11 packet already defines receipt verification for one part. This gate applies the
same pattern to the whole unit, so known failure points are caught at the door, not on site.

**Who receives it. PROPOSED:** one named person at the delivery address (likely Albany, not
necessarily), recorded on the Stage 2 record before the unit ships, with a second operator
named the same way (SOP 8ee2e9cd, the second-operator rule). Jegan signs off remotely from the
receiver's evidence; nothing is accepted on a verbal "looks fine".

| # | Step at receipt | Evidence |
|---|---|---|
| B1 | Shipment record matches: serial, `config_hash`, `cad_revision`, BOM version | photo of label beside the Stratasys shipment record |
| B2 | Visual and dimensional check against the BOM and CAD, part by part | the acceptance checklist, filled in |
| B3 | Electrical safety: GFCI present and tested, wiring matches the wiring diagram | photo and the tester reading |
| B4 | Wet loop: filled, no leak at valve, fittings or tray outlet after 24 h | photos at start and end, dry floor under the reservoir |
| B5 | Power measured on the metered supply | meter reading, logged to the BOM row |
| B6 | Every enrolled device reports to the dashboard under the rack's own farm id | `check_un9d_acceptance` on that farm |
| B7 | Any breakage or material failure is an incident, `INC-VFARM.<SUBSYSTEM>` | the incident ids, or "none" stated |

A failed step stops acceptance. It goes on the loop the same day with an owner and a proposed
fix (the no-silence rule, Jason, 29 Sep).

## 4. Gate C: ship to Pilot 1

Jason's loop sets the bar: go is confirmed only once the unit can grow at least tomatoes.

| # | Line | Evidence | Source |
|---|---|---|---|
| C1 | Tomato growth proof: plants in the P1.0 cabinet and stable, with monitored environment | 8E8D closed on plants in | SOP 17bf6e5e, 8E8D |
| C2 | Airflow (fan placement, DHT11 positions) and substrate / planting method written down and locked before the first tomatoes | the spec | SOP 17bf6e5e |
| C3 | A Stage 1 record, `VFARM_STAGE1_LAB_VALIDATION_v1`, exists with all four checks recorded and status passed | `get_vfarm_gates` | vFarm gates contract |
| C4 | One full seed-to-harvest pre-pilot baseline run, all sensors live, all alarms deliberately tested | the run record | SOP 8fef67ab |
| C5 | The rack meets all seven monitoring contract lines (real, feed live, UN9D Test 1 and 2, every device accounted for, alert frame landed, cabinet id, config hash and burn-in sent) | `check_un9d_acceptance` plus the contract | SOP 7059c100 |
| C6 | The pilot-ready checklist is green: one stable farm id, device status matches reality, UN9D Test 1 passes | the three items | SOP 048f0d71 |
| C7 | Stage 2 record exists with its budgets set: maintenance minutes/week, alert volume/week, uptime target and window, yield target per rack per cycle, failure modes covered | `get_vfarm_gates` | vFarm gates contract |
| C8 | A written bad-news agreement: what happens if a cycle fails | signed text | SOP 8fef67ab |
| C9 | The feedback loop is defined: in-the-moment reports, weekly pulse, post-harvest debrief | the agreed channel and cadence | SOP 8fef67ab |
| C10 | The offer is tied to the Stage 2 record and signed; the deposit is taken only after the signed agreement | offer record, agreement, ledger | gates hard gate; 08KI; SOP 51271e1c |
| C11 | Hardik's acceptance pass on the payment path is green and Jason has approved a live offer | Hardik's audit record | Jason, 21 Oct 2026 |

**Timing, so nobody reads this as late.** C3 and C4 need a full tomato cycle. Jegan's window
(HJ22, 14 Oct): plants in by 30 Oct, Stage 1 verdict end of January 2027, Client 2 delivery
last week of January 2027. **PROPOSED:** if the full-cycle Stage 1 verdict and the delivery
date collide, Jason decides between shipping on an interim Stage 1 reading (first numbers end
of November) or holding delivery. This document does not make that call.

**Today:** C1 to C11 not yet. C5 partly answered: UN9D Test 2 passes on the real rack, condition
6 passes (alert frames landed 21 Oct), Test 1 fails on 13 unplaced devices and 2 silent cameras.

## 5. Gate D: running the pilot, then expanding

After the unit ships, three things must hold from day one.

**Monitoring (substrate, system, cabinet function).** Each of the five racks is its own farm on
the dashboard and must meet the monitoring contract on its own. On site: 72-hour burn-in, then
30 days unattended (HJ22). The Stage 2 verdict is read against the budgets set in C7, never
against numbers chosen afterwards. Uptime comes only from the twin's own incidents (evidence
rules). Today the dashboard watches climate, pH, soil moisture and gas; substrate and cabinet
function beyond those sensors are recorded by a person, and are never described as automated.

**The open line to Client 2. PROPOSED:** one shared channel for the pilot (a Slack Connect
channel or the CST line, Jason to choose), carrying C9's three rhythms. A problem report there
opens an incident the same day, so a pilot fault is never only a message.

**Expansion to strawberries and other produce.** Not before the Stage 2 verdict passes, and only
through Jegan's tomato-to-strawberry migration note beside SPEC-VFARM-MECH-001 (tier clearance,
irrigation capacity, light curves; 8E8D, 1 Oct). Strawberry is the target crop, and tomato on
this rack is never presented as a strawberry result (8E8D).

## 6. Keeping it repeatable

- Pilot 2 onwards uses this file unchanged; only the gate owners and dates change.
- A line changes only with a new Architect Answer from Jason, then an edit here, then a
  BUILD_LOG line.
- Each gate decision is recorded once, with the evidence for every line, so the next pilot can
  read why the last one shipped.
