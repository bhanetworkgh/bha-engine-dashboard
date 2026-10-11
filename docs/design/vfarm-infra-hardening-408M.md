# vFarm infra hardening: where the three deliverables stand

**Loop:** LOOP-1788044070646-408M (Jason, 24 Aug 2026). **From:** Destiny, 11 Oct 2026. **For:** Jason, Hardik, Jegan.

The loop has three deliverables and one sub-part. This note says what exists for each, with the record that proves it, and what is still owed and by whom. Nothing below is a plan: every "exists" line names something that is live.

## 1. Golden incident pattern, error semantics, self-healing v1 (Destiny)

Done. It was built across September and October and is in use.

**One incident shape.** Every engine fault is one row in the BHARAG incident ledger, one per fault, with: lane, subsystem, workflow, the step that failed, error class, severity, whether it can be retried, the advice for a person, and its state (open, retrying, closed). Engine health reads it for Bays, North Star, Research Twin and Genie.

**One error vocabulary, shared by every handler.**

| Class | Retried on its own? |
|---|---|
| `NETWORK_TIMEOUT` (includes a 429) | yes |
| `MODEL_OUTPUT_INVALID` | yes |
| `UPSTREAM_5XX` | yes |
| `BILLING_QUOTA` | no |
| `CONFIG_AUTH` | no |
| `SCHEMA_VALIDATION` | no |
| `UNKNOWN` | no |

**What happens after a failure, in order.**
1. The healer retries a retryable fault from the failed step: after 1 minute, 4 minutes, 15 minutes, three attempts at most.
2. A fault no retry can fix goes to the repair bridge, which proposes or applies a change to the workflow and records what it changed and the way back.
3. A fault caused by a dependency being down (model credit, Slack, Google, BHARAG) waits, and is re-run once the dependency answers.
4. A fault that keeps coming back opens one research job for the pattern (Logstream: 3 of the same fault in 7 days), and 5 tells a person.
5. Anything left says so: "needs a person" is a state on the page, never silence.

**The same shape for the cabinet.** The Monitoring Twin opens `INC-VFARM.SENSOR`, `INC-VFARM.ENVIRONMENT` and `INC-VFARM.FEED` incidents in the same ledger, one per fault, closed when the fault clears.

**Where it is written down as patterns:** BP-INFRA-001-CANONICAL_INCIDENT_TAXONOMY (incidents.v0), BP-LOG-001-SELF_HEALING_RETRY_WITH_REAL_ERROR_TAXONOMY, BP-HEALING-002-ONE_LAYER_HEALING_BRIDGE, BP-SELFHEAL-001-INCIDENT_HEALABILITY_GATE, BP-LOG-001-LEDGER_AS_RETRY_QUEUE, BP-BAYS-1791460374050-S757 (closure protocol), BP-BAYS-1791460380502-BW9S (guarded retry).

## 2. Card tagging for North Star and Research Twin (Destiny and Hardik)

Destiny's half, the engine side, is done: this is the map of which tags and events live on which record, and each one is readable by the twins today. Hardik's half is the media side: which of these Media Twin is allowed to turn into a claim.

| Record | Tags it carries | Events written about it | How a twin reads it |
|---|---|---|---|
| Commercial card | `lane_id`, `confidence`, `readiness_state`, `pilot_state`, `routing_state`, `media_gate`, `media_readiness`, `missing_research_count`, `research_gleanings`, `experiment_results` | none of its own; a research job names its `Card ID` | `find_records` kind commercial; `get_priority_evidence` |
| Research job | `Lane`, `Card ID`, `Status`, `Attempts`, `Confidence`, `Opened By`, `Opened By Trigger`, `Signal Key` | `logstream_threshold_crossed`, `monitoring_recurrence_detected` when one opens it | `find_records` kind rt-jobs; `read_logstream` |
| Incident (engine) | lane, subsystem, workflow, failed step, error class, severity, retryable, resolution state | Logstream rows: observed, closed, patterns evaluated | `lane_health`; `read_logstream` |
| Incident (cabinet) | farm, device, kind, metric, stage, severity, and from 11 Oct the retry state: self-healed, retrying, needs human | `monitoring_recurrence_detected` | `read_monitoring_twin` |
| Farm (twin envelope) | `farm_id`, `cabinet_id`, `config_hash`, `burn_in_state`, worker health, retry counts, evidence class | none yet | `read_monitoring_twin` |
| vFarm stage gate and offer | status, the four checks, `target_cabinet_config_hash`, `cad_revision` | `VFARM_STAGE1_STATE_CHANGED`, `VFARM_STAGE2_STATE_CHANGED`, `VFARM_CHECK_UPDATED`, `VFARM_OFFER_STATE_CHANGED` | `get_vfarm_gates`; `read_engine_events` |
| Lead, buyer, subscriber | `source_campaign`, state, `subscription_lane`, `config_hash`, `cad_revision` | `VFARM_LEAD_CAPTURED` and the four other customer events | `read_engine_events` with catalog `vfarm_customers` |
| Lane | the six ranking factors, linked commercial lanes, blocked-by loops | `lane_blocker_cleared` | `rank_lanes`; `lane_health` |
| Media doctrine claim | maturity, allowed wording, prohibited wording | one record per doctrine change | `read_media_doctrine` |

Three of those tags are empty until vFarm sends them: `cabinet_id`, `config_hash` and `burn_in_state` on the farm. The read says "not sent by vFarm yet"; it does not guess.

## 3. Media-safe infra brief (co-authored; this is the infra half)

What the incident and tagging layers can honestly support a claim about today, for Hardik to turn into doctrine wording.

**Supported by a record a twin can cite.**
- The engine notices its own faults, retries the ones a retry can fix, and says when a person is needed. Every step is on a page.
- A fault that keeps coming back opens research on its own.
- The Monitoring Twin judges a farm's sensors against a versioned crop profile and opens and closes its own incidents.

**Not supported yet, so not safe to claim.**
- Anything about a real cabinet. The only farm the twin holds is a simulation. A simulated farm is never described as the real rack.
- Uptime as a product figure. The definition is locked (share of time with no enrolled device offline, 90 s and 900 s) and there is no real farm to measure.
- Reliability numbers of any kind: the thresholds are v0 and are re-tuned around 9 Nov.
- Yield or timing taken from Coimbatore. That is an agronomy reference only, never cabinet proof.
- "Subscription live." No subscriber event exists, and the Good-Enough gates have no numbers yet.

These boundaries are also held in code (`server/src/evidenceRules.ts`) and are returned by `read_media_doctrine` and `read_monitoring_twin`, so a twin meets them before it writes a claim.

## Jegan's sub-part: what counts as a cabinet incident

What the engine already decides: a sensor is offline after 900 seconds with no reading; a reading outside its crop stage's range is an incident; a farm whose snapshots stop for 600 seconds is an incident. The fields every cabinet incident carries are in section 2.

Still Jegan's: pump and valve thresholds, rail and vision constraints, and the soil-moisture range (the crop profile marks it "owner threshold required"). The engine has a place for each: a new range goes into the crop profile as a new version, and a new subsystem arrives on the snapshot.

## What is still owed on this loop

- Hardik: the media half of section 2 and the wording for section 3.
- Jegan: the thresholds named above.
- Destiny: nothing further until those land.
