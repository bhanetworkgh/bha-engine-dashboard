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
