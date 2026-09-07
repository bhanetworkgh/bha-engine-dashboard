# BUILD_LOG

Running record of build work on the BHA Engine Dashboard. Append only.

---

## 2026-09-07 13:25 — Session 1: system exploration via connectors, no code

Intent:    Read CLAUDE.md and README.md, confirm the Slack / Google Drive / n8n
           connectors are attached, and build a first-hand picture of the engine
           from the live systems rather than from the spec alone. Explicitly no
           code this session.

Files:     BUILD_LOG.md (created — this file). No other changes.

### Connectors

Confirmed attached and enabled: **n8n**, **Slack**, **Google Drive**. Also
present in this workspace and enabled: Airtable, Notion, Sprouts. Not enabled:
Gmail, Google Calendar, Fireflies, Latenode.

All three required connectors returned live data. Nothing was modified anywhere —
n8n reads only, no Slack posts, no Drive writes.

### What the engine actually looks like

**n8n** — 62 workflows on `https://n8n.arupiautomates.cloud/`. The three
subsystems named in the spec are each a front door plus a set of subworkflows:

| Subsystem | Front door | Webhook | Error workflow |
|---|---|---|---|
| Bays | `Bays` (iEiBm8vn3JANZRR2) | `POST /webhook/bays` | Bays — Error Handler |
| Research Twin | `Research Twin` (9WiMmxrD74uAlc2H) | `POST /webhook/research-twin` | Research Twin — Error Handler |
| North Star | `North Star` (7MIlqO3IDCdno7PY) | `POST /webhook/north-star` | North Star — Error Handler |

All three share one front-door pattern: parse and classify the Slack payload →
dedupe on Slack `event_id` → loop-guard on `session_id` (30s TTL window, added
Aug 27 against Genie ↔ RT/NS bounce loops) → route. Bays routes to seven
destinations (`app_home`, `slash_command`, `submit`, `message_check`, `agent`,
`onboarding`, `callback_answer`); RT routes to three (`app_home`, `agent`,
`card_research`); NS routes to two (`app_home`, `agent`).

Each conversational agent sits behind a Tools Router. The routers are the real
data contract:

- **RT — Tools Router** (10 tools): `read_research_queue`, `write_research_finding`,
  `post_to_slack`, `send_callback_answer`, `compute_lane_state`,
  `write_commercial_card_fields`, `queue_followup_research`,
  `update_watched_client_question`, `create_client_report_doc`, `search_workspace`.
- **NS — Tools Router** (6 tools): `Get_Priority_Evidence`, `Query_North_Star_Cluster`,
  `Get_Capacity_Status`, `Send_Callback_Answer`, `Post_Answer_To_Slack`,
  `Read_Open_Loops`.

Storage, as read off the router nodes:

- Airtable bases: **BHA Research Queue** / Research Queue, **BHA Commercial
  Opportunities**, **Priority Ledger**, **Lane_status**, plus a watched-clients
  base (`appkSUSh9ijNjP2f8`) and a capped/reviewed table (`app4QnMJ2woiKlLc0`).
- **Open loops live in `appUVlBSGGPHw6DGh`, one table per builder** — Destiny,
  Jason, Kaiqi, Jegan, Ahad, Hardik, Kavin. `Read_Open_Loops` fans out across
  all seven with hardcoded table IDs, then merges.
- BHARAG2 at `https://bharag2.duckdns.org` — `/api/v1/cluster/ask`,
  `/api/v1/ingest`, `/api/v1/ingest/batch`, and the incident ledger at
  `/api/v1/incidents`, `GET /api/v1/incidents`, `POST /api/v1/incidents/:id/status`.

**Incidents.** The Bays Error Handler is the engine-wide catch: any workflow
naming it as its Error Workflow routes failures here. Flow is classify (Claude
via OpenRouter, five classes: `BILLING_QUOTA`, `NETWORK_TIMEOUT`,
`SCHEMA_VALIDATION`, `CONFIG_AUTH`, `UNKNOWN`) → check the last 24h for a repeat
of the same workflow + node → decide retryability (billing, config/auth and
schema never auto-retry) → open or transition an incident in the BHARAG ledger →
alert `#bha-pipeline-errors`. Retry policy on the payload is
`{ retryable, max_retries: 3, retry_interval: '5m', retries_attempted }`.
Subsystem is computed deterministically from workflow name and node prefix into
`CODEX`, `CHANNELARCHIVES`, `COMMERCIALOPPS`, `BUILDPATTERNS` or `AGENT` — the
server rejects underscores in `subsystem` (`INCIDENT_INVALID_SUBSYSTEM`) and
allocates the canonical `entity_id` itself.

**Slack** — `#bha-coordination`, `#workflow-logs-<builder>`, `#bha-pipeline-errors`,
`#bha-engine-alerts`, `#bha-daily-checkin`, `#bha-log-reviews`, `#bha-weekly-checkin`.

**Drive** — the contract library is real and readable. Most relevant to this
build: *BHA Build Pattern — Incident-to-Pay Loop v1 (RT / North Star / Logstream
Reference Contract)*, *Contract — Self-Healing Contract v1*, *BHA Build Pattern —
Alert Delivery v1*, *BHA_Narration_Guidance_v1.1.pdf*.

Problem:   No build problems — nothing was built. Four findings that block or
           change the Phase 1 fixture design:

           1. There is no state history to render. Destiny, in
              `#workflow-logs-destiny` on 2026-09-04, verbatim:
              "We have no engine-side history. Airtable rows overwrite in place,
              Codex entries are snapshots, RT and NS emit nothing. The only
              system with real state history is the incident ledger."
              Telemetry v1 and self-healing v1 started this week (Monday
              2026-09-07) and are Destiny's current primary objective.

           2. `evidence_shape_version` — required by CLAUDE.md §7 on the NS/RT
              Records tab — does not appear in the RT Tools Router at all, and is
              named in Slack (2026-09-06, Jason) as a *gap*: "the missing
              job-record/evidence_shape_version gap tied to autopay rule two."

           3. The four vFarm event types in CLAUDE.md §7
              (`burn_in_cycle_started`, `burn_in_anomaly`,
              `growth_cycle_started`, `growth_cycle_measurement_logged`) do not
              match what vFarm emits. Jegan, `#bha-coordination` 2026-09-07:
              vFarm writes to BHARAG ledger corpora, not documents —
              `vfarm.sensor` (3-minute place rollups: pH, temperature,
              humidity), `vfarm.alert` (threshold alerts, incident closes),
              `vfarm.vision`, via `POST /api/v1/ingest/batch`. Readiness is
              expected to surface at `/clusters/:id/readiness`, which per the
              Incident-to-Pay contract is not yet built.

           4. Open loops are mid-migration and currently inconsistent. Destiny's
              table alone: 311 total, 41 closed, 2 in progress, 268 open
              (2026-09-06). Two TEMP workflows dated Sept 5 exist to reclassify
              and repair misrouted loops. Live example today, 2026-09-07 in
              `#workflow-logs-kaiqi`: the digest told Kaiqi he had 3 open loops;
              `Read_My_Open_Loops` against his table returned 0.

Fix:       Not applicable — exploration only.

Decision:  1. Recorded the router tool lists and Airtable/BHARAG surfaces above
              as the starting point for the Phase 1 fixture shapes, so the mock
              contract is drawn from what the engine actually exposes rather than
              invented. Per CLAUDE.md §4 the mock shapes become the contract, so
              they should be derived, not guessed.
           2. Did not resolve the four findings above unilaterally. They are
              scope questions under CLAUDE.md §2 rule 5 and go to Destiny before
              any fixture is written.
           3. Did not write any code, per the session instruction.

Security:  Flagged, not changed. Two live service API keys are hardcoded in
           plaintext inside `Parse & Classify Event` code nodes — one in
           `Research Twin` (9WiMmxrD74uAlc2H), one in `North Star`
           (7MIlqO3IDCdno7PY). Both are the `x-api-key` gate for external asks.
           They are readable by anyone with n8n workflow read access and by any
           MCP client attached to this n8n instance. The RT one carries a comment
           saying it was rotated Aug 29 to the "locked 6-secret architecture."
           The values are deliberately not reproduced here, and nothing in this
           repo references them. Raised with Destiny in session; the fix is
           n8n credentials or environment variables, not a code node, and it is
           Destiny's call, not this repo's.

Blocked:   `BHA - log_engine_event` (j4gD7onkPGLadFBY) could not be read — n8n
           returned "Workflow is not available in MCP. Enable MCP access in
           workflow settings." Given the name, it is likely the telemetry writer
           and therefore directly relevant to this dashboard's data contract.
           Needs `availableInMCP` enabled before the next session.

Not done:  BUILD_LOG.md was not uploaded to Google Drive this session (CLAUDE.md
           §9). Holding until Destiny confirms the target folder.

---

## 2026-09-07 15:40 — Session 2: phase 1 UI against mock data

Intent:    Build the whole interface — all eleven screens, navigation, styling,
           auth gate, row interactions — against fixtures. No live wiring.

Files:     Scaffolding: package.json, vite.config.ts, tsconfig*.json, index.html.
           Design tokens and base styles: src/index.css.
           Data module: src/data/types.ts, src/data/fixtures.ts, src/data/index.ts.
           App shell: src/main.tsx, src/App.tsx, src/app/session.tsx,
           src/app/useData.ts, src/components/ui.tsx, src/components/Layout.tsx.
           Screens: src/screens/{Login,Overview,AskBays,Twin,VFarm,EngineHealth,
           OpenLoops,Codex,BuildPatterns,Commercial,Builders}.tsx.

           Stack is React 18 + Vite 6 + TypeScript + Tailwind v4 + React Router 6.
           Static build, no backend.

Problem:   1. Table rows wrapped to three and four lines, so Open loops showed
              about ten rows on a 1440x900 screen instead of thirty. Cause was
              `max-w-[52ch]` on a `<td>` inside a `table-layout: auto` table:
              the browser treats that as permission to shrink the column and
              wrap, which is the opposite of the intent.

           2. The Overview page rendered correctly but left the bottom third
              empty, because each 24-hour column held only five events.

           3. Gold at #d4b063 read as warm white at 17px rather than as an
              accent — the one value that matters per screen did not stand out.

           4. The Ask Bays idle mark rendered as a bright grey disc. public/logo.svg
              is a 68-path traced mark whose first path is a full-bleed #FDFDFD
              background square, so on a dark screen it reads as a lit plate.

           5. A first Playwright sweep reported every route as 199 characters —
              all of them the login screen. Not a routing fault: the session token
              is held in memory as specified, so `page.goto` on each URL reloads
              the app and signs out.

Fix:       1. Replaced wrapping cells with single-line clipped cells: new `.td-clip`
              (overflow hidden, ellipsis, nowrap) plus an inline `maxWidth`, with
              the full value on the `title` attribute. Row padding cut to 3px and
              line-height to 1.35. Rows are now 25.8px: 27 fully visible at 900px
              tall, 34 at 1080. Tags moved out of the title cell into their own
              column so a clipped title can never eat them.
           2. Extended both 24-hour lists to eleven events each, drawn from the
              same incident, loop, alert and Codex fixtures already on screen
              elsewhere, so the numbers still reconcile.
           3. Gold to #ddaa42, gold-dim to #8a6a24. Hue stays clear of amber
              (#e3873c) and red (#e2564d) so the three never read as one family.
           4. Circular clip on the mark, idle animation amplitude dropped to
              0.16–0.26 opacity. The logo file itself is untouched.
           5. Rewrote the sweep to sign in once and navigate via the sidebar,
              which is how the app is actually used.

Decision:  - **Every data function is async and takes a `Query`.** Fixtures could
             have been returned synchronously, but then tomorrow's swap to the
             live endpoint would force loading and error states into all eleven
             screens at once. Components already `await` through a `useData`
             hook that owns loading, failure and the lane filter. Phase 2 should
             be bodies-only inside src/data/index.ts.
           - **The lane filter is applied inside the data module**, not in
             components, so no screen filters by hand and the live endpoint can
             take the lane as a query parameter without touching the UI.
           - **Lane and subsystem vocabularies are the engine's, not invented**:
             VFARM_CORE / VFARM_MEDIA / CLIENT_CORE / ENGINE_INTERNAL from the
             three n8n front doors, and AGENT / CODEX / CHANNELARCHIVES /
             COMMERCIALOPPS / BUILDPATTERNS from the Bays error handler's
             computeSubsystem, extended with NORTHSTAR, RESEARCHTWIN, VFARM and
             BHARAG. Error classes and the 3-retry policy match the live handler.
           - **`evidence_shape_version` is rendered but mostly reads "not written."**
             Session 1 established it as a gap rather than a field. Showing the
             column empty is truer than hiding it or filling it in.
           - **Age on Open loops is labelled "days since raised", with a sentence
             on the page saying time in current status is not recorded.** No
             status-change timestamp exists to compute it from.
           - **vFarm is split three ways** — Live (sensor rollups, alerts,
             incident closes), Lifecycle (empty, with the reason), Readiness
             (empty, naming /clusters/:id/readiness as unbuilt) — matching what
             the ledger actually carries rather than CLAUDE.md section 7's four
             event types.
           - **The reconciliation view ships as a launch feature**, seeded from
             the real Sept 7 case where Kaiqi's digest named three loops his
             table did not hold.
           - Overview counts are derived from the fixture rows, not typed
             separately, so a screen and its tile cannot disagree.
           - Row actions all route through one `act()` helper that logs. One
             place to swap for real calls.

Verified:  `npm run build` passes (tsc -b + vite build, no errors).
           Driven in Chromium at 1440x900: all 11 routes render, all 14 sub-tabs
           render, row actions fire (`loop.close`, `incident.retry` observed on
           the console), builder detail resolves, the lane filter cascades
           through every screen and correctly empties vFarm under client core.
           Zero console errors and zero page errors across the sweep.
           Overview does not scroll at 900px tall.

Known:     - A browser refresh signs you out. The token is in memory by design
             for phase 1; nothing is persisted anywhere.
           - Per-owner loop totals (268 open) are larger than the 46 individual
             loop rows held as fixtures. The Open loops empty state and the
             builder detail page both say so rather than implying the rows are
             the whole set.
           - Sub-tab selection persists when navigating away and back. Left as
             is; it seems right for a panel someone keeps open all day.

Not done:  BUILD_LOG.md still not uploaded to Google Drive (CLAUDE.md section 9),
           pending Destiny confirming the target folder.
