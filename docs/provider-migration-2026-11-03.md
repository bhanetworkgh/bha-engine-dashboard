# BHA provider migration: Anthropic primary, OpenRouter backup

Date: Tuesday, 3 November 2026, Lagos time.
Owner: Destiny Arupi.
Status: UPDATED COMPANY CREDENTIALS VERIFIED. Production provider rollout remains pending. All migration changes described as drafts remain unpublished. No rollout announcement was sent.

## Pre-change message draft for #bha-coordination

I am preparing to move our OpenRouter-first agents and AI workers to Anthropic directly, with OpenRouter as backup. This covers Bays and its Sonnet helper, North Star, Research Twin, log review Layers 0 to 2, loop matching, commercial and pattern extraction, error classification, web search, Deep Think, helper asks and scheduled-task recovery. Media Twin is included in the preparation, but remains unpublished.

The company key has now been updated and passed direct tests in n8n and the repair bridge. Web search and Deep Think have also passed on Anthropic and on their OpenRouter backup routes. Production provider routing has not changed. I will finish the remaining eval and pipeline checks before publishing, record the exact versions, and restore the previous version if a live check fails.

Voice transcription stays on Gemini through OpenRouter because the verified Anthropic models do not accept audio. The ElevenLabs Customer Service Twin currently uses DeepSeek rather than OpenRouter. Render workers and the dashboard pattern drafter are part of the remaining rollout work.

## What was actually audited

- n8n's full workflow list: 177 workflows, 57 active and 120 inactive. Active workflows were read through the full n8n interface where available. Context Harvester was visible only through the trimmed dashboard read.
- Seven existing first-class n8n agents, including the three backup copies and unpublished Media Twin. Eight entries now exist because a draft Media Twin OpenRouter backup was added.
- Dashboard server source, including pattern drafting, draft eval routing, model spend, audio transcription and credit alerts.
- Repair bridge source and Render's service inventory in Bays' workspace.
- ElevenLabs CST configuration: `deepseek-v41-flash`, no custom LLM configured.
- GitHub code searches on Genie, CST, RAG ingester, Genie-RSS and Smart Cursor Browser returned no matches. That is not proof those services are free of OpenRouter calls: private/default-branch indexing and runtime settings were not fully verified. Do not claim a completed company-wide migration on this evidence.

## Earlier blocking evidence, resolved by the updated-key tests below

The manual draft test ran in workflow `fNoWSRw3iWwsTzv8`, parent execution `63767`, child `63768`. `Ask Anthropic (primary HTTP)` returned HTTP 400 with:

> Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.

The saved credential is named **Anthropic account**, ID `Azyh6tmDAXXTUdPz`, in **BHA Engine**. This proves that credential could not pay for that request. It does not identify which organization it belongs to. Do not assume the company payment is missing, or that the existing credential was updated to the new company's key.

Credential action requested at the earlier checkpoint, since completed by Destiny: in n8n, edit **BHA Engine > Credentials > Anthropic account** and install or verify an API key from the funded company Anthropic account. Do not paste the key into chat, code, a sticky note or this document. The available n8n connector can reference credentials but cannot edit their secret values.

Paid preview tests were paused when this blocker was identified and resumed only after Destiny confirmed the new keys were installed. North Star's existing draft eval automatically started a backup run before the blocker was diagnosed; that runner still labels providers by fixed agent ID, so its route label is unreliable during this migration.

## Agent drafts and restore points

| Agent | ID | Previous active version | Prepared route |
| --- | --- | --- | --- |
| Bays (OpenRouter backup) | `PjKGbV4ZnH4YOfri` | `f44cda5b-741d-4c61-b950-674b4a223c3e` | OpenRouter backup |
| Bays (Agent) | `Nw5igXu4WWrjUMWB` | `81d2212e-f1af-4659-b1f4-6c88b13f5eed` | Anthropic primary |
| Research Twin (Agent) | `dDtsExaaXhlFd2dv` | `ebadd957-995a-483c-b4fc-90e54d17fb99` | Anthropic primary |
| Research Twin (OpenRouter backup) | `7ToBQqHpffX1eUG0` | `ab3369ce-4ed9-40e3-8064-0363bf7925fd` | OpenRouter backup |
| Media Twin (Agent) | `c9DVdUUSVFpekZN8` | `unpublished` | Anthropic primary |
| North Star (OpenRouter backup) | `fqeON4jXjenIi3cP` | `56de1217-ae9f-47bd-a464-363881f5c611` | OpenRouter backup |
| North Star (Agent) | `8NQRXadH0OrKe5XV` | `26128cf1-e44c-4ec7-a765-b7e7abf6f78d` | Anthropic primary |

New draft only: Media Twin OpenRouter backup, `oqahGbB45yxiTXcA`. Its configuration validates. It is not published, and Media Twin's workflow callers have not yet been wired to it. Media Twin's main agent also remains unpublished. Do not activate either as part of a blanket publish.

Bays' primary draft uses the verified direct model ID `anthropic/claude-haiku-5-5`; high-difficulty inline helpers use `anthropic/claude-sonnet-5`. Its backup uses OpenRouter with the corresponding Claude models. North Star, Research Twin and Media Twin use Sonnet 5. Existing instructions, tools and tasks were preserved; backup names and provider routing were changed in drafts.

## Workflow drafts and restore points

| Workflow | ID | Previous active version | Status |
| --- | --- | --- | --- |
| Bays - Commercial & Pattern Extractors | `ftonmTVMzpeTL7AS` | `1802a59b-60b1-4cfc-9224-d19a96ada7d4` | Worker draft saved, not published |
| Bays - Deep Think | `RQ9WLeWRRtxk4GMn` | `38ec14c0-b79b-4118-981e-a0aab0e55934` | Worker draft saved, not published |
| Bays - Error Handler | `iSr9sOV2AfhUQN7C` | `e064ef13-c427-4f0c-937f-51dcdbdc4c5b` | Worker draft saved, not published |
| Bays - Submit Actions | `YTpezWSOIN6TNYcX` | `03d8642b-9efc-4259-a32c-14ae6d84dcbb` | Worker draft saved, not published |
| North Star - Builder Pronoun Guard | `ELzFgYIlItmQ2PLs` | `6798b76b-913d-4292-b841-5bec9fd9083e` | Worker draft saved, not published |
| North Star - Error Handler | `9wuBBHVkKGhvS3MO` | `2c58fbd3-dcc4-4141-bd9a-aa741e2df6f9` | Worker draft saved, not published |
| Research Twin - Error Handler | `4WxzlFKpU6v2Gl8o` | `0d942d02-431d-4c5d-9bed-162299a72135` | Worker draft saved, not published |
| Research Twin - Web Search | `pvsuwhqOtoHPJddZ` | `a8b5aa26-1ced-43d4-876d-e4d7a7d14a4e` | Worker draft saved, not published |
| vFarm Pilot - Channel Listener | `2OBglxaVJBHSSuo1` | `72c2e3fd-b5d4-4e81-bf5d-7c02d7e0c316` | Worker draft saved, not published |
| Bays - Agent Delivery | `5AFqtZQaeKFFiGqe` | `7c709962-5772-44ac-913a-adb46cebb260` | Provider metadata draft saved, not published |
| North Star - Agent Delivery | `cnOz6iomtnWVXjso` | `e9d53dd4-e425-4b7c-9268-4517116996eb` | Provider metadata draft saved, not published |
| Research Twin - Agent Delivery | `w4SdZjjpokMuWPkV` | `d8c0a772-d622-4900-8c7b-e67c4d6fb675` | Provider metadata draft saved, not published |
| North Star - Recorded Helper Ask | `SZGkCtLkQbqO0yW8` | `687cf085-c77e-41a3-8ac1-a12b461ff7fd` | Provider metadata draft saved, not published |
| Bays - Scheduled Run Watch | `8yerdU9JtXoN5clt` | `aa8423c7-3e68-4714-b80d-95f5ef1d7202` | Provider metadata draft saved, not published |

The Submit Actions draft also reverses the `ai_languageModel` sockets for Layers 0, 1 and 2: Anthropic is index 0 and OpenRouter is index 1. The Anthropic model nodes enable one-hour prompt caching. Node labels were corrected to match those sockets.

Worker HTTP drafts preserve the legacy downstream response envelopes through explicit adapters. Native Anthropic usage fields, cache token counts and web citations are retained. OpenRouter fallback calls rebuild the original request from its source node, rather than receiving the primary error as the question. Existing error outputs, retry settings and destinations are preserved. The raw provider nodes retain explicit credential references, verified by re-reading Deep Think's saved draft.

The first manual test exposed an unsupported inline n8n expression. Request conversion was moved into Code nodes in all affected drafts. The next test reached Anthropic successfully but received the credit refusal, then produced a real answer through OpenRouter. This demonstrates fallback on that web-search failure, not a successful Anthropic primary test. Deep Think and the remaining worker end-to-end tests are still pending.

## Test evidence and limits

| Check | Result |
| --- | --- |
| Seven modified existing agent drafts | n8n validation passed |
| New Media Twin backup draft | n8n validation passed, not behavior-tested |
| Bays direct Anthropic preview | `ANTHROPIC_PRIMARY_OK`, execution `lxIb3nKolSMgOLm3`, before the later credit refusal |
| Research Twin draft eval | `DRAFT-202611030718-4UJU`: 9 of 9, no regressions |
| Bays draft eval | `DRAFT-202611030718-UG2X`: 16 of 20; four failures already present in `EVAL-202611020738`, no new regressions |
| North Star direct draft eval | `DRAFT-202611030718-VFKD`: stopped for credit after 25 of 33 answers; not a verdict |
| North Star automatic backup run | `DRAFT-202611030732-7Y97`: started by the existing eval runner; inspect separately, route labels currently assume the old provider arrangement |
| Worker node schemas | Initial 40 added HTTP/adapter nodes validated; later request-preparation changes saved without new validation warnings |
| Saved workflow mutation warnings | Existing header/canvas warnings remain; no new warning reported by the migration changes |
| Web-search draft fallback | Parent `63767`, child `63768`: Anthropic credit refusal followed by an OpenRouter answer with a source URL |
| Dashboard source | TypeScript typecheck and server build passed |
| Dashboard provider-routing tests | Direct Anthropic, cached system payload, same request on OpenRouter fallback, and both-provider failure passed with simulated responses |
| Draft-eval unit checks | 20 existing checks plus 3 provider-detection assertions passed |
| Candidate database integration test | Not run successfully; requires a local test Postgres database |
| Cache hit rate / production delivery | Not proven. Configuration is enabled, but there is no successful post-switch production run yet |

## Dashboard code draft for the next code session

The accompanying patch contains changes to `server/src/draftEval.ts`, `server/src/mcp/draftEvalTools.ts`, `server/src/patternDraft.ts`, `server/src/index.ts`, and the relevant tests and documentation. It has not been pushed or deployed. Its base is dashboard main commit `f1a0cbf73ce28c3616d26d20a21c3c8e0febccaa`.

- Draft eval reads the provider from the actual draft's `config.model`, applies the OpenRouter credit guard only to OpenRouter, and records the actual provider rather than guessing it from the agent ID. Backup runs cannot fall back recursively.
- Pattern drafting attempts direct Anthropic with a one-hour cached system block, then OpenRouter on a provider failure. It preserves the source evidence and current review-before-register behavior.
- The dashboard needs its own **company** `ANTHROPIC_API_KEY` in Render. An n8n credential is not automatically available to the dashboard. With that key absent, the code explicitly falls back to OpenRouter and the migration remains incomplete.
- Do not deploy the server while an eval is running: a restart marks active draft evals interrupted. Finish or explicitly handle those runs first.

## Still required before calling this done

1. Company key update has been verified through live n8n and repair-bridge calls. The dashboard direct Anthropic path still needs the prepared server code deployed before its Render key can be exercised.
2. North Star's updated-key direct draft eval DRAFT-202611030813-4O5P passed all 11 cases across 33 answers with no regressions. The earlier credit-stopped run remains incomplete as historical evidence. Per-backup full behavior suites beyond the recorded smoke and worker fallback checks remain to be completed before a blanket rollout.
3. Web-search and Deep Think primary and forced-backup tests have passed on the updated keys. Representative full-pipeline checks for log review, extractors, loop matching, error classification and the pilot classifier remain. Tests must not send Slack messages on Destiny's behalf.
4. Update the production Agent Evals Runner's provider choice, credit guard, backup labels and cost wording. Its current OpenRouter balance logic would choose the wrong route after this switch.
5. Finish Media Twin backup wiring and test it without publishing the previously unpublished agent. Its daily-draft workflow is inactive and was not activated.
6. Implement and test the repair bridge's provider reversal. Its current source defaults to OpenRouter with an Anthropic backup and a guard against retrying after writes. Preserve that no-double-write guard. Do not simply swap environment values while retaining hardcoded provider labels and backup behavior.
7. Verify Genie and the other Render workers from their real source/runtime settings. A zero-result code search is insufficient evidence. Hand changes in other builder-owned lanes to the appropriate owner when needed, without claiming they shipped.
8. Update alert text, spend/recovery descriptions and registry records that still assume OpenRouter is primary. Anthropic has no balance endpoint; never replace an unread balance with zero. Keep OpenRouter backup monitoring.
9. Have Destiny post the pre-change note in #bha-coordination. The standing agent-change procedure requires that note before a model swap is published. This task authorized a draft, not sending messages.
10. Publish in a staged order only after the checks pass, record every active version and the inventory, perform a real ask through each production entry path, verify delivery and fallback, and compare recorded tokens/cache usage. Re-publish the old active version from the restore table if a live check fails.

## Explicit exceptions

- Voice transcription: Gemini via OpenRouter. The verified Anthropic model catalog does not accept audio input. Preserve transcription and record this exception until a separate compatible audio route is chosen.
- ElevenLabs CST: uses DeepSeek directly through ElevenLabs, not an OpenRouter custom LLM. No model change made.
- Context Harvester: the available read shows an OpenAI node, not an OpenRouter call. Full workflow access was unavailable through n8n's connector; no change made.
- Retired, one-off and inactive legacy workflows: inventoried, not activated or rewritten. Several contain historical OpenRouter calls. Do not count them as live callers or resurrect them during this migration.


## Updated-key verification after Destiny confirmed installation

These checks ran against the new saved credentials. They verify access and the tested draft routes, not a completed production migration.

| Check | Verified result | Evidence |
| --- | --- | --- |
| Bays draft, direct Anthropic | PROVIDER_KEY_OK | Agent preview p9eJMjCSmvsD3yW9 |
| Research Twin draft, direct Anthropic | PROVIDER_KEY_OK | Agent preview Qq2W24sEIy3kko0q |
| North Star draft, direct Anthropic | PROVIDER_KEY_OK | Agent preview nGOnSS70AtzMWNOe |
| Bays OpenRouter backup draft | PROVIDER_KEY_OK | Agent preview b2EIW56YSbWOf2W5 |
| Web-search draft, Anthropic primary | Answer and source URLs returned on claude-haiku-5-5 | Manual workflow execution 63770, Check WebPrimary |
| Web-search draft, forced OpenRouter backup | Answer and source URL returned on anthropic/claude-haiku-5.5 | Manual workflow execution 63770, Check WebBackup |
| Deep Think draft, Anthropic primary | Analysis returned on claude-opus-5-5 | Manual workflow execution 63775, Check DeepPrimary |
| Deep Think draft, forced OpenRouter backup | Analysis returned on google/gemini-3.1-pro-preview | Manual workflow execution 63775, Check DeepBackup |
| Repair bridge, explicit Anthropic route | claude_reachable true, said OK, model claude-opus-5-5, no missing required environment variables, 3,526 ms | GET /health?deep=1&provider=backup |
| Repair bridge, current OpenRouter primary | claude_reachable true, said OK, provider openrouter, provider_fallback false, model claude-opus-5-5, 6,376 ms | GET /health?deep=1 |
| Dashboard service | Restarted on the existing f1a0cbf73ce28c3616d26d20a21c3c8e0febccaa code; no direct Anthropic code path in this deployed version | Dashboard get_health, source inspection |
| Full North Star direct draft re-eval | PASSED: 11 of 11 cases, all 33 answers, no regressions, unchanged draft hash; compared with EVAL-202611020738 | DRAFT-202611030813-4O5P, 11 cases / 33 answers |

The first resumed four-route harness execution 63770 stopped at the Deep Think assertion because the test expected `answer` while the existing workflow's documented contract returns `analysis`. The agent had answered successfully. The test assertion was corrected without changing Deep Think's output contract. Execution 63775 then passed both Deep Think routes. The harness was restored to its complete four-route chain and remains unpublished, manual only. One attempt to start the narrowed retest timed out in the automatic permission approval system before starting; the permitted single retry started execution 63775.

The still-deployed draft-eval server labels a fixed primary agent ID as OpenRouter even when its draft model is Anthropic. The actual North Star draft was re-read as anthropic/claude-sonnet-5 before testing. The provider-label correction remains in the undeployed server patch. Do not treat the old runner's `ran_on` label as evidence of the configured model route during this migration.

Prompt caching is configured, and the native API accepted the tested payloads. A cache-hit rate or cost reduction has not been measured. Neither the Anthropic balance nor company account ownership was independently read through an administrative billing API.

No Slack message was sent by these tests. Agent and worker migration drafts were not published. The dashboard key cannot be independently tested through its direct path until the code patch is deployed, and the repair bridge still uses OpenRouter as primary under its current code.
