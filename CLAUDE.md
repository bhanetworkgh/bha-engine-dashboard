# CLAUDE.md — BHA Engine Dashboard

Read this at the start of every session. It is the standing spec for this repo.

---

## 1. What this is

Bays Horizon Advisory (BHA) runs an automation engine on self-hosted n8n. It has
several subsystems: **Bays** (a Slack-facing AI agent), **Research Twin** (RT),
**North Star** (NS), **Codex** (builder session logging), **BHARAG** (the RAG /
storage platform), and **vFarm** (a physical vertical-farm product).

The engine has no window. Its state is scattered across Airtable bases, BHARAG,
and n8n's own execution history. Nobody can see it without opening six places by
hand.

**This repo is that window.** An internal dashboard for the BHA team — roughly
six people. Not a customer product.

Owner: Destiny Arupi, Engine Steward at BHA.

---

## 2. Hard rules

1. **No secrets in this repo.** API endpoint URLs and tokens are environment
   variables, injected at deploy. Never commit a `.env` with real values.
2. **No invented data on screen.** If a value isn't available, the UI says so.
   Never fill a panel with plausible-looking filler to make it look complete.
3. **Maintain `BUILD_LOG.md`** (see section 9). Append as you work, never
   rewrite earlier entries.
4. **This app never talks to Airtable, BHARAG, Slack or n8n directly.** It calls
   one endpoint. See section 4.
5. **Ask before changing scope.** If a section seems to need a backend, a
   database, or a new dependency, stop and raise it rather than building it.

---

## 3. Connectors — use them

This project has Slack, Google Drive and n8n connectors available. Run `/mcp`
in your first session and confirm they're attached.

Use them to ground your work rather than guessing:

- **n8n** — read the actual workflows to understand what the engine does and
  what data exists. Do not modify any workflow. Read only.
- **Slack** — search `#bha-coordination`, `#workflow-logs-destiny`,
  `#bha-pipeline-errors` for context on what the team is building and why.
- **Google Drive** — where session narrations and reference docs live, and where
  you upload `BUILD_LOG.md` at the end of each session.

---

## 4. Architecture

A static front end. No backend of its own.

```
Dashboard (this repo)  →  one JSON endpoint on the BHA engine  →  data sources
```

The engine endpoint fans out to Airtable, BHARAG and n8n execution history and
returns one response. The dashboard does not know or care where anything came
from.

**Phase 1 (now): build against mock data.** Put every fixture behind a single
data-access module — one file, one function per section. Swapping to the live
endpoint must be a change in that module only, never in components.

**Phase 2 (later): the live endpoint replaces the fixtures.** Design the mock
shapes to be plausible and consistent, because they become the contract.

**Auth:** one shared login for the whole team, same as BHARAG's console. Not
per-user accounts. Password is posted to the engine's login endpoint
(`VITE_AUTH_URL`), which returns a session token the app holds for the tab and
sends as a bearer on every engine call. No user management, no roles, no
signup. Without `VITE_AUTH_URL` the app runs a preview gate in local dev only.

---

## 5. Design

**Feel:** a modern consumer dashboard in the manner of Apple's account pages.
Calm, spacious, precise. Cool neutral surfaces, white cards, one blue accent.
Someone leaves this open on a second screen all day and it does not shout at
them. The reference is the "My Apple" mockup Destiny supplied on 2026-09-08.

- **Two themes.** Light and dark, switchable from the user menu in the sidebar,
  following the OS by default. Every colour is a token in `src/index.css`;
  components never name a hex value.
- **Palette:** cool light grey page (`#f5f5f7`) with white cards in light mode,
  near-black page with charcoal cards in dark. **One accent: system blue**, for
  links, the active tab, primary buttons, progress and focus. No gold, no
  terracotta, no orange as accent (decision 2026-09-08, Destiny).
- **Colour carries meaning.** Green dot = healthy. Amber = degraded. Red =
  failing. Amber and red appear only on a genuinely bad state, never on a
  label, a default, or a decoration. Coloured rounded-square **icon tiles**
  (blue, indigo, teal, green, purple, pink, graphite) are allowed on
  navigation-like affordances — quick actions, system tiles, list rows — and
  never on data values.
- **Cards on paper.** 18px radii, a soft shadow, no hairline border. The
  Overview opens with a greeting and a gradient summary banner whose numbers
  are read from the data; the banner's floating chips may drift gently. That,
  the idle mark on Ask Bays and a short fade-in are the only animations.
- **Density inside a card.** Real tables, tight rows, thirty visible. Charts
  are small inline SVG, never a library.
- **Type:** Inter, falling back to the system sans. Semibold for titles and
  headline numbers, medium for labels, regular for everything else. No serif.
- **Sentence case everywhere.** Never Title Case, never ALL CAPS.
- **Every row does something.** Hover reveals its actions inline. Never bury
  actions in a menu.

---

## 6. Navigation

Fixed left sidebar, grouped, with the shared account (Admin) at the bottom
opening Settings and Sign out. Main content fills the rest. Top right: date,
time, weather when the browser shares a location, and the theme toggle. No
status strip. Ask Bays hides the top row and gives its history panel the full
height.

```
Home (the Overview)
Ask Bays

SYSTEMS
  North Star
  Research Twin
  vFarm
  Engine health          ← red count badge when incidents are open

RECORDS
  Open loops
  Codex entries
  Build patterns
  Commercial

PEOPLE
  Builders
```

North Star, Research Twin and vFarm each have four in-page sub-tabs:
**Summary · Records · Runs · Gaps**. Sub-tabs live inside the page, not as
sidebar dropdowns.

---

## 7. What goes on each screen

### Overview
One tile per sidebar section, each showing its headline number and its worst
current signal. Clicking a tile navigates into that section.

Pinned across the top: days to Halloween (the vFarm deadline), vFarm status,
open incidents, open loops, entries logged this week.

Below: two columns — **what broke in the last 24 hours**, **what moved in the
last 24 hours**.

Overview is a scrolling page: greeting, summary banner, systems, then cards.
The first screen must carry the greeting, the banner and the systems row.

### Ask Bays
A chat interface onto the existing Bays agent.

Empty state: the BHA mark centred, large, with a slow subtle idle animation.
Input bar pinned to the bottom. Nothing else on screen until the user types.
On first send, the mark gives way to the thread.

Right-hand panel: new chat, chat history list, search past chats.

**Note:** Bays has no memory today. Build the history and new-chat UI fully
against fixtures. It gets wired in a later phase.

### North Star / Research Twin
- **Summary** — asks this period, split answered / thin / failed, median time to
  answer, top askers, breakdown by lane.
- **Records** — the ask log. Question, who asked, session, lane, cycle, outcome,
  `evidence_shape_version`.
- **Runs** — the attempt record. Which searches fired, what each returned, which
  came back empty, how the run ended.
- **Gaps** — what came back empty or thin and is still unanswered, plus the
  transition list: items that went thin and were later answered.

### vFarm
Timeline of four event types: `burn_in_cycle_started`, `burn_in_anomaly`,
`growth_cycle_started`, `growth_cycle_measurement_logged`.

Current rack state, last measurement, open anomalies, and a readiness panel that
answers "is vFarm on track for Halloween" directly.

### Engine health
Incidents and self-healing.

- Incident list, each showing its position in the state machine: new → triage →
  auto-retry pending → resolved / failed → escalated to RT / escalated to human.
- Duplicates collapsed by fingerprint so one flapping error doesn't flood the
  list.
- Metrics row: self-heal rate, retries attempted vs succeeded, mean time to
  resolve, escalation count, lanes that have hit their retry ceiling.
- Per incident, the action footprint: action type, actor, outcome, reason.

### Open loops
The densest screen.

- Every loop with **time-in-status**, sorted oldest first. That number is the
  headline signal on this page.
- Grouped by owner, so you can see where work is piling up and on whom.
- Open, update and close a loop directly from the interface.
- A separate **review queue** for stale loops: each proposed close carries its
  supporting citation and a reason. The user approves or rejects. **Nothing ever
  auto-closes.**
- A reconciliation view for loops that went missing during data migration.

### Codex entries / Build patterns / Commercial
Entries by builder and week, session type, link to the narration, and whether
each was ingested into BHARAG or only posted. Patterns by lane and how often
referenced. Commercial opportunities with their readiness state.

### Builders
One row per person: lane, open loops, oldest loop age, last activity, contract
status, entries this week. Click through to that person's detail page.

---

## 8. Rules that apply to every row, on every screen

- **Four-field spine** on every record: `session_id`, `builder_id`,
  `subsystem`, `lane`. The lane filter lives in session state and the data
  module honours it; the dropdown was removed from the shell on 2026-09-08
  (Destiny) and can return as a page-level control when a screen needs it.
- **Tags rendered where present:** `pay_eligible`, `is_incident`,
  `self_healed`. Small, quiet, consistent everywhere.
- **Every row links back to its source** — Slack message, Airtable record, or
  n8n execution.
- **Empty states name what is missing and why.** Several Gaps tabs will be empty
  at launch. The correct empty state is a plain sentence explaining that nothing
  is recording this yet — not a shrug icon, and never filler rows.

---

## 9. BUILD_LOG.md

Maintain `BUILD_LOG.md` in the repo root. Append as you work — not a summary
written at the end.

Each entry:

```
## YYYY-MM-DD HH:MM — short title
Intent:     what you set out to do
Files:      which files changed
Problem:    what broke, with the error text verbatim
Fix:        what resolved it
Decision:   any choice made, and why
```

Never rewrite or condense earlier entries. This file is the source for BHA's
session narrations, so specificity matters more than tidiness.

At the end of each session, upload the current `BUILD_LOG.md` to Google Drive
via the Drive connector.

---

## 10. Session start checklist

1. Read this file.
2. Read `README.md`.
3. Run `/mcp` and confirm Slack, Drive and n8n are attached.
4. Read `BUILD_LOG.md` to see where the last session ended.
5. State what you plan to do before doing it.
