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

---

## 2026-09-07 17:05 — Session 3: repo organisation and deployability

Intent:    No feature or visual changes. Restructure src/ so it is navigable,
           confirm the app is deployable to Render as a static site, and report
           on responsiveness without fixing anything.

Files:     src/data/fixtures.ts split into src/data/fixtures/{common,loops,
           incidents,twins,vfarm,codex,patterns,commercial,builders,chat,index}.
           src/components/ui.tsx split into src/components/ui/ (11 files + barrel).
           New src/lib/{format,health,actions,cx,index}.
           src/screens/{Twin,OpenLoops,VFarm,EngineHealth,Builders}.tsx became
           folders with sub-views and an index.
           README.md: new "Repo layout" section, expanded "Deployment".

Problem:   1. Splitting fixtures broke the `LoopSeed` tuple type. `owner` is typed
              `keyof typeof BUILDER_NAMES`, and I moved BUILDER_NAMES to common.ts
              without importing it into loops.ts:
                `src/data/fixtures/loops.ts(17,23): error TS2304: Cannot find name
                 'BUILDER_NAMES'.`
              The unresolved name widened `keyof` to `string | number | symbol`,
              which then failed against `Loop['owner']: string` — three errors from
              one missing import.

           2. Slicing JSX out of the vFarm and EngineHealth tab conditionals carried
              the conditional's own closing token into the extracted file:
                `src/screens/VFarm/Live.tsx(152,3): error TS1128: Declaration or
                 statement expected.`
              Each sub-view ended `)}\n);\n}` instead of `);\n}`.

           3. EngineHealth's incident block is a JSX expression container
              (`{cond ? (...) : (...)}`). Lifted verbatim into a `return`, the braces
              are a syntax error:
                `src/screens/EngineHealth/IncidentTable.tsx(32,12): error TS1005:
                 ',' expected.`

           4. My first EngineHealth/Builders split used guessed line numbers and
              produced malformed files. I had already `rm`'d the sources, and those
              two files carried uncommitted edits from earlier in this session, so
              the edits were lost.

           5. `npm ci` (run to verify a clean build) deleted node_modules including
              Playwright, which was installed with `--no-save` and is therefore not
              in package.json. The next verification run failed with
              `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'`.

Fix:       1. Imported BUILDER_NAMES into loops.ts. All three errors cleared.
           2. Stripped the trailing `)}` from each extracted sub-view.
           3. Removed the outer braces so the conditional is returned as an
              expression rather than a JSX container.
           4. Restored both files from HEAD, re-applied the lost import and label
              edits, then re-split using boundaries *located by content*
              (`grid shrink-0 grid-cols-6`, `data.incidents.length === 0`) rather
              than guessed line numbers.
           5. Reinstalled Playwright with `--no-save` and confirmed package.json and
              package-lock.json were untouched.

Decision:  - **Verified equivalence by pixel diff, not by eye.** Captured 30
             screenshots before the refactor, repeated the identical sweep after,
             and byte-compared. All 30 identical; character and row counts per route
             identical too. That is the evidence that "no visual changes" holds.
           - **Moved `healthText`, `act` and `ageTone` into src/lib/** rather than
             re-exporting them from components/ui. `ageTone` had been copy-pasted
             into OpenLoops and Builders; there is now one definition.
           - **Added `laneLabel`/`subsystemLabel`/`errorClassLabel`** and replaced
             eight inline `.toLowerCase()` calls. Same output, but the sentence-case
             rule is now stated once instead of being re-derived at each call site.
           - **Removed four dead exports**: `Metric` (a UI primitive nothing used),
             and `TODAY`, `HALLOWEEN`, `sources` from the fixtures. All three
             fixture consts were dead before this session. Dead primitives are
             exactly what makes a repo hard to read, which is what this session was
             for. `cx` is new and is used by Layout.
           - **Screens under ~200 lines stayed flat.** Overview, AskBays, Codex,
             BuildPatterns, Commercial and Login are single files; only the five
             over the line became folders.
           - **No Render config file committed.** The rewrite rule is a host
             setting I cannot verify from here, so README states what is needed and
             why, and leaves the change to the dashboard.

Verified:  `npm ci && npm run build` from a wiped node_modules and dist: passes.
           dist/ contains index.html, logo.svg and assets/ (one css, one js).
           Route sweep after refactor: all 11 routes, all 14 sub-tabs, row actions
           firing, builder detail, lane filter. Zero console errors.
           Deep-link behaviour tested against a plain static server (python
           http.server on dist): `/` and `/assets/*` return 200; `/open-loops`,
           `/vfarm` and `/builders/destiny` return 404. Confirmed the build does
           not solve client-side routing and a host rewrite is required.

Known:     Responsiveness measured at 1920, 1440, 1024, 768 and 390, reported to
           Destiny, deliberately not fixed. Summary: fine at 1920/1440/1024;
           cramped but usable at 768; broken at 390. The sidebar is a fixed 188px
           at every width and never collapses, which is the root cause at 390 —
           it leaves 202px of content and the five-column pin grid gives each pin
           about 40px. Overview's tile grid does drop 5→3 columns below 1024, but
           the pin row has no breakpoint at all.

Not done:  BUILD_LOG.md still not uploaded to Google Drive (CLAUDE.md section 9),
           pending Destiny confirming the target folder.

---

## 2026-09-07 18:40 — Session 4a: responsive layout

Intent:    Make the dashboard usable below 1024 without changing anything at
           1024 and above. Layout only — no behaviour, data, copy or colour.

Files:     src/index.css (a single max-width:767.98px block).
           src/components/Layout.tsx (drawer sidebar, hamburger, status strip).
           src/components/ui/PageHeader.tsx, src/components/ui/Table.tsx.
           src/screens/Overview.tsx, AskBays.tsx, Codex.tsx, Commercial.tsx,
           BuildPatterns.tsx, and the OpenLoops/, Twin/, VFarm/, EngineHealth/,
           Builders/ folders.

Problem:   The first pass failed the 1440 pixel diff: 29 of 30 screenshots
           differed. Only the login screen matched, which localised it to
           Layout — the one component on every other screen.

           Diffing the images rather than guessing gave the answer immediately:

             07-Open-loops.png  bbox=(215, 20, 216, 21) differing_px=1
             01-Overview.png    bbox=(215, 20, 216, 21) differing_px=1
             11-Builders.png    bbox=(215, 20, 216, 21) differing_px=1

           One pixel, same coordinate on every screen: the first glyph of the
           incident banner in the status strip. Adding `truncate` to that span
           set `white-space: nowrap` and `overflow: hidden`, which shifted the
           text rendering by a single subpixel even though nothing overflowed
           at 1440.

Fix:       Scoped the truncation to `max-lg:truncate` and the parent to
           `max-lg:min-w-0`, so it applies below 1024 and not at or above it.
           That is also what the brief actually asked for — banner truncation is
           a 768-to-1024 fix, not a desktop change. Re-ran the diff: 30 of 30
           byte-identical.

Decision:  - **Tables become cards through CSS, not a second component tree.**
             One `.table-cards` class on the table, and cells opt in with
             `card-title`, `card-meta`, `card-full` or `card-actions`. Below 768
             the rows become flex containers and any cell without one of those
             classes is `display: none`. The four spine fields are still in the
             DOM and still in the data; they are simply not shown on a phone.
             `flex order` puts the title first regardless of column order, so no
             screen had to reorder its markup.
           - **Card fields per the brief**: open loops (age, title, owner,
             status), engine health (id, summary, error class, state), twin
             records (question, outcome, cycle), vFarm (place, reading, time),
             codex (title, builder, ingested), and the equivalent three or four
             elsewhere.
           - **`.card-title` needs `max-width: none !important`** because the
             clipped desktop cells carry an inline `style={{ maxWidth }}`, and a
             stylesheet `!important` is the only thing that beats an inline
             style.
           - **Row actions become always-visible below 768** with 44px minimum
             tap targets, since hover does not exist on touch. Measured live:
             57x44, 68x44, 106x44.
           - **Two drawers, same pattern**: the sidebar and the Ask Bays history
             panel are `hidden` below md and `fixed` overlays when open, with
             `md:static md:flex` restoring the desktop column exactly. Both close
             on a backdrop tap and on selecting an item.
           - **Metric strips drop to 2 columns below md** (engine health 6, vFarm
             6, commercial 5, builder detail 5, twin summary 5, codex 4). Not
             named in the brief, but a six-column strip at 390 is the same
             failure as the pin row and the brief asked for no horizontal
             overflow at any width.
           - **The per-owner strip on Open loops scrolls horizontally below md**
             rather than crushing eight buttons into 390px.
           - **Twin Summary's two small tables stay real tables.** They are two
             and four narrow columns and already fit a phone; carding them would
             have made them worse.

Verified:  1440 pixel diff: 30 of 30 byte-identical, before and after.
           No horizontal body overflow at 1920, 1440, 1024, 768 or 390 —
           document.scrollWidth equals window.innerWidth at every width.
           At 390: nav computes to `display: none` closed and `flex` open;
           hamburger visible; backdrop tap and link tap both close it; the chat
           drawer opens, renders a stored thread and closes on selection;
           `.table-cards tbody tr` computes to `display: flex`.
           At 768: pin row is 3 columns matching the tile grid, the banner
           ellipsises, and sign out no longer wraps.
           Zero console errors at any width. Build passes.

Known:     Engine health still reports horizontal slack inside its own table
           container at 1024 and above (1001px at 1024). That is the intended
           behaviour at those widths — the table scrolls in place — not overflow
           of the page.

---

## 2026-09-07 19:20 — Session 4b: login screen

Intent:    Two-field login with real validation, a persisted session, and the
           explanatory paragraph removed. Login screen only.

Files:     src/screens/Login.tsx, src/app/session.tsx.

Problem:   None. The only thing worth recording is that this change deliberately
           breaks the pixel-diff invariant used for the responsive work, so the
           two jobs were committed separately: the responsive diff was proven at
           30 of 30 identical first, and only then was the login touched. The
           second diff run excludes 00-login.png and holds at 29 of 29.

Fix:       Not applicable.

Decision:  - **Email is checked against a constant; the password is not checked
             at all** and is never stored. That is stated in a comment directly
             above the check in session.tsx, so nobody reads this as security.
             Real verification moves to the engine endpoint in phase 2, which is
             what will return the session token.
           - **Two distinct errors, as asked**: an empty field gives "Enter an
             email address and a password."; a non-matching email gives "Not a
             recognised account." The button never silently no-ops.
           - **Email comparison is trimmed and lower-cased.** Typing
             `Admin@BHANetwork.org` on a phone keyboard should not read as a
             different account.
           - **Session moved from memory to sessionStorage**, so a refresh no
             longer signs you out. Every read and write is wrapped — sessionStorage
             throws in some private-browsing modes, and a failed read should mean
             "no session", not a blank screen. Sign out clears the key.
           - **sessionStorage, not localStorage**, per the brief. It clears when
             the tab closes, which suits a shared team credential better than a
             login that persists on a machine indefinitely.
           - The paragraph under the button is gone entirely: mark, two fields,
             button.

Verified:  Empty submit, email-only submit, wrong email, and correct credentials
           all behave as specified, checked live in the browser. Refresh keeps the
           session; a direct load of /open-loops arrives signed in and renders 46
           rows; sign out clears both the state and the storage key.
           Field types are email and password. No paragraph remains in the form.
           1440 diff excluding login: 29 of 29 byte-identical. Build passes, no
           console errors.

Known:     The deep-link check passes under `vite dev` because the dev server
           serves index.html for unknown paths. In production that still depends
           on the host rewrite documented in README under Deployment.

---

## 2026-09-08 11:10 — Session 5: UI overhaul, auth, loop actions, Ask Bays wiring

Intent:    Destiny's brief, verbatim in spirit: the dashboard "looks completely
           horrible"; make it "ultra modern" — "as if Claude and Apple decided
           to do a collaboration". Overview should be a real dashboard with
           metrics, percentages and charts, each card opening its system. Open
           loops should filter by builder and by open / in progress / closed,
           update live, and let you open or close a loop from the page. Put
           actual authentication in place. Wire Ask Bays to the real workflow
           through the callback URL pattern. Add light and dark mode. The gold
           and black palette is no longer required.

Files:     Design system: src/index.css (rewritten), src/app/theme.tsx (new),
           src/main.tsx, src/vite-env.d.ts (new).
           Primitives: src/components/ui/{Card,Charts,Icons,Tabs}.tsx (new),
           Dot, EmptyState, LoadFailed, Loading, PageHeader, RowActions,
           SourceLink, Table, TagRow (restyled), index.ts.
           Shell: src/components/Layout.tsx (rewritten).
           Data: src/data/engine.ts (new), src/data/index.ts (overview series,
           rates, auth, Bays send/poll, loop mutations), src/data/types.ts,
           src/data/fixtures/loops.ts (ten closed loops, closed counts).
           Session: src/app/session.tsx (rewritten).
           Screens: Overview, Login, AskBays, OpenLoops/{index,Loops,NewLoop,
           ReviewQueue,Reconciliation} rewritten; Twin/{index,Summary,Gaps,
           Records,Runs}, VFarm/{index,Live}, EngineHealth/{MetricsRow,
           IncidentTable,StateTrack}, Codex, BuildPatterns, Commercial,
           Builders/{List,Detail} restyled onto the new primitives.
           Docs: README.md (env vars, contracts, layout), CLAUDE.md section 5
           and the auth paragraph in section 4.

Problem:   1. `src/data/engine.ts(10,25): error TS2339: Property 'env' does not
              exist on type 'ImportMeta'.` The repo had no Vite client types
              reference, so `import.meta.env` was untyped.
           2. `src/data/index.ts(688,34): error TS1355: A 'const' assertions can
              only be applied to references to enum members, or string, number,
              boolean, array, or object literals.` — an `as const` on a
              ternary expression inside an arrow function.
           3. First render of the Overview bottom row at 1440 gave the two chart
              cards about 125px each: builder names truncated to "De…" and the
              card titles wrapped to four lines.
           4. The BHA mark (public/logo.svg carries a full-bleed #FDFDFD plate
              as its first path) rendered as a bright grey disc on every dark
              surface — sidebar, login, the Ask Bays idle mark.
           5. Making the row-action column sticky with a panel-coloured
              background hid the columns beneath it whenever the table was
              wider than its container, because the invisible (opacity 0)
              actions still occupied a painted 330px cell.
           6. The Overview's "what broke" events referenced loop rows by array
              index (`f.LOOPS[f.LOOPS.length - 2]`), which the ten appended
              closed-loop seeds would have silently pointed at the wrong row.

Fix:       1. Added src/vite-env.d.ts with `/// <reference types="vite/client" />`.
           2. Typed the helper's return explicitly instead of asserting.
           3. Bottom row grid is now `240px 260px 1fr 1fr` at xl; the engine
              card's self-heal block was tightened to three short lines.
           4. A `.mark` class: in dark mode the image gets
              `filter: invert(1) hue-rotate(180deg)`, which turns the white
              plate near-black and rotates the inverted gold back to warm. The
              SVG file itself is untouched.
           5. The sticky cell is transparent at rest and only takes the hover
              colour when its row is hovered or focused — at which point it
              matches the row, so covering scrolled-under cells is invisible.
           6. Overview events now look loops up by id (`loopById`).

Decision:  - **Tokens, not colours.** Every colour is a CSS variable defined once
             for light and once for dark in index.css, exposed to Tailwind via
             `@theme inline`. Components use `bg-panel`, `text-dim`, and so on;
             none names a hex. `gold` and `gold-dim` remain as aliases of the
             accent so nothing untouched breaks.
           - **Palette.** Warm off-white paper (#f4f3ef) and warm charcoal
             (#151412), white / warm-dark cards with 14px radii and a hairline,
             one terracotta accent. Amber and red still carry meaning only.
             CLAUDE.md section 5 updated to say so, with the date, so the next
             session does not restore gold and black from the old spec.
           - **Type.** System sans everywhere; a serif display face (Iowan Old
             Style / Charter / Georgia) for page titles and headline numbers
             only. Still two weights. On the Linux screenshot box it falls to
             DejaVu Serif; on the team's Macs it will be Iowan.
           - **Charts are inline SVG in src/components/ui/Charts.tsx**, no
             dependency (CLAUDE.md rule 5). Sparkline, Bars, HBar, Ring, Band.
             Every series is derived in the data module from fixture rows that
             already exist — loops per day from `raised_at`, incidents per day
             from `opened_at`, entries per ISO week, asks by outcome, incidents
             by class. Nothing on the Overview is typed in as a number.
           - **Overview still fits one screen.** Measured: `main` scrollHeight
             equals clientHeight at 1440x900 in both themes. The bottom row
             scrolls inside its cards, not the page.
           - **Open loops.** Builder picker (Everyone + one per builder, with
             count and oldest age), a segmented status filter (open / in
             progress / closed / all, each with a count) and row actions:
             Close, Start, Back to open, Reopen. Actions call
             `setLoopStatus` in the data module; the page holds a working copy
             and updates the row in place, with a toast. `createLoop` opens a
             new loop from an inline form. When `VITE_ENGINE_API_URL` is set
             these become `PATCH /loops/:id` and `POST /loops`; otherwise they
             mutate the held fixtures and keep the per-owner totals in step.
             Ten closed loops were added to the fixtures so the closed filter
             has something to show; their `closed_at` is set explicitly.
           - **Auth.** `signIn` in the data module posts the credential to
             `VITE_AUTH_URL` (defaulting to `<api>/auth/login`) and returns
             the engine's session `{token, expires_at, label}`. The session
             provider stores it in sessionStorage, installs it as the bearer
             on the engine client, signs out at the expiry the engine gave, and
             signs out on any 401. Three modes, shown on the login screen:
             `engine` when the URL is set; `preview` in local dev or with
             `VITE_AUTH_PREVIEW=1` (email checked, password not — stated on the
             screen); `none` otherwise, where the button is disabled and the
             screen says which variable is missing. So a production build with
             nothing configured admits nobody, which is what "actual auth"
             has to mean for a static site.
           - **No n8n workflow was created for auth.** Rule 5 says ask before
             adding a backend. The client side and the endpoint contract are
             done and documented in README; standing up the login endpoint is
             Destiny's call.
           - **Ask Bays.** Read from the live `Bays` workflow (iEiBm8vn3JANZRR2)
             on 2026-09-08: the external-ask shape at Parse & Classify is
             `prompt, session_id, builder_id, lane_id, source` plus a delivery
             target — `callback` (an http(s) URL) and/or `channel_id` — gated by
             `x-api-key`. The Respond to Webhook node fires straight off the
             Webhook with an empty body; the Conversational Agent runs with
             `waitForSubWorkflow: false`. So the answer never comes back on
             the request; it goes to the callback. `sendToBays` posts exactly
             that shape; `pollBaysAnswer` reads `VITE_BAYS_ANSWER_URL` until an
             answer or a two-minute timeout. The Dedup Check's 30-second loop
             guard on `session_id` is enforced as a per-thread cooldown in the
             composer, with a countdown in the placeholder, because the
             workflow would otherwise drop the second message silently.
           - **Every wiring state is stated on screen**, from `getBaysWiring`:
             not connected (no URL/key), no delivery target, connected but no
             answer endpoint (answer goes to Slack or the callback and will not
             appear here), and fully connected. A message that was not sent
             says so under the bubble. Nothing pretends a reply is coming.
           - **Chat history persists in localStorage**, seeded threads plus
             anything typed here, because Bays holds no memory and the panel
             said "stored by this dashboard". A session_id is minted per thread
             (`DASH-…`) and shown under the composer.
           - **The `x-api-key` in a VITE_ variable is in the bundle.** Flagged
             in README. The proper shape is a proxy route on the engine
             endpoint; the direct mode exists so the round trip can be tested
             before that route is built. Nothing in this repo contains the key.
           - **Sticky action column** on every table so reaching an action
             never scrolls the title away — visible in the first sweep when
             Playwright's hover scrolled the loop table 300px right.
           - **Sentence case on every row action** (Close, Re-run, Open in
             Slack); the old lower-case labels read as unfinished next to the
             new type.

Verified:  `npm run build` passes (tsc -b + vite build). Playwright sweep at
           1440x900 in light and in dark: login, all eleven routes, all sub-tab
           screens render; zero console errors, zero page errors, no horizontal
           overflow on any route. Open loops: closing the first row drops the
           open count 43 → 42 and the closed filter shows 11 (ten seeded plus
           the one just closed); the new-loop form adds a row and the open
           count returns to 43. Ask Bays with nothing configured: the message
           lands in the thread with "not sent" under it and the amber wiring
           note above the composer. Overview: `main` scrollHeight 840 =
           clientHeight 840, both themes. Phone at 390: drawer opens and
           closes, loops become cards, no overflow.

Known:     - The answer store behind `VITE_BAYS_CALLBACK_URL` /
             `VITE_BAYS_ANSWER_URL` does not exist on the engine. Until it
             does, a configured front door will accept the ask and the
             dashboard will say the answer went to the callback or Slack.
           - The Bays front door's CORS is n8n's default; if the browser
             preflight is refused in production the `x-api-key` header is the
             reason, and the fix is the engine-side proxy route above.
           - The tile grid on Overview is five across with four on the second
             row; the empty slot is accepted rather than stretching one tile.
           - Review queue approve/reject and reconciliation actions still log
             through `act()`; only loop status and creation are real writes.

Not done:  BUILD_LOG.md still not uploaded to Google Drive (CLAUDE.md section 9),
           pending Destiny confirming the target folder.

---

## 2026-09-08 11:30 — Session 6: the shared team credential

Intent:    Make sign-in real now, ahead of any engine login endpoint. Destiny
           supplied the one email and password the dashboard should accept.
           Only that pair may sign in.

Files:     src/data/index.ts (auth section rewritten), src/data/engine.ts
           (VITE_AUTH_EMAIL / VITE_AUTH_PASSWORD_SHA256 overrides replace
           VITE_AUTH_PREVIEW), src/app/session.tsx, src/screens/Login.tsx,
           src/components/Layout.tsx, README.md.

Problem:   CLAUDE.md rule 1 says no secrets in the repo, and the password was
           handed over in chat. Committing it in plain text was out. A static
           site has no server to hold it either.

Fix:       The repository holds only a SHA-256 digest of `<email>\n<password>`
           (email lower-cased). At sign-in the browser hashes what was typed with
           Web Crypto and compares. The plaintext appears nowhere in the tree or
           the built bundle (grepped both). A random fourteen-character password
           is not recoverable from its digest, so the digest is not a secret in
           the sense the rule guards against.

           The digest and the email can both be overridden on the host with
           VITE_AUTH_PASSWORD_SHA256 and VITE_AUTH_EMAIL, so rotating the password
           is a Render setting change, not a commit. The README shows the one-line
           command that produces a new digest.

           Five wrong attempts pause sign-in for thirty seconds. A session is a
           random 24-byte token in sessionStorage with a twelve-hour expiry, so a
           refresh keeps you signed in and closing the tab does not.

Decision:  - **The engine path stays.** When VITE_AUTH_URL is set the pair is
             posted to the engine instead and the digest is not consulted. The
             browser check is the current mechanism, not the final one.
           - **VITE_AUTH_PREVIEW is gone.** There is no longer an email-only gate
             anywhere; the password is always checked.
           - **This gates the interface, not the data.** The comparison runs in
             the browser, so it stops the team's neighbours, not a determined
             attacker with the bundle. Today the data behind it is fixtures. When
             the live endpoint lands, its bearer token is the real control.
           - **Email comparison is case-insensitive**, digest comparison is
             exact. `Admin@BHANetwork.org` with the right password signs in.

Verified:  Driven in Chromium: wrong password rejected, wrong email rejected,
           upper-cased correct email accepted, five wrong attempts then a
           thirty-second lockout message, the correct pair signs in, the stored
           session carries a token and a twelve-hour expiry, a reload stays
           signed in, the sidebar reads "BHA team · mock data". `npm run build`
           passes; the plaintext password is absent from dist/. No page errors.

---

## 2026-09-08 13:40 — Session 7: the Apple-style redesign

Intent:    Destiny's verdict on session 5: it looked like a Claude clone, and
           the terracotta and amber were everywhere. He supplied a "My Apple"
           account-page mockup as the reference and asked for it to be applied
           throughout: greeting header, gradient summary banner, coloured icon
           tiles, white cards on cool grey, blue as the only accent.

Files:     src/index.css (tokens, tiles, hero, chips, nav), index.html (Inter),
           src/components/Layout.tsx (sidebar with user menu, top chips),
           src/screens/Overview.tsx (rewritten), src/app/session.tsx ("me"),
           src/lib/health.ts, src/components/ui/{Icons,PageHeader,TagRow}.tsx,
           src/screens/OpenLoops/Loops.tsx, src/screens/AskBays.tsx, CLAUDE.md.

Problem:   1. The mockup greets a named person, but the login is shared and
              carries no identity.
           2. Amber appeared on seven of nine system tiles because the health
              thresholds are strict (any unanswered gap, any unsigned contract).
              The data is honest; the page read as alarmed.
           3. The Google Fonts request fails inside the sandbox browser
              (ERR_CONNECTION_RESET), so screenshots render in the fallback
              face. Not a code fault; the sandbox has no outbound browser
              network.

Fix:       1. A "who is at the keyboard" preference, `bha.me` in localStorage,
              chosen from the builder list in the sidebar's user menu. It
              drives the greeting, the banner, and the default asker on Ask
              Bays. It is a display preference, not identity: the login stays
              shared and nothing is attributed to it.
           2. The dot keeps its colour; the word "Degraded" goes grey. Red text
              is kept only for failing. Loop status pills are neutral (open),
              blue (in progress) and green (closed). The incident tag is no
              longer amber.
           3. Inter is loaded with `display=swap` over a system fallback, so
              the deployed site gets it and nothing waits on it.

Decision:  - **Blue is the only accent.** Gold, terracotta and orange are gone
             from the tokens; `--color-gold` remains only as an alias of the
             accent so nothing compiles against a missing name.
           - **Healthy dots are green.** CLAUDE.md said healthy carries no
             colour; the reference uses green "Online". Green is now allowed
             on a status dot and nowhere else. Recorded in CLAUDE.md section 5.
           - **Coloured icon tiles are allowed on navigation-like affordances**
             (system tiles, quick actions, list rows) and never on data values.
             Also in section 5.
           - **Overview scrolls now.** The one-screen rule is replaced by "the
             first screen carries the greeting, the banner and the systems
             row." Section 7 updated.
           - **The summary banner is composed from the data**, not written:
             open incidents, open loops, entries this week, how many systems
             are not healthy, days to Halloween. Its three floating chips drift
             a few pixels; that and the idle mark are the only motion.
           - **No serif.** Inter semibold for titles and headline numbers.
           - **The status strip is gone.** Date, engine health and the lane
             filter sit as chips at the top right of the content, as in the
             reference; theme and sign-out live in the user menu.

Verified:  Chromium sweep at 1440x900 in light and dark: all eleven routes
           render, loop close and create still work, Ask Bays still states its
           wiring, no page errors, no horizontal overflow. Phone at 390 renders
           the greeting, banner and systems grid. `npm run build` passes.

---

## 2026-09-08 14:30 — Session 8: Destiny's edit list on Home and Ask Bays

Intent:    Apply the round of edits Destiny gave on the redesign: strip the
           top-right down to date, time and weather; remove the lane dropdown
           and the engine-health chip; theme toggle top-right; "BHA Engine";
           the user block becomes Admin with Settings and Sign out only;
           greeting "Good afternoon, Admin"; live numbers in the banner and a
           fourth floating element; matched row heights; one colour per
           system; no health words on the system tiles; Ask Bays panel full
           height with pin / rename / delete, a working search, a hide control,
           the model label and a microphone; soft motion throughout.

Files:     src/components/Layout.tsx, src/screens/Overview.tsx,
           src/screens/AskBays.tsx, src/screens/Settings.tsx (new),
           src/app/useWeather.ts (new), src/app/session.tsx, src/App.tsx,
           src/data/{index,types,engine}.ts, src/components/ui/Icons.tsx,
           src/index.css, CLAUDE.md.

Problem:   1. The banner's "Open loops" was open only, and Halloween was the
              literal string "54". Neither would have moved.
           2. Weather needs a location and a source; the dashboard has neither
              and the rule is no invented data.
           3. The builder picker was the only thing giving the greeting a name.
           4. Chat threads seeded from fixtures could not be pinned, renamed or
              deleted without coming back on the next load.
           5. Removing the lane dropdown contradicts CLAUDE.md section 8, which
              says lane must be filterable from the status strip.

Fix:       1. Open loops is now open plus in progress across every builder
              table, read at render time; closing a loop from the interface
              moves it. Days to Halloween is computed from today's date each
              time the Overview loads (`daysToHalloween()` in the data module).
              Open incidents was already live.
           2. `useWeather` asks the browser for its location and, if granted,
              reads Open-Meteo (no key). If either is refused the chip shows
              date and time only. The result is cached for thirty minutes in
              sessionStorage. This is the one call the dashboard makes to a
              third party, and it carries no engine data.
           3. The greeting is "Good afternoon, Admin"; the banner headline is
              "Your engine, at a glance." The `bha.me` preference is removed.
           4. Any change to a thread marks it local and persists it; deletions
              are remembered in `bha.chats.deleted` so a seeded thread stays
              gone. Pinned threads sort first under their own heading.
           5. The dropdown is removed from the shell as asked. The lane filter
              still exists in session state (default: all lanes) and the data
              module still honours it, so nothing downstream changed. Recorded
              in CLAUDE.md section 8 as a deliberate departure.

Decision:  - **The fourth floating element is the Bays orb**: a conic-gradient
             ring that slowly turns behind the BHA mark, breathing gently. It
             stands in for the Siri orb in the reference.
           - **Row heights match by construction.** Home is one grid with two
             columns and explicit rows, so Quick actions sits in the hero's row
             and This week in the systems' row; each stretches to its neighbour.
           - **Tints are one per system**: indigo, purple, green, red, teal,
             brown, mint, cyan, blue. Engine health and incidents use red as
             their identity colour; it is an icon tile, not a data value.
           - **Health words are gone from the system tiles.** Destiny could not
             tell what "degraded" was measuring. The thresholds still drive
             "Needs a look" and the engine-health card, where the signal text
             says what is actually wrong.
           - **The mic is the browser's own dictation** (Web Speech API). Where
             the browser lacks it the button says so. Nothing is recorded or
             sent anywhere; it types into the composer.
           - **The model label is configuration**, `VITE_BAYS_MODEL_LABEL`,
             defaulting to "Claude Sonnet 5.0" at Destiny's instruction because
             that is what the Ask Bays workflow he is building will use.
           - **Motion**: a 260ms ease-in on every route change and on sign-in,
             a press-down on buttons and tiles, a lift on hover. All of it
             respects prefers-reduced-motion.
           - **Settings is a real page**: theme (system / light / dark), the
             account and its session expiry, and what the deployment is
             connected to, all read from configuration.

Verified:  Chromium sweep in light and dark: every route renders including
           /settings; loop close and create still work; on Ask Bays a thread
           was pinned (Pinned heading appeared), renamed (new title shown),
           deleted (count fell from five to four), the search matched one chat
           for "digest", the panel hid to a rail and reopened. No page errors.
           The only console error is the Google Fonts request, which the
           sandbox blocks. `npm run build` passes.

---

## 2026-09-08 15:00 — Session 9: minor adjustments round

Intent:    Destiny's follow-up list: light mode on a first visit; padding and
           centring for the top-right band; the summary banner laid out like
           the cropped reference; the Ask Bays composer growing before it
           scrolls; dictation that runs up to ten minutes and transcribes as it
           goes; the three-dot thread menu visible without hovering; a tinted
           sidebar; and a header on Ask Bays with the name, date and time.

Files:     src/app/theme.tsx, src/index.css, src/components/ClockChip.tsx (new,
           shared by Layout and Ask Bays), src/components/Layout.tsx,
           src/screens/Overview.tsx, src/screens/AskBays.tsx.

Problem:   1. The composer's height was set from the input event, so text that
              arrived from dictation (state, not typing) never resized it and
              the scrollbar appeared at once.
           2. Browsers end a speech-recognition session after a short pause, so
              "record for ten minutes" cannot be a single session.
           3. The three-dot menus existed but were opacity 0 until hover, which
              read as absent.

Fix:       1. The composer resizes from an effect on the draft, to a 240px cap;
              below the cap the scrollbar is hidden, at the cap it appears, and
              while dictating the view follows the newest text.
           2. Dictation keeps an accumulator of finished text and restarts a
              fresh recognition session on each browser-initiated end, until
              the person stops it or ten minutes pass. The mic button shows
              elapsed against 10:00 while it runs.
           3. The dots are always drawn in the faint colour and darken on hover.

Decision:  - **Light is the first-visit default.** "System" remains a choice in
             Settings, so anyone who wants the OS to decide can still have it.
           - **The header band is a fixed 72px** with the chips vertically
             centred, so scrolled content never touches them.
           - **The banner follows the crop**: a small tracked label ("BAYS
             SUMMARY", the one place upper case is used, matching the
             reference), a two-line headline, one line of copy, a white pill,
             the orb in a rounded-square glass tile, and three chips stepping
             diagonally. The headline is fixed copy; the live numbers stay in
             the chips.
           - **The sidebar is a shade darker than the body** with a hairline,
             in both themes, so the two regions read apart.
           - **Ask Bays gets its own header**: mark, "Ask Bays", the current
             thread's title, then date, time and the theme toggle on the right,
             beside the history panel.

Verified:  Chromium: a fresh context resolves to light before any choice is
           stored; a fourteen-line draft grows the composer to 240px and only
           then marks it scrollable; pin, rename, delete and search still pass;
           routes render in both themes; no page errors. `npm run build` passes.

---

## 2026-09-08 15:00 — Session 10: banner polish, glass, vertical dots, light-mode nav

Intent:    Destiny's last pass on Home and Ask Bays before he moves to other
           pages: the fuller banner copy back, a rotating headline, the orb
           beside uniform glass chips with room from the right edge, a taller
           banner, a glossy surface treatment, vertical three-dot menus, and a
           visible active item in the light sidebar.

Files:     src/screens/Overview.tsx, src/index.css,
           src/components/ui/Icons.tsx.

Problem:   1. In light mode the sidebar background (#ebebee) and the hover
              colour (#ededf0) were two points apart, so the active nav item
              was invisible. Dark mode used a distinct raised tone and was fine.
           2. The three chips had different widths because their labels did.
           3. Glass needs something behind it; the cards sit on a flat grey.

Fix:       1. The active item is now a white pill with the card shadow in light
              and the raised tone in dark.
           2. Chips are a fixed 196 by 58 with a truncating label.
           3. Real frosted glass (backdrop blur, translucent fill, an inner
              edge and a top highlight) goes on the chips and the orb tile,
              where the gradient shows through. Cards get only the top
              highlight, a one-pixel glossy lip, which reads on a flat ground.

Decision:  - **Four headlines rotate** every 5.2 seconds with a short rise-in:
             "Your engine, live in one window", "Every loop, every incident,
             one place", "Your day, more connected than ever", "Read live from
             the engine, never typed". They are copy; the sentence beneath
             carries the live numbers, and it now ends with a line saying so.
           - **The orb is positioned from the right, like the chips**, so the
             cluster stays together at any width above the breakpoint.
           - **Vertical dots** on the thread menus, as asked.

Verified:  Chromium sweep in light and dark: every route renders; loop close
           and create; pin, rename, delete and search on Ask Bays; composer
           growth; first visit is light. Home in light shows the white active
           nav pill and the glass chips over the gradient. No page errors.
           `npm run build` passes.

---

## 2026-09-08 15:05 — Session 9: frost, dock, and the last Home and Ask Bays polish

Intent:    Destiny's final polish list before moving to other pages: frosted
           glass on the Home cards and the sidebar, the header band frosted so
           content fades under it, the orb tilted and closer to shorter chips,
           an Apple-dock magnification on the systems row, padded rounded
           hover rows and a legible ring in the Engine health card.

Files:     src/index.css, src/components/Layout.tsx, src/screens/Overview.tsx,
           src/screens/AskBays.tsx, src/components/ui/Charts.tsx.

Problem:   1. Frosted glass over a flat grey page blurs nothing and looks like
              a plain card with lower opacity.
           2. The header band sat outside the scroll container, so content
              could never pass beneath it to be blurred.
           3. The self-heal ring's label was a fixed 15px, which overflowed a
              36px ring.

Fix:       1. A faint blue, lavender and teal wash (`.aurora`) sits behind the
              whole app at low opacity. Cards (`.frost`), the sidebar and the
              Ask Bays panel (`.frost-side`) and the header band (`.frost-bar`)
              are translucent with a backdrop blur, so the wash and any content
              behind them shows through softly. Dark mode uses the same wash at
              lower alpha.
           2. The band is now an absolute overlay across the top of the content
              column, with a mask that fades its bottom edge; pages pad their
              top so nothing starts hidden. Ask Bays got the same treatment.
           3. Ring's label scales with its size (10, 12 or 15px) and the card
              uses a 40px ring.

Decision:  - **Dock magnification is pure CSS**: the hovered tile scales 1.3 and
             lifts; its two neighbours scale 1.13 via sibling selectors,
             including `:has()` for the one before. Transitions ease at 220ms.
           - **Chips shortened to 164px** and the orb moved to 236px from the
             right edge with a 7° tilt, so the cluster reads as one group.
           - **The banner's own chips keep the stronger `.glass`**, cards use
             the gentler `.frost`; two intensities, one language.

Verified:  Chromium sweep in light and dark: Home at rest, scrolled 260px
           (banner visible blurred under the header), and with the vFarm tile
           hovered (grown, neighbours slightly grown). Ask Bays, loops, threads,
           search and settings checks unchanged. No page errors.

## 2026-09-08 19:40 — A server between the browser and the engine; Ask Bays live; records with real counts

Intent:    Destiny's four-part instruction. (1) Put a small server between the
           browser and the engine so no secret ever reaches the bundle, sign-in
           is verified server-side with a session cookie, and every /api call
           without a valid cookie is rejected. (2) Wire Ask Bays to the live
           agent at n8n.arupiautomates.cloud/webhook/dashboard-ask-bays with
           the x-api-key attached by the server. (3) A thinking indicator that
           does not invent activity. (4) Records pages (Open loops, Codex
           entries, Build patterns, Commercial) with builder and status
           filters, status changes written through the server, and counts that
           come from real history.

Files:     server/src/{index,auth,ask,db,store,engine,hash}.ts (new),
           tsconfig.server.json, render.yaml, .env.example, package.json
           (scripts, engines), .gitignore, vite.config.ts (/api proxy),
           src/data/{api,index,names,types}.ts, src/data/engine.ts (deleted),
           src/data/fixtures/{codex,patterns}.ts, src/app/session.tsx,
           src/App.tsx, src/screens/{AskBays,Login,Settings,Codex,
           BuildPatterns,Commercial}.tsx, src/screens/OpenLoops/index.tsx,
           src/components/ui/Records.tsx (new), src/index.css, README.md,
           CLAUDE.md.

Problem:   1. The previous sign-in compared a SHA-256 digest in the browser,
              which gated the interface but not the data, and the Bays key was
              a VITE_ variable compiled into the bundle.
           2. Bays's old front door acked with an empty body and answered at a
              callback the dashboard could not read; the thread had to poll and
              time out.
           3. Nothing upstream records when a loop, entry, pattern or card
              changed status, so "volume this week vs last" and "how quickly
              items move" had no source.
           4. `pkill -f sweep2.mjs` killed my own shell (exit 144) because the
              shell's command line contains the pattern; and Playwright was no
              longer under node_modules, so the sweep failed with
              `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'`.

Fix:       1. A Node server with no dependencies beyond Node 22 (node:sqlite,
              node:crypto, node:http). It serves dist/ and /api from one
              origin, so the session cookie is first-party. Sign-in posts to
              /api/auth/login; the server compares the email in constant time
              and the password against an scrypt hash (AUTH_PASSWORD_HASH,
              produced by `npm run hash-password`), then sets `bha_session`:
              HMAC-signed, HttpOnly, SameSite=Lax, Secure in production,
              twelve hours. Five failures from one address lock it for thirty
              seconds; fifty from anywhere in a minute lock everyone. Logout
              revokes the id. Every other /api route answers 401 without the
              cookie, and the client returns to sign-in on any 401.
           2. POST /api/ask forwards { message, session_id, builder_id } to
              ASK_BAYS_URL with x-api-key from ASK_BAYS_API_KEY, waits up to
              two minutes, and normalises { ok, answer, session_id, steps }.
              The client's askBays() never throws; ok:false comes back as a
              reply with a quiet "Bays could not complete this." label.
              session_id is minted once per thread and reused for every
              message in it. Cooldown, polling and the wiring notes are gone.
           3. The store: a records table per kind with status, builder,
              raised_at and closed_at; an events table written on every
              change; a daily snapshot per kind; and `history_since` in meta.
              Metrics are computed from those. Where a kind carries no date
              for a metric (patterns and cards have no raised date; Codex has
              no ingest date upstream) the value is null with a note, and the
              MetricsStrip prints the note in place of a number.
           4. Stop processes with `fuser -k <port>/tcp`; install playwright
              into the scratchpad and run the sweep from there against the
              built app on :8787.

Decision:  - **The server aggregates raw rows; the engine does not hand over
             finished numbers.** Nothing upstream keeps a status history, so
             the only honest counts are ones this server records from the
             moment it first boots. /api/status reports `history_since` and
             every closed/retired/ingested metric says it is counted from
             changes made here.
           - **One origin.** The server serves the front end so the cookie
             needs no cross-site handling. On Render this is one web service
             from render.yaml, with a 1 GB disk at /var/data for the SQLite
             file; without the disk history restarts on every deploy.
           - **CommonJS for the server build** so the existing extensionless
             fixture imports compile unchanged; `server-dist/package.json`
             carries `{"type":"commonjs"}` because the root package is ESM.
           - **Status vocabularies**: loops open · in progress · closed; codex
             posted · ingested · archived; patterns active · retired;
             commercial idea · researching · evidence thin · ready to pitch ·
             blocked · closed. The terminal state of each is what "closed"
             means in its metrics, and the strip says which word.
           - **The thinking indicator says only what is true**: three dots, a
             seconds counter and a caption that changes with elapsed time
             ("Bays is thinking", "Still working on it", "Taking longer than
             usual"). What Bays looked at arrives with the answer as `steps`
             and is shown under it as "Looked at" chips; when steps is empty
             nothing is shown, because the agent looked at nothing.
           - **Chat history stays in the browser.** Threads are localStorage;
             the server returns only the seeded ones. Bays's memory is the
             session_id.
           - **CLAUDE.md rule 4 and 5 and section 4 rewritten** to record the
             server, on Destiny's instruction, rather than leaving the spec
             saying there is no backend.

Verified:  Server compiled and run locally against a mock Bays workflow on
           :9999 that checks the key and answers with steps. Chromium sweep,
           light and dark, against the built app on :8787: wrong password
           rejected; cookie is HttpOnly SameSite=Lax; reload stays signed in;
           every page renders without overflow; closing a loop moved the strip
           from "Closed this week 0" to "1" and the median from 15d to 20d;
           filtering by Jegan recomputed the strip from his table; marking a
           Codex entry ingested moved it out of "Posted only" and gave the
           median its first value; retiring a pattern and closing a card
           counted under "changes made in this dashboard"; Ask Bays showed the
           indicator at 1s, then the answer with three "Looked at" chips, then
           a plain answer with no chips, then an ok:false answer labelled;
           sign out returns to the login and stays there on reload; six bad
           logins from one address return 401 ×5 then 429; unauthenticated
           /api/records/loops/metrics returns 401. Phone layout of Codex
           entries has no horizontal overflow. `grep` of dist/assets for
           ASK_BAYS, AUTH_PASSWORD, SESSION_SECRET and x-api-key: zero hits.

## 2026-09-09 10:35 — The Render build's type-check: two files never committed

Intent:    Get the Render deploy building again. It became a web service
           (Node) running `npm install && npm run build`, and the build fails
           at `tsc -b` on 04a9561 with around forty errors across
           `src/screens/Overview.tsx` and `src/screens/VFarm/index.tsx`.

Files:     src/data/api.ts     (new — the generic fetch helper)
           src/data/names.ts   (new — BUILDER_NAMES and LANE_LIST)
           .gitignore          (anchored the rule that swallowed them)
           package-lock.json   (npm syncing the `engines` field already in
                               package.json; produced by the install itself)

Problem:   A clean clone of 04a9561 does not compile. `npm run build` from a
           fresh tree:

             src/app/session.tsx(3,40): error TS2307: Cannot find module
               '../data/api' or its corresponding type declarations.
             src/data/index.ts(13,31): error TS2307: Cannot find module
               './api' or its corresponding type declarations.
             src/data/index.ts(231,42): error TS2307: Cannot find module
               './names' or its corresponding type declarations.
             src/screens/Overview.tsx(175,13): error TS18046: 'data' is of
               type 'unknown'.
             src/screens/Overview.tsx(198,17): error TS2322: Type 'unknown'
               is not assignable to type 'OverviewData'.
             src/screens/VFarm/index.tsx(27,32): error TS2322: Type 'unknown'
               is not assignable to type 'VFarmData'.
             … 74 errors in total.

           The report named forty errors in two screens; the real count is 74
           across ten files, and neither screen is the cause. **Two source
           files were written last session but never committed:**
           `src/data/api.ts` and `src/data/names.ts`. They exist on the
           machine that built 04a9561 and are absent from git — `git ls-files
           src/data/` lists only `index.ts`, `types.ts` and `fixtures/`.

           And they were not forgotten, they were swallowed. `.gitignore`
           line 147, added in 04a9561 with the server:

             # BHA dashboard server
             server-dist/
             data/

           `data/` has no leading slash, so git matches it at *any* depth —
           the root SQLite directory it was written for (DATA_DIR defaults to
           `./data`) and `src/data/` alike:

             $ git check-ignore -v src/data/api.ts
             .gitignore:147:data/	src/data/api.ts

           `index.ts`, `types.ts` and `fixtures/` survived only because they
           were already tracked when the rule landed, and git ignores nothing
           it already tracks. The two files written in that same session were
           new, so `git add -A` passed over them in silence and the commit
           looked complete. Anything added under `src/data/` from then on
           would have vanished the same way.

           Everything else follows from that one absence. `src/data/index.ts`
           imports `{ api, ApiError }` from './api'; with the module
           unresolved, `api<OverviewData>(…)` has no signature, so
           `getOverview` no longer returns `Promise<OverviewData>`,
           `useData(getOverview)` infers `T = unknown`, and every `data.pins`,
           `data.tiles`, every `.map((t) => …)` derived from it, collapses in
           turn — hence the run of TS18046 and TS7006. The same unresolved
           `ApiError` breaks the `err instanceof ApiError` narrowing in the
           sign-in catch, which is why `err` reads as `unknown` there too.

Fix:       Wrote the two missing modules rather than touching any consumer.
           No call site changed, no `as` cast was added at a use, no `: any`
           on a callback parameter, and `strict` / `noImplicitAny` are
           untouched.

           `src/data/api.ts` — `api<T = unknown>(path, opts): Promise<T>`.
           The generic is the whole point: `api<OverviewData>('/api/overview')`
           resolves to `OverviewData`, and the inference flows back out
           through `getOverview` → `useData` → the screen unchanged. The one
           unavoidable boundary cast (`payload as T`, JSON has no type) lives
           here, in the single place a shape crosses from the wire into the
           app, which is exactly where the type-check is meant to bite.
           It also carries: `ApiError` with `kind` ('http' | 'network' |
           'timeout' | 'parse') and `status`, which the sign-in and Ask Bays
           catches already branch on; `setUnauthorizedHandler`, which
           `src/app/session.tsx` registers so a 401 returns the app to
           sign-in; `credentials: 'same-origin'` so the session cookie rides
           along; a thirty-second default timeout, raised to 130s by Ask
           Bays; `quiet401` for the two routes that must not trigger a
           sign-out (the session check and the login itself); method
           defaulting to POST when a body is given; and the server's
           `{ ok: false, message }` read back as the thrown message.

           `.gitignore` — the rule anchored to `/data/`, so it means the
           repo-root SQLite directory and nothing else, with a comment saying
           what the unanchored version cost.

           `src/data/names.ts` — `BUILDER_NAMES` and `LANE_LIST`, kept out of
           the fixtures so the client bundle stays free of fixture data. The
           builder ids are byte-identical to `src/data/fixtures/common.ts`
           (checked, not eyeballed), which matters because
           `server/src/store.ts` rejects a new loop whose owner is not one of
           them.

Decision:  - **Fixed at the source, not the call sites.** Forty-odd errors,
             one cause. Papering over Overview and VFarm with assertions
             would have left `src/app/session.tsx` and `src/data/index.ts`
             still unresolved and the app broken at runtime — the module was
             missing, not mistyped.
           - **`names.ts` duplicates the builder list rather than importing
             the fixtures.** Importing `fixtures/common` into the browser
             would drag the fixture data into the bundle, against section 4.
             The list is seven fixed ids; the file says out loud that it must
             stay in step with the store, which validates against it.
           - **No type was forced to match.** Checked whether the declared
             shapes and the server's actual responses disagree, per the
             brief. They do not: `/api/overview` returns exactly
             `broke_24h, moved_24h, pins, rates, series, tiles` and
             `/api/vfarm` exactly `alerts, days_to_halloween, lifecycle,
             lifecycle_note, places, readiness_note, readings` — key for key
             against `OverviewData` and `VFarmData`. Nothing to reconcile,
             so nothing was asserted.
           - **Anchored the ignore rule rather than force-adding the two
             files.** `git add -f` would have got this deploy green and left
             the trap armed for the next file under `src/data/`. The rule was
             always meant to mean the root `data/`; `/data/` says so.
           - **The lockfile change is committed.** `npm install` writes the
             `engines` field into it regardless; committing it keeps Render's
             install from rewriting it on every deploy.

Verified:  `rm -rf dist server-dist node_modules && npm install && npm run
           build` from a clean tree — exactly what Render runs. Exit 0. Both
           halves pass: `tsc -b && vite build` (91 modules, 285.04 kB /
           83.10 kB gzipped) and `tsc -p tsconfig.server.json`. Zero errors,
           down from 74.
           Then the built server on :8791 against a real round-trip:
           unauthenticated `/api/overview` returns HTTP 401
           `{"ok":false,"message":"Sign in to continue."}` — the shape
           `api()` reads its message from; login returns the session with its
           twelve-hour expiry; `/api/overview` and `/api/vfarm` behind the
           cookie return the key sets recorded above.
           `grep` of `dist/assets/*.js` for ASK_BAYS, AUTH_PASSWORD,
           SESSION_SECRET and x-api-key: zero hits. No fixture source URLs in
           the bundle either.
           The ignore rule checked both ways: `git check-ignore src/data/api.ts`
           and `src/data/names.ts` now match nothing, while
           `data/dashboard.sqlite` still matches `.gitignore:150:/data/`.
           `git status --ignored` across the tree lists nothing under `src/`
           or `server/` any more — only `node_modules/`, `dist/`,
           `server-dist/` and the two `.tsbuildinfo` files — so no other
           source file is missing for the same reason.

           On Render: deploy dep-dagjdp9srm7s73fgnb1g on f0fbf80 went
           build_in_progress → **live** in 45 seconds (10:37:25 → 10:38:10),
           against the failed dep-dagj852jnfac73ds528g on 04a9561. The
           service booted: "BHA engine dashboard on http://localhost:10000",
           "Your service is live", available at
           https://bha-engine-dashboard.onrender.com. Could not curl that URL
           from the build session — this sandbox's egress policy refuses the
           host — so the live check is Render's own status and boot log, not
           a request I made.

Open:      The boot log says the service is running unconfigured. Four
           environment variables render.yaml declares are not set on the
           service, because it was created from the dashboard rather than
           from the blueprint (its build command is `npm install && npm run
           build`, its health check path is empty, and its plan is free, none
           of which match render.yaml):

             sign-in:  NOT configured — set AUTH_PASSWORD_HASH
             sessions: random key this boot (sessions end on restart)
             ask bays: NOT configured — set ASK_BAYS_API_KEY
             data:     /opt/render/project/src/data

           So: nobody can sign in, sessions would not survive a restart even
           if they could, Ask Bays answers with its not-connected sentence,
           and the SQLite file sits on the ephemeral filesystem rather than a
           disk — which means the status history the records counts are
           derived from resets on every deploy. The free plan carries no
           disk, so DATA_DIR and the 1 GB mount at /var/data need the plan
           render.yaml asks for. Not touched here: these are Destiny's
           secrets and his call on the plan. Flagged, not fixed.

## 2026-09-09 11:15 — Sign-in credential, and Ask Bays wired to the live contract

Intent:    Two things, in order. Produce the AUTH_PASSWORD_HASH value for the
           shared login and prove it against the server that verifies it. Then
           wire Ask Bays to the live dashboard-ask-bays workflow against its
           real contract rather than an assumed one.

Files:     server/src/ask.ts        (rewritten against the live contract)
           src/data/types.ts        (AskReply gains asked_at and error;
                                     ChatMessage gains the 'notice' role)
           src/data/index.ts        (askBays: 100s budget, typed failures)
           src/screens/AskBays.tsx  (a refusal renders as a notice, not as Bays)

Problem:   Two, both found by reading rather than assuming.

           1. **The failure path was Bays's own bubble.** The workflow answers
              a refused key with **HTTP 200** and `ok: false`, and the screen
              appended every reply as `role: 'bays'`. So the words "This
              request was not authorised." would have rendered under the BHA
              mark, with his name and timestamp on them, as though Bays had
              said them. The gate refusing is not the agent speaking.

           2. **The live endpoint cannot be reached from a build session.**
              The egress proxy denies the host:

                n8n.arupiautomates.cloud:443 — connect_rejected
                gateway answered 403 to CONNECT (policy denial)

              The proxy README is explicit that a 403 is an organisation
              policy denial, to be reported rather than routed around. The
              same policy denies bha-engine-dashboard.onrender.com. So the
              live round-trip this session could not be run at all.

Fix:       **The credential.** Generated with the repo's own
           `npm run hash-password`, so the format is right by construction
           rather than by a reimplementation of it:
           `scrypt$<16-byte salt as 32 hex chars>$<scryptSync(password, salt,
           64) as 128 hex chars>`, the salt passed to scrypt as the hex
           *string* it is printed as, joined on `$`, Node's default scrypt
           parameters. Verified structurally (scheme, 32, 128) and then
           behaviourally, which is the part that counts.

           **Ask Bays.** `server/src/ask.ts` rewritten against the contract
           read from the live workflow (Bays — Dashboard Agent,
           vDunZ17dxLXatcw0), with the node code quoted in the file header:

           - **`json.ok === true` is the only success signal**, never the
             status code. A 200 carrying `ok:false`, an n8n webhook-level 403
             with no `ok` field at all, and a non-JSON body all land in one
             failure branch.
           - `asked_at` passed through; `steps` kept exactly as the workflow
             sends them (already lowercased and space-separated); `[]` stays
             `[]` so the screen renders nothing rather than an empty state.
           - Timeout **90s**, per the brief, replacing 120s. A timeout comes
             back as `error: 'timeout'` with its own sentence, not as a
             refusal. The client waits 100s so the server's own answer wins
             rather than the browser giving up first and losing the reason.
           - Every failure carries a typed `error`: the workflow's own
             `unauthorised` / `empty_message`, plus `not_configured`,
             `timeout`, `unreachable`, `bad_response` for failures that never
             got an answer out of it.
           - `server/src/ask.ts` now imports `AskReply` from
             `src/data/types.ts` rather than declaring its own copy, so there
             is one contract rather than two that can drift.

           `ChatMessage.role` gains `'notice'`: the app speaking, not Bays.
           An `ok:false` reply is appended as a notice and rendered as a
           centred line with no mark and no byline, the reason beneath it,
           and the user's own message marked "Not delivered — key rejected."

           The thinking caption said "Bays can take up to two minutes"; the
           budget is ninety seconds, so it now says so.

Decision:  - **Branch on `ok`, in one place.** The brief called it and the
             workflow's shape demands it. Putting it in `ask.ts` means no
             screen ever sees a refusal it could mistake for an answer.
           - **A refusal is not a Bays message.** Marking it `delivery:
             'failed'` while still rendering it in his bubble was not enough:
             the text is what a reader takes away. Hence the new role rather
             than a tone change.
           - **The workflow was not touched.** CLAUDE.md section 3 says n8n
             is read only. What was found there is reported, not fixed.

Verified:  Clean build, `npm install && npm run build`, exit 0.

           Sign-in, against the built server with the generated hash and
           AUTH_PASSWORD deliberately unset so only the hash path could
           satisfy it: boot says "sign-in: configured"; the right email and
           password return 200 with a twelve-hour expiry and set
           `bha_session; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`; that
           cookie opens /api/overview (200); /api/auth/session reports
           signed_in true; a wrong password and a wrong email each return 401
           "Email or password not recognised."

           Ask Bays, against a mock replaying the workflow's node code
           verbatim (HTTP 200 on failure included), through the real server
           and then through a real browser:

             happy path      ok:true, asked_at through, steps preserved, the
                             same session_id returned for both messages of a
                             thread
             steps: []       stays [], nothing rendered
             builder_id absent  defaults to admin
             wrong key       HTTP 200 → ok:false, error:'unauthorised',
                             "This request was not authorised."
             n8n 403         no ok field → ok:false, error:'unauthorised',
                             "The Bays workflow rejected the dashboard's API
                             key."
             non-JSON body   ok:false, error:'bad_response'
             key unset       ok:false, error:'not_configured'
             no response     ok:false, error:'timeout' at **90.004s**

           Chromium, signed in, against both a refusing and an answering
           server: the refusal renders as a centred amber notice with no mark
           and no byline, reading "This request was not authorised." above
           "The workflow rejected the dashboard's API key. Bays never saw
           this.", with the sent message marked "Not delivered — key
           rejected."; the success renders as Bays with the mark, the byline
           and two "Looked at" chips. `x-api-key` appeared on **zero**
           browser requests in either run.

           Bundle grep: the-real-key, ASK_BAYS_API_KEY, AUTH_PASSWORD,
           SESSION_SECRET, x-api-key, bays_dash and n8n.arupiautomates — zero
           hits each. The only hosts the bundle names are its own /api paths.

Open:      **The workflow's expected key is still a placeholder.** Its
           Validate & Normalise Request node holds

             const EXPECTED_KEY = 'bays_dash_2026_REPLACE_ME';

           as a literal — not an n8n environment variable, not a credential.
           The webhook node in front of it also has its own Header Auth
           credential on the same header name, `x-api-key`. So one value has
           to satisfy both gates, and unless ASK_BAYS_API_KEY is exactly that
           placeholder string, every call returns unauthorised — which the
           dashboard will now report honestly rather than voice as Bays. The
           workflow has zero executions recorded, so nothing has ever got
           through it. Destiny's to change; n8n is read only here.

           The live round-trip remains unrun for the egress reason above.
           The one-liner to run it from a machine that can reach the host is
           in the session notes.

## 2026-09-09 16:10 — Airtable as the source of truth: resync, dual-write, and the four records pages rebuilt

Intent:    Four deliverables, in order, under one constraint. The service runs
           on Render's free instance type with no persistent disk, so
           DATA_DIR is ephemeral and the SQLite store is wiped on every
           deploy and spin-down. Airtable therefore stays the source of truth
           for every record type; this dashboard is a read model plus a
           write-through cache and never the system of record.
             1. Ask Bays budget to five minutes.
             2. Open loops: purge and repopulate from Airtable through an
                idempotent resync endpoint; authenticated inbound endpoints
                so n8n can dual-write; the screen with filters, search,
                inline status, per-builder views and honest metrics.
             3. Codex entries from the Codex base, with the review sections
                the data supports, a full entry view, editing, no delete.
             4. Build patterns (classification, search, promotion rate) and
                commercial (cards per lane, unresolved research questions).

Files:     server/src/airtable.ts      (new — the only code that talks to Airtable)
           server/src/sources.ts       (new — base/table ids, field names, vocabularies, mappers)
           server/src/sync.ts          (new — resync on boot, on a timer, on demand)
           server/src/store.ts         (rewritten — Airtable-keyed rows, write-through, metrics)
           server/src/db.ts            (only `meta` here now; the store owns its schema)
           server/src/index.ts         (resync, inbound, field-edit, pattern search/detail routes)
           server/src/engine.ts        (reads off the store; fixture loop lookups gone)
           server/src/ask.ts           (300s)
           src/data/types.ts           (Loop, CodexEntry, BuildPattern, Opportunity, metrics, SyncInfo)
           src/data/index.ts           (resync, updateRecordFields, getPatternDetail, searchPatterns)
           src/data/names.ts           (LOOP_LANE_TAGS)
           src/data/fixtures/{loops,codex,patterns,commercial}.ts   DELETED
           src/components/ui/Records.tsx (CountUp, MetricCell, SeriesBlock, SyncLine, SearchBox)
           src/components/ui/Table.tsx   (TableFrame `grow`)
           src/components/ui/Spine.tsx   (null fields render as a dash)
           src/screens/OpenLoops/{index,Loops,Metrics,NewLoop}.tsx
           src/screens/Codex.tsx, BuildPatterns.tsx, Commercial.tsx (rewritten)
           src/screens/AskBays.tsx, Builders/Detail.tsx, Overview.tsx (small)
           CLAUDE.md §4, README.md, render.yaml

Problem:   Read before building, and four things decided the shape.

           1. **Where the data actually is.** Base appUVlBSGGPHw6DGh is
              loops only: seven tables, one per builder (Destiny 324, Jegan
              189, Hardik 105, Kaiqi 65, Ahad 30, Kavin 22, Jason 18 — 753),
              identical nine-field schema. Codex is apploVyhvTYNGSGCD
              (Codex Log, 95 rows), patterns app5ni3E8r7Lvxk22 (148), and
              commercial appvLglfdCqOKqLpT (21). Every id, field name and
              select choice in sources.ts came from the live schemas.
              `Assignee Slack User ID` varies within a table (Jason's holds
              three different ids), so the owner of a loop is the table it
              lives in, never that field.

           2. **What the loop tables do not record.** No close date. No
              last-modified time. That one fact decides three of the seven
              derived measures: closed per day, net raised vs closed, and
              "no status change in fourteen days" cannot be computed from
              the source of truth, and this dashboard's own event history
              is wiped with the instance. They are null with the reason
              printed, not zero.

           3. **What the Codex Log does not record.** No approval field, no
              approval time. `action_required` holds JASON_SPOTCHECK (9),
              DESTINY_REVIEW (11), BUILDER_FOLLOWUP (26), nothing (45) and
              four free-text asks — the nearest thing to a review state, and
              what the sections use. `verdict` defines two tiers, not three.
              `flag_name` is empty on all 95 rows, so no field records Layer
              0 completeness. 35 rows name no builder at all. Sections and
              metrics follow what the field holds; the page says approval and
              Layer 0 are not recorded rather than inventing either.

           4. **The sandbox cannot reach api.airtable.com** — the egress
              proxy denies the host, same as n8n and the Render URL. So every
              record was pulled through the Airtable connector (the large
              pages landed as files), transformed into the exact shape the
              REST API returns (fields by name, selects as plain names), and
              served by a local stand-in of the API (same paths, same
              `offset` pagination, same auth header, same error bodies) so
              the server's real client could be exercised against it.
              AIRTABLE_API_URL exists for that reason.

           Two things broke in the browser sweep and were fixed:
             - The three table pages now scroll as a whole (metrics above
               the table), and TableFrame's own `flex-1 overflow-y-auto`
               collapsed inside that column: rows sat under the note and a
               hover landed on the wrong element. TableFrame gained `grow`;
               a page that already scrolls passes `grow={false}`.
             - The Codex entry view and pattern detail rendered inside the
               page's animated column, whose transform makes a stacking
               context; the layout's top bar (z-20) then intercepted clicks
               on the dialog (z-40). Both are portals to document.body now.

Fix:       **Ask Bays.** TIMEOUT_MS 90s → 300s server-side; the client waits
           320s so a server timeout arrives as the server's own answer with
           its reason. The elapsed indicator stays; its captions step through
           "Bays is thinking" → "Still working on it" → "Calling tools before
           answering" → "A multi-step answer can take a few minutes" → "Bays
           has up to five minutes".

           **The Airtable client** (airtable.ts): plain fetch, Bearer token
           from AIRTABLE_API_KEY, `listAll` following `offset` at 100 a page
           with a 220ms gap (Airtable allows 5 rps per base), one retry after
           the documented 30s cool-off on 429, `updateRecord`/`createRecord`
           with typecast, 30s per-call timeout. Nothing else imports fetch
           against Airtable.

           **The store** (store.ts). Rows keyed (kind, Airtable record id)
           with the mapped record as JSON plus status, builder, raised_at,
           closed_at, source, table_id, synced_at. `upsert` is idempotent
           and writes an event only when the status differs from the held
           row, stamped with the inbound payload's own time when it has one.
           `purgeMissing` removes what a full read of a table no longer
           contains — and only after that read succeeded. Schema version 2;
           the old tables are dropped and rebuilt, which on an ephemeral
           store is the honest migration.

           **Write-through.** `setStatus`, `updateFields` and `createLoop`
           each call Airtable first and then upsert *what Airtable returned*.
           If Airtable refuses, the StoreError carries Airtable's message and
           nothing here changes. With no key, every write answers 503 saying
           so. The Airtable write path is untouched and there is no cut-over
           path.

           **Resync** (sync.ts): per kind, per table; on boot when a key is
           present, every AIRTABLE_RESYNC_MINUTES (default 30, 0 off), and
           on demand from each page's "Resync from Airtable" or POST
           /api/resync[/:kind]. Concurrent calls for the same kind share the
           run. Each table logs one line: rows, new, changed, removed, ms.
           At each successful resync the canonical share of patterns and the
           unresolved-question counts (total and per card) are recorded as
           observations, so a trend becomes real the day there are two
           observations on different days — and says so until then.

           **Inbound** (index.ts): `/api/inbound/:kind` (POST upsert, PATCH
           by id, DELETE, and `/api/inbound/resync/:kind`), authenticated by
           DASHBOARD_INBOUND_KEY in `x-dashboard-key`, checked before the
           cookie gate. The body carries the Airtable record as n8n's node
           returns it; the id may be in the path, the body, or the record.
           `builder` or `table` says which loop table. Without a record the
           server reads it from Airtable itself. Airtable stays authoritative
           either way; the push is additive.

           **Loops metrics** (loopMetrics): open / in progress / closed;
           close rate per builder as closed over total in that table today,
           labelled as a state not a rate; oldest open loop with its id and
           owner; age distribution in five buckets plus a "no date raised"
           bucket when needed; raised per week from Date Raised, eight
           weeks; closed per day from this instance's own close events
           (dashboard or inbound) with the reset caveat, null until there is
           one; net per week null; stale null, with the sentence that adding
           a "Last modified time" field on Status would make it real.

           **Codex** (codexMetrics + Codex.tsx): buckets from
           action_required; entries per builder per week (35 unattributed
           rows counted separately, never assigned); verdict mix across the
           tiers the data holds with the two-not-three note; pay-eligible
           rate with an unchecked box counted as not eligible; Layer 0 null;
           median-to-approval null. Full entry view as a dialog; Edit writes
           the thirteen editable fields through to the Codex Log; a field
           outside that set answers 422; there is no delete route (404).

           **Patterns** (patternMetrics + BuildPatterns.tsx): `system` and
           `keywords` read off each pattern_id (BP-SLACK-001-BLOCK_KIT_… →
           SLACK; block, kit, text, fallback) plus bha_system — twenty
           systems, BAYS 34, RAG 24, INFRA 20, VFARM 20, GENIE 17. Promotion
           rate leads the page: 15 of 148 canonical, 10%, labelled as the
           share today because no promotion date exists; promotion over time
           null until observed on two days. Search is server-side across
           every text field including the long ones the list omits; the
           detail dialog fetches them. Promote / back to draft write through.

           **Commercial** (commercialMetrics + Commercial.tsx): cards grouped
           by lane_id (21 cards, 21 lanes — every card has its own lane, which
           is what the data says); missing_research_count summed over the 18
           cards that carry it, with the 3 that do not named as such; the
           pipe-separated question text split into its items and shown next
           to the count, flagged when count and list differ; per-card and
           total trend null until observed twice. readiness_state changes
           write through.

           **Purge.** The four phase 1 fixture files were deleted, not
           retyped. With no AIRTABLE_API_KEY the four pages are empty and
           print the reason. The review queue and reconciliation tabs are
           empty with a sentence: nothing proposes closes and nothing
           reconciles the digest against the tables yet.

Decision:  - **The server reads Airtable directly**, on Destiny's instruction,
             rather than through the engine endpoint CLAUDE.md §4 described.
             §4 rewritten to record it and the no-disk constraint. Still no
             dependency beyond Node.
           - **Owner is the table, not the assignee field.** See problem 1.
           - **The global lane filter does not apply to Airtable kinds.**
             lane_tag / lane_id / bha_system are not the engine's Lane union;
             mapping them would be guessing, and the filter is 'all' in
             practice since 2026-09-08. Loops carry lane_tag verbatim and the
             spine's lane is that string or null.
           - **Spine fields are nullable** and render as a dash. A loop table
             has no session_id or subsystem; saying so beats inventing one.
           - **No fixture fallback.** Empty-with-reason is the truth when the
             key is missing; fixtures would be invented data on screen.
           - **A count-up animates once, on first paint,** and respects
             prefers-reduced-motion. A number that re-animates on every
             refetch reads as noise.
           - **The variable name AIRTABLE_API_KEY appears in the bundle** —
             in the sentence "Writes are off: no AIRTABLE_API_KEY." No value
             does; the grep for the key, the inbound key, the Airtable host
             and the inbound header are all zero.

Verified:  Clean build, `npm run build`, exit 0: `tsc -b && vite build`
           (321 kB / 92 kB gzipped) and `tsc -p tsconfig.server.json`.

           verify.sh — 32 checks against the local replay of the Airtable
           API, all passing, output kept verbatim in the session notes:
             1. boot resync read every table: 753 loops (324/18/65/189/30/
                105/22), 95 Codex, 148 patterns, 21 cards; ten log lines,
                the slowest (Destiny) 1080ms.
             2. second resync: 0 new, 0 changed, 0 removed — idempotent.
             3. a record deleted upstream: next resync 1 removed, 21 held.
             4. close a loop from the dashboard: Airtable (replay) holds
                Status=Closed; the held row is closed with closed_at today.
             5. Airtable refusing writes: 502 with Airtable's reason; the
                held row still open.
             6. inbound: no key 401; wrong key 401; create 201; the same
                payload again 200 not inserted, not changed; close by PATCH
                changed:true with the event stamped at n8n's time; DELETE
                drops the row; an id with no record makes the server read
                it from Airtable.
             7. loop metrics: open 607, in progress 7, closed 138; oldest
                LOOP-1788044070652-7Z84, 39d, Destiny; buckets 99/119/310/
                86/0; close rates Destiny 14% (46/324) … Kaiqi 98% (64/65)
                … Kavin 0% (0/21); raised per week 0, 23, 87, 119, 154,
                211, 121, 37; closed per day has points (the close from
                step 4); net per week and stale null with notes; builder
                scope jegan rows 189 open 171 closed 14.
             8. codex: buckets 9/11/26/4/45, verdicts 85/10, pay eligible
                56%, Layer 0 null, median approval null; an edit landed in
                the Codex Log first; a locked field 422; DELETE 404.
             9. patterns: 133 draft / 15 canonical / 10%; twenty systems;
                search "block kit" 9 hits, first BP-SLACK-001; detail
                carries a 1047-char solution; promote written through.
            10. commercial: 21 cards, 53 unresolved over 18 of 21 cards,
                trend null (one day).
            11. /api/status: airtable_configured, inbound_configured,
                rows held.
            12. no AIRTABLE_API_KEY: zero rows, source none, the reason
                printed; resync 503.

           Chromium against the built app: signed in; Open loops counts run
           up to Open 607 / In progress 7 / Closed 138 with the sync line
           naming all seven tables; stale and net show "Not recorded" with
           their sentences; search by loop id shows 1; Kavin's table view
           shows 21; a hover-revealed "Start" on a row produced the toast
           "Marked in progress in Airtable."; the Codex page shows 95
           entries, 8 awaiting Jason (one was moved to Destiny review by the
           edit in step 8), the Layer 0 "Not recorded" and the approval
           note; the entry dialog opens with four textareas and four selects
           and no Delete button.
           The patterns page leads with "Draft to canonical 11%" (16 of 148
           after the promotion in step 9), 24 keyword chips, server search
           "idempot" → 3, and the detail dialog for "Idempotent Corpus-Card
           Migration with Stable Source Identity". Commercial: 21 cards in 21
           lane sections, 53 unresolved, the trend "Not recorded" with its
           sentence. The Overview's Open loops pin reads 614 = 605 open + 9
           in progress, consistent with the loops page after the sweep's
           own "Start" clicks. Console errors: five, all the Inter font from
           fonts.googleapis.com, which this sandbox's egress denies; none to
           the app (checked by URL, not assumed).

           Not verified here, because the sandbox cannot reach
           api.airtable.com: the real read of the real bases. That happens
           on Render the moment AIRTABLE_API_KEY is set, and the boot log
           prints one line per table with the count it read.

Open:      - **AIRTABLE_API_KEY is not set on Render.** Until it is, the
             four pages are empty and say so. The token needs
             data.records:read and data.records:write on the four bases.
           - **DASHBOARD_INBOUND_KEY** is declared in render.yaml as a
             generated value; the service was created from the dashboard, so
             it must be set by hand and given to n8n. No n8n workflow calls
             /api/inbound yet — that wiring is n8n's side and read-only here.
           - **Kaiqi's table is 98% closed (64/65)** and Kavin's 0% (0/21).
             Both are what the tables hold today; the close-rate card says it
             is a state, not a rate.
           - The engine-lane filter still exists in session state and is
             'all'; it does not apply to the Airtable-backed kinds.

           On Render: deploy dep-dago7fks728c73deepqg on 8c2d063 went live in
           50 seconds. Boot log: "sign-in: configured" (the hash from this
           morning works), "sessions: SESSION_SECRET set", "ask bays:
           https://n8n.arupiautomates.cloud/webhook/dashboard-ask-bays",
           "inbound: NOT configured — set DASHBOARD_INBOUND_KEY for n8n
           dual-write", "airtable: NOT configured — set AIRTABLE_API_KEY.
           Loops, Codex, patterns and commercial pages will be empty." So
           the live service is exactly in the no-key state verified in step
           12: four empty pages that print why. The first boot after the
           key is set will print one resync line per table.

## 2026-09-09 19:15 — Review round: last_modified, cuts on Open loops, Codex in three layers, patterns and commercial layout
Intent:     Destiny's review of the Airtable-backed pages. Every loop table
            now has a `last_modified` formula (LAST_MODIFIED_TIME()) — use it
            for net raised-vs-closed per week and stale-for-fourteen-days,
            but every existing record stamps today, so print on any metric
            derived from it that it is only meaningful for changes after
            9 Sept 2026 and never present early readings as history. Open
            loops: remove the Review queue and Reconciliation entirely, drop
            the oversized oldest-open panel, make the age distribution read
            newest first, count up again on every view change (including
            the close-rate percentages and the age bars), and stop the
            freeze on a builder tab switch. Codex: restructure (not restyle)
            around three layers — Layer 0 completeness, pending approval
            (only what awaits Jason), approved — with plain names, no
            JASON_SPOTCHECK / DESTINY_REVIEW / BUILDER_FOLLOWUP sections;
            narration in its own column; "37 with no builder" explained;
            week labels as date ranges; keep the verdict mix. Patterns: the
            by-system table full width, explain draft and canonical on the
            page, promotion-over-time either obvious or gone, keep the
            keyword chips and search. Commercial: fixed collapsed card
            height in a grid with an expand control. Throughout: where a
            metric cannot be computed keep saying so on the page, and add
            only metrics the data genuinely supports.
Files:      server/src/sources.ts (Loop.last_modified; CodexEntry.complete +
            missing from CODEX_REQUIRED), server/src/store.ts (metrics
            rewritten, memoised), server/src/engine.ts (OpenLoopsData
            without the queue/reconciliation), src/data/types.ts,
            src/components/ui/Records.tsx (CountUp replayKey),
            src/components/ui/Charts.tsx (Bars/HBar grow + labels),
            src/screens/OpenLoops/{index,Metrics}.tsx (rewritten),
            src/screens/OpenLoops/{ReviewQueue,Reconciliation}.tsx (deleted),
            src/screens/Codex.tsx (rewritten), src/screens/BuildPatterns.tsx,
            src/screens/Commercial.tsx, scratchpad verify.sh (46 checks),
            sweep3.js, mock-airtable.js.
Problem:    1. The mock loops carried no last_modified, so nothing could
               prove the new metrics. Stamped every mock loop with
               2026-09-09T14:02:11Z (what the live tables hold today) and
               taught the mock to stamp `last_modified` on PATCH and POST
               in the loops base, as the formula does.
            2. `server/src/sources.ts` imported the removed `CodexBucket`
               from the shared types: "Module '../../src/data/types' has no
               exported member 'CodexBucket'". Defined it locally in
               sources.ts; the shared contract now carries `CodexLayer`.
            3. First verify run, 5 failures, all in the script: the age
               order check assumed a trailing "no date raised" bucket that
               is absent when every loop has a date; the week label is
               "7–13 Sept", not "Sep"; the last_modified logic test stamped
               four open loops in Kaiqi's table, which has one open loop
               (64/65 closed), so stale read 1; the codex weeks live under
               each builder row, not at the top; and the reusability mix
               listed nineteen free-text sentences as nineteen bars.
            4. The Chromium sweep could not sign in: verify.sh starts the
               server from the scratchpad, where there is no dist/, so "/"
               answered 503 "The front end has not been built". Started a
               second server from the repo root on 8802 for the sweep.
Fix:        Open loops. Metrics come once, unscoped, carrying
            `by_builder` (all seven tables computed in the same pass and
            memoised per store version; `bumpVersion()` on every upsert,
            purge, inbound change and status event). A tab change picks
            from memory, shows a 220 ms dimmed state, and every count,
            percentage and bar re-runs from zero via `replayKey`. Sweep:
            click handled in 372 ms, Open read 89 at 60 ms and 170 at 1.1 s
            on Jegan's tab, zero metrics requests across two tab changes.
            Review queue, Reconciliation and the oldest-open panel are gone
            (files deleted, types removed). Age distribution: the buckets
            were already 0–7 first, over-60 last; each bar now carries its
            value and label and the card says "newest → oldest".
            last_modified. `modifiedAfterAdded()` counts a stamp only if
            strictly after 2026-09-09. Closed per week and net per week use
            it, start at the week the field was added (7–13 Sept) and show
            no earlier week; stale is open loops stamped more than fourteen
            days ago with `meaningful_from: 2026-09-23`, rendered dimmed
            with "not yet meaningful — from 2026-09-23" until then. All
            three notes end "…only meaningful for changes after 9 Sept 2026
            and is not history before then." Verified: three Jegan loops
            stamped 2026-09-10 count as closes in 7–13 Sept; four stamped
            20 Aug read as stale; a close made today stamps 9 Sept and is
            not counted; the cache invalidates on resync.
            Codex. Sections: Pending approval (action_required =
            JASON_SPOTCHECK), Incomplete, Complete, Approved, All; the
            builder filter stays above them. Layer 0 is the dashboard's own
            check (builder, session link, session type, verdict,
            architecture fit, engine movement, needle-moved evidence); each
            row carries `complete` and `missing`, and the strip prints the
            definition. Approved is defined but empty: `approved.n` is null
            and the section says the log records no approval — no flag, no
            approver, no time — so an entry with no action_required could be
            approved or never reviewed and the data cannot tell. Nothing is
            inferred. Narration has its own 24ch column (shortened URL,
            full link in the entry view); builder is 14ch with "none" and a
            hover explanation; week columns are "20–26 Jul" ranges; the
            unattributed sentence is printed under the per-builder table.
            Patterns. Promotion ring, Draft / Canonical / Patterns counts,
            a legend card defining the two states and saying the field
            defines no third, the by-system grid full width in four columns
            (1136 px of a 1200 px main, 242 px tall), created per week,
            and a reusability mix. Promotion-over-time is dropped: the table
            records the state, not the date, so no honest series exists.
            Commercial. Cards collapse to 188 px with a gradient "Expand"
            control (all 21 measured at 188 in the sweep; the first expands
            to 1419 px because it lists its questions) and a Confidence
            card joins the readiness band.
            Amber is reserved for bad states (section 5): the Draft count,
            the Pending approval count, the net-per-week bars and the
            confidence/readiness bands are now neutral.
Decision:   Approval is not inferred. Pending = a JASON_SPOTCHECK request;
            Evaluated = a verdict or narration quality is written;
            Complete = the dashboard's field check. None of those is
            "approved", and the page says so. An `approved_at` date on the
            Codex Log would fill the Approved section without a code change
            to the layer model.
            reusability on Build Patterns is free text, not a select: 129
            of 148 rows use one word (Broad 118, Moderate 11), 19 explain
            in a sentence. The mix counts the words and groups the prose as
            one bar with a note, rather than nineteen bars of sentences.
            Metrics added because the rows support them: open loops by
            lane tag, who raises loops (Raised By as written, so "Jason"
            and "Jason Bays" count separately and the note says so), closed
            per week; narration quality mix; reusability mix; confidence
            mix. Not added: time-to-close, reopen count, promotion date,
            approval time — none is recorded upstream.
            Verified on the local Airtable replay: verify.sh 46/46 (boot
            753/95/148/21; idempotent resync; purge; write-through; refused
            write; inbound 401/201/idempotent/PATCH/DELETE; the metric
            checks above; no delete route; 422 on a locked field; no-key
            state; bundle carries no key or host). Sweep: all four pages,
            console errors only the Inter font this sandbox cannot fetch.
            Live verification follows below after the push.

           On Render: deploy dep-dagqvp3m8hqs73fc7ncg on 927f146 built in
           28 s and was live at 19:14:28 UTC, 48 s end to end. Boot log:
           "sign-in: configured", "sessions: SESSION_SECRET set", "ask bays:
           https://n8n.arupiautomates.cloud/webhook/dashboard-ask-bays",
           "inbound: DASHBOARD_INBOUND_KEY set", "airtable:
           https://api.airtable.com/v0 — resync on boot, then every 1440
           min". Boot resync, one line per table: Destiny 324 (6038 ms),
           Jason 18, Kaiqi 65, Jegan 189, Ahad 30, Hardik 106, Kavin 23 —
           755 loops, two more than this morning's 753 (one new row each in
           Hardik's and Kavin's tables); Codex Log 95 (2904 ms); Build
           Patterns 148 (3620 ms); Commercial Opportunities 21 (2050 ms).
           No error line. Not verified here, because this sandbox cannot
           reach the Render URL: the metric panels as computed from the
           live rows. By construction they should read closed per week 0
           and net per week equal to this week's raised count (every live
           loop stamps 9 Sept), and stale 0 dimmed as "not yet meaningful —
           from 2026-09-23".

## 2026-09-10 18:50 — Refinement pass: Open loops, Codex on the submissions base, patterns and commercial as one page, vFarm coming soon
Intent:     Destiny's refinement brief on four record pages plus a vFarm empty
            state. Global rules to apply everywhere: newest first, uniform card
            heights with content that fills the card, no horizontal scroll on
            the page body ever, twenty rows to a page, and an explicit centred
            message wherever a section has no data. Open loops: new subtitle,
            drop the red age badge from every builder tab, delete the lane-tag
            card, rebuild "Age of what's open" in the visual language of "Close
            rate by builder", rebuild "Closed per week" to match "Raised per
            week", populate or empty-state "Closed per day", and stop
            double-counting people in "Who raises loops". Codex: read the real
            source — BHA Submissions & Logs, one table per builder — and
            surface the completed entry that already sits in Orchestrator
            Layer2 Review. Patterns: stop the filter bar scrolling the page,
            truncate the rows, and trace why draft/canonical/total never
            reconciled. Commercial: rebuild as the same page as Build patterns.
            vFarm: label what does not exist yet as coming soon.
Files:      new src/components/ui/{Pagination,ListRow}.tsx; src/components/ui/
            {Card,EmptyState,Records,Tabs,index}.tsx; src/index.css (.seg);
            src/data/{types,index}.ts; server/src/{sources,store,sync,engine,
            index}.ts; src/screens/OpenLoops/{index,Loops,Metrics}.tsx;
            src/screens/Codex.tsx (rewritten); src/screens/BuildPatterns.tsx;
            src/screens/Commercial.tsx (rewritten); src/screens/VFarm/{index,
            Live,Lifecycle,Readiness}.tsx; src/screens/Builders/Detail.tsx;
            scratchpad mock-airtable.js, sweep.js.
Problem:    1. Codex was reading apploVyhvTYNGSGCD (Codex Log) — the wrong
               base. The completed entry Destiny wanted on screen lives in
               appEmdKshNVTl64Zf, in a per-builder table, in a field the page
               never touched. The old page's "No Builder (37)" bucket was an
               artefact of attributing rows by a field that can be blank.
            2. The pattern figures did not reconcile because `pattern_status`
               is a single-select with exactly two choices and a fifth of the
               rows leave it empty. mapPattern read
               `status === 'canonical' ? 'canonical' : 'draft'`, so every
               untriaged row was silently counted as a draft. Verified against
               the live table: 149 rows = 15 canonical + 114 draft + 20 with no
               status. Second cause: 149 rows carry 147 distinct pattern_ids —
               BP-BAYS-002-FRONT_DOOR_CALLBACK_RTNS_GATE is written on three
               rows — so a count of rows was never a count of patterns.
            3. "Who raises loops" split one person across two bars. Raised By
               is a free-text box: Ahad's table alone holds "Jason" ×10 and
               "Jason Bays" ×15, plus "Jegan" and "Jeganathan", "Destiny" and
               "Destiny Arupi".
            4. The new list card rendered zero pixels tall with all twenty rows
               present in the DOM. These pages are a flex column and the card
               clips its own overflow, so the default flex-shrink collapsed it.
               Found by measuring the rendered geometry, not by reading it:
               `listHeight: 0, rows: 20`.
            5. First sweep: the ring cards on Build patterns and Commercial
               filled 42% and 52% of their own height — exactly the "100px card
               holding 10px of content" complaint, in a card I had just built.
Fix:        Global. `usePaged` + `<Pagination>`: twenty rows, next/previous,
            "1–20 of 149", the page index clamped as filters change and reset
            when the list changes. `.seg` is now `display:flex; flex-wrap:wrap;
            max-width:100%`, so a twenty-system filter bar becomes three lines
            inside its own width instead of scrolling the page; every records
            page's scroll container also carries `overflow-x-hidden`.
            `<MetricCard>` grows its body and pins its footnote to the card's
            floor, so cards in a row line up and their content fills them.
            `<EmptyPanel>` and `<ComingSoon>` are the two empty states; a
            `MetricSeries` with null points renders the panel rather than an
            axis with no bars.
            Open loops. Subtitle is "Every commitment BHA has made, across
            every system". The oldest-loop age badge is gone from All tables
            and from every builder tab — it was red on all eight, and a colour
            that is always on is not a signal. "Open loops by lane tag" is
            deleted. "Age of what is open" is now labelled horizontal bars,
            count over total plus percentage, same height, padding and type
            scale as "Close rate by builder". "Closed per week" spans the same
            eight weeks as "Raised per week" and falls to the empty state with
            its reason when no close has been recorded; "Closed per day" does
            the same. Both populate the moment a loop is closed — verified.
            `canonicalPerson()` in sources.ts collapses a free-text name to one
            identity, and the card names the spellings it merged rather than
            merging silently.
            Codex. `CODEX_TABLES` is the six submission tables in
            appEmdKshNVTl64Zf; the builder is the table, so every row is
            attributed and "No Builder" cannot exist. No Jason tab: he reviews
            logs, he does not submit them. Kavin's table is read. Four tabs,
            each computed from the source's own fields and printing its rule on
            the page: Approved (Jason Status = Approved), Pending approval
            (Pending or empty), Incomplete (Layer0 Flagged, listing Layer0
            Missing), Complete (not flagged and Orchestrator Layer2 Review not
            empty). The Layer 2 review is the substance of the page: two lines
            in the row, the whole entry in the entry view with its own section
            headings kept. `/api/codex/:id` carries the full text so a hundred
            entries are not shipped in one list payload. The Layer 0 holding
            table is read alongside, so the Incomplete tab can say how many
            submissions never reached a builder table. Week labels on the
            per-builder chart are the week start only ("3 Aug"), with the full
            range in the title attribute. Approving an entry writes Jason
            Status back to Airtable.
            Patterns. Three states, counted separately, with the sum printed
            against the row total on the page and the duplicate-id count beside
            it. `PatternStatus` gains 'unset'; only draft and canonical are
            writable. The ring card carries a triage bar ("129 of 149 given a
            status") so it fills its own height with a measure that is not
            duplicated elsewhere. Rows are id, title, system, reusability and a
            two-line problem summary; everything else opens on click.
            Commercial. Rebuilt as Build patterns with different content: same
            wrapping filter bars, same truncated rows, same detail dialog, same
            chart treatment and spacing. The expanding square tiles are gone.
            vFarm. Lifecycle and Readiness are `<ComingSoon>` panels, and both
            tabs are marked "soon" before the reader clicks. Live is unchanged
            except newest-first ordering and twenty rollups to a page.
Decision:   Layer 0 and Jason Status are two axes, not one pipeline, and the
            page says so. Two of Hardik's rows are Approved *and* Layer0
            flagged; folding them into one funnel would have had to invent a
            precedence rule the data does not carry, so both states are shown
            on the row and the tabs are independent filters.
            An empty `pattern_status` is its own state, not a draft. Naming it
            is what makes the counts reconcile; folding it back into draft is
            what broke them.
            An empty Jason Status is counted as pending, because nothing in the
            row distinguishes it from a log Jason has not reached.
            Codex editing is narrowed to Jason Status and Jason Notes. Every
            other field on a submission row is written by the pipeline that
            produced it, and a dashboard that lets someone retype the
            orchestrator's output is a dashboard that corrupts the record.
            Not done, and why: the "Net raised vs closed per week" chart still
            renders a single bar, because it starts at the week last_modified
            was added and that is one week so far. It is listed under KEEP AS
            IS in the brief, so it is untouched; it will fill as weeks pass.
            The "Action required = recent spot check" line called out for
            removal under Open loops does not exist on that page — the string
            lived on Codex, tied to action_required, and the Codex rewrite
            removes both the field and the line.
Verified:   Local Airtable replay seeded from the live schemas read through the
            connector today, including the exact rows that matter: Hardik's two
            Layer0-flagged rows, Ahad's Raised By spellings, the twenty
            status-less patterns and the pattern_id on three rows.
            Boot resync, one line per table: loops 755 across seven tables;
            codex Destiny 36 / Jegan 24 / Kaiqi 19 / Hardik 22 / Ahad 11 /
            Kavin 22 = 134 across six; patterns 149; commercial 21.
            Who raises loops: Jason 285 merging "Jason" and "Jason Bays",
            Destiny 223 merging "Destiny" and "Destiny Arupi", Jegan 182
            merging "Jegan" and "Jeganathan" — six people, not nine.
            Codex tabs, client rule and server rule agreeing exactly: Approved
            114, Pending 4, Incomplete 2, Complete 122.
            The Layer 0 transition, on a real row: recaIoFukLYoZDpp4 (Hardik,
            missing "commercial") read flagged=true, has_entry=false,
            complete=false. The pipeline's resubmission was replayed — flag
            cleared, Layer0 Missing emptied, Layer 2 review written — and after
            a resync it read flagged=false, has_entry=true, complete=true, and
            the tabs moved Incomplete 2→1, Complete 122→123.
            Patterns: 114 draft + 15 canonical + 20 unset = 149 rows, and 147
            distinct pattern ids across 149 rows.
            Closing two loops through the interface moved Closed per day to
            [.., .., 2] and Closed per week to eight points ending 2, the same
            axis length as Raised per week.
            Chromium sweep at 1440px and at 400px, all five pages: document
            overflow-x 0 at both widths; every wide element inside main is a
            self-contained scroller; card rows uniform in height with content
            filling 84–91%; twenty rows and a working pager on all four record
            pages. Console errors: only the Inter webfont this sandbox cannot
            fetch.
            Write paths: approve writes Jason Status back and reads Approved;
            an undefined status is refused 422; inbound without the key 401,
            with the key and a builder name 200, with a table that is not a
            submissions table 422; no delete route (404).
            Regression pass over Home, Builders, a builder detail page, Engine
            health, both twins, Ask Bays and Settings: no errors, no overflow.
            The bundle carries no key, host or base id — the one match for
            AIRTABLE_API_KEY is the sentence "Writes are off: no
            AIRTABLE_API_KEY." on screen.
            Not verified here: the live Render deploy, which this sandbox
            cannot reach. The first boot after this deploy will print six codex
            resync lines instead of one, and the Codex page will read from the
            submissions base for the first time.

## 2026-09-10 19:50 — Sync cadence, North Star and Research Twin telemetry, the Clients page
Intent:     Destiny's second brief. Shorten the resync interval and put the age
            of the data on every page. Build North Star telemetry from its own
            ask log, Research Twin telemetry from the Research Queue, and a
            Clients page grouping watched lanes under the client that owns
            them. Plus: the vFarm coming-soon state, reported as not landed.
Files:      server/src/{sync,sources,store,engine,index}.ts; src/data/
            {types,index}.ts; src/components/ui/Records.tsx (SyncLine,
            relativeTime); new src/screens/{NorthStar,ResearchTwin,
            Clients}.tsx; src/screens/Twin/* (deleted); src/screens/VFarm/
            index.tsx; src/{App,components/Layout}.tsx; render.yaml; README.md;
            CLAUDE.md; scratchpad mock-airtable.js.
Problem:    1. The vFarm coming-soon state DID land, on 2026-09-10 in commit
               4482885, on branch claude/bha-engine-dashboard-refinement-9v4t9r.
               It is not on the live service because `origin/main` is still at
               04a9561 — three commits behind — and render.yaml deploys from
               the default branch on commit. The whole previous refinement pass
               is unmerged and undeployed, not just the vFarm state.
            2. NS Records: `outcome` is empty on all 34 rows, including the
               ones written today. The brief said rows before 10 Sept would be
               empty; in fact nothing has written the field at all, so the thin
               rate — the page's headline — cannot be computed from it.
            3. The Research Queue is an attempt log, not one row per card: 213
               rows across ~29 distinct card_ids, one card carrying 25 rows.
               "Queue depth" and "run-count distribution" are per-card
               questions asked of a per-attempt table.
            4. `run_count` reaches 4 on some rows, above the documented cap of
               3, and `requires_human` stays ticked on cards since resolved.
            5. Two migrations sit in the queue, not one: `watched_clients_
               migration` (30 Aug, ids LANE-MIGRATED-*, status pending) as well
               as the `migrated_from_watched_clients` nine (10 Sept, ids
               RQ-MIG-*, status blank) the brief describes.
            6. A `clients` resync read each lane's questions table twice per
               cycle — once inside the clients run, once again when the kind
               loop reached `client_questions`.
Fix:        Cadence. AIRTABLE_RESYNC_MINUTES is 15, in sync.ts, render.yaml and
            the README. A full resync is 23 tables and ~31 requests across seven
            bases, paced
            at 220 ms, so about seven seconds and nowhere near Airtable's five
            requests a second per base. `resyncAll` now skips
            `client_questions`, which `clients` already covers.
            Freshness. `relativeTime()` and a rewritten `SyncLine`: every page
            prints "Read from Airtable 4 min ago — 34 rows", re-rendered on a
            30-second timer so a tab left open does not keep claiming the data
            is four minutes old an hour later. Rows older than two resync
            cycles go amber. A failed resync renders "Showing rows read 7 min
            ago … · last resync failed: <reason>" — the held rows are never
            presented as current. `SyncInfo` carries `resync_minutes` so the
            page knows what overdue means. vFarm, still fixtures, says so
            rather than showing a sync line it does not have.
            North Star. New kind `ns`. The thin rate is computed over rows
            carrying an `outcome` and no others, and renders as "Not recorded"
            with its reason when nothing is classified. Also asks per week,
            a stacked outcome-over-time chart, research-required rate, tool
            hits against cited uses parsed from the searches blob, citation
            coverage, by lane, and last ask. The entry view shows the tool
            calls, the answer, and the prompt as sent.
            Research Twin. New kind `rt`. `rtCards()` collapses the attempt log
            on card_id: newest attempt decides the state, run_count takes the
            highest, first_stuck_at the earliest. Cards at requires_human sort
            first and are the default filter. Days stuck, run counts, gap
            classification, confidence and created-per-week are all per card,
            with the row count printed beside the card count.
            Clients. New kinds `clients` and `client_questions`. The index is
            read, then each row's `Table ID` is followed — no lane-to-table map
            in this code. Lanes group under `Client ID`, so Client 2 appears
            once with both lanes beneath. Needs-human reads the three existing
            circuit breakers and recomputes none of them. A lane with no run is
            warming up and is not counted stale.
            vFarm. Lifecycle and Readiness were already ComingSoon panels with
            "soon" on the tabs; unchanged, plus the fixtures note.
Decision:   The thin rate is not derived from the answer text. The definitions
            are mechanical enough that this dashboard could classify the rows
            itself, and the brief's instruction not to backfill or guess is the
            right call: a number computed here would sit in the same place on
            the page as one North Star stands behind, and nothing on screen
            would distinguish them. What the page shows instead is citation
            coverage from the evidence blob — 27 of 34 asks cite nothing —
            labelled as coverage, which is what it is.
            The Research Twin page is per card, because that is the question
            being asked, and it prints the row count so the collapse is visible
            rather than assumed.
            The old fixture-backed Summary/Records/Runs/Gaps twin screens are
            deleted rather than kept beside the real ones. Two North Star pages,
            one real and one invented, is worse than one.
Verified:   Local Airtable replay extended with the three new sources, shaped
            from the live reads: 34 NS rows with no outcome on any of them, an
            RT attempt log of 211 rows over 29 cards including nine blank-status
            RQ-MIG-* rows, and the four index lanes with their own question
            tables.
            Boot resync, one line per table, 26 reads: loops 755/7, codex 134/6,
            patterns 149, commercial 21, ns 34, rt 211, clients index 4 plus
            four question tables (6/4/6/6). Each table read once.
            North Star: 34 rows, 0 classified, thin rate null and rendering as
            "Not recorded" with its reason rather than 0%. Tool usage
            Read_Open_Loops 16 hits / 7 cited (44%), Get_Priority_Evidence 7/7
            (100%) — a tool being called and ignored is visible. Citation
            coverage 27 nothing-cited, 7 fully cited.
            Research Twin: 211 attempt rows collapse to 29 cards; 3 at
            requires_human; 9 untriaged; 4 ever stuck, longest 21 days; run
            counts 15/6/5 at 0/1/2 and 3 above the cap, which the page names.
            Clients: 3 clients over 4 lanes. CLIENT-002 renders once, labelled
            "Client 2", with both lanes beneath it. The CRE vFarm + Kiosk lane
            reads "warming up / never" and is not counted stale; the other
            three are stale at 17 days.
            A failed resync, tested by stopping the replay mid-session: 34 rows
            still held, synced_at unchanged at the last good read, and the page
            renders "Showing rows read 7 min ago — 34 rows · last resync failed:
            NS Records: Could not reach Airtable." in amber.
            Chromium sweep, nine pages at 1440px and 400px: document overflow 0
            at both widths on every page, no uncontained wide element on any of
            the eight in scope, card rows uniform at 82–91% content fill, twenty
            rows and a pager wherever a list is paged. No console errors beyond
            the Inter webfont this sandbox cannot fetch.
            Not verified here: the live service, which this sandbox cannot
            reach — and which is running none of this, because main is three
            commits behind.

## 2026-09-11 19:55 — One table for every record list
Intent:     Open loops rendered its list as a real table and read well; Codex
            entries, North Star, Research Twin, Build patterns and Commercial
            each rendered a stack of cards with content anchored to four
            different points per card, so nothing lined up between rows or
            between pages. Convert all five to the same table component as Open
            loops, and make Open loops itself use it, so row styling lives in
            one place and cannot drift apart again. Nothing above the list was
            to change on any page — stat cards, charts, filter bars, search
            boxes and captions all stay as they were.
Files:      src/components/ui/RecordTable.tsx (new), src/components/ui/Table.tsx,
            src/components/ui/index.ts, src/components/ui/ListRow.tsx (deleted),
            src/index.css, src/data/types.ts, server/src/sources.ts,
            src/screens/OpenLoops/Loops.tsx, src/screens/Codex.tsx,
            src/screens/NorthStar.tsx, src/screens/ResearchTwin.tsx,
            src/screens/BuildPatterns.tsx, src/screens/Commercial.tsx
Problem:    "Breakthroughs" was asked for as a Codex column and no such field
            exists. Read the live schema of all six builder tables in
            appEmdKshNVTl64Zf: 23 fields, none of them breakthroughs. Read a
            real Orchestrator Layer2 Review from Destiny's table
            (rec25I6C9W7289AcG) and the reason became clear — Layer 2 writes
            every entry to a fixed section template and the first section is
            "Breakthroughs", followed by Blockers, Ruled Out, Engine Gaps
            Identified and eleven more.
Fix:        A `breakthroughs` field on CodexEntry, read server-side from the
            Layer 2 review by that heading — the section ends at the next short
            line carrying no bullet marker — falling back to the entry's opening
            lines when an entry is written in some other shape, and null when no
            entry exists at all. `entry_excerpt` stays as it was, because the
            builder detail page shows the opening of the entry and that page was
            not in scope. Verified on three shapes: the real record's text
            (heading found, stops before Blockers), a free-form entry with no
            headings (falls back), and a row with no Layer 2 review (null).
Decision:   Row height is a CSS rule, not a guess per page. `.rows-1` (38px) and
            `.rows-2` (56px) in index.css, set by RecordTable from its `lines`
            prop, above 768px only — below that the table stacks into cards and
            sizes itself. Every cell is nowrap and clipped, so those are exact
            heights rather than minimums, and the two-line cell always draws its
            description line even when the record carries none. Measured: one
            distinct row height per page, on every page.
Decision:   Every table keeps a `source` column. It is not in the requested
            column list for the five pages, but CLAUDE.md section 8 requires
            every row to link back to its source, and Open loops — the reference
            design here — has always carried one.
Decision:   North Star's `reason` column falls back to the answer when a row
            carries no reason, drawn in the muted tone with a tooltip that says
            which it is, rather than leaving the widest column blank on rows
            that have something to read.
            Verified with Chromium against the local Airtable replay, 1440px and
            400px. Every page renders one shared table: one row height per page
            (39px outer on the five single-line pages, 56px on the three
            two-line ones), a header row naming every column, no wrapped cell on
            any row, the actions cell last on every row, twenty rows to a page,
            and document overflow 0 at both widths — the frame scrolls, the page
            body never does. Codex's column caps were trimmed after the first
            measurement (breakthroughs 64ch → 54ch, codex id 26ch → 22ch,
            session type 24ch → 20ch) to bring the table from 1495px to 1370px,
            in line with Open loops at 1447px.
Problem:    The sweep would not run: `Cannot find module 'playwright'` from the
            scratchpad. Playwright is a dependency of this repo, not a global.
Fix:        Ran the sweep script from the project root as a .cjs file, and
            deleted it afterwards.

## 2026-09-12 17:05 — State moved from SQLite on an ephemeral disk to Postgres
Intent:     Move every persisted read and write off the server's own
            filesystem and into the Postgres 18 instance (bha-engine-db) now
            attached to the same Render environment, with DATABASE_URL set on
            the service. Keep the HTTP API surface identical so the front end
            needs no change. Audit first, then implement; no commit, no deploy.
Files:      server/src/pg.ts          new — pool, TLS decision, startup check
            server/src/migrations.ts  new — forward-only numbered migrations
            server/src/db.ts          rewritten: meta key/value over Postgres
            server/src/store.ts       every read and write now async over pg
            server/src/engine.ts      the reads that touch the store are async
            server/src/sync.ts        one transaction per table per resync
            server/src/index.ts       boot(): assert → migrate → listen
            package.json              + pg ^8.23.0, + @types/pg (dev)
            render.yaml               disk removed, databases: block added
            README.md, CLAUDE.md, .env.example, .gitignore

Audit:      What was persisted, and where, before this change — one SQLite file
            at `${DATA_DIR}/dashboard.sqlite` through node:sqlite, four tables:
              meta         history_since, schema_version, sync:<kind> (×8),
                           clients:tables, codex:layer0
              records      the read model for all eight kinds, PK (kind, id)
              events       status changes with timestamps — the ONLY place a
                           close is dated, since the loop tables carry none
              observations a figure as seen at one resync, for the two trends
            Write sites: store.upsert, purgeMissing, removeInbound, observe,
            setMeta via setSyncState / setQuestionTables / setLayer0Holds /
            ensureSchema. Read sites: rows, rowById, getMeta, observations, and
            the events query inside loopMetricsFor.
            In-memory only (unchanged, and correctly so): auth.ts failure
            counters and the revoked-session set, sync.ts's `running` map,
            store.ts's metricsCache. Browser-only (out of scope): theme,
            weather cache, and Ask Bays chat threads in localStorage.

Problem:    The conversion is not mechanical in one respect: node:sqlite's
            DatabaseSync is synchronous and `pg` is not, so every store read
            became a promise and the change propagated through engine.ts and
            index.ts. Done as an explicit async conversion rather than by
            hiding a cache behind the old synchronous signatures — a cache
            would have reintroduced the in-memory store this move exists to
            remove.

Problem:    Five migration runners racing on a fresh database killed one of
            them outright:
              duplicate key value violates unique constraint
              "pg_type_typname_nsp_index"
            The advisory lock covered each migration but not the
            `CREATE TABLE IF NOT EXISTS schema_migrations` bootstrap above it,
            and that statement is not safe against a concurrent identical
            CREATE — the two sessions race in the system catalogue. Render
            overlaps the old and new instance on a deploy, so this is the
            normal case, not an exotic one.
Fix:        One session-level advisory lock held across the whole run,
            bootstrap included, on a single checked-out client; each migration
            still commits in its own transaction. Re-tested with eight racing
            runners: one applies, seven report "already", no failures, five
            tables, one row in schema_migrations.

Decision:   No fallback, and the process exits rather than degrading. A missing
            DATABASE_URL, an unparseable one, or an unreachable database each
            print what is wrong and what to do about it, then exit 1 before the
            listener opens. A server that started anyway would accept writes it
            could not keep and show figures it could not stand behind — which
            is exactly how data goes missing without anyone noticing. Verified
            all three paths return exit 1.

Decision:   `records.json` stays `text` and the timestamps stay `text` rather
            than becoming `jsonb` and `timestamptz`. The column values are the
            exact strings Airtable returned — 'YYYY-MM-DD' in raised_at and
            closed_at, full ISO instants elsewhere — and the metrics compare
            and slice them as strings. Native types would reformat them coming
            back out and silently change what those comparisons mean. `json`
            has a second reason: searchPatterns matches the raw record text,
            and jsonb does not preserve it.

Decision:   Migrations never drop a table. The old ensureSchema dropped and
            rebuilt whenever SCHEMA_VERSION changed, which was honest while the
            file was wiped every deploy regardless. It is not honest now:
            events and observations are the first state in this system that
            actually survives a restart. A read-model shape change is a
            migration that alters it, or one that truncates `records` on
            purpose and lets sync.ts refill it from Airtable.

Decision:   `history_since` is written with an INSERT ... ON CONFLICT DO
            UPDATE SET value = meta.value RETURNING value, so the first boot
            against a fresh database stamps it and every later boot leaves it
            alone. It now means "when this database started recording status
            changes" rather than "when this process started". The page notes
            that cite it were reworded to match; nothing else about them moved.

Decision:   One transaction per table inside a resync, rather than per row.
            Every row and the purge land together or not at all, so a page
            never renders a half-rebuilt table, and ~1,600 statements for the
            loops rebuild cost one commit instead of 800.

Decision:   TLS is decided from the URL. A single-label host (Render's internal
            dpg-…-a) gets no TLS, because enabling it there fails the
            handshake; a public host gets TLS, verified properly when
            DATABASE_CA_CERT is set and with verification relaxed and a printed
            warning when it is not. `sslmode` in the URL overrides all of it.

Decision:   `/api/status.data_dir` keeps its name and its type so the front end
            is untouched, and now carries the Postgres server version, host and
            database — never the password, since that response reaches the
            browser. Nothing renders it today; Settings shows history_since and
            records_held, both unchanged in shape.

Decision:   `pg` is the server's first dependency past Node itself, which
            CLAUDE.md §2.5 previously forbade. Added on Destiny's explicit
            instruction in this session; §2.5 and the README were updated to
            say one dependency rather than none, and to mark that as a ceiling
            rather than a precedent.

Verified:   Against a real Postgres 16 (local, 127.0.0.1:55432) with the
            compiled server, not a mock:
            - boot on an empty database applies migration 1; second boot
              reports "up to date" and applies nothing; five tables created
            - missing / malformed / unreachable DATABASE_URL each exit 1 with
              the reason printed
            - three loops pushed through /api/inbound/loops: correct insert,
              a repeat reported changed=false inserted=false, a status change
              reported changed=true and wrote one event row
            - /api/open-loops, /api/records/loops/metrics, /api/builders/
              destiny, /api/overview, /api/status all correct against those
              rows: by_owner totals, age buckets 8–14 and 31–60, closed_per_day
              09-12=1 read from the events table, records_held loops=3
            - every GET route 200: 14 page routes, 6 metrics routes, the
              pattern search
            - PATCH with no AIRTABLE_API_KEY still refuses with 503 and the
              same sentence, and changes nothing
            - RESTART: rows, events and history_since all survived, and
              closed_per_day still read 09-12=1 — the point of the exercise
            - purgeMissing: removes exactly the rows a full read no longer
              contains, is idempotent on a second call, and with an empty keep
              set removes every row of that table, as before
            - a throw mid-transaction rolls back with nothing left behind
            - eight concurrent migrators: one applies, seven no-op, none fail
            - npm run build clean (client and server); both typechecks clean
            - nothing leaked into the bundle: the only grep hit is the literal
              string "AIRTABLE_API_KEY" inside an existing UI message

Not done:   No commit and no deploy, as asked — the diff is for review first.
            Ask Bays chat history is still browser-local; moving it to Postgres
            would change the API surface, which this task explicitly ruled out,
            so it stays for the phase that wires Bays's memory.

## 2026-09-12 17:40 — render.yaml corrected against the live Render API
Intent:     Replace the plan string I had guessed with the one Render's API
            actually reports, add the region and disk floor, and confirm no
            service-level disk block survives anywhere in the blueprint.
Files:      render.yaml
Problem:    I had written `plan: basic-256mb` from the public plan naming. The
            API reports the tier as `0.1c-256mb`. Both are accepted and mean
            the same tier, but a blueprint should carry the canonical string
            rather than an alias, so the file reads the same as the instance.
Fix:        plan: 0.1c-256mb, region: oregon, diskSizeGB: 1 on the database.
            Destiny confirmed disk autoscaling is on, so 1 GB is the floor and
            not a cap.
Decision:   No `region` on the web service. It is already in environment
            evm-dai49rmq1p3s73b2al2g with the database, and declaring a region
            on a service that exists is a way to cause a mismatch rather than
            to prevent one. The internal connection string resolves because the
            two share that environment; no ipAllowList entries exist and none
            are needed, since nothing connects from outside it.
Verified:   No `disk:`, `mountPath`, `sizeGB`, `DATA_DIR` or `/var/data`
            anywhere in render.yaml. The only `diskSizeGB` is the database's.
Verified:   Pre-commit audit of the two guarantees, read out of the code rather
            than recalled:
            - No fallback path exists. No `node:sqlite` import, no
              `DatabaseSync`, no `DATA_DIR`, no `mkdirSync` in server/src or
              src — the five remaining mentions are comments recording what
              this replaced. `pg` is the only runtime dependency. Every exit
              in the boot path is exit 1; the only exit 0 is the SIGTERM
              handler. `assertDatabase()` is called once, at index.ts:401,
              awaited and not caught, before `server.listen` at :405 — the
              listener is unreachable until it returns. `getPool()` throws
              rather than improvising if DATABASE_URL is absent.
            - Migration 1 creates meta, records, events, observations, four
              indexes and schema_migrations, and nothing else.
            - The advisory lock is session-level (`pg_advisory_lock`, not the
              transaction-scoped variant), taken on one checked-out client
              before the schema_migrations bootstrap and released in `finally`.
              It therefore covers the bootstrap CREATE as well as every
              migration body — which is the fix, since the bootstrap was what
              killed a runner in the earlier race.

## 2026-09-12 18:20 — Ask Bays pointed at a retired n8n host; config untangled
Intent:     Move every live reference off n8n.arupiautomates.cloud, which is
            retired, onto the company instance; stop the URL being invisible
            when it is wrong; and settle the four render.yaml decisions.
Files:      server/src/ask.ts, server/src/index.ts, render.yaml,
            src/data/fixtures/common.ts, .env.example, README.md

Problem:    The boot log printed
              ask bays: https://n8n.arupiautomates.cloud/webhook/dashboard-ask-bays
            against a dead instance. The premise that the URL was not an
            environment variable turned out to be half right, and the half that
            was wrong is the interesting half: ask.ts already read
            process.env.ASK_BAYS_URL. What was hardcoded was the FALLBACK. No
            ASK_BAYS_URL is set on the service, so the fallback is what ran.
            The mechanism existed, nothing used it, and the log printed a
            real-looking URL either way.
Fix:        ASK_URL_FALLBACK now names the company instance, and ASK_URL reads
            ASK_BAYS_URL first (trimmed, so a whitespace-only value does not
            beat the default). ASK_URL_FROM_ENV is exported and the boot log
            prints which source won:
              ask bays: https://bayshorizonnetwork.app.n8n.cloud/webhook/dashboard-ask-bays (ASK_BAYS_URL)
              ask bays: https://bayshorizonnetwork.app.n8n.cloud/webhook/dashboard-ask-bays (built-in default — ASK_BAYS_URL is not set on this service)
            Both branches verified against the compiled server. A URL alone
            cannot tell you that nobody chose it, which is why this line went
            wrong quietly for as long as it did.

Decision:   render.yaml no longer declares DATABASE_URL at all (Destiny,
            2026-09-12). The manual value, set via Add from database, tracks
            the instance through a credential rotation; a blueprint literal
            cannot, and two sources on one key is how a value silently flips
            back on a later redeploy. A comment names the variable and says it
            is set on the service, so its absence does not read as an
            oversight. The rule, in Destiny's words: secrets and linked
            resources stay out of the blueprint, non-secret config stays in it.
            ASK_BAYS_URL is therefore kept in the blueprint, with the host
            corrected.
Decision:   databaseName corrected bha_engine → bha_engine_db, the value the
            live instance reports. I had guessed it from the instance name in
            the earlier commit and never verified it; the Render API says
            otherwise.

Problem:    Destiny flagged that src/data/fixtures/common.ts is client-side and
            asked me to confirm process.env is available there before using it,
            rather than reaching for a workaround.
Fix:        Checked rather than assumed, and it is server-side. The only
            importer of src/data/fixtures anywhere is server/src/engine.ts;
            `grep -c arupiautomates dist/assets/*.js` is 0 both before and
            after this change, so the module has never been in the browser
            bundle. It lives under src/ and tsconfig.app.json type-checks it,
            but Vite bundles by import graph, not by tsconfig include, so
            nothing pulls it in. process.env is Node's here and is read at run
            time. No workaround was needed and none was added.
            The fragility is real but latent, and is written at the line: if a
            client module ever imports these fixtures, the page breaks with
            "process is not defined", because Vite does not shim process.env —
            the replacement would be an import.meta.env.VITE_ variable read at
            build time.
Decision:   The execution links take the base from N8N_BASE_URL, defaulting to
            the company instance, and the host was NOT simply swapped. Every
            execution id in fixture data predates the migration: the old
            instance was numbering in the 90,000s and the company instance
            restarted at 1, so those ids do not exist on the new host and will
            404. Executions recorded after the move resolve. This is accepted
            and expected, and the comment at that line says so in those terms,
            including not to "fix" it by pointing the host back at the retired
            instance — a link that looks right and fails is worse than one that
            is visibly stale.

Verified:   npm run typecheck and npm run build clean. After the change the
            browser bundle contains neither "arupiautomates" (0) nor
            "N8N_BASE_URL" (0), confirming the fixtures are still server-only.
            n8n('91234').url resolves to the company host by default and
            follows N8N_BASE_URL when set. render.yaml parses: DATABASE_URL
            absent from envVars, ASK_BAYS_URL on the new host, database block
            reading bha_engine_db / 0.1c-256mb / 18 / oregon / 1 GB.
            Every remaining "arupiautomates" hit in the repo is either
            BUILD_LOG history or a comment explaining the retirement. No live
            URL names the old host anywhere.
Not done:   BUILD_LOG history untouched, per section 9 and Destiny's
            instruction — those lines were true when written. N8N_BASE_URL is
            documented in .env.example and README but is NOT declared in
            render.yaml; by the rule above it could be, and that is Destiny's
            call rather than mine. No merge: this stays on the branch.

## 2026-09-12 18:45 — N8N_BASE_URL declared; a reasoning note on what ships to the browser
Intent:     Finish the config rule — non-secret config lives in the blueprint —
            and record why the bundle question was answered the way it was.
Files:      render.yaml
Fix:        N8N_BASE_URL declared with
            https://bayshorizonnetwork.app.n8n.cloud, placed after the
            ASK_BAYS_* group so those keys stay together. Validated: twelve
            envVars, DATABASE_URL still absent by design.

Decision:   Reasoning note, kept because the next person will make the same
            inference (Destiny, recording his own, 2026-09-12).

            The question was whether src/data/fixtures/common.ts ships to the
            browser, which decides whether process.env can be read there at
            all. Destiny read it as client-side, from two signals that both
            point that way: the file sits under src/, and tsconfig.app.json
            has "include": ["src"], so TypeScript type-checks it as part of the
            front-end project. Reasonable, and wrong.

            **Vite bundles by import graph, not by tsconfig include.** A file
            being type-checked by the app project says nothing about whether it
            reaches the bundle; only whether some module reachable from the
            entry point imports it does. Here nothing in the browser does —
            server/src/engine.ts is the sole importer of src/data/fixtures
            anywhere in the repo — so the module is compiled twice by two
            tsconfigs and bundled by neither Vite entry.

            What settled it was not reading the config but checking the two
            things that are actually load-bearing: the import graph, and the
            built artefact. `grep -c arupiautomates dist/assets/*.js` was 0
            before the change and `grep -c N8N_BASE_URL dist/assets/*.js` is 0
            after it. Both greps, not either alone — the first proves the
            module was never bundled, the second proves this change did not
            start bundling it.

            The generalisation worth keeping: to know whether something ships
            to the browser, grep the built bundle. Directory layout and
            tsconfig coverage are both circumstantial, and they were both
            misleading here.

            The latent risk stands and is written at that line: the day a
            client module imports these fixtures, process.env is suddenly in
            the bundle and the page dies with "process is not defined", because
            Vite does not shim it. The replacement would be an
            import.meta.env.VITE_ variable, read at build time rather than run
            time — a different mechanism, not a tweak.

Not done:   Still no merge. DATABASE_URL is not set on bha-engine-dashboard —
            Destiny checked the service environment directly: eight variables,
            none of them the database. Merging would put the startup check
            straight into the failure it is designed to produce, which is the
            check working rather than a bug, but a failed deploy either way.
            Merging waits on that variable being set.

## 2026-09-13 19:45 — System Registry: workflows, services and the billing behind them
Intent:     Build a new page answering the two questions nobody can answer
            without asking Destiny: which workflow does X, who owns it and
            where do I look when it breaks; and what does BHA pay for, who
            manages it, what does it cost, when does it renew. Six Postgres
            tables, seeded, read from the database, every row editable inline.

Files:      server/src/migrations.ts       migration 2, six registry tables
            server/src/registry.ts         schema spec, CRUD, spend, seeding
            server/src/registrySeed.ts     the opening contents (new)
            server/src/index.ts            /api/registry routes, boot seeding
            src/data/types.ts              registry shapes
            src/data/index.ts              registry data functions
            src/screens/Registry/index.tsx the page, five tabs
            src/screens/Registry/Editable.tsx inline cell + add-row form
            src/App.tsx, src/components/Layout.tsx  route and sidebar entry

Decision:   **Patterned on Clients.tsx**, which was the closest existing
            screen: one read through useData, a card-framed dense table with
            a sticky action column, Segmented filters plus SearchBox above it,
            StatStrip for the headline counts, usePaged/Pagination, and Toast
            for write feedback. No new dependency, no new state library, no new
            styling approach; every colour is an existing token.

Decision:   **This dashboard is the system of record for these six tables**,
            which is the one place this page deliberately departs from the rule
            in CLAUDE.md section 4 that Airtable owns every record kind. There
            is no upstream table holding the billing owner of Otter.ai or the
            pillar of a workflow, so a read model would have nothing to read
            and a resync nothing to resync. Writes go straight to Postgres and
            stay there; there is no resync control on the page, and the page
            says so in its own words at the top rather than leaving the reader
            to infer it from an absence.

Decision:   **Deletes are soft and there is no hard one.** A registry whose
            answer to "did we ever pay for that" is a missing row is not a
            registry. `deleted_at` hides a row from the default listing; "show
            removed" brings it back with a Restore action. A seeded row that
            was removed is *not* resurrected by a restart — seeding is
            `ON CONFLICT (id) DO NOTHING`, and a soft-deleted row still holds
            its id, so the conflict fires and nothing is written. Verified by
            deleting a row, restarting, and reading it back still deleted.

Decision:   **No column exists that a secret value could be written to.**
            registry_credentials holds name, type, used_by, owner and notes.
            Adding a value column would take a migration and a decision, which
            is the point; the tab carries a banner saying so, because that
            table is exactly where someone would reach to "keep the key safe".
            The seed was read from the live n8n credential list — names only.

Decision:   **The monthly total never appears without the count of what is
            missing from it.** A figure built from one of ten services is not
            what BHA spends. The server returns `priced`, `unpriced` and
            `not_monthly` alongside the totals and the card prints them in the
            same note; with nothing priced there is no number at all, just the
            sentence saying a zero there would claim BHA spends nothing, which
            is a different thing entirely. Totals are per currency and are
            never summed across currencies — GBP 1500/yr and USD 50/mo render
            as two figures, not one. One-off and no-cycle rows count as priced
            but are excluded from the monthly figure and counted separately.

Decision:   **Airtable bases live on the Endpoints tab, not Services.** They
            are the other set of addresses the engine talks to, and nobody is
            billed for a base — Airtable is one service. Ten unpriced base rows
            in the services table would have inflated the spend denominator
            from ten to twenty and made an already-incomplete total read as far
            worse than it is.

Decision:   Seed data was **read back from the live sources rather than taken
            on trust**, per CLAUDE.md section 3. The n8n BHA Engine project
            supplied folder, pillar, owner, status, trigger type, trigger
            detail and purpose for 29 of the 30 workflows, read from each
            workflow's own overview sticky note and trigger configuration —
            none of it inferred from a name. The Render API supplied the live
            service inventory. Where a field could not be read it is null and
            renders as a dash; where the live source disagreed with the brief,
            the row's notes records both readings rather than silently picking
            one.

Problem:    Thirteen columns in a fixed-width table crushed the short ones:
            "active" rendered as "a…" and a null plan as "—…", because the
            editable cell carried `truncate` and `w-full` and collapsed to
            whatever width was left.
Fix:        The cell only clips when it was given an explicit width; short
            fields are `whitespace-nowrap` and read whole. Each table declares
            a min-width and the card scrolls sideways inside itself when the
            column is narrower — permitted by section 5, which forbids the page
            *body* scrolling sideways, not a table in its own container.
            Verified at 400px: document horizontal overflow is 0.

Problem:    A service created from the interface had a null status while
            `spendOf` counted a null status as active — so a new row was in the
            spend denominator while displaying as "not recorded".
Fix:        A `defaultOnCreate` on the field spec, applied only where the
            caller named no value at all. Services default to `active`,
            workflows to `production`. Stated defaults, not inferred ones.

Verified:   npm run typecheck and npm run build clean. Against a local
            Postgres 16: boot applied migrations 1 and 2 and seeded 95 rows
            (workflows 30, services 10, credentials 29, endpoints 9, bases 10,
            people 7); a second boot reported "already populated" and wrote
            nothing. Through the API — create with a derived id, patch, soft
            delete, restore, and a re-create colliding with the soft-deleted id
            answering 409 with the restore hint. Validation refuses an unknown
            field ("secret_value" is not a field a service has), a select value
            outside its vocabulary, a date that is not YYYY-MM-DD, a negative
            cost and a URL with no scheme. Clearing a cell stores null, not "".
            An edit and a soft delete both survived a restart. Spend: USD 50/mo
            plus GBP 1500/yr rendered as two totals (USD 50, GBP 125), a
            one-off counted as priced but not monthly, renewal 12 days out
            flagged soon and one in the past flagged overdue. In Chromium:
            signed in, opened the page, edited a cost, currency and cycle
            inline and watched the total go from "Not recorded" to "USD 42 per
            month · 1 service / Computed from 1 of 10 active services. 9 have
            no cost recorded. This is not the whole bill." Escape discarded a
            draft instead of committing it. No console or page errors on any
            tab, in light or dark.

Not done:   Cost, currency, billing cycle, renewal date and billing owner are
            null on every one of the ten services — nobody supplied them and
            this build will not invent one. Two workflows could not be read
            from n8n and carry null pillar, trigger and purpose with a note
            saying why: North Star — Capacity Intelligence is archived and the
            API refuses it, and the vFarm funnel workflow has MCP access turned
            off. Per-Render-service billing rows were not created; the live
            eight-resource inventory is recorded in the Render row's notes
            instead, so the spend denominator stays the ten briefed services.

## 2026-09-13 20:10 — Inventory: what the dashboard reads from Airtable today
Intent:     Before mirroring anything into Postgres, write down exactly what is
            read, from where, by which page. Everything in the dual-write build
            is scoped to this list; a table nothing reads does not get mirrored.
            Read from server/src/sources.ts and server/src/sync.ts, and each
            base's schema re-checked live on 2026-09-13.

**Read, and therefore in scope (nine tables, five of them fanned out):**

1. Open Loops — `appUVlBSGGPHw6DGh`, seven per-builder tables, identical schema.
   `tblBJekl3ROpNZxQW` Destiny · `tblVOLhWULskNiIUt` Jason ·
   `tblOhjIS8t0dtCQmt` Kaiqi · `tblqMepD3XGZY4tZz` Jegan ·
   `tbl3bTRcuUcbYXgDc` Ahad · `tblaloC4JIRdBq5EM` Hardik ·
   `tbltm7QUmWAZpzTKz` Kavin.
   Fields: What · Raised By · Date Raised · Source Link · Status ·
   Assignee Slack User ID · loop_id · lane_tag · raised_in · last_modified.
   Sync kind `loops`. Pages: Open loops, Builders (list and detail), Overview.
   **The table a row sits in is its owner.** `Assignee Slack User ID` disagrees
   with the table on real rows and is not the owner — that mismatch was a live
   bug in the daily sweep on 7 Sep.

2. BHA Submissions & Logs — `appEmdKshNVTl64Zf`, six per-builder tables.
   `tblSqm5ty9QVTlmuA` Destiny · `tblTu46ZQYHrim4yI` Jegan ·
   `tbl6QBXrgtLv9axqu` Kaiqi · `tblPrGLTE6GGFIHum` Hardik ·
   `tblG67z5RRZyoBZSj` Ahad · `tbltOCB2DHE5FFXa6` Kavin. No Jason table — he
   reviews logs, he does not submit them.
   Fields read: Submission ID · Codex Entry ID · Timestamp · Session Type ·
   Session Url · Narration Quality · Submission Source · Jason Status ·
   Jason Notes · Layer0 Flagged · Layer0 Missing · Orchestrator Layer2 Review ·
   `Layer1 Review ` (trailing space, in every table) · Processed At ·
   Processed Date · Summary · Session Description · Builder Name.
   Sync kind `codex`. Pages: Codex entries, Builders, Overview.

3. Layer 0 holding table — `appEmdKshNVTl64Zf` / `tbljoWu73vsxyL6vc`.
   Fields: Submission ID · Builder User ID · Builder Username · Missing Fields ·
   Status · Created At · Session Description · Session URL · Channel ID.
   Not a record kind — no status, no write path — held whole by
   `store.setLayer0Holds`. Page: Codex, Incomplete tab.

4. Build Patterns — `app5ni3E8r7Lvxk22` / `tblaMXSMjmz30OvcU`.
   pattern_id · pattern_name · pattern_status · bha_system · reusability ·
   created_at · problem · solution · context · next_use_case ·
   commercial_impact · research_production_impact · learnings_gotchas ·
   readiness_gates · implementation_checklist · integration_points ·
   test_coverage · routing_logic · anti_pattern · naming_note · roadmap_context.
   Sync kind `patterns`. Page: Build patterns.

5. Commercial Opportunities — `appvLglfdCqOKqLpT` / `tblyXShZLOFT3jNMe`.
   card_id · opportunity_title · lane_id · readiness_state · confidence ·
   pilot_state · routing_state · lane_state · lane_state_blocked_reason ·
   engine_movement_state · demand_evidence · infra_readiness · data_readiness ·
   media_readiness · media_gate · missing_research_count ·
   missing_research_questions · next_action · pain_point · offer · target ·
   who_pays · bha_system · created_at.
   Sync kind `commercial`. Page: Commercial.

6. NS Records (North Star ask log) — `appkCTjhH8PtYRFI7` / `tbl9OGZTyvBKrbeFm`.
   trace_id · lane_id · workflow · request · actual_result · expected_result
   (a JSON blob carrying searches, confidence, session_id) · outcome ·
   research_required · reason · timestamp.
   Sync kind `ns`. Page: North Star.

7. Research Queue — `appud969Dw7H4tMwv` / `tblUl8YHhQReDgq8G`.
   card_id · lane_id · hypothesis_to_validate · context_snippet · status ·
   confidence_level · research_sufficiency · gap_classification ·
   missing_elements · target_source_types · research_summary ·
   links_or_sources · learnings_gotchas · answer_history · run_count ·
   requires_human · first_stuck_at · source · created_time.
   Sync kind `rt`. Page: Research Twin. **An attempt log — card_id repeats.**

8. Watched Clients index — `appkSUSh9ijNjP2f8` / `tblFJ1yuYcuanjPdn`.
   Lane / Client · Lane ID · Lane Type · Client ID · Questions Table ·
   Table ID · Lane Status · Run State · Last Run At · Next Run Due ·
   Last Run Status · Consecutive Error Count · Infra Fix Required ·
   First Stuck At · Stuck Cycle Count · Quarantined · Commercial Hook ·
   Interested Parties · Latest Memo Link.
   Sync kind `clients`. Page: Clients.

9. Per-lane question tables — `appkSUSh9ijNjP2f8`, table ids **not hardcoded**:
   each index row names its own in `Table ID`, followed at sync time.
   Question · This Week Answer · Plain Summary · Confidence · Sources ·
   Movement Tag · Answer History · Last Updated · Missing Research ·
   Research Stuck · Next Experiments · Run Count.
   Sync kind `client_questions`. Page: Clients.

**Deliberately NOT mirrored — nothing in the dashboard reads them:**

- `appud969Dw7H4tMwv` / research_twin_research_jobs — one test row, never read.
- `appINvgEoZjuYQI2O` / error_counts (`tblnvhKOnuOoiB1RX`) — written by the
  three error handlers, read only by them.
- `appINvgEoZjuYQI2O` / Table 1 (`tblFirFiPmUcINkBh`) — engine events, unread.
- `apprzpppxE2yV0q84` Channel Tracking, `appMNvZsFRb9isRRq` Bays Tools Router,
  `appSoakKvs7MLkRnX` Priority Ledger, `appxkIgnLL1zBsXqD` Lane_status — all
  registered in the System Registry as bases the engine uses, none of them read
  by this dashboard.

**One addition, in scope only because Part 3 makes it read:**

- `appINvgEoZjuYQI2O` / digest_deliveries (`tblNuMju8l1kL3Sd1`).
  session_id (primary, and the key the Callback Receiver matches on) · kind ·
  builder_id · builder_name · channel_id · loop_count · sent_at ·
  delivered_at · status (sent / delivered / missing) · flagged_at · notes.
  Mirrored because the delivery-health figure asked for on the registry reads
  it. It was not read before today.

Decision:   Nine tables in, ten with digest_deliveries. Twenty-two physical
            Airtable tables collapse to ten Postgres tables, because the seven
            loop tables and six submission tables are one schema each and the
            builder is carried as a column.

## 2026-09-13 20:45 — Dual-write: the engine writes into Postgres, and the backfill that seeds it
Intent:     Steps 1 and 2 of moving off Airtable. Mirror every Airtable table
            the dashboard reads into Postgres, backfill it, and open an
            authenticated write path so n8n can post records straight here.
            Step 3 — cutting the pages over and retiring the sync — is
            deliberately not in this task.

Files:      server/src/migrations.ts   migration 3: ten mirror tables + engine_writes
            server/src/mirror.ts       the table spec, the one upsert, the log (new)
            server/src/backfill.ts     the runnable backfill command (new)
            server/src/index.ts        POST /api/engine/:kind, GET /api/engine-writes
            server/src/registrySeed.ts the Digest Delivery Check workflow
            src/data/types.ts, src/data/index.ts
            src/screens/Registry/index.tsx  the Engine writes tab, digest health
            package.json               npm run backfill
            README.md                  the endpoint contract

Decision:   **Nothing in the Airtable read path was touched.** sources.ts,
            sync.ts, store.ts and airtable.ts are byte-identical; `records` is
            still the read model, the fifteen-minute resync still rebuilds it,
            and every page still renders from it. Verified after the change:
            /api/open-loops 576, /api/codex 150, /api/build-patterns 149,
            /api/commercial 21, /api/clients 3, all still source=airtable.
            Removing any of it now would empty the dashboard, which is the
            whole reason step 3 is a separate day.

Decision:   **Ten Postgres tables for twenty-two Airtable tables.** The seven
            loop tables and six submission tables are one schema each, so they
            collapse with a `builder_id` column — and the column is filled from
            *which table the row was read from*, never from
            `Assignee Slack User ID`, which disagrees on real rows and caused a
            live mis-delivery on 7 Sep. The write endpoint takes `builder_id`
            or `table_id` for the same reason and refuses without one.

Decision:   **Airtable's `fields` object is stored verbatim as jsonb, names
            untouched.** `What`, `Jason Status`, `Layer1 Review ` with its
            trailing space. A hand-written column list would silently drop any
            field I forgot or anyone adds to a base later, and silent field
            loss is the failure this engine has already hit three times. Columns
            are promoted out of the blob only where something keys or filters on
            them, and always derived from the payload so they cannot drift.
            Verified in Postgres: the trailing-space key is present and the
            trimmed spelling is absent.

Decision:   **`airtable_record_id` is UNIQUE but nullable; the natural id is
            indexed and deliberately NOT unique.** The Research Queue is an
            attempt log — 213 attempts across 12 `card_id`s in the test data —
            so a unique constraint on the natural id would reject real rows.
            `rt` and `client_questions` therefore key on the record id alone and
            say so when a caller omits it.

Decision:   **One upsert function for both paths.** The backfill and the write
            endpoint call the same `mirror.upsert`, so a row read from Airtable
            and the same row written by n8n land identically. It also gives
            adoption for free: a loop the engine creates by `loop_id` with no
            record id is *adopted* when Airtable's id later arrives, rather than
            inserted a second time. Verified — row id 577 throughout, one row.

Problem:    The second backfill run reported all 1164 rows as `updated` when it
            should have reported them unchanged. `changed` was computed by
            comparing `JSON.stringify` of the stored fields against the incoming
            fields — but jsonb does not preserve key order and normalises
            numbers, so a round trip reorders the object and the two strings
            never match. An idempotency check that always says "changed" is
            worse than none: the whole point of re-running the backfill during
            dual-write is that a reported change means a real disagreement.
Fix:        Postgres decides, not this process. The UPDATE joins a `before` CTE
            and returns `b.fields IS DISTINCT FROM t.fields`, which compares
            jsonb by value. Three consecutive runs now read 1164 and report
            1164 already current, 0 changed.

Problem:    `column reference "airtable_record_id" is ambiguous` on every update
            once that CTE was added — `before` carries the same columns as the
            target.
Fix:        Qualified the right-hand side of the SET clauses with the target
            alias.

Problem:    On a fresh database the registry's engine_events row kept its old
            description. Migration 3's guarded UPDATE runs *before*
            seedRegistry, so on a database with no registry rows yet it matched
            nothing, and the seed then inserted the old wording. Production —
            where the rows already exist — would have got the new text, so the
            two would have disagreed depending on install date.
Fix:        The seed carries the new wording *and* the migration keeps its
            guarded UPDATE for databases already seeded with the old one. Both
            paths converge. Verified both ways: a fresh database seeds the new
            text, and a database rewound to the old text and rebooted has
            migration 3 apply it. The guard is an equality check on the original
            string, so a row Destiny has reworded himself is left alone —
            verified too.

Verified:   npm run typecheck and npm run build clean. Against Postgres 16 with
            a local replay of the Airtable REST API (AIRTABLE_API_URL, the hook
            already in airtable.ts) serving the live field names and record
            envelope, 1164 records across 22 tables including a 336-row table so
            the pagination loop runs:
            - backfill run 1: 1164 inserted, 0 failed. Runs 2 and 3: 1164
              already current, 0 inserted, 0 updated, 0 failed.
            - 7 loop tables → 576 rows, 7 builders. 6 submission tables → 150
              rows, 6 builders. rt 213 attempts / 12 cards.
            - a lane whose index row names no Table ID is skipped and reported,
              never guessed.
            - auth: no key and a wrong key both 401 before any handler runs.
            - validation, each naming the field: missing `fields`; the record's
              top level sent instead of `.fields`; missing `builder_id`; an
              unknown builder; `codex` for Jason (he has no submissions table);
              `rt` without a record id; a malformed rec… or tbl… id.
            - insert → unchanged → updated → adoption, all on one row.
            - every write recorded in engine_writes with its outcome and, for a
              refusal, the reason.
            In Chromium: the Engine writes tab renders the per-table split and
            the recent writes; the digest figure reads "1 of 2 sent" when there
            are rows and "Not recorded" when there are none.

Not done:   No page reads a mirror table. No Airtable read was removed, changed
            or disabled. digest_deliveries is empty in the live base — the
            workflow that writes it is new — so its panel shows the
            "nothing recorded" branch rather than a zero, which is the honest
            state and not a bug.

## 2026-09-13 20:55 — The backfill over HTTP, so it can actually be run here
Intent:     `npm run backfill` needs a shell on the box. This is a Render web
            service, so on the deployed instance that means SSH — and the thing
            most likely to be wanted is "run it again now", from a curl or from
            n8n on a schedule.
Files:      server/src/backfill.ts, server/src/index.ts, README.md
Decision:   POST /api/engine/backfill, same DASHBOARD_INBOUND_KEY, same code
            path, CLI unchanged. One run at a time: a backfill is twenty-two
            full table reads against Airtable and two at once would double that
            traffic and race each other's upserts, so a second caller joins the
            run in flight — the same sharing sync.ts already does for a resync.
Verified:   Unauthenticated 401. An unknown kind named in the message. Run 1
            over the replay: 1164 read, 1164 inserted. Run 2: 1164 already
            current, nothing written. One named kind: 149 read, 149 current.
            The CLI run immediately afterwards agrees exactly. Endpoint and
            command are the same function.
Not done:   The production tables are created and empty. I hold neither the
            Airtable token nor DASHBOARD_INBOUND_KEY, so the first real backfill
            has to be triggered by Destiny — one curl, or `npm run backfill`
            over SSH.

## 2026-09-13 21:20 — Step 3, pre-flight: do the mirror tables actually have rows
Intent:     Destiny's instruction was to confirm the mirror tables hold rows
            before cutting their source, and to stop and say so if any kind the
            UI depends on is empty.
Problem:    mcp__Render__query_render_postgres failed again, the same way it did
            during steps 1 and 2:
              FATAL: SSL/TLS required (SQLSTATE 28000)
Fix:        Read it out of the service logs instead. The backfill was run over
            HTTP at 2026-09-13T21:19 and reported, verbatim:
              backfill 1425 read, 1421 new, 0 changed, 4 current, 0 failed
            Per kind: loops 798, codex 161, layer0 7, patterns 149,
            commercial 21, ns 59, rt 213, client_lanes 4, client_questions 13,
            digests 0.
Decision:   Proceed. Every kind a page reads has rows. `digests` is at 0 and is
            the one exception that is not a blocker: it was never fed by the
            Airtable sync — its source is the engine write path, which stays —
            and its panel already renders "Not recorded" rather than a zero.
            Cutting the sync does not cut its source.
Also:       Dual-write is proved, not assumed. Four POST /api/engine/loops
            writes carrying real rec… ids landed at 20:58 and 21:05, and the
            21:19 backfill read Airtable and reported exactly those four as
            "already current" — Airtable's copy already matched what n8n had
            pushed.

## 2026-09-13 22:05 — Step 3: the Airtable sync is gone; the pages read the engine tables
Intent:     Remove the Airtable sync entirely. Every page that read the synced
            store now reads its mirror table directly, keeping Airtable's own
            field names because n8n writes those names.
Files:      deleted server/src/sync.ts, server/src/airtable.ts,
            server/src/backfill.ts
            server/src/store.ts (the read path, the write path and the ledger
            rewritten), server/src/sources.ts, server/src/mirror.ts,
            server/src/engine.ts, server/src/index.ts,
            server/src/migrations.ts (migration 4), package.json, render.yaml,
            src/data/types.ts, src/data/index.ts,
            src/components/ui/Records.tsx, the seven record screens,
            src/screens/Settings.tsx, src/screens/Registry/index.tsx,
            README.md, CLAUDE.md

Decision:   **Reuse the mappers, do not rewrite them.** A mirror row stores
            { airtable_record_id, created_time, fields } — exactly the AtRecord
            shape sources.ts already consumes. So store.rows() rebuilds an
            AtRecord from each mirror row and hands it to the same mapLoop,
            mapCodex, mapPattern and the rest, untouched. That is what makes
            "keep the field names as they are" true by construction rather than
            by discipline: `What`, `Jason Status`, `Layer1 Review ` with its
            trailing space are read by exactly the code that read them before.
            AtRecord and recordUrl moved out of the deleted airtable.ts into
            sources.ts; nothing else about the mappers changed.

Decision:   **No projection step.** The alternative was to keep `records` and
            refill it from the mirror tables on a timer, which would have been
            a smaller diff. Rejected: it is the same two-copies-that-can-drift
            shape the sync had, and "reads its mirror table directly" is the
            instruction. `records` is left in place and unread — nothing drops
            a table — because `events` references the same record ids.

Decision:   **`events` is the whole status ledger now.** A record's previous
            status used to be a column on the read-model row; it is now the
            last event recorded for that record. An engine write records its
            own event as it lands (store.recordEngineWrite, called from the
            /api/engine handler, and deliberately never able to fail the write).
            store.reconcile() at boot writes down anything that changed while
            the process was not running, stamped via = 'mirror', and those are
            excluded from close-rate figures because a change noticed after the
            fact cannot be dated — the same rule the old via = 'airtable'
            events followed. The first event for a record is stamped with the
            row's first_seen_at, not with the time of the reconcile, so a
            restart cannot re-date the history.
            closed_at is derived from the ledger and keeps the old rule exactly:
            only a transition dates a close, so a loop that was already closed
            when it arrived still has no close date. The loop tables carry none.

Problem:    A note typed on a loop lived only inside records.json — mapLoop
            returns `note: null` and every upsert carried the held note
            forward. It would have vanished with the read model.
Fix:        Migration 4 creates record_notes (kind, record_id, note,
            updated_at) and carries across every note the read model held:
              INSERT INTO record_notes … SELECT kind, id, json::jsonb->>'note'
              FROM records WHERE json::jsonb->>'note' IS NOT NULL AND <> ''
            Verified on a database rewound to before migration 4 with two
            records rows, one with a note and one with a null note: the note
            came across, the null was skipped.

Problem:    A loop opened on this dashboard now exists here before Airtable has
            it, so it has no rec… id and is addressed as `row-<pk>`. When the
            engine later writes the same loop back with its rec id,
            mirror.upsert adopts the row on its loop_id — and everything keyed
            on the old id (its events, its note) would have been orphaned
            silently. Nothing would have errored, which is precisely why.
Fix:        store.adopt() moves the events and the note onto the Airtable id as
            part of that write, and logs what it moved. Verified end to end: a
            loop created in the interface as row-4 with a note, then pushed
            back as recADOPTEDAAAAAA1, came out with both its events and its
            note under the new id and one line in the log saying so.

Decision:   **Writes from the interface are Postgres-only now**, which is the
            real consequence of removing the Airtable client and is worth
            stating plainly. setStatus, updateFields and createLoop merge into
            the row's existing `fields` — never replace it, or the fields the
            interface does not know about would be dropped — and write through
            mirror.upsert with source = 'ui'. If n8n later pushes the same
            record carrying Airtable's copy of those fields, that push wins. It
            is the newer statement about the record, and there is no longer any
            path by which a change made here reaches Airtable.

Decision:   **backfill.ts deleted too.** It was not on the list, but it reads
            Airtable through the client and cannot run without
            AIRTABLE_API_KEY, so keeping it would have meant keeping both. Its
            npm script is gone and POST /api/engine/backfill answers 410 naming
            what happened. It is in git history if it is ever wanted.

Decision:   **/api/inbound/:kind kept, repointed.** It writes the same mirror
            rows /api/engine/:kind writes, so whatever in n8n still calls it
            keeps working. Two changes: `record` is now required — there is no
            Airtable to fetch a named record from, and the 422 says exactly
            that — and POST /api/inbound/resync/:kind answers 410.

Decision:   **SyncLine became RowsLine**, because every word of it was about to
            become a lie. It said "Read from Airtable 4 min ago", offered
            "Resync now", warned when a resync had failed and when rows were
            older than two resync cycles. None of those exist. It now says how
            many rows are held, across how many tables, when one of them last
            changed, and — the figure that replaced staleness — how many have
            been written since the migration backfill. Zero there is shown in
            amber: those rows are not stale, they are stopped.
            SyncInfo became Freshness; ResyncResponse and the resync client
            function are gone; the Registry's Engine writes tab gained a
            "last from a page" column and lost the dual-write framing.

Problem:    `writable` on five screens was `sync.write_through`, i.e. "is
            AIRTABLE_API_KEY set". Every row action was gated on it.
Fix:        Removed. The server does not start without its database, so a write
            path that is reachable at all is a write path that works. Leaving a
            permanently-true flag behind would have been dead branching on
            every row.

Verified:   Against a real Postgres 16 in this sandbox, not a mock.
            - Boot on an empty database: 4 migrations, registry seeded,
              "ledger: up to date (0 rows)".
            - Sixteen records posted through POST /api/engine/:kind across all
              ten kinds, using Airtable's own field names.
            - Every page endpoint: open-loops, codex, ns-telemetry,
              rt-telemetry, clients, build-patterns, commercial — all render
              from the mirror tables, all carry a freshness block.
            - Every metrics endpoint computes: thin rate over classified rows
              only, the RT attempt-log collapse (2 rows, 1 card, both stated),
              pattern reconciliation summing to the row count.
            - Close a loop with a note → closed_at 2026-09-13, note held.
              Edit a field → the other fields survive. Create a loop → row-4,
              source reads "not in Airtable" rather than linking to a record
              page that would 404.
            - Restart → "ledger: up to date (15 rows)", nothing rewritten.
              reconcile is idempotent.
            - POST and GET /api/resync → 404. /api/inbound/resync/loops → 410.
              /api/engine/backfill → 410, each naming what replaced it.
            - Chromium at 1440px over all ten routes and at 400px over two:
              zero horizontal overflow anywhere, no console error but the
              weather fetch this sandbox cannot reach, and no page still
              containing the words "Resync", "Read from Airtable" or
              "Nothing has been read from Airtable yet".

Not done:   Only `loops` has ever received an engine write in production. The
            other eight kinds hold exactly what the 21:19 backfill left and
            will not change until n8n is pointed at them — the Engine writes
            tab names each one, and each page says so in amber. That is the
            outstanding work this cut creates, and it is n8n-side, not here.
            AIRTABLE_API_KEY and AIRTABLE_RESYNC_MINUTES are dropped from
            render.yaml but Render leaves a removed key on the service; they
            want deleting by hand.

## 2026-09-14 06:30 — Loop write-back: the dashboard's closes reach Airtable again, through n8n
Intent:     Close the gap step 3 left. Removing airtable.ts on 13 Sep was
            right — this server should not hold an Airtable token — but
            `Bays — Daily Open Loops Sweep` reads Airtable, so a loop closed
            here updated Postgres, left Airtable saying Open, and came back in
            the next 08:00 digest as though nothing had happened. The write
            goes through n8n, which already holds the token.
Files:      server/src/writeback.ts    the helper (new)
            server/src/migrations.ts   migration 5: loop_writebacks
            server/src/store.ts        pushStatus + the read path + adopt()
            server/src/index.ts        the actor, /api/status, the boot line
            server/src/engine.ts       the page note, which had gone stale
            src/data/types.ts          LoopWriteback, on Loop and ServerStatus
            src/screens/OpenLoops/Loops.tsx, index.tsx   how it shows
            src/screens/Settings.tsx, render.yaml, .env.example, README.md,
            CLAUDE.md

Decision:   **The contract was read from the live workflow, not the brief.**
            BHA — Dashboard Loop Write-Back (GES8UIM3dJRbrLSx), created 06:06
            today, active. Header auth on x-api-key; source_table preferred
            over builder_id; status must be exactly Open / In Progress /
            Closed; 200 carries previous_status and changed, 400 carries a
            reason naming every problem at once, 404 is loop_not_found. Its
            builder-id → table roster is seven literals, and all seven match
            LOOP_TABLES here exactly — checked id by id, because that roster
            being hardcoded in two places is the thing most likely to drift.

Decision:   **source_table is what we send, and builder_id alongside it.**
            engine_loops records both: `table_id` (the tbl… the row was
            mirrored from) and `builder_id` (our slug — 'destiny', not a Slack
            id). table_id is populated on every row, because mirror.prepare
            refuses a loop write without resolving one. builder_id is
            converted to the Slack id the workflow's roster keys on by
            inverting SLACK_TO_BUILDER. Where table_id is somehow null the
            builder's own table is used instead — verified.

            Worth naming: this is derived from **the table the row sits in**,
            never from `Assignee Slack User ID`. LOOP-1001 in the test set
            carries assignee U0A9V97949F (Jason) while sitting in Destiny's
            table, and the payload correctly went out as U0AEW3TBYH1. Reading
            the assignee instead is the mis-delivery this engine already had
            on 7 Sep.

Problem:    The brief's rule for skipping — "if loop_id is missing or does not
            start with LOOP-" — does not catch the case it is meant to catch.
            createLoop generates `LOOP-<ts>-<rand>`, so a loop opened in the
            dashboard *does* have a LOOP- id; it just has no Airtable row. That
            rule would have sent it and collected a 404 for every new loop,
            which is exactly the "do not send it and collect a 400" the brief
            rules out.
Fix:        Skip on both: the LOOP- check as asked, and `airtable_record_id IS
            NULL`, which is the actual signal for "Airtable has no row". The
            skip is recorded with its reason and shown as a skip, not a
            failure. It self-resolves: when the engine writes the loop to
            Airtable and pushes it back, mirror.upsert adopts the row and the
            next change is sent for real. Verified end to end.

Problem:    Adoption would have orphaned the write-back record. It is keyed by
            the id the row is addressed by, and that id changes from row-<pk>
            to the rec… id — and the loop it is about is precisely the one
            adoption concerns. Nothing would have errored.
Fix:        adopt() carries it across with the events and the note. Verified:
            "store: row-4 is now recADOPTED0000001 — carried 2 event(s), 1
            note(s) and 1 write-back record(s) across".

Decision:   **Postgres first, then the push, and the push is awaited.** It
            never throws, never rolls back, never blocks the Postgres write —
            a working close must not be undone because a webhook was slow.
            Awaited rather than fired and forgotten because the answer belongs
            on the row the user just clicked: the returned Loop already carries
            the failure, so the optimistic update shows it immediately. Worst
            case is 10s on the PATCH (5s timeout, one retry).

Decision:   **N8N_WRITEBACK_KEY is not fatal at startup.** "Fail loudly at
            startup or on first use" — first use, plus a boot line. Exiting
            would take the whole dashboard down for a missing loop write-back,
            and CLAUDE.md reserves refusing to start for DATABASE_URL. So: a
            boot line naming the variable and what it costs, a failed
            write-back naming it on every attempt, a console.error per
            attempt, and a row on Settings. No fallback value, ever — a guessed
            key comes back as an unauthorised request, which reads on the page
            like the workflow rejecting the loop rather than like this server
            being misconfigured.

Problem:    A loop whose row had no table_id *and* an unknown builder_id got
            "The server hit an error handling that request." mirror.upsert's
            MirrorError was not caught in the Postgres write path. Pre-existing
            since 13 Sep, and unreachable through any write path, but it is on
            the line I was changing.
Fix:        writeFields translates MirrorError to StoreError, so the refusal
            names the field: `"builder_id": "nobody" is not a builder this
            engine knows. One of: ahad, destiny, …`.

Verified:   Against a real Postgres 16 and a stand-in for the workflow that
            mirrors its validation and responses (read from the workflow
            itself) and can be told to misbehave. Fifteen cases:
            - Open→Closed on a loop Airtable has: ok, changed true.
            - Closed again: ok, changed **false** — shown as success, not error.
            - Reopen, and In Progress: both ok.
            - A loop Airtable has lost: failed, HTTP 404, loop_not_found.
            - Workflow 500: two attempts, then failed.
            - Connection reset: two attempts, then failed.
            - n8n's own 403 with a non-JSON body: one attempt, no retry.
            - Never answers: 5s timeout, two attempts, 10s total, failed.
            - No N8N_WRITEBACK_KEY: nothing sent, failed, reason names the
              variable, and the change still saved in Postgres.
            - A loop opened in the dashboard, then closed: nothing sent either
              time, recorded as skipped with why.
            - table_id null, builder known: falls back to the builder's table.
            - Adoption carries the write-back record across.
            - Every failure left the Postgres row and the events ledger intact.
            In Chromium at 1440 and 400px, zero overflow, no console errors:
            the banner above the table naming the count and the reasons, the
            red "not in Airtable" marker under the status pill, the closed
            column in red, and the Settings rows.

Not done:   No retry affordance on the row — a failed write-back clears when
            the status is changed again, and nothing re-sends it on its own. If
            a run of these ever happens at once (a key rotation, an n8n
            outage), that is the thing to add next.
            N8N_WRITEBACK_KEY is in render.yaml as sync:false and has to be set
            by hand: it is the value on the workflow's own header-auth
            credential and cannot be generated.

## 2026-09-14 10:55 — The loop panel, and edits written straight to Airtable
Intent:     Two things on Open loops. Visual cleanup of the cards and the
            table, and a detail panel that edits a loop — What, Status, Lane
            and Builder — writing straight to Airtable rather than through the
            n8n write-back built this morning.
Files:      server/src/airtable.ts   restored, on AIRTABLE_TOKEN (new)
            server/src/loops.ts      field names, validation, the move (new)
            server/src/writeback.ts  deleted
            server/src/store.ts      editLoop; the log; adopt → rekey
            server/src/migrations.ts migration 6: loop_writebacks becomes a log
            server/src/index.ts      PATCH /api/loops/:id; boot line; status
            server/src/engine.ts     the page note, stale within a day
            src/data/types.ts, src/data/index.ts
            src/components/ui/Records.tsx        RowsLine writes={false}
            src/screens/OpenLoops/Metrics.tsx    the card changes
            src/screens/OpenLoops/Loops.tsx      click to open, Builder, clip
            src/screens/OpenLoops/LoopPanel.tsx  the panel (new)
            src/screens/OpenLoops/index.tsx      one save path
            src/screens/Settings.tsx, render.yaml, .env.example, README.md,
            CLAUDE.md

Problem:    The brief named the lane field `Lane`. There is no field called
            `Lane` in any of the seven tables. Read live from
            appUVlBSGGPHw6DGh on 2026-09-14, all seven identical:
              What · Raised By · Date Raised · Source Link · Status ·
              Assignee Slack User ID · loop_id · lane_tag · raised_in ·
              last_modified
Fix:        Wrote `lane_tag`. With typecast on, `Lane` would have been created
            as a second field that nothing reads, while the real lane silently
            never changed — the exact silent-divergence failure the
            never-rename rule exists for.

Problem:    `raised_in` is a real field carrying data (the Slack channel a loop
            was raised in, distinct from Source Link) and the brief's move list
            left it out. Not carrying it would have dropped it on every move.
Fix:        Carried. CARRIED in loops.ts is loop_id, What, Status, lane_tag,
            Raised By, Date Raised, Source Link, raised_in.

Decision:   **The env var is AIRTABLE_TOKEN, and it does not match.** The
            client deleted on 13 Sep read `AIRTABLE_API_KEY` (confirmed at
            7d6e58c^:server/src/airtable.ts:18). The variable set on the
            service is `AIRTABLE_TOKEN`, so that is what this reads, and
            `AIRTABLE_API_KEY` is now unused anywhere. Raised with Destiny.

Decision:   **setStatus for loops delegates to editLoop.** The row actions and
            the panel are the same call, so there is exactly one path that
            writes a loop's status — which was the reason for retiring the
            write-back in the first place.

Problem:    The first cut wrote the destination builder and table to Postgres
            before Airtable had moved anything, per "Postgres first". When the
            create failed, this database said Ahad while the row was still in
            Kaiqi's table — and nothing was left that knew where it really was.
            The retry then looked in Ahad's table, found nothing, and the loop
            was stuck.
Fix:        The field edits still go to Postgres first and still stand whatever
            Airtable does. The *move* lands in Postgres only after Airtable
            confirms the create. Which table a row sits in is a fact about
            Airtable, not a field this dashboard owns. Nothing is rolled back
            by this; the move simply is not claimed until it is true. Verified:
            a failed create leaves the edit applied, the builder unchanged and
            truthful, and the retry then works.

Decision:   **`duplicate` is its own outcome, not a kind of failure.** The save
            landed; the loop is in two tables and one copy needs deleting.
            Calling it failed would say the change did not happen, which is the
            opposite of the truth, and the recovery is different and specific.
            The move is never retried after a failed delete.

Decision:   **loop_writebacks becomes append-only** (migration 6) rather than
            one row per loop. A move that half-lands has to show where it
            stopped, and one row per loop overwrites exactly that. The primary
            key moves from record_id to a sequence; every existing row is kept;
            the newest line per loop drives the page marker.

Decision:   **"N written since the backfill" is dropped from Open loops only**,
            not from the other six pages. It stops meaning "the engine is still
            feeding this" the moment anyone edits a loop here — one edit turns
            the amber warning off whether or not n8n has gone quiet. On the six
            read-only kinds it still says exactly what it says, so RowsLine
            took a `writes` prop rather than losing the signal everywhere.

Problem:    With the second line removed from the What column, the text ran
            straight through the status, Builder and lane columns. `td-clip` is
            overflow/ellipsis/nowrap and needs a block box; a `<span>` stays
            inline and clips nothing.
Fix:        The column's own `clip: true`, which wraps the cell in the div
            td-clip expects. Verified in Chromium: scrollWidth > clientWidth.

Verified:   Against Postgres 16 and a replay of the Airtable REST API shaped
            from the live schema — ten fields, the real select vocabularies,
            last_modified rejected as computed, unknown field names rejected —
            which can be told to fail a specific verb.
            - edit in place: PATCH carrying What, Status and lane_tag. Nothing
              else sent; last_modified never written.
            - move: GET source → POST destination → DELETE source, in that
              order. loop_id unchanged, raised_in carried, assignee set to the
              destination builder's own id and not the source's.
            - edit + move in one save: the edits arrive in the create.
            - DELETE fails: state `duplicate`, both tables named, steps showing
              the create landed and the delete did not, new record id stored so
              the next edit finds the live row.
            - CREATE fails: nothing deleted, the loop still in the source
              table, Postgres still naming the source builder, and the retry
              succeeds once Airtable answers.
            - rejected before any write: an unknown builder, a lane the tables
              do not define, an empty What — zero Airtable calls for all three.
            - a record deleted in Airtable: failed, HTTP 404, marked.
            - no AIRTABLE_TOKEN: zero calls, failed, reason names the variable,
              boot line says it.
            - a loop opened in the dashboard: skipped, zero calls.
            - the three row actions: same endpoint, Airtable followed each.
            In Chromium at 1440 and 400px, zero overflow, no console errors:
            the two cards removed, close rate left and the age card right and
            renamed, the four time-series cards all 294px, the What column
            ellipsised, the Builder header, and a full edit-and-move driven
            through the panel end to end.

            **Row actions were reachable, not dead code.** `.row-actions` is
            opacity 0 and `tr:hover .row-actions` is opacity 1 — measured 0 →
            1 on hover. They were only ever discoverable by hovering, which is
            why the panel now carries Close loop as a labelled button.

Not done:   No way to delete the stale copy after a duplicate; it is named and
            has to be removed in Airtable by hand. No bulk edit. The other six
            record kinds still have no write path to their sources — loops are
            the only kind this server writes to Airtable, because the 08:00
            digest is the only reader that needs it.

## 2026-09-14 11:30 — Codex entries: three stages, a detail panel, direct writes and delete
Intent:     Layout cleanup, a stage model that reconciles, an expandable entry
            with Approve / Send back / Delete, writes straight to Airtable, and
            a reconciliation against rows deleted there by hand.
Files:      server/src/codex.ts       field names, status, delete, live ids (new)
            server/src/airtable.ts    every call now names its base
            server/src/loops.ts       call sites follow
            server/src/store.ts       stages, setJasonStatus, deleteCodex,
                                      reconcileCodex; the write log generalised
            server/src/migrations.ts  migration 7
            server/src/index.ts       PATCH and DELETE /api/codex/:id
            server/src/engine.ts      reconcile before the list is built
            server/src/sources.ts     `stage` on the mapped record
            src/data/types.ts, src/data/index.ts
            src/components/ui/Records.tsx  unlanded/writeWarning/NotLanded shared
            src/components/ui/Card.tsx     MetricCard align
            src/screens/Codex.tsx, src/screens/OpenLoops/{Loops,Metrics}.tsx
            render.yaml, .env.example, README.md, CLAUDE.md

Decision:   **Every field name read from the live base first, per the brief.**
            appEmdKshNVTl64Zf on 2026-09-14; all six builder tables carry the
            same 23 fields. `Layer1 Review ` does end in a space, in all six —
            the existing mapper already read both spellings and still does.
Problem:    Two schema facts the prompt did not have. The Layer 0 parking table
            spells it `Session URL`, where the builder tables spell it
            `Session Url` — different tables, different schemas, and the
            parking table has no Jason Status, no Layer 2 review and no Codex
            Entry ID at all. And `Narration Quality` is a singleSelect in five
            tables but **multilineText in Kavin G N's**, so that column is free
            text there and nothing constrains it to the three tiers.
Fix:        The Layer 0 table is read through its own shape and never through
            the builder-table field names. The narration tiers are ordered by
            the pipeline's definition rather than by what any one table's select
            happens to offer, and a value outside the three is appended rather
            than dropped.

Decision:   **The tier order is hardcoded, not sorted.** Excellent, Great, Good.
            Sorting gave Excellent, Good, Great — alphabetical, which reads as
            Good outranking Great. Airtable's own option order is the same
            alphabetical one, so it could not be the source either. Destiny's
            table does not even define a "Good" option; Ahad's, Kaiqi's,
            Hardik's and Jegan's do.

Decision:   **One rule makes the three stages exclusive**, applied in mapCodex
            rather than in each consumer: Layer0 Flagged wins, otherwise Jason
            Status decides. So `stage` is on the row, the tabs and the list read
            the same field, and they cannot answer differently. The page prints
            the reconciliation sentence — "7 + 16 + 141 = 164" — so the figures
            are visibly closed rather than asserted.
            "Input Added" is not a stage: it is Jason asking while the log waits,
            so those logs sit at Awaiting approval with a small tag. "Complete"
            is gone; it was Layer 2 having written something, not a decision,
            and it overlapped Approved.

Decision:   **`loop_writebacks` becomes `record_writes` with a `kind`**
            (migration 7) rather than a second table for Codex. A second table
            would have meant a second marker component drifting from the first,
            and the brief asked for the Open Loops pattern reused. A rename, not
            a drop; every row is kept as `kind = 'loops'`. Its `loop_id` column
            is renamed `natural_id` in the same migration — it now holds a Codex
            entry id as often as a loop id, and a column named for one of two
            things it carries is how the next reader gets it wrong.

Decision:   **AIRTABLE_SUBMISSIONS_BASE_ID**, a separate variable, as asked.
            AIRTABLE_BASE_ID stays the Open Loops base. The Airtable client now
            takes a base per call rather than holding one.

Decision:   **Delete is confirmed by typing the Codex entry id**, and the whole
            row is written to `record_deletions` before either side lets go.
            Once Airtable and Postgres have both removed it, that log is the
            only place it can be read — so it holds the record, not a summary.
            A row with no Codex entry id yet (one still at Layer 0) is confirmed
            by its Submission ID instead, so the guard is never unsatisfiable.
            The Postgres row goes whether or not Airtable let go: the
            alternative is a row nobody can delete from either side, and the log
            carries what happened.

Decision:   **The reconciliation removes only what is genuinely absent.** A
            table whose read fails is left out of the comparison entirely and
            nothing under it is touched — a failed fetch and an emptied table
            are indistinguishable from here, and reading one as the other would
            clear the page. Single-flight, so two page loads share one pass.

Problem:    The three cards were the same height but their bars did not start on
            the same line: MetricCard centres its body, so a three-bar card sat
            lower than the four-bar one beside it and they stopped reading as a
            set.
Fix:        MetricCard takes `align`; centred stays the default for a single
            headline figure, and the bar-stack rows on Codex and Open loops pass
            `align="top"`.

Verified:   Against Postgres 16 and a replay of the Airtable REST API shaped
            from the live schema — the real 23 field names including the
            trailing space, the real select vocabularies, unknown field names
            and bad options rejected the way Airtable rejects them.
            - stage model over ten seeded logs: 2 needs input + 4 awaiting +
              4 approved = 10, and a log that is Approved *and* flagged lands in
              Needs input, which is the rule.
            - approve, send back to pending: PATCH carrying only Jason Status.
            - "Input Added" from the interface refused, naming the two it does
              set and why.
            - Airtable refuses the write: saved here, marked, reason and http on
              the row, `kind = 'codex'` in the log.
            - no AIRTABLE_TOKEN: nothing sent, marked, boot line says it.
            - delete with a wrong id and with no id: both refused, naming the id
              to type. With the right id: gone from both sides, and the deletion
              log holds the full record including `Layer1 Review ` and the
              generated codex.
            - reconciliation: a clean pass removes nothing; two rows deleted in
              Airtable are removed and logged with the reason; one table failing
              its read leaves its rows alone and names the table; Airtable
              entirely down removes nothing and the page still renders all six.
            - migration 7 applied both on a fresh database (1–7 in order) and on
              one already at 6, with the rename preserving every row.
            In Chromium at 1440 and 400px, zero overflow, no console errors: the
            four-cell header strip, the three cards uniform at 346px with their
            bars aligned, Excellent/Great/Good on screen in that order, the
            stage tabs summing to All, the panel with both collapsible sections,
            and a delete driven through the id-confirmation field end to end.

Live counts (Airtable, 2026-09-14):
            Destiny 38 = 0 / 1 / 37      Jegan  25 = 0 / 1 / 24
            Kaiqi   36 = 0 / 1 / 35      Hardik 26 = 2 / 5 / 19
            Ahad    15 = 4 / 7 / 4       Kavin  24 = 1 / 1 / 22
            needs input 7 + awaiting 16 + approved 141 = 164 submissions.
            Layer 0 parking table: 7 rows, 1 still pending_builder_input
            (Kavin G N, missing commercial). Not in the 164.

Not done:   Narration Quality in Kavin G N's table is free text rather than a
            select, so nothing stops a fourth value appearing there. The page
            shows whatever is written rather than dropping it, but the field
            wants converting to a select to match the other five.

## 2026-09-14 13:45 — Four cards that read as one row, the duplicate repair, and a base named for its base
Intent:     Three things on Open loops: even out the four time-series footnotes
            and line the cards up, add a way to remove the copy a half-landed
            move leaves behind, and rename AIRTABLE_BASE_ID to
            AIRTABLE_OPEN_LOOPS_BASE_ID with no default.
Files:      server/src/airtable.ts    OPEN_LOOPS_BASE_VAR, loopsBase(), no default
            server/src/loops.ts       retryDelete; the base guard; from_record_id
            server/src/store.ts       resolveDuplicate; the four footnotes;
                                      from_record_id through the write log
            server/src/migrations.ts  migration 8
            server/src/index.ts       POST /api/loops/:id/duplicate; boot line
            src/data/types.ts         from_builder on RecordWrite; airtable_base
                                      is nullable
            src/data/index.ts         removeLoopDuplicate
            src/components/ui/Card.tsx     MetricCard noteMinLines
            src/components/ui/Records.tsx  SeriesBlock layout + footnote
            src/screens/OpenLoops/{Metrics,Loops,LoopPanel,index}.tsx
            src/screens/Settings.tsx, render.yaml, .env.example, README.md,
            CLAUDE.md

Decision:   **The footnotes are the same length because they say less, not
            because one was padded.** Raised per week was one line and 67
            characters; Closed per week was 430 with MODIFIED_NOTE appended
            whole. They are now 94, 102, 104 and 111 — three lines each at the
            four-up width, two at every width below it. Nothing true was cut:
            the 9 Sept 2026 caveat is on both measures that read last_modified,
            Net still says it is Date Raised minus last_modified, and Closed per
            day still says closes are only dated when they pass through here or
            are pushed by the engine.

Problem:    Same length is not the same height. At 272px the notes wrapped to 4,
            4, 5 and 4 lines, and since the footnote sits on the floor of a card
            whose height the grid has already equalised, the five-line one
            pushed its chart 16px higher than the other three. The cards were
            the same size and still did not line up.
Fix:        Three things together. The note is the *card's* footnote rather than
            the chart's (SeriesBlock takes `footnote={false}`), `noteMinLines`
            holds a two-line floor under it, and `layout="spread"` puts the
            total at the top of the body and the chart on the bottom. Measured
            in Chromium: at 1440, 1024 and 400 the four cards agree on height,
            on the total's y, on the chart's baseline and on the footnote's top
            — to the hundredth of a pixel at 400.

Decision:   **The duplicate repair deletes the source row and nothing else.**
            Not a re-run of the move: the loop already lives in the destination
            row and Postgres already says so, so re-running it would turn two
            copies into three. Not a Postgres change either — there is none to
            make. Airtable only, one DELETE, against the record id the move
            wrote down.
Problem:    That id was not written down. The log had from_table and to_table,
            but after a move the loop's own record id is the *new* one, so the
            copy could be named and not removed.
Fix:        Migration 8 adds `from_record_id` to record_writes; the duplicate
            line carries it and the retry reads it back. A duplicate logged
            before this migration says so and asks for Airtable by hand rather
            than deleting a guess.
Decision:   **A retry that fails stays `duplicate`, not `failed`.** The loop is
            still in two tables, which is what duplicate means; calling it
            failed would drop the marker's meaning and take the action away.
            The reason is replaced with what happened this time and the action
            stays. A source record already gone (HTTP 404) is success — someone
            deleting it by hand reaches the same state the retry was aiming at.

Decision:   **AIRTABLE_OPEN_LOOPS_BASE_ID, with no default.** A base variable is
            named for its base, so the next one cannot be mistaken for it. The
            default went with the rename: a default is a guess about which base
            real loops are written to, and a wrong guess writes them there
            rather than failing. Missing is missing — the boot line names it,
            `/api/status` returns null, Settings says which variable, and every
            loop edit and every retry is refused with the same sentence.
            Not fatal at boot: CLAUDE.md reserves refusing to start for
            DATABASE_URL, and taking the whole dashboard down over a base id
            would be worse than the loud refusal. Set on the service before the
            deploy, so the rename never left a window where loop edits stopped
            reaching Airtable; AIRTABLE_BASE_ID is now read by nothing and can
            be deleted in Render by hand.

Verified:   Against Postgres 16 and the Airtable replay, with fifteen seeded
            loops across the seven tables.
            - migrations 1–8 on a fresh database, in order.
            - move with DELETE failing: duplicate, from_record_id on the line,
              both rows present in the replay.
            - retry while DELETE still fails: still duplicate, new reason, the
              action still offered, and from_record_id kept for the next try.
            - retry with Airtable healthy: ok, source row gone, destination row
              untouched, and the marker cleared on the row and in the banner.
            - retry when the copy was deleted in Airtable by hand: ok, and the
              step says it was already gone.
            - retry on a loop that is not a duplicate: 422, "This loop is not in
              two tables, so there is no copy to remove."
            - no AIRTABLE_TOKEN, and no AIRTABLE_OPEN_LOOPS_BASE_ID: the retry
              stays duplicate and names the variable; an ordinary edit is saved
              here, marked, and names it too; both boot lines say it.
            In Chromium at 1440 and 400: the action in the banner and in the
            panel, a failed retry and a successful one driven through the
            interface end to end, the four cards aligned at 1440, 1024 and 400,
            zero overflow, no console errors.

Not done:   The banner offers the action on the three loops it names; a fourth
            is reached by clicking the loop, where the panel carries the same
            action. No bulk repair, deliberately — each one is a delete against
            a named record, and a button that removes several is a button that
            removes the wrong one.

## 2026-09-14 16:10 — Codex: the amber line says why, one strip, named steps
Intent:     Answer the amber line Destiny was looking at, give the header strip
            and the three cards the Open Loops treatment, name the layers,
            reorder the tabs and drop All, and take "Parked at the gate" off the
            completeness card.
Files:      server/src/store.ts       reconciliation reasons, logging, cache,
                                      TAB_RULES names and order, the shortened
                                      metric strings
            server/src/codex.ts       liveIds budget, per-read timeout, unreached,
                                      tableLabel
            server/src/airtable.ts    per-call timeout on the client
            src/components/ui/Records.tsx  CountCell hintMinLines
            src/screens/Codex.tsx     strip, cards, tabs, panel prose
            render.yaml, .env.example, README.md, CLAUDE.md

Problem:    **The amber line could not be acted on.** "No submission table could
            be read, so nothing was removed and the page is showing what this
            database holds." The reason was already in hand — `liveIds` catches
            each table's error into `failed` with Airtable's own message — and
            `runReconcile` threw it away when every table failed. Nothing was
            logged either: five Codex page loads in production and not one app
            log line, confirmed against the Render logs.
Fix:        The note carries Airtable's message, commonest reason first, bounded
            at two with the rest counted, and a reason that covers every table
            is not followed by a list of all seven. A `console.error` beside it.
            The same reasons are added to the partial-failure note, which named
            tables but not reasons.
Decision:   **The sentence also says the list is fine.** "Showing what this
            database holds" reads like a warning about the rows and is not one:
            the page always reads Postgres, every row is real, and the only
            thing a failed pass misses is a submission deleted in Airtable by
            hand still being listed. It says that now.

Problem:    Most likely cause, and the reason it took a page to notice:
            **render.yaml, .env.example and the README env table all said the
            token needs the Open Loops base "and nothing else"** — the three
            files someone follows when creating it — while the code, CLAUDE.md
            and two other README passages said one token covers both bases. A
            token made from the instructions authenticates fine and then refuses
            every read of appEmdKshNVTl64Zf.
Fix:        All three corrected to say read and write on both bases. Verified
            read-only today that the base and all seven table ids are right, so
            a wrong id is not the cause.

Decision:   **The pass is bounded.** Seven sequential reads at the client's
            15s write timeout is ninety seconds of housekeeping with a person
            waiting; one production load took twenty-two seconds. A
            reconciliation read now gets 5s, the pass 8s, and tables the budget
            did not reach are reported as *not reached* rather than failed —
            they are not evidence of anything and nothing under them is touched.
            The result is held two minutes, twenty seconds if it failed (that is
            the state somebody is trying to clear), and a delete made here drops
            it so this dashboard's own delete is never answered from an older
            pass.

Decision:   **The steps are named: completeness check, pending review, builder
            codex** (Destiny). The Airtable fields keep their names and the page
            still quotes `Layer0 Flagged` and `Orchestrator Layer2 Review` where
            it states a rule — a rule you cannot check against the source is
            decoration. The header cell reads "Completeness flagged"; "Codex
            generated" keeps the name Destiny chose this morning, since it
            counts codexes written rather than naming the step.

Decision:   **Approved first, no All tab** (Destiny), default Approved. The
            stage card reads the same order, so the page states one order
            rather than two. Dropped with it: the `'all'` member of the tab
            type, its branch in `inTab`, and its rule line. One consequence
            worth knowing — the search box filters inside the selected stage,
            so searching now means being on the right stage first.

Decision:   **"Parked at the gate" comes off the completeness card** (Destiny):
            everything in that table is parked by definition, so the bar
            restated its own table's name. The count still shows in that card's
            footnote and under the Needs input tab. The completed parked rows
            stopped being mentioned at all — a row whose answers were merged is
            the engine's to delete, and until n8n does it the dashboard simply
            does not count it.

Problem:    Same length is not the same height, again. The four hints were 25,
            150, 50 and 32 characters and the three card footnotes 107, 205 and
            104; at 1024 the completeness note wrapped one line further than its
            neighbours even once the lengths matched, because `Layer0 Flagged`
            and `Layer0 Missing` are long unbreakable tokens that move the wrap.
Fix:        `CountCell` gained `hintMinLines`, the counterpart of MetricCard's
            `noteMinLines`, and every footnote was cut until the wrap agreed.
            Measured: at 1440, 1024 and 400 the four cells share a height and a
            hint height, and the three cards share height, footnote top and
            footnote height exactly. The one difference left is a 1px hairline
            between the strip's two rows at phone width, which is the separator.

Verified:   Against Postgres 16 and the submissions replay, twenty seeded
            submissions across six tables and seven Layer 0 rows (six answered,
            one still waiting — the live shape).
            - stages 12 + 4 + 4 = 20, tabs Approved · Awaiting approval · Needs
              input, opening on Approved, each printing its own rule.
            - every table refuses (403): ran=false, nothing removed, all seven
              reasons carried to the page and one line in the log.
            - every table refuses for the same reason: said once, not seven
              times.
            - one table refuses: 17 of 20 checked, Hardik named, its rows left
              alone, the reason printed.
            - no AIRTABLE_TOKEN: same shape, the variable named.
            - a slow Airtable (3s a read): the page answered in 9.1s rather than
              21s, named the four tables it did not reach, and removed only
              within the three it read — ten rows, each logged whole to
              record_deletions.
            - delete: wrong id refused naming the id, right id removes both
              sides, and the next load reconciles fresh rather than from cache.
            In Chromium at 1440, 1024 and 400: zero overflow, no console errors,
            the strip and the cards aligned at every width, the parked bar gone,
            and no "Layer 0/1/2" left on screen except the field names in their
            captions.

Also:       The README carried the entire Codex section twice, the second copy
            glued onto the "### The migration backfill" heading — a botched
            insertion from this morning. The duplicate is removed; the two
            copies were byte-identical, so nothing was lost.

Not done:   Nothing deletes a Layer 0 row once the builder's answers are merged;
            that is n8n's, and the dashboard now just stops counting the
            answered ones. The submissions base still has a built-in default
            where the loops base has none.

## 2026-09-14 17:20 — The malformed read, a two-way resync, and Input Added where it belongs
Intent:     Six things on the Codex page, the first of them a bug I shipped
            yesterday and then misdiagnosed.
Files:      server/src/airtable.ts   the field name; listRecords
            server/src/codex.ts      liveRecords, allTables, its own budget
            server/src/store.ts      resyncCodex; removeCodexRows shared;
                                     recordEngineWrite takes a via; TAB_RULES
                                     loses its rule strings
            server/src/sources.ts    Input Added counts as approved
            server/src/engine.ts     the reconciliation result stops being returned
            server/src/index.ts      POST /api/codex/resync
            src/data/{index,types}.ts, src/screens/Codex.tsx
            CLAUDE.md, README.md, /tmp/claude-0/fakecodex.js

Problem:    **`Unknown field name: ""`, on every table, and it was mine.**
            `listRecordIds` sent `fields[]=` with no field named, and the
            comment above it asserted that this "asks Airtable for the ids
            alone". It does not. Airtable reads it as a request for a field
            whose name is the empty string and refuses the whole request. All
            seven tables answered identically, which is exactly what a
            base-wide permissions failure looks like — so yesterday I read it
            as the token's scope and shipped a docs correction instead of a fix.
            Destiny read the message properly: the token authenticated and
            reached the base; the request was malformed.
Fix:        Ask for one small real field. `Submission ID` is the one spelling
            present in all six builder tables *and* the Layer 0 table, checked
            against the live schema rather than assumed — the habit that should
            have caught the original.

Problem:    **The test harness agreed with me.** `/tmp/claude-0/fakecodex.js`
            treated an empty `fields[]` as "ids only" and returned empty field
            objects, because I wrote it from the same belief as the code. Nine
            reconciliation cases went green yesterday against a stand-in that
            shared the bug.
Fix:        The replay refuses an empty field name, and an unknown one, exactly
            as Airtable does, and returns only the fields actually asked for.
            Verified by replaying the old query shape against it: it now answers
            the production error verbatim. A harness that agrees with the code
            it is testing is worse than no harness.

Decision:   **The reconciliation says nothing on the page any more** (Destiny).
            A standing amber line about a background check, on a page whose rows
            were never in doubt, is a banner nobody can act on. The pass still
            runs on load, still removes rows deleted in Airtable, and still logs
            the reason work from yesterday — which is the part that was actually
            missing. `reconciliation` is off the payload and the type too, so it
            cannot creep back as a banner.

Decision:   **Resync from Airtable, on a button, with Airtable winning.** The
            gap it closes: reconciliation only ever *removed*. Nothing inserted
            a row Airtable had and we did not, and nothing picked up a changed
            field — so the copy here could only fall behind. Measured against
            the live base before the work: Airtable 151 Approved / 14 Input
            Added / 0 Pending / 165 rows against 148 / 14 / 2 / 164 here.
            Rows go in through `mirror.upsert` with `source = 'airtable'` —
            already an accepted value, and `MirrorResult` already reports
            `inserted` and `changed`, so the per-table counts come off the
            return rather than from counting of my own. Deletes go through the
            same `removeCodexRows` the reconciliation now uses, so a row can
            only leave that table one way.
Decision:   **The status change is dated `via = 'mirror'`, not `'engine'`.**
            A resync learns that something changed; it has no idea when it
            changed in Airtable. That is exactly what 'mirror' has always meant
            here, and it is already left out of close-rate figures.
Decision:   **An overwritten local change is never silent.** A row whose newest
            `record_writes` line is failed or duplicate carries a change that
            never reached Airtable, and a resync reverts it. Correct, and named:
            counted in the result and printed in the log with its Codex entry
            id. The unlanded set is read *before* anything is written, because
            afterwards the newest line is the resync itself.
Decision:   **The log carries the whole outcome**, per table and in total,
            including what both sides hold afterwards. Nobody in this sandbox
            can press the button, so "do the two sides agree now" has to be
            answerable from the log alone.

Decision:   **Input Added counts as Approved** (Destiny). Jason adding input
            means he has read the log and responded — a form of having dealt
            with it, not a state of waiting for him. One line in mapCodex. The
            three stages stay exclusive and still sum: `Layer0 Flagged` still
            wins outright, so an Input Added row that is also flagged is still
            Needs input.

Decision:   **The three rule paragraphs come off the screen** (Destiny) and the
            `rule` strings come out of TAB_RULES and the payload with them, so
            there is nothing left to render. They live in CLAUDE.md §4, as spec
            rather than caption.

Problem:    "commercial 4 of 4" and "next step 1 of 4" read as fractions of
            something and are not: they are how many of the flagged submissions
            lacked that one thing, and a submission can lack several.
Fix:        A quiet line above them — "of the 4 flagged, what was missing" — and
            the right-hand figure is a share of the flagged count rather than a
            bare "of N".

Verified:   Against Postgres 16 and the corrected replay, twenty submissions and
            seven Layer 0 rows.
            - the old query shape now fails in the replay exactly as it fails in
              production; the new one returns real records, one field each.
            - stages 13 + 3 + 4 = 20 before the resync, 14 + 2 + 4 = 20 after,
              with the Input Added row in Approved.
            - **one resync against all four kinds of divergence at once**: a row
              only Airtable had, a row changed to Approved there, a row only
              Postgres had, and a row carrying a failed local write. Result:
              1 inserted, 2 updated, 1 deleted, 24 already matching, and the
              overwritten row named by its Codex entry id.
            - a second run immediately after: 0/0/0, 27 already matching.
            - one table refusing with a 403: named with its reason, its three
              rows untouched, nothing deleted under it.
            - the deletion log holds the removed row whole, with the resync's
              own reason and the actor.
            In Chromium at 1440, 1024 and 400: no banner, no rule paragraph, the
            breakdown labelled, the button and the result panel, zero overflow,
            no console errors. The header cells and the three cards still share
            a height and a footnote line at 1440 and 1024. At 400 the cards are
            one per row and size to their own content, which is what stacking
            means — the same-height rule is about cards beside each other.

Not done:   The resync is the only path that pulls; nothing schedules it, by
            instruction — Destiny wants to watch what it does before it does it
            on its own. Nothing in this sandbox can press the button, so the
            first production run and its numbers come from the Render log.

## 2026-09-14 18:15 — Needs input reads the right field; two pages become placeholders; the registry becomes four
Intent:     Eight things from Destiny. The first is the only one that changes
            what the page means: Needs input was driven by `Layer0 Flagged`,
            which means "was flagged once, ever" and is never cleared, so eight
            logs (Ahad 4, Hardik 2, Kavin 2) sat in the queue of work owed after
            every one had been answered, merged and approved. Then: the resync
            result becomes a toast, empty stages get a sentence, the
            completeness sub-heading goes, `Jason Reviewed At` starts
            accumulating, vFarm and Engine health become placeholders, the
            Builders page goes, and the System registry becomes four registries.

Files:      server/src/sources.ts, store.ts, engine.ts, index.ts, registry.ts;
            src/data/{types,index}.ts; src/screens/Codex.tsx, Overview.tsx,
            Registry/index.tsx, VFarm/index.tsx, EngineHealth/index.tsx;
            src/components/Layout.tsx, ui/RecordTable.tsx, ui/Tabs.tsx;
            src/App.tsx, src/index.css, src/lib/format.ts,
            src/data/fixtures/vfarm.ts; CLAUDE.md, README.md.
            Deleted: src/screens/Builders/ (3 files), VFarm/{Live,Lifecycle,
            Readiness}.tsx, EngineHealth/{IncidentTable,MetricsRow,
            StateTrack}.tsx.

Problem:    `mapCodex` maps one record and cannot see another table, and the
            fact that decides Needs input lives in the Layer 0 parking table.
            `Layer0Hold.open` was already there and looked like the answer — it
            is `status !== 'completed'`, which is wider than
            `pending_builder_input` and would have re-introduced the same class
            of bug one field along.

            Second: the Layer 0 table upstream is **empty — 0 records**, checked
            twice against the live base. It held seven this morning, six
            `completed` and one `pending_builder_input`. So the count Destiny
            expected to drop from 8 to 1 lands on 0 instead.

            Third: `/api/engine-status` had no reader left once the sidebar
            badge went — a live fetch on every page answering nobody.

Fix:        The pending set is read in one query beside `layer0Holds()`, once
            per read, and threaded through `mapRecord` as an optional context.
            The comparison names `pending_builder_input` literally rather than
            inferring it from the absence of `completed`. `Layer0 Flagged` is
            still read, still on the entry and still what the completeness card
            counts — it just no longer places a log. The paths that only want a
            record's status for the events ledger pass no context and place
            nothing, which is right: `statusOf` reads `approval`, never `stage`.

            The engine-status route, its server function, its client fetcher and
            its type are all gone, with the incident-derived Overview payload
            (`incidents_7d`, `incidents_by_class`, `incidents_by_state`,
            `rates.self_heal`, `rates.retries`) that nothing rendered any more.

Decision:   **Airtable wins uniformly on the resync, including Layer 0.** The
            brief said completed Layer 0 rows are never deleted — they are the
            record of what failed the check. Asked directly, with the
            consequence spelled out, Destiny chose the other way: "resync pulls
            what's in airtable, if they've been deleted, pull zero cuz its
            empty, airtable and postgres must match." So the resync keeps
            deleting them and the seven rows in `engine_layer0_holds` go on its
            next production run. Naming the conflict here because the brief and
            the code now disagree on purpose.

Decision:   **The completeness card keeps reading the builder rows** (Destiny),
            so it will say 8 flagged while Needs input says 0. Two different
            questions — what failed the check at some point, and who is owed an
            answer now — and the page stops conflating them. The stat card's
            footnote says so.

Decision:   **`Jason Reviewed At` needs no code.** It is on all six builder
            tables (dateTime, UTC) and `mirror.prepare` stores `fields` whole
            with no whitelist, so the resync already carries it. Proved by
            round-trip: written through `/api/engine/codex`, read back out of
            `engine_codex_submissions.fields` unchanged.

Decision:   **Home loses every figure it drew from the incident and vFarm
            fixtures**, not only the two pages. The vFarm-status and
            open-incidents pins, the incidents chip, the Engine health card with
            its self-heal rate and incidents by class, and the seven-day
            incident count. The two tiles stay as navigation with a dash where
            the number was. Left alone and still fixtures: the two 24-hour
            columns, which are what section 7 asks for and predate this.

Decision:   **No credentials registry, and the table is not dropped.** It is
            neither read nor served. `ShownKind = Exclude<RegistryKind,
            'credentials'>` makes naming it from the page a type error rather
            than an undefined at runtime.

Decision:   **The Builders registry shows a dash, not a zero, where a person has
            no table of that kind.** Jason has an Open Loops table and no
            submissions table, so his entries this week is null. A zero and an
            unknown must never look the same.

Verified:   `npm run typecheck && npm run build` clean.
            Against the local rig, the stage rule in all three shapes:
            - a flagged log with no Layer 0 row and Jason Status Approved →
              **Approved**. That is the eight-log case, fixed.
            - a log with a hold at `pending_builder_input` → **Needs input**,
              whatever Jason Status says.
            - a log with a hold at `completed` → placed by Jason Status alone.
            - 13 + 6 + 1 = 20, and 2 + 1 + 0 = 3 scoped to one builder.
            The resync toast, both ways: "Resync complete in 0.1s · 0 inserted,
            0 updated, 0 deleted", and with one table forced to 403, "Resync
            finished in 0.1s · 0 inserted, 0 updated, 0 deleted · Ahad could not
            be read, so nothing under it changed". The per-table breakdown is
            still in the server log in full, with Airtable's own reason.
            An empty stage keeps its frame, headers, tabs and search box with
            one centred line in the table.
            In Chromium at 1440 and 400: Codex, Home, vFarm, Engine health and
            all five registry tabs, zero page overflow, no console errors.

Problem:    At 400px the Builders rows read "0 — 0" with no labels: the table
            stacks into cards and the column headers are gone. Worse, the cards
            were as wide as the table's own min-width and had to be scrolled
            sideways — true of every registry tab, not just this one.
Fix:        Each live figure carries a label under 768px. `.table-cards` drops
            its min-width in card mode, and the tab row scrolls inside itself
            rather than clipping a label in half. Both apply everywhere.

Not done:   The Overview's "what broke" and "what moved" columns are still the
            hardcoded phase 1 fixtures they have always been; they are what
            section 7 asks for and were not in this brief. The generic
            `/api/registry/:kind` write routes still accept `credentials` — the
            kind is gone from the page and the payload, not from the server's
            vocabulary. And still outstanding from this morning: nobody in this
            sandbox can press Resync, so the first production run's per-table
            numbers come from the Render log.

## 2026-09-14 18:20 — After the deploy: what the two sides hold
Intent:     Record the numbers, since the page itself cannot be read from here.
Verified:   Deploy live at 18:11. Boot line clean: schema up to date (8
            migrations), registry already populated, both Airtable bases named,
            ledger 1442 rows. No errors since.
            Live Airtable, read again after the deploy, all six builder tables
            in full — 165 rows: Destiny 38, Jegan 25, Kaiqi 36, Hardik 26,
            Ahad 15, Kavin 25. Jason Status: **151 Approved, 14 Input Added, 0
            Pending, 0 blank**. 8 rows flagged (Hardik 2, Ahad 4, Kavin 2).
            `Jason Reviewed At`: 0 rows carry a value, which is what the field's
            own description says to expect. The Layer 0 table: **0 records**.
Problem:    So Airtable says Approved 165 / Awaiting 0 / Needs input 0. The page
            reads Postgres, and Postgres has not been resynced: this morning it
            held 164 rows with 2 still Pending, so it will read 162 / 2 / 0
            until somebody presses the button. Needs input is 0 either way — the
            seven Layer 0 rows still in Postgres are parked submissions that
            never reached a builder table, so nothing joins to them.
Not done:   The resync. It is manual by instruction and nothing in this sandbox
            can press it, so the first production run's per-table numbers still
            come from the Render log afterwards.

## 2026-09-15 11:10 — Build patterns, Commercial and Clients: what the data actually supports
Intent:     Finish the three sibling record pages. Remove every grouping whose
            buckets are constant or one-per-row, give all three the resync the
            Codex page has had since yesterday, and find out what "1.3 open"
            was rather than guessing at it.

Files:      server/src/sources.ts, store.ts, engine.ts, index.ts
            src/data/types.ts, src/data/index.ts
            src/screens/BuildPatterns.tsx, Commercial.tsx, Clients.tsx, Codex.tsx
            src/components/ui/Resync.tsx (new), index.ts, src/index.css
            CLAUDE.md, README.md, render.yaml, .env.example

Problem:    The Commercial page's lane strip rendered "1.3 open", "1.5 open",
            "1.8 open". Those cannot be a per-lane average of
            missing_research_count: every lane holds exactly one card and the
            corpus total is 53 across 18 populated records, averaging 2.9.
Fix:        Found in the code, not reasoned about. `src/screens/Commercial.tsx`
            drew the lane bar's value as:

                {l.n} <span className="text-faint">· {l.unresolved} open</span>

            — the card count, a middot, and the open-question count. Every lane
            holds one card, so the first number was always 1 and the middot at
            11px on a faint span read as a decimal point. "1.5 open" was one
            card with five open research questions. Nothing computed a decimal.
            It went with the grouping it belonged to; the note is in the
            Commercial screen's header comment so nobody re-derives it.

Decision:   **Nothing on Commercial groups the corpus.** Checked against all 21
            records: lane_id is 1:1 with the card, readiness_state is 19/1/1
            with INCUBATE never used, and pilot_state, routing_state, media_gate
            and lane_state are one hardcoded value each. One sortable table
            instead, defaulting to missing_research_count ascending then
            media_readiness descending. Four figures above it.
Decision:   **The eight dead-scaffold columns are not mapped at all**, not
            merely hidden. A field with no way out of `sources.ts` cannot be
            rendered by accident later. They stay in Airtable and inside the
            stored `fields` blob — nothing here removes a column the engine
            owns.
Decision:   **Build patterns loses `pattern_status` entirely.** The field is
            gone from the base — confirmed against live Airtable, the table has
            20 columns and none of them is a state — so the split, the pill, the
            filter, the two row actions, the by-system bar and the promotion
            rate all go, and `STATUSES.patterns` is now empty, which makes a
            write to it a 422 rather than a write to a column that does not
            exist. `statusOf` returns a constant for patterns: there is no state
            to move between, and the ledger records only that this database has
            seen the row.
Decision:   **Clients is one table with a heading row per client**, not a table
            per client. Four tables gave each block its own column widths, so
            nothing lined up down the page and the header row was drawn four
            times for four lanes.
Decision:   **Lane Status and Run State get two columns.** They answer different
            questions — onboarding maturity against the outcome of the last run
            — and the single pill that mixed them could only ever say one.
            Staleness moves to `Next Run Due` against today, which is the field
            the weekly clock actually reads.

Problem:    The resync read five rows from Build Patterns and stored none. The
            result said "5 rows, 0 inserted, 0 updated, 0 unchanged", which a
            reader could take for a table that already matched.
Fix:        Two things. The rig's fault was real — its fixture record ids were
            `rec` + 13, and `mirror.upsert` refused every one of them, correctly.
            But the reporting gap was ours: a row read from Airtable and refused
            by this database was logged and then invisible. Every resync now
            counts refusals per table, says so in the note and in the toast, and
            the run reads as a failure. The same count went onto the Codex
            resync, so the four pages report identically.

Decision:   **One shared resync**, `store.resync` behind
            `POST /api/{patterns|commercial|clients}/resync`, and one shared
            control in `src/components/ui/Resync.tsx` that the Codex page now
            uses too. Codex keeps its own server-side pass: it has a deletion
            log, a Layer 0 table and an unlanded-write check that the other
            three do not, and folding those together would have been a rewrite
            of a path that works.
Decision:   **Clients follows the index and only the index.** A questions table
            no index row names is never read, and a question row held against
            one is removed — but only once the index has actually been read,
            because without that guard the first refusal from Airtable would
            empty the whole kind.
Decision:   **A change made here that Airtable never had is named when it is
            reverted.** These three kinds write no line to `record_writes` —
            only loops and Codex go to Airtable from here — so the signal is the
            mirror row's own `source = 'ui'`, which is exactly what it records.
Decision:   **The token now reads five bases and writes two.** Read-only on
            Build Patterns, Commercial Opportunities and BHA Client Research
            Loop. Those three get no base variable of their own: this server
            never writes to them, so it can never write to a guess about them.
            render.yaml, .env.example and README all say so — the same mistake
            as 14 Sep, where the comment said "the Open Loops base and nothing
            else" and a token scoped from it failed every Codex read.

Problem:    `patternMetrics` reported `distinct_ids: 4` beside a note reading
            "5 rows carry 3 distinct pattern ids". The figure counted rows with
            no pattern_id as one id each; the sentence did not.
Fix:        `distinct_ids` is the count of distinct ids and nothing else, and
            the note prints the arithmetic — "5 rows: 3 distinct pattern ids +
            1 duplicate row (BP-BHARAG-002-CHUNK_OVERLAP) + 1 row carrying no
            pattern_id" — so a reader can check it on the page.

Verified:   Against a real Postgres 16 and a replay of the Airtable REST API
            that refuses exactly what Airtable refuses (`fields[]=` with no
            field named answers 422 `Unknown field name: ""`), pages two records
            at a time so `offset` is genuinely followed, and can be told to 403
            a named table.
            - empty database: patterns +5, commercial +4, clients +8 across the
              index and four question tables followed from `Table ID`.
            - re-run with nothing changed: 0/0/0, everything "already matching".
            - one field edited, two rows deleted, one lane added to the index:
              patterns ~1, commercial -1, clients +1/-1 — and the new lane's own
              questions table was read in the same pass, without a code change.
            - two tables forced to 403: named with Airtable's own reason, the
              run reads as a failure, and `select count(*)` confirms nothing
              under either was deleted. The patterns run came back ran=false.
            - orphan question row with the index unreadable: kept. With the index
              readable: removed, counted, named in the note, and the whole row
              written to `record_deletions` first.
            - readiness_state set here, then a resync: "1 of those updates
              overwrote a change made here that Airtable never had — CARD-2".
            - `PATCH /api/records/patterns/:id` now answers 422, "patterns is
              read-only in this dashboard".
            In Chromium at 1440 and 400, all five pages: no console errors, no
            page errors, zero horizontal overflow. Each sortable column checked
            by clicking it — open questions ascending and descending, created
            newest-first with the undated card last, confidence and media
            readiness strongest-first. The resync button pressed on all four
            pages: identical wording, and the failure path reads "Resync
            finished in 0.2s · 0 inserted, 0 updated, 0 deleted · Client 9 —
            Veganism/Plant-Based Trend could not be read, so nothing under it
            changed" in the failing tone.
            `npm run typecheck && npm run build` clean.

Not done:   The Overview's build-patterns and commercial tiles lost the figures
            they were reading (canonical/draft counts, and cards "blocked on
            research" from the dead `lane_state_blocked_reason`). They now read
            broadly-reusable and open research questions, which are real, but
            nobody asked for a tile redesign and that is all they got.
            The Commercial card still offers Set media-ready / research-first /
            incubate. Those writes land in Postgres only and a resync takes
            Airtable's value back — the same property the Codex page has — so
            the toast now says so on the write as well as on the resync. Removing
            them would be a scope change and was not in the brief.
            Nobody in this sandbox can press these buttons against live
            Airtable, so the first production run's per-table numbers come from
            the Render log.

## 2026-09-15 11:55 — Monthly tracking, execution tracking, and a registry pass
Intent:     Add the monthly rollup to all five record pages, give each system
            per-workflow execution visibility, and bring the Engine Registry's
            spacing into line with the three pages finished this morning.

Files:      server/src/n8n.ts (new), executions.ts (new), monthly.ts (new)
            server/src/migrations.ts, store.ts, sources.ts, index.ts
            src/data/types.ts, src/data/index.ts, src/lib/csv.ts (new)
            src/components/ui/Monthly.tsx (new), Executions.tsx (new), index.ts
            src/screens/Bays/index.tsx (new), EngineHealth/index.tsx
            src/screens/OpenLoops/index.tsx, Codex.tsx, BuildPatterns.tsx,
            Commercial.tsx, Clients.tsx, NorthStar.tsx, ResearchTwin.tsx
            src/screens/Registry/index.tsx, src/App.tsx, components/Layout.tsx
            CLAUDE.md, README.md, render.yaml, .env.example

Problem:    Read against the live instance before writing anything: n8n holds
            **3,673 executions and none older than 12 Sep 2026** — three days.
            `startedBefore=2026-09-12T12:00:00Z` returns zero. So a monthly view
            that queried the API live would be told, honestly, that August held
            nothing, and would draw a clean past that is only missing data.
Fix:        `engine_executions`, migration 9. One row per workflow per month,
            nothing prunes it, and the counts are **accumulated forward rather
            than recomputed** — each pass reads only executions above a
            watermark and adds them, so a month keeps the count it had when its
            executions still existed. Proved against a replay that ages
            executions off on command: July and August survived n8n forgetting
            every execution they were built from.

Problem:    The first design held the watermark below the oldest unfinished
            execution so a run still in flight would be re-read. Everything
            *above* it was then counted again on every pass: a September total
            of 2 read 4 after two passes with nothing new. Caught in the rig,
            not in production.
Fix:        The watermark moves past everything read; an unfinished execution
            goes on a deferred list by id and is looked up individually until it
            finishes, then counted exactly once. It also removes a starvation
            bug the first design had: one execution parked on a Wait node would
            have frozen all counting behind it indefinitely. An execution that
            ages out of n8n before finishing is dropped and never counted,
            because nothing knows how it ended.

Decision:   **A chart bar is never drawn for a month with no instrumentation.**
            Every month carries its own coverage, and `created` and `advanced`
            carry it separately, because they are almost never instrumented from
            the same date. `none` draws no bar at all, behind a dashed boundary
            rule, with a sentence saying what began when.
Decision:   **Loops are the clearest case for splitting the two.** `Date Raised`
            has always existed; a close is dated only by this dashboard's own
            status ledger. So July and August draw a raised bar and **no closed
            bar at all** — nine of those loops are closed in Airtable and not one
            of those closes can be dated. Drawing "closed: 0" would have been the
            lie the whole shape exists to prevent.
Decision:   **Codex approval rate is honest for the whole history; days to
            approval is not.** The rate counts a cohort's state today rather than
            a dated event. `Jason Reviewed At` was created on 14 Sep 2026 —
            confirmed against the live base, whose own field description reads
            "Nothing before 14 Sept 2026 carries a value; it is not history
            before then" — so it is a separate panel, July and August draw
            nothing, September is partial and **October is the first honest
            month**. The field was not mapped at all before today.
Decision:   **A month whose rows mostly arrived later is marked partial.** Not in
            the brief, and found in the data: Build Patterns holds 152 rows and
            most of them were written to Airtable in one go on 12 Aug 2026,
            carrying `created_at` values spread back through July. Those dates
            are real and belong on the chart, but a bar of a hundred backdated
            rows is not a hundred patterns' worth of output that month. The
            mirror row's `created_time` against the record's own date is what
            detects it.
Decision:   **Build Patterns also needs an undated count.** The brief flagged
            only Commercial. Twenty of the 152 pattern rows carry no `created_at`
            — checked against the live base — so it gets the same explicit
            undated count, per the rule that a record with no date is never
            dropped or re-bucketed.
Decision:   **CSV is built from the rows the page is showing**, not re-queried,
            so the file and the screen cannot disagree. Cells beginning `=`, `+`,
            `-` or `@` are prefixed with an apostrophe: these exports carry free
            text written by builders and by agents, and a spreadsheet reads those
            as formulas.
Decision:   **A workflow's system comes from the workflow registry**, which
            already holds one row per workflow with its `system`. Pointing a new
            workflow at a system is a registry edit, not a deploy — the same rule
            as the watched-clients index. One n8n reports that no row names is
            counted and listed on Engine health as unregistered rather than filed
            under a guess.
Decision:   **Engine health keeps the roll-up and nothing more.** One figure per
            system, a link through, and no per-workflow detail: two drawings of
            the same counts drift, and whichever a person opens first becomes the
            one they trust. Its incident half is still the placeholder it became
            on 14 Sep, and the page now says plainly that a failed execution and
            a self-healed incident are different things.
Decision:   **Bays gets a page and execution health is the whole of it.** The
            output stays on the four record pages and is linked rather than
            copied.
Decision:   **`N8N_API_KEY` is a new variable and a different credential from
            `ASK_BAYS_API_KEY`** — an instance API key rather than a webhook
            header. Read only: the one endpoint used is GET /api/v1/executions
            and nothing in this server can write to n8n. No new dependency.

Verified:   Against real Postgres 16, the Airtable replay (now carrying the six
            builder tables) and a new n8n replay that ages executions off and can
            leave one running.
            - executions bucket by month and map to systems from the registry.
            - n8n discards everything it holds: July and August keep their exact
              counts, September accumulates. A pass with nothing new changes
              nothing.
            - a running execution is not counted, the watermark moves past it,
              nothing above is double counted; when it finishes it is counted
              once and stays once; one that ages off while deferred is dropped.
            - loops: Jul raised 6 / closed none, Aug raised 6 / closed none, and
              the boundary note names 2026-09-15 as the day the ledger started.
            - codex: approval rate 100/92/83 across Jul/Aug/Sep with full
              history; median days to approval draws nothing for Jul and Aug,
              3.2 days over 5 logs for Sep, boundary 2026-10.
            - month selection filters the list (5 rows → 1 for Aug) and the
              export follows: `build-patterns-2026-08.csv`, one row, carrying
              pattern_id and the Airtable URL.
            - CSV escaping: a formula-leading cell is guarded, commas and quotes
              quoted and doubled, a newline quoted, a null empty.
            In Chromium at 1440 and 400, all ten pages plus every registry tab:
            no console errors, no page errors, zero horizontal overflow.
            `npm run typecheck && npm run build` clean.

Not done:   **The Engine Registry's Workflow tab clips its last column.** The
            table is wider than its card and scrolls inside it, which is allowed,
            but there is no affordance saying so and the header reads "up" cut
            mid-word. That is a real problem rather than a spacing
            inconsistency, so per the brief it is reported and not fixed.
            The registry pass was otherwise narrow: the intro paragraph is capped
            to a readable measure, and every stat cell now declares a hint floor
            so a row of four reads as one block, which is what Build patterns,
            Commercial and Clients do.
            **The brief said Build Patterns has "effectively no history before
            15 Sep 2026".** The live base disagrees: 152 rows dating back to
            16 July. Blanking July and August would have erased 130 real
            patterns, so September is marked partial instead and the backfill
            detection above says which months are imported history. Worth
            confirming that reading.
            The first production snapshot stamps the coverage boundary, so
            whichever month it first runs in is partial by construction —
            October 2026 if it deploys today. Nothing in this sandbox can run it
            against the real instance.

## 2026-09-15 13:40 — One Executions page: day grain, three periods, and comparisons that refuse to lie

Intent:     Destiny, dictated: delete the Bays page built ninety minutes ago and
            replace the whole per-system execution treatment with one Records
            page called **Executions** — "where we keep track of every execution
            across every workflow across the motherfucking system". Tabbed by
            system the way the Engine registry is tabbed: Bays, North Star,
            Research Twin, "because those are the only systems that really
            matter right now or that are active on anything right now". Keep the
            structure that already worked (workflow, executions, failure rate).
            Add weekly, monthly and yearly tracking, "although we don't have data
            for yearly yet". Add average execution time. And add comparisons
            against the period before: "in comparison to last week, our
            executions were 2% faster... we had 20% less failures this month, we
            had 100% more successes this month, and we had a 2 percent or
            3 percent increase in workflow executions this month."

Files:      server/src/migrations.ts       migration 10, engine_execution_days
            server/src/executions.ts       rewritten: day grain, duration, periods, comparison
            server/src/index.ts            /api/executions?grain=
            src/screens/Executions/index.tsx   new page
            src/screens/Bays/                  deleted
            src/components/ui/Executions.tsx   deleted
            src/components/ui/index.ts         export removed
            src/screens/NorthStar.tsx          execution section removed
            src/screens/ResearchTwin.tsx       execution section removed
            src/screens/EngineHealth/index.tsx repointed at the week grain
            src/components/Layout.tsx          Bays out of SYSTEMS, Executions into RECORDS
            src/App.tsx                        route swapped
            src/data/types.ts, src/data/index.ts
            CLAUDE.md, README.md

Problem:    **The stored grain could not answer the question.** `engine_executions`
            held one row per workflow per *month*, which was right for a monthly
            page and useless for this one: a month can be divided into weeks
            after the fact only if the rows are finer than a month, and they were
            not. There is no honest way to split 890 executions across the four
            weeks of August once the executions themselves have aged out of n8n.

Fix:        Migration 10 adds `engine_execution_days` — one row per workflow per
            **day**, which is the finest grain n8n's own `startedAt` supports, and
            weeks, months and years are all sums over it. `engine_executions` is
            left in place and unread, like the `records` read model; nothing here
            drops a table. The reset cost nothing to verify: n8n holds three days
            of history, so everything the monthly table knew was re-read within a
            day of the change.

Problem:    **An average of averages is not an average.** Storing `avg_ms` per
            day and meaning it per month weights a quiet Sunday the same as a
            busy Tuesday.

Fix:        Each day row stores `duration_ms` (a sum) and `duration_counted` (a
            count), never a mean. The mean over any span is the sum over the
            count, which is exact. An execution with no `stoppedAt` contributes
            neither, so the figure is of executions that actually finished, and
            the page prints how many were timed beside it.

Problem:    **Every running period read as a collapse.** Three days into
            September the comparison was September-so-far against the whole of
            August: 42 executions against 890, "−95%". True arithmetic, useless
            sentence.

Fix:        A period still running is compared against the previous period **cut
            to the same elapsed point** — three days in, against the previous
            month's first three days — and the page says so. Found an off-by-one
            in the wording while testing it: a two-day-old week printed "its
            first 1 day", because elapsed was a difference rather than a count.
            `elapsed = diff + 1`, cut at `addDays(start, elapsed - 1)`.

Problem:    **The monthly comparison read "0 → 890, +∞".** Counting began on
            24 Aug. Comparing the first fortnight of September against the first
            fortnight of August compared it against days nobody counted, and
            printed the silence as a rise.

Fix:        The comparison checks the **window's** start against
            `meta.executions.since_day` — not the whole previous period, which
            would wrongly refuse a comparison whose counted tail is real — and
            when the window predates counting it refuses the delta and says why:
            "counting only started on 2026-08-24, and 2026-08-01 to 2026-08-15 is
            before that". Those days were not quiet, they were not recorded.
            Separately, `delta()` returns a null percentage when the previous
            figure is nought and prints both figures instead, because a change
            against nothing has no percentage.

Problem:    The first chart label was clipped at the left edge of its SVG, and
            month labels carrying a year read as dates ("Aug 26" beside "24 Aug").

Fix:        A 16px gutter on the chart, and the year suffix only when the span
            being drawn crosses years.

Decision:   **The tabs are the three active systems plus all.** vFarm has no
            workflow and Codex is not a system that executes; a tab that is
            always empty is furniture. A workflow no registry row claims is still
            counted, and still named on Engine health as unregistered, because
            that is a registry row somebody needs to add.

Decision:   **Engine health keeps the roll-up and loses nothing else.** It now
            reads the week grain and links to Executions. Two drawings of the
            same counts drift, and the one a person opens first becomes the one
            they trust.

Decision:   **Yearly ships with no data and says so** rather than being hidden.
            The grain exists, 2026 is the only year, and there is no 2025 to
            compare against — which the page states. Hiding it until January
            would mean shipping it in January.

Verified:   Against the rig — real Postgres, an n8n replay holding 1,086
            executions across four weeks, five registered workflows and one
            unregistered:
            - Weekly, all systems: 196 executions, 192 ok, 4 failed, 3.7 s avg.
              Against the week of 7 Sep, like-for-like: executions 108→196
              (+81.5%), successes 103→192 (+86.4%, better), failures 5→4
              (−20%, better), failure rate 4.6%→2% (−56.5%, better), average
              3,744 ms→3,661 ms (−2.2%, better).
            - Monthly: 890 / 854 / 36, and the comparison correctly **refused** —
              "counting only started on 2026-08-24".
            - Yearly: 1,086 / 1,041 / 45, comparison refused; 2025 was never
              recorded.
            - Tabs: Bays 151, North Star 26, Research Twin 17. Failing execution
              ids link through to n8n.
            - Two passes with nothing new between them left every total
              unchanged, which is the double-count regression test.
            In Chromium at 1440 and 400: no console errors, no page errors, zero
            horizontal overflow. `npm run typecheck && npm run build` clean.

Not done:   The first production snapshot after this deploy stamps the coverage
            boundary and `since_day`, so the period it first runs in is partial
            by construction and every earlier period is refused a comparison
            until a full one exists. Nothing in this sandbox can run it against
            the real instance.
            The Engine Registry's clipped Workflow column, reported at 11:55, is
            still reported and still not fixed.

## 2026-09-15 14:30 — Executions: store the executions, delete the counters

Intent:     Destiny, after seeing the live page: every number on it is wrong,
            and the fix is the storage model rather than the arithmetic —
            "Do not start by fixing the counters. They are being deleted."
            One row per n8n execution id, a backfill of everything n8n holds, a
            30–60 second poll, an unregistered bucket beside the three systems,
            a per-workflow drill-down, the period comparison in prose, and
            downloadable reports. And one factual correction: stop asserting a
            retention window nobody has confirmed.

Files:      server/src/migrations.ts       migration 11, engine_execution_runs
            server/src/n8n.ts              the paging fix, /workflows, the stall guard
            server/src/executions.ts       rewritten against rows
            server/src/index.ts            ?period=, /workflow/:id, /backfill, the poll
            src/data/types.ts, src/data/index.ts, src/app/useData.ts
            src/lib/executionReport.ts (new), src/lib/csv.ts
            src/screens/Executions/index.tsx, src/screens/EngineHealth/index.tsx
            CLAUDE.md, README.md, render.yaml, .env.example
            /var/tmp/bharig/n8nreplay.mjs  (the rig, and the reason all this shipped)

Problem:    **One bug produced all three faults, and the evidence in the brief
            pinned it exactly.** `server/src/n8n.ts` walked the executions list
            with `?limit=200&lastId=<cursor>`. The n8n public API does not accept
            `lastId` — it pages on an opaque `cursor` — so it ignored the
            parameter and returned the newest 200 executions every time. The
            walk ran its full 60-page ceiling, pushing the same 200 rows 60
            times, and the counter table faithfully **added** them:

              196 executions in the week × 60 = 11,760, the headline on screen.
              Per workflow: 97, 27, 25, 24, 17, 4, 2 × 60 = 5820, 1620, 1500,
              1440, 1020, 240, 120 — the exact multiples of 60 Destiny spotted.
              12,000 − 240 (4 still running × 60, correctly set aside) = 11,760.

            Failures read 0 because the newest 200 ids were 3702–3902 and both
            errors (3396, 3413) are below that — the pages holding them were
            never reached. 7 workflows of 31 for the same reason. And the
            "11760 of 11760 runs recorded an end" caption beside "4 still
            running" was the same multiplication applied to the duration count.

Fix:        `cursor`, carrying `nextCursor` verbatim. And because a reader that
            cannot page is broken whether or not it corrupts anything, the walk
            now proves it is moving: every page must contain an id lower than
            the lowest seen so far, and one that does not stops the walk and is
            reported as stalled rather than followed.

Problem:    **The rig shared the bug it existed to catch.** `n8nreplay.mjs`
            paged on `lastId`, because the client did. Every test passed against
            a stand-in that implemented the client's assumption. This is the
            same failure CLAUDE.md already records for the Airtable replay on
            14 Sep — "the replay used for testing must refuse exactly what
            Airtable refuses" — repeated verbatim with n8n eight hours later.
Fix:        The replay now ignores `lastId` exactly as n8n ignores it, and pages
            on an opaque base64 `cursor` that cannot be mistaken for an id. A
            `ignoreCursor` flag reproduces a cursor the server does not honour,
            which is what the stall guard is tested against.

Decision:   **Counters are gone; the rows are the record.** Migration 11 creates
            `engine_execution_runs`, primary key `execution_id`, carrying
            workflow, status, mode, start, end and duration. Every figure is a
            GROUP BY. Nothing accumulates, there is no watermark arithmetic, and
            a re-read is an upsert — so the backfill is safe to run at any time,
            which is now a button on the page. `engine_execution_days` and
            `engine_executions` are left in place unread; nothing here drops a
            table.
Decision:   **No `system` column.** The system comes from `registry_workflows`
            by join at read time, so pointing a workflow at a system re-files its
            whole history rather than only its future. The old table copied the
            system onto each row, which froze yesterday's answer into yesterday's
            rows.
Decision:   **Duration is null where a run recorded no end, never nought.** A run
            of unknown length and a run of no length are different facts, and an
            average must not be dragged down by the first.
Decision:   **The failure rate is over finished runs**, not over every row. An
            execution still running has neither failed nor succeeded, and putting
            it in the denominator would report a lower failure rate the busier
            the moment.
Decision:   **Unregistered is a tab, and so is any other system the registry
            names.** The rig turned up a case the brief did not: one workflow is
            filed under `vFarm`, which had no tab, so its executions were in the
            All systems total and under no tab at all — invisible for the same
            reason an unregistered one was. Tabs are now the three known systems,
            every other system present in the data, and Unregistered. They sum to
            All systems exactly, which is how you can see nothing was dropped.
Decision:   **The poll is 45 seconds and the page says so** — in the subtitle, in
            the card note and in a line at the foot. Nothing is described as
            live. No reporting node was added to any workflow: a workflow
            somebody forgets to instrument is a silent gap, which is the failure
            this dashboard exists to remove.
Decision:   **An execution still running is a row, not a list entry.** It is
            stored with its real status and re-read by id until it finishes, so
            the row is its own to-do list and there is no deferred-id list to
            keep in step with the table. One n8n no longer holds becomes
            `unknown`, which is what it is.
Decision:   **The retention claim comes off, everywhere.** The page, the client,
            CLAUDE.md and the README all said n8n keeps about three days and
            discards the rest. Never verified, and not true as stated: the
            history begins on 12 Sep because that is when the instance was
            migrated. What they say now is that the rows are copied here so the
            record does not depend on another system's retention policy, and
            what this database holds and from when.
Decision:   **The prose comparison is generated on the server**, not on the page,
            so the screen and the downloaded report cannot word the same
            comparison differently. The report carries every caveat inside the
            file — coverage, the comparison in full, the refusal where there is
            nothing honest to compare against — because a report is read after
            the page is closed.

Verified:   Against real Postgres 16 and a replay seeded to the live instance's
            exact shape: 31 workflows, 3,895 executions, ids to 3931 with gaps,
            oldest 12 Sep, 51 failures at the live ids, 3 canceled, 4 running.
            Verification targets from the brief, first pass, from an empty
            database:
            - 3,895 rows stored, read over **20 pages** (not 60 of the same one).
            - highest execution id 3931; oldest day 2026-09-12; newest today.
            - 31 distinct workflows.
            - 51 failures — 49 error, 2 crashed — matching n8n exactly.
            - 3,837 success + 51 failed + 3 canceled + 4 running = 3,895.
            - **Three further full backfills left the table at 3,895 rows.**
              That is the ×60 regression test: under the old design each pass
              added another copy.
            - the stall guard: with a cursor the server ignores — the old
              `lastId` condition exactly — the walk stops after 2 pages, stores
              200 unique rows rather than 12,000, and says "n8n's paging did not
              advance".
            - the poll picked up two new executions within 25s over one page,
              and resolved a running one by id 35s later: status running with a
              null duration became success with its real duration, and the total
              stayed put.
            - tabs sum: All 2113 = Bays 1143 + North Star 351 + Research Twin 483
              + vFarm 71 + Unregistered 65. Weeks sum to the whole: 1054 + 1278 +
              1274 + 289 = 3,895. Aug 1236 + Sep 2659 = 3,895.
            - comparisons: a past whole period reads "Against 31 Aug (2026-08-31
              to 2026-09-06): executions down 0.3%, successes down 0.8%, failures
              up 400%, the failure rate up 0.6 points, average run time 0.2%
              faster"; the running week reads "Against the same point of 7 Sep
              (its first 2 days …)"; a window before the oldest row held is
              refused by name in all three grains.
            - the drill-down lists a workflow's days and its individual runs with
              id, start, duration, mode and outcome, each id linking into n8n.
            - the report downloaded as `executions-all-systems-2026-W37.csv`,
              4,444 bytes, carrying the period, the coverage, the prose, the
              per-workflow rows and every period held.
            In Chromium at 1440 and 400, every tab, all three grains, a past
            period selected, the drill-down opened: no page errors, no
            horizontal overflow. `npm run typecheck && npm run build` clean.

Not done:   The figures above are the rig's, against a replay shaped like the
            live instance. The production backfill runs on this deploy and its
            own figures are in the Render log and on the page's own line
            ("3,895 executions held, from 2026-09-12 · newest id 3931").
            The Engine Registry's clipped Workflow column, reported at 11:55 and
            again at 13:40, is still reported and still not fixed.

## 2026-09-15 14:45 — The backfill checks itself against n8n's own total

Intent:     Report the production backfill against the brief's verification
            targets, and reconcile a difference rather than round past it.

Problem:    The production backfill logged **"4009 read from n8n over 21 pages,
            4009 new, 0 already held"** at 14:27:52. n8n's own API, read through
            MCP minutes either side, reports `count: 3973` with the newest id
            4009, 51 failures and 31 workflows. So the rows stored exceed what
            n8n says it holds by 36 — 0.9%, not a multiple of anything, and not
            the old fault (every row is a unique primary key, and three full
            re-reads in the rig left the table unchanged). The list endpoint
            plainly has gaps in its id sequence — 3421 then 3427 on one page —
            so "no gaps, 4,009 ids" is unlikely; the likeliest readings are that
            the MCP connection and the dashboard's instance API key do not see
            the same set, or that n8n's `count` excludes rows its list still
            returns. Neither is checkable from this sandbox: the Render Postgres
            MCP cannot connect (`FATAL: SSL/TLS required`).

Fix:        Make the server answer the question itself, every time, instead of
            me guessing at it. `n8n.executionsAfter` now keeps the `count` n8n
            returns on the first page, and a full read compares it with what the
            database holds afterwards. Holding **more** than n8n reports is
            expected and silent — rows stay here after n8n stops returning them,
            which is the whole reason they are copied. Holding **fewer** is a
            warning, named in the log, in the backfill toast and on the page:
            "n8n reports holding N and this database holds M after reading
            everything — X short. Something was not read."

Decision:   That check is the cheap general form of this morning's bug. A pass
            that had read 200 of 3,673 would have said so in one line instead of
            presenting a total that looked plausible. It runs only on a full
            read, because an incremental pass has deliberately read only the top
            of the list.

Verified:   In the rig: a clean backfill reads "holds 3895; n8n reports holding
            3895" with no warning; after n8n itself drops 500, the database holds
            3,895 against a reported 3,395 and stays silent, which is the
            expected direction; and a deliberately crippled read stores 200 of
            3,395 and warns "3195 short. Something was not read". The replay now
            answers `count`, as the real API does, so the check is tested against
            the behaviour rather than against an assumption.

Not done:   The 36-row difference itself is still open. The next production
            backfill after this deploy prints both numbers in one line, which
            settles whether this database is ahead of n8n's count (fine) or
            behind it (not fine), without anybody having to read two systems and
            subtract.

## 2026-09-15 14:50 — The self-check runs on every pass, not only a full read

Intent:     Get the held-against-reported comparison in front of somebody within
            45 seconds rather than at the next backfill anybody remembers to run.

Problem:    The check as written only ran on a full read, on the reasoning that
            an incremental pass has read only the top of the list. That was
            wrong about what the comparison needs: the total comes from the
            `count` n8n returns on the **first page**, which every pass fetches
            whether or not anything is new above the watermark. A quiet poll
            knows both numbers and was throwing one of them away — and on a
            deploy where the table is already populated, the boot pass is
            incremental, so the check would not have run at all.

Fix:        The comparison runs on every pass. A pass that is short of n8n now
            logs even when it read nothing new; one that agrees and found
            nothing stays silent, as it should.

Verified:   In the rig: every seventh row deleted from the table by hand, and the
            next quiet poll — "0 read from n8n over 1 page, 0 new" — reported
            "this database holds 3342 — 553 short. Something has not been read."
            No full read, no restart, 45 seconds.

## 2026-09-15 15:00 — Correction: n8n's public API returns no count, so the pass states its own id coverage

Problem:    The check added at 14:45 compares what this database holds with the
            `count` n8n returns. **The public API does not return one.** The
            production log at 14:42 reads "This database now holds 4019." with
            no total beside it, because `reported` came back null. The
            `count: 3973` I had been comparing against comes from the n8n MCP
            connector, not from `GET /api/v1/executions` — a different layer,
            and on the evidence a different scope: its execution list has gaps
            in the id sequence (3421 then 3427) where the dashboard's walk of
            the public API found none. The likeliest reading is that the MCP
            sees a project-scoped subset and the instance API key sees
            everything, which would make this database **more** complete than
            the view I was checking it against, not less. Either way, comparing
            two systems' totals cannot settle it when they may not be looking at
            the same set.

Fix:        The pass now states a fact it can establish on its own: n8n's
            execution ids are one increasing sequence, so the span from the
            oldest id held to the newest says how many executions could exist in
            that range, and the difference from what is held is how many are
            missing from it. "holds 4019, ids 1 to 4019 with no gaps" settles the
            question with one number and no second opinion.
            The reported-total comparison stays, because it is free and correct
            where a total is given, but nothing depends on it.

Decision:   This is the same lesson as the replay: a check that quietly does
            nothing is worse than no check, because it reads as one. The id-span
            line cannot quietly do nothing — it prints on every pass that logs.

Verified:   In the rig, whose replay has 36 ids deliberately missing: "holds
            3895, ids 1 to 3931 with 36 of that range not here". The production
            figure is in the next sync line after this deploy.

## 2026-09-15 15:05 — Production figures, and the 36-row difference explained

Intent:     Answer the brief's four verification targets from production rather
            than from the rig, and close the discrepancy left open at 14:45.

Problem:    Two of the four targets — workflows and failures — were nowhere in
            the server's own output, so checking them meant logging into the
            page and reading two screens.
Fix:        Each pass's line now carries all four: held, workflows, failures and
            the id span. "holds 4044 across 32 workflows, 51 of them failed, ids
            1 to 4045 with 1 of that range not here" answers the whole of
            section 2 of the brief in one line, on every pass, for good.

Problem:    **The 36-row difference was two different views of n8n, not a fault.**
            Production reported "holds 4044, ids 1 to 4045 with 1 of that range
            not here": the dashboard's walk of the public API sees an id space
            that is dense — one absent id in four thousand. The n8n MCP
            connector, read at the same moment, reported `count: 3989` with the
            newest id at 4025: exactly 36 short of its own id range, and the same
            36 as at 14:27. So the MCP sees a subset — most likely one project's
            worth — and the instance API key the dashboard uses sees everything.
            This database is **more** complete than the view I was checking it
            against, which is the opposite of the fear.
Decision:   The targets in the brief were derived from that same MCP view, so
            they read ~36 low. Reported as measured rather than reconciled to
            the brief's numbers: the page holds what n8n's own API gave it, and
            says how much of the id sequence that is.

Verified:   Rig, with 36 ids deliberately absent: "holds 3895 across 31
            workflows, 51 of them failed, ids 1 to 3931 with 36 of that range
            not here". Production, 14:54:41: "holds 4044, ids 1 to 4045 with 1
            of that range not here", growing by 8 and then 11 executions across
            two consecutive 45-second polls, each over one page.

## 2026-09-15 15:05 — Production, against the brief's four targets

The line the production server printed at 15:01:18, which answers all four:

    executions sync: 1 read from n8n over 1 page, 1 new, 0 already held.
    This database now holds 4053 across 32 workflows, 60 of them failed,
    ids 1 to 4054 with 1 of that range not here.

Against the brief:
- **Ids 1 to approximately 3902** → ids 1 to 4054, and the sequence is dense:
  one id of 4,054 is absent. Nothing was skipped.
- **Total approximately 3,900, and materially more means double-counting** →
  4,053, and it is not double counting: the id span bounds it. 4,053 rows
  cannot be 4,054 ids counted twice.
- **31 workflows** → 32 distinct workflows have executions here.
- **At least 2 failures (3396, 3413)** → 60 failures held, both of those among
  them.

The two figures that read high are the same difference as the 36-row one, and
it is a difference between **views of n8n rather than between counts**. The n8n
MCP connector — where the brief's targets came from, and where I checked them —
reports 51 failures with its newest at 03:14, while the dashboard holds 60 and
is still finding more; it reports 31 workflows where the dashboard sees 32 with
executions; and its execution list is 36 short of its own id range where the
dashboard's is dense. The consistent reading is that the MCP sees one project's
worth and the instance API key the dashboard uses sees the instance. **Worth
one look on the page**: the 32nd workflow and those extra failures are real runs
that this view could not see at all, and they will be sitting under Unregistered
or under their own system tab.

## 2026-09-16 07:33 — Codex: the Paid column, and the list reads the session description

Intent:     Two changes to the Codex page, both from Destiny. The pipeline now
            tracks pay and the dashboard had no field for it at all. And the
            wide list column headed "breakthroughs" should be "description",
            previewing the session description rather than the opening of the
            generated codex — the full codex still opens on click.
Files:      server/src/sources.ts, src/data/types.ts, src/screens/Codex.tsx

Problem:    There was no pay field anywhere in this repo, so the first job was
            finding what the engine actually writes rather than guessing a
            name. Read from the live base (Airtable connector), not assumed:
            `Paid`, a **singleSelect with exactly Yes and No**, present in all
            six builder tables — Destiny fldG1JJS6IJewGS05, Ahad
            fldp3kvzIev8wwbzh, Kavin fldg7hnlH3EiBb6I0, Kaiqi flddGiqw6dV247A82,
            Hardik fldjLoGkTKD6ZwpkT, Jegan fld31lpSGDmLKYAxG. Its own
            description in Airtable: "Written as No by Bays — Submit Actions at
            Layer 1 and kept No through Layer 2. Changes to Yes only when Jason
            clicks Yes on the card in #bha-pay-reviews." It is **not** on the
            Layer 0 parking table, which has a different schema, as ever.
Fix:        `paidState()` in sources.ts reads it to `paid: boolean | null` and
            `mapCodex` carries it. The name `Paid` is quoted verbatim and never
            renamed, per rule 6.

Decision:   **Null is a third state and is not No.** The column was added after
            most of the history and nothing backfills it, so a row can carry no
            value. The column prints "not recorded" there, with the reason on
            hover — reading an empty field as "unpaid" would be the dashboard
            asserting a fact the base does not hold, which is exactly what
            section 2 forbids and the same rule as "a zero and an unknown must
            never look the same".
Decision:   **Paid is not coloured, either way.** Paid is not a healthy state
            and unpaid is not a failing one; they are two ordinary facts about
            a log. A green pill on every paid row would be decoration and would
            dilute what green means on the rest of the page. Plain pill for
            both, faint text for not recorded.
Decision:   Paid appears in three places, all reading the same value: the list
            column, the entry panel's field grid, and the CSV export (as `Yes`
            / `No` / blank, never a fabricated `No`). It is searchable by the
            word the column prints, so "unpaid" finds the unpaid rows.

Problem:    The wide column showed the Breakthroughs section of the generated
            codex. Every Layer 2 entry is written to the same template, so 220
            characters of one reads much like 220 of the next; scanning down
            the page past builder names told a reader nothing about which
            session was which.
Fix:        The column is now `description` and previews `Session Description`
            — the builder's own one-line title for the session, which is what
            somebody scrolling the list is looking for. New
            `description_excerpt` on the list shape, built by the same
            `firstLines` helper `entry_excerpt` uses. The full
            `Orchestrator Layer2 Review` is untouched: it is still carried whole
            on the detail shape and still what opens on click, still open by
            default in the entry panel.
Decision:   The `breakthroughs()` parser is **deleted rather than left unread**
            — it had one caller and now has none, and the removed code lives in
            git history rather than commented out, same as the 14 Sep removals.
            `entry_excerpt` stays: it is still searched, so a search for a
            phrase inside a codex still finds its row.

Verified:   `npm run typecheck` and `npm run build` clean. The mapper exercised
            against a real record shape over all four cases: Paid "Yes" → true,
            "No" → false, field absent → null, an unexpected spelling → null;
            and a row with no Session Description → `description_excerpt` null,
            which renders as "No session description was submitted with this
            log." rather than an empty cell. Confirmed the list shape carries
            `paid` and `description_excerpt` and no longer carries
            `breakthroughs`.

Note:       **Rows already in Postgres carry no `Paid` until a resync.** The
            stored `fields` blob is whatever was written when the row landed,
            and `Paid` postdates most of them, so those rows read "not
            recorded" — correctly — until the Codex page's resync button pulls
            the column through, or n8n writes the record again. Nothing here
            invents the value in the meantime.

## 2026-09-16 08:30 — Codex: a statistics tab, a month picker on the export, and the caption comes off

Intent:     Three things from Destiny. Be able to export a month that is not
            the current one. Add a statistics surface — month against month for
            logs, approval rate, approval speed, pay and the completeness check
            — tabbed at the top the way the System Registry tabs its registries.
            And take off "This month is still running."
Files:      server/src/codexStats.ts (new), server/src/delta.ts (new),
            server/src/executions.ts, server/src/index.ts,
            server/src/monthly.ts, src/data/types.ts, src/data/index.ts,
            src/components/ui/Monthly.tsx, src/screens/CodexStatistics.tsx
            (new), src/screens/Codex.tsx

Problem:    "There is nowhere we can download the previous month" was a
            **discoverability** fault, not a missing capability. Clicking a bar
            on the month-over-month chart has always selected that month,
            filtered the list to it and pointed the export at it — but nothing
            on the card said the bars were clickable, so a previous month read
            as something the page could not export.
Fix:        A named month control sits beside Export CSV: "All months", then
            every month held, newest first. Same selection, same state, same
            export — just visible. Verified end to end in a browser: picking
            Jul 2026 downloads `codex-2026-07.csv` with 6 rows, all of them
            July and all of them the selected stage; Aug 2026 downloads 18.
Decision:   The chart bars stay clickable. Two ways into the same state is
            fine; a capability with no affordance is not.

Problem:    Every figure on the page answered "what is it" and none answered
            "is it getting better". An approval rate of 86% says nothing on its
            own.
Fix:        A **Statistics** tab beside Entries, `GET /api/codex/stats?month=`,
            computed in `codexStats.ts`. Six figures, each with the same figure
            a month ago: logs submitted, approval rate, median days to approval,
            share stopped by the completeness check, pay rate, and median days
            to payment.
Decision:   **The two rules that keep the Executions comparison honest are
            reused verbatim, because they are the same risk.** A month still
            running is never set against a whole one — on the 16th, September is
            compared against 1–16 August and the page says so — and a
            comparison whose window predates everything held is refused
            outright rather than reported as a collapse. Without the first,
            this tab would report a catastrophe on the 1st of every month.
Decision:   `delta()` and `movement()` moved out of `executions.ts` into
            `delta.ts` and are now shared. Two surfaces computing a change
            separately will eventually word the same change differently.
Decision:   **A rate moves in points, never in a percentage of a percentage.**
            80% → 90% is up 10 points; calling it "up 12.5%" is a number nobody
            can act on.
Decision:   Colour only where the direction is news, same rule as Executions.
            More logs is neither good nor bad and is uncoloured; a falling
            approval rate is red, a rising completeness-flag rate is red, a
            rising pay rate is green.
Decision:   Cohort state versus dated event is kept explicit, because the two
            have different honesty boundaries. Logs, approval rate, flag rate
            and pay rate are properties of the cohort logged that month read as
            they stand today, so they are honest for the whole history. Median
            days to approval is a dated event from `Jason Reviewed At` (created
            14 Sep 2026, no backfill), so it carries its boundary onto the tile
            and Oct 2026 is the first month it covers whole. It is bucketed by
            the month the **decision** was made, not the month the log was
            written, so a month is not dragged down by logs nobody has reached.

Problem:    **Destiny asked for time-to-pay and it cannot be computed.** There
            is no `Paid At` on any of the six builder tables — `Paid` is a
            Yes/No select and nothing anywhere dates the moment it changed. This
            dashboard does not write the field either, so its own status ledger
            has never seen it move; a resync would only record when this
            database looked, which is not when the payment happened.
Fix:        The tile is shown and says so: "Not recorded anywhere", with the
            reason and what would fix it. Per section 5 — where the capability
            does not exist, say so plainly rather than drawing something that
            implies it works — and per section 4, a metric the data cannot
            support is null with a note, and the note is shown.
Decision:   Not silently dropped from the six. Destiny asked for it, it is a
            real gap, and a tile naming the missing field is how it gets fixed.
            **It becomes a real figure the day the workflow that flips `Paid`
            also stamps when it did**, exactly as days-to-approval became real
            on 14 Sep. Raised with Destiny rather than added to Airtable here:
            this dashboard does not add columns the engine owns.
Decision:   Pay rate's denominator is approved logs **that carry a Paid value**.
            An empty Paid is unknown, never No, and the note says how many
            approved logs were left out for that reason.

Problem:    "This month is still running." sat under the month summary telling
            a reader what the calendar already told them, in the one place a
            real instrumentation caveat goes.
Fix:        The sentence is gone. The current month **stays** hatched and marked
            "part" on the chart, because it is genuinely incomplete and the
            comparison logic depends on knowing that; it simply no longer
            prints a caption. A real caveat still overwrites the coverage and
            prints its own note.

Problem:    `/api/codex/stats` returned 404: "That Codex entry is not held by
            this dashboard." The route was declared after
            `/api/codex/:id`, which matched "stats" as a record id.
Fix:        Moved above it, with a comment saying why it has to stay there.
            **A typecheck cannot catch this and did not** — it was found by
            standing the whole thing up and calling it.

Verified:   Not on a typecheck. A throwaway Postgres 16 cluster, the real
            server booted against it, 41 seeded submissions across three builder
            tables carrying real Airtable field names (12 July, 20 August, 9
            September; 31 of them with a `Paid` value), and the page driven in
            Chromium.
            - Sep vs Aug, like-for-like: "Against the same days of Aug 2026:
              logs down 43.7%, approval rate down 22.2 points, completeness
              flags up 11.1 points and pay rate up 6.2 points." Checked by hand
              against the seed: Sep 1–16 holds 9 logs to August's 16; 7 of 9
              approved (77.8%) against 16 of 16 (100%); 1 of 9 flagged (11.1%)
              against 0; 7 of 7 paid against 15 of 16 (93.8%). Every figure
              matches.
            - Aug vs Jul, both complete: no cut, compared whole.
            - Jul, the earliest month held: comparison refused, in amber —
              "Jun 2026 was not quiet, it was not recorded" — with July's own
              figures still shown, because they are real.
            - Colour: approval down red, flags up red, pay up green, logs grey.
            - Both month pickers, the CSV contents, and the absence of "This
              month is still running" on the entries tab.
Problem:    Two figures read as inventions in the refused case. A null median
            drew a dash at 30px in the display face, which reads like a
            redaction and worse, like a value; and the logs note said "12 here,
            0 then" about a month nobody had recorded.
Fix:        A null figure now says "Not recorded this month" in words, and the
            "N here, M then" clause is only written where there is an M.

## 2026-09-16 09:25 — The statistics tab, generalised to six pages

Intent:     Destiny's list. On Codex: drop median days to approval from the
            entries tab, drop the month card and the month-over-month chart
            with it, move the export to the statistics tab, put the chart at
            the top of that tab, say "average approval time" in hours rather
            than "median days", and print a rate change as a percentage rather
            than points. Then the same treatment on Open loops, Build patterns,
            Commercial, Clients, and — proactively — North Star and Research
            Twin.
Files:      server/src/stats.ts (was codexStats.ts), server/src/delta.ts,
            server/src/index.ts, src/data/types.ts, src/data/index.ts,
            src/components/RecordStatistics.tsx (was screens/CodexStatistics),
            src/components/ui/Monthly.tsx, and the six record screens.

Decision:   **One engine, not six.** `codexStats.ts` became `stats.ts`: each
            page contributes a *spec* — what dates a record into a month, and a
            list of figures — and the month span, the like-for-like cut, the
            refusal, the deltas and the sentence are computed once. Six pages
            each working out a month-over-month change would eventually
            disagree about what "down 12%" means. One route,
            `GET /api/records/:kind/stats`, and one React component.
Decision:   Every spec has to say whether a figure is a **cohort state** or a
            **dated event**, because they have different honesty boundaries. A
            rate read off the cohort created in a month — approval rate, close
            rate, movement rate — is a property of those records as they stand
            today, so it is honest for the whole history and needs no field to
            have been recording. A figure timed from an event exists only as
            far back as the field that dates it and carries that boundary onto
            its own tile. Loops is the clearest case: `Date Raised` has always
            been written so raised and close *rate* are honest throughout, but a
            close is dated by this dashboard's ledger and by nothing else.

Problem:    "Median days to approval" could not answer the question it was
            asked. Every review Jason does in under a day rounded to "0 days".
Fix:        Durations are kept in **milliseconds** and rendered as seconds,
            minutes, hours or days at the point they are read. The tile now says
            "7.8 hours". `days()`, which rounded to a tenth of a day, is gone.
Decision:   The **mean** is the headline, as asked, and the **median sits in the
            note beside it**. Verified on the rig: seven reviews, six under an
            hour and one at two days, is a mean of 7.8 hours and a median of 55
            minutes. A reader who cannot see the second will read the first as
            how long Jason usually takes.

Decision:   A rate change prints as a **percentage, not points**: 79.3% → 76.4%
            reads "down 2.9%". That is the difference between the two rates
            wearing a per-cent sign rather than a ratio of a ratio, and it is
            only safe because the tile always prints "vs 79.3% in Aug 2026"
            underneath, so the number can be checked against what it came from.
            The Executions page keeps points — that choice is recorded in
            CLAUDE.md and was not part of this ask.

Problem:    **Time to payment still cannot be computed** and now neither can it
            be quietly dropped. There is no `Paid At` on any builder table.
Fix:        Unchanged from this morning: the tile says "Not recorded anywhere"
            with the reason and the fix. It is the one `unavailable` metric in
            the whole engine and the shape exists precisely so a real gap can be
            shown rather than drawn as a zero.

Problem:    The four pages carrying a month card each had a second, smaller
            answer to a question their statistics tab answers properly.
Fix:        `MonthlyPanel` and `SecondaryMonthly` are **deleted**, not left
            unread — nothing referenced them and dead components drift. The
            chart itself (`MonthChart`, `Legend`) is exported and is what every
            statistics tab draws with. The chart now fills the card it is given
            (bars grow to fill the width, capped at 90px) and prints each
            month's figures above its own bar, so it reads without hovering.
Decision:   The lists no longer filter by month. With the month card off that
            tab, a list silently narrowed to a month with nothing on screen
            saying so is worse than no filter.
Decision:   North Star and Research Twin have **no `MonthlySeries`** — that file
            encodes per-kind instrumentation boundaries and neither kind has one
            recorded — so their chart is synthesised from the counts the
            statistics already return and drawn by the *same* component. A
            second chart renderer would drift from the first.
Decision:   Research Twin counts **attempts** and exports **cards**, so the
            report names what it carries rather than borrowing the word above
            it. That is the page's own shape caveat: one row per attempt,
            `card_id` repeats.

Problem:    `/api/codex/stats` returned 404 — "That Codex entry is not held by
            this dashboard" — because it was declared after `/api/codex/:id`,
            which matched "stats" as a record id. (Fixed earlier today; the
            generalised route lives under `/api/records/:kind/stats` and cannot
            collide.)

Verified:   Not on a typecheck. A throwaway Postgres 16, the real server, and
            seeded rows for every kind, each carrying Airtable's own field
            names: 41 Codex submissions, 22 loops with 15 dated close events,
            15 patterns, 12 commercial cards, 18 North Star asks, 15 Research
            Twin attempts.
            - All seven routes answered; arithmetic checked by hand against the
              seed. Loops: Sep 1–16 raised 8 against Aug 1–16's 8; closed 5
              against 7; close rate 62.5% against 100%; mean time to close 3
              days, median 3.4; average age still open 9.4 days.
            - Every one of the six pages driven in Chromium: both tabs render,
              the picker lists every month, the export downloads
              `<kind>-2026-09.csv`, and there were **no page errors**.
            - Every main tab re-checked afterwards for leftovers of the removed
              panels: none, on any page.
Problem:    Three figures read as nulls or zeros on the first pass — North Star's
            research-required and citation coverage, and Research Twin's
            requires-human.
Fix:        All three were **the seed, not the code**: `research_required` is a
            Yes/No select upstream and I had written "true"/"false";
            `requires_human` is a checkbox and wants a real boolean; and the
            searches blob is a JSON *string* in `expected_result`, not a field of
            its own. Corrected the seed to match what Airtable actually sends and
            all three computed. Worth recording because each looked like a bug in
            the accessor and none was — the accessors match `sources.ts`, which
            was read off the live bases.

## 2026-09-16 09:55 — Codex and Open loops open on the month, not on all time

Intent:     Destiny's review notes. Both record pages opened on an all-time
            view, so the headline figures never moved. Give the working tab a
            month picker and scope everything under it. Plus: the statistics
            chart should not be clickable, the tile notes should be the same
            length, the loop age buckets should be seven, the four weekly
            series should move to statistics, and the page wash should reach
            the top of the page.
Files:      server/src/store.ts, server/src/stats.ts, server/src/engine.ts,
            server/src/index.ts, src/data/types.ts, src/data/index.ts,
            src/index.css, src/components/ui/MonthPicker.tsx (new),
            src/components/ui/Monthly.tsx, src/components/RecordStatistics.tsx,
            src/screens/Codex.tsx, src/screens/OpenLoops/{index,Loops,Metrics}.tsx

Problem:    "Submissions 41" was every submission BHA has ever logged. It is a
            true number and a useless one: it never moves, so it says nothing
            about how the month is going.
Fix:        `/api/records/:kind/metrics` takes a `month`, and both pages open on
            the current one. The stat strip, the three cards, the stage counts,
            the builder tabs and the list all follow it. `null` is still
            reachable as the last option in the picker — the all-time view is
            worth having, it is just no longer what the page assumes.
Decision:   **The entries tab and the statistics tab share one month
            selection.** Choosing September on one and coming back to the other
            must not show August. Two pickers, one piece of state.
Decision:   **"Entries per builder per week" is deliberately not scoped**, as
            asked. It is an eight-week strip by design and narrowing it to one
            month would blank most of its columns, so it is computed over the
            whole history while everything else follows the month.
Decision:   The builder tabs count the month too. A tab whose number never
            moved would be answering a different question in the same row as
            one that does.

Problem:    Scoping the rows silently made two notes lie. "Closed as a share of
            every loop in the builder's table today" and the page's own "22
            loops across 3 builder tables" both claimed all time while sitting
            over a month's figures.
Fix:        Both reworded — "the loops in view", and the leading total dropped
            from the list caption. The all-time total is in the status strip
            and the month's is in the tabs, so neither number is missing;
            neither is now attached to the wrong sentence.

Decision:   **Open loops' status strip stays all-time and moves above the
            builder tabs** (Destiny). Open, in progress and closed describe
            where the backlog stands today; narrowing them to September would
            answer a different question. It is computed separately, as
            `all_time`, and never takes the month filter. Everything below it
            does.
Decision:   **Seven age buckets** — 0–7, 8–14, 15–30, 31–60, 61–90, 91–180 and
            over 180 — so that card and Close rate by builder beside it, which
            has one row per builder and there are seven, read as one set rather
            than two lists of different lengths. An empty bucket is still drawn:
            "nothing has been open longer than ninety days" is worth seeing, and
            a bucket that vanishes when it empties makes the card change shape
            every time the backlog does.
Decision:   The four weekly series (raised, closed, net, closed per day) move to
            the statistics tab. They were never scoped to a month, which is
            exactly why they no longer belonged above a list that is.

Problem:    The statistics chart was clickable and the month picker below it
            also set the month: two controls for one selection, with nothing
            saying which you had used.
Fix:        `readOnly` on `MonthChart`. It is there to show the shape of the
            year; the picker chooses the month.

Problem:    Approval time's note ran to about seventy words where pay rate's ran
            to twelve, so a row of cards read as six different objects and the
            longest note pushed its own figure out of line with its neighbours.
Fix:        Every note on both pages rewritten to one or two short sentences of
            roughly the same length. **What a note is for: the base the figure
            is over, and the boundary if it has one.** The reasoning lives in
            CLAUDE.md and in the comments, where it is the spec rather than a
            caption — the same call that took the three stage rules off the
            Codex page on 14 Sep.

Problem:    The page's colour wash did not reach the top. Its first two radial
            gradients were centred at 12% and 30% of the page height, which put
            the colour below the frosted top bar, so the bar was blurring bare
            page grey.
Fix:        Those two centres moved to the top edge (0% and 8%). The bar now has
            real colour behind it and the wash reads as starting at the top.

Verified:   The rig again — Postgres, the real server, seeded rows, both pages
            driven in Chromium, no page errors.
            - Codex: opens on Sep 2026 (9 logs); picking Aug 2026 moves every
              figure to 20 submissions, 20 generated, 18 approved, 2 flagged,
              and the builder tabs to Destiny 7, Ahad 7, Kavin 6 — which sums to
              20. Entries per builder per week stayed the eight-week strip.
            - Open loops: status strip 7 open / 0 in progress / 15 closed, all
              time, above the tabs; tabs count September (3 + 3 + 2 = 8); seven
              age buckets drawn; list scoped to September.
            - Both statistics tabs still follow the same month, the chart no
              longer responds to a click, and the notes now sit at the same
              depth across all six cards.

## 2026-09-16 10:15 — Loop page furniture, panel labels, one statistics grid, and a real loading state

Intent:     Destiny's review round. Replace Open loops' tall builder tiles with
            the Codex page's quiet segmented control, drop "All" from the status
            filter, move the month picker next to the search box, rename "All
            months" to "All time", stop the two comparison cards from following
            the builder tab, fix the panel's button labels, restyle the four
            moved series as statistics tiles, and replace the corner "Loading"
            dot with the BHA mark. Plus: make it faster.
Files:      src/App.tsx, src/components/ui/{Loading,MonthPicker,index}.tsx,
            src/components/RecordStatistics.tsx, src/index.css,
            public/logo-mark.svg (new),
            src/screens/OpenLoops/{index,Loops,Metrics,LoopPanel}.tsx

Problem:    **"Close loop" was ambiguous and Destiny asked for it to be renamed
            "Close panel". It is not a panel control.** It calls
            `save({ status: 'closed' })`, which writes Status → Closed to this
            database and then to Airtable.
Fix:        Renaming it as asked would have put a destructive write behind a
            label that says it closes a dialog. The ambiguity is real and is
            fixed the other way: the footer now carries **"Close panel"**, which
            closes the dialog, beside **"Mark as closed"**, which is the write.
            The top row keeps only "Open in Airtable", as asked. Raised with
            Destiny rather than done silently — closing a loop from the panel is
            CLAUDE.md §7 and is not mine to remove.

Problem:    Close rate by builder and How long these have been sitting followed
            the builder tab, so picking Destiny left a comparison chart with one
            bar in it — the one question those two cards cannot answer.
Fix:        They read the all-builders figures and never the per-builder ones.
            They still follow the **month**, because that is a page-level scope
            rather than a comparison axis. The status strip above them follows
            both, as it did.
Decision:   The builder filter becomes the same `Segmented` control the Codex
            page uses, and `OwnerPicker` — the row of tall tiles with a headline
            number each — is deleted rather than left unread. A number per
            builder was a lot of furniture for a filter, and the two cards below
            already say who is where.
Decision:   The status filter loses "All". Open, in progress and closed are the
            three states a loop can be in; a fourth tab that is the sum of them
            earns nothing, which is the same call as the Codex tabs on 14 Sep.

Problem:    The four weekly series arrived on the statistics tab still in their
            own four-across row, so the tab read as two pages stacked: five
            narrow figures, then four wide charts.
Fix:        They are `MetricCard`s in the same three-column grid now, which with
            the five computed figures makes exactly nine. `RecordStatistics`
            takes an `extraTiles` slot for the purpose. They are the one set on
            the tab that is not month-scoped — an eight-week strip by design —
            and each card's own footnote says so.

Problem:    A page that takes a moment showed a grey dot and the word "Loading"
            in the top-left corner, which reads as an empty page with a speck on
            it.
Fix:        The BHA mark, centred and breathing, on the same `idle-breath`
            animation Ask Bays uses — so the two places this dashboard waits
            look like the same product. `public/logo-mark.svg` is `logo.svg`
            with its full-canvas white background path removed, so the mark sits
            on the page wash rather than in a white tile; the sidebar and Ask
            Bays keep the original, where the white circle is the look.

Problem:    "It takes quite a while for a page to load." The server was not the
            cause: every endpoint the two pages call answers in 1–2 ms warm
            (measured on the rig — open-loops 1.4 ms, loops/metrics 1.0 ms,
            loops/stats 2.0 ms, codex 2.0 ms, codex/metrics 0.5 ms). **Every
            screen was imported eagerly**, so opening the dashboard downloaded
            and parsed the Executions drill-down, the registry editors and the
            Ask Bays thread before the Overview could paint.
Fix:        Route-level `React.lazy`, with the new loading mark as the Suspense
            fallback, so a page still arriving and a page still fetching look
            like one wait. **The initial bundle goes from 431 kB to 215 kB —
            121 kB gzipped to 69 kB** — and the rest arrives per page. Overview
            is deliberately not split: it is what the dashboard opens on, and
            splitting it would add a round trip before every first paint.

Verified:   The rig. All fourteen routes opened after the split and every one
            rendered its own heading, with no page errors — the check that
            matters for lazy routes, since a broken chunk fails at navigation
            rather than at build. Open loops: month picker reads
            "Sep 2026 · 8 / Aug 2026 · 14 / All time"; picking Destiny leaves
            the close-rate card **byte-identical** (asserted, not eyeballed);
            the panel's buttons read "Open in Airtable | Close panel | Mark as
            closed | Save"; the statistics grid is nine tiles. Codex's picker
            reads "All time" too. The loading mark was captured by holding the
            data request open, and renders with no white tile behind it.

## 2026-09-16 10:35 — The wash reaches the top, the loop page reorders, Executions goes monthly

Intent:     Destiny's round. The colour wash still was not reaching the top.
            Bigger, more obvious loading pulse, centred properly on a tab
            switch. Open loops: builder tabs above the status filter with the
            month beside them, and the statistics tab cut to five figures.
            Remove the panel's "Mark as closed". And the same monthly treatment
            for Executions.
Files:      src/index.css, src/components/ui/{Loading,MonthPicker}.tsx,
            src/screens/OpenLoops/{index,Metrics,LoopPanel}.tsx,
            src/screens/Executions/index.tsx, server/src/executions.ts,
            server/src/stats.ts, src/data/types.ts, CLAUDE.md

Problem:    **The wash was never going to reach the top, and moving the
            gradients could not fix it.** `.frost-bar` — the 84px header band —
            fills with `--frost-bar`, which was `rgba(245,245,247,0.72)`: 72%
            opaque page grey laid over the wash. Whatever the gradients behind
            it did, the top 84px was three-quarters flat grey.
Fix:        The fill drops to 0.22 (0.24 in dark). The blur and the mask are
            what stop scrolled content reading through the bar; the fill only
            has to take the edge off. Diagnosed this time rather than nudged —
            the last two attempts moved the gradients, which was the wrong
            layer.

Problem:    The loading mark reused Ask Bays' `idle-breath`, a six-second calm
            that says "waiting for you" rather than "working".
Fix:        Its own `loading-pulse`: 1.5s, opacity 0.32 → 1, scale 0.94 → 1.06.
            The mark goes from 28 to 36.
Problem:    On a tab switch it sat under the tab row rather than centred below
            it. `flex-1` does nothing when the parent is not a flex column, and
            a tab body is not always one.
Fix:        `min-h-[55vh]` gives it real height to centre inside whatever it is
            dropped into.

Decision:   Open loops' rows reorder to the Codex page's shape: the all-time
            status strip, the two comparison cards, then **builder tables and
            the month on one row**, then **status and search on the next**.
Decision:   **"Mark as closed" comes off the loop panel entirely.** The Status
            control in the panel already closes a loop, so the button was a
            second way to make the same write — and the ambiguous one. Removing
            it loses nothing: CLAUDE.md §7's "close a loop directly from the
            interface" is the dropdown.
Decision:   The four weekly series come off the statistics tab, as asked, and
            `LoopSeriesTiles` is deleted rather than left unread. Five figures
            would leave a gap in a three-column grid, so a sixth was added:
            **Longest still open**. It is not filler — an average age hides its
            own tail, and the oldest loop still open from a month is the one
            somebody has to go and deal with. Cohort state, aged from Date
            Raised, no new field.

Decision:   **Executions goes to one month at a time** (CLAUDE.md §7 updated).
            The week / month / year control asked a question the tabs already
            answer differently. **The rows are untouched** — one per execution,
            a grain is only a `GROUP BY` — so the arithmetic is the same and the
            other two grains stay reachable by query string. Recorded in
            CLAUDE.md rather than left to drift from it.
Fix:        Six tiles in the same cards the statistics tabs use: executions,
            succeeded, failed, failure rate, average time, **workflows run**.
            The card carrying the period in words is gone, as asked; the change
            against last month is still on every tile that has one.
Fix:        New `weeks` on `ExecutionSystem`: the weeks inside the period in
            view, **tallied from the same day rows as the month's own totals**,
            so a month and the weeks drawn under it cannot disagree. The first
            and last are cut to the month.
Problem:    Weeks that had not started yet were drawn hatched and marked "part",
            which says the days were only partly recorded. They have not
            happened.
Fix:        A week starting after today is not emitted at all.
Problem:    The month picker offered "All time" on Executions, where selecting
            it quietly means "the current month" — a lie in a dropdown.
Fix:        `allowAll` on `MonthPicker`, false there.

Verified:   The rig, with 330 seeded executions across two months on five
            workflows. Open loops reads in the new order; the panel's buttons
            are "Open in Airtable | Close panel | Save"; the statistics grid is
            six tiles. Executions shows the month picker with "Sep 2026 · 144 /
            Aug 2026 · 186" and no All time, six tiles, the weekly chart inside
            September with no future columns, and the per-workflow table under
            it. No page errors on either page.

## 2026-09-16 11:10 — The loop figures reconcile, a calendar year on the chart, and loops gets a resync

Intent:     Destiny's round. The loop page's numbers did not reconcile with its
            own statistics tab. Bars should re-animate on a builder switch. The
            month chart should show a whole calendar year with a year picker and
            a line view. Open loops needs a resync button. Executions: no count
            in the picker. And every entry animation was too abrupt.
Files:      server/src/store.ts, server/src/index.ts, src/data/{types,index}.ts,
            src/index.css, src/components/ui/{Monthly,Charts,Records}.tsx,
            src/components/RecordStatistics.tsx,
            src/screens/OpenLoops/{index,Metrics}.tsx,
            src/screens/Executions/index.tsx

Problem:    **Destiny read 602 open at the top of Open loops and 627 raised in
            August on its statistics tab and could not tell which was wrong.**
            Neither was: the strip was all-time and everything under it was the
            month, so the page carried two answers to one question with nothing
            saying they were different questions.
Fix:        The strip follows the month and the builder, like the rest of the
            page. Its hint now states the identity out loud — "Of the 8 in view.
            Open + in progress + closed = 8" — so it can be checked against the
            builder tabs beside it. Verified on the rig: 3 + 0 + 5 = 8, matching
            the All-tables tab and September's 8 raised.
Decision:   This reverses the all-time strip of earlier today, which was also
            Destiny's call. All-time is not lost: it is "All time" in the month
            picker, which scopes the **whole page** at once rather than one row
            of it. `all_time` on `LoopMetrics` is deleted rather than left
            unread.

Fix:        The two comparison cards and the strip take `owner|month` as their
            replay key, so switching builder re-runs the count-ups and re-grows
            the bars from zero even though the cards' figures do not change —
            which is the point: the page should visibly answer a click.

Problem:    Every entry animation "happened all at once". A cubic ease-out
            spends most of its distance in the first third, so a 720ms count-up
            reads as a snap.
Fix:        Quint ease-out and 1100ms for `CountUp`, 1100ms for the bar widen,
            420ms for `page-in`, and the loading pulse slowed from 1.5s to 2.2s.

Decision:   **The month chart draws a calendar year, twelve columns** (Destiny),
            with a year picker and a bars/line switch on the card's own header.
            A year that starts in August was two columns wide and said nothing
            about the ten months before it. A month the series does not hold
            gets `coverage: 'none'` — no bar, and the line **breaks** rather
            than joining through as though the value were nought.
Problem:    The "recording starts" boundary rule was drawn against the fixed bar
            width while the bars themselves widen to fill the card, so on a
            filled chart it pointed at the wrong month — March, where the data
            starts in August.
Fix:        It uses the computed width, so it lands on the same grid the bars do.
Decision:   The word under each month — "part" and "none" — is gone, as asked.
            With twelve columns drawn that was ten "none" labels of noise. **The
            hatching stays**: it is the only thing keeping a partly-covered
            month from looking like a fully-covered one, which is section 4's
            rule. The legend now carries both meanings instead.

Decision:   **Open loops is the fifth page with a resync**, through the same
            shared pass and the same control. Loops are seven Airtable tables,
            one per builder, and every one is swept; `sweepScope` treats them
            per-table like client questions, so a sweep of one builder's table
            only ever compares against and deletes from rows that came out of
            it. The base is `AIRTABLE_OPEN_LOOPS_BASE_ID` and never a default.

Fix:        The Executions month picker drops the count beside each month: the
            figure it repeated is the first tile on the page.

Not done, and why:
  - **"Unregistered" → "Archived" on Executions.** The tab means "the workflow
    registry has no row for this workflow", which is not the same as "archived
    in n8n" — this server never reads n8n's archived flag, so relabelling it
    would assert something the data does not know. The honest version is to read
    `isArchived` from `GET /api/v1/workflows`, which is a real change to
    `n8n.ts` and wants testing against the live instance. Raised rather than
    renamed.
  - **Removing the hatch entirely.** See the decision above: the word labels
    went, the hatch stays.

Verified:   The rig. Open loops: the strip reconciles (3 + 0 + 5 = 8), the
            resync button sits beside New loop, the year picker offers 2026 and
            2027, the chart draws all twelve months with dotted baselines where
            nothing is recorded, and the line view breaks across the empty
            months rather than running through them. Executions: months listed
            without counts. No page errors on either.

## 2026-09-16 11:35 — Executions draws a year, the registry sheds borrowed figures, and everything slows down again

Intent:     Destiny's round. Animations still too rushed. Counts off every month
            dropdown. Executions: year at the top, a month picker inside the
            page, the calendar-year chart the record pages use, the paragraph of
            caveats gone, count-ups on the figures, and Unregistered renamed.
            Registry: strip the Builders tab of figures that belong to other
            pages, and stop the Tools table scrolling sideways.
Files:      src/index.css, src/components/ui/{Charts,Records,MonthPicker}.tsx,
            src/components/RecordStatistics.tsx, src/screens/Executions/index.tsx,
            src/screens/Registry/index.tsx, src/screens/{Codex,OpenLoops/index}.tsx,
            server/src/executions.ts

Problem:    The entry animations read as "all at once" for the third time, after
            two passes that only lengthened them.
Fix:        The curve was the fault, not the duration. **Every ease-out —
            cubic, quint — front-loads**: it covers most of its distance
            immediately and then crawls, so a longer duration made the crawl
            longer without making the motion legible. `CountUp` now uses a
            smoothstep (`p²(3−2p)`), which starts slow, moves through the middle
            and settles, and the number is readable the whole way up. Durations
            go to 1900ms for the count-up and the bar widen, 700ms for the page
            fade, 620ms for the card fade, 2.8s for the loading pulse.

Fix:        The count beside each month is gone from every dropdown — Open
            loops, Codex, both statistics tabs, Executions — and the `counts`
            prop is deleted rather than left unused. The figure it repeated is
            the headline on the page under it.

Decision:   **Executions is a year, month by month** (Destiny). The year sits in
            the header beside the report buttons; the month is picked inside the
            page, next to the figures it scopes, because that is where the
            choice belongs. The chart is the same calendar-year chart the record
            pages draw — twelve columns, bars or line, no bar and a broken line
            where nothing was recorded — so the dashboard has one chart rather
            than two that drift. `PeriodChart` is deleted; it is in git history.
Fix:        The paragraph of caveats under the chart is gone, as asked. What is
            left of it — when n8n was last read, and how far back this database
            goes — is the line already at the foot of the page.
Fix:        The six figures count up like every other number in the dashboard.
            They were the one place that snapped, and a figure that animates on
            one page and snaps on another reads as two different products.

Decision:   **"Unregistered" is now "Archived"** (Destiny, who checked the
            workflows the tab was holding and found every one archived in n8n).
            **The test behind it is unchanged** and is still "the workflow
            registry has no row for this workflow" — this server reads
            `GET /api/v1/workflows` for names only and never looks at n8n's own
            archived flag. So the label is Destiny's verified reading of what
            lands there today, not something the data knows, and a live
            workflow nobody had registered would land there and be mislabelled.
            Reading `isArchived` and filing on that is the honest version and is
            written down in the code as the next change to make.

Decision:   **Builders loses the open-loop, oldest-loop and entries-this-week
            columns, the notes card and the updated column** (Destiny). Those
            three were figures about Open loops and Codex shown on the one page
            nobody goes to for them. The four figures above the table are now
            about the roster itself — people, with a role, lanes assigned, Slack
            ids — which is the only question this table is the source of an
            answer to, and each goes amber when it is short of the headcount.
Fix:        Tools drops its `updated` column and its minimum width with it, from
            thirteen columns at 1400 to twelve at 1040, so the table stops
            scrolling sideways inside itself on a normal screen.

Not done, and why:
  - **The Tools data** — plans, costs, cycles, renewal dates, who pays, the
    Genie URL, adding AWS and Kaiqi's tools. Two reasons. The Slack connector
    was down for this session, so the Genie URL and Kaiqi's list could not be
    read, and guessing either would put a wrong URL in the one place that is
    the system of record for it. And **every cell on that page is editable** —
    Destiny found this mid-message — so these are one-line edits he can make
    faster than I can verify them. Offered rather than guessed.
  - **The builder emails and Jason's lane.** Same reason: the local part of each
    address is not something this repo knows, and a guessed address in the
    roster is worse than an empty cell that says so.
  - **"The button next to the export CSV."** The statistics card carries the
    Compare picker and Export CSV and nothing else, and removing the picker
    would leave the tab with no way to choose its month. Asked rather than
    deleted.

Verified:   The rig. Executions: tabs read "All systems / Bays / North Star /
            Research Twin / Archived", the year picker offers 2026, the in-page
            month picker offers Sep and Aug with no counts, the chart draws all
            twelve months in bars and in line. Registry: the Builders table is
            down to name, role, lanes owned, slack id, email. Open loops and
            Codex dropdowns carry no counts. No page errors on any of them.

## 2026-09-16 13:10 — Build patterns and Commercial become one page shape
Intent:     Destiny: "for the build patterns and the commercial opportunities
            both of them are basically the same page right they are going to
            have the exact same look." Header strip, two cards each (reusability
            + created per week; confidence + created per week), media readiness
            and the open-question trend moved to Statistics, the media-readiness
            segmented bar removed, a month dropdown beside each search box, the
            keyword bar added to Commercial, and Commercial's table stopped
            scrolling sideways.
Files:      src/data/types.ts, server/src/sources.ts, server/src/store.ts,
            src/screens/BuildPatterns.tsx, src/screens/Commercial.tsx, CLAUDE.md
Problem:    Three things the page could not do yet.
            1. `patternMetrics()` and `commercialMetrics()` took no month, so a
               month picker beside the search box would have left the strip and
               the cards answering all time while the list answered one month —
               the same reconciliation bug the loops page had on 15 Sep, where
               "602 open" sat above "627 raised in August".
            2. Commercial had no `created_per_week` series at all and no
               keywords: `Opportunity` carries no keyword field, and `bha_system`
               on that table is prose — "vFarm (digital twin), RAG archive
               (intelligence layer), Swagger-documented API" — so splitting it on
               spaces yields "documented" and "layer".
            3. The Commercial table measured 1158px inside a 1136px card at
               1440px wide, so it scrolled sideways where no other record table
               did. The `width` props are `maxWidth`, not minimums, so narrowing
               card id 28ch→24ch and card 58ch→48ch changed nothing at all:
               re-measured at exactly 1158/1136 again. The floor was the header
               row's own min-content, and the two widest headers were the
               offenders at 120px and 114px.
Fix:        1. Both metrics take `month`, cache per month (`patterns:2026-09`),
               and scope every figure over the same set the list shows.
               `created_per_week` follows: `weeksIn(month)` where a month is
               chosen, `lastWeeks(8)` for all time, with the note saying which.
               Added `scope.month` so the strip's hint can read "created in this
               month" rather than "rows in the table".
            2. Read Commercial's real `lane_id` values off the live base rather
               than assuming: `LANE-VFARM-ZONE_MONITORING_SAAS` — the same shape
               as a pattern id minus the sequence number. `laneKeywords()` gives
               zone, monitoring, saas. The VFARM segment is dropped because it is
               on every card and would group nothing, the same rule `classify()`
               already applied to BP-.
            3. Headed the two columns `media` and `questions`. Re-measured:
               1136/1136 at 1440, 1416/1416 at 1720. At 1280 it still scrolls,
               and so does Open loops (1115/976) — that is the existing floor for
               a dense table, not a Commercial fault.
Decision:   Both pages open on the current month, not all time, matching Codex
            and Open loops; "All time" stays as the last option in the picker.
            The media-readiness bar came off because it read All / high / medium
            / low / not set beside a confidence bar reading the same five words.
            Media readiness stays a sortable column — it is still the second half
            of the list's default order — and becomes a statistics tile.
            `unresolved_trend` is deliberately the one figure on that tab not
            scoped to the month: it is this dashboard's own observation of the
            whole corpus at each resync, and cutting a record of when something
            was written down to the month the cards were created in would be two
            questions in one chart.
            Commercial's keyword bar starts at two occurrences where Build
            patterns starts at three, because it holds 21 rows to the other's 152.
Verified:   Postgres + real server + Playwright at 1280/1440/1720.
            patterns months: Sep 2026 / Aug 2026 / All time; 5 rows in Sep,
            15 all time. commercial: same picker, 4 rows in Sep, 12 all time,
            segmented "All confidence 4 / high 1 / medium 3", keywords "ledger 2",
            statistics grid reads Every month held · Month in view · Media
            readiness · Open research questions over time · Cards written ·
            Nothing outstanding · Open research questions · Reached Media-Ready.
            No page errors. Caught on screenshot and fixed: the Created per week
            card printed its note twice, once from `MetricCard note` and once
            from `SeriesBlock`.

## 2026-09-16 13:55 — Percentages and durations count up; the roster and the spend card
Intent:     Destiny: "it's only the numbers that are doing the counting
            animation for percentages and for seconds time, right? It should
            also do the same animation across all the tables, all the workflows,
            all the pages." Plus the roster emails he had asked for and I had not
            written, and "for the total monthly spend it seems you did not put in
            the figures I told you to put... I added the $60 for the Anything
            Cloud, however it did not update."
Files:      src/components/ui/CountUp.tsx (new), src/components/ui/Records.tsx,
            src/components/ui/Charts.tsx, src/components/ui/index.ts,
            src/components/RecordStatistics.tsx, src/screens/Executions/index.tsx,
            server/src/migrations.ts, server/src/registrySeed.ts,
            server/src/registry.ts, src/data/types.ts,
            src/screens/Registry/index.tsx
Problem:    `CountUp` did `Math.round` inside the animation loop, so it could only
            ever emit whole numbers. Every rate and every duration on the page
            snapped into place beside counts that ran, on the same row of tiles.
            The count-up also lived in `Records.tsx`, which imports `Charts.tsx`,
            so a bar's own figure could not use it without a cycle — which is why
            an HBar grew from nought over 1900ms with a number that was already
            at its final value.
            The roster emails were never written anywhere: `seedRegistry` inserts
            `ON CONFLICT (id) DO NOTHING`, so editing `registrySeed.ts` reaches a
            fresh database and no other, and every live one already holds the
            seven rows.
            The spend total was not broken. Reproduced against the rig: PATCH
            cost_amount 60 onto Render, re-read /api/registry, and the answer came
            back `priced: 1, not_monthly: 1, totals: []` — correct, because a cost
            with no billing cycle cannot be part of a monthly figure. What was
            broken was the page, which said "No active service has a cost against
            it yet" while one did, and "3 are one-off or have no billing cycle"
            without saying which three.
Fix:        Split the animation into `useCountUp`, returning the raw number, in
            its own module both Records and Charts can import. `CountUp` rounds
            it; the new `CountUpText` runs it through a formatter, so a rate
            counts up through 3.4%, 12.8%, 36.2%, 59.7% and a duration through
            20 min, 1.3 hours, 3.6 hours, 6 hours. Wired into the statistics
            tiles (replayKey is the month, so the whole grid re-runs on a month
            change), the Executions failure rate and average time, the five
            figures inside a workflow panel, every HBar's own number, and the
            percentage in the middle of a Ring.
            Made `fmt` round on every branch, because it now also draws frames:
            without it a rate read 12.38741952% for a second and a half. A value
            that arrives already rounded comes back unchanged, so the figure that
            lands is the figure it would have printed anyway.
            Migration 12 writes the seven work addresses, `WHERE email IS NULL`
            on six so an edit made in the interface is never overwritten, and
            from the exact seeded gmail on Destiny's. It also sets Jason's lanes
            to CEO and Ahad's role to CS Twin, each guarded on the exact seeded
            value. The seed carries the same values for a fresh database.
            `spendOf` now returns `not_monthly_ids`, the card names those
            services and says what to do, the cycle cell on such a row goes amber,
            and the empty state has two sentences rather than one — "no service
            carries a cost" and "costs exist, none has a cycle" are different
            facts.
Decision:   Destiny named four addresses — ahad@, destiny@, jason@, jegan@ — and
            asked for "everybody's bhanetwork.org emails". The other three follow
            the same convention and are the ones to check first if one bounces;
            they are in the migration, in one place, rather than guessed at
            row by row.
            A cost with no cycle stays out of the monthly total. It is the
            honest answer and the page now says so by name instead of leaving a
            reader to conclude the total is broken.
Verified:   Sampled the codex statistics grid at 250/500/900/1400/2600ms and it
            reads 0 → 1 → 4 → 7 → 9, 3.4% → 12.8% → 36.2% → 59.7% → 75.9%,
            20 min → 1.3 hours → 3.6 hours → 6 hours → 7.6 hours. Registry after
            migration 12: seven people, every one with a bhanetwork.org address,
            Jason CEO, Ahad CS Twin. Spend card names Render as priced and not
            counted. No page errors.

## 2026-09-16 14:30 — Two downloads on Executions; Media Twin, Genie and Engine health
Intent:     Destiny: the top download "should be formatted in a way that it
            downloads the entire yearly report", and on Every month held, "after
            bars and line, you should add a download button... a dropdown where
            you get to select the particular month... if you are on the all
            systems page it downloads for all systems, if you are on the Bays tab
            it downloads only Bays." Plus: "for the systems side, please add
            Media Twin and Genie... give them the same coming soon screen that
            vFarm has. Engine health should also have that coming soon."
Files:      src/screens/Executions/index.tsx, src/components/Layout.tsx,
            src/App.tsx, src/screens/MediaTwin/index.tsx (new),
            src/screens/Genie/index.tsx (new), src/screens/EngineHealth/index.tsx,
            src/screens/Overview.tsx, server/src/engine.ts, CLAUDE.md
Problem:    The top button built its report from `data` and `system` — the props
            already on screen — which is one month. A year needs the year's rows.
            Building it client-side from the twelve months on the chart would have
            been a second arithmetic that could disagree with the server's.
Fix:        `downloadPeriod(grain, period, systemKey)` re-reads the period from
            the server and builds the report from that. The server already
            answers all three grains over the same one-row-per-execution table —
            a grain is a GROUP BY — so a year cannot disagree with its months.
            The system is carried by key, never by index: tabs differ between
            periods, because a system that ran nothing in a month has no tab in
            it, and an index would have handed back somebody else's report. A
            system with no tab in the requested period says so rather than
            downloading the wrong file.
            `MonthDownload` is the menu: a button on the chart card, closing on
            outside click and on Escape, one row per month of the year on screen.
            Media Twin and Genie are two new placeholder screens, the same shape
            as vFarm, with sidebar entries, routes and an Overview tile each
            (one tile per sidebar section is the rule). Engine health becomes the
            same thing.
Decision:   Engine health loses the execution roll-up it gained on 15 Sep. It was
            real, but it drew counts the Executions page already draws with the
            month, the year, the per-workflow breakdown and the failing ids
            behind them. Two drawings of the same counts drift and the one
            somebody opens first becomes the one they trust — which is the
            reasoning that kept the per-workflow detail off it in the first
            place, followed the rest of the way. The workflows-in-no-system card
            went with it; those workflows are the Archived tab on Executions,
            where they are counted rather than only listed. CLAUDE.md §7 is
            updated; the code is in git history rather than commented out.
Verified:   Playwright, with downloads captured. Top button reads
            "Download 2026 report" and yields executions-all-systems-2026.csv
            opening "All systems, by year / period,2026,2026-01-01,2026-12-31".
            The month menu lists Sep 2026 / Aug 2026 and yields
            executions-all-systems-2026-08.csv opening "All systems, by month /
            period,Aug,2026-08-01,2026-08-31". Switching to the Archived tab and
            downloading gives executions-archived-2026.csv. Sidebar reads Home /
            Ask Bays / North Star / Research Twin / Media Twin / Genie / vFarm /
            Engine health / ... and all three placeholder pages render their
            sentence. No page errors.

## 2026-09-16 15:05 — The Tools registry data, and two labels that said nothing
Intent:     Destiny, carried over from 15 Sep: "remove cluster from the BHARAG",
            "Genie, this URL needs to be updated if you check Slack", "you need
            to add AWS", "Airtable, the plan is free... Google Workspace, free
            plan, OpenRouter is pay as you go", "currency for all of them is in
            dollars", "who pays, just put BHA". And from today: "for the
            endpoints you have something called digest that never arrived, I
            don't know what that tab is supposed to mean" and "Engine writes —
            what is kinds receiving writes?"
Files:      server/src/migrations.ts, server/src/registrySeed.ts,
            src/screens/Registry/index.tsx
Problem:    Genie's URL. The seed carried https://genie-v3-migration.onrender.com
            with a note already saying no live Render service reports that host.
            Slack settles it: "genie-v3-migration.onrender.com never resolved;
            the DNS failure surfaced as network_timeout and read as a transient
            outage", "ruled out ... as either live Genie service after checking
            the Render API directly", and "Kaiqi confirmed the canonical Genie
            deployment (genie-v3-migration-u82u) before the builder repointed
            ask_genie". Two independent sources agree, so it is a correction
            rather than a guess.
Fix:        Migration 13, guarded on the exact seeded value on every statement so
            an edit made in the interface survives: BHARAG loses "cluster", the
            Genie service row and the ep-genie-messages endpoint both move to
            genie-v3-migration-u82u.onrender.com, Airtable and Google Workspace
            get Free, OpenRouter Pay as you go, AWS is inserted, and every row
            with no currency or no billing owner gets USD and BHA. The seed
            carries the same values for a fresh database, with USD and BHA now
            the default in `S()`.
            "Kinds receiving writes" became "Record tables n8n writes to", which
            is what it counts — mirror rows whose source is not the migration
            backfill — and its hint now says what a shortfall means rather than
            only "of 6". "Digests that never arrived" became "Open Loops digests
            that never reached Slack", and the note explains the hop it measures:
            the 08:00 digest is handed to North Star, which posts it to each
            builder, and the Callback Receiver confirms it landed.
Decision:   AWS goes in with no cost and no billing cycle. Destiny said it is in
            use, not what it costs, and a figure nobody supplied is exactly what
            section 2 forbids — it counts as unpriced on the spend card, which
            says so. The $60 is not written here either: he entered it himself,
            and what it was missing was a billing cycle, which the card now names.
Verified:   Migration 13 applied on boot; /api/registry reads AWS / Airtable Free
            / BHARAG / Genie v3 at genie-v3-migration-u82u.onrender.com / Google
            Workspace Free / Onshape / OpenRouter Pay as you go / Otter.ai /
            Render / Slack / n8n Cloud Pro, every one USD and paid by BHA, and
            the Genie endpoint row moved with it. Caught on the rendered page and
            fixed: the new spend sentence had lost its negation and read "1
            service carries a cost, but it has a billing cycle".

## 2026-09-16 16:10 — 80% by default, a sidebar that shows everything, and the twins get statistics tabs
Intent:     Destiny: "I've been using my laptop on 80% zoom and the screen looks
            phenomenal — is there a way we can set it as a default"; "for the
            sidebar I would really love it if this sidebar is not scrollable,
            everything just shows as it's loaded"; the month dropdown belongs
            "on the left hand side of the search bar" on Build patterns and
            Commercial; "for the patterns page, can you give it a similar
            looking UI" to the other record pages; on North Star "all those
            things should move into the statistics, let's also have that monthly
            select next to the search bar"; on Research Twin the same, keeping
            only confidence (on the left) and cards created per week, and "the
            research queue holds 212 rows across 36 distinct — let's remove that
            write-up"; and "add a resync from Airtable at the top of research
            twin page, North Star page."
Files:      src/app/zoom.tsx (new), src/main.tsx, src/screens/Settings.tsx,
            src/index.css, src/components/Layout.tsx, src/screens/NorthStar.tsx,
            src/screens/ResearchTwin.tsx, src/screens/BuildPatterns.tsx,
            src/screens/Commercial.tsx, src/data/types.ts, src/data/index.ts,
            server/src/store.ts, server/src/sources.ts, server/src/index.ts,
            .env.example, render.yaml, CLAUDE.md
Problem:    Three real ones, none of them where I expected.
            1. The North Star strip read "Asks 18" above a list of 6 as soon as
               the month picker went on, and Research Twin the same. The page
               was passing `month` and the server was ignoring it: `metrics()`
               dispatched `case 'ns': return nsMetrics()` with no argument, so
               the filter never arrived. That is the exact reconciliation fault
               the loops page had on 15 Sep ("602 open" over "627 raised in
               August"), reintroduced by adding a picker to a kind whose metrics
               took no month.
            2. `Systems covered` read 0 with every one of fifteen rows filed
               under none. `classify()` matched `^BP-([A-Z0-9]+)-\d+-(.+)$`,
               which requires a slug after the sequence number, so an ordinary
               id like `BP-BHARAG-114` matched nothing at all — not even its
               system, which is the second segment and needs nothing else to be
               read.
            3. `Segmented` is `<T extends string>`, so a zoom choice typed as
               `0.75 | 0.8 | 0.9 | 1` would not compile against it:
               "Type 'number' does not satisfy the constraint 'string'."
Fix:        1. `nsMetrics(month)` and `rtMetrics(month)` scope and cache per
               month, and the dispatcher passes `filter.month` through. Research
               Twin scopes cards by `created_at` and then keeps the attempts
               belonging to those cards, because the strip prints "cards" and
               "attempt rows" side by side and they have to count the same set;
               an attempt with no `card_id` belongs to no card and is left out
               rather than matched against a null. Verified against the rig:
               ns 18→6 rows, 15→5 classified; rt 10→4 cards, 15→6 rows.
            2. `^BP-([A-Z0-9]+)-\d+(?:-(.+))?$`. The system comes off the second
               segment either way; the slug is only what the keywords come from.
            3. `ZoomChoice` is `'75' | '80' | '90' | '100'` — the percentage as
               the control shows it, converted where it is applied, so there is
               one representation rather than two to keep in step.
            The zoom itself is `document.documentElement.style.zoom`, not a
            transform: `zoom` reflows, so the page genuinely gets more CSS
            pixels and the breakpoints, the sticky header and the tables behave
            as they would on a bigger screen. 100% is written as the empty
            string so the property comes off entirely.
            Sidebar: nav rows 38px→32px, radius 12→10, font 13.5→13, group gap
            mt-5→mt-3, item gap 2px→1px, header a little tighter. Measured at
            1440×1000, ×860 and ×760: does not scroll at any of them, fifteen
            items each time.
            North Star and Research Twin: the cards split out into `NsStatTiles`
            and `RtStatTiles`, passed to `RecordStatistics` as `extraTiles`, with
            the two bespoke ring cards rebuilt as `MetricCard`s so the grid reads
            as one set. Both pages gained a month picker left of the search box,
            month-scoped filter counts, and a resync button.
            Build patterns: a fourth strip figure (systems covered) and a system
            column, and the two widest columns brought in, so the table is tight
            like Commercial's rather than stretched across five.
Decision:   **The resync widens what the Airtable token must read**, from five
            bases to seven. Nothing is written to the two new ones, so they get
            no base variable — this server cannot write to a guess about them —
            and .env.example, render.yaml and CLAUDE.md all name them. Without
            read access the resync refuses and names the table; it never reads a
            refusal as an emptied table.
            80% is the default rather than an opt-in, because Destiny asked for
            it to be what loads. The Settings note says it multiplies with the
            browser's zoom, which is the one thing that surprises people.
            The sidebar keeps `overflow-y-auto` underneath the new sizing. It
            will not scroll on any realistic screen, and if the list ever
            outgrows the shortest one, degrading to a scroll beats clipping an
            item out of sight.
Verified:   Every page at 1440×900: no sidebar scroll, no body sideways scroll,
            and no table sideways scroll anywhere — at 80% the layout has 1800
            CSS pixels, so even Commercial and Open loops fit. `POST /api/ns/resync`
            and `/api/rt/resync` both answer and refuse cleanly with no token
            ("AIRTABLE_TOKEN is not set on this server, so nothing was read and
            nothing was changed"). Build patterns headers read pattern id /
            pattern / reusability / system / created / source. No page errors.

## 2026-09-16 16:55 — The week charts go back to Asks, and every statistics tile is one shape
Intent:     Destiny: "move asks per week and outcome over time back to the asks
            page on the North Star, they are supposed to be underneath the bar
            that has thin rate, asks, classified, research required and last
            ask"; "the text for that bar — the number of words, the characters —
            should be uniform across every section in there"; and "I want every
            grid, all the different cards, to have the same format and style as
            the asks 59, thin rate 100%, research required and citation
            coverage — styling that shows the number, the percentage. Do it like
            that for the North Star statistics and the research twin statistics."
Files:      src/components/ui/CountUp.tsx, src/components/ui/Records.tsx,
            src/screens/NorthStar.tsx, src/screens/ResearchTwin.tsx,
            server/src/store.ts, CLAUDE.md
Fix:        `TileFigure` — the exact shape `StatTile` draws, pulled out into the
            shared module: a 30px figure, a quiet line under it, and the detail
            it summarises beneath. Every tile on both twins' statistics grids
            now leads with one, so a grid is one kind of card rather than a
            computed figure beside a stack of bars.
            The headline on each is derived from what that card already shows:
            classified share, answered share, the share of tool hits that ended
            up cited, the share of asks citing something, the lane count; and on
            Research Twin the hard-stop share, the largest status, the share
            ever stuck, the share at the attempt cap and the share naming a gap.
            Asks per week and outcome over time moved into `NsWeeklyPanel` on
            the Asks tab, under the strip, which leaves the statistics grid at
            exactly nine cards — a 3×3, measured on the rendered page.
            The five strip hints were rewritten to 81–108 characters each and
            `MetricCell` gained `noteMinLines`, the counterpart of `CountCell`'s
            `hintMinLines`, so the boxes are level as well as the sentences.
Problem:    Two things the rig caught that a typecheck could not.
            1. "Queue depth by status" headlined the resolved share, hardcoding
               `status === 'resolved'`. The seeded queue's cards are all
               `answered`, so the tile read **0%** above its own bar saying
               **100%**. Naming a status in this code is asserting which one is
               terminal, and that vocabulary is Airtable's to change.
            2. Two cards on the North Star grid were both titled "Citation
               coverage" — the moved bucket distribution and the computed
               monthly figure — showing different numbers under one name.
            Plus two agreement bugs in the new hints: "1 rows carry no outcome",
            and then "1 of 6 ask carries", where I had made the noun agree with
            the numerator instead of the total.
Decision:   The status headline is the **largest** group, with the line under it
            naming which. It is derived from the bars underneath and cannot
            disagree with them, whatever the queue calls its states.
            The moved distribution is **Coverage mix**, beside Outcome mix; the
            computed one keeps Citation coverage. Two figures under one title is
            worse than either.
Verified:   Rendered grids read 9 cards in 3 columns on North Star and 8 in 3 on
            Research Twin, every one carrying a figure except Citation coverage,
            which correctly prints "No ask records a coverage figure" because the
            rig's rows have none. Strip hints measure 108 / 81 / 85 / 98
            characters plus the last-ask note. Full sweep of all sixteen pages:
            no sidebar scroll, no body sideways scroll, no table sideways
            scroll, no page errors.

## 2026-09-17 13:05 — The Clients page reads Client Requests
Intent:     Destiny: "update the clients page so it reads the new data in the
            client research base on Airtable."
Files:      server/src/sources.ts, server/src/mirror.ts,
            server/src/migrations.ts, server/src/store.ts, server/src/engine.ts,
            src/data/types.ts, src/screens/Clients.tsx, CLAUDE.md
Problem:    Not a fault — a table that did not exist yesterday. Read the live
            base rather than guessing what had changed: `Client Requests`
            (`tblhu29KejAPQfSuy`), created 17 Sep 2026 for
            LOOP-1789590960971-EHF9, four rows, all Client 2's CRE vFarm + Kiosk
            lane. Its own description carries the rule: "Tracks request status so
            interest is never mistaken for a commitment: a request stays
            Requested/Under Review until every Open Check is cleared. Not read by
            the weekly Research Loop."
            The second lane on that client — Client2_VFarmKiosk_Questions, added
            to the index on 10 Sep — already flowed through, because the page
            reads each lane's table off the index row's `Table ID` and has since
            that map was removed from the pipeline.
Fix:        A mirror kind and a table like every other: migration 14 creates
            `engine_client_requests`, `mapClientRequest` reads Airtable's own
            field names, and the select vocabularies (`REQUEST_STATUSES`,
            `REQUEST_CATEGORIES`, `OPEN_CHECKS`) were read off the live schema on
            17 Sep, not assumed. `Open Checks` is a multipleSelects, so it maps to
            a string array and an empty one means nothing outstanding — which is
            a different fact from a missing field, and why it is never null.
            The clients resync sweeps it as a fixed source beside the index: it
            is one shared table for every client, not one per lane, so unlike a
            questions table it is queued up front rather than learned from a row.
            `lane_id` is promoted off the row itself, because a request names its
            own lane where a question is told which lane by the table it came out
            of.
            A third tab on the page, grouped under the client that asked, with
            the open checks as their own column and a line above the table
            stating the rule in Airtable's words. Four figures: requests, not yet
            a commitment, open checks owed, clients asking.
Decision:   **A status this code does not know counts as open.** `requestIsOpen`
            names Confirmed, Delivered and Declined literally and treats
            everything else as still interest, on the server and on the page in
            the same words. The unsafe direction is the other one: a status
            nobody planned for reading as a commitment.
            **A request whose client id matches no index row still appears**, in
            a lane-less group of its own, rather than being dropped for arriving
            before the index caught up.
            The Requests tab gets its own freshness line. It reads a different
            table from the lanes, and the two happen to hold four rows each
            today, which is exactly the coincidence that would hide the bug.
Verified:   Migration 14 applied on boot. Seeded the rig with the four real
            request rows and the four real index rows read from the live base, so
            the page was checked against what it will actually see:
            /api/clients returns 4 lanes and 4 requests, grouped Client 2
            (2 lanes, 4 requests, 4 open) / Client 9 / Client 12, ordered 2, 9,
            12. The tab reads Requests 4 · Not yet a commitment 4 · Open checks
            14 · Clients asking 1, the filters count 4 / 4 / 4, and the table
            does not scroll sideways (1496/1496). Full sweep of all sixteen
            pages: no page errors, no sideways scroll, no sidebar scroll.
Not tested: the resync against the live table, because the rig holds no
            AIRTABLE_TOKEN. The route refuses cleanly without one; the first real
            run needs the token to have read on this base, which it already does
            for the index and the questions tables.

## 2026-09-17 21:05 — The twins are rewired onto their own ledgers
Intent:     Point North Star and Research Twin at the Airtable ledgers both twins
            started writing to today, build the ingest endpoints n8n is already
            posting to, and stop reading the five `[LEGACY]` tables. The orange
            "none written since the migration backfill on 13 Sep 2026" line on
            both pages was correct and the fix was to give it something live to
            report, not to silence it.
Files:      server/src/sources.ts, mirror.ts, migrations.ts, store.ts, stats.ts,
            engine.ts, index.ts, registrySeed.ts
            src/data/types.ts, src/data/index.ts
            src/components/ui/Figures.tsx (new), src/components/ui/index.ts
            src/screens/NorthStar.tsx, src/screens/ResearchTwin.tsx,
            src/screens/Overview.tsx
            CLAUDE.md, README.md, .env.example, render.yaml

Problem:    **Two of the three field lists in the brief disagreed with the live
            bases, and the live bases win.** Read from Airtable rather than from
            the brief, on the habit CLAUDE.md section 4 sets:
              - `Delivered` is **Delivered · Not delivered · No target**, plus
                **Self-delivered** on Research Twin. The brief said the fourth
                value was "Failed". A vocabulary invented here would have filed
                every real undelivered row under a name Airtable never writes,
                and the delivery rate — the one coloured figure on North Star —
                would have read 100% while answers were being refused.
              - Research Twin's `Ask Type` carries an **External web search**
                option the brief did not list, and `Asked By System` carries
                Commercial Extractor and Weekly Clock. `Opened By` on a job is
                Person, not "Destiny", and there is no "Weekly Sweep".

Problem:    `Evidence Used` is written in **two different formats**, and I had
            to read the agents' own tail nodes in n8n to find out rather than
            assume one. North Star writes
            `- <tool> -> 12 row(s), cited 3 time(s) | args: {…}`; Research Twin
            writes `- <tool> | args: {…}` and then `  -> <observation>` on a
            second line, **with no counts at all**.
Fix:        One parser that reads both. Research Twin's rows carry
            `hits: null, cited: null` — **never nought**, because nought reads as
            "called and came back with nothing", which is a different and much
            worse fact than "not recorded". The ask view says so in words, and
            the tool-usage tile shows its calls and leaves the other two blank.

Problem:    Running the two real line formats through that parser caught two
            bugs before they shipped, both of which would have looked like data
            rather than like code:
              1. Research Twin's continuation line `  -> Found 6 results…` was
                 being stored as a tool named `> Found 6 results…`. `->` starts
                 with a hyphen, so it matched the bullet pattern. Every RT ask
                 would have reported twice as many tool calls as it made.
              2. North Star's `| args:` sits **after** the counts, and the parser
                 cut the line at the counts before reading the args, so every
                 North Star tool call lost its arguments.
Fix:        Skip a continuation line before the bullet match; read the args out
            first, then the counts. This is exactly the failure mode the
            `fields[]=""` note in CLAUDE.md records — a stand-in that shares the
            assumption passes every test — which is why the formats were read out
            of n8n rather than guessed at.

Problem:    Three figures on the old North Star page — thin rate at 100%,
            classified at 42%, unclassified at 58% — were artefacts of `outcome`
            being added late to the legacy table.
Decision:   **Not carried across, and there is no unclassified bucket.** Every
            row in the new ledger carries an outcome. Thin is a slice of the
            outcome mix now, and the headline is the **delivery rate**: North
            Star once ran green for six consecutive days while Slack rejected
            every post, and delivery is the only field recorded *after* the
            answer is sent. It is the one coloured figure on the page.

Decision:   **Needs human and the external-search rate are never coloured.**
            Escalating correctly beats a confident wrong answer, and a month of
            genuinely internal questions is a real month. Capped jobs and BHARAG
            degraded are coloured, because those are genuinely bad in one
            direction. Colour only where the direction is news.

Decision:   **A job is one row.** `Research Jobs` carries its own status,
            attempts and outcome, so nothing collapses on `card_id` any more and
            none of the one-row-per-attempt language survives. `Attempts` is a
            number on the job, capped at three. Three tabs on Research Twin now:
            Asks · Jobs · Statistics.

Decision:   **Research Twin's resync sweeps two tables.** A job is updated in
            place as it is worked and the agent only mirrors on an ask write, so
            a queue kept current by ask mirrors alone would show every job at the
            state it was in when it was opened. `/api/engine/rt-jobs` exists for
            when n8n is pointed at it; the button is what keeps the queue current
            today. The Jobs tab therefore carries **its own freshness line** —
            one age above both would be quietly wrong about whichever was not
            written last.

Decision:   **A handoff direction is only asserted where the row states one.**
            The first cut labelled every linked ask with an arrow. But
            `Asked By System` naming the other twin says who asked whom;
            `Linked Twin Ask` on its own says the two rows are one exchange and
            nothing about which end started it. Caught on the rig: a North Star
            row asked from Slack and carrying `Linked Twin Ask` was being drawn
            as `rt→ns`, which is the opposite of what happened. Those read
            "linked" now. The known gap — the front doors do not yet pass
            `Linked Twin Ask` through — is in the footnote, and the count reads
            slightly high through its fallbacks rather than silently low.

Problem:    Two statistics cards I had written rendered a **count** with a
            per-cent sign: "Gap types" showed `1%` for one job, and "Confidence
            mix" showed `1%` for one High-confidence-no-sources ask. `DistTile`
            hardcoded a percent formatter.
Fix:        `DistTile` takes a `format`; those two pass a count formatter.
            Confidence mix now renders nought as `0` rather than falling through
            to an empty state — "none of these" and "nothing recorded" are
            different statements.

Decision:   The five `[LEGACY]` tables are **read by nothing**, and
            `engine_ns_records` and `engine_rt_attempts` keep their rows, unread,
            like the `records` read model. Nothing drops a table. All five stay
            in the System Registry's bases list, marked `[LEGACY]` with what
            replaced them: a base that vanished from the registry would read as
            one that was never there.

Decision:   **The Overview's two twin tiles and its asks figure read the
            ledgers.** They were the last fixtures on that page computing a
            number about a section that now holds real rows, which is the
            disagreement section 2 forbids. The tiles' signals are each page's
            own failure metric — an answer that reached nobody, a job waiting on
            a person — and twin-to-twin handoffs sits in the "This week" card.

Verified:   Against a local Postgres 16 and a stub that **refuses exactly what
            Airtable refuses** (`fields[]=` with no field named → 422
            `Unknown field name: ""`), because a stub implementing the assumption
            is how the last round of tests all passed against a shared bug.
            - Migration 15 applied on boot: 15 migrations, three new tables.
            - `POST /api/engine/ns-asks` inserted, then re-sent the identical
              payload and reported `unchanged` — the upsert is idempotent, so
              n8n retrying is safe.
            - `POST /api/engine/rt-asks`, `POST /api/engine/rt-jobs` the same,
              and a second post to the same job **updated it in place**
              (In Progress → Resolved) rather than duplicating.
            - `POST /api/engine/ns` now 404s naming the kinds that exist, and an
              unauthenticated post is 401 before the router reads the body.
            - Both resyncs against the stub: North Star +1 inserted / 1 updated /
              1 deleted over one table; Research Twin 2 updated / 2 deleted over
              **two** tables (asks and jobs), with the job's status changing in
              place and `days_to_resolve` landing at 15.
            - Killed the stub mid-flight and re-ran: `ran: false`, `deleted: 0`,
              both tables named as unread with what Airtable said, and every row
              still held. **A table that could not be read is never an emptied
              table.**
            - Every figure over a month with no rows: `pct: null` with a sentence
              ("No ask is held for this month"), never 0%. Every rate carries its
              denominator; every duration is p50/p95.
            - A sparse month reads as one: two asks report "1 of 2", not a trend.
Not tested: the resyncs against the live Airtable bases, because the rig holds no
            real `AIRTABLE_TOKEN`. **The token needs read added on
            `appRvx4u9V9BYp646` and `appv39nQzmfC9VVkG` before either button will
            work** — it was scoped to the two legacy bases, and a token that is
            not re-scoped authenticates and then refuses, which is the same
            failure the submissions base had on 14 Sep. The resync names the
            table rather than reading the refusal as an emptied one, so the
            failure is legible, but it is a failure until the grant is widened.
            Also untested with real rows: both ledgers are empty today, by
            design, so every figure was exercised against rows posted through the
            live ingest endpoints rather than against production data.

## 2026-09-17 22:10 — Engine health, built from scratch
Intent:     Build the page that says whether the engine is working right now —
            what broke, whether it healed itself, and what is waiting on a
            person. Nothing existed: the route served a single "coming soon"
            card, and the three sources it needed had all been written for days
            and never read.
Files:      server/src/bharag.ts (new), server/src/health.ts (new),
            server/src/sources.ts, mirror.ts, migrations.ts, store.ts,
            engine.ts, index.ts
            src/data/types.ts, src/data/index.ts
            src/screens/EngineHealth/{index,LaneView,Retries,parts}.tsx
            src/screens/Overview.tsx (its tile is real now)
            CLAUDE.md, README.md, .env.example, render.yaml

Decision:   **The page is built around one distinction: no incidents and no
            reporting look identical from the outside, and only one of them is
            good news.** Each lane needs its own BHARAG credential, so an
            unkeyed or refused lane is a real and common state rather than an
            edge case. Three sentences, never one: a lane with no key was never
            asked; a lane that refused was asked and said no; a lane that
            answered with nothing is the only one that is health. Every tab
            leads with which lanes answered and every figure over an unread lane
            carries that in its own note.

Problem:    Rendered the page and the "By lane" card drew **a full-width amber
            bar for Research Twin — a lane with no credential that had never
            been read**. The bar is scaled to the largest lane, so whatever
            count happened to be held for an unread lane read as the worst lane
            on the page. Precisely the failure the whole page exists to prevent,
            in the one card meant to make it visible.
Fix:        A lane that was not read gets no bar at all — its row is the reason
            it was not read. A bar is a measured value and there was no
            measurement.

Problem:    `first_seen_at` preferred the mirror row's insert time over the
            incident's own `created_at`, so every incident read in one pass
            landed in the week somebody pressed Resync. The weekly chart drew
            one tall bar on the day of the import and time-to-resolve was
            measured from the wrong end.
Fix:        The ledger's `created_at` wins; the insert time is the fallback for
            a row carrying no date of its own. Caught by reading the table on
            screen and noticing a 14 Sep incident dated today.

Problem:    **Markdown was rendering literally on screen** — `**like this**` and
            backticked field names — across Engine health *and* both twins'
            pages, which have been live since this morning. The notes are
            written on the server and drawn as plain text; the emphasis was
            never going to render.
Fix:        Stripped from every user-visible string in health.ts, store.ts and
            stats.ts, leaving the comments alone. 28 lines. Mine from this
            morning as well as today's.

Problem:    "Needing a person" summed exhausted retries and non-retryable open
            incidents while its own footnote said an incident in both is counted
            once. The footnote was the lie.
Fix:        A union on the incident id, which is what the sentence claims.

Decision:   **`retries_attempted` from the incident payload is displayed
            nowhere**, as asked. The healer does not maintain it — attempts live
            in `retry_attempts` — so it is stale the moment a retry happens. It
            stays inside the stored blob, because nothing drops a field the
            engine owns, and it has no way onto the page or onto the type.

Decision:   **Nothing deletes an incident.** The ledger is read with
            `status=open`, so a closed incident stops appearing — and a sweep
            that deleted what it no longer saw would throw away exactly the
            history time-to-resolve is computed from. A row a *successful* read
            no longer returns is marked closed-since; a lane that refused
            touches nothing. The two Airtable tables are read whole and swept
            normally, because for them absence really is deletion.

Problem:    The sources disagree about how to spell an error class:
            `error_counts` holds `schema_validation` and `billing_quota` while
            `retry_attempts` and the ledger hold `NETWORK_TIMEOUT`. Read off the
            live tables, not assumed.
Fix:        One normaliser, so the same fault is one bar rather than two. **A
            class this dashboard has not heard of keeps its own name** rather
            than being folded into `UNKNOWN` — `UNKNOWN` means the handler
            looked and could not decide, which is a different fact, and a class
            added upstream is worth seeing rather than hiding.

Decision:   Severity and retryability **prefer the incident's own answer** and
            fall back to the class map only where the row carries none, and each
            says which of the two answered. This code does not contradict a
            handler about an incident the handler classified.

Decision:   Three lane tabs, one component. The handlers are deliberately
            identical and a per-lane copy would drift the first time one changed.
            "By lane" is on All systems only: on a lane tab the other two lanes'
            counts are not context, they are noise.

Decision:   The silence framing on "most recent incident" starts at three days,
            not at one. A day without an incident is an ordinary good day, and
            saying "silence here is itself the signal" about it is the page
            crying wolf — which is how a reader learns to ignore the sentence by
            the time it means something.

Decision:   `/api/engine-health`, not `/api/health`: that one is the
            unauthenticated liveness check the host polls. A page's data route
            sharing its prefix is how one of them eventually shadows the other —
            noticed while wiring the route, before it could.

Verified:   Against a local Postgres 16 and stubs for the two hosts this sandbox
            cannot reach, each refusing what the real thing refuses — a lane key
            that is wrong gets a 401, an unknown table a 404, `fields[]=` with
            no field named a 422.
            - Migration 16 applied on boot; the boot line named the one lane
              with no key, by variable name.
            - Resync read 2 lanes + 2 Airtable tables, named the unkeyed third,
              and inserted 5 rows.
            - Deliberately left `retry_attempts` ids one character short first
              time: all 5 rows were refused, counted as refused rather than as
              "already matching", and each named in the log. That is the rule
              working, so the stub was fixed rather than the check.
            - Marked closed by absence: told the stub to stop returning
              INC-BAYS.CODEX-014, resynced, and it stayed held with
              `open_now: false` and a `last_seen_open` stamp. **0 deleted.**
            - **Broke the Bays key and resynced**: the lane was named unread
              with what BHARAG said, nothing under it was touched, its open
              incident stayed open, and the figure said it was over what is held
              rather than over what exists.
            - Retry now: posted to the healer with the exact documented body;
              refused at 3 attempts with the circuit-breaker sentence; refused
              for an incident with no retry row. The answer says the retry was
              *handed over*, never that it worked.
            - `/api/engine/incidents` took the brief's payload, was idempotent
              on a re-send, refused a row with no `entity_id`, 401'd without the
              key, and landed on the Engine writes tab. Same for the other two.
            - All five tabs rendered at 1440px with no sideways scroll and no
              console errors.
Not tested: anything against the live hosts. **The sandbox proxy refuses
            `bharag2.duckdns.org` and the n8n webhook host** (403 on CONNECT),
            so the ledger read and the healer call have only ever run against
            stubs built to the documented contract. Both need a real run before
            this page can be trusted: the ledger's list shape in particular is
            read defensively — a bare array and `{items: […]}` are both
            accepted, and anything else is an error naming what came back rather
            than an empty lane — but that is a guess about a shape I could not
            observe.
            Also untested: the three lane keys themselves, which are not set on
            this rig. Until they are set on Render every lane reads as unkeyed,
            which the page states plainly and the boot line names.

## 2026-09-17 23:05 — Pay Tracker, built from scratch
Intent:     Build the page that answers who is owed money, for what work, and
            what has already been paid. Pay lived as a tick on a Slack card, so
            answering "what do I owe Hardik for September" meant scrolling back
            through weeks of messages.
Files:      server/src/pay.ts (new), server/src/sources.ts, mirror.ts,
            migrations.ts, store.ts, index.ts
            src/data/types.ts, src/data/index.ts
            src/screens/PayTracker/{index,Owed,Statements,Sessions,Statistics}.tsx
            src/App.tsx, src/components/Layout.tsx
            CLAUDE.md, README.md, .env.example, render.yaml

Decision:   Read the live base before writing anything, as instructed. **This
            time the brief and Airtable agreed exactly** — every field name, id
            and select option matched. Worth recording precisely because the
            last two briefs did not, and the habit is what caught those.
            Sessions and Monthly Statements are both **empty**, which makes the
            empty-state rule the live state rather than a hypothetical.

Decision:   **The page counts work, not money.** There are no rates in the
            system and none appear anywhere — no column, no figure, no schema
            field waiting to be filled. Checked by grep before committing. If a
            rate arrives it goes on the Builders row and this schema needs a
            migration of its own, which is the point of saying so in the
            migration rather than leaving a spare column somebody might use.

Decision:   **Read-only, with no write path at all.** Paid status is set by the
            Slack card or by a statement closing. Two places to change one fact
            is how records drift, so there is no route, no button and nothing in
            the data module that could become one.

Decision:   **Monthly and daily are never summed into one rate.** Owed is two
            tables rather than one with a column; time to pay is two figures
            with their own denominators. A monthly builder is expected to wait
            until the 1st, so a blended number describes nobody — and the
            oldest-unpaid tile is only coloured past 30 days for the same
            reason, because under a full cycle is the agreement working.

Problem:    The strip read "This month so far 7" above "3 monthly · 3 daily".
            Three plus three is six. The seventh session carried no Pay Mode at
            all, and the split silently dropped it.
Fix:        A third count, named — "1 no pay mode" — wherever a split is
            printed, and its own group on the Owed tab. A split that does not
            add up to the figure above it is exactly the quietly-wrong number
            this dashboard exists to remove, and folding it into either mode
            would have been guessing which agreement somebody is on.

Problem:    The month read "Sep 26" on a page wall-to-wall with session dates,
            where it reads as the twenty-sixth rather than as 2026.
Fix:        Full year here, against the short form every other page uses. Four
            characters to remove the one ambiguity that matters on a page about
            which month somebody is owed for.

Problem:    The same builder appeared on two rows of the Owed tab, which reads
            as a duplicate.
Fix:        It was correct — rows group on the Slack id where there is one, and
            a session carrying none cannot be matched to one that does — but
            correct and unexplained is indistinguishable from broken. The row
            now says "no Slack id", which is also the thing worth fixing
            upstream.

Decision:   **`/api/engine/pay` takes one route with a `kind` in the body**,
            which is what n8n was given, rather than three kind-named routes.
            The body's kind is mapped onto the mirror kind before anything else
            reads it, so a pay row lands with the same envelope, auth and write
            log as every other. No default: a row with no kind is refused
            naming the two options, because guessing which of three tables a row
            belongs to is not a recoverable mistake.

Decision:   The ledger's own age is on the page and is load-bearing rather than
            polish. The ledger is kept in step with the approved logs by a
            30-minute sync, and this dashboard reads the ledger on a button —
            two hops, both stated. **Nothing owed and the sync not having run
            look identical**, and on a pay page that is the difference between a
            quiet month and an unpaid builder, so every empty state says which
            of the two it is.

Verified:   Against a local Postgres 16 and an Airtable stub built to the live
            schema, seeded to exercise exactly the cases the rules are about.
            - Migration 17 applied on boot.
            - **Before any resync**: the page said "This dashboard has never
              read the ledger", not "nothing is owed". That is the whole point.
            - Resync read 3 tables, 14 rows, 0 refused.
            - **The month rule**: a session worked 2026-08-31 and approved
              2026-09-01 came back as Month 2026-08. Grouped to August.
            - **Working days against session count**: Hardik shows 3 sessions
              across 2 working days (two on the 15th); the Jeganathan statement
              shows 12 working days and 17 sessions, and the panel says so in
              words when they differ.
            - **Time to pay is two figures**: Monthly "not recorded", Daily p50
              1.4 d / p95 2.4 d. Never one number over both.
            - **No roster match** surfaced 3 of 9 sessions in red, each with its
              Slack id or "no slack id" — never dropped.
            - Evidence rendered whole: three lines with dates and links, no
              clamp.
            - `/api/engine/pay` took the brief's payload for both kinds, was
              idempotent on a re-send, refused a missing and a nonsense kind
              naming the options, 401'd without the key, and landed on the
              Engine writes tab.
            - **Killed the stub mid-flight and resynced**: all three tables
              named unread, nothing deleted, nothing changed, and the last-read
              stamp deliberately not advanced — a failed read must not claim a
              fresh one.
            - Four tabs at 1440px: no sideways scroll, no console errors. The
              sidebar still fits every item without scrolling at sixteen
              (measured: scrollHeight equals clientHeight).
            - Grepped for currency symbols, "amount", "salary", "day rate": the
              only hit is the comment forbidding them.
Not tested: anything against real pay data — Sessions and Monthly Statements are
            both empty in the live base today, by design, so every figure was
            exercised against rows written to the stub. The first real statement
            is due on the 1st, and the first real session the next time one is
            approved; both paths should be watched then.
            Also untested: the token's read scope on `appwnt0mEtfwDtcN5`, which
            is not set on this rig. Until it is granted on Render the resync
            will refuse and name the table, which the page states plainly rather
            than reading as nothing owed.

## 2026-09-18 19:58 — an MCP server on the dashboard, so Claude can see the app
Intent:     Destiny talks to Claude about this dashboard constantly — "on this
            page I can't do X", "this panel should show Y" — and Claude has no
            way to see the app. The page is client-rendered, so fetching
            https://dashboard.bhanetwork.org returns `<div id="root">` and
            nothing else. Give an external Claude client the app's **structure**
            (routes, pages, components, which data feeds which panel) and its
            live data, over MCP, mounted on the existing service. Structure
            matters more than data, so it got the larger share of the work.
Files:      server/src/mcp/source.ts     (new) repo-relative reads, the file walk, the glob, the grep
            server/src/mcp/jsx.ts        (new) the TSX scanner
            server/src/mcp/structure.ts  (new) routes, pages, panels, data routes, sources — all derived
            server/src/mcp/tools.ts      (new) the seven tools and their schemas
            server/src/mcp/index.ts      (new) the streamable-HTTP transport
            server/src/index.ts          mounted /mcp ahead of /api; added the in-process GET dispatcher and the boot line
            render.yaml, .env.example, README.md, CLAUDE.md

Decision:   **No new dependency.** The obvious way to do this is
            `@modelcontextprotocol/sdk`, and CLAUDE.md rule 2.5 is explicit that
            `pg` is the ceiling and not a precedent. Streamable HTTP is JSON-RPC
            2.0 over a POST, so the transport is 180 lines here instead: parse
            the body, switch on `method`, answer. It handles `initialize`,
            `notifications/initialized`, `ping`, `tools/list`, `tools/call`, and
            answers `-32601` for the resources and prompts methods rather than
            an empty list, because an empty list reads as "there are none".
            Raised with Destiny in the same message as the build rather than
            blocking on it, since the answer the rule gives is not ambiguous.

Decision:   **Mounted on the existing `node:http` handler, not Express.** The
            brief said "mounted on the existing Express app"; there is no
            Express in this repo and never has been — `server/src/index.ts` is
            one `createServer` with its own router. So `/mcp` is a branch in
            that handler, ahead of `/api` and ahead of the SPA fallback. Same
            commit, same process, same Postgres, one service.

Decision:   **The secret is a path segment and every miss is a 404.**
            `MCP_SECRET`, no default, compared with `timingSafeEqual`. A wrong
            secret, a deeper path like `/mcp/<secret>/x`, and every request when
            the variable is unset all get the same `{"ok":false,"message":"No
            such route."}` an unknown route gets. Not a 401 — a 401 tells a
            stranger the endpoint exists and that they need a credential.

Decision:   **Read-only means no write tool and no path to one.** There is no
            guarded write, no confirmation-token write, nothing. `get_page_data`
            needed the app's own fetching code so it cannot drift from what the
            page shows, so it runs an **in-process GET through `api()` itself**
            — the same function that answers the browser. That needed one line
            in the existing router: the cookie guard became
            `if (!internal && !readSession(req))`, with `internal` an optional
            fourth parameter no request can set and only `dispatchApi` in the
            same file passes. The dispatcher is GET-only and refuses
            `/api/engine/*` and `/api/inbound/*` by name as well, because
            "unreachable by construction" is worth asserting twice on a path
            that skips the cookie. Verified after: `/api/overview` without a
            cookie is still 401.

Decision:   **Nothing about the structure is a list written by hand.** The
            whole value of `get_page_structure` is that it cannot be out of date.
            So: routes from the `<Route>` elements in `src/App.tsx` with each
            element resolved through its own import to a file; sidebar label and
            group from the `GROUPS` array in `Layout.tsx`; a page's title and
            one-line purpose from its own `<PageHeader title subtitle>`, falling
            back to the first sentence of that page's `###` section in
            CLAUDE.md, with the source of each named in the answer beside it;
            panels from a scan of the page's own JSX; data routes by resolving
            each `src/data` function to its `api()` call; external sources from
            the exported constants in `sources.ts` and `mirror.ts` as the
            process actually holds them. A page with no subtitle and no spec
            section returns `description: null` and says why, rather than a
            sentence somebody composed.

Problem:    Telling JSX from a TypeScript type argument. `useData<HealthData>(`,
            `Record<string, unknown>` and `api<OverviewData>(` are
            character-for-character an opening tag.
Fix:        A `<` immediately after an identifier, a `)` or a `]` is a type
            argument or a comparison, never an element — unless the identifier
            is a keyword, so `return <PageHeader />` still reads as JSX. Across
            all seventeen pages at expand_depth 3 the scanner now reports **zero
            warnings**, and the only names it cannot resolve are `Ic`, `I` and
            `W`, which are genuinely dynamic icon aliases assigned inside a
            function body (`const I = Icon[meta.icon]`). Those come back
            unresolved **with the reason**, which is the right answer.

Problem:    The first version of the declaration-span finder answered with a
            signature and no body. `function f(a, b) { … }` returns to bracket
            depth nought at the `)` of its parameter list, so every page's
            structure came back as **zero nodes** and five `src/data` functions
            whose `api()` call sits on a second line resolved to no route at all.
Fix:        When depth returns to nought, look ahead: `{`, `=>` or `:` means the
            declaration carries on. `/engine-health` went from 0 nodes to 89.

Problem:    `<LaneView>` on the Engine health page resolved to
            `src/screens/Clients.tsx:90`. Both files declare a component with
            that name and the resolver was ranking candidates and taking the
            first. That is exactly the failure the brief calls out: a wrong
            answer about structure, stated confidently, that gets acted on.
Fix:        Components are resolved **through the importing file's own import**,
            never by ranking same-named declarations — following `export *`
            barrels where needed, since every screen imports its primitives from
            `src/components/ui`. Where the import cannot be followed the answer
            is `defined_at: null` with the candidates named. `get_component` on
            an ambiguous name now **fails and names both files** rather than
            picking one.

Problem:    The barrel follower stopped before it reached `Figures.tsx`: the
            cycle guard (`seen.size > 12`) was doubling as a breadth limit, and
            `src/components/ui/index.ts` has twenty-five `export * from` lines.
            Everything declared past the twelfth came back unresolved.
Fix:        `seen` guards cycles only; depth is what is capped, at 6.

Problem:    `/api/engine-health/metrics${lane ? `?lane=…` : ''}` is a template
            literal with a template literal inside it, and the route extractor
            stopped at the first inner backtick — so the route came back cut off
            mid-expression.
Fix:        A literal reader that counts `${}` nesting. Routes now carry both
            `path` (verbatim) and `path_prefix` (the part before the first
            `${`), and a parameterised route is never looked up by its prefix,
            because `/api/` is not a route this server registers.

Decision:   **Nothing is cut silently, and a cut payload is described rather
            than sampled.** Every capped answer says what the cap was and how to
            ask for the rest — `search_source` pages with an offset and prints
            the total, `get_page_structure` has a node budget and names it. Where
            a page's payload is past `get_page_data`'s 120 KB cap the answer
            carries the payload's **shape** (keys, array lengths, leaf types) and
            no rows at all. No "first three of": a fragment read as the whole is
            the mistake this dashboard exists to stop, and a shape with counts on
            it is enough to decide what to ask for next.

Decision:   `get_health` probes rather than asserts. Postgres gets a `select 1`,
            Airtable a one-field read of Build Patterns, n8n a `GET /workflows`
            limited to one page, and each BHARAG lane its own `status=open` read
            with its own key. A source with no credential set is reported
            `configured: false, reachable: null` and **never as healthy** — the
            same rule Engine health follows, because an unasked source and a
            healthy one look identical from outside. The deployed commit is read
            from `RENDER_GIT_COMMIT`; absent, it is `null` with a note saying it
            is not guessed at from the checkout, which may have moved since the
            build.

Verified:   Against a local Postgres 16 and this checkout, with the client and
            server both built (`npm run build`, clean) and `npm run typecheck`
            passing.
            - Boot line: `mcp: /mcp/<MCP_SECRET> — read-only tools over
              streamable HTTP, MCP_SECRET set`. The secret is never printed.
            - **404 on every miss**: wrong secret, bare `/mcp`, and
              `/mcp/<secret>/extra` all 404. `GET` on the right path is 405 and
              says the endpoint opens no stream. A notification gets 202 with an
              empty body.
            - `initialize` echoes the client's protocol version when it is one of
              the three supported. `tools/list` returns all seven.
            - Both response framings: `application/json` by default, and one
              `event: message` SSE frame when `Accept` asks for a stream only.
              A JSON-RPC batch answers as an array.
            - `list_pages` returned all 18 routes with the right file for each
              and a description for every one — nine from a `PageHeader`
              subtitle, two from CLAUDE.md's own section, and the catch-all named
              as a redirect to `/`.
            - `get_page_structure` over **every page** at expand_depth 3: zero
              scan warnings, nothing truncated, and 7 unresolved names in total,
              all of them dynamic icon aliases reported with the reason.
            - `get_page_data` on `/` read `/api/overview` through the app's own
              router — 11,748 bytes, and against the empty database the Overview
              says "none held" rather than nought, which is the page being
              honest and not the tool. With `max_bytes: 4096` the same call came
              back as a shape with the cap explained.
            - `get_page_data` on `/engine-health` fetched two routes and
              **skipped three, each with its reason**: one needs a lane filled
              in, two are POSTs and "this tool set has no write tool, so it is
              never called from here".
            - `list_data_sources` returned 33 sources — 27 Airtable tables
              (including all seven loop tables and all six Codex tables), three
              BHARAG lanes, two n8n endpoints and Postgres — each with its
              credential, whether it is set, its `engine_*` table and the pages
              that read it.
            - `get_component("LaneView")` failed with both candidates named.
              `get_component("PageHeader")` returned the whole declaration and
              its doc comment.
            - **Existing behaviour unchanged**: `/api/overview` without a cookie
              is still 401; sign-in still works; all fourteen page routes
              (`/api/status` through `/api/twin-handoffs`) still 200 behind the
              cookie; `/` and `/open-loops` still serve the SPA shell.
            - **Every page still renders**: signed in through the real form in
              Chromium at 1440×900 and walked all seventeen routes. Each painted
              its own heading — "Good evening, Admin" on the Overview, then North
              Star through Settings — no sideways scroll on any of them, and no
              console or page error except the sandbox proxy's
              `ERR_CERT_AUTHORITY_INVALID` on the web font and the weather call,
              which are this container's and not the app's.
Not tested: Anything against the live Render service, or against a real Claude
            connector. `MCP_SECRET` is not set on the service yet, so until it is
            the endpoint answers 404 to everything — which is the designed state
            and is what the boot line says. The probes in `get_health` ran with
            no Airtable token, no n8n key and no BHARAG keys on this rig, so each
            reported "not configured" correctly but the reachable path was only
            exercised against Postgres. Both should be watched on the first real
            connector call.
## 2026-09-18 19:30 — Registry: a service can be given a url and a note
Intent:     Destiny added GoDaddy from the Tools tab's "Add a service" form and
            found nowhere to put its URL, and asked for GoDaddy to appear in the
            notes card at the foot of the registry.
Files:      src/screens/Registry/index.tsx, server/src/registrySeed.ts

Problem:    `url` and `notes` are both registered fields on the services kind
            (`server/src/registry.ts:114` and `:123`, accepted by create and
            update) and **neither had any interface at all**. Not on the add
            form, and not in the row: the url rendered as a read-only link
            under the service name and notes rendered nowhere but a read-only
            card. So a service created from the page could never be given
            either, for as long as it existed. The only notes that could exist
            were the ones seeded in this repo.
Fix:        url and notes added to the add-a-service form; url made editable in
            the row beside its link; every note in the card made editable in
            place.

Decision:   **The url keeps its link and gains an editor beside it**, rather
            than becoming a plain editable cell like the Endpoints tab's. An
            `<a>` inside `EditableCell`'s button is invalid markup and the
            click would be swallowed, and the link is the useful thing on that
            row. It is the shape the Builders tab already uses for lanes owned:
            the value rendered as itself, with a quiet `edit` next to it. A
            service with no url shows the dash, which clicks to add.

Decision:   **The notes card lists every live service, not only the annotated
            ones.** It was gated on `rows.some((s) => s.notes)` and listed only
            services carrying a note, which meant a service with none was
            invisible in the one place notes live — so there was nowhere to
            click to write the first one. Annotated services lead, because it
            is a card for reading notes, and the rest keep their line with a
            dash on it. Absence drawn as absence, the same rule section 4
            states for a metric.
            Deliberately not filtered by the search box or the category tabs:
            these are read as a set, and a note that vanishes because somebody
            typed in an unrelated filter is a note nobody finds twice.

Decision:   GoDaddy seeded with its url and its note rather than left to be
            typed. Read from the #bha-coordination front-door thread today
            rather than supplied, so every claim in the note is something
            somebody wrote down: the Account Change off Jason's personal login
            into admin@bhanetwork.org, why a delegate was not enough (GoDaddy
            blocks a delegate from generating an API key, and the Domains
            section is invisible below the Products & Domains level), and the
            Website Builder site still on the apex. The Bitwarden **item name**
            is recorded and no value of any kind is, per section 2 rule 1.
            Filed under `other`: it is a registrar, not hosting, and there is
            no `domains` category. Inventing an eighth value in the server's
            vocabulary to file one row under was not worth a schema change.

Problem:    Seeding is `INSERT ... ON CONFLICT (id) DO NOTHING` and a service
            created from the page takes `slug(name)` as its id, so a GoDaddy
            row already added by hand holds `godaddy` and **the seed is a
            no-op against it** — it would keep whatever blanks it was created
            with. Could not check the live table: Render's query tool refuses
            the connection ("SSL/TLS required (SQLSTATE 28000)").
Fix:        Left as is rather than made to overwrite. A seed that edits a row
            somebody typed is worse than one that does not, and both fields are
            now one click away on the page. Flagged to Destiny.

Verified:   Local Postgres 16, twelve services.
            - Boot: `registry: seeded 1 row(s): services 1`.
            - The form carries url (placeholder `https://…`) after category and
              notes on the second line; no overflow at 1440.
            - Added a note to Onshape from the card and read it back out of
              `registry_services`. Edited GoDaddy's url from the row: the
              editor opened on the current value, saved, and the anchor's href
              followed it to the new one.
            - Notes card: annotated services first, then BHARAG, Onshape and
              Slack each as a name and a clickable dash. `scrollWidth ===
              clientWidth` at 1440, so the body still does not scroll sideways.
Not tested: anything against the live database — see the seed no-op above.

## 2026-09-18 19:32 — Two Airtable bases the registry never listed
Intent:     Destiny mentioned two new Airtable bases and then withdrew it,
            saying they had shown up here on their own. Checked rather than
            taken on trust, because nothing about this list is automatic.
Files:      server/src/registrySeed.ts

Problem:    **Nothing discovers an Airtable base.** `AIRTABLE_BASES` is a seed
            list and `registry_bases` has no writer anywhere in the server, so
            a base reaches the registry only by being written down in this
            file. What Destiny saw was the two twin ledgers arriving after
            yesterday's deploy — new ids do not conflict, so a seed addition
            does insert on the next boot — which reads as automatic and is not.
            Two bases this server has read for days were missing outright:
            `appkSUSh9ijNjP2f8` (the watched clients, behind the Clients page
            since 15 Sep) and `appwnt0mEtfwDtcN5` (BHA Pay Ledger, built
            yesterday). Fourteen listed, sixteen read.
Fix:        Both seeded, with their table ids and what each is for.
Decision:   Section 4 says a legacy base stays listed because one that vanished
            from the registry would read as one that was never there. A base
            the engine actively reads and the registry omits is the same
            sentence from the other end, and it is the worse half: the five
            legacy bases are listed and the Clients base, which is live, was
            not.
Verified:   `registry: seeded 2 row(s): bases 2` on boot; sixteen bases on the
            Endpoint tab, both new rows carrying their ids and notes, no
            sideways scroll at 1440.

## 2026-09-18 20:30 — one route the extractor could not see, on the page that lists everything
Intent:     PR #6 merged while this session was still open — Destiny resolved
            the BUILD_LOG conflict and merged at 20:18, so the MCP server is on
            `main`. This entry is the one change that came after it, found by
            reading the merged tree's own answer rather than by a test.
Files:      server/src/mcp/structure.ts

Problem:    `get_page_structure("/registry")` listed one route,
            `GET /api/engine-writes`, and **not `/api/registry`** — so the
            System registry read as a page that fetches no data of its own, and
            `get_page_data` on it would have answered with the write log and
            nothing else. `getRegistry` wraps its route in a ternary:
            `api<RegistryData>(includeDeleted ? '/api/registry?deleted=true' :
            '/api/registry')`. The extractor read only the token immediately
            after `api(` — a string, a template, or a `withLane(` — and a
            ternary is none of the three, so it found no literal and dropped the
            function entirely.
Fix:        Read the **first `/api/…` literal anywhere in the call** rather than
            only the next token, and strip the query string as well as the `${`
            when deriving `path_prefix`: `/api/registry` is what index.ts
            registers and `/api/registry?deleted=true` is not. Forty data
            functions now resolve to a route where thirty-five did, and because
            a prefix without its query matches the route literal in index.ts,
            the source-to-page chain in `list_data_sources` went from 27 of 33
            sources carrying a page link to 30.

Decision:   Worth stating plainly, because it is the failure mode the whole tool
            set is built against and it arrived from the direction the design
            did not guard. The "never guess" rule protects against a **wrong**
            answer; this was an **incomplete** one, and an incomplete answer
            about a page reads exactly as confidently as a complete one. Nothing
            warned. The guard against the next one is that the extractor now
            searches for what it needs instead of assuming the shape it will be
            written in.

Decision:   Restarted this branch from `main` rather than stacking on the
            already-merged history. A merged pull request is finished, so the
            merge commit this session made to resolve the conflict is
            superseded — Destiny's own resolution (a66ba25) is what landed, and
            it kept both sides' entries, which is what section 9 requires. Its
            ordering puts 19:58 above 19:30; that is left exactly as merged,
            because reordering an entry somebody else committed is rewriting it.

Verified:   Against `main` plus this one file, with a local Postgres 16.
            - `npm run typecheck` and `npm run build` clean.
            - `get_page_structure` over **every page** at expand_depth 3: 1,172
              nodes, **zero scan warnings**. `/registry` reads 159 nodes where
              it read 155 before main's registry commits, having picked up the
              new url and notes form fields without a line of this code
              changing — which is the point of deriving structure from source.
            - `/registry` now lists `GET /api/registry` **and**
              `GET /api/engine-writes`, and `get_page_data` on it returned
              40,854 bytes carrying all six registries, `spend` and
              `digest_health`, skipping the parameterised write-log route by
              name.
            - Boot on the merged tree: 17 migrations, `registry: seeded 103
              row(s) … services 11, bases 16` — main's new seed rows land — and
              the mcp boot line still names MCP_SECRET.
            - Still 404 on a wrong secret and on a deeper path; still 401 on
              `/api/overview` without a cookie; `/api/status`,
              `/api/registry`, `/api/overview`, `/api/open-loops`, `/api/codex`
              and `/api/executions` all still 200 behind the cookie.
            - Re-rendered `/`, `/registry`, `/engine-health`, `/executions` and
              `/open-loops` in Chromium at 1440×900: each painted its own
              heading, no sideways scroll, and no console error but this
              container's proxy certificate on the web font and the weather
              call.
Not tested: Nothing against the live Render service. There is **no CI on this
            repository** — PR #6 reported no check runs at all — so "green" here
            means the repo's own checks run by hand: typecheck, build, the
            scanner sweep over every page, and the browser pass above.

## 2026-09-18 20:40 — the connector could not discover the endpoint, because GET was a 405
Intent:     The MCP server is merged and live (07bd015) and adding it as a
            Claude custom connector still failed. Destiny found why:
            `GET https://dashboard.bhanetwork.org/mcp/<secret>` answered 405.
            Claude's connector check **opens with a GET**, read the 405 as
            "could not connect", could not then determine how the server signs
            in, and fell back to OAuth dynamic client registration — which
            fails, because this server deliberately has no OAuth.
Files:      server/src/mcp/index.ts, README.md, CLAUDE.md

Problem:    Refusing GET is spec-legal: this server sends no server-initiated
            messages, so there is genuinely no stream to open. The comment in
            the code said exactly that and it was true. It was also the wrong
            call — **spec-legal and undiscoverable is still undiscoverable**,
            and the failure surfaced two steps downstream as an OAuth error,
            which points at the wrong thing entirely.
Fix:        GET answers 200 `text/event-stream` and holds the stream open,
            carrying no messages. A comment goes down it immediately and
            another every 20 seconds.

Decision:   **The keep-alive and the immediate first byte are not decoration.**
            Render's router closes an idle connection, so a stream with nothing
            on it would be dropped under the client; and a buffering proxy will
            hold the headers back until a client cannot tell an open stream from
            a hang, which is why the first byte goes out before anything else
            and `X-Accel-Buffering: no` is on the response. `socket.setTimeout(0)`
            stops Node timing the socket out from under a live stream, and the
            keep-alive interval is `unref`ed so it can never be the reason this
            process stays up.

Decision:   **Nothing under `/mcp` answers 401, and that is now written down as
            a rule rather than a fact about the code.** The original reason was
            that a 401 tells a stranger the endpoint is there. The better reason
            is the one this bug taught: a 401 is what *starts* an OAuth flow, so
            a client that gets one goes off to discover an authorization server
            this service does not have, and the error it eventually reports is
            about OAuth rather than about the thing that went wrong. Swept 24
            method/path combinations to confirm none of them answers 401.

Decision:   **The secret is still checked first, for every method**, before
            anything else is read — so OPTIONS, GET, HEAD, POST and DELETE are
            all equally silent to a caller without it. Every one of them answers
            the same `{"ok":false,"message":"No such route."}` with **no CORS
            headers at all**, byte for byte what an unknown route answers. The
            new GET handler must not leak the endpoint's existence, and a 404
            that carried `Access-Control-Allow-Origin` would have done exactly
            that.

Decision:   **A session id is issued on initialize and then accepted forever.**
            It is minted in the transport rather than in `handleRpc`, which
            answers in JSON-RPC and has no way to set a header, and it goes back
            in `Mcp-Session-Id` with `Access-Control-Expose-Headers` naming it —
            without which a browser client cannot read the header it was just
            sent. Nothing per-session is kept, so **an id this process does not
            recognise is accepted rather than refused**: Render restarts on every
            deploy and after every spin-down, so a client's id routinely
            outlives the process that issued it, and the spec's 404 for an
            expired session would be indistinguishable here from the 404 a wrong
            secret gets — which is the one signal on this endpoint that has to
            stay unambiguous. The store is bounded at 500 and exists for the
            log line and nothing else.

Problem:    The rejection log said "secret did not match" for a bare `/mcp` and
            for `/mcp/<secret>/extra`, neither of which ever reaches the
            comparison.
Fix:        It names the real reason now — the path shape, the secret, or
            `MCP_SECRET` not being set — and still never prints what was tried.

Verified:   Locally, driving it exactly as a client does, against a server booted
            on a local Postgres 16. `npm run typecheck` and `npm run build`
            clean.
            1. **OPTIONS** → 204, `Access-Control-Allow-Origin: https://claude.ai`
               (the request's own origin, echoed, with `Vary: Origin`),
               `Allow-Methods: GET, POST, DELETE, OPTIONS`, `Allow-Headers`
               carrying `mcp-session-id` and `mcp-protocol-version`, and
               **`Expose-Headers: Mcp-Session-Id, Mcp-Protocol-Version`**.
            2. **GET** → `200`, `Content-Type: text/event-stream`,
               `Connection: keep-alive`, `X-Accel-Buffering: no`, `: open` on the
               wire straight away. curl timed out at 4s and again at 26s rather
               than the server closing: at 26s the stream had `: open` and one
               `: keep-alive`, 22 bytes, still open.
            3. **POST initialize** → 200 with
               `Mcp-Session-Id: d2451f5c-…`, protocolVersion echoed as
               2025-06-18, `capabilities.tools`, serverInfo.
            4. **notifications/initialized** with that id → 202, empty body.
            5. **tools/list** with that id → 200, the id echoed back, all seven
               tools.
            6. A real call — `list_pages` over the session → 18 routes,
               `isError: false`.
            7. **DELETE** with the id → 204, no body, CORS present.
            - **HEAD** (with `curl --head`, not `-X HEAD`, which waits for a body
              it will never get) → 200 with the stream's headers.
            - **No leak**: OPTIONS, GET, HEAD, POST, DELETE and PUT on
              `/mcp/wrong-secret` all 404; bare `/mcp` 404; `/mcp/<secret>/extra`
              404 on GET and on OPTIONS. Zero `access-control` headers on a 404.
              PUT on the right secret is 405 with the Allow header, not 401.
            - **No 401**: swept six methods across four paths — 24 combinations,
              not one 401.
            - An invented session id → 200, accepted.
            - The app is untouched: `/` still serves the shell, `/api/overview`
              without a cookie is still 401, and `/api/status`, `/api/overview`,
              `/api/registry` and `/api/executions` all still 200 behind it.
Not tested: **Against the deployed URL — this session cannot reach it.** The
            egress policy on this container denies both
            `dashboard.bhanetwork.org:443` and
            `bha-engine-dashboard.onrender.com:443` with a 403 on CONNECT
            (recorded in the agent proxy's own `recentRelayFailures`), and the
            proxy's guidance is to report a policy denial rather than route
            around it. So the deployed retest Destiny asked for was done the
            only way available from here: confirming the deploy went live
            through Render's API and reading this server's own `[mcp]` log lines
            off the running instance. The curl sequence to run from a machine
            that can reach the host is in the handover.

## 2026-09-18 20:42 — what the live request log proved, and what it could not
Intent:     Addendum to the 20:40 entry. Destiny asked for the retest to be
            driven against the deployed URL rather than locally, so this records
            exactly how far that got and where it stopped.
Files:      none — verification only.

Verified:   **The diagnosis is confirmed against the live service, not merely
            believed.** Render's own request log for dashboard.bhanetwork.org at
            20:27:01 holds the failing request verbatim:
            `GET /mcp/<secret>` → **405**, `level=warning`,
            `responseTimeMS=6`, `responseBytes=462`, user agent
            `Claude-User/1.0 (+claude-user@anthropic.com)` — the connector
            check, opening with a GET, getting the 405 this commit removes.
            The deploy of 01c0cf4 went live at 20:37:35 on instance
            `srv-dagj84ijnfac73ds5100-gd6nk`, and that instance's own boot line
            reads `mcp: /mcp/<MCP_SECRET> — read-only tools over streamable
            HTTP, MCP_SECRET set`.

Not tested: **The post-fix GET against the deployed URL. This session cannot
            reach the host by any route.** The container's egress policy denies
            `dashboard.bhanetwork.org:443` and
            `bha-engine-dashboard.onrender.com:443` with a 403 on CONNECT
            (recorded in the agent proxy's `recentRelayFailures`), and the
            Anthropic-side fetch is denied the same domain
            (`EGRESS_BLOCKED`). The proxy's own guidance is to report a policy
            denial rather than route around it, so that is what this says: the
            fix is proven locally against the exact client sequence, and the
            deployed leg of it is one curl away from somebody who can reach the
            host. It will also show up in Render's request log as
            `GET /mcp/<secret>` → 200 the moment the connector is retried,
            which is checkable from here afterwards even though originating it
            is not.

Decision:   Worth writing down because it is a consequence of the design rather
            than a bug: **a path-segment secret appears in plaintext in
            Render's request logs**, which is where this session read it from.
            That is inherent to putting the credential in the URL — the
            connector URL is what Claude's client accepts, so the trade was
            made deliberately — but it means the log is as sensitive as the
            variable, and rotating the secret means rotating it in two places
            (the Render env var and the connector URL). Nothing in this repo
            ever prints it; Render's edge does, before the process sees the
            request.

## 2026-09-20 19:05 — the vFarm Early Access funnel: a public write route, a lead table, a Slack hop and a tab
Intent:     Build the receiving end of the vFarm Early Access funnel. The form
            on bhanetwork.org had nowhere to post to; /vfarm was a ComingSoon
            with no data of its own. So: a table, one public endpoint, a
            notification through n8n into #vfarm-early-access, and an Early
            Access tab that is a small CRM.
Files:      server/src/migrations.ts (migration 18)
            server/src/earlyAccess.ts (new — the whole funnel)
            server/src/index.ts (the public route, the read and patch routes, boot lines)
            src/data/types.ts, src/data/index.ts
            src/screens/VFarm/index.tsx (tabs), src/screens/VFarm/EarlyAccess.tsx (new)
            .env.example, render.yaml, README.md, CLAUDE.md

Decision:   **`engine_vfarm_leads` is not shaped like a mirror table, and that
            is deliberate.** Every other `engine_*` table here holds
            `{ airtable_record_id, created_time, fields }` because the engine
            owns those rows and this dashboard copies them — and section 4's
            rule about never renaming what the engine writes exists because
            n8n writes those names. These rows are *born here*: the site posts
            to this server and nothing upstream has a copy. There is no
            Airtable field name to keep verbatim, so they get real columns.
            Worth writing down because the convention looked like it applied
            and does not.

Decision:   **`email` is not unique.** A unique constraint has two failure
            modes and both are bad: reject the submission, which tells a
            stranger their address is already on file, or drop it silently,
            which loses a real signal. Repeats are stored and flagged at read
            time with a window function — `row_number() over (partition by
            email order by created_at, id) > 1` — so the *first* row is never
            the repeat and the flag survives a delete.

Decision:   **The public endpoint answers `{ ok: true }` and a status code, and
            that is the entire contract.** Never the stored row, never a count,
            never whether the address was already known. A public route that
            confirms "you are already on the list" is an address oracle, and
            the repeat it would be confirming is exactly the thing the
            dashboard shows to the six people who should see it. Verified by
            posting a duplicate: byte-identical 201 body.

Decision:   **It records an expression of interest and nothing else.** No
            subscriber, payment, entitlement, reservation or delivery state is
            set, read or implied in the handler, the table or the response, and
            no such column belongs in that table. `status` is this dashboard's
            own note about whether anybody has replied — which is why the strip
            says "expressions of interest, not commitments" under the count.

Decision:   **On CORS, said plainly rather than implied.** An `Origin` that is
            present and not on the list is refused 403, and its preflight too.
            But **CORS is a browser mechanism and cannot be an authorization
            boundary**: a request with no `Origin` is allowed through, because
            `Origin` is unauthenticated and refusing its absence would only
            inconvenience honest callers while stopping nobody. What actually
            protects the route is the validation, the rate limit, and the fact
            that it can answer with nothing. The comment in the code says this,
            so the next person does not mistake the 403 for a security control.

Decision:   **Order in the handler: origin, method, rate, shape, write.** A
            refused origin never reaches the body, and a flood is turned away
            before it costs a database round trip. **A failed validation still
            spends a rate-limit slot** — otherwise an attacker floods with
            invalid bodies for free — and five in ten minutes is still generous
            for a human who mistyped.

Decision:   **`IP_HASH_SALT` unset generates a random per-process salt rather
            than falling back to no salt.** An unsalted SHA-256 of an IPv4
            address is reversible by anyone with an afternoon and four billion
            guesses, so "salted" with an empty string would be the kind of
            security that reads as security and is not. The cost is that stored
            digests stop comparing across a restart, and the boot line says so.

Decision:   **The notification is started and never awaited**, five seconds,
            and a failure is logged and never fatal. `notified_at` staying null
            is the useful part rather than a gap: the row prints "not announced",
            which is exactly what somebody wants when they are wondering why
            they never saw one. No Slack token is in this repo and nothing calls
            Slack directly — the n8n webhook holds that credential, the same
            way `ENGINE_HEAL_URL` does.

Decision:   **Nothing new was introduced on the page.** Tabs, StatStrip,
            RecordTable, SearchBox, Segmented, Pagination, Pill and Toast were
            already here, and inline editing already existed as the registry's
            own `EditableCell` — which does select and longtext, and reverts a
            refused write. Reusing it meant the CRM needed no new component and
            no new colour. A repeat email is a **neutral** tag: somebody asking
            twice is a real signal and not a fault, and section 5 keeps amber
            and red for a genuinely bad state.

Decision:   **Overview keeps its ComingSoon, untouched.** The funnel arriving
            does not make the rack instrumented. Early Access is a second tab,
            not a replacement — a page that quietly started implying vFarm was
            wired up would be the thing section 2 forbids.

Problem:    Acceptance check 7 passed and the result was worthless. The server
            meant to have a *failing* notify URL never started —
            `Error: listen EADDRINUSE: address already in use 0.0.0.0:8797` —
            so the submission was answered by the previous process, the one
            with notifications switched **off**. `notified_at` was null for the
            wrong reason, and a null read exactly like a pass.
Fix:        Killed the holder by pid, confirmed the port free, restarted, and
            checked the boot line said `notifying … via EARLY_ACCESS_NOTIFY_URL`
            before trusting the result. Then asserted the webhook was actually
            called — the stub's delivery count went 9 → 10 — and read the log
            line naming the 500. The lesson is the general one: a test whose
            pass condition is an absence has to prove the mechanism ran.

Problem:    The first browser run of check 10 died on
            `strict mode violation: getByRole('button', { name: /^contacted/ })
            resolved to 2 elements` — the status filter and the status pill on a
            row both read "contacted".
Fix:        Scoped the filter clicks to `[role=group][aria-label="Filter by
            status"]`. A test-only fix; the page was right.

Verified:   Eleven checks, against Postgres 16 and Chromium at 1440×900.
            1. **Migration** — empty database applied 1–18; a database brought
               to 17 with the pre-change `migrations.ts` then applied **18
               alone** (`applied: 18 | already: 17`); both re-ran as
               `applied: | already: 18`. Columns, defaults and all three
               indexes match the spec, `id` defaulting to `gen_random_uuid()`.
            2. **201** — from `Origin: https://bhanetwork.org`, body
               `{"ok":true}`, `Access-Control-Allow-Origin` echoed. Stored with
               the name trimmed and the address lowercased
               (`"  ADA@Example.COM "` → `ada@example.com`), the provenance
               fields kept, `submitted_at` parsed, and an unknown field
               (`some_field_added_later`) ignored rather than refused.
            3. **CORS** — POST from `https://evil.example` → 403 with no
               `Access-Control-Allow-Origin`; its preflight → 403; a preflight
               from `http://localhost:5173` → 204 with the full header set.
               Nothing stored.
            4. **400** — ten malformed bodies, each with its own reason: no
               email, empty email, no `@`, no dot in the domain, a space in the
               address, no name, a name of only spaces, a 201-character name, a
               201-character organisation, and a body that is not an object.
               Row count unchanged.
            5. **429** — six submissions from one address: five 201, the sixth
               429 with `Retry-After: 600`, five stored. A different address on
               the next request → 201.
            6. **Notify unset** — boot line `notifications OFF …  The endpoint
               still works`; POST → 201, stored, `notified_at` null, no
               delivery attempted.
            7. **Notify erroring** — boot line confirmed notifications on, the
               stub was called (deliveries 9 → 10) and returned 500; POST → 201,
               lead stored, `notified_at` **NULL**, and the log reads "was
               refused: 500 … The lead is stored; notified_at stays null."
               Also checked a notify URL that hangs 30s: the POST returned 201
               in 9ms.
            8. **No lead data** — GET, GET with `?id=`, and PUT on the public
               route all 405 with `{"ok":false,"message":"POST a submission."}`;
               a duplicate address gets the byte-identical `{"ok":true}`.
            9. **Auth** — `GET /api/vfarm/leads` and `PATCH /api/vfarm/leads/:id`
               both 401 without the cookie and 200 signed in. No `ip_hash` on
               any lead in the response.
           10. **The tab** — Overview still renders its ComingSoon; tabs read
               `Overview` and `Early Access 11`. The strip
               (11 / 11 / 11 / "11 / 0") matched the API exactly; 11 rows newest
               first; one repeat flagged, matching the API. An inline status
               change moved the strip to "10 / 1" immediately, a note was typed,
               and after a reload the server had both. Filters returned
               10/1/0/0/11 with "No lead matches that filter." on the empty
               ones; search matched a name, an address and an organisation
               separately. Copy-email put one address on the clipboard and
               copy-all put ten. A refused PATCH (injected 422) left the row
               reading `contacted` and put the server's own sentence in the
               toast. No sideways scroll, no console error but the injected 422.
           11. **`npm run build`** — clean, and `npm run typecheck` with it.
Not tested: Against the live site or the real n8n webhook. The notification was
            exercised against a local stub on 200, 500 and a hang, and the
            envelope it received was checked field by field — but nobody has
            confirmed the webhook at the other end parses it or that it posts to
            `C0C36GPEB3L`. That is the first thing to watch after the variables
            are set. Nothing was tested against the production database; the
            migration was proved on a copy brought to 17 by the pre-change code,
            which is the same shape but not the same rows.

## 2026-09-20 20:20 — MCP upgrade: five read tools, one resync, and the write gate
Intent:     Close the gap that made both of today's faults slow. The Pay Tracker
            showed nothing because an n8n workflow had written no rows into
            Airtable, and finding that took four tool calls here plus two
            elsewhere because nothing could compare a source against its mirror.
            Then, after the upstream fix, the page still showed nothing — the
            mirror only fills on `POST /api/pay/resync`, and this server
            reported that correctly and uselessly, having no way to press it.
            So: tools that say whether an empty kind is stopped or merely unread,
            a tool that can press the button, and the scaffolding for the first
            tool that will one day change a row.
Files:      server/src/mcp/sql.ts (new, 313)  — read-only SELECT, schema reads
            server/src/mcp/inventory.ts (new, 353) — mirror status and the diff
            server/src/mcp/logs.ts (new, 175) — the in-process ring and search
            server/src/mcp/gate.ts (new, 284) — preview / token / audit
            server/src/mcp/tools.ts — 7 tools to 13, annotations on all of them,
              `fields` on get_page_data, the get_health probe fixed
            server/src/mcp/index.ts — the rewritten `instructions` string
            server/src/index.ts — mcpLogs.install(), request recording with the
              secret redacted to `/mcp/<secret>`
            server/src/migrations.ts — migration 19, engine_mcp_writes
            server/test/write-gate.test.cjs (new) + `npm run test:gate`
            CLAUDE.md, README.md
Problem:    Five things, in the order they bit.

            1. `get_health` reported Airtable unreachable with
               `Unknown field name: "Submission ID"`. My own probe from 18 Sep
               called `listRecordIds` on Build Patterns, and `Submission ID`
               exists only in the seven loop/Codex tables. A false negative on
               a health surface, which is the worst direction for one to fail
               in: it said the engine was broken when the engine was fine.

            2. `resync` reported `0 rows added, refused: 5` against the stub.
               The stub's record ids were `rec` + 12 characters. Airtable's are
               `rec` + exactly 14, and `mirror.prepare()`'s own regex refused
               every row. The mechanism was right and my test data was wrong —
               and the refusal count is precisely the thing I had added to
               `store.resync` on 15 Sep so that "read five, stored none" could
               never read as "five already matched".

            3. A comment I had written in `sql.ts` claimed the query fetched
               `cap + 1` rows to detect a capped read, while the code fetched
               the whole result set and sliced. The comment described the design
               and the code did something else, so the reported count would have
               been a total on a read that was actually capped.

            4. `describe_schema` printed `"type": "oid:19"` — `name` and `oid`
               were missing from the type map.

            5. Acceptance check 7 for the *vFarm* work earlier today had passed
               spuriously, and it is worth recording next to this because the
               lesson shaped how I tested the gate. The server meant to have a
               failing notify URL never started — `Error: listen EADDRINUSE:
               address already in use 0.0.0.0:8797` — so the POST was answered
               by the previous process with notifications off. `notified_at` was
               null for the wrong reason, and a null reads identically either
               way.
Fix:        1. Probe `sources.CODEX_LAYER0` instead, with a comment saying why
               that table and not another: it is one of the seven that carries
               `Submission ID`, which is the one field name present in all of
               them. Section 4's note that there is no way to ask Airtable for
               record ids alone is the same bug's other half.
            2. Stub ids to exactly 14 characters. 0 rows became 5.
            3. Wrapped the caller's SQL in `LIMIT cap + 1` for real, and changed
               the note to say the count is a floor rather than a total.
            4. Added 19 and 26 to `typeName`.
            5. Re-ran it after confirming the boot line said notifications were
               *on* and asserting the webhook had actually been called (stub
               deliveries 9 → 10). Every test whose pass condition is an absence
               now proves the mechanism ran first.
Decision:   **The write gate ships as scaffolding with nothing destructive
            through it.** `resync` deliberately does not use it: copying rows
            that already exist, from a source this dashboard already reads, is
            not a change anybody needs to approve, and putting it behind a
            confirmation would teach a client that the confirmation is noise.
            The gate is here so the first real mutation does not invent the
            shape, and so the shape is tested before anything depends on it.

            **Enforced server-side, not in the client and not in the model.**
            Both of those vary with which client is connected and what a model
            decides in the moment. A mutating tool called without a token
            performs no change; the only thing that can mint a token is a
            preview this process computed.

            **The digest covers the whole record, not just the fields being
            changed.** A token minted against a row somebody has since edited
            stops matching, so "it changed underneath you" is detected rather
            than assumed. `redeem` is handed an operation rebuilt from a fresh
            read — passing the preview's own operation back would compare a
            value with itself and prove nothing.

            **Four refusals, not one "invalid token".** `token_expired`,
            `token_used`, `record_changed` and `token_unknown` want four
            different next moves: wait and re-preview, stop and read what
            already happened, re-read the record, and get a fresh preview. One
            collapsed error would be a shrug.

            **A replayed token is refused rather than repeated**, so a retry
            cannot double-apply, and **the audit write throws rather than
            swallowing** — if a change cannot be recorded it does not happen.
            That is the opposite of the Early Access notification hop, on
            purpose: a lead nobody announced is still a lead, but a mutation
            nobody recorded undercuts the premise that these tables are the
            record. A **preview is not logged**: a log that records intentions
            beside actions stops being a record of what happened.

            **`query_postgres` is read-only three separate ways** — statement
            shape, `BEGIN TRANSACTION READ ONLY`, unconditional rollback —
            because one would be a single point of failure on a tool a model
            drives. The row cap is a `LIMIT` and is reported as a floor.

            **The resync cooldown is keyed on the pass, not the kind.** Several
            kinds share one pass (`codex`, `clients`, `rt`, `pay`, `health`), so
            keying on the kind would let five calls run the same sweep five
            times. A second call inside 60 seconds is told "ran N seconds ago"
            rather than queued: a queue turns an impatient client into a load
            test on somebody else's API.

            **Annotations on every tool, old ones included.** The spec's default
            for an unannotated tool is *potentially destructive*, so twelve
            read-only tools that said nothing about themselves were being
            offered to clients as though any might delete something.

            **`SOURCE_OF` and `RESYNC_ROUTE` are `Record<MirrorKind, …>`**, so a
            new record kind cannot compile without declaring where it comes from
            and how it is refilled. `digests` declares `null` explicitly, which
            is a statement rather than an omission.

            **The request log redacts the secret.** `/mcp/<secret>` is recorded
            as the literal `/mcp/<secret>`, because `search_logs` reads that
            buffer and a tool that hands back the path secret would be a way to
            read the credential out through the endpoint it protects.
Verified:   Eleven acceptance checks, all against a local Postgres (5602) and an
            Airtable stub (8901) with the server on 8799.
             1. A `SELECT` with a bound parameter returns rows; an `UPDATE`, two
                semicolon-joined statements and a writable CTE are each refused
                by name. The cap is stated as a floor.
             2. `query_timeout` after 5000ms on `pg_sleep(10)`.
             3. `get_mirror_status` with no argument: all 18 kinds, each with a
                verdict; `pay_sessions` matched a direct count.
             4. `diff_source_vs_mirror('pay_sessions')`: source 5, mirror 0,
                difference 5, all five record ids named, pointing at `resync` —
                which is this morning's fault, reproduced exactly. After the
                resync: `Matched: 5 row(s) on both sides`.
             5. `describe_schema` returns real columns from `information_schema`;
                a table that does not exist gets a typed `not_found`.
             6. `get_page_data` with `fields: ["sessions_owed.n", …]` returned
                only those values, reported `nope.not_here` as not found, and
                omitted the byte cap entirely.
             7. `resync('pay_sessions')` 0 → 5 with the per-table report; the
                second call and a sibling kind both `too_soon`; `digests` →
                `no_resync`.
             8. `tools/list`: 13 tools, every one annotated, the twelve reads
                `readOnlyHint: true`.
             9. + 10. `npm run test:gate`: preview changes nothing, the token
                works once, and expired, replayed, stale-record and unknown
                tokens are each refused by name. `engine_mcp_writes` held
                `{"applied":1,"refused":4}` with before/after on the applied row
                — five rows for five outcomes.
            11. `npm run typecheck` and `npm run build` clean; `initialize`
                returns the new instructions; `search_logs` matched by route,
                status class and substring, with the secret appearing nowhere in
                the buffer.
Not tested: Against the deployed service. Egress to `dashboard.bhanetwork.org`
            and `bha-engine-dashboard.onrender.com` is 403 at the proxy from
            this session, so the live leg of the handshake is unverified here as
            it was on 18 Sep — the connector's own tools answering against the
            deployed commit is what confirmed that one. Nothing ran against the
            production database: migration 19 was proved on a copy.

## 2026-09-20 20:50 — the repair record: engine_repairs, the Repairs tab, and the one write to n8n
Intent:     Part two of the self-healing repair layer. Part one is a separate
            service, `bha-repair-bridge`, which receives a workflow failure from
            n8n, runs Claude Code against the failing workflow and reports what
            it did. This is the dashboard half: the row that keeps the result,
            the tab that shows it, and the revert that undoes it. The design
            rule set earlier and not negotiable — nothing heals invisibly: every
            failure ends as retried, repaired, or waiting on a person, and every
            repair shows the error, the root cause, the exact change, and a way
            back.
Files:      server/src/migrations.ts (migration 20, engine_repairs)
            server/src/repairs.ts (new, 480) — the write, the read, the revert
            server/src/n8n.ts — workflow(id) whole, and the one write
            server/src/index.ts — three routes
            src/data/types.ts, src/data/index.ts
            src/screens/EngineHealth/Repairs.tsx (new, 430)
            src/screens/EngineHealth/index.tsx — the sixth tab
            CLAUDE.md, README.md
Problem:    Part one could not be built in this session. `bhanetworkgh/bha-repair-bridge`
            does not exist yet: `list_repos` does not show it and `add_repo`
            answered `you don't have access to bhanetworkgh/bha-repair-bridge`.
            The prompt's own fallback is written the other way round — do part
            one, then check whether the dashboard can be opened — so the same
            rule was applied inverted: build the part that belongs to the repo
            this session has, in full, and say plainly that the other part needs
            a session on its own repo. No bridge code was written into this
            repo.

Problem:    **The spec's revert cannot be implemented as written, and it took
            reading n8n's actual API to see why.** The brief says the revert
            "restores the workflow to `version_before` through the n8n API".
            n8n's public API offers `PUT /api/v1/workflows/{id}`, which replaces
            a workflow with a body you supply, and **no endpoint that fetches a
            historical version by its id** — workflow history lives behind the
            internal REST API. So `version_before` names a restore point without
            containing it: on its own there is nothing to restore *from*.
Fix:        The revert restores from a **snapshot**, and the snapshot already
            exists at exactly the moment it matters — part one, step 5, reads the
            whole workflow before it edits anything, to capture the restore
            point. So `repairs.revert` reads the snapshot off the stored payload
            (`workflow_before`, and three other spellings, because the bridge is
            a separate deployment and this must work the day it sends one
            without a migration here), and where there is none it **refuses with
            that reason and names the manual route** — the workflow's own version
            history in n8n — rather than drawing a revert that did not happen.
            That is a fifth refusal the brief did not anticipate, `no_snapshot`,
            and it is the one the bridge's current result contract actually
            produces. **Part one should carry the snapshot on its result
            payload**; it is one field and the bridge already holds it.
            Checked against the live instance rather than assumed: the n8n
            connector's `get_workflow_history` on `iSr9sOV2AfhUQN7C` returns
            three versions, so history exists on this instance — but through a
            path this server's API key does not reach.

Problem:    A revert moved the row and left the strip above it reading the
            server's counts: "repaired and standing 3" over a table showing two.
Fix:        The two figures a revert moves — standing, and put back — are counted
            from the rows on screen rather than from the summary the server
            computed before the revert. Nothing else there changes on a revert,
            so the windows and the percentiles stay as the server computed them.
            This is the reconciliation bug the record pages and the Early Access
            tab each learned once; it is now three for three, which says the
            shape is worth pulling out rather than re-deriving.

Problem:    Two test-rig faults worth recording because both produced a
            confident wrong reading. `pkill -f "node n8n-stub.cjs"` killed its
            own shell (exit 144) — the third time that pattern has bitten this
            week. And the PUT-failure case was "tested" by putting
            `STUB_PUT_FAILS=1` in front of the *curl* rather than the stub, so
            the stub never refused anything and the check passed on a path that
            was never exercised.
Fix:        Kill by pid from `ss`, never by pattern. And prove the mechanism
            before trusting an absence: the stub was restarted in refusing mode
            and a direct PUT confirmed as 400 *before* the revert was driven
            through the server. Same lesson as the notify-URL check earlier
            today, applied without being re-taught.
Decision:   **`engine_repairs` is not a mirror table**, for the reason
            `engine_vfarm_leads` is not: the rows are born of this engine's own
            repair loop rather than copied out of Airtable, so there is no
            upstream field name to keep verbatim and the columns are real
            columns. `repair_id` is unique because the bridge posts once and n8n
            retries a failed HTTP node — the same reason the execution table is
            keyed on n8n's own id.

            **The whole payload is stored beside the columns.** The columns are
            the read model, the blob is the record. A field the bridge adds
            before this dashboard reads it is kept rather than dropped, which is
            the rule that keeps `retries_attempted` inside the incident blob with
            no way onto the page — and it is what makes the snapshot work the
            day part one starts sending one.

            **An unknown outcome is refused with a 422 naming it**, never filed
            under `error` or `unknown`. The five names are the vocabulary the two
            services share; a sixth arriving means they have drifted, and a row
            nobody can interpret is worse than a refused write.

            **`reverted_at` is stamped only after n8n agrees**, and a refused
            revert leaves the row exactly as it was — it stays revertible, with
            the new reason. A row claiming a revert that did not happen is worse
            than no revert at all.

            **Every guard is on the server and the answer names which one
            refused.** `can_revert` and its reason are computed once, server
            side, and the page asks rather than deciding a second time, so the
            button and the endpoint cannot disagree. The version check is the
            one guard that costs a live read, so it runs when somebody asks to
            revert rather than forty times for a list of forty rows.

            **The revert is the one write to n8n and it lives in `n8n.ts`.**
            That file declared itself read-only and now declares the exception
            instead, so every use of `N8N_API_KEY` stays in one file. Nothing
            there edits, activates, deactivates or deletes a workflow, and
            section 3 still holds everywhere else. **`active` is never sent**: a
            restore that switched a live workflow on or off would be a second
            change nobody asked for.

            **`repaired` is not green.** A machine changed a live workflow, which
            is worth reading rather than celebrating, so it carries the accent.
            Colour marks only what needs somebody: needing a person, and not
            repaired.

            **Repairs is a sixth tab rather than a section inside an existing
            one.** Retries is what the healer retried on its own and Repairs is
            what the bridge changed in a workflow — the two halves of what
            happened after a failure — and the tab reads its own route rather
            than the health payload, which is keyed on the three lanes and has
            nothing to do with these rows.
Verified:   Eight acceptance checks, against Postgres 16 on 5603, an n8n stub on
            8903 and the server on 8801.
            1. **Migration** — a database brought to 19 by the pre-change
               `migrations.ts` (`applied 1–19`) then applied **20 alone**
               (`applied: [20] | already: 19`), and re-ran as
               `applied: [] | already: 20`. All 23 columns, three indexes and
               the unique constraint on `repair_id` match the spec.
            2. **The write** — 201 `inserted`, then the same `repair_id` again
               201→200 `updated`, one row, total unchanged. An unknown outcome
               and a missing `repair_id` each 422 with their own sentence; no
               `x-dashboard-key` 401. All five outcomes, refusals included, on
               the `engine_writes` log as `kind=repairs`.
            3. **The read** — 401 signed out, 200 signed in. 8 rows newest
               first, summary `{total 8, 7d 8, standing, reverted, p50, p95,
               timed}` matching the rows, `by_outcome` summing to the total, and
               `can_revert` false on every non-repaired row with the reason
               naming the guard.
            4. **The revert** — `ok: true`, the stub's held workflow went from
               `[{"name":"After the repair"}]` to `[{"name":"Codex Read Builder
               Tab"}]` on a new version id, one PUT carrying name, nodes,
               connections and settings, `reverted_by` and `reverted_at` stamped,
               the restored version recorded in the payload, and the PUT on the
               write log.
            5. **Refused where the version moved on** — the stub moved to
               `v-someone-edited-it`; the revert answered `version_moved_on`
               naming both versions, `reverted_at` stayed null and **zero PUTs
               were made**.
            6. **The tab** — six tabs; the strip read 8 / 2 standing / 1 needing
               a person / 2 not repaired / 71 s with p95 142 s; eight rows newest
               first with repaired, needs-a-person, not-repaired, bridge-error,
               skipped and reverted each drawn differently; the needs-human row
               carried its `human_action` on the row; the panel showed the root
               cause, the change, the nodes, both version ids and the error; the
               confirmation named the workflow and said the failure returns; the
               revert landed and the row and the strip both moved (standing 3→2,
               put back 1→2). No horizontal overflow. The only console errors
               are the Google Fonts stylesheet failing this sandbox's TLS
               interception, on every page.
            7. **No sample data** — there was none to remove. The brief expected
               placeholder repair rows marked `sample`; this repo has no repair
               fixture, and `src/data/fixtures/` holds only builders, chat,
               incidents, twins and vfarm. Engine health has read real mirrored
               rows since it was built on 17 Sep.
            8. **`npm run build`** — clean, and `npm run typecheck` with it.
            Also proved: the other four guards by name (`already_reverted`,
            `not_a_repair`, `not_found`, `no_snapshot`), and `n8n_refused` with
            the stub actually refusing the PUT — the row untouched, still
            revertible, and the refusal on the write log.
Not tested: Against the live n8n instance or the production database. No revert
            has been made against a real workflow: the stub mimics the one
            behaviour the code depends on (a PUT mints a new version rather than
            resurrecting the old id) but nobody has confirmed that
            `PUT /api/v1/workflows/{id}` is accepted by the key on Render —
            **that key has been read-only until now and may need workflow write
            scope**, which is the first thing to check, and the same class of
            failure as the Airtable token re-scoping on 14 and 17 Sep. The
            bridge does not exist yet, so nothing has posted a real result and
            no payload has carried a real snapshot.

## 2026-09-20 21:05 — the Airtable liveness probe names no field
Intent:     Fix `get_health`'s Airtable probe properly. It called
            `airtable.listRecordIds`, which hardcodes the field `Submission ID`
            — present on the six builder tables and Layer 0 and nowhere else —
            against Build Patterns, whose id field is `pattern_id`. Airtable
            refuses the whole request on one unknown field name, so the probe
            reported the whole of Airtable as unreachable while the token was
            working perfectly.
Files:      server/src/airtable.ts (probeReachable, new, beside listRecordIds)
            server/src/mcp/tools.ts (the get_health probe)
            CLAUDE.md
Problem:    Confirmed live on 2026-09-20 at 19:43 UTC: `reachable false`, 2244ms,
            `Unknown field name: "Submission ID"`. The same call also explains
            the eight seconds seen on 18 Sep — `listRecordIds` pages to the end
            at 100 records a page with a 220ms pace delay between pages, and
            Build Patterns holds 175 records, so the probe was walking the whole
            table to answer a yes/no question.
Problem:    **My own first fix, earlier today, was the wrong one and this is
            worth writing down.** It moved the probe to the Layer 0 table, which
            *does* carry `Submission ID`. That made the answer true and left the
            trap armed: the field name was still hardcoded, so the next person
            to repoint the probe would have found it exactly the same way. And
            it did not make the probe cheap — measured live on main through the
            deployed connector at 21:00 UTC today, commit 8ba479a: **reachable
            true, 2,661ms**, which is *slower* than the broken version's 2,244ms,
            because it now walks Layer 0 to completion instead of being refused
            on the first page. A probe that takes two and a half seconds to
            answer "yes" is still the wrong shape.
Fix:        `probeReachable(base, table, timeoutMs)` — one request,
            `?maxRecords=1`, **no `fields[]` at all**, no `offset` followed. It
            returns how many records came back (0 or 1); the number is not the
            point, having got an answer at all is. `get_health` points at
            `sources.PATTERNS` again, because the probe can no longer break on a
            table's schema: it asks about no schema.
Decision:   **The rule, rather than the repair: a liveness probe names no
            field.** Any field name a probe hardcodes is a field that can be
            absent from whichever table it is later pointed at. Picking a better
            field would have been a fix for today and a bug for whoever repoints
            it.
Decision:   **`listRecordIds` and `ID_PROBE_FIELD` are untouched.** They are
            correct for their real callers — the Codex reconciliation reads the
            six builder tables and Layer 0, where the field exists — and both
            the field and the paging are load-bearing there: a partial read
            would look exactly like a table somebody had emptied, which is the
            one mistake that pass must never make. This was not a rename.
Decision:   **The `get_health` contract is unchanged.** Same keys, same
            ordering, same per-source keys, same credentials, same
            not-configured wording. Exactly one line of its output differs — the
            `source` label, which names which table is probed and how, and had
            to change because both of those did.
Verified:   Five checks. The stub used is a replay that **refuses exactly what
            Airtable refuses** — 422 `Unknown field name: "…"` on any field the
            table has not got — and that offers an `offset` even on a
            `maxRecords=1` read, which the real API would not, deliberately, so
            that a probe which followed offset would be caught here rather than
            in production.
            1. **One request, no field, no paging** — `probeReachable` against
               Build Patterns issued exactly one request,
               `GET /v0/app5ni3E8r7Lvxk22/tblaMXSMjmz30OvcU?maxRecords=1`:
               `fields[]` empty, no `pageSize`, no `offset`, and the offset the
               stub offered was not followed. Returned 1.
            2. **Reachable true** — `get_health`'s Airtable probe now answers
               `reachable: true, detail: "answered"` against the Build Patterns
               table it used to fail on. **Not yet measured live**: this session
               holds no `AIRTABLE_TOKEN` and the deployed commit is main, so the
               live figure has to be read with one `get_health` call after this
               deploys. The baseline to beat is the 2,661ms measured on main
               today, and the new probe is one round trip with no pace delay —
               the other single-call probes on that deploy answer in 65–355ms.
               Live evidence for the request itself: the Airtable connector read
               that exact table with `pageSize=1` successfully, 175 records
               total, one returned.
            3. **Output otherwise identical** — the two builds run against the
               same stub with the same environment differ by a single line, the
               `source` label. Top-level keys, source count and order,
               per-source keys, credentials, `configured` flags and every
               `is not set` sentence are byte-identical.
            4. **Existing callers unchanged** — `listRecordIds` against a
               submissions-shaped table still returns its 12 ids, still asks for
               `Submission ID`, still pages at 100. `ID_PROBE_FIELD` is still
               `Submission ID`. The fault also still reproduces against Build
               Patterns, refused on its first page, which is the proof the stub
               is faithful.
            5. **`npm run build`** — clean, and `npm run typecheck` with it.
            Every other caller of `listRecordIds` was checked: there is exactly
            one, `server/src/codex.ts:191`, and it reads the six builder tables
            and Layer 0 through `SUBMISSIONS_BASE_ID` — all of which carry
            `Submission ID`. Nothing else in the server calls it.
Not tested: The live latency of the new probe, for the reason above. Nothing ran
            against the production database or a real Airtable token from this
            session.

## 2026-09-21 13:20 — n8n can read and part-update the engine tables; the Airtable write-back goes behind a flag
Intent:     Cut Airtable out of the engine. BHA's shared Airtable workspace hit
            its monthly API cap on 20 Sep at about 23:00 UTC and every n8n
            workflow that reads or writes Airtable is failing. Every Airtable
            node becomes an HTTPS call to this dashboard and this dashboard's
            Postgres becomes the only record. n8n could already WRITE a whole
            record through `POST /api/engine/:kind`; it could not read one back
            and it could not change part of one, which an Airtable node does
            constantly. Both, now. And the write-back this server does to
            Airtable when somebody edits a page is about to be pointless, so it
            goes behind a flag rather than being left to fail or deleted.
Files:      server/src/mirror.ts     lookup(), patchFields(), columnsOf(), the
                                     `read` outcome on the write log
            server/src/index.ts      GET /api/engine/:kind,
                                     PATCH /api/engine/:kind/:id, the boot line,
                                     airtable_writeback on /api/status
            server/src/airtable.ts   AIRTABLE_WRITEBACK, writebackEnabled(),
                                     WRITEBACK_OFF_REASON
            server/src/loops.ts      apply() and retryDelete() behind the flag
            server/src/codex.ts      setStatus() and remove() behind the flag
            server/src/store.ts      a builder move lands in Postgres when the
                                     write-back is off
            src/data/types.ts        ServerStatus.airtable_writeback
            src/data/index.ts        deleteCodexEntry returns the Airtable state
            src/screens/Settings.tsx three states on the Airtable row, not two
            src/screens/Codex.tsx    the delete toast is worded from what
                                     actually happened on the other side
            src/screens/Registry/index.tsx  "Lookups answered" as its own figure
            README.md, CLAUDE.md, render.yaml, .env.example
Decision:   **n8n never connects to Postgres.** `bha-engine-db` stays closed to
            everything outside its own Render environment, exactly as
            render.yaml intends. These two routes are the whole of what reaches
            it from outside, behind the service key that is already in n8n's
            hands. A second credential would be a second thing to rotate.
Decision:   **The lookup is the only readable thing under `/api/engine`.** The
            403 that covered the whole prefix still covers every other method
            and path, and the in-process loopback `get_page_data` reads through
            (`dispatchApi`) still refuses the prefix by name whatever the method
            — that guard is untouched, at index.ts:1126.
Decision:   **Which columns a table has is read from `information_schema`, not
            derived from the kind's spec.** Deriving it looked obvious and is
            already wrong on a live table: `engine_client_requests` carries
            `table_id` although its `KindSpec` sets `perLaneTable: false`, so a
            guess from the flags would have refused a filter the column
            supports. Cached for the life of the process, because the schema
            only changes in a migration and migrations run at boot. Two of the
            three faults found through the MCP server on 20 Sep were a name
            assumed rather than read; this reads.
Decision:   **A filter naming a column that kind has not got is a 400, not a
            shrug.** `GET /api/engine/patterns?builder_id=hardik` answers
            `"builder_id" is not a column Build Patterns holds … patterns can be
            filtered on: id, airtable_record_id, natural_id`. Ignoring an
            unsupported filter would answer a different question confidently,
            which is the failure this dashboard exists to remove.
Decision:   **`count` is every row that matched, never the page.** A window
            function in the same statement rather than a second query: two
            statements can disagree across a concurrent write and one cannot,
            and `count(*) OVER ()` is evaluated before the LIMIT.
Decision:   **Field names are bound parameters.** They arrive from the query
            string — `f.Jason%20Status`, `f.Layer1%20Review%20` with the
            trailing space that field really has — and go into the statement as
            `$n` on the right of `->>`. The only things interpolated into the
            SQL are the table and column names, and both come from `KINDS` and
            from the database's own `information_schema`, so neither can carry
            anything a caller sent.
Decision:   **PATCH re-derives the promoted columns from the merged blob**, the
            same way `prepare()` derives them on a POST, so they cannot drift
            from the thing they are a copy of. `builder_id` and `table_id` are
            deliberately not among them: those are not fields, they are which of
            the seven tables the row sits in, and changing one is a move rather
            than an edit — the rule section 4 already states.
Decision:   **A key sent as `null` is removed, and that is why the merge is not
            just `||`.** `fields || $patch` would store a JSON null and the
            field would read as present and empty. The null keys are stripped
            out of the patch object and applied as `- $keys::text[]` instead, so
            removing and setting in one body both work and neither is a string
            concatenation.
Decision:   **A lookup is logged as `read`.** It is on `engine_writes` because
            it is the same surface with the same key; it is its own outcome
            because a reader counting what the engine wrote has to be able to
            leave the reads out. The Engine writes tab therefore gained a
            "Lookups answered" figure of its own rather than folding them into
            "Writes accepted" — a strip whose figures no longer add up to the
            rows beneath it is the quietly-wrong number this dashboard exists to
            remove.
Decision:   **`AIRTABLE_WRITEBACK` is off by default and the code is not
            deleted.** The four write paths (`loops.apply`, `loops.retryDelete`,
            `codex.setStatus`, `codex.remove`) answer `skipped` rather than
            `failed`, and `unlanded()` in the interface treats only `failed` and
            `duplicate` as a disagreement — so the row carries no marker, the
            panel carries no warning, and the toast says what the save said.
            A loop edit that tried and failed would cost fifteen seconds of
            somebody's time and then mark the row "not in Airtable", which is a
            warning about a system that is deliberately no longer the record.
Decision:   **With the write-back off, a builder move lands in Postgres.** The
            standing rule is that a move is claimed only once Airtable has made
            it, because which table a row sits in is a fact about Airtable. With
            nothing asking Airtable that rule has no arbiter: the move lands
            here or it has not happened, and holding it back would leave the
            save doing nothing with nothing on screen saying so — the same
            failure the rule was written to prevent, in the other direction.
Decision:   **Retry now on a duplicate still reports the duplicate.** That is
            not a page edit that saved: it is a button that exists to delete a
            row in Airtable, the loop really is still in two tables, and saying
            nothing would be claiming a repair that did not happen. It stays
            `duplicate`, names the flag, and works the moment the flag goes on.
Decision:   **The resync buttons and their code are untouched**, as asked. They
            are reads, not write-backs, and they are how the final import
            happens once the cap resets. They come out in their own change.
Problem:    `column reference "fields" is ambiguous` — the first PATCH against a
            real row. The merge expression was `((fields || $2::jsonb) - …)` and
            the CTE holding the before-image carries a `fields` column too, so
            the reference was ambiguous once it was joined in and Postgres
            refused the whole statement. `upsert()` twenty lines above already
            carries a note about exactly this on its own two COALESCEs, which is
            where the fix came from.
Fix:        Qualified with the target alias: `((t.fields || $2::jsonb) - …)`.
            Worth recording because the refusal was total and the row was left
            untouched — which is the right failure, but it means a smoke test
            that only checked the HTTP status of a 404 would have passed.
Verified:   Against a local Postgres 16 seeded with **twelve real production
            rows read out of bha-engine-db** — six loops whole, six Codex
            submissions with six long text fields (`Transcript`, `Summary`,
            `Session Description`, both reviews, `Builder Channel Post`) left
            behind because they are transcripts. Every field name and value
            below is the engine's own. **Nothing was written to production**:
            the deployed commit does not carry this code, and the only
            production access used was read-only SELECTs through the MCP
            server. The predicates the route builds were then run against the
            **full live tables** separately — see 10 below.
            1. **GET, no filter** — `count: 6, rows: 6`, newest first:
               id=5 rec2iARVZbn30iLMD LOOP-1788610001003-ORGA jason In Progress
               id=4 recBwqXmgnsPIdDbj LOOP-1787940296462-6075 jason In Progress
               id=2 recoIcI39nOYVJ3D0 LOOP-1787940022681-3NI1 hardik Open
               id=1 rec0ABnymhjUdZc31 LOOP-1788044070650-3DBC hardik Open
               id=6 rec5nyLa185vkEJRa LOOP-1788044070647-91IC jason Closed
               id=3 recNeFQnR31JEdwGk LOOP-1788044070646-TFYK jason In Progress
            2. **Each column filter** — `id=3` → 1 (LOOP-…-TFYK);
               `airtable_record_id=rec2iARVZbn30iLMD` → 1 (LOOP-…-ORGA);
               `natural_id=LOOP-1788044070647-91IC` → 1;
               `builder_id=hardik` → 2; `table_id=tblVOLhWULskNiIUt` → 4.
               And `patterns?builder_id=hardik` → **HTTP 400**, naming
               `id, airtable_record_id, natural_id` as the ones that kind has.
            3. **One `f.` filter** — `f.Status=Open` → 2, both lane_tag NS.
            4. **Two `f.` filters** — `f.Status=In Progress` AND
               `f.lane_tag=VFARM_HARDWARE` → 2 (…-6075, …-TFYK). The same first
               filter with `f.lane_tag=BAYS` → 1 (…-ORGA), which is the proof
               they AND rather than OR.
            5. **A field name with a space** — `f.Raised By=Jeganathan` → 2,
               both carrying `"Raised By": "Jeganathan"`;
               `f.Date Raised=2026-08-28` → 2; and on Codex,
               `f.Jason Status=Approved` AND `f.Session Type=Build` → 3, two
               spaced names ANDed in one request.
            6. **order and limit** — `order=created_asc&limit=3` returned the
               three oldest and `count: 6`, so the count is the total and not
               the page; `created_desc&limit=3` the three newest.
               `limit=lots`, `order=sideways` and `id=notanumber` are each a 400
               naming the parameter; `limit=99999` is clamped, not refused.
            7. **PATCH one field on a real row** — id=3,
               LOOP-1788044070646-TFYK, `{"fields":{"Status":"Closed"}}` →
               `ok: true, changed: true`. Read back and diffed key by key:
               **8 of 9 keys untouched, 1 changed.** `What`, `loop_id`,
               `lane_tag`, `Raised By`, `Date Raised`, `Source Link`,
               `last_modified` and `Assignee Slack User ID` byte-identical;
               `Status` "In Progress" → "Closed". `id`, `airtable_record_id`,
               `natural_id`, `builder_id`, `table_id` and `created_time`
               unchanged; `source` airtable → engine and `updated_at`
               2026-09-13T21:27:27.366Z → 2026-09-21T13:10:03.437Z, both
               intended. The same PATCH again → `changed: false`.
               Adding `raised_in` → 10 keys; sending it as `null` → 9 keys and
               the key absent, not null. Patching `loop_id` moved the
               `natural_id` column with it and moving it back moved it back;
               on a commercial card, patching `lane_id` inside `fields` moved
               the promoted `lane_id` column, which nothing sent in the
               envelope. A row id that does not exist → **404**.
            8. **401 without the key** — GET with no header, GET with a wrong
               key, PATCH with no header, PATCH with a wrong key and POST with
               no header all answer **401** with the identical body,
               `The x-dashboard-key header is missing or wrong.` The row the two
               refused PATCHes named was read back afterwards and had not moved.
            9. **POST is exactly as before** — insert → `inserted / insert`;
               the same payload again → `unchanged / airtable_record_id`; a
               changed payload → `updated / airtable_record_id`; no `fields` →
               the same 422; `/api/engine/pay` with no `kind` → the same 422;
               a malformed `record_id` (rec + 13) → the same refusal. A `PUT`
               still 405s, now naming all three methods the route answers.
               And the difference the whole change is for, on one row: a POST
               carrying two keys left the row holding two keys; a PATCH naming
               one key left it holding three, `Status` kept.
           10. **The same predicates against the live tables** (read-only, via
               the deployed MCP server, 946 loops and 199 Codex rows):
               `f.Status=Open` → 636; `f.Status=Open AND f.lane_tag=VFARM_HARDWARE`
               → 47; `f.Raised By=Jeganathan` → 32; `builder_id=hardik` → 146;
               `table_id=tblVOLhWULskNiIUt` → 19;
               `f.Jason Status=Approved` → 179; with `f.Session Type=Build`
               → 106; `f.Layer1 Review ` — **the name that really ends in a
               space** — is non-null on all 199.
           11. **Injection is a value, not SQL.** `f.Status') OR 1=1 --=x`,
               `f.Status" OR ""="=x` and
               `f.Status=Open'; DROP TABLE engine_loops; --` each answer
               HTTP 200 `count: 0`; both tables still hold their rows, locally
               and (the last one, as a parameter) against production. A bare
               `f.=x` is refused, which is the rule Airtable itself enforces on
               an empty field name.
           12. **The write log tells them apart** — GET read 20, GET rejected 4,
               GET unauthorised 4, PATCH updated 6, PATCH unchanged 1, PATCH
               rejected 5, PATCH unauthorised 2, POST inserted 2, POST rejected
               7, POST unauthorised 1. A lookup's detail line is what was asked
               and what came back: `no filter → 6 of 6`, `id=3 → 1 of 1`.
           13. **The write-back flag, both ways.** Unset: `writebackEnabled()`
               false; `loops.apply`, `codex.setStatus` and `codex.remove` all
               `skipped` naming the variable; `loops.retryDelete` `duplicate`
               naming it. `store.editLoop` saved Status and What to Postgres
               with `source = ui`, returned `writeback.state = "skipped"`, and
               `unlanded` — the marker the row would carry — was **false**.
               `writebackFailures()`, which is what Settings prints, stayed 0.
               A builder move with the flag off moved the row in Postgres:
               hardik/tblaloC4JIRdBq5EM → destiny/tblBJekl3ROpNZxQW.
               With `AIRTABLE_WRITEBACK=true` the same four paths ran again and
               failed for want of a token, which is the proof they were reached
               rather than removed. `1 true on yes TRUE` → on; `0 false off no`,
               empty and unset → off.
           14. **The Airtable cap, confirmed live** — `get_health` against the
               deployed service at 12:57 UTC today: postgres reachable 4ms,
               all three BHARAG lanes reachable, n8n reachable, and
               **airtable `reachable: false`, 398ms, `Airtable answered 429.`**
               The token is fine; the workspace is over its cap.
           15. **`npm run build`, `npm run typecheck` and `npm run test:gate`**
               — all clean, the gate's eight assertions included.
Not tested: Against the production database or the deployed service — neither
            has this code until this commit deploys. No production row was
            written by any part of this. The n8n side does not exist yet: no
            workflow has been repointed at these routes, so nothing has called
            them except this session. The volume question is open and worth
            watching — once n8n reads through the lookup, `engine_writes` will
            carry a row per read, and the Recent writes list on the Engine
            writes tab is unfiltered; if reads start drowning the writes there,
            that list wants a filter rather than the logging being dropped.

## 2026-09-22 09:10 — everything Bays needs to come off Airtable, and a final import that loses nothing
Intent:     North Star's four workflows are through the cutover and reading and
            writing through /api/engine. Bays is next: ~19 workflows and 100+
            Airtable nodes. The lookup shipped yesterday only does equality, an
            Airtable node does a great deal more, four tables Bays uses were
            never mirrored at all, and a plain resync after the cap resets
            would silently undo everything the engine has done since. All four.
Files:      server/src/mirror.ts        six lookup operators, four new kinds,
                                        an explicit natural_id, resolveNatural,
                                        needsTableId
            server/src/index.ts         the operators, PATCH by-natural, the
                                        final-import route, the 410s, the boot
                                        line, airtable_retired on /api/status
            server/src/finalImport.ts   new — the last read of Airtable
            server/src/airtable.ts      AIRTABLE_RETIRED, RETIRED_REASON
            server/src/store.ts         the loops-resync fault, and the Codex
                                        reconciliation behind the retirement
            server/src/migrations.ts    migration 21: four tables, three
                                        registry notes
            server/src/mcp/tools.ts     get_health, and the resync tool
            server/src/mcp/inventory.ts SOURCE_OF, RESYNC_ROUTE, the retirement
            src/App.tsx                 the two record routes, as splats
            src/components/Layout.tsx   the fade-in keyed on the page
            src/components/ui/RecordLink.tsx   new — the shared link hook
            src/components/ui/Resync.tsx       the buttons hide when retired
            src/screens/EngineHealth/FinalImport.tsx   new — the button and report
            src/screens/EngineHealth/index.tsx, OpenLoops/index.tsx, Codex.tsx
            src/data/index.ts, src/data/types.ts
            README.md, CLAUDE.md, render.yaml, .env.example
Decision:   **Six operators, and `nf.` is the one with a rule behind it.**
            `f.` equals, `nf.` does not, `c.` contains case-insensitively,
            `in.` any of, `gte.`/`lte.` string comparison. `nf.` is
            `IS DISTINCT FROM`, not `<>`: a missing field reads NULL and
            `NULL <> 'Closed'` is NULL rather than true, so `<>` would silently
            drop every row that never had a Status — on a schema that grew over
            months, most of the old ones. "Not closed" has to include "never
            had a status".
Decision:   **`c.` is `strpos` on the lower-cased pair, never `ILIKE '%…%'`.**
            A value containing `%` or `_` would otherwise be read as a wildcard
            and a search for "100%" would match everything.
Decision:   **`gte.`/`lte.` are string comparisons and are refused on `id`.**
            Airtable's dates are ISO strings and sort correctly as text, so they
            are exact on a date and wrong on a number. `id` is the one genuinely
            numeric thing here, so it is exact-match only rather than quietly
            sorting 9 after 100.
Decision:   **The five column names are reserved, and that was checked rather
            than assumed.** A filter naming `id`, `airtable_record_id`,
            `natural_id`, `builder_id` or `table_id` addresses the column, never
            a blob key of the same name. Queried across all eighteen mirror
            tables first: the only blob key with one of those names is
            `builder_id` on the 61 digest rows, and that column is derived from
            precisely that key, so the two answer identically.
Decision:   **An explicit `natural_id` in the envelope, and only where the kind
            has no natural field.** Review Returns, Lane Backlog and Deep Think
            Log have no id column this dashboard can name, so n8n supplies one;
            `keyOnNatural: true` then makes it a real key, which is the only way
            a kind with no Airtable record id can be idempotent. Sending it for
            a kind that derives its own is **refused**, not ignored and not
            preferred: the blob and the column would be two statements about one
            key, and the column is what every lookup and every upsert matches on.
Decision:   **Nothing needed a `keyOnNatural` fix.** The brief expected some of
            the twelve kinds Bays creates rows in to refuse a write with no
            record id. None of them did — all twelve were already
            `keyOnNatural: true`. Said plainly rather than claiming a fix that
            was not made; the test below is the evidence, and it covers all
            sixteen kinds rather than the twelve asked for.
Decision:   **`by-natural` refuses a duplicate rather than picking.**
            `natural_id` is indexed and deliberately not unique — a row the
            engine wrote before Airtable had one can sit beside the Airtable
            copy until the two are adopted — so two matches is a real state. A
            409 names both ids and the caller says which with PATCH /:id.
Decision:   **The four new kinds are engine-only and no table id is recorded for
            two of them.** Nothing resyncs any of them, and after the cutover no
            second copy exists. Lane Backlog and Deep Think Log are named by
            their base alone: this server never reads that base, so a table id
            would be a constant with no caller, and a constant with no caller is
            one nobody notices going stale.
Decision:   **The final import is a different pass, not a flag on the resync.**
            A resync is Airtable-wins and deletes what Airtable no longer has.
            Run after the cutover it would take a loop Bays closed here and
            reopen it, because the Airtable row still says Open — and it would
            delete every row the engine has created here since, because none of
            them has an Airtable copy. One function that sometimes lets Airtable
            win and sometimes does not is one nobody can reason about at the
            moment they are about to run it, so it is its own file with its own
            rule and **no delete anywhere in it**.
Decision:   **The cutover line is a constant, not a parameter.** 2026-09-21T00:00Z.
            A caller that could move it could move it past a real change, and
            the entire value of this pass is that it cannot silently overwrite
            one. The decision is made from the row's own `source` and
            `updated_at`, afresh on every run, which is what makes it safe to
            run twice.
Decision:   **The final-import button runs the nine groups one after another.**
            Nine full sweeps of somebody else's API from one click is how a
            careful pass turns into a rate limit — and the workspace is over its
            cap already, which is why this exists. A group that fails is named
            and the rest still run.
Decision:   **`AIRTABLE_RETIRED` reports Airtable as retired, not healthy and
            not unreachable.** Both of those are claims about a live dependency
            and it is neither; an amber line about a system nothing depends on
            is a warning nobody can act on. The routes answer **410**, not 404:
            the route was there, it did something, and it is finished, which is
            what somebody re-running a saved request needs to be told.
Decision:   **Retired forces the write-back off.** A flag saying "do not look at
            Airtable" and one saying "do write to Airtable" cannot both be
            honoured, and only one of them can be honoured safely, so the
            retirement decides rather than whichever was read last.
Decision:   **Records are addressed by their own id.** `/open-loops/<loop_id>`,
            `/codex/<Codex Entry ID>` — never this database's row id, which
            means nothing outside it, and never the Airtable record id, which
            **changes when a loop moves between builder tables**: a link built on
            one breaks at exactly the moment somebody is following it.
Problem:    **The Open loops "Resync from Airtable" button has never stored a
            row, and still had not on main this morning.** Measured against a
            replay of all seven builder tables: `ran=true, inserted=0,
            updated=0, unchanged=0, deleted=0, refused=7`, with
            `"builder_id" is required for loops` against every record.
Fix:        `store.resync` passed `table_id` for client questions and null for
            everything else; `loops` is a per-builder kind, where the table a
            row sits in *is* its owner, so `prepare()` refused every row. Now
            `mirror.needsTableId(kind)`, derived from the spec rather than
            listed, so the next per-builder kind cannot be forgotten the same
            way. The same one-line fault was in the new final import and was
            found by it. The Codex resync was always correct — it passes both —
            which is why only loops was affected. After the fix, against the
            same replay: 1 inserted, 0 updated, 5 unchanged, 1 kept, **0 refused**.
Problem:    **A link to a record this dashboard does not hold answered with
            silence.** The page set the toast saying so and the toast vanished
            within milliseconds. Found in a browser; invisible in the code.
Fix:        Three attempts, two of which look right and are worth recording.
            (1) Two `<Route>`s for one component are two elements, so moving
            between `/open-loops/X` and `/open-loops` unmounts one and mounts
            the other. (2) One route with an **optional** param (`:recordId?`)
            reads like the fix and is not — React Router expands an optional
            segment into two ranked branches internally, so it still remounts;
            confirmed by the hook logging `ready: false, rows: 0` on the second
            pass. (3) The real cause was underneath both: `Layout` keyed the
            page container on `location.pathname` to replay the fade-in, so
            **every** URL change rebuilt the page. Keyed on the first path
            segment now — the page, which is what the animation is about — and
            the route is a splat so one pattern matches both shapes.
Problem:    **With the retirement on, the Codex page still read Airtable on
            every load — and deleted.** Its reconciliation removes rows Airtable
            no longer has. Pointed at a replay that answered the six builder
            tables with no records, one page load took the page from six entries
            to none.
Fix:        `runReconcile` returns early when `airtable.retired()`, naming the
            reason. This is the most important half of the flag: left running
            after the cutover, the first page load would quietly delete every
            Codex entry the engine had written since.
Problem:    A race between the two effects in the record-link hook: the first
            set the open record, the second still saw `openId` as null in the
            same commit and navigated back to the bare page, wiping the id out
            of the path before the first had been reflected. The link opened
            nothing, silently.
Fix:        A `settled` flag, set by the first effect and required by the
            second.
Verified:   Against a local Postgres 16 holding twelve real production rows read
            out of bha-engine-db, an Airtable replay that refuses exactly what
            Airtable refuses, and **a real browser** (Chromium via Playwright,
            installed outside the repo so nothing was added to package.json).
            **Nothing was written to production**: the only production access
            was read-only SELECTs through the MCP server.
            1. **Every operator, against the six real loops** — `f.Status=Open`
               2; `nf.Status=Closed` 5; `in.Status=Open,Closed` 3;
               `c.Status=progress` 3 (case-insensitive);
               `gte.Date Raised=2026-08-28` 3; `lte.Date Raised=2026-08-25` 3;
               the two ANDed 4. `nf.Source Link=x` returned **6 of 6**,
               including the three rows that have no Source Link at all, which
               is the rule that operator exists for. `c.What=100%` returned 0 of
               6 — a literal percent, not a wildcard.
            2. **On the promoted columns** — `in.builder_id=hardik,jason` 6;
               `nf.builder_id=jason` 2; `c.natural_id=17880` 3;
               `gte.natural_id=LOOP-1788` 4; `in.id=1,3,6` 3.
            3. **The refusals** — `gte.id=3` 400 naming why ("id is a number, so
               it would sort 9 after 100"); `in.Status=` 400; `f.=x` 400;
               `c.builder_id` on patterns 400 naming the columns that kind has.
            4. **Against the LIVE tables** (read-only, through the deployed MCP
               server, 946 loops and 199 Codex rows): `f.Status=Open` **636**,
               `f.Status=In Progress` **73**, `f.Status=Closed` **237**, and
               **`nf.Status=Closed` 709 — exactly 636 + 73**, which is the
               figure the brief named. `in.Status=Open,In Progress` is 709 too.
               `gte.Date Raised=2026-09-01` 319 and `lte.…=2026-08-31` 627 sum
               to 946, the whole table. Loops with no Status at all: 0, so on
               this data `nf.` and `in.` agree — the difference shows on a table
               where the field is sometimes absent, which is why the six-row
               `nf.Source Link` case above is the one that proves it.
            5. **POST with no `record_id`, one payload per kind, all sixteen** —
               loops, codex, layer0, patterns, commercial, pay_sessions,
               pay_statements, digests, error_counts, retry_attempts, rt-asks,
               rt-jobs, and the four new ones. **16 of 16 inserted**, every one
               `matched_on=insert` with `airtable_record_id: null`. The same
               sixteen payloads again: **16 of 16 `unchanged`, matched on
               `natural_id`** — an upsert, never a duplicate.
            6. **PATCH by-natural on a real loop** — LOOP-1788044070646-TFYK,
               `{"fields":{"Status":"Closed"}}` → HTTP 200, `changed: true`,
               id 3. Read back and diffed key by key: **8 of 9 keys untouched**,
               `Status` "In Progress" → "Closed", every column unchanged but
               `source` (airtable → engine) and `updated_at`. A natural id
               naming nothing → **404**; a deliberately duplicated natural id →
               **409** naming both rows, `3 (recNeFQnR31JEdwGk), 7 (no Airtable
               record id)`.
            7. **The final import** — against a replay holding the six real
               loops with one edited in Airtable, plus one loop Airtable has and
               this database does not, and with LOOP-…-TFYK marked as changed
               here after the cutover. Result: **inserted 1** (the Airtable-only
               loop), **updated 0**, **unchanged 5**, **kept_newer_here 1**,
               **refused 0**. The kept row is named with the field that differs:
               `Status`, here `"Closed"`, Airtable `"In Progress"`, 2 fields
               differing, written here by `engine` at 2026-09-21T14:00. After
               the run the row still reads Closed and all seven rows are
               present — **nothing deleted**. Run again: 0 inserted, 0 updated,
               6 unchanged, 1 kept — the decision is made afresh and holds.
            8. **`AIRTABLE_RETIRED=true`** — the boot line says RETIRED; all ten
               Airtable routes answer **410** with the one reason
               (`/api/{codex,loops,patterns,commercial,clients,ns,rt,pay,engine-health}/resync`
               and `/api/engine/final-import/loops`); `/api/status` reports
               `airtable_retired: true` and `airtable_writeback: false` even
               though the write-back variable was not set to false;
               `get_health` reports `reachable: null, retired: true` and the
               reason rather than probing; `get_mirror_status("loops")` reports
               `source.system: engine-only` and `resync.available: false`; the
               MCP `resync` and `diff_source_vs_mirror` tools both refuse with
               `airtable_retired`. The engine lookup still answered normally,
               because it touches no Airtable.
            9. **In a browser, both flag states.** Retired on: Resync button 0,
               Final import button 0, on Engine health and on Open loops. Off:
               both present. `/open-loops/LOOP-1788044070646-TFYK` opens that
               loop's panel and the address stays; `/codex/CODEX-20260908-…`
               opens that entry; `/open-loops/LOOP-DOES-NOT-EXIST` says
               "No loop here is called LOOP-DOES-NOT-EXIST"; clicking a row
               moves the bar from `/open-loops` to
               `/open-loops/LOOP-ONLY-IN-AIRTABLE` and closing it puts it back.
               Clicking **Final import from Airtable** ran all nine groups and
               printed "Inserted 1 · Updated 0 · Unchanged 11 · Kept, newer
               here 1 · Refused 0". No page errors on any of it.
           10. **Migration 21** applied to a database already at 20: the four
               tables exist and the three registry base rows carry their notes.
           11. **`npm run build`, `npm run typecheck` and `npm run test:gate`** —
               all clean, the gate's eight assertions included. (The gate counts
               its audit rows all-time, so it fails on a database an earlier run
               has used; cleared its own rows and it passes.)
Not tested: Against the production database or the deployed service — neither
            has this code until this commit deploys, and the Airtable cap is
            still in force, so **the final import has never run against real
            Airtable**. It has only been run against a replay, which is the
            honest limit of what could be proved before the cap resets: the
            replay serves records and refuses an unknown field name the way
            Airtable does, but it is not Airtable. The first real run should be
            read carefully rather than trusted, and `kept_newer_here` is the
            column to read. No n8n workflow has been repointed at any of this
            yet. `channel_tracking` holds one test row and no real one: Message
            Capture has still not been cut over, so Slack messages have still
            not been archived since 20 Sep — this change makes that possible,
            it does not do it.

## 2026-09-23 10:40 — two Airtable-backed kinds, the Bays four in the final import, and onboarding without a deploy
Intent:     Follow-up to 74fbd54. Four things the Bays cutover still needed:
            two kinds that were never mirrored and hold real data, the four
            kinds added yesterday as engine-only brought into the final import
            because each holds real Airtable history, a way to add a builder
            that does not need a code change or an Airtable table, and the
            lookup's owner columns pinned rather than assumed.
Files:      server/src/migrations.ts    migration 22: two tables, two registry rows
            server/src/sources.ts       PATTERN_CANDIDATES, BUILDER_PROFILES,
                                        LANE_BACKLOG, DEEP_THINK_LOG,
                                        CHANNEL_TRACKING, REVIEW_RETURNS
            server/src/mirror.ts        the two kinds, lane_backlog's real
                                        natural field, resolveBuilder reading
                                        Builder Profiles, prepare() async
            server/src/finalImport.ts   the `builders` and `bays` groups, and
                                        keying on the Airtable record id
            server/src/store.ts         the patterns sweep takes both tables,
                                        the `builders` sweep
            server/src/index.ts         /api/builders/resync
            server/src/mcp/inventory.ts SOURCE_OF, RESYNC_ROUTE
            server/test/lookup-shape.test.cjs   new — the owner columns, pinned
            package.json                npm run test:lookup
            src/data/index.ts, src/screens/EngineHealth/FinalImport.tsx
            README.md, CLAUDE.md
Decision:   **`builder_profiles` and `pattern_candidates` are Airtable-backed,
            not engine-only.** Both hold real rows in Airtable today, so both
            are swept by a resync and both are in the final import — the
            opposite of yesterday's four, which are written here and read back
            here.
Decision:   **Pattern candidates ride the Build patterns resync.** Same base,
            same page's subject, so that page's one button sweeps both tables —
            the precedent is Research Twin, whose one button sweeps its ask
            ledger and its job queue. No new grant on the token, because it is
            a base it already reads.
Decision:   **Builder Profiles has no resync button on any page.** Nothing in
            the interface reads it — the Builders registry tab is
            `registry_people`, a different list — and a control that filled a
            table no screen shows is one nobody could check the result of.
            `POST /api/builders/resync` exists for the MCP `resync` tool and
            the final import, and `get_mirror_status` names it and says so,
            which is where somebody looking at that kind actually is. Said
            plainly rather than adding a button to have one.
Decision:   **`lane_backlog` takes `task_id` from the blob after all.**
            Migration 21 had its natural field as null on the understanding
            that n8n minted the key; the live table carries `task_id`, so it is
            read off the blob like every other kind with an id column — and an
            explicit envelope `natural_id` is now refused for it, by the same
            rule that refuses one for loops.
Decision:   **Review Returns, Deep Think Log and Pattern Candidates are keyed
            on Airtable's record id when imported.** None has an id column this
            dashboard can name, and the record id is the only stable thing an
            imported row carries; without it they would come across with a null
            key and a second import could not match them. `held()` works the key
            out the same way the write does, so the decision cannot be made
            about one row and written to another.
Decision:   **How n8n should key new rows in those three.** Review Returns and
            Deep Think Log: send `natural_id` in the envelope, minted by n8n and
            stable for that row — `RR-<ms>` and `DT-<ms>` are the shapes already
            in use. Pattern Candidates: `CAND-<ms>-<4>`, as n8n already mints.
            **Rows imported from Airtable carry the record id as their key
            instead**, so a row created before the cutover and a row created
            after it are keyed differently — which is correct and worth knowing:
            a PATCH by-natural against an imported candidate names its `rec…`
            id, not a `CAND-` one. `GET /api/engine/pattern_candidates` is what
            says which a given row has.
Decision:   **Adding a builder is a row, not a deploy.** `builder_id` is now
            one of the seven *or* any Slack user id with a row in Builder
            Profiles, with no `table_id`. `Bays — Onboarding` creates a
            builder's table through Airtable's Meta API, which stops working
            the moment Airtable is retired and needed a deploy here even while
            it worked. Post the profile, and that builder's loops and Codex
            entries are accepted from the next request.
Decision:   **A Slack id belonging to one of the seven resolves to their name.**
            Not to a new builder — `builder_id` on those rows keeps the one
            spelling every page already groups by. The raw value is checked
            against the roster **before** it is lower-cased, because a Slack id
            is upper case and lower-casing first would miss every one of them.
Decision:   **`table_id` stays null for a profile builder**, which is the honest
            answer: there is no Airtable table, and writing one would be
            inventing a location. Everything that needs a table already falls
            back through `tableOf()`, as it does for a row the engine wrote
            before Airtable had one.
Decision:   **The profile lookup is on the cold path only.** It is reached only
            when the name is not one of the seven and no `table_id` was sent, so
            a resync of nine hundred loops still costs no extra round trip.
            `prepare()` became async to allow it; `upsert` is its only caller.
Decision:   **`engine_builder_profiles.natural_id` is UNIQUE**, unlike every
            other mirror table's. A Slack id names one person, two profile rows
            for one id is a fault rather than a state, and this table decides
            who owns a loop. The others leave it non-unique because a row the
            engine wrote before Airtable had one can legitimately sit beside the
            Airtable copy until the two are adopted; a profile has no such phase.
Decision:   **The lookup's owner columns are a test, not a comment.** n8n's
            update-a-loop path reads `builder_id` and `table_id` to find the
            owner, and a lookup that stopped sending them would not fail — it
            would answer, and every workflow downstream would quietly lose the
            owner. `npm run test:lookup` asserts the whole key set on every row,
            that neither column is ever `undefined`, and that a kind without
            those columns answers `null` rather than leaving them out.
Problem:    The first final-import run against the extended replay refused every
            row of the six new sources: `"record_id": "recCHAN00000000A" is not
            an Airtable record id (rec followed by 14 characters).`
Fix:        The replay's ids were `rec` + 13. Airtable's are `rec` + 14 and the
            validator has always said so — the replay was wrong, not the code,
            the same mistake as the `recTESTPOST00001` payload on 21 Sep.
            Regenerated them and the same run inserted 5, kept 1, refused 0.
            Worth recording twice because it is now twice: **a stand-in has to
            be as strict as the thing it stands in for, or a test passes against
            a fiction.**
Problem:    `POST /api/builders/resync` answered 404 after it was written.
Fix:        Nothing wrong with the route — the cell that added it ran
            `npm run typecheck`, which does not emit, so the running server was
            the previous build. Rebuilt and restarted: 200, two profiles read.
            Noted because it is the second time this session a stale process
            has read as a code fault, and the tell is the same: the behaviour
            predates the edit exactly.
Verified:   Against a local Postgres 16 holding the twelve real production rows,
            an Airtable replay extended to nine tables, and read-only SELECTs
            against production through the MCP server. **Nothing was written to
            production.**
            1. **Migration 22** applied to a database already at 21:
               `engine_builder_profiles` and `engine_pattern_candidates` exist,
               the Builder Profiles base is a new registry row and the Build
               Patterns row now names its second table.
            2. **POST with no `record_id`, one per new kind** — builder_profiles,
               pattern_candidates, channel_tracking, review_returns,
               lane_backlog, deep_think_log: **6 of 6** stored, every one
               `matched_on=insert` with `airtable_record_id: null`. The same six
               again: **6 of 6 `unchanged`, matched on `natural_id`**.
               `lane_backlog` keyed on `task_id` from the blob, and an envelope
               `natural_id` for it is refused naming `task_id` as the fix.
            3. **The onboarding contract, in order.** A loop for `U0RITA9K2LM`
               before the profile exists → **422**, naming Builder Profiles and
               the five fields. The profile → inserted. The same loop and a
               Codex entry, `builder_id` only, **no `table_id`** → both
               inserted. Read back: `builder_id='U0RITA9K2LM'`,
               `table_id=None` on both. `builder_id` sent as `'destiny'` and as
               `'U0AEW3TBYH1'` both stored `builder_id='destiny'`,
               `table_id='tblBJekl3ROpNZxQW'` — the seven are undisturbed either
               way. `U0NOBODYATALL` → 422 with the same fix named.
            4. **The final import, new groups.** `bays`: **5 inserted, 1 kept,
               0 refused** — Channel Tracking read 3 and inserted 2, keeping
               `C0AFPJ5S1C1`, which this database had already moved to a new
               capture doc after the cutover. The report names it:
               `field="doc_url"`, here `…/THE-NEW-DOC-BAYS-ROLLED-TO`, Airtable
               `…/THE-OLD-AIRTABLE-DOC`, written here by `engine` at
               2026-09-22T10:00. After the run that row still points at the new
               doc and the other two are in — which is exactly what Message
               Capture needs: the existing mapping, without losing the one that
               moved. `builders`: 2 profiles inserted. `patterns`: 1 candidate
               inserted beside the patterns sweep. Re-run of `bays`: 0 inserted,
               5 unchanged, 1 kept — idempotent, and the keep decided afresh.
            5. **The resyncs.** `POST /api/builders/resync` → 200, 2 read,
               2 unchanged. `POST /api/patterns/resync` → both tables named in
               the result, Build Patterns and Pattern Candidates.
            6. **`get_mirror_status` knows all 24 kinds**, with the two new ones
               as `system: airtable` and the four Bays ones as `engine-only`
               with their real table ids — `tblmQF2ajJtsNQUft` and
               `tbloh8gnxAfivJBx4` recorded now that the final import reads
               them, having been left out while nothing did.
            7. **`AIRTABLE_RETIRED=true`** still refuses the new routes with the
               rest: `/api/builders/resync`, `/api/engine/final-import/bays` and
               `/api/engine/final-import/builders` all **410**.
            8. **The lookup shape, live.** Against production, read-only:
               **946 of 946 loops** carry `builder_id` and `table_id`, across 7
               distinct builders and 7 distinct tables; **199 of 199 Codex rows**
               carry both, across 6 builders (Jason reviews logs, he does not
               submit them). `npm run test:lookup` — 7 checks, all pass.
            9. **`npm run build`, `npm run typecheck` and `npm run test:gate`** —
               all clean.
Not tested: Against the production database or the deployed service — neither
            has this code until this commit deploys, and the Airtable cap is
            still in force, so **the final import has still never run against
            real Airtable**. The nine-table replay is stricter than it was and
            still is not Airtable. Nothing has been repointed in n8n: no builder
            profile has been posted by `Bays — Onboarding`, `channel_tracking`
            holds no real row in production, and Slack messages are still not
            being archived. The field lists for the two new kinds are what the
            brief named and were not read off the live bases — the cap prevents
            it — so a field spelled differently there will arrive verbatim in
            the blob and simply not be one this dashboard names, which is the
            safe direction but worth checking on the first real import.

## 2026-09-22 18:10 — Engine health: the incident resync was refused by the Airtable retirement
Intent:     Page-by-page data-correctness pass (Destiny's brief of 22 Sep). First,
            6.1: incidents have not reached this page since 17 Sep.
Files:      server/src/index.ts, server/src/health.ts, server/src/mcp/tools.ts,
            server/src/mcp/inventory.ts, src/components/ui/Resync.tsx,
            src/screens/EngineHealth/index.tsx
Problem:    Confirmed live before touching anything: `engine_incidents` holds 37
            rows (bays 20, north_star 8, research_twin 9), every one
            `open_now = true` and `resolution_status = 'open'`, newest
            `occurred_at` 2026-09-17 15:32 UTC, and `meta.health.lane.*` shows
            the last read of all three lanes at 2026-09-17T22:32Z. Nothing has
            read the ledger since. Three places refused it, not one:
            1. the HTTP route — `/api/engine-health/resync` was in the 410 regex
               in index.ts beside the eight Airtable resyncs;
            2. the MCP `resync` tool — `if (airtable.retired()) throw` before the
               route lookup, whatever the kind's source;
            3. `diff_source_vs_mirror` — the retired check ran before the
               `system !== 'airtable'` check, so incidents got
               `airtable_retired` rather than anything about BHARAG.
            And the page's button is `ResyncButton`, which hides itself on every
            page once Airtable is retired, so there was no way to press it.
Fix:        The retirement is gated on the source actually being Airtable.
            `engine-health` leaves the 410 regex; the pass reads the three BHARAG
            lanes as before and skips `error_counts` and `retry_attempts` when
            retired (the engine writes those directly), saying so in its note.
            The MCP resync checks `SOURCE_OF[kind].system === 'airtable'`.
            `diff` gets a BHARAG branch: open in the ledger against open here,
            lane by lane, with an unread lane named and never counted as empty.
            `ResyncButton` takes `alsoReads`; Engine health passes "BHARAG", so
            its button stays when retired and reads "Resync from BHARAG".
Decision:   Retired Airtable tables are left out of the pass's table list rather
            than listed as unread — an unread source reads as a failure in the
            toast, and nothing failed.

## 2026-09-22 18:30 — Engine health: 17 incidents in, close from the page, charts that give a number
Intent:     6.1 verified live, then 6.2–6.5 of the brief, and global rules (a) and
            (b) as shared components the other pages use.
Files:      server/src/bharag.ts, server/src/health.ts, server/src/index.ts,
            server/src/sources.ts, server/src/store.ts, src/data/index.ts,
            src/data/types.ts, src/components/ui/InfoTip.tsx (new),
            src/components/ui/Figures.tsx, src/components/ui/Records.tsx,
            src/components/ui/Tabs.tsx, src/components/ui/index.ts,
            src/screens/EngineHealth/{index,LaneView}.tsx,
            src/screens/EngineHealth/FinalImport.tsx (deleted)
Verified:   6.1 after the deploy of ed45ffb, through the MCP `resync("incidents")`:
            37 → 54 rows. Bays read 23 (3 new), North Star 22 (14 new),
            Research Twin 9 (0 new). The 17 new ones occurred between
            2026-09-21 08:00 and 2026-09-22 08:06 UTC — none on 18, 19 or 20
            Sep among the ones still open. All 37 older ones are still open in
            the ledger itself, not just here.
Problem:    Every incident was dated by its import. `mapIncident` read
            `f.created_at`, and the ledger's rows carry `occurred_at` and
            `recorded_at` and no `created_at` at all, so every row fell back to
            `first_seen_at` — 2026-09-17T22:28Z for all 37 — and "Incidents
            over time" drew one column in the week of 14 Sep. That, as much as
            the missing axis, is why the chart said nothing.
Fix:        `occurred_at` first, `created_at` kept as a fallback.
Decision:   **The close route is BHARAG's own, read from its source, not
            guessed.** The n8n agent found the only close in the engine:
            `BHA — Self Healer Reports` → `POST /api/v1/incidents/{id}/status`
            with `resolution_status: 'self_healed'`. The BHARAG repo
            (bhanetworkgh/bharag, `backend/core/incidents/lifecycle.ts`) gives
            the six states and the transitions: `open → manually_resolved` is
            legal directly, terminal states have no way out. Its `/close` route
            is the one meant for a person but requires a control-plane session
            and refuses a workspace key (`INCIDENT_CLOSE_CONTROL_PLANE_REQUIRED`);
            this server holds only the three lane keys, so it uses `/status`
            with `manually_resolved` and names the dashboard login in
            `resolved_by` and `payload_patch.resolved_by`. The incidents router
            has no `requirePermission`, so a lane key can make the call.
Decision:   Ledger first, one incident at a time, each with its own lane's key.
            A row here is marked closed only after BHARAG answers 200, and takes
            the ledger's returned incident as its blob. A refusal leaves the row
            open and red ("close refused", BHARAG's reason in the tooltip).
            Every attempt is a `record_writes` line, `kind = 'incidents'`,
            actor = login. `writebackFailures()` without a kind now excludes
            `incidents` — it counts Airtable write-backs and a refused close is
            not one. The confirm dialog's count travels as `expected` and the
            server refuses a request whose selection differs.
Tested:     Locally against Postgres 16 and a stand-in BHARAG implementing the
            real lifecycle table: 3 selected + one unknown id → 2 closed (Bays
            with the Bays key, North Star with the North Star key), 1 refused
            `409 INCIDENT_ALREADY_CLOSED` (flipped to self_healed behind our
            back) and left open with the reason, 1 skipped as not held; a
            mismatched `expected` refused with nothing sent. **Not run against
            production BHARAG** — that is Destiny's click, and the 37 are hers
            to select.
Decision:   6.3: All systems ends at the table. The cards stay on lane tabs.
            The final-import panel, already hidden when retired, is deleted.
Decision:   6.4: one column per week with its count printed and its Monday
            under it, a lane × week grid of numbers below, and class over time
            as a class × week grid of counts rather than a seven-colour stack.
            The window is named in the note. Every lane is read, so a quiet week
            is a real 0 and is printed as one.
Decision:   Rule (a) is a component, not copy: `caption` on `FigureCell`,
            `PercentCell`, `PercentileCell` and `CountCell` puts one line (≤55
            characters, warned in dev) under the figure and moves the whole
            explanation behind an ⓘ beside the label (`InfoTip`, hover and
            keyboard focus). Rule (b) is `Definition` under a filter row plus a
            `title` on each segment.
Decision:   6.5: filter and class words defined from the handlers' code:
            `retryable = !(['billing_quota','config_auth','schema_validation']
            .includes(cls) || cancelled)`; the healer retries network_timeout,
            upstream_5xx and model_output_invalid, sends schema_validation and
            unknown to the repair bridge, billing and auth to a person.
            `ERROR_CLASSES.what` corrected to match: 502/503 are UPSTREAM_5XX
            since 17 Sep, not timeouts.
Found:      Reported, not fixed (outside this repo): the Retry now webhook
            `/webhook/engine-heal` belongs to `Engine — Self-Healing Retry`,
            which is **inactive**, so the button's production webhook is not
            live; the active `BHA — Self Healer` writes no `retry_attempts`
            rows, so Retries shows nothing it does; nothing posts to
            `/api/engine/incidents`.

## 2026-09-22 18:40 — North Star, Research Twin, Customer Service Twin
Intent:     Brief §3, §4, §5: a comprehension pass on the twins, rules (a) and
            (b), and a placeholder for the Customer Service Twin.
Files:      src/screens/NorthStar.tsx, src/screens/ResearchTwin.tsx,
            src/screens/twinDefinitions.ts (new), src/screens/CsTwin/index.tsx
            (new), src/App.tsx, src/components/Layout.tsx,
            src/components/ui/Tabs.tsx, server/src/store.ts, server/src/stats.ts,
            CLAUDE.md (navigation tree)
Verified:   engine_ns_asks 46 rows, all from the engine, 2026-09-18 07:00Z to
            2026-09-22 08:45Z: 45 Thin + 1 Answered, 46 Delivered. So for Sep:
            delivery 46 of 46, answered 1 of 46. engine_rt_asks 5 rows: 3
            Answered, 2 Needs human, all Delivered. engine_rt_jobs 3 rows, all
            `source=engine`, all Pending with 0 attempts, first arriving
            2026-09-22T10:11:55Z (the brief said "3 rows since 22 Sept" — right).
Decision:   Every definition is taken from the n8n node that writes the value,
            quoted in the header of twinDefinitions.ts. Two places the brief's
            reference list was not quite what the code does:
            - **Research Twin "Needs human" is not "capped after 3 attempts".**
              It is set on an *ask* when the answer text itself matches
              `/needs? a (person|human)|capped after|requires_human|flagged for
              (a )?human/i`. "Capped (needs human)" is a different thing, a
              *job* status, set by the Tools Router at the third low-confidence
              attempt. They are defined separately on the two tabs.
            - **"Not delivered" is never written by either agent.** A refused
              Slack post throws in "Assert Slack OK" before the ask row is
              built, so a failed delivery leaves no row at all. The Not
              delivered filter is therefore always 0 by construction; its
              definition and empty state now say so, and the delivery-rate
              note says 100% cannot on its own prove every post arrived.
            - Refused is only reachable on a *cited* answer: North Star tests
              Thin before Refused, so an uncited refusal is recorded as Thin.
            The notes that said "nothing is inferred from the answer text" were
            wrong — the agent infers all of it from the answer text; this
            dashboard only counts it. Corrected in store.ts and stats.ts.
Decision:   The page sentence the brief asked for is the PageHeader subtitle and
            names the table. Research Twin gets a line under its tabs saying
            what the selected section is, and each tab carries it as a tooltip.
Decision:   The Jobs tab no longer opens on an empty Capped filter when nothing
            is capped — it opens on All — and carries a line reading "N jobs
            recorded since the first arrived on …, x pending · …", with "none
            has been worked yet" when every job is still Pending.
Decision:   Customer Service Twin: /cs-twin, Systems group, the same
            ComingSoon shape as Genie, no fetch and no figure. Sidebar is now
            sixteen items; CLAUDE.md's navigation tree and "sixteen fit" updated.
Tested:     Local build, three NS and two RT asks and one job posted through
            /api/engine: both strips render as one even row with one caption
            each, definitions under the filters, the jobs line reads correctly.

## 2026-09-22 18:50 — Open loops: "nulld" was every loop's age, not a missing loop_id
Intent:     Brief §7: rows in the time-in-status list print a literal "null".
Files:      server/src/store.ts, src/screens/OpenLoops/Loops.tsx
Verified:   The brief's cause does not hold. engine_loops 975 rows, 739 from an
            Airtable resync — but only **2** have no `loop_id` (fields and
            natural_id both null); no row stores the string "null". Reproduced
            locally with three loops, one without a loop_id: the "null" was in
            the **age** column, reading `nulld` on every row, and "How long
            these have been sitting" said 0 open beside a strip saying 2.
Problem:    `dayDiff` in store.ts, since f128037 ("Engine health is a real
            page", 2026-09-17 21:16Z), read
            `Date.parse(\`${b}T00:00:00Z) - Date.parse(${a}T00:00:00Z\`)` — the
            two parses had been run into one template literal, so it parsed a
            nonsense string, returned NaN, and `Math.max(0, NaN)` sent every
            loop's `age_days` out as null. Everything built on it went with it:
            the age column, the age distribution, the Overview's oldest-loop
            figure and the Builders registry's oldest-loop age.
Fix:        Two template literals again, and a non-finite result is 0 rather
            than NaN. The age cell prints "—" rather than "nulld" if an age is
            ever missing. The loop column falls back to the record id, as
            LoopPanel already does, faint and titled "No loop_id on this row —
            … is its record id", rather than an amber "no loop_id".
Audit:      Every loop-id render: LoopPanel header (`loop_id ?? id`, fine),
            LoopPanel read-only field (blank-safe), Loops.tsx duplicate banner
            (`loop_id ?? id`), the record link (`natural ?? id`), the CSV
            (blank for null). None printed "null"; only the table cell changed.
Tested:     Local: ages 20d and 21d for loops raised 2 and 1 Sep, age chart
            15–30 days 2 of 2.

## 2026-09-22 19:00 — Codex, Build patterns, Commercial verified; Clients says how old each lane is
Intent:     Brief §8–§11.
Files:      server/src/store.ts, server/src/engine.ts, src/data/types.ts,
            src/screens/Clients.tsx
Verified:   Codex — engine_codex_submissions holds **209**, not 208: the 209th
            arrived today at 17:53Z. The page's own /api/codex serves 209, and
            its stages match a SQL recomputation of the three rules exactly:
            203 Approved (186 `Approved` + 17 `Input Added`), 6 Awaiting
            approval (`Pending`), 0 Needs input — the three Layer 0 rows are all
            `completed`. By builder: Destiny 48, Kaiqi 45, Hardik 32, Kavin 32,
            Jegan 31, Ahad 21 = 209.
            Build patterns — table 181, page 181. engine_pattern_candidates
            holds 40 and **no page reads them**; CLAUDE.md says so on purpose
            (they are swept with the patterns resync). Reported, not built.
            Commercial — table 27, page 27.
            Clients — as the brief said: 4 lanes, 13 questions, 4 requests, every
            row `source=airtable`, all last changed by the resync of
            2026-09-17 15:13Z. engine_writes has no client_lanes or
            client_requests write at all, and the last client_questions write
            was 2026-09-14 08:05Z (26 updates) — since overwritten by the
            resync, which is why the rows' own source says airtable.
Fix:        Every lane, question and request carries `held: { updated_at, via }`
            from its mirror row (`engine` / `resync` / `page`). A lane row gets
            `last_update`, the newest of itself and its questions, shown in a
            new "last updated here" column ("2026-09-17 · resync"), amber at
            three days or more. Both tabs carry a line: when the engine last
            wrote lanes / questions / requests (from engine_writes, lookups and
            refusals excluded, "never" where it never has), and whether every
            row on screen arrived through a resync.
Tested:     Local: one lane seeded as a resync row dated 17 Sep renders
            "2026-09-17 · resync" in amber and the line reads correctly.

## 2026-09-22 19:15 — Executions: recent health beside the month, and 320 runs the poll never read
Intent:     Brief §12: the failure rate carries its window, recent health reads
            apart from the month, and the totals checked against n8n.
Files:      server/src/executions.ts, src/data/types.ts,
            src/screens/Executions/index.tsx
Verified:   Bays — Error Handler against n8n itself: n8n 203 executions (68
            before 21 Sep + 135 since), 128 failed; this database 203 / 128 —
            exact. The brief's story is right in shape and wrong in size: the
            failures run from **20 Sep 23:00** (the Airtable cap) to 21 Sep
            15:31 — 3 on the 20th, 124 on the 21st, 127 in 16½ hours, not ~100
            between 13:28 and 15:31 — plus one on 14 Sep. Every run since has
            succeeded, and there are **11** of them, not 4: 21 Sep 16:21 (×2),
            19:30, 21:31, 21:36, 22:00, 22:29, 23:00, 23:25, then 22 Sep 04:30
            and 12:49.
Problem:    **The totals do not match n8n.** n8n `count` 13,771; this database
            13,451, both ending at id 13830. Bisected by day: 21 more here than
            n8n before 15 Sep (rows kept after n8n dropped them — expected),
            then short by 154 (15–18 Sep), 94 (19–20), 38 (21), 55 (22). Ids
            13595–13794 compared one by one: the ten missing (13599, 13601,
            13641, 13647, 13666, 13680, 13691, 13710, 13759, 13779) are every
            one a run of 39 s to 106 s — Conversational Agent turns, Submit
            Actions, the Self Healer. n8n's list leaves out a run still going,
            and the poll stopped at the highest id it held, so a long run was
            skipped for good as soon as a later, shorter one finished first.
            The pass's own warning line had been saying "short by N" all along.
Fix:        Every poll now reads from `highest − 400` rather than `highest`
            (two pages, an upsert, so re-reading changes nothing twice), and
            the log line fires on inserts rather than on every read. The next
            boot runs one full read (`executions.gap_backfill_2026_09_22` in
            meta, so it happens once) to recover what was skipped; "Read n8n
            again" on the page does the same.
Decision:   Recent health, per workflow: its last ten finished runs whenever
            they ran, when it last failed, how many succeeded since — one SQL
            pass over engine_execution_runs. Shown as a column beside the
            month's rate ("last 10 ok · last failed 1 d ago" / "3 of last 10
            failed", red only in the second case). The month's own figures are
            not touched. Column headers name the window ("failure rate, Sep").
Found:      Other workflows distorted the same way (Sep rate high, 0 of the
            last 10 failed): BHA — Self Healer 18% (7 of 38), Bays — Parked Log
            Reminder 14% (12 of 85), Bays — Digest Delivery Check 8% (18 of
            215), North Star — Tools Router 7% (10 of 149), Bays — Message
            Capture 5% (68 of 1,385), Bays — Front Door 1% (42 of 4,668) — all
            failures in the 20–21 Sep Airtable window or earlier. The opposite
            case, **failing now**: North Star — Front Door 7 of last 10
            failed, North Star — Conversational Agent 5 of 10, North Star —
            Error Handler 4 of 10, all at 22 Sep 08:00 — the same burst as the
            14 new North Star incidents.
Tested:     Local: 23 Error Handler rows (12 failing on 21 Sep then 11 ok) and
            20 North Star rows (last 3 failing) render as described.

## 2026-09-22 19:35 — Pay Tracker: 132 rows were 75 sessions; missing Paid is its own figure
Intent:     Brief §13.
Files:      server/src/pay.ts, server/src/sources.ts, src/data/types.ts,
            src/screens/PayTracker/{index,Owed,Sessions,Statements,Statistics}.tsx
Verified:   engine_pay_builders: Daily = Kaiqi Yang, Ahad, Destiny Arupi;
            Monthly = Kavin G N, Hardik Bhatt, Jeganathan — as the brief said.
            engine_pay_sessions row counts exactly as the brief said (132: 78
            daily paid, 1 daily no flag, 41 monthly paid, 3 monthly unpaid, 9
            monthly no flag) — **but those are rows, not sessions.**
Problem:    57 sessions are held twice under the same Codex Entry ID: once from
            the Airtable resync of 20 Sep (with its rec… id) and once as
            `Bays — Pay Tracking` posted it from 21 Sep (no record id), so the
            two never matched on the way in. Every figure counted both. Real
            count: **75 sessions** — daily 42 (41 paid, 1 no flag), monthly 33
            (21 paid, 3 explicitly unpaid, 9 no flag). All 57 pairs agree about
            Paid. The 10 with no flag exist only in the Airtable import, and
            Airtable leaves an unticked checkbox out of the record, so they were
            most likely unticked on 20 Sep; the engine's pay sync has never
            posted them.
Problem:    **13.1 could not be reproduced.** Hardik's 17 rows all carry
            `Pay Mode = Monthly` and his roster row says Monthly; the live
            /api/pay/metrics files him under Monthly with 4 unpaid. The rule
            that could misfile somebody is real, though: the owed row took the
            mode of whichever unpaid session came first.
Fix:        `sessionsHeld()` counts each Codex Entry ID once, the engine's copy
            kept, and reports rows / sessions / merged / pairs that disagree;
            the Sessions tab says so in a line. `paid` is tri-state: null where
            the row has no Paid. Owed = explicit false only; "Paid not
            recorded" is its own figure and its own filter, never added to
            owed, with the resync explanation in its note. A builder is listed
            under the **roster's** Pay Mode; each session keeps its frozen mode
            and any that differ are counted on the row ("n on another mode").
            13.2: the empty Statements tab names Bays — Pay Tracking, the 1st at
            09:00, /api/engine/pay_statements and the pay-reviews channel, says
            the workflow was created 17 Sep so the first run is 1 Oct, and says
            the write log holds no statement at all. 13.4: six figures, one
            caption each. "Ledger last read" is now "Ledger last written" and
            takes the newer of the resync stamp and the engine's last post
            (it said "press Resync from Airtable" on a page with no button).
Found:      Bays — Pay Tracking's own readers use `!paid(f['Paid'])`, so a
            missing flag is unpaid to them: the 9 monthly no-flag sessions will
            be on the 1 Oct statements and in the Monday reminders.
Tested:     Local: five rows (one duplicated paid pair, two flagless from a
            resync, one explicit unpaid) → 4 sessions, 1 owed, 2 not recorded,
            Hardik under Monthly with "+1 paid not recorded".

## 2026-09-22 19:55 — System registry: no url edit, no Engine writes, workflows and endpoints in step with n8n
Intent:     Brief §14.
Files:      src/screens/Registry/index.tsx, src/data/index.ts,
            server/src/index.ts, server/src/mirror.ts, server/src/registrySeed.ts,
            server/src/migrations.ts (migration 24), CLAUDE.md
Verified:   The live n8n list (42 workflows) against registry_workflows (31):
            13 had no row — BHA — Self Healer, BHA — Self Healer Reports,
            Engine — Self-Healing Retry (inactive), the three TEST self-healing
            lanes, Bays — Pay Tracking, Bays — Pay Ledger Sync, BHA — Dashboard
            Loop Write-Back (inactive), vFarm Early Access — Lead Notifier,
            GenieContextTest (inactive), and the two one-offs (source_campaign
            header, D565 clip-pattern ingest). 3 were stale:
            `lEyirYDareupAmlB` is "Bays — Builder Chasers" in n8n, not "Parked
            Log Reminder"; `fhQNvRFdh1H6Li0E` is marked [MIGRATED]; and
            "North Star — Weekly Status" (`aPP4AMtcB4xmOSCW`) is no longer in n8n
            at all but read `production`. The brief's "check-in workflow"
            (`Bays — In Progress Loops Check-in`) was already registered.
Fix:        The 13 go in as seed rows, which insert on boot and never touch an
            existing row. Name, description and active state are n8n's own;
            system is chosen from the name (Engine / Test / Bays / vFarm / Genie
            / One-off) and every row's notes say so; folder, owner and trigger
            are null where not read. Migration 24 corrects the three stale rows,
            each only while the row still holds the seeded value, so a page edit
            wins. Endpoints: 8 added from the engine's own nodes and this code —
            the dashboard's /api/engine surface, /api/engine/repair, the public
            Early Access route, the repair bridge, /webhook/repair-result,
            /webhook/engine-heal (noted as not live), BHARAG's /incidents/:id/
            status, and the n8n public API.
Fix:        The "edit" beside a service's url is gone; the url is a link or
            "no url recorded". The Airtable bases section is titled "— history"
            and says it is not live and why it is kept. The Engine writes tab,
            its component, `getEngineWrites`, the `/api/engine-writes` route and
            `mirror.writesView` are removed; `engine_writes` stays.
Found:      New systems on the Executions page: Engine, Test, One-off and Genie
            each get a tab once these rows exist, where they read as Unregistered
            before. The TEST lanes are deliberately broken, so the Test tab will
            show failures by design.
Tested:     Local boot: "applied 1 migration(s): 24", "seeded 21 row(s):
            workflows 13, endpoints 8"; the three stale rows corrected; the
            Endpoint tab renders the new rows and the history label.

## 2026-09-22 20:10 — Engine health: the close body the ledger actually accepts
Intent:     Brief 2, item 1. The bulk close shipped in the last pass sent
            `resolved_by` at the top level of the status body; the deployed
            ledger refuses that.
Files:      server/src/bharag.ts, server/src/health.ts,
            src/screens/EngineHealth/LaneView.tsx
Problem:    Live, per Destiny: HTTP 400 LEDGER_PAYLOAD_SCHEMA_MISMATCH
            "/ must NOT have additional properties". The BHARAG repository copy
            this code was written against (last commit 11 Sep) parses the status
            body with a non-strict schema and would have accepted it — the
            deployed service is stricter than its repo, which is why the local
            mock passed.
Fix:        `closeIncident` sends exactly `{ resolution_status:
            'manually_resolved', payload_patch: { resolved_at, resolved_by } }`
            and nothing else. The comment says the ledger overwrites both on a
            terminal transition and stores the lane principal as resolved_by
            ("bays", "north_star", "research_twin" were what it returned), so
            the dashboard does not promise the login it sent is kept. The login
            and time are still written to record_writes here. The confirm
            dialog, the closed-row tooltip and the server's result note now say
            the ledger records the lane as the resolver, not a person.
Tested:     Mock ledger made strict (refuses any top-level key but
            resolution_status/payload_patch, and any patch key outside the
            schema, with the live error text; sets resolved_by = source). The
            old body is refused by it; the UI flow — select two, Mark
            resolved…, Close 2 in the ledger — sent the new body with each
            lane's own key, both closed, ledger resolved_by "bays" /
            "north_star", record_writes actor the login.
Found:      Production engine_incidents holds 54 rows (bays 23, north_star 22,
            research_twin 9), open_now false on all 54, last lane read
            2026-09-22T19:19:34Z. So the page reads 0 open, not 17: the brief
            said 37 were closed, and the other 17 are also absent from the
            ledger's status=open read. The stored blob still says
            resolution_status "open" on all 54, because a row the open-only read
            stops returning is marked closed-since and not re-fetched.

## 2026-09-22 20:35 — Pay Tracker: one month for the whole page; Owed says what it lists
Intent:     Brief 2, item 2. One month picker at the top of Pay scoping Owed,
            Statements, Sessions and Statistics together; the strip recomputes
            and says which month; Owed says it lists people with something
            outstanding rather than the roster, Ahad reads as "nothing owed · 1
            payment not recorded", and an empty mode group says it is paid up.
Files:      server/src/pay.ts, server/src/index.ts, src/data/{index,types}.ts,
            src/screens/PayTracker/{index,Owed,Sessions}.tsx
Data:       Production before the change: 134 session rows, 77 sessions once
            the resync/engine pairs are merged, every one in Month 2026-09. Owed
            5 (Hardik 1, Jeganathan 2, Kavin 2 — all monthly), Paid not recorded
            10, builders owed 3, statements 0. Ahad: 15 paid, 1 with no Paid,
            nothing owed — so the daily group has nobody owed. So today the
            picker holds one month and September and All time agree; the scope
            only starts to differ in October.
Fix:        `pay.metrics(selected)`; `/api/pay/metrics?month=YYYY-MM`, refusing
            anything else with a 400 rather than reading it as every month. The
            sessions are cut by their own Month, the statements by theirs. Two
            things are not scoped and say so: the month-against-month chart
            (scoped it is one bar), and `outside` — what is owed or unrecorded in
            other months — because on 1 October a picker opened on October would
            otherwise hide exactly the September work being paid. The Owed tab
            names it in a line with "Show every month". The picker sits in the
            header beside Resync and opens on the current month like the record
            pages, with All time last as they have it; the Sessions tab's own
            picker is gone, one month for the page. Under the freshness line:
            "Showing Sep 2026 · 4 of 5 sessions held". The strip's fifth figure
            is "Sessions in Sep 2026" / "Sessions, all months", not "this
            month". A builder with nothing owed shows "—" in the owed columns and
            "nothing owed · 1 payment not recorded" by the name; a group with
            rows but nothing owed opens with "Every daily builder is paid up for
            Sep 2026." and says the rows below are not owed; a group with no rows
            says paid up, or that no session counts toward the month, or that the
            ledger is unread — in that order of checking.
Tested:     Local, with an August unpaid row added: all months owed 2 / unconf 2;
            ?month=2026-09 owed 1, outside {owed 1, months [2026-08]};
            ?month=2026-08 owed 1, outside {owed 1, unconfirmed 2}; ?month=bad
            400. Screenshot shows the Ahad row and the paid-up line as above.

## 2026-09-22 21:05 — System registry: folder, trigger and owner for the 22 Sep rows
Intent:     Brief 2, item 5. Fill folder (from parentFolderId, resolved through
            the project), trigger (from the workflow's own trigger nodes) and
            owner (from the convention on comparable rows) on the 13 rows added
            this morning; leave blank what the instance cannot say, and say why.
Files:      server/src/registrySeed.ts, server/src/migrations.ts (25)
Data:       n8n, read only: two projects — BHA Engine (team,
            HjupolvfBya6b0ox, 20 folders) and Destiny's personal project (no
            folders). search_workflows on the team project for parentFolderId;
            get_workflow_details for trigger nodes, and the full node list for
            Self Healer and Pay Tracking to catch executeWorkflowTrigger, which
            the trigger summary leaves out.
Found:      - BHA — Self Healer now holds the /webhook/engine-heal trigger
              ("Retry Now (Dashboard Button)", moved there 22 Sep) beside its
              executeWorkflowTrigger. So Retry now IS live, and the registry
              said it was not, on both the workflow row and the endpoint row.
            - Engine — Self-Healing Retry is archived in n8n; its folder cannot
              be read.
            - GenieContextTest is not in the BHA Engine project at all — it is at
              the root of Destiny's personal project.
            - Add source_campaign Header has MCP access off: folder read from the
              workflow list (Sandbox), trigger not readable.
            - Pay Tracking's third trigger is "Session Approved (From Submit
              Actions)", a sub-workflow trigger — so "called on each approval"
              is by Bays — Submit Actions.
            - A 42nd workflow, "ONE-OFF — Close stale incidents (22 Sep audit)"
              (QqSeahroA4ez2iOp), was created at 19:07 UTC today, after this
              morning's list: the run that closed the 37 incidents. Added as a
              seed row so its runs do not read as unregistered.
            - n8n records no owner on a team-project workflow. Every existing
              BHA Engine row with an owner says Destiny Arupi except the vFarm
              lead workflow (Hardik Bhatt); that convention is applied and the
              notes say it is a convention. The vFarm Lead Notifier's owner is
              left blank: its one comparable row is Hardik's, but it was built
              for the dashboard — two conventions, so none is assumed.
            - Existing rows record the second-level folder ("Bays Subsystems")
              although n8n now files those workflows one level deeper (Pay,
              Open Loops, Slack In & Out, Logs & Review, Error Handling). The new
              rows carry the folder n8n actually names; the older rows were not
              changed — not in the brief, and the page is where they are edited.
            - Security, reported not fixed (n8n is read only here): Self
              Healer's "Call Repair Bridge" node carries the bridge's x-api-key
              as plain text in the node, not in an n8n credential.
Fix:        Seed rows carry the values for a fresh database; migration 25 sets
            them on the live one, each UPDATE guarded on the row still holding
            the exact seeded note, so a row edited on the page is untouched. The
            ep-engine-heal endpoint note is corrected the same way.
Tested:     Local: "applied 1 migration(s): 25"; all 13 rows read back with the
            values above; blanks: folder on Self-Healing Retry (archived),
            GenieContextTest (personal project root), D565 one-off (project
            root); trigger on source_campaign (MCP off); owner on the Lead
            Notifier.

## 2026-09-22 21:40 — Captions and code-read definitions on eight pages (rules (a) and (b))
Intent:     Brief 2, item 3: apply the caption rule and the status-word rule to
            Codex, Open loops, Build patterns, Commercial, Clients, Executions,
            and Engine health's Retries and Repairs tabs, with the shared pieces
            (InfoTip, caption mode, a twinDefinitions-style constant per page).
Files:      src/components/ui/Records.tsx (MetricCell gains caption mode — the
            one strip cell that had none); src/screens/Codex.tsx +
            codexDefinitions.ts; OpenLoops/{Metrics,index,Loops,LoopPanel}.tsx
            + OpenLoops/definitions.ts; BuildPatterns.tsx, Commercial.tsx +
            recordDefinitions.ts; Clients.tsx + clientDefinitions.ts;
            Executions/index.tsx + Executions/definitions.ts;
            EngineHealth/{Retries,Repairs}.tsx + EngineHealth/definitions.ts.
            Pages done in parallel, one worker per page group, each confined to
            its own files; shared components touched only by me.
Decision:   Every strip figure: one caption ≤55 characters read off the data,
            the old footnote kept word for word behind the mark. Every status
            word: a definition read from the code that computes it, cited in the
            definitions file's header, shown as tab/option/pill tooltips or a
            Definition line under the filter. Codex keeps its stage rules off the
            page as a paragraph (2026-09-14 decision) — tooltips only. Where no
            code defines a word the definition says so rather than inventing one:
            Codex narration quality tiers; Commercial reusability words, Medium /
            Low media readiness, how readiness_state is derived, lane_state (no
            writer); Clients Lane Status / Run State / Quarantined and the three
            infra fields (no workflow read writes them); Executions "how it ran"
            (n8n's own mode, never mapped here).
Verified:   (page vs database, 22 Sep)
            Open loops: open 638 / in progress 74 / closed 268 of 980, per
            builder all seven match; oldest open 52 d (destiny, raised 1 Aug) on
            page, registry and SQL alike.
            Codex: 209 rows; approved 205, awaiting 4, needs input 0 (3 Layer 0
            rows, all completed); Sep 2026 100/4/0 of 104; codex generated 193
            of 209; flagged 11.
            Build patterns: 182 rows, 178 ids (4 duplicate rows), Broad 147.
            Sep 2026: 34, Broad 30, 10 systems.
            Clients: 3 clients, 4 lanes, 13 questions, needs a human 0, overdue
            3 (due 31 Aug), warming up 1, requests 4 (all Requested), open checks
            14, clients asking 1.
            Executions (Sep, All systems): 13,888 runs, 13,472 succeeded, 406
            failed (error+crashed), 2.9% of 13,884 finished, 28.5 s mean over
            13,888, 50 workflows; tabs sum to 13,888.
            Retries: 8 rows, recovered 1, exhausted 5, rate 1 of 6. Repairs: 22
            held, 9 repaired and standing, 1 needs a person, 0 not repaired, 12
            skipped, p50 163 s / p95 204 s over 9.
Problem:    get_page_data could not read the month-scoped metrics routes
            (/api/records/{kind}/metrics, /api/executions?grain=…): the MCP
            resolver skips templated URLs, so those strips were verified against
            SQL by the server's own rule rather than against the served JSON.
Fix:        Codex's "input added" pill could never render (it required stage
            awaiting, and mapCodex files Input Added under approved); it now
            shows on the 17 rows that carry it. Retries' manual-vs-automatic
            card counted only Schedule as automatic, which would have put every
            row the current healer writes (Handler) on the manual side.

## 2026-09-22 21:45 — Commercial: one open-questions rule; Home disagreed with the page
Intent:     Brief 2, item 4 (tiles agree with their pages) — Commercial did not.
Problem:    Home counted open research questions as count-or-listed (62); the
            page summed missing_research_count alone (53). Underneath both: the
            extractor's "Comm Write Card to Sheet" posts missing_research_count
            as a literal 0 on every new card, so 9 cards listing 2–3 questions
            each read as "nothing left to answer". The count and the list are
            not the same quantity — August cards list 3 questions and count up
            to 8 — so the list cannot simply replace the count.
Fix:        `open_questions` on each card, derived once in mapOpportunity: the
            count wins, except a count of 0 (or none) beside listed questions,
            where the listed ones are counted; neither is null, never nought.
            Home, the Commercial strip and list, "Nothing left to answer" and
            the monthly advanced figure all read it. Nothing the engine writes
            is renamed or changed.
Data:       Production under the rule: 28 cards (one arrived at 19:30 today),
            all 28 state something, 0 clear, 9 say 0 while listing questions.
            The page's figure moves from 53 and Home's from 62 to one number.
            The extractor is n8n's to fix, not this repo's.

## 2026-09-22 21:50 — Engine health: finished incidents stop reading as needing a person
Problem:    Home's Engine health tile read "0 incidents open" beside "5 retries
            have used all three attempts", amber. All five are on incidents the
            ledger has since closed (open_now false) — finished, not waiting on
            anybody. And the Retries tab's "currently retrying 2" were Retrying
            rows from 17 Sep for PIPELINE-009 and -014, each overtaken by an
            Exhausted row on 21 Sep.
Fix:        exhaustedStillOpen(): an exhausted retry on an incident held here
            and not open is left out of "needing a person" and of Home's signal
            (it stays on the Retries tab, the retry record); an incident not held
            at all stays in — unknown is not closed. stillRetrying(): a Retrying
            row with a later Recovered/Exhausted row for the same incident is not
            in flight. Production then reads: needing a person 1 (CHANNELARCHIVES
            -008, not held here), currently retrying 0.

## 2026-09-22 21:55 — Home: tiles agree with their pages, and look like one set
Intent:     Brief 2, item 4.
Verified:   Open loops 712 = 638 + 74, oldest 52 d (matches page). Codex 10
            this week, 4 awaiting (now counted by stage, as the page does, not
            by Jason Status alone). Build patterns 182 / 147 broad. North Star
            46 asks, Research Twin 5 (3 answered, 2 needs human). Engine health
            0 open (all 54 held are closed) — its signal now follows the page.
Problem:    The twins' 7-day trend was counted against the fixtures' reference
            date (7 Sep), so it was all zeros; now today.
Fix:        Each tile: icon and name, one figure at 26px in the display face (a
            dash at the same size where there is none), what it counts, then the
            signal as a sentence with the health dot — two lines reserved so the
            tiles are even. Grid 5 across on wide screens. Signals rewritten as
            sentences ("The oldest has been open 52 days."). Green only on a tile
            with data; a "not wired up" tile gets a neutral dot.
Not done:   CLAUDE.md says one tile per sidebar section; Customer Service Twin,
            Clients, Executions and Pay Tracker have none. Not in the brief, so
            raised rather than built. The two 24-hour columns are still the
            phase 1 fixtures CLAUDE.md says they are, dated 7 Sep.

## 2026-09-22 19:50 UTC — Production check after bb8a19b
Verified:   Live /api/overview: every signal is a sentence; Engine health "0
            incidents open" beside "1 exhausted retry needs a person." (was 5);
            Open loops 712, oldest 52 d; Codex 4 awaiting; Commercial 86 open
            research questions, which is what SQL gives by the rule as shipped
            (count wins, a 0 or no count beside listed questions counts the list;
            all 28 cards state something). The 21:45 entry's "80" was a
            list-first draft of the rule, not what shipped. North Star and
            Research Twin now show real 7-day trends (NS 0,0,7,14,7,1,17). Retries:
            currently retrying 0 (was 2), exhausted 5 on the record tab.
Not read:   /api/pay/metrics?month= and /api/engine-health/metrics are templated
            routes the MCP read tool will not resolve, so Pay's scoped figures
            on production rest on the SQL check and the local test above.

## 2026-09-23 08:40 — vFarm Early Access: Form A leads from n8n, every answer kept
Intent:     Destiny, 23 Sep. All Early Access leads now arrive through Hardik's
            Google Form A (directly, or from bhanetwork.org/vfarm, which submits
            into Form A). His n8n tracker pushes each one here and sends the
            Slack alert. The public route is origin-checked for browsers and
            keeps three fields, so n8n cannot use it and it would lose the rest.
Files:      server/src/earlyAccess.ts (storeFormA), server/src/index.ts (route in
            the engine block), server/src/migrations.ts (26),
            src/data/formA.ts (new: the 23 questions and their grouping),
            tsconfig.server.json, src/data/types.ts,
            src/screens/VFarm/EarlyAccess.tsx, README.md, CLAUDE.md
Data:       Question text read, not assumed: the "Check The Signup" node of n8n
            "vFarm Early Access — Website Intake" (xxME1VLRkPdlLpaV) keys its row
            by the response sheet's headers "character for character", and the
            sheet itself (1ssxxdB5…, "Form Responses 1") carries the same 24
            headers — Timestamp plus 23 answers, two ending in a space.
            Tracker (fhQNvRFdh1H6Li0E): buyer_intake_id = VFBUYER-FORMA-<hash of
            email|Timestamp>, correlation_id = VFARM-FORMA-<same>,
            early_access_lead_id = VFLEAD-<ms>-<6> (reused per email),
            source_campaign "vfarm_flagship_1031"; it has no submitted_at field
            of its own (created_at = the Form A Timestamp).
Found:      - The tracker has no HTTP node and no Slack node today: nothing posts
              to this dashboard or to Slack yet. The website intake's sticky
              note says the tracker does both; it does not. Hardik's to add.
            - Form A's section titles are not readable from anything this
              dashboard can reach (n8n, the sheet, Drive search). The grouping
              on the page is by subject in the form's order, labelled as this
              page's, in one constant to replace when the real titles are read.
Fix:        POST /api/engine/vfarm-leads behind x-dashboard-key, logged to
            engine_writes as kind vfarm_leads. Columns for name, email, org;
            form_a jsonb for answers + the five tracker fields; upsert on a
            unique index over form_a->>'buyer_intake_id'; status and notes never
            touched by an update. No Slack from here. The public route is marked
            superseded in code, README and CLAUDE.md, and kept. The Early Access
            tab opens a lead to every answer, grouped; the "not announced" marker
            is limited to old-route leads.
Tested:     Local: migration 26 applied; the same body posted twice → 201
            inserted then 200 updated, same id, one row, 23 answers; no key →
            401; no buyer_intake_id → 422; status 'contacted' and notes set by
            hand survive a third post. Screenshot shows the grouped answers.

## 2026-09-23 10:20 — Build patterns: a Candidates tab for engine_pattern_candidates
Intent:     Destiny, 23 Sep. Pattern candidates moved from Airtable into
            engine_pattern_candidates on 21 Sep (the final import landed 40) and
            nothing showed them; Bays' instructions still link the retired
            Airtable view. A read-only tab at /build-patterns?view=candidates.
Files:      server/src/engine.ts (getPatternCandidates), server/src/index.ts
            (GET /api/pattern-candidates, cookie), src/data/{index,types}.ts,
            src/screens/BuildPatterns.tsx, CLAUDE.md
Data:       describe_schema on engine_pattern_candidates: id, airtable_record_id,
            natural_id, lane_id, builder_id, created_time, fields, source,
            first_seen_at, updated_at; 45 rows. mirror.ts KINDS:
            pattern_candidates → engine_pattern_candidates, naturalField null,
            keyOnNatural. Field keys read off the rows (jsonb_object_keys): the
            twelve every row has, plus Pattern ID and Registered At on 5.
            Status: Proposed 40 (flagged 16–20 Sep), Registered 5 (flagged 22
            Sep, registered 23 Sep 11:05), Approved 0. All 45 have
            airtable_record_id null. The five Pattern IDs all exist in
            engine_build_patterns (checked by natural_id).
Problem:    My first check guessed the patterns table as engine_patterns:
            "relation \"engine_patterns\" does not exist". The mirror map says
            engine_build_patterns — the same class of mistake the brief warned
            about, caught by reading mirror.ts rather than guessing again.
Decision:   The tab is in the URL (?view=candidates / ?view=statistics; Patterns
            carries none) through react-router's useSearchParams — no page kept
            a tab in the address before, and the brief needs a linkable one.
            The Pattern ID link finds the pattern in the list the page already
            holds and calls the Patterns tab's own setOpen after switching tab:
            the same dialog, not a second one. Status counts are a Segmented
            filter (the page's existing clickable-count control). An unknown
            status would get its own "Other status" option rather than vanish.
Tested:     Local, seeded one pattern and three candidates: route returns them
            newest first; no cookie → 401 and the inbound key alone → 401;
            screenshots of the tab at ?view=candidates, the candidate dialog
            with the Pattern ID, and the click through to that pattern's dialog
            on the Patterns tab.

## 2026-09-23 11:45 — Pay Tracker: Open shows the Codex entry; no Airtable on /pay
Intent:     Destiny, 23 Sep. "Codex" on a pay session opened s.codex_link, which
            is the Otter recording, and "Airtable" pointed at a retired base
            (AIRTABLE_RETIRED=true). One "Open" button that shows the session's
            Codex entry in the Codex page's own dialog; no Airtable on /pay; and
            LOOP-1790112860892-45ZS, the Sessions tab listing every month.
Files:      src/screens/CodexEntryDialog.tsx (new: the dialog and its helpers,
            moved whole from Codex.tsx), src/screens/Codex.tsx,
            src/screens/PayTracker/{Owed,Sessions,Statements}.tsx,
            server/src/store.ts (codexForPaySession), server/src/index.ts
            (GET /api/pay/sessions/:id/codex), server/src/pay.ts (wording),
            src/data/index.ts, CLAUDE.md
Data:       engine_pay_sessions: natural_id = Codex Entry ID, fields carry
            "Codex Entry ID" and "Codex Link" (Otter). engine_codex_submissions
            is keyed by Submission ID; only 67 of 211 rows carry "Codex Entry
            ID". CODEX-20260921-ahad-vfarm-integration is row 206
            (U0AC6RFNP3P_1790028328627) by id. CODEX-20260917-ahad-cst-tenancy-
            voice-boundaries matches no Codex Entry ID at all: its row is 186
            (U0AC6RFNP3P_1789681773186), which carries none, and whose "Session
            Url" is exactly the pay session's Codex Link. Across all 78 sessions:
            67 resolve by id, 11 only by recording URL, 0 ambiguous, 0 none.
Decision:   Resolved on the server, id first then recording URL, each only on
            exactly one match — two is a 409 naming both, none a 404 ("No Codex
            entry is held for this session."), shown neutral rather than red.
            The dialog is read-only on /pay (no Approve / Send back / Delete /
            Airtable) because Pay Tracker has no write path; the Codex page keeps
            all of them. The Otter link stays in the dialog as the narration
            link. Every other Airtable word on /pay went too: the Owed empty
            state, two Sessions notes, the Sessions SourceLink ("Airtable ↗"),
            Statements' "Open in Airtable", and two notes pay.ts writes.
Problem:    Sessions was already month-scoped (4ba4feb, 19:25 UTC on 22 Sep); the
            loop was raised at 21:34. With an August row seeded locally the tab
            shows only September — but its "N rows are held for M sessions" line
            counted the whole ledger. It now says so ("Across the whole ledger,
            not only this month"). Every production session is in 2026-09, so
            the month scope cannot be seen there until October.
Tested:     Local: CODEX-1 → 200 by codex_entry_id; CODEX-2 → 200 by
            session_url; CODEX-3 → 404 with the sentence. Screenshots: Sessions
            scoped to Sep (4 of 5 held), Open from Sessions and from Owed shows
            the read-only dialog with the Otter link inside, the 404 dialog, and
            the Codex page's dialog still carrying its actions.

## 2026-09-23 12:30 — Airtable removed from the interface; Pay session buttons confirmed live
Intent:     Destiny, 23 Sep. Two jobs: remove every trace of Airtable from the
            UI (AIRTABLE_RETIRED=true since 21 Sep; any link there opens a stale,
            capped copy), and the Pay Tracker "Open" buttons + Sessions month
            scope (LOOP-1790112860892-45ZS).
Job 2:      Already built and pushed as 5a809bc in the previous turn, and live:
            production's search_source shows codexForPaySession in store.ts and
            the /api/pay/sessions/:id/codex route in index.ts. Not redone.
Files:      src/components/ui/{Records,Resync,SourceLink}.tsx;
            src/screens/{BuildPatterns,Clients,Codex,CodexEntryDialog,
            Commercial,NorthStar,ResearchTwin,Settings,clientDefinitions,
            recordDefinitions}.tsx/.ts; src/screens/OpenLoops/{LoopPanel,Loops,
            definitions,index}; src/screens/EngineHealth/{LaneView,Retries}.tsx;
            src/screens/Registry/index.tsx; server/src/{engine,health,store,
            registrySeed,migrations}.ts (27); CLAUDE.md.
Fix:        grep -rniE airtable src/ started at 241 hits; worked through each.
            Removed: 8 "Open in Airtable" dialog buttons, 9 row actions (incl.
            Registry's base action), the LoopPanel "Airtable record" field, 7
            airtable_url CSV columns (airtable_record_id → record_id, same
            value), 7 "source" columns and every SourceLink of kind airtable
            (the component now draws nothing for it), and two Settings rows
            about the write-back. ResyncButton draws only with a live source
            (Engine health: "Resync from BHARAG"). unlanded() returns false, so
            the not-landed marker, the stranded-loops banner and the "Airtable
            did not take it" toasts stop drawing. Reworded: every "Resync from
            Airtable" hint, the Clients provenance line and status tooltip,
            four definitions, the Codex delete wording and toast, and five
            server notes a page shows (loops note, Commercial trend note, the
            empty-kind note and resync line in health.ts, a delete refusal).
Decision:   Registry keeps Airtable as a service, now retired (migration 27,
            guarded on the seeded row), with its url shown unlinked; the bases
            stay as the "history" section, with no action. API payloads,
            airtable_record_id and the importers are untouched. Resync call
            sites on the Airtable-only pages stay; the button draws nothing.
Tested:     Local build; migration 27 applied; a Playwright scan of 17 routes'
            rendered text, title attributes and hrefs finds "airtable" on one
            only — Engine health, where an incident's own n8n node is named
            "Update Jason Review (Airtable)". That is engine data, shown as
            written. Final grep: 162 hits, all comments, identifiers, payload
            types, fixtures or the registry's history section.

## 2026-09-23 12:55 — Pay at write time, and live pages
Intent:     Two parts, one pass. (A) Keep the pay ledger in step with the
            session logs inside the write that changes a log, so n8n's
            "Bays — Pay Ledger Sync" (every 30 min) can be retired. (B) Make
            open pages refresh themselves the moment data changes. Dashboard
            repo only; nothing in n8n changed (the workflow was read, not
            edited).
Files:      server/src/paySync.ts (new), server/src/events.ts (new),
            server/src/pg.ts (afterCommit), server/src/mirror.ts (hooks in
            upsert and patchFields), server/src/index.ts (POST
            /api/engine/pay/reconcile, GET /api/events, loopback refuses
            /api/events), server/src/store.ts, health.ts, pay.ts,
            executions.ts, repairs.ts, earlyAccess.ts, registry.ts (change
            events on every other write and delete path);
            server/test/pay-sync.test.cjs (new), package.json (test:pay);
            src/app/live.tsx (new), src/app/useData.ts, src/main.tsx,
            src/components/ui/Live.tsx (new), src/components/ui/index.ts,
            src/screens/PayTracker/{index,Owed}.tsx, Codex.tsx,
            OpenLoops/index.tsx, BuildPatterns.tsx, Commercial.tsx,
            NorthStar.tsx, ResearchTwin.tsx, Clients.tsx, VFarm/index.tsx,
            EngineHealth/{index,LaneView,Retries,Repairs,kinds}.tsx/.ts,
            Executions/index.tsx, Registry/index.tsx; CLAUDE.md; README.md.
Problem:    Read the live ledger before writing anything: 147 pay_sessions
            rows for 79 Codex Entry IDs. 68 are bound to an Airtable record id
            (the 20 Sep import) and 79 are n8n's own posts with none; upsert's
            natural-id match only adopts an unclaimed row, so the two never
            merged. pay.sessionsHeld already dedupes, preferring the engine
            copy. A sync that updated one copy would leave the page reading the
            other.
            Also found: n8n's node wrote Paid At = Jason Reviewed At (the
            approval, not the payment) and re-wrote Pay Mode every half hour.
            And test:gate fails its "every outcome reached engine_mcp_writes"
            check on any second run against the same database
            ("3 !== 1") — it counts audit rows by tool and never deletes them.
            Pre-existing; not touched.
Fix:        paySync writes every copy of a session to the same state (one Paid
            At for all: the earliest already set, else now). The pay_sessions
            override (applyLogPaid) runs inside upsert and patchFields, so a
            late Paid:false from Pay Tracking — or any PATCH — cannot undo a
            payment. Statement close counts sessions by distinct Codex Entry ID.
            The codex hook runs behind SAVEPOINT pay_sync: a pay failure is
            logged to engine_writes and the Slack approval still lands.
            Events are queued on the transaction client and emitted only after
            COMMIT (pg.afterCommit); a rollback drops them — pinned in the test.
            store.bumpVersion subscribes to the bus so memoised figures cannot
            outlive an engine write.
            useData: third argument takes { refreshMs, kinds } (a bare number
            still works); quiet re-read debounced 750ms; sequence numbers so a
            slow older answer never overwrites a newer one. LiveProvider's
            subscribe is a stable useCallback — a new function on every
            connect/disconnect would have re-run every page's first load and
            flashed it. Pay and vFarm kept a local copy (held ?? loaded) that
            shadowed every later read; Pay's is gone (its resync is retired),
            vFarm's is cleared on each fresh read.
Decision:   Pay Mode frozen, Paid At = flip time, and Slack Card Link kept —
            per the brief, and each a deliberate departure from the node.
            The Pay header's Resync button and the "last synced by the 30-min
            sync" wording are replaced by a Live indicator (green dot "Live",
            grey "Not live"); grey not amber, because a dropped stream is the
            page catching up slowly, not an engine fault.
            Verified locally: npm run test:pay 9/9; test:lookup passes; build
            passes. Playwright with /pay and /codex already open: an approval
            POSTed to /api/engine/codex appeared on /pay after 802ms; a Paid
            PATCH by-natural showed "paid · Jason" on /pay after 818ms.
            Reconcile run twice locally: second run 0 created, 0 updated.

## 2026-09-23 13:05 — Pay reconcile also runs at boot
Intent:     Run the first production reconcile and report its counts.
Files:      server/src/index.ts (boot), CLAUDE.md.
Problem:    POST /api/engine/pay/reconcile needs DASHBOARD_INBOUND_KEY, which
            this session does not hold, and the Render tools asked for a
            workspace to be chosen, which is not mine to guess.
Fix:        boot() runs paySync.reconcile() in the background after the
            migrations, prints the counts, and writes them to engine_writes
            (endpoint 'boot', method 'RECONCILE'), where query_postgres reads
            them. Idempotent, so running it every boot costs a few hundred ms
            and changes nothing when the ledger is already in step.
Decision:   Every boot rather than once: a log written while the process was
            restarting never reached the hook, and this is what catches it.

## 2026-09-23 13:05 — First production pay reconcile
Intent:     Confirm 9cb4fa4 is live and read the first reconcile.
Files:      BUILD_LOG.md only.
Problem:    None.
Fix:        —
Decision:   Read off engine_writes (endpoint 'boot', 12:56:18Z): 79 checked,
            0 created, 10 updated, 69 unchanged, 0 statements closed, 2,760ms.
            All 10 updates were the Airtable-import copies (bound to a record
            id) of unpaid sessions, given the fields n8n's copies already had;
            none changed Paid. After it: 0 pay rows disagree with their log
            about Paid; 147 rows for 79 sessions, as before.

## 2026-09-23 14:05 — Home: every number read (Part B)
Intent:     Make every figure on Home real: the two 24-hour feeds, one
            definition of open loops, North Star's tile, the placeholder tiles,
            and live updates on every panel.
Files:      server/src/feeds.ts (new), server/src/engine.ts, server/src/store.ts
            (countOpenLoops), server/src/index.ts (open_loops on GET
            /api/engine/loops; /api/north-star and /api/research-twin removed),
            src/data/types.ts (FeedItem, tile figures/muted, open_count),
            src/data/index.ts, src/screens/Overview.tsx,
            src/screens/OpenLoops/index.tsx, src/screens/BuildPatterns.tsx,
            src/screens/Commercial.tsx, src/screens/VFarm/{index,EarlyAccess}.tsx,
            src/screens/EngineHealth/{index,LaneView}.tsx; CLAUDE.md.
Problem:    engine.getOverview returned 11 "broke" and 11 "moved" rows typed
            by hand in phase 1 ("pH above ceiling on rack-a/tier-3", "North
            Star credential rotated") under a heading claiming the last 24
            hours. The open-loop "discrepancy": Home 713, "about 311" quoted
            elsewhere. Read production: 638 Open + 75 In Progress = 713 rows,
            713 distinct loop_ids, 710 distinct What texts, no archived or
            deleted field on any of the 984 rows. The 311 is Bays' digest to
            Destiny on 21 Sep in #workflow-logs-destiny — "Your top 5 of 311"
            — Destiny's own table (324 today), not the team total.
            North Star's tile read "Every answer reached someone." beside a ring
            "1 of 46 answered": Delivered and Answered in one breath.
Fix:        feeds.ts reads engine_incidents (own date in window), error_counts
            and retry_attempts (updated_at in window, folded into a listed
            incident), codex (Jason Reviewed At, Approved/Input Added), events
            (loops closed, via engine/ui/inbound), patterns, pattern
            candidates, commercial and engine_vfarm_leads. Each item has a
            `to`; Engine health opens ?incident=, Build patterns and Commercial
            ?open=, vFarm ?tab=early-access&lead=. countOpenLoops() keeps one
            row per loop_id (newest) and counts Open + In Progress; Home's pin,
            tile and Loops by builder, the Open loops header and the engine
            lookup all read it. NS tile: two figures, Delivered (reached a
            person) and Answered, N of M; the sentence speaks for the weaker.
            vFarm tile: leads, last 7 days, newest date. Media Twin / Genie:
            "Not connected yet", greyed. Home passes kinds for every panel.
            Also removed: /api/north-star and /api/research-twin (fixture
            twins, no page read them since 17 Sep) and Ask Bays' seeded sample
            chat threads (fixtures/chat.ts); the history panel shows only
            threads this browser has had.
Decision:   Verified locally with Playwright: an approval PATCHed to
            /api/engine/codex appeared in "What moved" on an open Home tab
            after 869ms, and clicking it opened /codex/<id> with the entry.

## 2026-09-23 14:40 — Design system pass, gold primary, one Button (Part A)
Intent:     Apply the Claude Design handoff across every page, with gold
            primary buttons, one shared Button, tokens only, both themes right
            and no theme flash.
Files:      src/index.css (tokens, controls), index.html (pre-paint theme),
            src/components/ui/Button.tsx (new: Button, ButtonLink,
            ButtonAnchor), src/components/ui/{index,RowActions,Resync,
            Pagination}.tsx, src/components/{Layout,RecordStatistics}.tsx, and
            every screen with a button: AskBays, BuildPatterns, Clients,
            CodexEntryDialog, Commercial, EngineHealth/{LaneView,Repairs,
            Retries,parts}, Executions, Login, NorthStar, OpenLoops/{index,
            LoopPanel,Loops,NewLoop}, Overview, PayTracker/{Owed,Sessions,
            Statements}, Registry/Editable, ResearchTwin, Settings,
            VFarm/EarlyAccess; server/src/engine.ts (a date in copy); CLAUDE.md.
Problem:    The brief's handoff block was an unfilled placeholder ("<<< PASTE
            CLAUDE DESIGN HANDOFF HERE >>>"). The handoff is the Design System
            artifact "Bays Horizon Network" (SeZtHVhnw6MKm1PSPv6xMs), read
            whole: it is this repo's own tokens and controls plus three
            accessibility corrections — and it says "Gold is not a UI colour.
            No gold buttons ... on the dashboard", reserving brand-gold for the
            public site. Asked Destiny; answer: "my brief, but if you check the
            design system, it has not been updated". Its lastChange confirms
            that: only "Brand gold matched to the live site".
            The first codemod run died with "ValueError: no end" on
            Repairs.tsx:264 — a `// ... the server's own reason` comment
            between JSX attributes, whose apostrophe the tag scanner read as
            a quote. Fixed by skipping line comments that start a line.
Fix:        Tokens: accent #0a6ee6 (light), accent-on (#fff / #141416),
            brand-gold #e0b84a / bright #eac765 / deep #9a7b2e / black #0a0a0a,
            --primary* mapped to them, --danger* (#b3261e white 6.54:1; dark
            #ff6961 near-black 6.52:1), --on-tile, --shadow-glass, and the
            select chevron as a per-theme token. No colour literal outside the
            two token blocks; no component names a hex or rgb value (grep
            clean). Tag labels ink; sidebar group labels dim; two uppercase
            headings removed. Button: primary / secondary / ghost / destructive
            with hover (never on disabled or busy), focus-visible 2px accent at
            2px offset, disabled 0.5, loading spinner + aria-busy. 52 buttons,
            7 external links and 1 router link moved onto it; Resync, Open,
            Commercial's readiness setters, filters and row actions are
            secondary/ghost; Codex Delete is destructive. Theme set before
            first paint by an inline script reading bha.theme.
Decision:   Gold primary per Destiny, over the design system and the
            2026-09-08 "no gold" rule, recorded in CLAUDE.md §5. Label
            #0a0a0a on #e0b84a is 10.49:1; the fill is 1.73:1 on the light page,
            so light adds a brand-gold-deep hairline (3.68:1). The dashboard's
            12px button shape is kept — the design system's pill and glow are
            the public site's signature, not the dashboard's. Tabs, segmented
            controls, keyword chips and clickable rows stay their own shared
            primitives rather than becoming Buttons.
            Verified: Playwright over 23 routes (tabs included) in each theme —
            data-theme correct at domcontentloaded on every one (dark first
            paint rgb(20,20,22)), no sideways scroll, at most one .btn-primary
            per screen; only console error is Google Fonts' certificate in this
            sandbox's proxy. Build, test:pay (9/9) and test:lookup pass.

## 2026-09-23 14:45 — Correction to the 14:40 entry
Intent:     Put the right count on the record.
Files:      BUILD_LOG.md only.
Problem:    The 14:40 entry says "52 buttons" moved onto <Button>; that was
            written before counting.
Fix:        Counted in the source after the commit (0b40d91): 55 <Button>, 7
            <ButtonAnchor>, 1 <ButtonLink>.
Decision:   Recorded as its own entry rather than editing the earlier one.

## 2026-09-23 14:50 — Open loops: 713 → 712, and a correction
Intent:     Check the new open-loop count against production after deploy.
Files:      CLAUDE.md; BUILD_LOG.md.
Problem:    Production Home now reads 712. The 14:05 entry and CLAUDE.md said
            "713 distinct loop_ids": that was counted as distinct ids *within
            each status* (638 Open, 75 In Progress), not across them. Across
            them there are 712. The one loop held twice is
            LOOP-1789784029288-MN0M — row 908 in Destiny's table
            (tblBJekl3ROpNZxQW, Open, last written 19 Sep 02:13Z) and row 926 in
            Hardik's (tblaloC4JIRdBq5EM, In Progress, 20 Sep 18:33Z): a move
            whose source copy was never removed.
Fix:        countOpenLoops() already keeps one row per loop_id, the newest, so
            it counts the loop once, as Hardik's In Progress. CLAUDE.md
            corrected to say 712 and why.
Decision:   The stale row is left where it is: this dashboard does not delete
            an engine row it was not asked to touch. It still appears on the
            Open loops list under Destiny and in any digest that reads
            Destiny's table row by row.

## 2026-09-23 14:55 — Full-page screenshots no longer cut
Intent:     Destiny: "when i'm using a chrome screenshot extension to screenshot
            the full page its always cut".
Files:      src/index.css (a document-scroll block at the end, outside the
            layers), src/components/Layout.tsx, src/app/zoom.tsx, index.html,
            CLAUDE.md.
Problem:    The shell was h-full all the way down with main md:overflow-hidden,
            so the window never scrolled: every page scrolled inside its own
            `min-h-0 flex-1 overflow-y-auto` panel (40-odd of them). A full-page
            capture measures and scrolls the window, so it got one screen.
            First fix: the sticky sidebar still scrolled away — computed
            `position: static`, because Tailwind's `md:static` lives in the
            utilities layer, which beats a more specific rule in an earlier
            layer. Second: the sidebar stopped 20% short of the window —
            `vh` inside the 80% zoom on <html> is scaled by it.
Fix:        html[data-scroll="document"] makes html, body, #root and the
            shell grow with their content, so every page panel grows too and
            none needs a scrollbar; the sidebar is sticky at
            calc(100vh / var(--zoom)), the top bar sticky with a -84px margin so
            it still overlays; the aurora wash is fixed to the viewport. The
            block moved out of the layers. ZoomProvider publishes --zoom.
            index.html sets data-scroll before first paint.
Decision:   Every page but Ask Bays; the chat keeps its pinned input. The zoom
            stays on <html>: moving it to <body> was tried and changes nothing
            the page reports (scrollHeight 1202 either way, correct), and it
            would have split portals from the page.
            Verified with Playwright: the window scrolls on every route
            (Home 1202 over an 800 viewport), no element inside main scrolls on
            its own, sidebar and bar at top 0 after scrolling to the bottom, 46
            route captures in both themes clean. Playwright's own fullPage PNG
            carries blank margin at 80% zoom (1800×1502 for 1440×1202) — a
            quirk of its CDP capture under CSS zoom; the page reports its true
            size, which is what scroll-and-stitch extensions read.

## 2026-09-23 20:20 — Engine recovery: the dashboard side (brief D2)
Intent:     When a workflow fails because something it depends on is down
            (OpenRouter credit, a Slack or Google login, BHARAG), re-run it
            from the failed step once that thing is back, close the ledger
            incident, and send one Slack summary per recovery. The n8n side
            (Engine — Dependency Probe, Engine — Recovery Summary, the healer's
            `recovery: true`) was already built; this is the watcher.
Files:      server/src/recovery.ts (new), server/src/bharag.ts (closeIncident
            takes the target state; markRetrying; liveIncidents reads open and
            retrying; HealRequest gains recovery and error_message),
            server/src/n8n.ts (executionDetail, includeData=true),
            server/src/migrations.ts (28: engine_recovery,
            engine_recovery_batches, registry_workflows.replay + five `never`),
            server/src/registry.ts + registrySeed.ts (replay field, notNull),
            server/src/index.ts (GET /api/engine/recovery/plan, the page route,
            toggle, Re-run now, boot line, startWatching),
            server/src/mcp/tools.ts (get_recovery_status),
            src/screens/EngineHealth/Recovery.tsx (new) + index.tsx + kinds.ts,
            src/screens/Registry/index.tsx (replay column), src/data/*,
            server/test/recovery.test.cjs + package.json (test:recovery),
            render.yaml (RECOVERY_ENABLED), CLAUDE.md.
Problem:    Nothing re-ran a failure once its dependency came back: the healer
            gives up after three attempts over ~20 minutes, and an outage lasts
            longer. Two traps found while building, both before they shipped:
            (1) an incident the schedule already exhausted carries an old
            `Exhausted` retry_attempts row, so settling a re-run by "the row's
            status" would have failed every recovery the moment it started;
            (2) the ledger's `status=open` read misses incidents the error
            handler moved to `retrying` as repeats — Self Healer Reports reads
            both for the same reason.
Fix:        Settling only accepts a retry row written after the re-run started
            (last_attempt_at, else updated_at, against replay_started_at).
            The live read asks for open and retrying both, the retrying half
            allowed to fail alone. The close path copies Self Healer Reports
            exactly: `{ resolution_status: 'retrying' }`, then
            `{ resolution_status, payload_patch: { resolved_at, resolved_by } }`
            and nothing else at the top level.
Decision:   The ledger is the queue; engine_recovery holds decisions, not
            payloads. One row per incident, so an incident is recovered at
            most once — failed_again belongs to a person. What an incident
            waits on is worked out every time from its class, its failed
            node's credential or URL host (each falling back to the other),
            never written to BHARAG. Where the ledger or n8n cannot be asked the
            row goes back to waiting rather than being guessed at. Re-run now is
            a batch of one with its own summary, so a manual recovery is in the
            same channel as an automatic one, and it is refused while recovery
            is switched off. The summary is claimed with
            `UPDATE … WHERE summary_sent_at IS NULL` so it can go only once.
            Recovery is a seventh Engine health tab rather than a panel on All
            systems, which the 22 Sep decision keeps to the table.
            Verified: typecheck and build clean; npm run test:recovery (new —
            local stand-ins for BHARAG, n8n, both webhooks and the healer; 30+
            assertions: classification by class / credential / host, the 30-min
            rule, no probe when nothing waits, heal carries recovery: true,
            chat reply closed retrying → wont_fix → manually_resolved on
            refusal, data_gone, already_done via retrySuccessId, the old
            Exhausted row ignored, exactly one summary across three ticks, the
            plan makes no call, off makes no call, the flip is logged);
            test:gate, test:pay and test:lookup still pass on a local database;
            the server boots, the plan answers 200 with the key and 401
            without; the Recovery tab and the registry's replay column render
            with no page errors (five `never` rows).
            Not verified here: the live end-to-end trace (a real BILLING_QUOTA
            or CONFIG_AUTH incident through to one message in
            #bha-self-healing). There are no open incidents in the ledger
            mirror tonight, and it has to run against the deployed service.

## 2026-09-23 20:25 — Engine recovery: first live run
Intent:     Confirm the deploy and trace a case end to end.
Files:      BUILD_LOG.md.
Problem:    None in the code. Worth recording what the first tick found: the
            engine_incidents mirror held no open incidents, but the live ledger
            held 23 open BILLING_QUOTA incidents (the oldest from 4 Sep), all
            from the OpenRouter outage. The mirror only fills on a Resync from
            BHARAG. The watcher reads the ledger live, so it saw them all.
Fix:        —
Decision:   Deploy dep-daq359jtqb8s73bpftbg (c12e1d7) went live 20:13; migration
            28 applied; the five `never` rows are right. First tick 20:14: the
            probe said OpenRouter ok ($30.78, floor $1), and one batch of 23
            (rec-openrouter-20260923201417-ji6c) drained to 20:22:
              18 chat_not_rerun: Bays — Conversational Agent 10,
                 North Star — Conversational Agent 4, North Star — Front Door 4.
                 Closed in the ledger as wont_fix; the ledger accepted it.
              4 data_gone: n8n had pruned 87571, 89965, 89966, 89967.
              1 already_done: Bays — Submit Actions. n8n held a successful
                 retry (3068), so it was closed self_healed.
            One summary went out, HTTP 2xx, "Sent: 23 run(s)".
            Not traced live: a heal call carrying recovery: true. No incident in
            that batch was a re-runnable workflow. `TEST — Self-healing, Bays
            lane` no longer fails (it was repaired on 22 Sep), and making it fail
            with BILLING_QUOTA or CONFIG_AUTH means editing an n8n workflow,
            which CLAUDE.md section 3 does not allow from here. That path is
            covered only by npm run test:recovery until a real failure takes it.

## 2026-09-24 04:50 — MCP write tools: two tokens, one write path, the Tools Router's guards
Intent:     Let Destiny (through Claude) and the Bays n8n Agent create, update,
            archive and delete engine records over MCP. The same safety checks
            the Bays Tools Router enforces must apply, and the writes must go
            through the exact server functions n8n's POST and PATCH use.
Files:      server/src/engineWrite.ts (new: postRecord, patchRecord,
            resolveRow), server/src/index.ts (the three engine write routes now
            call it; /api/engine-health/mcp-writes; boot line),
            server/src/writeGuards.ts (new: the ported guards and the writable
            kind registry), server/src/mcp/writeTools.ts (new: the five tools
            and the audit), server/src/mcp/index.ts (MCP_WRITE_TOKEN, access per
            connection), server/src/mcp/tools.ts (catalogue per access),
            server/src/mirror.ts (readRow, deleteRow, columnsOf exported,
            'deleted' outcome), server/src/bharag.ts (ingest + three workspace
            keys), server/src/migrations.ts (29: engine_mcp_writes columns),
            src/screens/EngineHealth/McpWrites.tsx (new) + index.tsx,
            src/data/*, server/test/mcp-write.test.cjs + package.json
            (test:mcp-write), render.yaml, CLAUDE.md.
Problem:    Three things the brief could not be followed literally on, each
            settled in the code rather than guessed:
            (1) `engine_mcp_writes` already exists — the write gate made it on
            20 Sep, and its `token` column holds the gate's one-use preview
            token. So migration 29 extends that table instead of creating a
            second one with the same name. The brief's read/write "token" is
            the column `access`.
            (2) "archive sets the archived/closed state the page already
            understands": only loops have one (Status = Closed). Candidates are
            Proposed / Approved / Registered and the Candidates tab draws
            anything else as "Other status". So archive is refused by name for
            every other kind rather than inventing a status.
            (3) Candidates are not in the Tools Router at all. They are two
            tool nodes on Bays — Conversational Agent (Flag_Pattern_Candidate,
            which mints CAND- ids and writes Status Proposed), and those are
            what was ported.
            Two smaller points. The duplicate gate in n8n searches every row in
            the assignee's table, closed ones included; the brief says "open
            loops", so this searches Open and In Progress only. And
            `test:gate` fails one check when re-run on a database it has
            already run against: it counts every `test_set_lead_status` row in
            the table, earlier runs included (3 applied after 3 runs). That is
            the test's own isolation, not this change. On a fresh database it
            passes all its checks, including against the new columns.
Fix:        —
Decision:   One write path: the route bodies moved into engineWrite.ts and
            both the routes and the tools call it. On engine_writes an MCP
            write reads endpoint mcp:<tool>, key MCP_WRITE_TOKEN.
            On the read connection the write tools are not registered at all,
            rather than listed and refused. A write token equal to the read
            secret is ignored and the boot line says so.
            The audit line is opened before the change and closed after it, so
            a write that cannot be audited does not happen.
            create_record never overwrites: a natural id already held is
            refused and update_record is named.
            Hard delete keeps the row in record_deletions first. It needs
            "DELETE <natural_id>" exactly, and codex is refused outright.
            A BHARAG ingest that does not land is reported as saved:true,
            ingested_to_bharag:false with a note that it is not full success.
            Verified locally, against the real server process over HTTP and a
            local database, with a stand-in for BHARAG's /ingest. npm run
            test:mcp-write passes all eight done-means checks, plus:
            - a non-admin is refused on somebody else's loop;
            - an unknown lane is refused on update;
            - a dry run writes nothing;
            - a wrong confirm is refused and a codex delete is refused;
            - a pattern gets a BP-BHARAG- id, a joined checklist and an ingest
              with the right key, tags and metadata;
            - a commercial card with no key is saved:true,
              ingested_to_bharag:false;
            - a candidate goes to Proposed and a same-name repeat is refused;
            - every call is audited with none left pending;
            - the n8n POST and by-natural PATCH routes still answer as before.
            test:pay, test:lookup and test:recovery still pass. The MCP writes
            tab renders with no page errors.

## 2026-09-24 04:50 — MCP write connection: deployed
Intent:     Put the write connection live and run the done-means checks
            against production.
Files:      BUILD_LOG.md.
Problem:    This session's cloud sandbox cannot reach the service. The network
            policy answers `CONNECT tunnel failed, response 403` for
            bha-engine-dashboard.onrender.com and dashboard.bhanetwork.org.
            So checks 1–7 could not be run against production from here.
Fix:        —
Decision:   MCP_WRITE_TOKEN was generated (48 random url-safe characters) and
            set on srv-dagj84ijnfac73ds5100, with Destiny's go-ahead, in Bays'
            workspace, merged so nothing else changed. Deploy
            dep-daqam3c9v7es73cfucog (6531fff) went live 04:46:46Z. The boot
            line reads "/mcp/<MCP_WRITE_TOKEN> — the write connection …", and
            migration 29 is applied (the seven new engine_mcp_writes columns
            are present). Check 8 holds on production: the read connector lists
            no write tool.
            Checks 1–7 on production are still to run. They pass locally, end
            to end (npm run test:mcp-write). They need the write URL added as a
            connector, or this environment allowed to reach the Render host.
            The three BHARAG workspace keys are not set. Their values live in
            n8n credentials this session cannot read, so until they are set, a
            Codex / pattern / commercial create answers ingested_to_bharag:
            false.

## 2026-09-24 05:10 — The write tools on the existing MCP URL
Intent:     Destiny: "i want these new tools, all of them to be at this one
            instead of the one you just created, so that i can just refresh tool
            list from claude chat and they show up". The one he means is the
            connector already in Claude, dashboard.bhanetwork.org/mcp/<MCP_SECRET>.
Files:      server/src/mcp/index.ts, server/src/index.ts (boot line),
            CLAUDE.md, BUILD_LOG.md.
Problem:    As first built, a write token equal to the read secret was refused
            and that URL stayed read-only ("one URL cannot be both"). So setting
            the two equal, which is the only way to put the tools on the
            existing URL without a second connector, would have switched the
            write tools off entirely.
Fix:        A write token equal to the read secret now makes that one URL the
            write connection. accessFor checks the write token first, so the
            shared case answers as write. The boot line says "ONE URL" when it
            is so. MCP_WRITE_TOKEN on Render is set to the existing secret, so
            the separate URL minted at 04:46 stops working.
Decision:   This reverses the separation the brief asked for, on Destiny's
            instruction: the read-only connector no longer exists as a
            read-only surface. Setting the two apart again restores it; no code
            change is needed. Verified locally: with both set to one string,
            tools/list on that URL returns 19 tools including all five write
            tools, and npm run test:mcp-write (separate tokens) still passes.

## 2026-09-24 06:10 — find_records, and the duplicate gate stops matching on generic words
Intent:     Brief: one read tool for every writable kind, replacing the six n8n
            read tools the Bays agent uses. Also stop the loop duplicate gate
            refusing asks that share only generic words with an existing loop.
Files:      server/src/mcp/findRecords.ts (new), server/src/mcp/tools.ts
            (registered with the read tools), server/src/writeGuards.ts,
            server/test/mcp-write.test.cjs, CLAUDE.md, BUILD_LOG.md.
Problem:    A dry run of "Dry-run connectivity test from Bays agent" was
            refused as a duplicate of three unrelated loops at score 0.4. Two
            generic words in a two-word ask give 1.0 containment, and 0.35 was
            the only bar. The same rule runs in n8n's LOL - Score Candidates,
            so the same false refusals happen there.
            While testing the new rule, an assertion expected an exact copy of
            the first test loop to be refused, and it was not:
            `+ undefined - 'possible_duplicate'`. That loop had been archived
            (Closed) earlier in the test, and closed loops are not candidates.
            The rule was right and the test was wrong.
Fix:        A candidate counts only where score >= 0.35 AND (shared meaningful
            words >= 3 OR score >= 0.6). test, agent, bays, check, run, build,
            update, new and add are added to the stopwords. Refusals now carry
            the rule and each candidate's shared_words.
            The test copies the still-open loop instead.
Decision:   find_records is registered with the read tools, so the read URL
            and the write URL both list it. In production they are one URL, so
            either way a connected client sees it on refresh.
            The search is RML - Format My Loops' own:
            - its tokeniser, splitting on _ and - too;
            - its stopwords;
            - share of the search's words found, zero dropped, best first.
            That deliberately differs from the duplicate gate's tokeniser, as
            it does in n8n: a search asks "does this row mention it", the gate
            asks "is this the same work".
            Loops come back one row per loop_id, the rule countOpenLoops uses,
            so BAYS open counts agree with the page. Live before this change:
            30 BAYS loops open or in progress.
            An unknown field or an out-of-vocabulary value is applied and
            warned about, never silently dropped.
            Reads are logged to engine_writes as `read`, beside n8n's lookups,
            and not to engine_mcp_writes, which is the MCP writes tab's record
            of changes and would be buried under reads.
            Candidates search Candidate and Summary, not only the name. Only 2
            of 51 candidate names mention self-healing, against 4 summaries.
            Layer 0 today holds only `completed` rows, so the brief's
            pending_builder_input check returns an empty, correct answer.
            Verified locally: npm run test:mcp-write passes the earlier eight
            checks, plus find_records and the duplicate-tuning checks:
            - both connections list find_records;
            - the BAYS count equals a DISTINCT ON count straight from the
              table;
            - the counts sum to the total;
            - the right loop ranks first on a search;
            - an unknown field and an out-of-vocabulary value are both warned
              about;
            - a commercial card is found by card_id;
            - layer0 is readable;
            - the read is logged;
            - the brief's dry-run ask now passes;
            - an exact copy of an open loop is still refused.
            test:recovery, test:lookup and test:pay still pass.

## 2026-09-24 06:07 — find_records and the tuned gate: live
Intent:     Run the brief's done-means against production.
Files:      BUILD_LOG.md.
Problem:    This session's own connector lists the tools it was given when it
            connected, and the server declares listChanged: false. So
            find_records, deployed after that, is not callable from here until
            the connector refreshes. That is the same refresh the brief
            expects a client to do.
Fix:        —
Decision:   Deploy dep-daqbq5ou01pc73clpijg (2eefd32) went live 06:03:47Z.
            #7 live: a dry-run create of "Dry-run connectivity test from Bays
            agent" (BAYS, Destiny) passes every guard, the duplicate gate
            included (audit_id 7).
            #8 live: a dry-run exact copy of open loop LOOP-1790182250648-ZOLH
            is refused possible_duplicate, score 1, 20 shared words, with the
            rule stated (audit_id 8).
            #1–#6 are not yet run live. What they should return, read from
            production with the same one-row-per-loop_id rule:
            - #1: 30 BAYS loops not Closed, In Progress 11 and Open 19.
            - #2: LOOP-1789580654185-C26M is Closed. It will surface on a
              search without status_not, and not with status_not: "Closed".
            - #3: CARD-1790036548913-TTF6 is held, one card.
            - #4: its research jobs number 2.
            - #6: Layer 0 holds 0 pending_builder_input rows; every row is
              `completed`. So the answer is total 0, which is correct.

## 2026-09-24 07:30 — Bays onto the dashboard MCP: n8n, Slack file, Drive tools, pattern Doc, registry
Intent:     Brief: "finish moving Bays onto the dashboard MCP". Add the tools
            the new n8n Agent needs in place of its old n8n tools, give a
            created pattern its Google Doc, give find_records range filters
            and channel_tracking, and bring the registry in step.
Files:      server/src/mcp/n8nTools.ts (new), server/src/mcp/docTools.ts
            (new), server/src/pdf.ts (new), server/src/slack.ts (new),
            server/src/google.ts (new), server/src/n8n.ts (updatedAt),
            server/src/mcp/tools.ts, server/src/mcp/writeTools.ts,
            server/src/mcp/findRecords.ts, server/src/mcp/index.ts,
            server/src/index.ts (boot lines), server/src/registrySeed.ts,
            server/src/migrations.ts (30), server/test/bays-tools.test.cjs
            (new), package.json (test:bays-tools), render.yaml, CLAUDE.md.
Problem:    Three things the brief could not be followed literally on.
            (1) No Slack bot token and no Google credential exist on this
            server. render.yaml, the code and the service's own boot lines
            name neither. n8n's "Admin Google Docs" is an OAuth2 credential n8n
            holds; this server cannot read it. Per the brief, the tools are
            built and answer not_configured, naming the variables, until they
            are set. No workaround was invented.
            (2) "pdf-parse or equivalent": section 2 rule 5 makes pg the only
            dependency. So server/src/pdf.ts is the equivalent: zlib only.
            First run on a Chromium PDF read "Golden CAD run — pr ovenance" and
            "BA YS". Chromium splits a line at every kerning pair with
            `314.125 0 Td`, and the first cut added a space on every same-line
            Td. A same-line move now adds nothing; a real gap is a space glyph.
            It now reads the PDF exactly, including "Ümlaut café “quotes”".
            (3) Bays — Extra Tools (WZHZJ0PXEhswCvxD) was never in the
            registry. It is added as retired, with its purpose left blank and
            the note saying it was not read back, rather than guessed.
            While testing, get_n8n_workflow's unknown-id message said "Use
            list_n8n_workflows…". The test pins the brief's lowercase phrase,
            and the message now carries it verbatim.
Fix:        —
Decision:   create_doc was chosen over a digest_archive option: one tool that
            makes a Doc in a folder, rather than an option that changes what
            another tool does.
            grant_drive_access: the domain rule is isBhaEmail, exactly
            `^[^@\s]+@bhanetwork\.org$`. A refusal calls Google for nothing,
            DMs U0AEW3TBYH1 with the email and file_id, and is audited. It
            DMs on a dry run too, because somebody asked for it either way.
            read_slack_file never follows a redirect: an unauthorised Slack
            file redirects to a 200 sign-in page, and that page would be
            returned as the file's text.
            The pattern Doc is made after the save, in LBP's folder, with the
            BHARAG text; drafted_by defaults to "Bays" as in LBP. A failure is
            doc_created:false with doc_error, and doc_id if the empty Doc
            exists; the record stays.
            Agent Delivery gets replay 'never', like the other chat paths.
            Verified locally: npm run test:bays-tools passes all 19 checks,
            against local stand-ins for n8n, Slack and Google, and a real
            Chromium PDF. test:mcp-write, test:lookup, test:pay and
            test:recovery still pass, and npm run build is clean.

## 2026-09-24 07:25 — find_records reads a JSON-string filter object
Intent:     Prove find_records' new arguments on production.
Files:      server/src/mcp/findRecords.ts, server/test/bays-tools.test.cjs,
            BUILD_LOG.md.
Problem:    Deploy dep-daqct5dckfvc738jd28g went live at 07:18:25Z. The boot
            lines read "SLACK_BAYS_BOT_TOKEN NOT set" and "google: NOT
            configured"; migration 30 was applied and 2 registry rows were
            seeded.
            The first live call, from this session's connector, came back:
            `"filters_gte" must be an object: { "<field>": "<value>" }.`
            The connector still holds the tool list from before the argument
            existed, so it sent the object as a JSON string. n8n agent tool
            parameters typed as strings do the same.
Fix:        filters, filters_gte and filters_lte accept a JSON string that
            parses to an object. Anything else is still refused, with the same
            message.
Decision:   Accepted rather than refused, because the meaning is unambiguous.

## 2026-09-24 08:15 — North Star's three code tools onto the dashboard MCP
Intent:     Brief: port read_slack, read_open_loops and get_priority_evidence
            out of North Star — Tools Router (G6Myypk64kpcaVhz) so the Router
            can retire, the way Bays moved this morning.
Files:      server/src/mcp/northStarTools.ts (new), server/src/slack.ts
            (NS_TOKEN_VAR, webApi), server/src/mcp/tools.ts, server/src/index.ts
            (boot line), server/test/north-star-tools.test.cjs (new),
            package.json (test:north-star), render.yaml, CLAUDE.md.
Problem:    Read first: the Router has 26 nodes. The RS, ROL and PE branches
            are 15 of them: 7 Code nodes and 8 HTTP nodes. The three Slack HTTP
            nodes use slackApi "North Star". The five dashboard reads use
            GET /api/engine/:kind with x-dashboard-key. ROL calls this same
            workflow for Read_Slack with question "LOOP-" and since_hours 168.
            No env var on this server holds the North Star bot token, and no
            code reads one. The Bays token is not a substitute: North Star
            reads with its own bot, which was added to every channel on
            21 Sep.
Fix:        —
Decision:   Ported as written: every cap, clip, label rule, sort and message
            text is copied from the Code nodes. The dashboard reads go through
            mirror.lookup, the function behind the route n8n called, with the
            same limits and orders. So an rt-jobs row still carries no lane_id
            column, and the job's lane comes from its Lane field, as it did
            through HTTP.
            One deliberate difference. ROL - Slack Mentions has onError
            stopWorkflow, so in n8n a Slack failure failed the whole loop
            read. But ROL - Label Loops wraps that read in try/catch, so the
            node was written to carry on without Slack. The port does that:
            it returns the loops with slack_checked:false and slack_error, and
            a note that the labels came from work logs and age only.
            With no threads, the source calls api.test as a placeholder, only
            to keep an n8n item flowing. The port calls nothing.
            Registry: North Star — Agent Delivery is cnOz6iomtnWVXjso in n8n
            (created 07:40, active). It is NOT added until Destiny confirms
            the id, per the brief. The Tools Router is NOT retired yet:
            read_slack cannot be proved live until SLACK_NORTH_STAR_BOT_TOKEN
            is set.
            Verified locally: npm run test:north-star passes 8 checks against
            a Slack stand-in: batching timed at 1.5 s, the token asserted as
            North Star's, clips, cleaning, thread handling, labels and sort,
            the lane filter, the read log. The earlier suites still pass.

## 2026-09-24 08:05 — North Star tools deployed; the 1,000-loop ceiling
Intent:     Put the three North Star tools live and check them against
            production.
Files:      BUILD_LOG.md.
Problem:    Deploy of 36fc9b0 went live at 08:03:27Z. The boot line reads
            "SLACK_NORTH_STAR_BOT_TOKEN NOT set". This session's connector still
            lists the tools it had when it connected, so the three new tools
            were not callable from here.
            Reading production for the same rows the tools read:
            - engine_loops holds 1,004 rows. ROL - Fetch Loops (limit=1000,
              newest first) therefore never sees the 4 oldest, in n8n today
              and in the port.
            - 723 of the 1,000 read are not Closed.
            - rt-jobs: 10 rows; commercial: 30; lanes seen: 28.
Fix:        —
Decision:   The 1,000 ceiling is left as the source has it, per the brief
            ("port as written"). It is raised with Destiny rather than changed
            silently, because it will drop more loops as the table grows.

## 2026-09-24 08:50 — read_open_loops reads every loop; North Star — Agent Delivery registered
Intent:     Destiny: raise the loop limit, so read_open_loops pages through
            every loop rather than reading the newest 1,000. Add North Star —
            Agent Delivery to the registry, now that its id is confirmed.
Files:      server/src/mirror.ts (LookupQuery.offset),
            server/src/mcp/northStarTools.ts, server/src/registrySeed.ts,
            server/test/north-star-tools.test.cjs, CLAUDE.md.
Problem:    Found: ROL - Fetch Loops read limit=1000, newest first. On 24 Sep
            engine_loops held 1,004 rows, so four were never read, in n8n and
            in the first port:
            - LOOP-1787835756742-WG36, kaiqi, Closed;
            - LOOP-1787829302058-FDSM, destiny, Closed;
            - LOOP-1787828953631-CCTQ, jegan, Open;
            - LOOP-1787828951562-TUQ7, jegan, Open.
            So two open loops, both created 27 Aug 11:09, were invisible to
            North Star.
Fix:        mirror.lookup takes an optional offset. The order was already total
            (created_time, then id), so pages cannot overlap or skip.
            read_open_loops reads a thousand at a time until a page comes back
            short or the matched count is reached. The answer now carries
            loop_rows_read.
            The test inserts 1,000 more Closed loops, so 1,007 rows must be
            read, and asserts that they are.
Decision:   North Star — Agent Delivery, cnOz6iomtnWVXjso, goes in through the
            seed, which inserts a missing row on the next boot. Its purpose is
            the workflow's own n8n description. Its replay is `never`, like
            every other chat path.
            The Tools Router is left alone: Destiny retires it once the agent
            is repointed.

## 2026-09-24 09:15 — North Star tools: a size budget, compact shapes, and a 429 that waits once
Intent:     Destiny: the three tools returned figures that matched exactly (725
            open loops, 10 jobs, 30 cards, 31 channels read), but the n8n Agent
            looped on them, so they cannot go live yet.
Files:      server/src/mcp/northStarTools.ts, server/src/slack.ts
            (SlackRateLimited), server/test/north-star-tools.test.cjs,
            CLAUDE.md.
Problem:    search_logs, 08:51–08:57Z. On one whole-board question the agent
            called get_priority_evidence and read_open_loops alternately about
            every 20 seconds: 6 and 5 times in 70 seconds. It did this even
            after an explicit "never call the same read twice" rule. It also
            ran read_slack until Slack rate-limited the North Star bot.
            Answer sizes: read_open_loops 84 KB, get_priority_evidence 82 KB,
            read_slack 66 KB. The Router's versions were much smaller. The
            likely cause is that n8n's MCP client truncates or drops answers
            this big, so the model never sees a usable one and asks again. A
            builder-filtered read_open_loops, called once on its own, came
            back readable.
            In my first try at the budget, the test asserted `held to 2,000:
            2076`. The note was added after the lists were cut, so it pushed
            the answer back over. And at 2,000 even empty lists do not fit: the
            fixed part alone (source_note, lanes_seen) is bigger.
Fix:        max_chars on all three: default 20,000, at most 40,000, floor
            5,000. The budget pops from the longest list and stamps note,
            truncated and result_chars inside the loop, so the note is
            measured with the answer. The note reads "capped at N chars — do
            not call again with the same arguments; narrow with …".
            Compact default shapes:
            - read_open_loops: every count (label, status, owner), then 40
              loops of eight small fields each.
            - get_priority_evidence: 400-character work-log summaries, with
              jobs and cards cut to their decision fields.
            - read_slack: the newest 40 messages, unless since_hours or
              slack_channel narrows the read.
            A Slack 429 waits out its Retry-After once (up to 30 s) and
            retries. If still limited, the answer is ok:false rate_limited
            with retry_after, and never partial data. The same Slack read
            within 60 s is answered from the last one and marked cached, so an
            agent that re-asks does not re-read thirty channels.
Decision:   The 60-second cache was not in the brief. It is added because
            repeated identical reads are what tripped the 429 in the first
            place, and the answer says when it came from the cache, so nothing
            about it is silent. It can be tuned with
            NORTH_STAR_SLACK_CACHE_SECONDS.
            Verified locally: test:north-star passes 10 checks. The new ones:
            - the budget is held and stated, and result_chars is the returned
              size;
            - 999,999 is clamped to 40,000;
            - a single 429 is waited (≥1 s) and the retry succeeds;
            - a persistent 429 is rate_limited with no messages key;
            - every read logs its size.
            test:bays-tools, test:mcp-write and test:lookup still pass, and
            the build is clean.

## 2026-09-24 09:40 — North Star — Tools Router retired in the registry
Intent:     Destiny re-tested the North Star Agent after 3954e59, and it now
            works on the three MCP tools. Record in the registry that the
            Router it replaced is retired.
Files:      server/src/registrySeed.ts, server/src/migrations.ts (31),
            CLAUDE.md, BUILD_LOG.md.
Problem:    None. Destiny's re-test: each tool was called exactly once —
            read_slack 19,882 characters, read_open_loops 13,438,
            get_priority_evidence 19,974. The agent did not loop, and the
            figures were correct. He published the agent on the three tools,
            then unpublished North Star — Tools Router (G6Myypk64kpcaVhz) and
            moved it to RETIRED in n8n.
Fix:        In the seed, G6Myypk64kpcaVhz is 'retired', with a note saying
            when, why and what replaced its RS, ROL and PE branches. North Star
            — Agent Delivery's note now names the agent's three MCP tools and
            the re-test.
            Migration 31 does the same on the live database. Each update fires
            only while the row still holds the seed's value (the Router still
            `production`; Agent Delivery's note still the first one), so an
            edit made on the page is kept.
            Checked locally: before the migration, G6Myypk64kpcaVhz was
            production and Agent Delivery had the old note; after it, retired
            and the new note. test:north-star still passes its 10 checks.
Decision:   North Star — Conversational Agent (seK3we7pTurvZmqe) is not
            touched. Agent Delivery replaces it behind the Front Door, but
            nobody has said it is unpublished, and a retirement that has not
            happened in n8n is not one this registry should claim.

## 2026-09-24 10:40 — send_nudge, post_file, North Star — Conversational Agent retired
Intent:     Brief (g): close Bays' last migration gaps. Add send_nudge (one DM
            per recipient, fan-out in code) and post_file (Markdown as a .md
            file into any channel or DM), and retire seK3we7pTurvZmqe.
Files:      server/src/mcp/slackTools.ts (new), server/src/slack.ts (botCall,
            uploadBytes), server/src/mcp/tools.ts, server/src/registrySeed.ts,
            server/src/migrations.ts (32), server/test/bays-tools.test.cjs,
            CLAUDE.md.
Problem:    The retired Bays — Tools Router (WjWzhVRq566A60fJ) is
            active:false but not archived, so the SNG and PRF nodes were read
            from it verbatim (versionId fa610975…). Nothing in n8n was changed.
            test:gate failed locally with "one applied — 5 !== 1". Its rows
            from five earlier runs were still in the local engine_mcp_writes.
            Deleting the test_set_lead_status rows fixed it. The failure came
            from local state; the code change did not cause it.
Fix:        —
Decision:   Ported as written. That covers SNG - Build Recipients' tokeniser
            and regex (\b([UW][A-Z0-9]{6,})\b), the repeat-sent-once rule,
            SNG - Format Result's result lines and summary wording, and
            PRF's filename (<title>.md) and UTF-8 byte length.
            Three deliberate differences:
            (1) post_file opens the DM before the upload rather than after it.
            A user the bot cannot DM then leaves no orphaned upload behind.
            (2) The permalink comes from files.info.
            files.completeUploadExternal answers {id, title} only. A files.info
            failure is permalink_error and does not undo a posted file.
            (3) The n8n empty-case reply told the agent to use User_Lookup.
            That tool is not here, so the wording is "look each person up".
            Audit kind is 'slack'. Partly sent is outcome applied, with the
            failures named in detail. Nothing sent is failed, and a refusal
            is refused.
            Verified locally: test:bays-tools 22/22, against a Slack stand-in
            that refuses with 200 ok:false. mcp-write, north-star, lookup, pay,
            gate and recovery all pass, and the build is clean.

## 2026-09-24 10:15 — brief (g) deployed; live proofs handed to Destiny
Intent:     Deploy 282608e and prove it on production.
Files:      BUILD_LOG.md.
Problem:    Deploy dep-daqfeq8u01pc73cpjnkg went live at 10:12:37Z, and
            migration 32 was applied at 10:12:33Z. On production,
            seK3we7pTurvZmqe reads status "retired" with the new note. Checked
            with query_postgres.
            The live send_nudge and post_file calls could not be made from
            this session. The sandbox gets curl 000 to dashboard.bhanetwork.org,
            and this session's connector still holds the tool list from before
            these tools existed.
Fix:        —
Decision:   Nothing was worked around. Destiny runs the two proof calls after
            a tool refresh. Each one leaves a line on engine_mcp_writes, and
            that line can be read back here.

## 2026-09-24 10:55 — Research Twin's six write tools; rt-asks delete-only
Intent:     Brief: move Research Twin (Agent) dDtsExaaXhlFd2dv off the six
            workflow tools it calls on Research Twin — Tools Router
            (zikfpO0wvqzPCQuz), onto the dashboard MCP. The tools are
            write_research_finding, write_commercial_card_fields,
            compute_lane_state, queue_followup_research,
            update_watched_client_question and create_client_report_doc.
            Also make rt-asks deletable.
Files:      server/src/mcp/researchTwinTools.ts (new), server/src/mcp/tools.ts,
            server/src/mcp/writeTools.ts (delete_record takes DELETABLE_KINDS),
            server/src/writeGuards.ts (DELETE_ONLY: rt-asks), server/src/slack.ts
            (botCall token override, SLACK_RESEARCH_TWIN_BOT_TOKEN),
            server/src/bharag.ts (research_twin ingest workspace),
            server/src/index.ts (two boot lines), render.yaml,
            server/test/research-twin-tools.test.cjs (new), package.json
            (test:research-twin), CLAUDE.md.
Problem:    The router was read with n8n get_workflow_details: 65 nodes,
            versionId f0c202ae…. Nothing in n8n was changed.
            First test run: the seed was refused with "record_id":
            "recRT536341q1" is not an Airtable record id (rec followed by 14
            characters). That was a test-fixture mistake; the fixed id passes.
            The source does things that look like bugs. Each is ported as
            written and named here rather than fixed:
            (1) WRF caps a job when the answer is low AND attempts >= 3. It
            counts all attempts, not stuck ones: two good answers followed by
            one low one still cap.
            (2) UWC reads Run Count and never increments it. Neither does
            this.
            (3) CCR resolves the questions table from the index's
            "Questions Table" through a hardcoded three-name map, not from
            "Table ID". Any other lane whose "Questions Table" is a name
            answers client_not_found, and unresolved_table is named.
Fix:        —
Decision:   Every Code node is its own exported function. Before wiring
            anything, a harness ran each one against the n8n node's own jsCode
            in a vm, with a frozen clock and $/$input shims. It covered WRF
            gate and merge, WCF, CLS, QFR, UWC merge and doc, CCR resolve,
            build and initial_comment. All 77 comparisons were identical.
            Differences on purpose:
            - A refusal is ok:false, not a throw.
            - The BHARAG ingest degrades (ingested_to_bharag:false) instead of
              stopping the call. The n8n node was onError:stopWorkflow.
            - One answer per call; the n8n parallel branches are folded in.
            - dry_run is supported.
            - Answers are capped at 20,000 characters.
            - The report permalink comes from files.info. n8n read it from
              completeUploadExternal, which never carries one.
            Credentials:
            - Report upload: new SLACK_RESEARCH_TWIN_BOT_TOKEN. It is n8n's
              "Research Twin" Slack credential, and no default is set.
            - BHARAG ingest: the existing BHARAG_RESEARCH_TWIN_KEY, which is
              what n8n's "BHARAG - Research Twin" credential names.
            rt-asks is delete-only (DELETE_ONLY in writeGuards). create_record
            and update_record still refuse it.
            Verified locally:
            - test:research-twin 10/10.
            - bays-tools, mcp-write, north-star, lookup, pay, gate and
              recovery all pass.
            - The build is clean.

## 2026-09-24 11:45 — RT tools live; row 9 deleted; agent draft switched (five of six)
Intent:     Deploy 675934c, delete the Sept 24 delivery test ask, and put the
            new tools on Research Twin (Agent)'s allow-list.
Files:      server/src/mcp/researchTwinTools.ts (descriptions), CLAUDE.md,
            BUILD_LOG.md.
Problem:    Deploy dep-daqglo0u01pc73cr242g went live at about 11:35:41Z. Boot
            lines:
            "SLACK_RESEARCH_TWIN_BOT_TOKEN NOT set — create_client_report_doc
            builds the report and answers not_configured instead of uploading
            it"
            "BHARAG_RESEARCH_TWIN_KEY set — update_watched_client_question
            ingests each answer into Research Twin's workspace".
            This session's connector still listed delete_record with the old
            kind enum. A call with kind rt-asks went through anyway, because
            the server decides. rt-asks row 9 (RT-1790247471804-8YPB) was
            deleted and kept in record_deletions (engine_mcp_writes audit 30).
            First edit to the descriptions: a single-quoted string held
            "Research Twin's", and tsc answered TS1005 "',' expected" on
            line 437. Changed to a typographic apostrophe.
            The local Postgres was down between runs ("FATAL: could not
            connect to Postgres ... ECONNREFUSED 127.0.0.1:55432"). It was
            restarted.
Fix:        —
Decision:   The agent's instructions name the old tools (Write_Research_Finding
            etc.) in 9,852 characters of prose. Rewriting them over
            mutate_agent means re-sending the whole string by hand. Instead,
            each MCP tool's own description now opens with the old name. The
            agent patch is small and leaves the instructions untouched.
            create_client_report_doc is not switched while its token is unset.
            Create_Client_Report_Doc stays on the workflow tool, which holds
            its own credential, so the weekly report keeps uploading.

## 2026-09-24 12:20 — Registry (migration 33); the hidden Airtable writer sweep
Intent:     Brief: retire Research Twin — Conversational Agent and the RT
            self-healing test in the registry, and add Research Twin — Agent
            Delivery and Bays — Slack Request. Note that the RT Tools Router
            has no callers. Then sweep every n8n workflow for Airtable nodes
            and report them without changing anything (closes
            LOOP-1790034076667-8HOF).
Files:      server/src/registrySeed.ts, server/src/migrations.ts (33),
            server/src/airtableSweep.ts (new), server/src/n8n.ts (isArchived
            passthrough), server/src/mcp/n8nTools.ts (sweep_airtable_nodes),
            server/src/mcp/tools.ts, scripts/airtable-sweep.cjs (new),
            server/test/airtable-sweep.test.cjs (new),
            server/test/bays-tools.test.cjs, docs/sweeps/airtable-2026-09-24.md
            (new), package.json, CLAUDE.md.
Problem:    "Using N8N_API_KEY": the key exists only on the Render service.
            This sandbox has none, and bayshorizonnetwork.app.n8n.cloud
            answered curl with 000. So today's sweep read workflow JSON
            exported read-only through the n8n connector. It got 46 of the 48
            listed workflows. Two refused with "Workflow is not available in
            MCP": N9kIvHF8Vohy8OeM "Add source_campaign Header (one-off)" and
            qnNZlzWAF1GXuxX3 "Context Harvester Pipeline". Both are inactive.
            The production tool reads them with the key.
            4beRTMIlgJ0njPna is absent from the connector's listing,
            consistent with it being archived.
            First classifier cut, two mistakes of mine:
            (1) A node naming only a loop table id read as not owned, because
            ownership was per base.
            (2) Reference-only nodes were labelled "read".
            Fixed:
            - Loop, Codex, Layer 0, Review Returns and the client tables are
              owned by id too.
            - A reference is access "none".
            - A Code node naming an Airtable credential type
              ('airtableTokenApi') counts as a call.
            Many Code nodes are named "… (Airtable)", e.g. "Write to BHA
            Submissions (Airtable)" and "Mark Log Paid (Airtable)". Their
            matches are comments about reshaping rows to Airtable's
            { id, createdTime, fields }. They call the dashboard, not
            Airtable. api.airtable.com appears in one workflow only, in a
            sticky note of GES8UIM3dJRbrLSx.
Fix:        —
Decision:   Result:
            - Active writers: none.
            - Would write if switched back on: one. BHA — Dashboard Loop
              Write-Back (GES8UIM3dJRbrLSx, inactive), node "Update Loop
              Status" (airtable, operation update). Its only read is "Find
              Loop Row" (search). Both are on the Open Loops base
              (appUVlBSGGPHw6DGh, table from an expression) with credential
              "Admin Airtable" IOwa36AoQylkenkh (airtableTokenApi). That is
              the one Airtable credential n8n lists (35 credentials in all).
            - References only: 145.
            - The three n8n Agents (Bays, Research Twin, North Star; published
              and draft) have no Airtable tool. Bays' scheduled loop tasks name
              the seven loop table ids as find_records filters: a read here.
              They will not see a builder added through Builder Profiles,
              whose table_id is null.
            An operation that is unset or an expression is "unknown" and
            counted with the writers, never assumed a read. The rules are
            pure (classifyWorkflow), pinned by test:airtable-sweep (22
            assertions).
            New registry rows get replay never:
            - Research Twin — Agent Delivery, like the other two Agent
              Deliveries.
            - Bays — Slack Request: a Slack request re-run hours later posts
              into a conversation that has moved on.
            The Tools Router keeps production with a note, as asked.
            Research Twin (Agent)'s published version already has
            create_client_report_doc on its MCP allow-list. That switch was
            made on the n8n side after this session's draft.
            Verified locally: bays-tools 22/22 (with the new registry checks),
            research-twin 10/10, mcp-write and airtable-sweep pass, and the
            build is clean.

## 2026-09-24 13:15 — Build patterns Candidates: filters in the URL, register / decline / reassign
Intent:     Make the Candidates tab (/build-patterns?view=candidates; 52 held,
            47 Proposed, 5 Registered) a working queue.
            1. Filters at a glance: builder, suggested architect, lane and
               status, each with counts, combined with the search, kept in the
               URL so a builder can bookmark "my candidates". Proposed first,
               oldest first.
            2. Act from the detail panel: register as a pattern through
               create_record's own path, decline with a reason, reassign the
               architect from Builder Profiles. Every action through the write
               guards and on engine_mcp_writes. Only the suggested architect,
               the builder, Jason or Destiny may act.
Files:      server/src/candidateActions.ts (new)
            server/src/index.ts:
            - POST /api/pattern-candidates/:id/(register|decline|reassign)
            - GET /api/builder-profiles
            server/src/mcp/tools.ts, mcp/writeTools.ts, mcp/index.ts: a third
              access, 'page'.
            server/src/writeGuards.ts: Declined added to CANDIDATE_STATUSES.
            server/src/engine.ts: the candidate read model maps Registered By
              and the Declined / Reassigned fields.
            src/screens/PatternCandidates.tsx (new): the tab, the panel and the
              three forms.
            src/screens/BuildPatterns.tsx: the old read-only tab removed, the
              new one wired in.
            src/data/index.ts, src/data/types.ts
            server/test/pattern-candidates.test.cjs (new), npm run
              test:candidates
            server/test/mcp-write.test.cjs: the audit window is anchored to the
              test's own start.
            CLAUDE.md
Problem:    1. The dashboard has one shared login, so there is no "signed-in
               person" to fill drafted_by or to check "who may act" against.
            2. Widening ToolDeps.access to include 'page' broke the MCP
               transport: TS2345 "Argument of type 'ToolAccess' is not
               assignable to parameter of type 'McpAccess'" in mcp/index.ts.
            3. The first test run failed "drafted_by is the person acting":
               undefined. Build patterns has no drafted_by column.
               create_record's drafted_by only names the Google Doc ("Build
               Pattern -- <name> -- <drafted_by>").
            4. The regression run failed test:mcp-write
               ("assert.ok(audit.rows.every((r) => r.access === 'write'))").
               Its audit query read "the last five minutes" and picked up the
               page rows test:candidates had just written.
            5. The panel's divider drew black. border-[var(--hairline)] names
               a token that does not exist; the token is --line.
Fix:        1. An "Acting as" picker from Builder Profiles, remembered in this
               browser (bha.actingAs). The server checks the declared person
               against Architect Slack ID / Builder Slack ID / ADMIN_IDS before
               any write. The page says in words that it is declared, not
               checked.
            2. mcpAccess() narrows 'page' to 'read' for tools/list and
               tools/call. No URL grants 'page'.
            3. The test asserts the Doc title instead. The candidate carries
               Registered By.
            4. The mcp-write audit query is scoped to rows written since the
               test's own start (and excludes the gate test's tool).
            5. border-line.
Decision:   - Page actions call the create_record / update_record handlers
              in-process with access 'page', rather than a second write path.
              So the BP- mint, guards, BHARAG ingest, Google Doc, engine_writes
              line (endpoint page:<tool>, key "session cookie") and
              engine_mcp_writes audit are an MCP call's, byte for byte.
            - Register writes the pattern first and marks the candidate only
              after it is saved. A candidate update that fails after a saved
              pattern is reported with the BP- id and not retried: a second
              create would be a second pattern.
            - Registered and Declined candidates refuse every action (409).
            - Month defaults to all time on this tab, not the current month:
              a bookmark that opened on this month would hide most of an
              architect's backlog.
            - Sort is Proposed → Approved → Registered → Declined, oldest
              first within each. This is an explicit exception to "newest
              first": it is a queue of decisions owed.
            - Facet counts are computed over what the other filters leave, so
              each count is what picking it would show.
            - The checklist field is one step per line and is sent as a list,
              which the pattern guard joins with " | ".
            - Reassign leaves Why This Architect as written. The panel says it
              was written for the first architect.
            - Not built: per-person sign-in. The acting-as picker stops
              mistakes, not a teammate choosing another name. Real identity is
              a scope change for Destiny to decide.
Verified:   Locally:
            - test:candidates, 8 steps: cookie required; who may act (403 for
              others, 400 for no profile, nothing written); decline; reassign;
              register (BP-BAYS-… id, BHARAG ingest with the patterns key, Doc
              titled with the actor, candidate Registered with the id, second
              register 409); the audit on both logs. Every throwaway profile,
              candidate and pattern is deleted through delete_record.
            - A Playwright run against the built page: architect filter in the
              URL (2 of 3 rows), open → acting as → decline, register from the
              prefilled form, the not-permitted sentence, all rows deleted
              after.
            - The regression suites, all passing: bays-tools 22, research-twin
              10, north-star 10, mcp-write, lookup, gate, pay, recovery,
              airtable-sweep.
            - Build clean.
