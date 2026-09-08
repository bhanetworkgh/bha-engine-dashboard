# BHA Engine Dashboard

Internal dashboard for Bays Horizon Advisory's automation engine.

The engine — Bays, Research Twin, North Star, Codex, BHARAG and vFarm — has no
single window onto its own state. Its data sits across Airtable, BHARAG and n8n's
execution history. Answering "what changed this week", "which loops are stale",
or "is vFarm on track" currently means opening six places by hand.

This is that window. Internal team tooling, not a customer product.

## Status

**Phase 1 — UI against mock data, with the write paths wired.** Layout,
navigation, light and dark themes, and interactions are built. Reads come from
fixtures. Sign-in, loop status changes, new loops and Ask Bays messages go to
the engine when the matching environment variable is set, and otherwise act on
the fixtures so the interface behaves.

Phase 2 wires the live engine endpoint for reads. Phase 3 adds chat memory for
Ask Bays.

## Architecture

Static front end, no backend of its own. It calls a single JSON endpoint hosted
on the BHA n8n engine, which fans out to the underlying data sources and returns
one response.

All data access goes through one module. Swapping mock fixtures for the live
endpoint is a change in that module only.

Auth is a single shared team login, matching the pattern used by BHARAG's admin
console. No per-user accounts.

## Sections

| Section | Purpose |
|---|---|
| Overview | Headline numbers, what broke and what moved in 24h |
| Ask Bays | Chat interface onto the Bays agent |
| North Star | Asks routed through NS — records, runs, gaps |
| Research Twin | Research jobs — records, runs, gaps |
| vFarm | Rack events, anomalies, Halloween readiness |
| Engine health | Incidents, self-healing state machine, retry metrics |
| Open loops | Loops by age and owner, close from the interface |
| Codex entries | Session logs by builder and week |
| Build patterns | Patterns by lane |
| Commercial | Opportunities and readiness |
| Builders | Per-person lane, loops, activity, contract status |

## Repo layout

```
src/
  main.tsx            Entry point. Router + session provider.
  App.tsx             Route table. The login gate sits in front of everything.
  index.css           Design tokens for both themes, base styles, component classes.

  app/                Application-wide state.
    session.tsx       Shared team login (token, expiry, bearer) and the global lane filter.
    theme.tsx         Light / dark / system, stamped on <html data-theme>.
    useData.ts        Calls a data function with the current lane; owns loading and failure.

  data/               The one swap point. Nothing else knows where data comes from.
    types.ts          The contract. Shapes the engine endpoint must return.
    engine.ts         The HTTP client: env config, bearer, timeouts, error shape.
    index.ts          One async function per section, plus the write paths. Phase 2 changes these bodies only.
    fixtures/         Phase 1 mock rows, one file per domain. Deleted in phase 2.

  lib/                Pure helpers. No React, no data access.
    format.ts         Display formatting and the age colour scale.
    health.ts         Health-to-class mapping. Healthy returns no colour.
    actions.ts        act() — the single row-action handler.
    cx.ts             Class-name join.

  components/
    Layout.tsx        Sidebar, status strip, theme toggle, content outlet.
    ui/               Shared primitives (cards, stats, tabs, tables, tags, inline SVG charts, icons).

  screens/            One screen per route. Screens with sub-views get a folder.
    Overview.tsx      Flat file — small enough to read in one sitting.
    OpenLoops/        Loops, ReviewQueue, Reconciliation + index.
    Twin/             Summary, Records, Runs, Gaps + index. Serves North Star and Research Twin.
    VFarm/            Live, Lifecycle, Readiness + index.
    EngineHealth/     MetricsRow, IncidentTable, StateTrack + index.
    Builders/         List, Detail + index.
```

### Where to make each kind of change

| To change | Go to |
|---|---|
| Where data comes from | `src/data/index.ts` — only this file |
| The shape the engine must return | `src/data/types.ts` |
| Mock values | `src/data/fixtures/<domain>.ts` |
| A colour, spacing or font | `src/index.css` — tokens for both themes, not per-component classes |
| What a screen shows | `src/screens/<Screen>/` |
| A table cell, tag, dot or row action used on several screens | `src/components/ui/` |
| Sidebar groups, status strip, lane filter | `src/components/Layout.tsx` |
| Formatting or the age colour scale | `src/lib/` |
| A new route | `src/App.tsx` and the sidebar list in `Layout.tsx` |

## Local development

```bash
npm install
npm run dev
```

## Environment variables

Set in the host's environment settings. Never committed. Every one is optional;
a feature whose variables are missing says so on screen rather than pretending.

| Variable | Purpose |
|---|---|
| `VITE_ENGINE_API_URL` | Base URL of the engine data endpoint. Also the write target for loops (`PATCH /loops/:id`, `POST /loops`). |
| `VITE_AUTH_URL` | Login endpoint. Defaults to `<VITE_ENGINE_API_URL>/auth/login` when only the API is set. When unset, sign-in is checked in the browser against the team credential (below). |
| `VITE_AUTH_EMAIL` | Overrides the built-in team email for the browser-side check. |
| `VITE_AUTH_PASSWORD_SHA256` | Overrides the built-in credential digest: hex SHA-256 of `<email>\n<password>`, email lower-cased. Rotate the password by setting this, no code change needed. |
| `VITE_BAYS_WEBHOOK_URL` | The Bays front door, `https://<n8n host>/webhook/bays`. |
| `VITE_BAYS_API_KEY` | The `x-api-key` the front door expects on an external ask. |
| `VITE_BAYS_CALLBACK_URL` | Where Bays posts its answer. Sent as `callback` on every ask. |
| `VITE_BAYS_ANSWER_URL` | Where the dashboard reads answers back from. Polled as `GET ?session_id=…`. |
| `VITE_BAYS_CHANNEL_ID` | Optional Slack channel for Bays to deliver to instead of, or as well as, the callback. |

Anything set as a `VITE_` variable is compiled into the static bundle and is
readable by anyone who can load the site. The shared login gates the interface,
not the bundle. The Bays key in particular should be replaced by a proxy route
on the engine endpoint (which attaches the key server-side) before this is
exposed beyond the team.

### Contracts the engine must meet

**Sign-in, browser-side (current).** With no `VITE_AUTH_URL`, the email and
password are hashed in the browser (SHA-256 of `<email>\n<password>`) and
compared with the team credential digest held in `src/data/index.ts`, or the
`VITE_AUTH_PASSWORD_SHA256` override. Only that one pair signs in. The password
is never in the repository; the digest of a random fourteen-character password
is not recoverable. Five wrong attempts pause sign-in for thirty seconds. A
session lasts twelve hours or until the tab closes. Because the check runs in
the browser it gates the interface, not the data behind it — which is fixtures
today. To generate a new digest:

```bash
printf 'admin@bhanetwork.org\n<new password>' | sha256sum
```

**Sign-in, engine-side (when `VITE_AUTH_URL` is set).** `POST VITE_AUTH_URL` with `{ "email", "password" }`. Success is
`200` with `{ "token", "expires_at"?, "label"? }` (`session_token` or
`access_token` are also accepted). A `401` or `403` is shown as a rejected
login. The token is sent as `Authorization: Bearer` on every engine call, and a
`401` from any call signs the tab out.

**Ask Bays.** The dashboard posts the front door's external-ask shape:
`{ prompt, session_id, builder_id, lane_id, source: "engine_dashboard", callback?, channel_id? }`
with the `x-api-key` header. The front door acks with an empty body and runs the
agent asynchronously; the answer arrives at `callback`. The dashboard then polls
`VITE_BAYS_ANSWER_URL?session_id=…` expecting `{ "status": "pending" }` or
`{ "status": "answered", "answer", "at" }` (`response` or `text` also accepted)
for up to two minutes. The workflow's loop guard drops the same `session_id`
inside thirty seconds, so the composer enforces a thirty-second cooldown per
thread. The answer store behind `VITE_BAYS_CALLBACK_URL` and
`VITE_BAYS_ANSWER_URL` does not exist yet; it is the one piece of the wiring
that needs a workflow on the engine side.

## Deployment

Render static site, deploying from this repository's default branch. Pushes to
the default branch trigger a deploy.

| Setting | Value |
|---|---|
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |

### A rewrite rule is required

This is a single-page app using client-side routing, and the build does **not**
solve this on its own. `npm run build` emits one `index.html` plus hashed assets —
there is no `open-loops.html`. Verified against a plain static server:

```
GET /                    200
GET /assets/index-*.css  200
GET /open-loops          404
GET /vfarm               404
GET /builders/destiny     404
```

So the site works if you land on `/` and navigate, and 404s on any deep link,
refresh, or bookmarked URL.

The fix is a host-level rewrite: serve `index.html` for any path that does not
match a file on disk, as a **rewrite** (200, URL preserved), not a redirect —
a redirect would rewrite the address bar and lose the route. On Render this is
configured on the service under Redirects/Rewrites: source `/*`, destination
`/index.html`, action Rewrite.

No config file for this is committed here, because the rule belongs to the host
and has not been verified against this service. Add it in the Render dashboard,
then confirm by loading `/open-loops` directly.

## Working in this repo

Read `CLAUDE.md` before making changes — it holds the full spec, design rules and
per-section content requirements.

`BUILD_LOG.md` is a running record of build work and is the source material for
BHA session narrations. Append to it; never rewrite it.

## Owner

Destiny Arupi — Engine Steward, BHA.
