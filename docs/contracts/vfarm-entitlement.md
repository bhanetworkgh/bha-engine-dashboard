# vFarm entitlement — `vfarm.entitlement.v0`

What a vFarm farm is entitled to, read by vFarm from the Engine. Set by Jason on 30 Oct 2026
(#bha-coordination, 1793375674.351769, in the buyer-flow thread 1792133001.785759), on Jegan's vFarm
plan (1793355422.648359) and Destiny's naming check (1793347571.326389). Built 31 Oct 2026.

## The rule

- **The Engine record is the only writer.** No vFarm route writes the entitlement, and vFarm admin has
  no toggle for it.
- **vFarm derives every feature from plan + status, in one place.** Monitor is monitoring, alerts,
  read-only twin reports and the farm and device dashboards. The higher plan adds the tested automation
  workflows, and rover and vision only where Hardik's doctrine carries the claim. Pollination is never
  included; it shows as NEEDS_EVIDENCE / under development on every plan.
- **A farm with no record, or no plan, derives Monitor with status `pending`.** The floor, not
  everything on.
- **Plans, not tiers.** "Tier" means a shelf on the rack.

## The read

```
GET https://dashboard.bhanetwork.org/api/engine/vfarm-entitlement?farm_id=<farm id>
x-dashboard-key: <ENGINE_DASHBOARD_KEY, the key the snapshot push already uses>
```

Always 200 for a farm id it can read, found or not, so vFarm can cache the floor. 401 on a wrong key,
422 with no `farm_id`. vFarm pulls it on a schedule and on demand, and keeps the last good copy with its
own `fetched_at`.

```json
{
  "ok": true,
  "contract": "vfarm.entitlement.v0",
  "farm_id": "21dde23e-…",
  "found": true,
  "record_id": "ENT-1793430000000-3F2A",
  "plan": "Monitor",
  "status": "active",
  "status_recorded": true,
  "status_since": "2026-11-20T09:00:00.000Z",
  "start_at": "2026-11-20T00:00:00.000Z",
  "renew_at": "2027-02-20T00:00:00.000Z",
  "pilot": true,
  "limits": { "racks": 5, "devices": null, "users": null },
  "offer_id": "OFFER-…",
  "buyer_intake_id": "VFBUYER-FORMA-…",
  "test": false,
  "updated_at": "…",
  "floor": { "plan": "Monitor", "status": "pending" },
  "read_at": "…",
  "notes": ["A limit that is null is not set yet: show \"not set\" and enforce nothing against it."]
}
```

| Field | Where it comes from |
|---|---|
| `plan` | Only the `plan` named in the conditions of Jason's newest real approved offer (the charge gate's `offer_approval`), by its `offer_id`. Null until such an offer exists. |
| `status` | The newest `VFARM_SUBSCRIBER_STATE_CHANGED` naming this `farm_id` (customer events contract): `pending`, `active`, `paused`, `cancelled`. None recorded is `pending`, with `status_recorded: false`. There is no trial. |
| `start_at`, `renew_at`, `pilot` | Set on the record by Destiny or Jason. |
| `limits` | Racks, devices, users. Null is "not set": show it, enforce nothing. The rack count waits on the Pilot 1 contract. |
| `record_id` | The Engine record id, `ENT-<ms>-<4>`. |
| `test` | The record is on a team test lead (an @bhanetwork.org address): a test of the path, never a customer. |

## The write

`set_vfarm_entitlement` on the Engine dashboard's MCP write connection, in no agent's scope. Destiny or
Jason only. The farm must be one vFarm has sent in a snapshot; the lead must be the paying customer (a
real lead at Stage 5, or a team test lead). One record per farm; a farm linked to one lead is refused to
another. Every write is one `vfarm_entitlement_set` event and a line on `engine_mcp_writes`.
`read_vfarm_entitlement` reads the same answer the route gives.
