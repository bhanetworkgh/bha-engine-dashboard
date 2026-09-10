# BHA Engine Dashboard

Internal dashboard for Bays Horizon Advisory's automation engine.

The engine — Bays, Research Twin, North Star, Codex, BHARAG and vFarm — has no
single window onto its own state. Its data sits across Airtable, BHARAG and n8n's
execution history. Answering "what changed this week", "which loops are stale",
or "is vFarm on track" currently means opening six places by hand.

This is that window. Internal team tooling, not a customer product.

## Status

**Live on Render as one Node web service.** Sign-in is verified by the
server, which sets a session cookie. Ask Bays goes through the server to the
live agent workflow. **Open loops, Codex entries, build patterns and
commercial cards are read from Airtable** — the seven per-builder loop tables,
the six per-builder submission tables in BHA Submissions & Logs, Build
Patterns and Commercial Opportunities — and every change made on those pages
is written to Airtable first and shown from what came back. The server resyncs from Airtable on boot, on a timer and on demand, and
n8n can push writes to it as it writes them to Airtable.

The service runs on Render's free instance type with no persistent disk, so
the server's SQLite store is a read model that is rebuilt from Airtable after
every deploy and spin-down. Airtable is the source of truth. Incidents, twins,
vFarm and builders are still phase 1 fixtures. Chat history stays in the
browser until Bays keeps memory of its own.

## Architecture

```
Browser  →  this repo's server (/api, same origin)  →  BHA engine (n8n)  →  data sources
```

A React front end and a small Node server, deployed together as one Render web
service. The server serves the built front end and answers every `/api` call.
It owns every secret: the login credential, the session signing key and the
engine API key. The browser holds none of them and never talks to the engine.

The server has no dependencies beyond Node itself (22.13 or later, for the
built-in SQLite driver). Its state is one SQLite file under `DATA_DIR`.

All browser data access goes through one module, `src/data/index.ts`, which
calls `/api`. On the server, `engine.ts` derives every read, `store.ts` holds
the records and the status-change history, `sync.ts` rebuilds the records from
Airtable, `airtable.ts` is the only code that talks to Airtable, and
`sources.ts` says where each kind lives and how a row becomes a record.

### Inbound writes from n8n

`DASHBOARD_INBOUND_KEY` in the `x-dashboard-key` header authenticates these;
the session cookie is not needed. `:kind` is `loops`, `codex`, `patterns` or
`commercial`.

```
POST   /api/inbound/:kind           { id?, builder?, table?, record?, at? }   create or update
PATCH  /api/inbound/:kind/:id       { builder?, table?, record?, at? }        same, id in the path
DELETE /api/inbound/:kind/:id                                                  drop the held row
POST   /api/inbound/resync/:kind                                               full rebuild of that kind
```

`record` is the Airtable record as n8n's Airtable node returns it
(`{ id, createdTime, fields }`); the id may be given at the top level, in the
path, or only inside the record. For loops and Codex entries, `builder` (e.g. `jegan`) or
`table` (the tbl… id) says which builder table it lives in. When `record` is
absent the server reads the record from Airtable itself. `at` is the time of
the change and stamps the status event; without it the server uses now. The
call is idempotent: the same record twice is one row and no second event.

### Environment

| Variable | Purpose |
|---|---|
| `AUTH_EMAIL`, `AUTH_PASSWORD_HASH` | The shared login (`npm run hash-password`) |
| `SESSION_SECRET` | Signs the session cookie |
| `ASK_BAYS_API_KEY`, `ASK_BAYS_URL` | The Ask Bays workflow |
| `AIRTABLE_API_KEY` | Personal access token with read and write on the four bases |
| `AIRTABLE_RESYNC_MINUTES` | Timed resync; default 30, 0 disables |
| `DASHBOARD_INBOUND_KEY` | Authenticates n8n's pushes to `/api/inbound/*` |
| `DATA_DIR` | Where the SQLite read model lives (ephemeral on the free plan) |

Auth is a single shared team login, matching the pattern used by BHARAG's admin
console. No per-user accounts.

**Counts on the records pages are computed by the server from raw rows**, not
handed over finished by the engine. Decision made 2026-09-08: nothing upstream
keeps a status-change history, so the server records one (an events table, a
daily snapshot per kind, and the date history began) and derives "this week
versus last", "open versus closed" and "median days raised to closed" from
it. A metric the data cannot support is returned null with a note saying what
is missing, and the note is what the page shows.

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

server/
  src/
    index.ts          The HTTP server: /api routes, cookie guard, static dist/.
    auth.ts           Credential check (scrypt), signed HttpOnly session cookie, lockout.
    ask.ts            Proxy to the Bays workflow; attaches the API key server-side.
    engine.ts         Every read, derived from fixtures and the store.
    store.ts          Records with status, the events/snapshot history, and metrics.
    db.ts             SQLite through node:sqlite, under DATA_DIR.
    hash.ts           `npm run hash-password`.
tsconfig.server.json  Compiles server/ plus src/data/{types,fixtures} to server-dist/.
render.yaml           Render blueprint: one web service, one persistent disk.
.env.example          Every server variable, documented.

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

Two processes: Vite for the front end (with `/api` proxied), and the server.

```bash
npm install
cp .env.example .env            # then set AUTH_PASSWORD_HASH or AUTH_PASSWORD
set -a; . ./.env; set +a         # or export the variables another way
npm run dev:server               # builds and starts the server on :8787
npm run dev                      # Vite on :5173, proxying /api to :8787
```

To produce the credential hash:

```bash
npm run hash-password -- 'the password'
```

To run the production shape locally (server serving `dist/`):

```bash
npm run build && npm start
```

Other scripts: `npm run typecheck` checks both the front end and the server.

## Environment variables

All read by the server. Set in the host's environment settings, never
committed. `.env.example` lists them with comments. Nothing prefixed `VITE_`
is used any more: the bundle contains no configuration and no secrets.

| Variable | Purpose |
|---|---|
| `AUTH_EMAIL` | The shared team email. Defaults to `admin@bhanetwork.org`. |
| `AUTH_PASSWORD_HASH` | scrypt hash of the shared password, from `npm run hash-password`. Rotate the password by replacing this. |
| `AUTH_PASSWORD` | Plain-text alternative for local development. Ignored when the hash is set. Without either, sign-in returns 503 and says so. |
| `SESSION_SECRET` | Signs the session cookie. When unset a random key is generated at boot, so every session ends on restart. Render's blueprint generates one. |
| `ASK_BAYS_URL` | The Bays agent workflow. Defaults to `https://n8n.arupiautomates.cloud/webhook/dashboard-ask-bays`. |
| `ASK_BAYS_API_KEY` | Sent as `x-api-key` on every call to that workflow. Without it Ask Bays replies that it is not connected. |
| `ASK_BAYS_MODEL_LABEL` | Shown under the composer. Defaults to `Claude Sonnet 5.0`. |
| `DATA_DIR` | Where the SQLite file lives. On Render, the persistent disk mount. Defaults to `./data`. |
| `PORT` | Listen port. Render sets it. Defaults to `8787`. |

### Contracts

**Sign-in.** `POST /api/auth/login` with `{ "email", "password" }`. The server
compares the email in constant time and the password against the scrypt hash,
then sets `bha_session`: an HMAC-signed, HttpOnly, SameSite=Lax cookie (Secure
in production) that expires twelve hours out. `401` is a wrong pair; `429` is
the lockout (five failures from one address pause it for thirty seconds; fifty
failures from anywhere inside a minute pause everyone); `503` means no
credential is configured. `GET /api/auth/session` says whether the cookie is
live; `POST /api/auth/logout` revokes it. Every other `/api` route answers
`401` without a valid cookie, and the front end returns to sign-in on any
`401`.

**Ask Bays.** The browser posts `{ message, session_id, builder_id }` to
`POST /api/ask`. The server forwards the same body to `ASK_BAYS_URL` with the
`x-api-key` header and waits up to two minutes. The workflow answers
`{ ok, answer, session_id, steps }`; the server normalises that and returns
it. `session_id` is fixed for the life of a thread and is what gives Bays its
memory of the conversation. When `ok` is false, `answer` explains why and is
shown as the reply. `steps` is the agent's own trace, shown under the answer;
when empty nothing is shown, because the agent answered without looking
anything up. The agent can answer questions about engine state and create,
update or close loops, nothing else.

**Records.** `GET /api/records/:kind/metrics?lane=&builder=` returns the
counts strip for `loops`, `codex`, `patterns` or `commercial`.
`PATCH /api/records/:kind/:id` with `{ status, note? }` changes a status and
records the change; `POST /api/records/loops` opens a loop. Status
vocabularies: loops `open · in progress · closed`; codex `posted · ingested ·
archived`; patterns `active · retired`; commercial `idea · researching ·
evidence thin · ready to pitch · blocked · closed`.

**Reads.** `GET /api/{overview, engine-status, north-star, research-twin,
vfarm, engine-health, open-loops, codex, build-patterns, commercial, builders,
builders/:id, ask-bays}?lane=` return the shapes in `src/data/types.ts`.
`GET /api/status` reports what is configured, without values.

## Deployment

One Render **web service** (not a static site), from `render.yaml` in this
repository. Pushes to the default branch deploy.

| Setting | Value |
|---|---|
| Runtime | Node 22.22 |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check | `/api/health` |
| Disk | 1 GB mounted at `/var/data`, `DATA_DIR=/var/data` |

Set `AUTH_PASSWORD_HASH` and `ASK_BAYS_API_KEY` in the service's environment
by hand; the blueprint marks them `sync: false`. `SESSION_SECRET` is generated
by the blueprint. Without the disk the server still runs, but the status
history restarts on every deploy and `/api/status` reports `history_since`
accordingly.

The server serves `index.html` for any path that is not a file in `dist/`, so
deep links and refreshes work without a rewrite rule. Hashed assets are sent
with a one-year cache header; everything else is `no-cache` or short-lived.

## Working in this repo

Read `CLAUDE.md` before making changes — it holds the full spec, design rules and
per-section content requirements.

`BUILD_LOG.md` is a running record of build work and is the source material for
BHA session narrations. Append to it; never rewrite it.

## Owner

Destiny Arupi — Engine Steward, BHA.
