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
| `last_reading_at` | `devices.last_reading_at`. **This is what the dashboard uses to decide "reporting"** (a reading in the last 15 minutes), because nothing keeps `devices.status` up to date. Please make sure it is right. |
| `open_alerts[]` | `alerts.alert_state` where `cleared_at IS NULL`, joined for names. `id` is the alert_state id. |
| `alert_pipeline` | The same object `GET /api/v1/alerts/threshold/health` returns. |

Rules:

- **List every farm the snapshot covers, with all of its devices and all of its open alerts.** The dashboard reads absence *within the farms you list*: a device you stop listing is marked gone, and an open alert you stop listing is marked cleared. A farm you leave out is left exactly as it was, so a partial snapshot never empties a farm.
- An older snapshot than the newest held is refused with `409`, so a late retry cannot roll the page back.
- Every device's `farm_id` must be one of the listed farms; otherwise the snapshot is refused with `422`, naming the device.

Answers: `201` with `{ ok, taken_at, farms, devices, open_alerts, devices_gone, alerts_closed, dry_run }`, or `422` naming the problem.

---

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
