# Genie Builder interactions: `genie.builder.interaction.v1`

The Logstream record for Genie Builder rails, starting with `genie-slack-n8n` (Slack Genie on u82u to production n8n), the first production-connected Genie rail under the rev 5 contract (Genie Builder 0.1 Production-Connected, BHARAG `f9cc85f1-d4ef-4ff8-99fd-e4d3aa909428`). Agreed in #bha-coordination 1793566544.600759 (Jason, Kaiqi, Destiny, 8 to 9 Nov 2026). Code: `server/src/genieBuilder.ts`.

## Where it goes

`POST https://dashboard.bhanetwork.org/api/engine/genie-builder` with header `x-dashboard-key: <DASHBOARD_INBOUND_KEY>`, the key every engine sender uses. The key is in Bitwarden; it is never pasted in Slack or committed.

Send one stage message, or `{ "messages": [ ... ] }` with at most 50. `"dry_run": true` checks and writes nothing. The answer is `201` (a new interaction) or `200` (an existing one updated) with `{ ok, received, inserted, updated, interaction_ids }`. A message that breaks a rule is `422` with the reason and **nothing in the call is written**. Genie must treat any answer that is not `ok: true` as a failed write and raise it, never drop it.

## One record per interaction

Keyed by `interaction_id` (Genie's `request_id`). Every message carries:

| field | type | |
|---|---|---|
| `schema` | `"genie.builder.interaction.v1"` | optional |
| `interaction_id` | string | required |
| `rail_id` | string, e.g. `"genie-slack-n8n"` | required, fixed for the interaction |
| `stage` | `queued` / `approval` / `terminal` / `review` | required |
| `proof_type` | `test_forced` / `live_natural` | required; if any stage says `test_forced`, the record stays `test_forced` |

Each stage writes only its own fields and is dated, so a later stage never overwrites an earlier one. The same stage sent again (a retry) replaces only that stage's fields.

### 1. `queued`
`requester_id` (Slack id), `queued_at` (ISO time; default now), `intent` (`create_workflow` / `modify_workflow` / `publish_workflow`), `live_touching` (true/false), `live_touching_reason` (why it does or does not touch anything live), `genie_plan_id`, `plan_summary`, `context_sources` (what the reuse lookup found, or `["none found"]`), `subagent_query` (the request and the JSON plan; optional). All but `subagent_query` are required.

### 2. `approval`
`approver_id`, `approved_at`, `approvals_required` (1 or 2), `two_builder_check` (`not_required` / `passed` / `rejected_self_approval`), `approval_decision` (`granted` / `denied`); on a deny, `error_or_stop_reason` (defaults to `approval_denied`).
Refused: two approvals required with `not_required`; a `rejected_self_approval` that is `granted`; a `granted` approval on a live-touching action by its own requester (the two-builder gate), or with `approvals_required` other than 2.

### 3. `terminal`
`finished_at`, `status`, `backend_artifact_id` (n8n workflow id), `backend_artifact_version`, `backend_debrief` (object: nodes, assumptions, warnings, validate result, active, published), `submission` (what was actually shipped back, G3), `live_effect` (true only when a publish or live edit actually ran), `error_or_stop_reason`, `evidence_links` (list).
`status` and `live_effect` are required; `backend_debrief` and `submission` are required unless `error_or_stop_reason` says why nothing was built. Refused: `live_effect` true with no granted approval held, or on a live-touching action whose two-builder check is not `passed`.

### 4. `review`
`rater_id`, `reviewed_at`, `builder_decision` (`accepted` / `modified` / `rejected`), `usefulness_rating` (whole number 1 to 5, never null), `review_note` (optional).

## How it is read

- **Counts toward the proof** only when finished and reviewed with a rating (G2). A finished interaction with no review after 48 hours is a **failed feedback loop**, never closed.
- `test_forced` and `live_natural` are counted apart; only `live_natural` answers "does Genie help in real use".
- Page: the dashboard's Genie page, Builder tab. Read: `read_genie_builder` (MCP) and `GET /api/genie/builder` (page). Both give the rows and the summary: interactions, finished, counted toward the proof, accepted / modified / rejected, average rating, awaiting review, failed feedback, live effect, self-approvals refused, denied.
- BHARAG may keep a mirror copy; this record is the evidence spine for rev 5 (G1).

## Example: one interaction, four messages

```json
{ "schema": "genie.builder.interaction.v1", "interaction_id": "req_8f2c", "rail_id": "genie-slack-n8n", "stage": "queued", "proof_type": "live_natural",
  "requester_id": "U0AD1V1D65N", "queued_at": "2026-11-20T14:00:00Z", "intent": "publish_workflow", "live_touching": true,
  "live_touching_reason": "publish activates a production n8n workflow that posts to #ops", "genie_plan_id": "plan_8f2c",
  "plan_summary": "Publish the vFarm humidity alert to #ops", "context_sources": ["Codex CODEX-...", "BHARAG doc ..."] }
{ "interaction_id": "req_8f2c", "rail_id": "genie-slack-n8n", "stage": "approval", "proof_type": "live_natural",
  "approver_id": "U0AEW3TBYH1", "approvals_required": 2, "two_builder_check": "passed", "approval_decision": "granted" }
{ "interaction_id": "req_8f2c", "rail_id": "genie-slack-n8n", "stage": "terminal", "proof_type": "live_natural",
  "status": "succeeded", "backend_artifact_id": "AbC123", "backend_artifact_version": "v7", "live_effect": true,
  "backend_debrief": { "nodes": 4, "assumptions": [], "warnings": [], "validate": "ok", "active": true, "published": true },
  "submission": { "workflow_id": "AbC123", "message": "Published" }, "evidence_links": ["https://.../executions/123"] }
{ "interaction_id": "req_8f2c", "rail_id": "genie-slack-n8n", "stage": "review", "proof_type": "live_natural",
  "rater_id": "U0AD1V1D65N", "builder_decision": "accepted", "usefulness_rating": 4, "review_note": "Worked first time" }
```
