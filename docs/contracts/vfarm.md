# vFarm → BHA Engine Dashboard: state snapshots and alert fires

**For:** Jegan and Kavin (vFarm). **From:** Destiny, 29 Sep 2026. **Status:** the dashboard side is live; this is the vFarm side.

## Why

vFarm has rich data and its own dashboards, but nothing reaches BHA's engine dashboard today. The **vFarm** page there (dashboard.bhanetwork.org/vfarm) now has three tabs waiting for it:

- **Overview**: farms and their health, how many devices are reporting and how many have gone quiet, open alerts, and whether vFarm's alert worker is healthy.
- **Devices**: every device, where it sits, when it last reported, and its latest readings.
- **Alerts**: open alerts, then a live feed of fires and clears.

vFarm **pushes** these; the dashboard never polls vFarm and never holds a vFarm key. That is deliberate: the only all-farms key vFarm has (`FARM_API_KEY`) can also write.

Two pushes, both to the same host, with the same header:

```
https://dashboard.bhanetwork.org/api/engine/...
x-dashboard-key: <DASHBOARD_INBOUND_KEY>        (Destiny sends it privately)
content-type: application/json
```

Suggested vFarm env vars: `ENGINE_DASHBOARD_URL` and `ENGINE_DASHBOARD_KEY`. Unset means "do not post".

---

## 1. The snapshot: every 3 minutes (new job)

`POST /api/engine/vfarm-snapshot`

This is a fourth ledger-style worker beside `bharag_ledger`, `alert_ledger` and `vision_ledger`, on its own cron slot (for example `minute=*/3, second=15`), reading the tables the API already reads. It needs **no API call**: read Postgres directly, the way the ledger workers do.

```json
{
  "schema": "vfarm.snapshot.v1",
  "taken_at": "2026-09-29T13:03:15Z",
  "farms": [
    { "id": "8f0c…uuid", "code": "cre-host-01", "name": "CRE Host — Floor 3", "status": "healthy",
      "device_count": 6, "online_count": 5, "offline_count": 1, "unhealthy_count": 0 }
  ],
  "devices": [
    { "id": "esp32_node_01", "farm_id": "8f0c…uuid", "place": "Zone A / Rack 1 / Tray 3",
      "device_type": "temp_humidity_sensor", "model": "dht22", "status": "online", "health_score": 97,
      "last_seen_at": "2026-09-29T13:02:58Z", "last_reading_at": "2026-09-29T13:02:58Z",
      "firmware_version": "1.4.2",
      "latest": { "temperature": { "value": 24.1, "unit": "°C", "status": "ok" }, "humidity": { "value": 61, "unit": "%" } } }
  ],
  "open_alerts": [
    { "id": "4411", "rule_id": "…", "device_id": "ph_probe_02", "farm_id": "8f0c…uuid", "farm_name": "CRE Host — Floor 3",
      "place": "Zone A / Reservoir", "severity": "warning", "title": "pH above 6.8", "detail": "pH 7.1 for 10 min",
      "last_value": 7.1, "opened_at": "2026-09-29T12:40:00Z" }
  ],
  "alert_pipeline": { "status": "ok", "lag": 0, "last_processed_at": "2026-09-29T13:03:10Z", "last_processed_age_s": 5 }
}
```

Where each field comes from:

| Field | Source in vFarm |
|---|---|
| `farms[]` | `farms` plus the same counts `GET /api/v1/farms/{id}/health` computes. `status` is that route's `healthy` / `warning` / `critical` / `neutral`. |
| `devices[]` | `devices`, **placed or not**. `place` is the breadcrumb (zone / location / sub-location names). `latest` is the latest `sensor_readings.values` for that device. |
| `status` | `devices.status`, as stored (`online`, `offline`, `unknown`). **From 20 Oct 2026 this is what the dashboard uses for online and offline**: vFarm keeps it current (ingest, heartbeat and MQTT presence set `online`; the API's presence backstop sets `offline` after 180 s). |
| `last_reading_at` | `devices.last_reading_at`, written only by the sensor ingest path, so a camera has none. A device that reads still goes stale after 90 s and offline after 15 minutes without a reading, whatever its status; a device that never reads (a camera) is judged on `status` and `last_seen_at` alone. |
| `open_alerts[]` | `alerts.alert_state` where `cleared_at IS NULL`, joined for names. `id` is the alert_state id. |
| `alert_pipeline` | The same object `GET /api/v1/alerts/threshold/health` returns. |

### Three optional identity fields (11 Oct 2026, LOOP-1789426955094-3FP4)

Jason asked that the twin envelope carry the cabinet, its config and its burn-in state, so Monitoring Twin, Slack Genie, North Star and Research Twin can say which cabinet and which spec they are talking about. The dashboard now reads three optional fields. Send them on a farm, on a device, or both; a device without its own takes its farm's.

| Field | On | Value |
|---|---|---|
| `cabinet_id` | `farms[]`, `devices[]` | the cabinet's own id, as vFarm names it |
| `config_hash` | `farms[]`, `devices[]` | the config identity hash from the config identity spine |
| `burn_in_state` | `farms[]`, `devices[]` | exactly `not_started`, `burn_in` or `passed`. Anything else is refused with `422` naming the field |

All three are optional. Until they are sent the twin reads `null` and says "not sent by vFarm yet"; nothing is guessed. Worker health needs nothing new: it is read from `alert_pipeline.status` (`ok` is healthy, anything else unhealthy).

Rules:

- **List every farm the snapshot covers, with all of its devices and all of its open alerts.** The dashboard reads absence *within the farms you list*: a device you stop listing is marked gone, and an open alert you stop listing is marked cleared. A farm you leave out keeps its rows exactly as they were, so a partial snapshot never empties a farm; from 24 Oct 2026 a real farm a real snapshot leaves out is marked **not listed** (`listed: false` on the twin's read): nothing about it is judged, its devices read GONE, and its open incidents close as "vFarm stopped listing this farm", never as a recovery and never as a silent feed. A device you stop listing closes its incidents the same way. Listing the farm again lists it again.
- An older snapshot than the newest held is refused with `409`, so a late retry cannot roll the page back.
- Every device's `farm_id` must be one of the listed farms; otherwise the snapshot is refused with `422`, naming the device.

Answers: `201` with `{ ok, taken_at, farms, devices, open_alerts, devices_gone, alerts_closed, farms_unlisted, dry_run }`, or `422` naming the problem.

---

### Everything else vFarm records: `history`, `layout`, `rover_config` (24 Oct 2026, D5)

Optional, additive to `vfarm.snapshot.v1`, and only for the farms the snapshot lists. Until 24 Oct the
snapshot carried current state only, so rover runs, frames, drain and relay events, commands, device
events and alert history never reached the dashboard, and it kept about one reading in sixty.

```json
"history": {
  "until": "<taken_at>",
  "sections": {
    "<section>": { "since": "<ISO>", "next_since": "<ISO>", "truncated": false, "rows": [ { "...vFarm's row as stored...": "", "farm_id": "<uuid>", "device_id": "<id or null>", "at": "<ISO>" } ] }
  },
  "errors": { "<section>": "<why it could not be read this tick>" }
},
"layout": { "zones": [ ... ], "locations": [ ... ], "sublocations": [ ... ] },
"rover_config": { "schedules": [ ... ], "settings": [ ... ], "rail_map": [ ... ] }
```

- **Sections and their key** (the dashboard keeps one row per section and key, so a re-sent window
  changes nothing and a changed row is updated): `readings` (rows `{device_id, farm_id, reading_ts, values}`,
  stored one row per metric and reading time in `engine_vfarm_readings`), `rover_runs` (`run_id`),
  `rover_stops` (`run_id` + `seq`), `rover_detections` (`id`), `rover_videos` (`id`, else `run_id`),
  `vision_frames` (`frame_id`), `automation_events` (`id`), `device_commands` (`id`), `device_events`
  (`id`), `alert_changes` (`id`), `alert_firings` (`id`). Any other lower-case section name is accepted
  and keyed on `id` (else `key`), so vFarm can add one (a `drain_cycles` section, say) without a change here.
- **`layout` and `rover_config` are sent whole every tick.** An item of a listed farm that stops being sent
  is marked gone, never deleted, as a device is.
- **Every row carries `farm_id`.** A row naming a farm the snapshot does not list, or with no key, is
  refused and counted on the snapshot's record, never stored against the wrong farm.
- **Nothing is dropped quietly.** `truncated: true` on a section means vFarm hit its cap and continues
  from `next_since` on the next tick; `errors` names a section vFarm could not read. Both are stored on
  the snapshot row (`engine_vfarm_snapshots.history`) and shown on the Monitoring Twin.
- At most 10,000 rows per section; the whole body at most 4 MB.
- Reads: the Monitoring Twin's `feed_history` (rows per section, last 24 h, newest) and `rover` (the six
  rover signals: heartbeat age, runs against the schedule, run time against its budget, limit hits, stops
  with no frame, the upload backlog; readings only, no thresholds set), and the MCP tool `read_vfarm_history`
  for the rows themselves.

### Rover passes (28 Oct 2026, D3 — Kavin's rover log of 26 Oct)

vFarm sends each pass as `history.sections.rover_passes`, one row per pass keyed on `id`, in the shape
`rover_pass.summarize` builds: `status` (`complete` / `failed`), `started_at`, `ended_at`, `stops_planned`,
`stops_done`, `distance_mm`, `images_taken`, `images_sent`, `images_not_sent` (a list), `failed_stops`
(`[{seq, reason}]`, reason `snapshot_failed`, `move_failed`, `pass_aborted` or `no_movement`), `position_mm`,
`position_known`, `returned_home`, `needs_manual_check`, `edge_version`. Nothing new to send: these have
arrived since 24 Oct. From 28 Oct the Monitoring Twin lists the passes of the last 8 days, and when vFarm
sends passes and no `rover_runs`, the rover tiles count runs, run time, stops with no photo
(`snapshot_failed`) and photos not sent from the passes, and say so.

### Ledger writes (28 Oct 2026, D3 — new, optional)

BHARAG can answer 201 and write nothing, and vFarm's ledger lanes only log that to New Relic. Each
snapshot may carry what each lane really managed since the previous one:

```json
"ledger_writes": {
  "lanes": [
    { "lane": "bharag_ledger", "farm_id": "<uuid>", "corpus": "vfarm.sensor",
      "sent": 8, "written": 0, "refused": 8,
      "reasons": [ { "code": "entry_not_written", "count": 8 } ],
      "window_from": "<ISO>", "window_to": "<ISO>", "last_pass_at": "<ISO>" }
  ]
}
```

- **One row per lane and farm**, for every lane that ran, a clean one included (`refused: 0`). An empty
  list means no lane ran. `lane` is lower case (`bharag_ledger`, `alert_ledger`, `rover_ledger`, …).
- `sent`, `written` and `refused` are whole numbers and `written + refused` is at most `sent`. `corpus`,
  `reasons` (at most 20), `window_from`, `window_to` and `last_pass_at` are optional.
- A row naming a farm the snapshot does not list, a second row for one lane and farm, or impossible
  counts is refused and counted on the snapshot's record; the rest of the snapshot still lands. A block
  that is not `{lanes: [...]}` refuses the snapshot (422), at most 500 rows (413).
- **Any `refused` above nought opens one critical incident** for that lane and farm (class
  `LEDGER_WRITE_REFUSED`, subsystem `LEDGER`, on the BHARAG ledger and on Engine health), shown on the
  Monitoring Twin and the vFarm page. It closes when a later report shows that lane at `refused: 0`. A lane
  that stops reporting keeps its incident open and says it has not reported since. A simulated report
  never judges a real farm.

## 2. Alert fires: live, the envelope you already build

`POST /api/engine/vfarm-alerts`

The body is **exactly the `vfarm.alert.v1` envelope** `alerts_pipeline/envelope.py` already builds (single or digest). Nothing new to design.

**One code change is needed.** A rule has one destination (`resolve_destination` in `webhook.py`: its channel, or its own `webhook_url`). So pointing a rule at the dashboard would take its Slack delivery away. Instead, add an **extra post** in `fire_webhook` (and the digest path) to `ENGINE_DASHBOARD_URL + /api/engine/vfarm-alerts`, with the `x-dashboard-key` header:

- sent after the rule's own delivery, whatever that delivery returned;
- in the background, with a 5 s timeout;
- never able to fail or delay the real alert;
- recorded in `alerts.alert_ingests` with `target = 'engine-dashboard'` if you want the receipt.

The upsert key is each `devices[].event_id` (the `alerts.alert_events.id`), so a retry updates one row.

Answers: `201` with `{ ok, received, inserted, updated, event_ids, dry_run }`, or `422` naming the problem.

---

## Test without leaving a row

Add `"dry_run": true` to either body. Everything is checked and written, then rolled back.

```bash
curl -sS -X POST https://dashboard.bhanetwork.org/api/engine/vfarm-snapshot \
  -H "x-dashboard-key: $ENGINE_DASHBOARD_KEY" -H 'content-type: application/json' \
  -d '{"dry_run":true,"schema":"vfarm.snapshot.v1","taken_at":"2026-09-29T13:00:00Z","farms":[{"id":"f1","name":"Test farm","status":"healthy"}],"devices":[{"id":"d1","farm_id":"f1","last_reading_at":"2026-09-29T12:59:00Z","latest":{"temperature":{"value":24.1,"unit":"°C"}}}],"open_alerts":[]}'
```

## When it works

Within a second of the first snapshot, the vFarm **Overview** fills in and the tab counts appear. The "State as of …" line turns amber if no snapshot arrives for ten minutes, so a stopped job is visible straight away.

## Not in scope yet

Vision frames (the vision worker is not deployed), device commands, and automation. We add them when they are live.
