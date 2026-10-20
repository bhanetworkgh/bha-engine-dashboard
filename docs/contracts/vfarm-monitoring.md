# vFarm monitoring contract: when a rack counts as monitored

**Status:** v1, 20 Oct 2026. Written by Destiny for Jason's ask in #bha-codex-logs
(C0AFPJ5S1C1, 1792503936.931709): "Document the exact ENV, snapshot/alert contracts, and the
'this rack is monitored' criteria that P1.0 and Pilot House will use."
**Rule it serves:** SOP 1a4518a5, no kiosk, phone app or Media Twin view goes to a buyer until
this is locked and the rack meets it.
**Payload detail:** `docs/contracts/vfarm.md` holds the full field lists. This file is the
part that decides whether a rack is monitored.

Every number below comes from code that is running now (`server/src/monitoringTwin.ts`,
`server/src/un9d.ts`, `vfarm/backend/workers/engine_snapshot.py`,
`vfarm/backend/api/app/alerts_pipeline/engine_copy.py`). A line marked **PROPOSED** is new
and is Jason's to accept or change.

## 1. The exact ENV

On the vFarm side, in AWS Secrets Manager `vfarm/app/env`. The deploy workflow writes it to
`.env`, and `docker-compose.deploy.yml` hands that file to the `engine-snapshot` service and
the API:

| Variable | Value | If unset |
|---|---|---|
| `ENGINE_DASHBOARD_URL` | `https://dashboard.bhanetwork.org` | The snapshot job builds and never posts. The alert copy is off, and the API logs that once at INFO. |
| `ENGINE_DASHBOARD_KEY` | the dashboard's `DASHBOARD_INBOUND_KEY`, sent as `x-dashboard-key` | Same as above. A wrong key gets a 401, logged as ERROR by the snapshot job and as WARNING by the alert copy. |
| `DATABASE_URL` | vFarm's own Postgres | The snapshot job cannot start. |
| `REDIS_URL` | optional | The alert pipeline's health is not read. |
| `ENGINE_SNAPSHOT_FARMS` | optional, comma-separated farm uuids or codes | Every active farm is sent. |
| `ENGINE_SNAPSHOT_TIMEOUT_S` | optional, default 15 | |

On the dashboard side there is only `DASHBOARD_INBOUND_KEY`. It is already set on Render.

**As of 20 Oct 2026 the two `ENGINE_DASHBOARD_*` values are not in `vfarm/app/env`, so no
rack is monitored yet.** Jegan is adding them.

## 2. The two pushes

Both go to `https://dashboard.bhanetwork.org` with `x-dashboard-key` and
`content-type: application/json`. Either one accepts `"dry_run": true`, which checks and
writes the push, then rolls it back.

- **Snapshot.** `POST /api/engine/vfarm-snapshot`, schema `vfarm.snapshot.v1`, every 3
  minutes from the `engine-snapshot` container. It carries every active farm whole: all of its
  devices (placed or not), every open alert, and the alert pipeline's health. A farm is sent
  whole or not at all, because the dashboard reads absence only inside the farms a snapshot
  lists. A snapshot older than the newest one held gets a 409. A device whose `farm_id` is not
  listed gets a 422.
- **Alerts.** `POST /api/engine/vfarm-alerts`, the `vfarm.alert.v1` envelope exactly as
  `alerts_pipeline/envelope.py` builds it, for a single fire, a digest or a clear. This is an
  extra copy sent beside the rule's own Slack delivery: one post, a 5-second timeout, no retry,
  never awaited, and it can never fail or delay the real alert. Each frame is keyed on
  `devices[].event_id`, so a frame sent twice updates one row.
- **Identity fields:** `cabinet_id`, `config_hash` and `burn_in_state` (`not_started`,
  `burn_in` or `passed`) can be sent on a farm or a device. A device that sends none takes its
  farm's values. They are optional on the wire. Section 4 makes them required for buyer
  exposure.

## 3. Freshness: how the dashboard reads a device

| State | Rule |
|---|---|
| Online / offline | vFarm's stored `devices.status`. Ingest, heartbeat and MQTT presence set `online`, and vFarm's own backstop sets `offline` after 180 s. |
| LIVE | A device that reads has a reading at most **90 s** old when vFarm last looked. |
| STALE | Older than 90 s, at most **900 s**. A stale reading is never shown as live. |
| OFFLINE | vFarm reports it offline, or it has had no reading for over **900 s**. This opens an `INC-VFARM.SENSOR` incident. |
| Cameras | They never stamp `last_reading_at`, so they are judged on `status` and `last_seen_at` alone. |
| Feed silent | No snapshot for the farm in **600 s** (the job runs every 180 s). The farm reads unknown and a `FEED_SILENT` incident opens. |

## 4. "This rack is monitored"

A rack is monitored only when **every** line below holds. The dashboard answers each one, so
nobody has to judge it by eye. `check_un9d_acceptance` on the rack's farm returns each
condition as `pass`, `fail` or `not_yet_possible`.

1. **It is real.** The farm is not simulated: no `synthetic`, and it is not a simulator farm
   held here. A simulated farm is always NOT_SAFE_TO_CLAIM.
2. **The feed is live.** The dashboard holds a stored real snapshot for the farm, and the
   newest one is at most 600 s old.
3. **Test 1, the canonical sensor-state read, passes.** That means:
   - every device has an id and a farm
   - every device carries when it last reported
   - the dashboard knows when it received the state
   - the data says whether it is real evidence
   - stale data is never shown as live
   - the Monitoring Twin's read agrees with the stored feed
4. **Test 2, silent device to incident and back, passes on this farm.** A device that went
   silent opened an incident with one ledger id. It recovered with no two incidents open at
   once for one device and no ledger id reused. Engine health holds the incident once, open or
   closed as the twin says.
5. **Every enrolled device is accounted for.** Each placed device is LIVE, or it is OFFLINE
   with its incident open. No placed device is STALE for more than 900 s without an incident.
6. **Alerts reach the dashboard.** At least one `vfarm.alert.v1` frame from this farm has
   landed on `/api/engine/vfarm-alerts`. A real fire, or the clear that follows one, both
   count. **PROPOSED:** this is not checked by `check_un9d_acceptance` today.
7. **It knows which cabinet and which spec it is.** `cabinet_id` and `config_hash` are sent,
   and `burn_in_state` is `passed`. **PROPOSED:** these are optional on the wire today and
   become required before a buyer sees the rack.

**P1.0** is one rack and must meet all seven. **Pilot House** is judged one rack at a time:
each of the five racks is its own farm or cabinet, and the house is monitored only when every
rack is. One silent rack is never averaged away by four healthy ones.

The criteria change only with a new Architect Answer from Jason, then an edit here, then a
BUILD_LOG line, and the evidence rules (`server/src/evidenceRules.ts`) still apply.
Coimbatore data is an agronomy reference and never cabinet proof. Uptime comes from the twin's
own incidents and nothing else.

## 5. How to prove it on a rack

1. Set the two `ENGINE_DASHBOARD_*` values in `vfarm/app/env` and redeploy `engine-snapshot`.
2. Run `python backend/workers/engine_snapshot.py --check`. This sends the snapshot as a dry
   run, which is stored and then rolled back, and the answer is a 201.
3. Watch for the first real snapshot. Bays DMs Destiny once (`vfarm_first_real_data`), and the
   farm appears on `/vfarm` and in `read_monitoring_twin`.
4. Unplug one sensor for over 15 minutes, then plug it back. That is Test 2.
5. Run `check_un9d_acceptance` on the farm. Every condition must read `pass`.
