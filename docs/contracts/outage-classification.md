# Rack outage classification and how we talk about it

`outage.classification.v1`, 13 Nov 2026 (Destiny). Jason on LOOP-1788044070646-408M, 2 Nov 2026
(#workflow-logs-jason, C0BT41XUWG7 1793290686.159989): "diagnostic → encoded pattern → commercial use".
The method is Jegan's production read of 2 Nov (1793617155.681509). The rules live in
`server/src/outageClass.ts` (`RULE`) and nowhere else; `npm run test:outage-class` pins them against the
408M numbers. Read through `classify_outages` (both connections, in Genie's scope).

## 1. The six outage types

| Type | What it is | How it is told apart |
|---|---|---|
| `POWER_CUT` | Mains power at the site went off | The Pi's boot record says power loss with no clean shutdown, in the outage window |
| `GATEWAY_LINK` | The Pi stayed up but its link to the server dropped (wifi or broker reconnect) | The Pi and the board went stale together, inside the boot record's coverage, with no reboot |
| `BOARD_HARDWARE` | The UNO board or its connection failed | The board went stale while the Pi stayed healthy, and a builder's log or the Pi journal names the board |
| `VALVE_COIL` | A valve coil spike reset the board path | The board went stale while the Pi stayed healthy, and a builder's log names the valve |
| `DEPLOY_REBOOT` | We deployed to the Pi and it restarted | The boot record says deploy |
| `CLEAN_REBOOT` | A planned, clean restart of the Pi | The boot record says clean |

**Unresolved is a real answer.** A gateway outage from before the boot record existed (it went on the Pi on
29 Oct 09:40 UTC) cannot be read as power or link from the API; the Pi journal can settle it. A board outage
nobody has named a cause for is board or valve. Both come back with `outage_type: null`, both candidates, and
what would settle it. Nothing is guessed.

## 2. What counts against a run

| Type | Counts? | Why |
|---|---|---|
| `GATEWAY_LINK` | Yes | Our gateway lost its link |
| `BOARD_HARDWARE` | Yes | Our hardware failed |
| `VALVE_COIL` | Yes | Our hardware reset itself |
| `POWER_CUT` | No | Site mains power, which the unit recovered from on its own |
| `DEPLOY_REBOOT` | No | Our own deploy, logged as ours |
| `CLEAN_REBOOT` | No (proposed) | A planned restart. Jegan's read did not rule on it; Jason confirms |
| Unresolved | Yes, until resolved | It may be a link drop, and an SLA must not assume the kinder reading |

An outage that starts before the run starts is outside the run.

## 3. The 408M reference (16 Oct 13:01 UTC burn-in to 2 Nov, November run from 29 Oct)

Eight outages of the sensor path: five gateway (the Pi and the board stale together), three board (the Pi healthy).

| When (UTC) | Minutes | Type | November run |
|---|---|---|---|
| 19 Oct 15:44 to 16:24 | 40 | Unresolved: power or link | Outside (before 29 Oct) |
| 20 Oct 13:26 to 14:11 | 45 | Unresolved: power or link | Outside |
| 21 Oct 00:56 to 08:55 | 479 | BOARD_HARDWARE (USB port failure, board replacement EREM) | Outside |
| 21 Oct 15:59 to 16:19 | 20 | BOARD_HARDWARE | Outside |
| 21 Oct 16:44 to 21:29 | 285 | Unresolved: power or link | Outside |
| 28 Oct 10:53 to 11:08 | 15 | VALVE_COIL (drain valve coil spike, fix on J660) | Outside |
| 30 Oct 16:30 to 31 Oct 07:35 | 905 (15.1 h) | POWER_CUT (boot record: power loss) | Excluded |
| 2 Nov 05:50 to 06:06 | 16 | GATEWAY_LINK (no reboot on the boot record) | **Counts** |

Plus four reboots that did not stale the board: deploys on 29 Oct 09:40, 30 Oct 06:58 and 2 Nov 08:26, and a
clean reboot on 29 Oct 10:43, all excluded. Against the November run: **16 minutes count**; the 15.1-hour power
cut, three deploys and one clean reboot are excluded. (Jegan reported the power cut as 906 minutes from his
second-level records; the posted times give 905, and the code keeps the posted times.)

## 4. How we talk about it to Shibu (reliability claims)

- **Say:** the rack's sensor path is watched continuously; every outage is recorded with its cause; site
  power cuts and our own deploys are shown separately from faults in our hardware or link.
- **Show:** the outages that counted, each with its type and minutes, and the excluded ones with why they
  were excluded. Never only the total.
- **Never:** an uptime percentage, "no downtime", "self-healing rack", or a power cut presented as our fault
  fixed by us. The unit coming back after power returns is recovery, not repair. The do-not-claim block
  (SOP a7f63ae9) holds over all of this.
- **Unresolved outages are shown as unresolved,** and counted.

## 5. How it carries into a future SLA

- **Chargeable downtime:** `GATEWAY_LINK`, `BOARD_HARDWARE`, `VALVE_COIL`, and any outage still unresolved
  at the end of the period.
- **Excluded:** `POWER_CUT` at the customer's site that the unit recovers from on its own, `DEPLOY_REBOOT`,
  and `CLEAN_REBOOT` (proposed). A power cut the unit does not recover from on its own is a separate
  decision, not covered here.
- **Worked example:** for the November run to 2 Nov, chargeable downtime is 16 minutes; the 905-minute power
  cut is excluded.
- No SLA figure, credit or price is set by this document. Those are Jason's.

## 6. Changing it

A change to a type, a rule or what counts is Jason's decision, then an edit to `RULE` in
`server/src/outageClass.ts`, to this document and to `server/test/outage-class.test.cjs`, together, and a
BUILD_LOG line.
