# Customer Service Twin → BHA Engine Dashboard: every customer turn, as it happens

**For:** Ahad (CST). **From:** Destiny, 29 Sep 2026. **Status:** the dashboard side is live; this is the CST side.

## Why

CST keeps a full record in its own Postgres: conversations, messages in and out, delivery status, the security log. None of it reaches BHA's engine dashboard, so the **Customer Service Twin** page there (dashboard.bhanetwork.org/cs-twin) has been a placeholder.

The fix is a push. After every customer turn, CST posts what happened, and the page shows it the moment it lands, with the same live refresh the other pages have. The page has two tabs:

- **Turns**: every customer message, the reply, what the customer wanted, the outcome, how long the reply took, and whether it reached them. A row opens to show the whole record.
- **Statistics**: outcomes by week, and splits by intent, channel and project.

There is no pull and no resync button. A turn CST does not post does not exist on the page. **The dashboard keeps the whole record**: message text, reply text and the customer's number. The list shows only the last four digits; the full number is inside the row.

## Where

```
POST https://dashboard.bhanetwork.org/api/engine/cst-events
x-dashboard-key: <ENGINE_DASHBOARD_KEY>        (in Bitwarden)
content-type: application/json
```

Two new CST env vars: `ENGINE_DASHBOARD_URL` and `ENGINE_DASHBOARD_KEY`. If either is unset, CST does not post, and logs that once at boot.

## What: two events, one row

Both events carry `"schema": "cst.event.v1"` and the same **`turn_id`**. The turn id is the `correlation_id` already on the `MessageEnvelope` (the inbound Twilio MessageSid for SMS). Both events land on one row, in either order, and a retry updates that row rather than adding a second.

### 1. `cst.turn`: after `CoreEngine.processEnvelope` returns

Post it from the three places that call it: `interfaces/sms`, `interfaces/voice` and `interfaces/web`. Post it on the refused and onboarding paths too, not only on `ok`. If processEnvelope throws, post it with `status: "error"`.

| Field | Required | Notes |
|---|---|---|
| `event_type` | yes | `cst.turn` |
| `turn_id` | yes | `envelope.correlation_id` |
| `channel` | yes | `sms`, `voice` or `web` |
| `status` | yes | `ok`, `refused`, `step_up_required`, `onboarding` or `error`. The unknown-speaker path returns no status today, so send it as `onboarding`. |
| `occurred_at` | yes, in practice | ISO 8601, when the message came in. If it's missing, the dashboard stamps the time it received the event. |
| `conversation_id`, `tenant_id`, `project_id` | yes | as on the response |
| `customer` | yes | `{ person_id, customer_ref, phone_e164, name, role, is_known }` from the resolved `SpeakerIdentity` |
| `message` | yes | the customer's text, as received (for voice, the transcribed turn) |
| `reply` | yes | `reply_text`, as sent |
| `intent` | when known | the router's `status` / `knowledge` / `images` / `escalate` / `default`. Please add `intent` to the refused and step-up responses, so every row has one. |
| `reason` | on refused / step_up / error | the same sentence that goes in the audit log |
| `incident_id` | on escalate | what `BharagIncidentsConnector.fileIncident` returned |
| `duration_ms` | yes, in practice | time from the message arriving to the reply being ready. The page shows p50/p95, and **leaves out turns without it** rather than counting them as instant. |

How the page reads the outcome:
- `ok` → **Answered**, or **Escalated** when the intent is `escalate`
- `refused` → **Refused**
- `step_up_required` → **Needs verification**
- `onboarding` → **Unknown caller**
- `error` → **Failed**

### 2. `cst.delivery`: whenever an SMS reply's delivery changes

Post it from two places:
- `processOutboundQueue`, when it marks a message `sent` or finally `failed`
- the `/twilio/delivery-status` callback, for `delivered`, `undelivered` or `failed`

| Field | Required | Notes |
|---|---|---|
| `event_type` | yes | `cst.delivery` |
| `turn_id` | yes | the turn this reply answers. `messages_out.correlation_id` is `corr_<MessageSid>_<ms>` today. Either carry the turn id onto the `messages_out` row, or take the MessageSid back out of it. |
| `status` | yes | `queued`, `sending`, `sent`, `delivered`, `undelivered` or `failed` |
| `error` | on failure | e.g. `Twilio ErrorCode: 30003` |
| `attempts` | optional | `retry_count` |
| `occurred_at` | optional | when the status changed |

**A delivery never moves backwards.** Twilio's callbacks arrive out of order, so a late `sent` never overwrites a `delivered`. Voice and web replies have no Twilio delivery; don't send one for them. The page shows a dash, and leaves those turns out of the delivered rate.

### Example

```json
{ "events": [
  { "schema": "cst.event.v1", "event_type": "cst.turn", "turn_id": "SM8f2c0e1b4a",
    "occurred_at": "2026-09-29T13:05:12Z", "channel": "sms", "status": "ok", "intent": "status",
    "conversation_id": "conv_71a", "tenant_id": "tenant-vfarm-01", "project_id": "proj-vfarm-main",
    "customer": { "person_id": "p_19", "customer_ref": "cust_19", "phone_e164": "+15125550143", "name": "Ama", "role": "owner", "is_known": true },
    "message": "how is my farm doing", "reply": "Farm Austin Main: all 6 sensors reporting, temperature 24.1°C…",
    "duration_ms": 1840 },
  { "schema": "cst.event.v1", "event_type": "cst.delivery", "turn_id": "SM8f2c0e1b4a",
    "status": "delivered", "attempts": 1, "occurred_at": "2026-09-29T13:05:15Z" }
] }
```

A single event can be posted on its own, without the `events` wrapper. A batch holds at most 200. One bad event refuses the whole batch and writes nothing.

## Answers

- `201` when something new was stored, `200` otherwise: `{ ok, received, turns, deliveries, inserted, updated, unchanged, turn_ids, dry_run }`.
- `422` names the field that is wrong. For example: no `turn_id`, a `channel` or `status` outside the lists above, or an `occurred_at` that is not a time.
- `401` means the key is missing or wrong.
- Every call, refused ones included, is logged on the dashboard's engine-writes log.

## Test without leaving a row

Add `"dry_run": true` at the top level. Every check and database write runs, then everything is rolled back, and the answer says `"dry_run": true`.

```bash
curl -sS -X POST https://dashboard.bhanetwork.org/api/engine/cst-events \
  -H "x-dashboard-key: $ENGINE_DASHBOARD_KEY" -H 'content-type: application/json' \
  -d '{"dry_run":true,"schema":"cst.event.v1","event_type":"cst.turn","turn_id":"test-1","channel":"sms","status":"ok","intent":"status","occurred_at":"2026-09-29T13:00:00Z","message":"test","reply":"ok","duration_ms":900}'
```

## CST-side rules

- **Fire-and-forget, after the reply is on its way.** A dashboard outage must never delay or fail a customer's reply. Use a 5 s timeout, off the request path (the SMS handler already works inside `setImmediate`).
- **Retry three times** on a network error, 408, 429 or 5xx, with backoff. Do not retry a 4xx: log it once with the dashboard's message.
- **One post per turn and one per delivery change.** Nothing else is needed: no conversation-start event, no heartbeat.

## Also wanted, separately

A BHARAG incident-read key for `CUSTOMER_TWIN`. CST already files its escalations and failures there. With the key, CST gets its own lane on Engine health, beside Bays, North Star and Research Twin.

## When it works

The first turn appears under **Turns** within a second, with its outcome, time and delivery, and the Home page's Customer Service Twin tile starts counting.
