# Decision Watch v0

11 Oct 2026, Destiny. The spec behind TASK-1791743558788-FJOO and LOOP-1791743584778-5YQA.
Jason's ask, #bha-coordination thread 1791733223.226019: a tracked decision object and a
scheduler that brings Bays back when a decision or an SOP-covered lane goes quiet, "solved as
infra, not as vibes".

## The problem

Bays only acts when something calls it: a message, or a scheduled task. A decision put to a
person in a thread and then left unanswered had nothing that came back to it. Open loops have
that persistence; a question in a thread did not.

## The object

One row per decision waiting on one named person, in `engine_decision_watches` on the engine
dashboard. It is its own list and not an open loop: a loop is a piece of work, a watch is
"somebody owes an answer here". A watch can point at a loop or a backlog task.

| Field | What it holds |
| --- | --- |
| `watch_id` | `DW-<ms>-<4>` |
| `decision` | What is being waited on, in a sentence or two |
| `owner_user_id`, `owner_name` | The one person who owes the answer |
| `channel_id`, `thread_ts`, `thread_link` | The Slack thread it was raised in, if any |
| `record_kind`, `record_id` | The loop or backlog task that tracks it, if any |
| `sop_refs`, `ns_refs` | The SOP and the North Star position it ties to |
| `next_step` | The next logged step expected of the owner |
| `lane` | The lane tag |
| `status` | `watching`, `answered`, `moved`, `escalated`, `cancelled` |
| `wait_minutes` | Quiet time before a reminder. 24 hours unless a person names another |
| `reminders_sent`, `max_reminders` | 0 to 3 |
| `quiet_since` | When something last moved |
| `last_error` | Why it could not be checked or posted, if it could not |
| `created_by`, `created_via` | Who asked, and through what |
| `history` | Every reminder, movement and close, dated |

A watch needs a thread, a record, or both.

## How a watch is made

Three ways, and no others.

1. **Bays, in a thread it is already in**, when a decision is put to a named person and not
   answered there and then (`open_decision_watch`).
2. **Anyone saying "Bays, watch this."**
3. **A standing rule in code.** There is one: PX07, below.

Bays never scans channels looking for things to watch. A second ask for the same thread and
owner while the first is open answers the first; no duplicate is made.

## What the scheduler does

One pass every five minutes, on the dashboard, beside its other background checks.

1. **The linked record** is read from the database. Closed or done closes the watch (`moved`).
   A real change to the record restarts the wait; a write that changed nothing does not.
2. **The thread** is read from Slack, as Bays, and as North Star where Bays cannot read the
   place. A reply from the owner closes the watch (`answered`). A reply from anyone else
   restarts the wait. A bot post, Bays' own reminders included, is never movement.
3. **Quiet past the wait:** one reminder is posted as Bays in the thread, naming the decision,
   the SOP and North Star reference, the owner and the next logged step. A watch with no thread
   reminds its owner by DM, and a reply in a thread on that DM closes it.
4. **After the third reminder and one more quiet wait:** one escalation naming Jason and
   Destiny, in the thread (the engine alerts channel when there is no thread), and the watch
   stops for good.

## Limits

- 24 hours quiet before a reminder; 1 hour at the least, 7 days at the most.
- At most 3 reminders per watch, then one escalation.
- At most 12 posts a day across every watch. Over that, a post is held and tried on the next pass.
- **A thread that could not be read is never reminded on.** Quiet and unread look the same from
  the outside. The watch stays open with the reason, is retried every pass, and writes one
  `decision_watch_unread` event a day.
- A post Slack refuses is recorded with Slack's reason and retried. Two passes at the same
  moment post one reminder: the row is claimed before anything goes to Slack.
- Reminders only go to a person with a Builder Profile, Jason or Destiny. On Bays' token, a
  watch can only be opened on a channel the engine already knows.
- These are v0 numbers, global. Per-lane numbers wait for real data.

## How it fits what exists

- **Open loops:** unchanged. A watch may carry a `LOOP-…` id; closing the loop closes the watch.
  The daily loop digests are not touched.
- **PX07** (LOOP-1791735522163-PX07) is its first standing use: every open CAPITAL-lane loop
  and backlog task with an owner the engine can name gets one watch, once, under the SOP
  "CAPITAL Lane Live-Client Ownership & Escalation". The wait starts when the watch is made,
  so switching it on reminds nobody about the past. An owner that is not one person
  (for example "North Star and Research Twin") is not watched.
- **Events:** `decision_watch_opened`, `_reminded`, `_closed`, `_escalated`, `_unread`, `_held` (the daily cap held a post back) in
  `engine_events`, so every agent can read them through `read_engine_events`.
- **Where it shows:** the Decision watch tab on the Bays page; `list_decision_watches`.

## What "wakes Bays" means in v0

The reminder is written by the dashboard from the watch's own fields and posted as the Bays
bot. The Bays agent is not run to compose it. That is deliberate: a reminder that depends on a
model run can fail without a trace, and this one cannot. Running the agent on a quiet watch (to
look up a newer SOP, or to ask North Star what should happen next) is the next step once this
has run on real threads.

## Not built

- Per-lane wait times and caps.
- Bays being run as an agent when a watch goes quiet (above).
- A person's weekend or working hours. A wait is clock hours.
- Opening a watch from the dashboard page. It is read only; a watch is opened by asking Bays.

## Tools

`open_decision_watch`, `list_decision_watches`, `close_decision_watch` (in Bays' scope) and
`run_decision_watch` (a person on the connector; `dry_run` by default). Every call is audited on
`engine_mcp_writes`. `npm run test:decision-watch` pins the behaviour against a local database
with Slack stood in.
