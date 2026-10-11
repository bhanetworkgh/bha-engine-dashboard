# Genie reads Logstream and the engine's events

For Kaiqi. LOOP-1791653985161-QRTH. Jason's go-time notice of 10 Oct 2026 asks
that Slack Genie read the same two surfaces Bays, North Star and Research Twin
read, read-only, so there is one view of incidents and events and not a second
one built inside Genie.

## What you get

One read-only token for Genie. It can call two tools on the dashboard and
nothing else:

| Tool | What it answers |
|---|---|
| `read_logstream` | Faults that keep coming back, which crossed a threshold, and what was done (a research job opened, an alert posted) |
| `read_engine_events` | The engine's own events (`engine.event.v1`): counts by type over a window, and the newest events |

Any other tool is refused by the server and the refusal is logged. The token
can never write.

## How to call it

The dashboard's MCP server speaks JSON-RPC 2.0 over one HTTPS POST. No SDK is
needed and no session has to be opened first.

```
POST https://dashboard.bhanetwork.org/mcp/agent
Authorization: Bearer <READONLY_SECRETS_GENIE>
Content-Type: application/json
Accept: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "read_engine_events", "arguments": { "hours": 24, "limit": 20 } } }
```

The answer is `result.content[0].text`, which is itself a JSON string. Parse it.
A tool error comes back as `error.code` and `error.message` on the same 200.
A wrong or missing token is a plain 404, never a 401.

`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` returns both tools with their
full argument schemas. Treat that as the source of truth for arguments; the
tables below are a summary.

### `read_logstream`

| Argument | Use |
|---|---|
| (none) | The overview: the rule in words, what holds now, the last 30 days of crossings and what was done, the faults nearest the line |
| `signature` | One fault's history. A signature is `workflow :: step that failed`, as the overview prints it |
| `workflow` | Every fault of one workflow |
| `max_chars` | Answer budget. 20,000 by default, 40,000 at most |

### `read_engine_events`

| Argument | Use |
|---|---|
| `hours` | Window to read. 168 (7 days) by default, 720 (30 days) at most |
| `event_type` | One event type, e.g. `logstream_threshold_crossed`, `openrouter_credit_out` |
| `subject_id` | One subject, e.g. an incident id or a loop id |
| `lane` | One lane, e.g. `GENIE`, `BAYS`, `MEDIA` |
| `limit` | Newest events to return. 50 by default, 200 at most |
| `catalog` | `vfarm_customers` returns the vFarm customer state catalog (counts only, never a name or an email) |

## Rules to keep

1. **Read-only.** Genie reports what these two reads say. It does not close,
   retry or edit an incident, and it does not keep its own copy as a second
   source.
2. **An empty answer is not good news by itself.** Both tools say so in words:
   an empty window means none was recorded, not that nothing happened.
3. **A cut answer says it was cut.** `truncated: true` and a `note` tell you
   how to narrow the ask. Do not call again with the same arguments.
4. **Fixture and simulated rows are marked.** Never present one as a real farm
   or a real fault.
5. **Keep the token server-side**, in Genie's environment, never in a prompt,
   a log line or a client bundle.

## How we will know it is wired

Each call writes one line on the dashboard as `agent token: genie`. Once Genie
has made one real `read_logstream` and one real `read_engine_events` call from
its deployed service, Destiny confirms both lines and QRTH can close.

## Where the token is

Set on the dashboard service as `READONLY_SECRETS_GENIE`. Destiny hands the
value to Kaiqi directly; it is not in this repo or in Slack.
