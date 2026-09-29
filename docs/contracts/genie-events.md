# Genie → BHA Engine Dashboard: one event per ask

**For:** Kaiqi (Genie). **From:** Destiny, 29 Sep 2026. **Status:** the dashboard side is live; this is the Genie side.

## Why

Genie keeps no record of its asks: `agent_sessions` is hashed memory, and `subagent_runs` is the coding-helper queue (and is not to grow, per `docs/subagentrun-wiring-contract-v1.md`). So the dashboard has nothing to read. The fix is a push: after every ask, Genie posts one event to the dashboard, and the **Genie** page (dashboard.bhanetwork.org/genie) shows it the moment it lands. It is shaped like the North Star and Research Twin pages: every ask, its outcome, how long it took, and whether it went on to a twin.

There is no pull and no resync button. An ask Genie does not post does not exist on the page.

## Where

```
POST https://dashboard.bhanetwork.org/api/engine/genie-events
x-dashboard-key: <DASHBOARD_INBOUND_KEY>        (Destiny sends it privately; the same key n8n uses)
content-type: application/json
```

Two new Genie env vars: `ENGINE_DASHBOARD_URL` and `ENGINE_DASHBOARD_KEY`. Unset means "do not post", and Genie logs that once at boot.

## What: the envelope Genie already sends

The body is **the service-callback envelope Genie already builds** (`src/integrations/callbackDelivery.ts`, documented in `docs/genie-service-api-integration-guide.md`), with four fields added. It goes to one more receiver, **for every ask, not only service-API asks**: Slack, the browser UI, `/voice` and the service API.

| Field | Required | Notes |
|---|---|---|
| `eventId` | yes | Unique per event. **It is the upsert key**: sending the same event twice updates one row. |
| `eventType` | yes | Must start with `genie.`. Use `genie.message.completed` / `genie.message.failed` for asks; `genie.subagent.*` is stored but not counted as an ask. |
| `requestId` | yes, in practice | One ask = one `requestId`. The page shows the latest event per `requestId`. |
| `occurredAt` | yes, in practice | ISO 8601. If it's missing, the dashboard stamps the time it received the event. |
| `session_id`, `builder_id`, `correlation_id`, `thread_id`, `lane`, `runId` | as today | `builder_id` = the asker's Slack user id. `lane` = the synthesis lane, else `ENGINE_INTERNAL`. |
| `response` | on completed | The ExecuteResponse as today. The page reads `response.status` (`satisfied` / `max_iterations_reached` / `error`) and `response.finalOutput`. |
| `error` | on failed | `{ code, message }` as today. |
| **`question`** | new | The ask text, as the person typed it. Trim it to 2,000 characters if needed. |
| **`source`** | new | `slack`, `service`, `browser` or `voice`. |
| **`duration_ms`** | new | Wall-clock time from receiving the ask to having the answer. The page shows p50/p95 and **leaves out asks without it** rather than treating them as instant. |
| **`handoff`** | new | `research_twin` or `north_star` when Genie sent the ask on (the `hopTwin…` paths in `slack.ts`); otherwise omit it. |

Outcome on the page: `satisfied` → **Answered**, `max_iterations_reached` → **Incomplete**, a `.failed` event or `error` → **Failed**.

### Example

```json
{
  "eventId": "evt_01J9ZK3Q7M2X",
  "eventType": "genie.message.completed",
  "requestId": "req_01J9ZK3Q5D",
  "session_id": "req_01J9ZK3Q5D",
  "builder_id": "U0AEW3TBYH1",
  "correlation_id": null,
  "thread_id": "1790690000.123456",
  "subsystem": "GENIE",
  "lane": "VFARM_CORE",
  "occurredAt": "2026-09-29T13:05:12.000Z",
  "question": "What did Kavin change on the Pi yesterday?",
  "source": "slack",
  "duration_ms": 18400,
  "response": { "requestId": "req_01J9ZK3Q5D", "status": "satisfied", "finalOutput": "Kavin reserved the Pi's static IP…", "iterationsUsed": 3, "judgeSummary": "…" }
}
```

Batch (for a backfill): `{ "events": [ …up to 200 envelopes… ] }`. One bad envelope refuses the whole batch and writes nothing.

## Answers

- `201` when the event is new, `200` when it updated an existing event: `{ ok, received, inserted, updated, event_ids, dry_run }`.
- `422` names the field that is wrong: no `eventId`, an `eventType` not starting with `genie.`, or an `occurredAt` that is not a time.
- `401` means the key is missing or wrong.
- Every call, refused ones included, is logged on the dashboard's engine-writes log.

## Test without leaving a row

Add `"dry_run": true` at the top level. Every check and database write runs, then everything is rolled back, and the answer says `"dry_run": true`.

```bash
curl -sS -X POST https://dashboard.bhanetwork.org/api/engine/genie-events \
  -H "x-dashboard-key: $ENGINE_DASHBOARD_KEY" -H 'content-type: application/json' \
  -d '{"dry_run":true,"events":[{"eventId":"test-1","eventType":"genie.message.completed","requestId":"req-test-1","occurredAt":"2026-09-29T13:00:00Z","question":"test","source":"slack","duration_ms":1200,"response":{"status":"satisfied","finalOutput":"ok"}}]}'
```

## Genie-side rules

- **Fire-and-forget, after the answer is delivered.** A dashboard outage must never delay or fail an ask.
- **Retry three times** on a network error, 408, 429 or 5xx, with the backoff `callbackDelivery.ts` already uses. Do not retry a 4xx: log it once with the dashboard's message.
- **Post once per ask when it finishes**, and once when it fails. The page does not need an "accepted" event.
- **Where to call it:** after `executeAgent` returns, beside the incident reporter (`agentExecutionService.ts` around line 297), and in the Slack twin-hop path so that hand-offs are posted too.

## Also wanted, separately

A BHARAG incident-read key for `source=genie`. With it, Genie gets its own lane on Engine health, beside Bays, North Star and Research Twin.

## When it works

The Genie page shows the ask under **Asks** within a second, with its outcome and time, and the **Statistics** tab starts filling in.
