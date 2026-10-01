# Monitoring Twin: what it judges, and how to read it

**For:** North Star, Genie, the kiosk and app (Kavin), Hardik (0X16 / MDN4), Jegan. **From:** Destiny, 1 Oct 2026. **Why:** Jason's tomato-first memo (#bha-coordination, 1 Oct): validate the twins on synthetic sensor scenarios before any seedling goes in, version the agronomy profiles, and make every interface show the same truth the twin sees.

## Where it sits

```
vFarm rack → vFarm software (Jegan) → POST /api/engine/vfarm-snapshot every 3 min
                                        ↓
                         Monitoring Twin (this dashboard) judges every snapshot, and once a minute
                                        ↓
     Monitoring Twin page · GET /api/engine/monitoring-twin · MCP read_monitoring_twin
```

Nothing new is asked of vFarm: the twin reads the snapshot vFarm already sends (`docs/contracts/vfarm.md`).

## What it decides

| State | Meaning |
|---|---|
| `LIVE` | a reading at most 90 s old when vFarm last looked |
| `STALE` | older than 90 s, at most 900 s |
| `OFFLINE` | no reading for over 900 s. Opens `INC-VFARM.SENSOR-…` |
| `NOT_WIRED` | listed by vFarm, never sent a reading |
| `NO_FEED` | the farm's snapshots stopped over 600 s ago, so nothing is judged. A real farm opens `INC-VFARM.FEED-…` |
| `GONE` | vFarm no longer lists the device |

The 90 s and 900 s lines are Jason's (IMFX, 1 Oct). Age is measured at the snapshot, not now, because a snapshot arrives every three minutes.

Readings from `LIVE` and `STALE` devices are checked against the **crop profile** for the stage the farm's cycle is in now. A reading outside its stage's range opens `INC-VFARM.ENVIRONMENT-…`. One incident per fault; it closes itself when the fault clears.

**Uptime** is Jason's definition: the share of observed time with no device `OFFLINE`, over the last 24 h (or since the twin started watching the farm), with time when the feed was silent left out.

## Crop profiles are versioned

`POST /api/engine/monitoring-profile` (same `x-dashboard-key`):

```json
{ "profile_id": "tomato-dwarf-determinate", "version": 2, "previous_version": 1, "crop": "tomato",
  "reason": "Flowering RH tightened after the first burn-in week", "changed_by": "Jegan",
  "stages": [ { "stage": "vegetative", "label": "Vegetative", "from_day": 0, "to_day": 27,
                "targets": { "temperature": { "min": 18.5, "max": 29.5, "unit": "°C", "source": "…" } } } ] }
```

A version is never edited: the same version with different content is a 409, and the next version must name the previous one and say why. Every version stays readable on the page.

`POST /api/engine/monitoring-cycle` says which profile a farm runs and when day 0 was: `{ farm_id, profile_id, profile_version?, transplanted_at, time_scale?, synthetic? }`. A real farm runs at `time_scale` 1. Only a simulated farm may run a fast clock.

## Simulated farms

A snapshot whose farms carry `"synthetic": true` goes through the same route and the same judgement as the real rack. It is labelled on the Monitoring Twin page, hidden from the vFarm page, ordered separately from real snapshots (it can never make a real one look out of date), and never raises a FEED incident. The n8n workflow `Engine — Monitoring Twin Simulator` sends it, one scenario at a time.

## Reading it

- `GET https://dashboard.bhanetwork.org/api/engine/monitoring-twin` with `x-dashboard-key` → `monitoring.twin.v1`
- MCP: `read_monitoring_twin` (optional `farm_id`)
- `POST /api/engine/monitoring-twin/evaluate` runs a judgement now.

## Not yet

- Incidents are held on the dashboard; they are not yet written to the BHARAG incident ledger.
- The launch gates (uptime X%, incident envelope Y, yield N) are Jegan's to propose from the first real snapshots (IMFX). Nothing is gated on them yet.
- North Star and Bays do not have `read_monitoring_twin` in their token scope yet. That goes through the agent checklist as its own step.
