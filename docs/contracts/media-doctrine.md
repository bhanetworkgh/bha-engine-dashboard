# Media Twin doctrine → BHA Engine Dashboard: one record per doctrine change

**For:** Hardik (Media lane). **From:** Destiny, 30 Sep 2026. **Status:** the dashboard side is live and holds the current B93H, TSNR and OWLG versions as its first records. This page covers your side.

## Why

You own the rules for what vFarm's public surfaces may claim: B93H (the buyer capability list), TSNR (commercial vocabulary and Stage 2 / paid semantics), OWLG (the mechanical → media handoff), and any that follow. Today those rules live in loop text and documents. An agent, a page or a builder has no single place to read which version is in force, so an old promise can get quoted after the rule has changed.

The fix is a push. Every time one of your doctrines or contracts changes, post one record to the dashboard. The **Media Twin** page (dashboard.bhanetwork.org/media-twin → Doctrine) then shows the version in force for each doctrine and every change behind it, and the agents read from there.

This is the third section of the dashboard-posting spec Jason asked for on HMJV: "what doctrine/contract changes Hardik must post (doctrine version, contract IDs, default patterns applied)."

## Where

```
POST https://dashboard.bhanetwork.org/api/engine/media-doctrine
x-dashboard-key: <DASHBOARD_INBOUND_KEY>        (Destiny sends it privately; the same key n8n uses)
content-type: application/json
```

Send one change, or `{ "changes": [ ... ] }` with up to 100. Add `"dry_run": true` to check a payload end to end without storing it.

## When to post

Post every time you:

- **create** a doctrine or contract (its first version);
- **amend** one: a wording change, a maturity moving up or down, a new clause, or Jason ratifying a change;
- **supersede** one with a replacement;
- **retire** one.

If Jason or Bays appends a standing rule to one of your loops (B93H, OWLG and so on), that is an amendment too, and it gets a record.

## What: `media.doctrine.v1`

| Field | Required | Notes |
|---|---|---|
| `change_id` | yes | Your id for this change, unique, e.g. `DOC-B93H-v0.2`. **It is the retry key**: posting the same change twice changes nothing. |
| `doctrine_id` | yes | The short id: `B93H`, `TSNR`, `OWLG`, … Stored upper case. |
| `doctrine_name` | recommended | e.g. "vFarm buyer capability list". |
| `version` | yes | The version this change puts in force, e.g. `v0.2`. |
| `previous_version` | yes, unless `created` | The version it replaces. This is what makes a supersession visible. |
| `change_type` | yes | `created`, `amended`, `superseded` or `retired`. |
| `summary` | yes | What changed, in plain words. |
| `changed_at` | yes | ISO 8601: when the change was made or ratified. |
| `contract_ids` | recommended | Every contract the version binds, e.g. `VFARM_BUYER_INTAKE.v1`, `VFARM_MECHANICAL_MEDIA_HANDOFF`. |
| `default_patterns` | recommended | The build patterns or standing rules applied by default, e.g. `BP-…` ids or `P1.0 mechanical ceiling`. |
| `claims` | recommended | The claim-level states the version sets. Legacy `maturity` is normalized to `maturity_state` on read. T0NO fields are `claim_state`, `config_hash`, `cad_provenance: { cad_revision, provenance_ref }`, `evidence_publication_status`, `fail_closed: { needs_evidence, reason }`, and `allowed_use: { media_twin, vfarm, genie_ns }`. Missing evidence remains null/explicit and fails closed; never send placeholder hashes or CAD revisions. |
| `approved_by`, `approved_at` | recommended | Who ratified it (usually Jason) and when. |
| `loop_id`, `doc_url` | recommended | The loop and the document behind the change. |
| `posted_by` | recommended | Who sent the record. |

### No silent edits

This follows OWLG's own rule, and the server enforces it:

- A `change_id` sent again with **identical** content answers `200` and changes nothing.
- A `change_id` sent again with **different** content is refused `409`.
- A second `change_id` for a `doctrine_id` + `version` already held is refused `409`.

To correct something, post a **new version** with `previous_version` set to the one it replaces. The old version stays on the page as history.

### Example

```json
{
  "schema": "media.doctrine.v1",
  "change_id": "DOC-B93H-v0.2",
  "doctrine_id": "B93H",
  "doctrine_name": "vFarm buyer capability list",
  "version": "v0.2",
  "previous_version": "v0.1",
  "change_type": "amended",
  "summary": "Camera/vision (6.1) stays IN_BUILD; adds the P1.0 camera/FOV NEEDS_EVIDENCE hold from Jegan's handoff.",
  "changed_at": "2026-10-02T10:00:00Z",
  "contract_ids": ["VFARM_MECHANICAL_MEDIA_HANDOFF"],
  "default_patterns": ["P1.0 mechanical ceiling"],
  "claims": [
    { "claim_id": "6.1", "label": "Camera / vision", "maturity": "IN_BUILD", "allowed_wording": null, "prohibited_wording": "Any claim that P1.0 camera coverage is measured" }
  ],
  "approved_by": "Jason Bays",
  "approved_at": "2026-10-02T09:30:00Z",
  "loop_id": "LOOP-1790430578528-B93H",
  "posted_by": "Hardik Bhatt"
}
```

## Answers

- `201` with `{ ok, received, inserted, unchanged, change_ids }` when something new was stored.
- `200` when everything sent was already held unchanged, or on a dry run (`dry_run: true`).
- `409` for an edit or a restated version. The message names the change already held.
- `422` naming the field when a record is not valid; nothing in the batch is stored.
- `401` without the key. Every call, accepted or refused, is logged on the dashboard's engine-writes log.

## Reading it back (added 1 Oct, for T0NO)

Media Twin, `/vfarm` and Genie read the claims from here, not from a copy of their own.

- **Code:** `GET https://dashboard.bhanetwork.org/api/engine/media-doctrine` with the same `x-dashboard-key` header. Optional filters: `?doctrine_id=B93H`, `?claim_id=6.1`, `?maturity=NOT_SAFE_TO_CLAIM` (case does not matter).
- **Agents:** the `read_media_doctrine` MCP tool. Same function, same answer.

The answer (`media.doctrine.read.v1`) carries the version in force of each doctrine and one row per claim. Every row exposes T0NO's locked core: `maturity_state`, `claim_state`, `config_hash`, `cad_provenance`, `evidence_publication_status`, `fail_closed`, and `allowed_use`, alongside its claim identity and wording. Missing upstream values are explicit (`UNKNOWN`, null, or `NEEDS_EVIDENCE`) and make `fail_closed.needs_evidence` true with the missing evidence classes named in `reason`. A claim that is not held has no approved wording. A filter that matches nothing returns a line in `warnings`, never a silent empty list.

```bash
curl -s https://dashboard.bhanetwork.org/api/engine/media-doctrine?doctrine_id=B93H \
  -H "x-dashboard-key: $DASHBOARD_INBOUND_KEY"
```

## Publication-decision trace (VRFK)

T0NO says what the current evidence allows; it is not itself proof that a
surface made a publication decision.  `VFAM.claim_publication_decision` is the
append-only trace for that second step.  It uses the existing `engine.event.v1`
store (`engine_events`), with adapter event type
`vfam_claim_publication_decision` and the exact domain event name retained in
`detail.event_name`.

- **Write/read:** `POST` / `GET /api/engine/publication-decision`.
- **Agent read:** `read_publication_decision`.
- **Scope:** one `doctrine_id` + `claim_id` + `surface` (`media_twin`, `vfarm`
  or `genie_ns`).
- **Decision:** `allowed`, `hold` or `needs_evidence`.
- **Retry identity:** `decision_id`, stored as the event `dedupe_key`.
- **Evidence binding:** the event carries the doctrine version/change and an
  exact seven-field T0NO snapshot. A caller cannot submit a decision that
  contradicts the current resolver.
- **Fail closed:** a missing event, changed doctrine version, contradictory
  decision or unresolved evidence reads as `needs_evidence`; an old event is
  never treated as current authority.

Media Twin requires both a clear T0NO claim and a current applicable decision.
No decision means hold. This trace never edits doctrine, claim state, config
identity or evidence.

## Already there

The current versions are recorded from the loop records as the first entries: **B93H v0.1**, **TSNR v0** and **OWLG v0.1**, each as ratified by Jason on 27–29 Sep. Your first post should amend one of them, so check the page for the version in force before you post.
