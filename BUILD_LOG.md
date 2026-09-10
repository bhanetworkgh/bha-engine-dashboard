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
