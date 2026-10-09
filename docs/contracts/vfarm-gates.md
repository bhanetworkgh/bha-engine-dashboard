# vFarm stage gates and the 5-rack pilot offer

Loop LOOP-1791479575963-7S0O (Destiny). The three objects are Jason's v1
contracts, locked on 8 Oct 2026 in Codex Architect Answer
`6120a262-8609-40ae-9a8f-eec180f8cf46`. This file says how the dashboard holds
them. It does not change them.

## The three records

One table, `engine_vfarm_gates`. Every field keeps the contract's own name.

| kind | contract | id looks like | statuses |
|---|---|---|---|
| `stage1` | `VFARM_STAGE1_LAB_VALIDATION_v1` | `VFS1-<ms>-<4>` | planned, in_progress, passed, failed |
| `stage2` | `VFARM_STAGE2_PILOT_CHECKLIST_v1` | `VFS2-<ms>-<4>` | planned, in_progress, passed, failed |
| `offer` | `VFARM_5RACK_PILOT_OFFER_v1` | `VFOF-<ms>-<4>` | draft, under_review, final, offered, signed |

**stage1 fields:** loop_ref, target_cabinet_config_hash, cad_revision,
substrate_config, lighting_config, irrigation_config, climate_band,
canopy_climate_check, root_zone_moisture_check, airflow_velocity_check,
early_disease_detection_check, evidence_links, status, owner_slack_id,
target_date.

**stage2 fields:** loop_ref, stage1_ref, pilot_site_profile_id, rack_count,
cabinet_config_hashes, crop_profile, maintenance_time_budget_min_per_week,
alert_volume_budget_per_week, yield_target_per_rack_per_cycle,
uptime_target_pct, uptime_window, failure_modes_covered, status,
pass_fail_rationale, owner_slack_id, target_date.

**offer fields:** loop_ref, stage2_ref, target_customer_profile, rack_count,
upfront_price_band_min, upfront_price_band_max,
subscription_price_per_rack_min, subscription_price_per_rack_max,
final_upfront_price, final_subscription_price_per_rack, term_length_months,
grandfathering_rules, underperformance_clause, included_support_scope,
exit_conditions, status, owner_slack_id, target_date.

A field name the contract does not have is refused (`unknown_field`).

## What was added to the locked lists, and why

Each of these came from Jason in the thread after the lock, or is something the
contract left unsaid. None renames or removes a contract field.

- `crop_profile` and `growth_stage` on stage1, `growth_stage` on stage2: Jason,
  8 Oct ("explicit crop + growth-stage tags, e.g. tomato_veg, tomato_flower,
  tomato_fruit"). Lower-case tags; carried on every event.
- `source` (`manual` or `sensor`) and `value` on a check: Jason, 8 Oct
  ("whether it was manual vs sensor", "current value/outcome").
- `notes` on a check: the Architect Answer words the check as
  `{status, notes/thresholds, checked_by, checked_at, evidence_ref}`.
- A check's status values, `pending`, `passed`, `failed`: the contract names the
  field and not its values. **Open for Jason to confirm or rename.**
- `uptime_window`: the contract says "`uptime_target_pct` + window".
- `linked_lead_ids` on an offer: the Early Access tie (below).

## The two hard gates

Enforced in `server/src/vfarmGates.ts`, in `writeGate`, the one function every
writer goes through (the MCP tool, the engine route, the tests). A refusal
writes nothing, sends no event and posts no alert.

1. A Stage 2 row needs `stage1_ref` to a Stage 1 row (`stage1_required`), and
   can only be `planned` until that Stage 1 row is `passed`
   (`stage1_not_passed`). `stage1_ref` does not change afterwards.
2. An offer cannot be `offered` or `signed` without `stage2_ref` to a Stage 2
   row (`stage2_required`). `stage2_ref` is set once.

Not enforced, because the contract does not say it: that Stage 1 can only be
`passed` when all four checks are `passed`. That is Jason's call.

## The four checks

`{status, thresholds, notes, value, source, checked_by, checked_at, evidence_ref}`.
A verdict (`passed` or `failed`) always carries who and when; if the writer
does not say, it is the person making the change and the time of the change.

**Three are recorded by a person for now:** `root_zone_moisture_check`,
`airflow_velocity_check`, `early_disease_detection_check`. `source: "sensor"`
is refused on them (`no_sensor_yet`). Nothing on the page, in a tool
description or in an alert calls them automated detection, and no front-door or
offer copy may either. When a sensor lands, its check name is added to
`SENSOR_BACKED` in `vfarmGates.ts` and it feeds the same field.

## Events

Written to `engine_events` (`engine.event.v1`) in the same transaction as the
change, so a row and its event land together or not at all. Append-only, so
the history can be replayed.

| event_type | when | detail carries |
|---|---|---|
| `VFARM_STAGE1_STATE_CHANGED` | Stage 1 created or its status changed | object_id, loop_ref, old_status, new_status, changed_by, changed_at, crop_profile, growth_stage, target_cabinet_config_hash, cad_revision, `checks` (each check's status, source, who, when, evidence_ref) |
| `VFARM_STAGE2_STATE_CHANGED` | Stage 2 created or its status changed | as above plus stage1_ref, stage1_status, pilot_site_profile_id, rack_count, cabinet_config_hashes, `checks_ref` and `checks` (the Stage 1 checks behind it) |
| `VFARM_CHECK_UPDATED` | any change to one check | check, outcome, value, thresholds, source, checked_by, checked_at, evidence_ref, notes, crop_profile, growth_stage |
| `VFARM_OFFER_STATE_CHANGED` | offer created or its status changed | stage2_ref and `stage2` (its id, status, stage1_ref, site, racks, crop, growth stage), rack_count, linked_lead_ids |
| `VFARM_GATE_ALERT_FAILED` | a Slack alert did not go out | about, channel, error, text |

Every event has `subject_id` = the record id, `lane` = `VFARM_HARDWARE`,
`actor` = who made the change, and `detail.fixture`.

## Slack alerts

After the commit, posted as Bays to `VFARM_GATE_ALERT_CHANNEL`, or to
`QUOTA_ALERT_CHANNEL` when that is not set: one post for a status change, one
for a check that became `failed`. A post Slack refuses is not silent: the
write's answer carries `raise: true`, the reason is in `alerts`, and a
`VFARM_GATE_ALERT_FAILED` event is kept.

## Early Access

The person signing up sees nothing about gates, offers or prices. Internally, a
lead that is clearly a 5-rack or pilot enquiry is tied to an offer by putting
its id (or its buyer_intake_id) in the offer's `linked_lead_ids`. The offer
then lists the lead on the Gates tab and the lead's panel on the Early Access
tab names the offer. Nothing ties a lead automatically, and no offer is created
for a home or single-rack sign-up: Form A has no question that says "5 racks",
so a person or Bays decides.

## Writing and reading

- MCP: `get_vfarm_gates` (read), `write_vfarm_gate` (write),
  `delete_vfarm_gate_fixtures` (write, not in any agent's scope).
- Engine key: `GET` and `POST /api/engine/vfarm-gates`
  `{ kind, object_id?, fields, by, fixture?, dry_run? }`. A refusal is a 409.
- Page: `/vfarm?tab=gates`, read-only.

## Fixtures and the repeatable test

`fixture: true` on create marks a test record: its id starts `FIXTURE-`, it is
labelled on the page, in alerts and in events, a real record cannot point at
one, and `delete_vfarm_gate_fixtures` removes fixtures and nothing else. Their
events stay, with `detail.fixture: true`; filter on that for analytics.

`npm run test:vfarm-gates` (local database only) is the repeatable procedure:
14 steps covering both hard gates, the failed-check alert, the manual-only
checks, the lead tie, a refused Slack post and the clean-up.
