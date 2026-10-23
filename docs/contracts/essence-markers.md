# Essence markers: schema and the `read_essence` contract (v0, for Canon)

LOOP-1792428941802-0LEW. Built 24 Oct 2026 from Jason's calls of 23 Oct (#bha-coordination
1792773102.009109): builder confirmation is mandatory; markers are private by default and a builder
may publish chosen ones; founder markers come from Jason's reviews, architect answers and doctrine
posts through the same pipeline; markers never feed pay. Code: `server/src/essence.ts`, migration 93,
`server/src/mcp/essenceTools.ts`. Test: `npm run test:essence`.

## What a marker is

One line about how a person decides, always carrying the exact sentence from their own words it
came from. Five kinds: `decision_rule`, `trade_off`, `debugging_instinct`, `standard`, `voice`.
A task, a status or a judgement of the person is never a marker.

## Table `engine_essence_markers`

| field | type | rule |
| --- | --- | --- |
| marker_id | text, primary key | `EM-<ms>-<4>` |
| subject_id | text | Slack id of the person the marker is about |
| subject_name | text | from the log or Builder Profiles |
| kind | text | one of the five kinds (CHECK) |
| line | text | the marker, 8 to 280 characters (CHECK) |
| quote | text | the exact sentence, 15 to 400 characters (CHECK) |
| source_kind | text | `codex_log`, `review`, `architect_answer`, `doctrine_post` (CHECK) |
| source_ref | text | Codex Entry ID, or the Slack message link |
| seen_in | text[] | every distinct source the line has been found in |
| status | text | `proposed` (default), `confirmed`, `rejected`, `stable` (CHECK) |
| published | boolean | false by default; true only on confirmed or stable (CHECK) |
| confidence | numeric | 0 to 1, optional |
| proposed_by | text | who or what proposed it |
| via | text | the door it came through |
| decided_by, decided_at, decision_note | | the subject's own decision; decided_by is always the subject (CHECK) |
| test | boolean | TEST rows; never read unless asked |
| created_at, updated_at | timestamptz | |

Indexes: `(subject_id, status)` for the read; `(source_ref)` for "what came from this log";
unique `(subject_id, kind, md5(quote), source_ref)` so one sentence from one source is one marker.

## Rules, held in code

1. **No quote, no marker.** `codex_log`: the log must be the subject's own (`Builder User ID`) and the
   quote must appear word for word in its `Transcript`, the builder's narration, never the review.
   Founder sources: Slack must confirm the subject posted the linked message and the quote is in it.
   Case, curly quotes and spacing are ignored; a paraphrase is refused.
2. **Only the subject decides.** Confirm ("That's me"), reject ("Not me"), publish and unpublish are
   refused for anyone else, Destiny and Jason included, and on any agent token.
3. **Private by default.** Nothing is published automatically.
4. **Stable at three.** The same line found in a new source adds to `seen_in`; a confirmed marker
   seen in three distinct sources becomes `stable`.
5. **"Not me" is final.** A rejected line is never proposed again for that person.
6. **At most three markers per source** per person (rejected ones not counted).
7. **Never pay.** Nothing in pay, Logstream or any score reads this table.
8. Every change is one engine event: `essence_marker_proposed`, `_seen_again`, `_stable`,
   `_confirmed`, `_rejected`, `_shared`, `_made_private`.

## `read_essence` contract

Input: `{ who: <Slack id or name>, include_test?: boolean }`.

Output:

```
{ ok: true,
  subject_id, subject_name,
  markers: [ { marker_id, kind, line, quote, status: "confirmed"|"stable", published,
               source_ref, seen_in, decided_at } ],   // stable first, then newest decision
  counts: { proposed, confirmed, rejected, stable },
  readiness: { stable_markers, confirmed_markers, last_confirmed_at },
  rules: [ ... ] }
```

Never returns a proposed or rejected marker. An unknown person is `ok: false, reason: unknown_person`.
The rules travel with every answer: private between the person and the engine, quote a marker to
anyone else only when `published` is true, never extend a marker into a judgement of the person,
never pay.

## Tools

- `read_essence`: read, both connections. **In no agent's scope until this contract is locked.**
- `propose_essence_marker`: write connection, no agent's scope, `dry_run`, audited kind `essence`.
- `decide_essence_marker`: write connection, no agent's scope, refused on any agent token.

## Not built yet

- The Layer 2 field in `Bays — Submit Actions` that proposes markers from each approved log.
- The "That's me" / "Not me" buttons in the builder's log channel (the tool is what they will call).
- The backfill over past logs.
- A BHARAG "Essence: <name>" document holding published markers only.
- Adding `read_essence` to agent scopes, after Canon.
