# Media Twin post log (media.post_log.v1)

Owner: Destiny Arupi (Engine Steward). 22 Oct 2026. The answer to Jason's ask on H58Q in #bha-coordination (1792559349.662489): the canonical SOURCE_TO_TARGET_LOG write and read route, and its persisted schema.

## What it is

One row per post of one vFarm picture to one place. It records the source the post came from, the picture and its version, the platform, the claim it carries, Jason's approval, the tracked link, what happened when it went out, and the live post's link or the error. Hardik's envelopes, Bays and Media Twin all write to this one log, so the engine has one answer to "which picture went where, and was it allowed to".

## Where pictures live

The "Approved vFarm renders" Drive folder, https://drive.google.com/drive/folders/19vTXax0Fk1JXSt3oHCcHBa3KonflqqPr, set up on 22 Sep 2026 (LOOP-1790035676921-5MQZ). It is the only place bhanetwork.org and /vfarm pull pictures from. A picture goes in only after Jason approves it, named with its version (for example `P1.0_hero_v0.3.png`). A post can be queued or published only from a file in that folder: the engine checks the file's folder in Drive on every such write, and refuses when Drive cannot say.

## Write

`POST https://dashboard.bhanetwork.org/api/engine/media-post-log`, header `x-dashboard-key`, body:

```
{ "log_id": "MPL-…" (leave out to log a new post),
  "fields": { … },
  "requester_user_id": "<Slack id of the person logging>",
  "test": false, "dry_run": false }
```

The same function answers the MCP tool `write_media_post_log` on the dashboard's write connection. A refusal is 422 (503 when Drive cannot say) with `reason` and `message`, and writes nothing.

## Read

`GET https://dashboard.bhanetwork.org/api/engine/media-post-log` (`?asset_id=`, `?platform=`, `?log_id=`, `?include_test=1`), header `x-dashboard-key`, or the MCP tool `read_media_post_log`. The Media Twin page's Posts tab shows the same rows.

## Fields (table `engine_media_post_log`)

| field | meaning |
|---|---|
| log_id | The engine's id, `MPL-<ms>-<4>`. Never sent on create. |
| asset_id | The picture, e.g. `H58Q-A`. Fixed once logged. |
| asset_version | Its version, e.g. `v0.3`. Fixed once logged. |
| asset_file_id | The Drive file id of the approved picture in the folder. Required to queue or publish. |
| source_id | The source post or record it came from, as given. Fixed once logged. |
| platform | `linkedin`, `instagram`, `facebook`, `tiktok`, `x` or `website`. Fixed once logged. |
| classification | `CONCEPTUAL` (only value accepted today). |
| verified_current_p1_0 | Always false. |
| claim_state | As given, e.g. `interest_only_live`. Required. |
| approval | `pending`, `APPROVE_FOR_EA_PUBLICATION`, `REVISE` or `HOLD`. |
| approved_by, approved_at | Jason's Slack id (`U0A9V97949F`) and when. |
| manual_only | Always true. |
| automation_enabled | Always false. |
| utm_url | `https://bhanetwork.org/vfarm?utm_source=<platform>&utm_medium=social&utm_campaign=…`. Required for a social post that is queued or published. |
| publish_result | `not_published`, `queued`, `published`, `failed` or `held`. |
| target_url, target_id | The live post's own link or id, as the platform gave it. One is required once published. |
| read_back | `not_checked`, `ok` or `error`; `read_back_detail` says what the platform answered. |
| loop_id, notes | Optional. |
| logged_by, test, created_at, updated_at | The engine's. |

## Rules held on every path

1. Nothing is verified current P1.0 hardware yet: `classification` stays `CONCEPTUAL` and `verified_current_p1_0` false until the Canon/provenance bundle lands. An approval never flips it. The table itself refuses true.
2. Manual only: `automation_enabled` true is refused, and the table refuses it too.
3. Only Jason approves publication, per picture.
4. Queued or published needs that approval, the picture in the approved folder, and for a social platform the /vfarm link tagged for that platform.
5. Published needs the live post's own link or id. No identifier is made up: every id on a row is one a person or a platform gave.
6. A published row never goes back to unpublished. A post that came down is a new row with its own result.

Each write is one `media_post_logged` or `media_post_updated` event in `engine_events`, lane MEDIA.
