# BHA Engine Dashboard

Internal dashboard for Bays Horizon Advisory's automation engine.

The engine — Bays, Research Twin, North Star, Codex, BHARAG and vFarm — has no
single window onto its own state. Its data sits across Airtable, BHARAG and n8n's
execution history. Answering "what changed this week", "which loops are stale",
or "is vFarm on track" currently means opening six places by hand.

This is that window. Internal team tooling, not a customer product.

## Status

**Phase 1 — UI build against mock data.** Layout, navigation, styling and
interactions. No live data yet.

Phase 2 wires the live engine endpoint. Phase 3 adds chat memory for Ask Bays.

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

## Local development

```bash
npm install
npm run dev
```

## Environment variables

Set in the host's environment settings. Never committed.

| Variable | Purpose |
|---|---|
| `VITE_ENGINE_API_URL` | Base URL of the engine data endpoint |
| `VITE_ENGINE_API_TOKEN` | Token for that endpoint |

## Deployment

Render, deploying from this repository's default branch. Pushes to the default
branch trigger a deploy.

## Working in this repo

Read `CLAUDE.md` before making changes — it holds the full spec, design rules and
per-section content requirements.

`BUILD_LOG.md` is a running record of build work and is the source material for
BHA session narrations. Append to it; never rewrite it.

## Owner

Destiny Arupi — Engine Steward, BHA.
