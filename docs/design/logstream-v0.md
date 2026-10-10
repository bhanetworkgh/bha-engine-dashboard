# Incident → Research → Guidance: Logstream v0 design note

**Date:** Friday 9 October 2026
**Owner:** Destiny Arupi (Engine Steward)
**Approved direction:** Jason Bays, #bha-north-star-twin, 9 Oct ("proceed as proposed")
**Status:** Built as v0 on 10 Oct 2026 (table, writer, trigger; `server/src/logstream.ts`), on Jason's go-ahead of 9 Oct. A read and analysis spine only: no pay is automated, and nothing is closed, retried or deleted by it. Sections 1 to 9 are the design as written on 9 Oct; section 11 says what was built.
**Merged from:** Research Twin answer `RT-1791466173818-JZMP` and North Star answer `NS-1791466174257-Q6NI`.

---

## 1. What this is

One written design for how an engine fault becomes a research question and then a piece of guidance, and how each step is logged in a single row shape ("Logstream"). It joins the two twins' answers into one note, so there is one design and not two.

Two things were done in this pass, and only these two:

1. This note.
2. The BAYS work lane is now linked to the commercial lane `LANE-VFARM-SELF_HEALING_ENGINE` (card `CARD-1790036548913-TTF6`), so Bays' incident work and that lane's research are read together. Set on the dashboard, audit line 1493, confirmed on the live lane read the same day.

## 2. The four patterns it covers

| Short id | Name | Held as |
|---|---|---|
| S757 | Digest Incident Closure Protocol | Registered pattern `BP-BAYS-1791460374050-S757` |
| GRM8 | answer_cut_off explicit signal in pattern-draft | Registered pattern `BP-BAYS-1791460387306-GRM8` |
| BW9S | Guarded retry_incident path | Registered pattern `BP-BAYS-1791460380502-BW9S` |
| GNER | No filler on an empty read | **Still a candidate**, `CAND-1791450711610-GNER`. Not a registered pattern yet. |

## 3. Signal model (from Research Twin, kept as written)

A "signal" is one observable event where a pattern either was followed or was not.

- **S757.** A close or retry on an incident. Followed = the close carries evidence (a ledger row and an audit line). Not followed = closed because a retry happened to succeed.
- **GRM8.** A pattern draft whose answer was cut short. Followed = it is reported as cut off, by name. Not followed = it is reported as a generic parsing fault, or blindly retried.
- **BW9S.** A manual retry of an incident. Followed = written reason, audit line, refused if already recovered. Not followed = a retry outside that path.
- **GNER.** A read that came back empty. Followed = the answer says it was empty. Not followed = the gap is filled with plausible text.

## 4. The loop (Research Twin's five steps, plus North Star's guidance step)

1. **Count.** Incidents are counted per fault signature over a rolling 7 days.
2. **Threshold.** When a signature crosses the threshold (section 6), it is a pattern, not a one-off.
3. **Research.** One Research Twin job is opened for the pattern. Never one per incident.
4. **Finding.** The job resolves with a cause and a confidence.
5. **Logstream row.** One row is written joining incident, pattern, research and outcome.
6. **Guidance (North Star).** North Star turns the finding into a recommendation: a tag change on the lane, a note on the linked commercial card, and a note in the channel. A recommendation, never an action taken on its own.

## 5. Logstream v0 row

Research Twin's field list is the base. Two fields are added from North Star.

| Field | Meaning |
|---|---|
| `logstream_row_id` | The row's own id |
| `incident_id` | The ledger incident it is about |
| `timestamp` | When the row was written |
| `lane_id` | Work lane, with the linked commercial lane where there is one |
| `pattern_ids_applied` | Which of the patterns applied |
| `pattern_adherence` | Followed / not followed / not applicable, per pattern |
| `objective_outcomes.incident_frequency_7d` | Same signature, last 7 days |
| `objective_outcomes.incident_frequency_30d` | Same signature, last 30 days |
| `objective_outcomes.time_to_recovery` | Raised to closed |
| `objective_outcomes.retry_count` | Retries made |
| `objective_outcomes.retries_within_cap` | Whether they stayed inside the cap of three |
| `objective_outcomes.escalation_occurred` | Whether a person had to step in |
| `research_trigger.threshold_crossed` | Whether this row crossed the threshold |
| `research_trigger.rt_job_id` | The research job opened, if any |
| `research_trigger.cause_distribution` | The causes found, with shares |
| `commercial_relevance.linked_card_ids` | Commercial cards this bears on |
| `commercial_relevance.relevance_note` | Why it matters commercially |
| `commercial_relevance.pay_band_recommendation` | A recommendation object. Advice only. |
| `audit.written_by` | Who or what wrote the row |
| `audit.approval_gate_status` | Where it stands with a person |
| `evaluated_by`, `evaluated_at` | Who reviewed the row and when (North Star) |
| **`person_confirmed`** | **Added.** Must be true before an incident counts toward pay or autopay. Default false. |
| **`autopay_enabled`** | **Added.** Default false. While false, pay stays a recommendation a person acts on. |

**The pay rule in one line:** nothing in this design pays anybody. A row can recommend; a person confirms; autopay stays off until Jason agrees a rule.

## 6. Calibration: what the records we hold actually say

Read from the dashboard's own incident record on 9 Oct 2026. 107 incidents, 28 Aug to 9 Oct (about six weeks), across Bays, North Star, Research Twin and Genie.

### 6a. Per fault signature (workflow + the step that failed)

- 77 distinct signatures. **64 of them fired exactly once.**
- Signatures that reached **5 or more in 7 days: 3.**
  - Bays — Builder Chasers / Assert Chaser Delivered: 7
  - Genie / agent-orchestrator: 5
  - North Star — Front Door / Is Duplicate?: 5
- Signatures that reached **3 or 4 in 7 days: 4 more.**
  - North Star — Conversational Agent / Read_Slack: 4
  - Bays — Daily Doc Rotator / Create Daily Doc: 3
  - Bays — Front Door / Raise Refused Ask: 3 (a guard doing its job, not a fault)
  - Monitoring Twin Simulator / Build Simulated Snapshot: 3 (test noise)

### 6b. Per lane per week

Bays had 7, 10, 1, 2, 14, 18 and 7 incidents in successive weeks. North Star had one week of 16. **A lane-level "5 in 7" would have fired in five of Bays' seven weeks.** That is an alarm that is always on.

### 6c. What this means for the threshold

1. **Count per signature, never per lane.** This is the main tuning. Per lane, 5-in-7 is noise. Per signature, it is rare and meaningful.
2. **Research Twin's 5-in-7 stays as the default for "this needs a person now".** On six weeks of history it would have fired 3 times. All three were real.
3. **Recommend 3-in-7 per signature as the point where research opens.** It would have fired 7 times in six weeks, 5 of them real. It also matches the rule Jason already approved for the Monitoring Twin on 4 Oct (3 or more in 7 days, one job per pattern), so the engine has one number, not two.
4. **Leave out** test and simulator incidents, and "refused ask" incidents, which are guards working. Without that, 2 of the 7 firings are false.
5. **The 20% half, tuned from run counts** (added later on 9 Oct). Read from the 30,478 production runs held, 7 Sep to 9 Oct, as failed runs over all runs, per workflow per week, for workflows with at least 5 runs that week (117 workflow-weeks).
   - A plain 20% rule fired in **18** of the 117. **12 of those 18 are one week**, 21 Sep, when the Airtable cap broke everything at once. That is one outage, not twelve patterns.
   - Outside that week it fired 6 times: Research Twin — Agent Delivery in **three separate weeks** (5 of 19, 4 of 14, 4 of 19), the simulator once (test), Research Twin's old agent once (2 of 9) and Bays — Approval Decision once (1 of 5).
   - So 20% is the right height, but it needs a floor. **Recommended: 20% or more of a workflow's runs fail in 7 days, with at least 10 runs and at least 3 failures.** With that floor and tests left out, the only firing outside the outage week is Research Twin — Agent Delivery, three weeks running. The per-signature count in point 3 missed it (its busiest week was 2). Read by day, those failures sit on three single days, not spread through the weeks: 24 Sep (the day the workflow was built), 28 Sep (cause not checked in this pass) and 7 Oct (the BHARAG address move, closed with its cause). None since 7 Oct. So the rule fired on real failures, but this is three separate bad days, not one standing fault.
   - **The two halves catch different things, so keep both.** The count catches one step breaking repeatedly. The rate catches a workflow that keeps failing a fifth of the time in different places.
   - **A week where many workflows cross at once is one event.** When five or more workflows cross in the same 7 days, raise one incident for the shared cause and open no per-workflow research.

All of these numbers stay tunable. Six weeks is thin, and these should be re-read after another month.

### 6d. How often each of the four patterns actually fired

| Pattern | What the records show | Honest reading |
|---|---|---|
| S757 | 7 digest or scheduled-run incidents held. 2 since the protocol existed (INC-BAYS.AGENT-046 on 7 Oct, -049 on 9 Oct). Both were closed with an evidence line. 13 digest posts confirmed delivered since 4 Oct, 0 failed. | Followed 2 of 2. Small sample. |
| GRM8 | 6 pattern-draft runs held. 1 failed, recorded as a parsing fault (the failure that led to this pattern). 0 cut-off answers since the fix on 7 Oct. | Has not fired since it was built. Nothing to tune yet. |
| BW9S | 3 guarded-retry calls, all on 7 Oct, all part of proving it: 1 dry run, 1 refused, 1 applied. Before it: 11 healer retry rows from 17 to 21 Sep (6 exhausted, 3 recovered, 2 undecided). None since. | Has not been used in anger. |
| GNER | Nothing in the record marks a read as empty. | **Cannot be counted today.** The engine does not record this signal. |

**Plain summary:** two of the four patterns have never fired in real use, one has fired twice, and one cannot be measured. Thresholds for the four patterns themselves cannot be tuned from this. What can be tuned, and was, is the incident threshold in 6c.

## 7. Limits, stated plainly

- **Time to recovery is not trustworthy in what we hold.** 77 of the 107 incidents were closed before 2 Oct, when closes started being dated and signed. Their close times are estimates. Use this field only for incidents closed from 2 Oct on.
- **GNER has no signal.** Until an empty read is recorded somewhere, that row of the model is a design, not a measurement.
- **GNER is not a registered pattern.** It should be registered or dropped before anything depends on it.
- **Six weeks, four lanes.** Enough to see that per-lane counting is wrong. Not enough to fix numbers for good.
- **Research Twin's own listed limits stand** (see its answer).

- **The 28 Sep failures on Research Twin — Agent Delivery (5 runs) were not traced** in this pass. The other two bad days have known causes.

## 8. What is deliberately not built

- No Logstream table, no writer, no page.
- No automatic research trigger for engine incidents (the Monitoring Twin's one exists and is separate).
- No autopay, no pay band applied to anyone.

## 9. Open items for a next pass, if Jason wants one

1. Agree the two count numbers: 3-in-7 per signature opens research; 5-in-7 per signature calls a person.
2. Register or drop GNER, and decide where an empty read gets recorded.
3. Agree the rate rule: 20% with at least 10 runs and 3 failures, and "many at once is one event".
4. Only then: build the Logstream row and the trigger.

## 10. Locked v0 parameters (Jason Bays, 9 Oct 2026)

Locked in #bha-north-star-twin on 9 Oct 2026. These replace the proposals in sections 6 and 9 wherever they differ. They are rules on paper: nothing in the engine acts on them yet.

**Counts, per fault signature, never per lane**

- 3 of the same fault in 7 days: open one Research Twin job for that pattern.
- 5 of the same fault in 7 days: escalate to a person.
- Test, simulator and "refused ask" incidents are excluded from both.
- A fault signature is the workflow plus the step that failed.

**Workflow-level rate rule, a separate trigger**

- 20% or more of a workflow's runs fail in 7 days,
- with at least 10 runs and at least 3 failures.
- When 5 or more workflows cross a threshold in the same 7 days, it is one shared-cause outage, not one pattern per workflow.

**GNER (No Filler on an Empty Read)**

- Stays a candidate pattern only (`CAND-1791450711610-GNER`).
- No GNER-based trigger is wired until empty reads are recorded somewhere in the engine and there are real counts on that signal.
- In v0, no runtime decision may depend on GNER.

**Empty-read logging: consciously left out of v0** (Destiny, 9 Oct 2026)

- Recording an empty read means changing the workflows that do the reading. That is low-level work, which this pass excludes.
- So v0 does not record empty reads, GNER stays a candidate, and nothing depends on it.
- Revisit at the re-tune. If it is wanted then, it is scoped as its own build.

**Limits and re-tune**

- `objective_outcomes.time_to_recovery` is trusted only for incidents closed on or after 2 Oct 2026.
- All numbers here are v0, calibrated from thin history. Re-read about one month on (around 9 Nov 2026), tracked as an open loop.

**Implementation gate**

- This note is design plus lane link only.
- The Logstream table, writer and trigger are not built until these thresholds are in the engine contract (this section and CLAUDE.md are that contract) and the empty-read decision is made (made above: left out).
- Building them still needs Jason's go-ahead.


## 11. What was built (10 Oct 2026)

Jason gave the go-ahead on 9 Oct: table, writer and trigger against the locked thresholds, with no autopay, no pay wiring and no destructive automated action.

- **Table.** `engine_logstream`, append-only, one row per state an incident reaches: observed, closed, research opened. The fields are section 5's. `person_confirmed` and `autopay_enabled` are false on every row and nothing sets or reads them.
- **Writer.** Reads the incidents the dashboard already holds. No workflow was changed.
- **Trigger.** Section 10's numbers, every five minutes, over the last 7 days. 3 of the same fault opens one Research Twin job. 5 posts one alert in the engine alerts channel. The workflow rate rule opens one job. 5 or more workflows crossing is one outage alert and no per-workflow research.
- **Left out of counting:** workflows named TEST, anything simulated, and the step "Raise Refused Ask".

Not built, and still to decide: a page, North Star's guidance step (step 6 of section 4), a person's review of a row, and which build pattern applied to an incident (`pattern_ids_applied` is empty, because nothing in the engine records that).
