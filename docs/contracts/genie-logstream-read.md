# Genie reads Logstream, the engine's events and the vFarm doctrine

For Kaiqi. LOOP-1791653985161-QRTH. Jason's go-time notice of 10 Oct 2026 asks
that Slack Genie read the same two surfaces Bays, North Star and Research Twin
read, read-only, so there is one view of incidents and events and not a second
one built inside Genie. LOOP-1791557096136-EG4N (14 Oct) adds the doctrine:
how Genie answers "are we ready?" and "can we say X?" — see
[The doctrine](#the-doctrine-are-we-ready-and-can-we-say-x-eg4n) below.

## What you get

One read-only token for Genie. It can call six tools on the dashboard and
nothing else (four until 18 Oct 2026, when the buyer flow read and the SOP read
were added for the Engine Surfaces Contract):

| Tool | What it answers |
|---|---|
| `read_logstream` | Faults that keep coming back, which crossed a threshold, and what was done (a research job opened, an alert posted) |
| `read_engine_events` | The engine's own events (`engine.event.v1`): counts by type over a window, and the newest events. **History only, never publication authority** (see the doctrine section) |
| `read_media_doctrine` | Every vFarm claim in the doctrine in force, resolved to T0NO's seven fields (EG4N) |
| `read_publication_decision` | The current publication decision for one claim on one surface, re-checked against the doctrine in force (EG4N) |
| `read_buyer_flow` | Where each vFarm buyer lead is in the five-stage flow and what Stripe has seen for it, by `buyer_intake_id`, with no name or email (18 Oct) |
| `read_sop` | One SOP's whole text, by BHARAG id or exact title (18 Oct) |

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


### `read_buyer_flow` (18 Oct 2026)

The one read of where a vFarm buyer is. The contract is the SOP
"SOP -- Engine Surfaces Contract: vFarm buyer flow and Stripe" (read it with
`read_sop`) and `docs/contracts/engine-surfaces-buyer-flow.md`.

| Argument | Use |
|---|---|
| (none) | Counts by position and by payment `state_mode` over every lead, and the open leads newest first |
| `buyer_intake_id` | One lead, closed or not, e.g. `VFBUYER-FORMA-1A2B3C` |
| `position` | `interest`, `invited`, `spec`, `proposal`, `agreement`, `customer` or `closed` |
| `include_closed` | Include closed leads in the list (counts always include them) |
| `limit` | 50 by default, 200 at most |

Show `stage_name` and `position_label` as written. Say test or live for every
payment: a test payment is never a sale. Never work a stage out from a Slack
thread or an event on its own; if this read fails, say you do not know. The
answer carries the never-infer rules in `rules`.

### `read_sop` (18 Oct 2026)

`title` (exact, case and punctuation do not matter) or `id` (the BHARAG
document id). A title that matches nothing returns the closest titles and their
ids, never a guess. 60,000 characters at most, cut and marked.

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

## The doctrine: "are we ready?" and "can we say X?" (EG4N)

Jason, 9 Oct: "write and log a concrete plan for how a ledger-based Slack Genie
will read from this resolver (which ledger/endpoint), and how it will use
allowed/hold/needs_evidence when answering 'are we ready?' or 'can we say X?'."
This is that plan. Genie reads the one resolver Media Twin, North Star, Research
Twin and Bays read. It keeps no copy, no cache that outlives a turn, and no rule
of its own about what may be said.

### Where it reads

| Question | Tool | Ledger behind it |
|---|---|---|
| What does the doctrine say about this claim? | `read_media_doctrine` | `engine_media_doctrine`, resolved by T0NO (`systemFeeds.doctrineClaims`) |
| May Genie say it now? | `read_publication_decision` with `surface: "genie_ns"` | `engine_events` rows of type `vfam_claim_publication_decision`, re-checked by VRFK (`publicationDecision.readDecisions`) against the doctrine in force |
| What was decided, and when? (history) | `read_engine_events` | the same `engine_events` rows, **raw** |

**`read_engine_events` is history, never authority.** It returns stored decision
rows as they were written. A row written against an older doctrine version still
says `"decision": "allowed"` there, while `read_publication_decision` reports the
same claim as `needs_evidence` / `STALE_PUBLICATION_DECISION`. Never answer "can
we say X?" from `read_engine_events`.

### The identifiers

One claim is `doctrine_id` + `claim_id`, exactly as `read_media_doctrine`
returns them (e.g. `B93H` + `6.1`). The surface is always `genie_ns`. Find the
claim first, then ask for its decision:

```
{ "method": "tools/call", "params": { "name": "read_media_doctrine",
  "arguments": { "doctrine_id": "B93H", "claim_id": "6.1" } } }

{ "method": "tools/call", "params": { "name": "read_publication_decision",
  "arguments": { "doctrine_id": "B93H", "claim_id": "6.1", "surface": "genie_ns" } } }
```

`read_media_doctrine` answers `claims[]`, each with `doctrine_id`,
`doctrine_version`, `change_id`, `claim_id`, `label`, the seven fields
(`maturity_state`, `claim_state`, `config_hash`, `cad_provenance`,
`evidence_publication_status`, `fail_closed { needs_evidence, reason }`,
`allowed_use { media_twin, vfarm, genie_ns }`), `allowed_wording`,
`prohibited_wording`, and `warnings[]`. `read_publication_decision` answers
`decisions[0]` with `decision` (`allowed` | `hold` | `needs_evidence`),
`applicable`, `reason`, `recorded_decision`, `decision_id`, `decided_at` and
`doctrine_change_id`. If the claim does not match exactly one claim in force, the
tool returns an error (`not_found`).

### How Genie answers

Decide from the two reads in this order. The first rule that matches is the answer.

| # | What the reads say | What Genie says |
|---|---|---|
| 1 | Either read errored, timed out, was refused, or could not be parsed | **Not ready.** "I could not read the doctrine just now, so I can't say we're ready." Never fall back to memory, a cache or `read_engine_events`. |
| 2 | No claim matches (`not_found`, or a `warnings` line saying the claim is not held) | **Not ready.** The claim has no approved wording; it is not safe to make. |
| 3 | `decisions[0].applicable` is `false` (reason `MISSING_PUBLICATION_DECISION`, `STALE_PUBLICATION_DECISION`, `PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO`, `MISSING_CLAIM_ID`) | **Not ready.** Name the reason in plain words: no decision has been recorded, the one recorded was for an older doctrine version, or it no longer matches the doctrine. |
| 4 | `decision` is `needs_evidence` | **Not ready.** Name what is missing from `fail_closed.reason` (e.g. `MISSING_CONFIG_HASH_AND_CAD_PROVENANCE`). |
| 5 | `decision` is `hold` | **Not ready.** State the blocker from `reason` (e.g. `NOT_ALLOWED_FOR_GENIE_NS`, `NOT_SAFE_TO_CLAIM`). |
| 6 | `decision` is `allowed`, `applicable` is `true`, and the claim's `fail_closed.needs_evidence` is `false` | The claim may be described, **using its `allowed_wording` and never its `prohibited_wording`**, and only as what it says. |

`allowed_use.genie_ns` alone is never permission. It reads `true` by default on a
claim that has not cleared, so that Genie may *report* an unresolved claim
("this is still needs-evidence because …"). It never lets Genie *promote* one.
Only rule 6 does.

### Three things Genie keeps apart

- **What is observed**: a fact the engine recorded (a reading, an event, a fault).
  Genie may report it as a fact with its time, from any of the four tools.
- **What may be said**: rule 6 for that claim on `genie_ns`, and nothing wider
  than the claim's own wording.
- **Commercial readiness**: paid access, reservation, subscription, delivery.
  None of the four tools grants it. The public vFarm surface stays
  `interest_only_live` with no paid link until the doctrine and Jason say
  otherwise. Genie never says vFarm is purchasable, reservable or delivering.

### Not in this plan

Genie writes nothing: no publication decision, no doctrine change, no incident.
Decisions are recorded by their owner through `POST /api/engine/publication-decision`.
`read_doctrine_gap_summary` is not on Genie's token. It describes gaps across all
claims for the engine's own monitoring, and it answers no single "can we say X?"
question.

### How EG4N will be proved

1. Destiny deploys the scope change and confirms `tools/list` on Genie's token
   names exactly the four tools.
2. Kaiqi's deployed Genie answers one real "can we say X?" question, which writes
   one `read_media_doctrine` and one `read_publication_decision` line as
   `agent token: genie`, and its answer matches the table above for that claim's
   real state.
3. With a recorded decision for one claim on `genie_ns`, Genie's answer changes
   to rule 6. After a newer doctrine version is posted, it changes back to rule 3
   (`STALE_PUBLICATION_DECISION`), with no change on Genie's side.

## How we will know it is wired

Each call writes one line on the dashboard as `agent token: genie`. Once Genie
has made one real `read_logstream` and one real `read_engine_events` call from
its deployed service, Destiny confirms both lines and QRTH can close.

## Where the token is

On Render, on the dashboard service (`bha-engine-dashboard`), under Environment,
as `READONLY_SECRETS_GENIE`. Kaiqi copies the value from there and sets it as a
secret on the Genie service. It is not in this repo or in Slack, and must not be
pasted into either.
