# vFarm customer events: lead, buyer, subscriber, upgrade

**For:** Hardik (the Early Access tracker and anything that takes a reservation), Jegan (config identity: `config_hash`, `cad_revision`), Kaiqi (Slack Genie), and the twins. **From:** Destiny, 11 Oct 2026. **Why:** Jason's ask of 13 Sep (LOOP-1789326230248-ZX0W): define the exact event tags and shapes for lead, buyer, subscriber and upgrade events with `vfarm_flagship_1031` attribution, and one query path every twin uses to answer who vFarm's subscribers are, what they last received and what state, lane and spec they are in.

**Contract:** `vfarm.customer.events.v0`. It is a v0: the state names below are Destiny's proposal and are Jason's to change.

## The shape

Each one is an ordinary `engine.event.v1` event, posted to the same place as every other engine event:

```
POST https://dashboard.bhanetwork.org/api/engine/events
x-dashboard-key: <DASHBOARD_INBOUND_KEY>

{ "event_type": "...", "subject_id": "...", "at": "2026-10-11T09:00:00Z", "lane": "CAPITAL",
  "actor": "who or what did it", "source_ref": "a link", "detail": { ... }, "dedupe_key": "one string per real event" }
```

`subject_id` must equal the id inside `detail` (`buyer_intake_id` for lead and buyer events, `subscriber_id` for the rest), so every event about one person is found under one id. Send a `dedupe_key`: n8n retries a failed HTTP node.

## The five event types

| `event_type` | Means | `detail` must carry | `detail` may carry |
|---|---|---|---|
| `VFARM_LEAD_CAPTURED` | A person expressed interest. Interest only. | `buyer_intake_id`, `source_campaign`, `source_surface` | `early_access_lead_id`, `correlation_id`, `lead_row_id` |
| `VFARM_BUYER_STATE_CHANGED` | A lead moved along the buyer path. | `buyer_intake_id`, `new_state`, `source_campaign` | `old_state`, `reason`, `changed_by`, `commercial_lane` |
| `VFARM_SUBSCRIBER_STATE_CHANGED` | A subscription was created or changed state. | `subscriber_id`, `new_state`, `subscription_lane`; and `config_hash`, `cad_revision` when `new_state` is `active` | `old_state`, `buyer_intake_id`, `source_campaign`, `farm_id`, `cabinet_id`, `reason`, `changed_by` |
| `VFARM_SUBSCRIBER_DELIVERY` | Something was delivered to a subscriber. | `subscriber_id`, `delivered`, `channel` | `delivery_ref`, `farm_id`, `cabinet_id`, `config_hash` |
| `VFARM_SUBSCRIBER_UPGRADED` | The subscriber's farm levelled up to a new spec. | `subscriber_id`, `from_config_hash`, `to_config_hash`, `cad_revision` | `from_cad_revision`, `farm_id`, `cabinet_id`, `reason`, `changed_by` |

Buyer states: `intake_submitted`, `qualified`, `reserved`, `declined`. Subscriber states: `pending`, `active`, `paused`, `cancelled`.

## What is enforced

Any event whose type starts `VFARM_LEAD_`, `VFARM_BUYER_` or `VFARM_SUBSCRIBER_` is refused with `422` unless it is one of the five and carries its fields. The refusal names the missing field or the bad value, and nothing is written. The vFarm gate events (`VFARM_STAGE1_STATE_CHANGED` and the rest) are a different family and are not touched.

## Attribution

`source_campaign` is required on lead and buyer events. The flagship campaign is `vfarm_flagship_1031`. A subscriber event may leave it out: the catalog takes it from the subscriber's lead through `buyer_intake_id`. A lead that named no campaign is recorded as `not_attributed`, in words, so an empty value can never read as the flagship's.

## `config_hash` and `cad_revision`

These are corpus fields from the config identity spine. `config_hash` says which spec a subscriber's hardware is on; `cad_revision` says which CAD revision produced it. They are stored as sent and never derived. They are required when a subscriber becomes `active` and on every upgrade.

## The one query path

Every agent already holds `read_engine_events`. Call it with `catalog: "vfarm_customers"`:

- leads: total, by campaign, by surface;
- buyers: total, by current state;
- subscribers: one row each, with `state`, `since`, `subscription_lane`, `source_campaign`, `farm_id`, `cabinet_id`, `config_hash`, `cad_revision`, `levelled_up_at`, `upgrades`, `newer_config_available` and `last_received`.

Narrow with `subscriber_id` or `campaign`. The raw events are the same tool without `catalog`, filtered by `event_type` or `subject_id`. No name or email is returned: those stay on the lead's own row, behind the vFarm page.

It answers Jason's four questions: what spec is this subscriber on (`config_hash`, `cad_revision`), when did this farm level up (`levelled_up_at`), what CAD revision produced their hardware (`cad_revision`), and is there a newer `config_hash` available (`newer_config_available`).

## Who writes what today

- `VFARM_LEAD_CAPTURED`: the dashboard, the moment a Form A lead is stored. Leads held before 11 Oct were given their event at the next boot.
- The other four: nobody yet. No buyer state, subscription or delivery exists in any system. When Hardik's checkout and Jegan's config identity are live, they post these.

## These are facts, never commitments

A lead is an expression of interest. Nothing here is a reservation, a payment or a delivery promise, and B93H claim 4.3 still governs what may be said about any of it.
