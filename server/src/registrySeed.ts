/**
 * The registry's opening contents.
 *
 * Every row here was either supplied by Destiny (2026-09-13) or read back from
 * the live source — the n8n instance for the workflows, the Render API for the
 * services. Nothing is inferred. A field nobody could tell us is `null`, which
 * the page renders as "—" rather than as a plausible-looking guess.
 *
 * Where a value came from the live instance rather than from the brief, the
 * row's `notes` says so, because the two disagreed in two places and the
 * disagreement is the useful part.
 *
 * Seeding is `ON CONFLICT DO NOTHING` (see registry.ts), so this file is the
 * first version of each row and never the current one. Editing a row in the
 * interface wins permanently; changing a string here does not reach a row that
 * already exists.
 *
 * NEVER put a secret in this file. The credentials below are names and owners
 * only — that is the whole point of that table.
 */

export interface SeedRow {
  id: string;
  [field: string]: unknown;
}

const N8N = 'https://bayshorizonnetwork.app.n8n.cloud';
/**
 * The note the rows added on 2026-09-22 carry. They were seeded first with
 * folder, owner and trigger null; migration 25 filled them from n8n and holds
 * the earlier note text it matches on.
 */
const READ = 'Added 2026-09-22 from the live n8n workflow list; system chosen from the name. Folder is the n8n parent folder and trigger the workflow\'s own trigger nodes, both read 2026-09-22. Owner follows the convention every BHA Engine row has (Destiny Arupi): n8n records no owner on a team-project workflow.';
const wfUrl = (id: string) => `${N8N}/workflow/${id}`;

/**
 * Workflows, from the BHA ENGINE project on bayshorizonnetwork.app.n8n.cloud.
 *
 * `folder`, `pillar`, `trigger_type`, `trigger_detail` and `purpose` were read
 * from each workflow's own overview sticky note and trigger configuration on
 * 2026-09-13, not assumed from the name. Two rows could not be read and say so
 * in their notes: the archived North Star — Capacity Intelligence, and the
 * vFarm funnel workflow, which has MCP access turned off.
 */
const W = (
  id: string,
  name: string,
  system: string,
  folder: string | null,
  pillar: string | null,
  owner: string | null,
  trigger_type: string | null,
  trigger_detail: string | null,
  purpose: string | null,
  status = 'production',
  notes: string | null = null,
): SeedRow => ({ id, name, system, folder, pillar, owner, trigger_type, trigger_detail, purpose, status, n8n_url: wfUrl(id), notes });

export const WORKFLOWS: SeedRow[] = [
  // Research Twin / Agent
  W('u2jfe2eRQYIEtuZQ', 'Research Twin — Conversational Agent', 'Research Twin', 'Research Twin Agent', 'Agent', 'Destiny Arupi', 'sub-workflow', 'Called by Research Twin — Front Door',
    'The reasoning layer of Research Twin: builds the prompt, runs the agent, and hands the answer to a deterministic delivery tail.'),
  W('K1iQ72ZTEzQKrxb9', 'Research Twin — Front Door', 'Research Twin', 'Research Twin Agent', 'Routing', 'Destiny Arupi', 'webhook', 'POST /webhook/research-twin',
    'The single public entry point for Research Twin. It receives, decides and routes — it never answers.'),
  W('zikfpO0wvqzPCQuz', 'Research Twin — Tools Router', 'Research Twin', 'Research Twin Agent', 'Routing', 'Destiny Arupi', 'sub-workflow', 'Called by Research Twin — Conversational Agent',
    'Every tool the Research Twin agent can call lands here, so all write logic stays in one reviewable place.'),
  // Research Twin / Subsystems
  W('4WxzlFKpU6v2Gl8o', 'Research Twin — Error Handler', 'Research Twin', 'Research Twin Subsystems', 'Observability', 'Destiny Arupi', 'error trigger', 'Error workflow on every Research Twin workflow; also callable from the Tools Router',
    'Catches every failure in the Research Twin stack, classifies it, files an incident, and decides whether a person needs telling now.'),
  W('lON0a0xdXze2GaxK', 'Research Queue — Weekly Sweep', 'Research Twin', 'Research Twin Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Mondays 10:00',
    'Re-asks every research question that never got a usable answer, carrying what earlier attempts already ruled out.'),
  W('g2xQxuOCbH7LhgAj', 'Research Queue — Weekly Digest', 'Research Twin', 'Research Twin Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Mondays 13:00',
    'Reports what the Research Queue closed this week — what resolved, and what capped out and needs a person.'),
  W('KOZMm2TTFTme5YkQ', 'Watched Clients — Weekly Clock', 'Research Twin', 'Research Twin Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Mondays 09:00',
    'Walks every watched client lane weekly and sends its standing questions to Research Twin to be re-answered.'),
  // North Star Twin / Agent
  W('seK3we7pTurvZmqe', 'North Star — Conversational Agent', 'North Star Twin', 'North Star Agent', 'Agent', 'Destiny Arupi', 'sub-workflow', 'Called by North Star — Front Door',
    "BHA's prioritisation brain: gathers real evidence, reasons to a judgment, delivers the answer, and records how it got there."),
  W('6S4X6UYtDpETB6u6', 'North Star — Front Door', 'North Star Twin', 'North Star Agent', 'Routing', 'Destiny Arupi', 'webhook', 'POST /webhook/north-star',
    'The single public entry point for North Star. It receives, decides and routes — it never answers.'),
  W('G6Myypk64kpcaVhz', 'North Star — Tools Router', 'North Star Twin', 'North Star Agent', 'Routing', 'Destiny Arupi', 'sub-workflow', 'Called by North Star — Conversational Agent and North Star — Weekly Status',
    'Every tool the North Star agent can call lands here, so all read and write logic stays in one reviewable place.'),
  // North Star Twin / Subsystems
  W('9wuBBHVkKGhvS3MO', 'North Star — Error Handler', 'North Star Twin', 'North Star Subsystems', 'Observability', 'Destiny Arupi', 'error trigger', 'Error workflow on every North Star workflow; also callable directly',
    'Catches every failure in the North Star stack, classifies it, files an incident, and decides whether a person needs telling now.'),
  W('aPP4AMtcB4xmOSCW', 'North Star — Weekly Status', 'North Star Twin', 'North Star Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Mondays 09:00',
    'The proactive half of North Star: a weekly briefing of what moved, what ranks highest, and what is at risk.'),
  W('wCTENdZmWRfLl3go', 'North Star — Capacity Intelligence', 'North Star Twin', 'North Star Subsystems', null, 'Destiny Arupi', null, null, null, 'retired',
    'Archived in n8n on 13 Sep 2026 and no longer readable through the API, so its pillar, trigger and purpose could not be read back. Its Get_Capacity_Status route was removed from North Star — Tools Router the same day; capacity is dashboard telemetry now.'),
  // Bays / Agent
  W('rKRnxHhKSJUd4Q6M', 'Bays — Conversational Agent', 'Bays', 'Bays Agent', 'Agent', 'Destiny Arupi', 'sub-workflow', 'Called by Bays — Front Door on the agent route',
    'The Bays people actually talk to in Slack — 53 nodes, 38 of them tools, the widest tool surface in the engine.'),
  W('GjNtBQQvVSJvsPNI', 'Bays — Dashboard Agent', 'Bays', 'Bays Agent', 'Agent', 'Destiny Arupi', 'webhook', 'POST /webhook/dashboard-ask-bays (header auth)',
    'The Ask Bays panel in this dashboard. Same identity as the Slack Bays, separate instance, so neither can break the other.'),
  W('134ezjaO6gYqYjez', 'Bays — Front Door', 'Bays', 'Bays Agent', 'Routing', 'Destiny Arupi', 'webhook', 'POST /webhook/bays (raw body on)',
    'The single public entry point for Bays and the busiest door in the engine — seven routes. It never answers anything itself.'),
  W('WjWzhVRq566A60fJ', 'Bays — Tools Router', 'Bays', 'Bays Agent', 'Routing', 'Destiny Arupi', 'sub-workflow', 'Called as a sub-workflow (inputSource passthrough)',
    'The largest workflow in the engine — 107 nodes, 18 tool branches. Every Bays agent tool that does more than one thing lands here.'),
  // Bays / Subsystems
  W('ZBquodTosOOyYgUl', 'Bays — Callback Receiver', 'Bays', 'Bays Subsystems', 'Routing', 'Destiny Arupi', 'sub-workflow', 'Called by Bays — Front Door (inputSource passthrough)',
    'Receives signed answers coming back from the other subsystems, proves they are genuine, and delivers them into Slack.'),
  W('WYOacTvwe6iarNSF', 'Bays — Commands & Cancel', 'Bays', 'Bays Subsystems', 'Routing', 'Destiny Arupi', 'sub-workflow', 'Called by Bays — Front Door (inputSource passthrough)',
    'Every Bays slash command, plus the Cancel button on the log form — six commands sharing one dispatcher and one response path.'),
  W('ftonmTVMzpeTL7AS', 'Bays — Commercial & Pattern Extractors', 'Bays', 'Bays Subsystems', 'Ingestion', 'Destiny Arupi', 'webhook', 'POST /webhook/commercial-pattern-extractors',
    'Reads an approved Codex entry and asks two independent questions of it: is there a sellable opportunity, and is there a reusable build pattern.'),
  W('Q9LyrNP3o5Qditat', 'Bays — Daily Digests', 'Bays', 'Bays Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Fires at 08:00, 09:00 and 10:00 and routes by the hour',
    'Three separate reports in one workflow, sharing one trigger that routes by the hour it fired.'),
  W('hoDXLJuQojYwiO3W', 'Bays — Daily Doc Rotator', 'Bays', 'Bays Subsystems', 'Ingestion', 'Destiny Arupi', 'schedule', 'Daily at midnight',
    "Ingests yesterday's channel capture doc into BHARAG, then creates a fresh doc for today and repoints the tracking row."),
  W('5JMxwNZn2mSYOlO1', 'Bays — Daily Open Loops Sweep', 'Bays', 'Bays Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Seven triggers, 08:00 to 08:30, five minutes apart — one per builder',
    'Every morning each builder gets their own open loops read back to them, ranked by North Star and summarised in plain English.'),
  W('iSr9sOV2AfhUQN7C', 'Bays — Error Handler', 'Bays', 'Bays Subsystems', 'Observability', 'Destiny Arupi', 'error trigger', 'Error workflow on every Bays workflow; also callable directly',
    'Catches every failure across the twelve Bays workflows, classifies it, files an incident, and decides whether anyone needs telling now.'),
  W('oojcbu9tgSme2JV1', 'Bays — In Progress Loops Check-in', 'Bays', 'Bays Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Every 3 days at 09:00',
    'Every three days, reminds each builder what they have already started and not finished.'),
  W('4qyFecIxBtK6F2K7', 'Bays — Message Capture', 'Bays', 'Bays Subsystems', 'Ingestion', 'Destiny Arupi', 'sub-workflow', 'Called by Bays — Front Door, fire and forget (inputSource passthrough)',
    "Two jobs in one: builds a channel's archive when Bays joins it, and appends every message in a tracked channel to that channel's doc.",
    'production', "Its own overview note reads 'Production (one branch disabled)'."),
  W('IN9xDckKW9I7kiLh', 'Bays — Onboarding', 'Bays', 'Bays Subsystems', 'Ingestion', 'Destiny Arupi', 'sub-workflow', 'Called by Bays — Front Door on the onboarding route',
    'Everything a new builder needs the moment they join Slack: log channel, channel memberships, Drive folder, Airtable table and a welcome DM.'),
  W('lEyirYDareupAmlB', 'Bays — Parked Log Reminder', 'Bays', 'Bays Subsystems', 'Monitoring', 'Destiny Arupi', 'schedule', 'Every 6 hours',
    'Chases builders whose session logs are parked at the Layer 0 completeness gate and therefore never reach Jason.'),
  W('YTpezWSOIN6TNYcX', 'Bays — Submit Actions', 'Bays', 'Bays Subsystems', 'Ingestion', 'Destiny Arupi', 'sub-workflow', 'Called by Bays — Front Door on the submit route (inputSource passthrough)',
    'The log pipeline, and the workflow that decides whether a builder gets paid — submit through to a Codex entry in BHARAG.'),
  W('ivV8s8BkRoJ8ScDu', 'Bays — Digest Delivery Check', 'Bays', 'Bays Subsystems', 'Observability', 'Destiny Arupi', 'schedule', 'Hourly',
    'Flags digests accepted by North Star that never arrived in Slack.',
    'production',
    'Added 13 Sep 2026. It writes to digest_deliveries in the engine_events base; a row it marks missing is a digest a builder never received, which nothing else in the stack reports \u2014 every other signal stops at North Star accepting the hand-off, four hops short of Slack.'),
  // vFarm
  W('fhQNvRFdh1H6Li0E', 'vFarm Early Access Lead → Buyer Link', 'vFarm', 'vFarm', null, 'Hardik Bhatt', null, null, null, 'production',
    "n8n titles this 'vFarm Early Access Lead → Buyer Link [MIGRATED]', reports it inactive, and has MCP access turned off, so its pillar, trigger and purpose could not be read back (13 Sep 2026). Status here is as briefed, not as observed — worth confirming."),
  /*
   * Added 2026-09-22 from the live n8n workflow list (42 workflows; these 14
   * had no row). Name, active state and description are n8n's own; `system`
   * is chosen from the workflow's name and says so in its notes; folder,
   * owner and trigger were not read and are null rather than guessed.
   * Inactive workflows are `retired`, except where a note says otherwise.
   */
  W('oOAZaW1aQaRP2arc', 'BHA — Self Healer', 'Engine', 'Engine Self-Healing', null, 'Destiny Arupi', 'sub-workflow + webhook', 'Handed every failure by the three error handlers; POST /webhook/engine-heal (Retry now, moved here 22 Sep)',
    'The one self-healing layer for all three lanes: routes each failure to retry, Claude Code repair, or a person, and reports every outcome.', 'production', READ),
  W('wZpWp9ov6exxoez0', 'BHA — Self Healer Reports', 'Engine', 'Engine Self-Healing', null, 'Destiny Arupi', 'webhook', 'POST /webhook/repair-result',
    'Receives a repair or retry result, reports it in #bha-self-healing whatever the outcome, and closes the BHARAG incident when the result was a fix.', 'production', READ),
  W('3Pzm0DlJZSNu6DU4', 'Engine — Self-Healing Retry', 'Engine', null, null, 'Destiny Arupi', 'schedule + webhook', 'Every 5 minutes; POST /webhook/engine-heal',
    'Retries the failures a retry can fix, with backoff and a circuit breaker, and writes retry_attempts.', 'retired', `${READ} Archived in n8n, so its folder cannot be read. Its /webhook/engine-heal trigger moved to BHA — Self Healer on 22 Sep, which is what Retry now reaches.`),
  W('MtjakyCf90lgah7S', 'TEST — Self-healing, Bays lane', 'Test', 'Sandbox (For Testing & One-Off Builds)', null, 'Destiny Arupi', 'webhook', 'POST /webhook/heal-test-bays-0921',
    'Deliberately broken test workflow for the Bays self-healing lane. Safe to delete after testing.', 'experimental', READ),
  W('xIVt2cO0VHDJ7jT6', 'TEST — Self-healing, North Star lane', 'Test', 'Sandbox (For Testing & One-Off Builds)', null, 'Destiny Arupi', 'webhook', 'POST /webhook/heal-test-ns-0921',
    'Deliberately broken test workflow for the North Star self-healing lane. Safe to delete after testing.', 'experimental', READ),
  W('4beRTMIlgJ0njPna', 'TEST — Self-healing, Research Twin lane', 'Test', 'Sandbox (For Testing & One-Off Builds)', null, 'Destiny Arupi', 'webhook', 'POST /webhook/heal-test-rt-0921',
    'Deliberately broken test workflow for the Research Twin self-healing lane. Safe to delete after testing.', 'experimental', READ),
  W('LR7M1POhHvJ0j7Vm', 'Bays — Pay Tracking', 'Bays', 'Pay', null, 'Destiny Arupi', 'schedule + sub-workflow', 'Called by Bays — Submit Actions on each approval; 1st of the month 09:00; Mondays 10:00',
    'Records every approved session, sends one statement per monthly builder on the 1st, and reminds daily builders to confirm sessions still showing unpaid.', 'production', READ),
  W('t79s1mXSHink3dAM', 'Bays — Pay Ledger Sync', 'Bays', 'Pay', null, 'Destiny Arupi', 'schedule', 'Every 30 minutes',
    'Keeps the pay ledger in step with the approved session logs, in both directions, without touching the live approval path or the Yes, Paid button.', 'production', READ),
  W('GES8UIM3dJRbrLSx', 'BHA — Dashboard Loop Write-Back', 'Bays', 'Open Loops', null, 'Destiny Arupi', 'webhook', 'POST /webhook/dashboard-loop-writeback (X-N8N-API-KEY header)',
    'Wrote loop status changes from this dashboard back to the Airtable Open Loops tables. Retired 14 Sep, when loop edits began writing to Airtable directly.', 'retired', READ),
  W('xxME1VLRkPdlLpaV', 'vFarm Early Access — Lead Notifier', 'vFarm', 'vFarm', null, null, 'webhook', 'POST /webhook/vfarm-early-access-lead, called by this dashboard on a new Early Access lead',
    'Receives a vFarm Early Access lead notification from the BHA Engine Dashboard and posts it into #vfarm-early-access.', 'production', `${READ} Owner left blank: the one comparable row, the vFarm lead workflow it replaced, is Hardik Bhatt's, while this one was built for the dashboard — two conventions, so no owner is assumed.`),
  W('rt2oje925OyiSttf', 'GenieContextTest-20260918220730', 'Genie', null, null, 'Destiny Arupi', 'webhook', 'POST /webhook/geniecontexttest-20260918220730-a7k9m2',
    'Webhook trigger that replies with JSON {"ok":true}. Unpublished, no Slack, Gmail or OAuth — a connectivity test.', 'retired', `${READ} In Destiny Arupi's personal n8n project, at its root, not in the BHA Engine project — so no folder, and the owner is that project's.`),
  W('N9kIvHF8Vohy8OeM', 'Add source_campaign Header (one-off)', 'One-off', 'Sandbox (For Testing & One-Off Builds)', null, 'Destiny Arupi', null, null,
    null, 'retired', `${READ} Trigger not read: MCP access is turned off on this workflow in n8n. A one-off job, inactive; n8n carries no description for it.`),
  W('PEdHH8OZuplhTidg', 'ONE-OFF — Ingest vFarm clip patterns v0.2 (D565)', 'One-off', null, null, 'Destiny Arupi', 'webhook', 'POST /webhook/oneoff-vfarm-clip-patterns-d565',
    "One-off: ingest Hardik's eight vFarm clip patterns plus the patched v0.2 contract into BHARAG as nine documents, then read each back by exact pattern_id. LOOP-1789929222645-D565.", 'retired', `${READ} At the root of the BHA Engine project, in no folder.`),
  /* Created in n8n at 19:07 UTC on 22 Sep, after the list above was taken — the run that closed 37 stale incidents. */
  W('QqSeahroA4ez2iOp', 'ONE-OFF — Close stale incidents (22 Sep audit)', 'One-off', null, null, 'Destiny Arupi', 'webhook', 'POST /webhook/close-stale-incidents',
    "One-off: closes incidents left open on the BHARAG ledger after being fixed by hand, using each lane's own incident key, and reports every refusal with BHARAG's reason.",
    'retired', `${READ} At the root of the BHA Engine project, in no folder. Inactive in n8n.`),
];

/**
 * Services. Costs, billing cycles, renewal dates and billing owners are all
 * null on purpose: nobody supplied them and this file will not invent one.
 * The Services & Billing tab says how many are unpriced beside every total so
 * an incomplete figure can never read as a complete one.
 *
 * `plan` is filled only where the live source states it — n8n's is named in
 * its own workflow notes, Render's per-service plans are listed in that row's
 * notes from the live API on 2026-09-13.
 */
const S = (
  id: string,
  name: string,
  category: string,
  what_it_is_for: string | null,
  url: string | null,
  managed_by: string | null,
  plan: string | null = null,
  notes: string | null = null,
  status: 'active' | 'trial' | 'retired' = 'active',
): SeedRow => ({
  id, name, category, what_it_is_for, url, managed_by, plan,
  /**
   * Dollars and BHA on every row (2026-09-16, Destiny): "currency for all of
   * them is in dollars", "who pays, just put BHA". `cost_amount` and
   * `billing_cycle` stay null, because nobody has supplied them and a figure
   * nobody supplied is what section 2 forbids — the spend card counts these
   * as unpriced and says so.
   */
  billing_owner: 'BHA', cost_amount: null, cost_currency: 'USD', billing_cycle: null, renewal_date: null,
  status, notes,
});

export const SERVICES: SeedRow[] = [
  S('n8n-cloud', 'n8n Cloud', 'automation',
    'Runs every workflow in the engine — the BHA ENGINE project holds thirty of them.',
    'https://bayshorizonnetwork.app.n8n.cloud', 'Destiny Arupi', 'Pro',
    'Pro rather than Community because instance Variables are needed: the three callback signing secrets live there, and Code nodes cannot bind credentials. Recorded from the Callback Receiver notes, 12 Sep 2026.'),
  S('render', 'Render', 'hosting',
    'Hosts this dashboard and its database, the Genie services, ragingester, smartcursorbrowser and the vFarm SDK docs.',
    'https://dashboard.render.com', 'Kaiqi Yang', null,
    "Workspace “Bays' workspace” (tea-dafco81t0dsc73djsv4g). Live inventory read from the Render API on 13 Sep 2026 — eight paid resources, none of them priced here: bha-engine-dashboard (web, 0.5c-512mb), bha-engine-db (postgres 18, 0.1c-256mb, 1 GB), genie-v3-migration (web, starter), genie-v3-migration-ldye (web, starter), ragingester (web, starter), smartcursorbrowser (web, starter), Genie-RSS (web, free), vfarm-device-sdk-docs (static site, starter build). All in Oregon."),
  S('airtable', 'Airtable', 'data',
    'Was the system of record for open loops, submissions, the research queue, build patterns, commercial cards and lane state.',
    'https://airtable.com', 'Destiny Arupi', 'Free',
    'Retired 21 Sep 2026: every record now lives in this dashboard, written by n8n through /api/engine. Its bases are kept as history on the Endpoints tab.', 'retired'),
  S('bharag', 'BHARAG', 'data',
    'The RAG and incident store every subsystem reads from and writes to.',
    'https://bharag2.duckdns.org', 'Jeganathan', null, null),
  S('slack', 'Slack', 'comms',
    'Where Bays, North Star and Research Twin meet the team.',
    'https://bayshorizonnetwork.slack.com', null, null, null),
  S('google-workspace', 'Google Workspace', 'storage',
    'Drive and Docs for session narrations, channel archives and client reports.',
    'https://admin.google.com', null, 'Free',
    'admin@bhanetwork.org. Every BHA Google credential moved from destiny@ to admin@ on 9 Sep 2026; a document owned by a personal account is not reachable by the admin account, which presents as an intermittent 403.'),
  S('openrouter', 'OpenRouter', 'ai',
    'The model gateway every agent and every error classifier calls.',
    'https://openrouter.ai', null, 'Pay as you go',
    'Briefed models in use: anthropic/claude-sonnet-5 and google/gemini-3.1-pro-preview. Reading the live workflows on 13 Sep also found anthropic/claude-sonnet-4-5 and 4.5 in the three error classifiers and the weekly ranking, and claude-sonnet-4.5:online for web search. No gemini call was found.'),
  S('genie-v3', 'Genie v3', 'other',
    'The Genie service Bays exchanges signed callbacks with.',
    'https://genie-v3-migration-u82u.onrender.com', 'Kaiqi Yang', null,
    'Host corrected on 16 Sep 2026. genie-v3-migration.onrender.com never resolved and was ruled out as either live service against the Render API; Kaiqi confirmed genie-v3-migration-u82u as the canonical deployment before ask_genie was repointed to it.'),
  S('otter', 'Otter.ai', 'comms',
    'Session recording and transcription behind every builder narration.',
    'https://otter.ai', null, null,
    'No public invite API. Workspace invites are sent by hand from the Otter admin console (Workspace → Invite people to Workspace); Bays — Onboarding names this as a manual step on every onboarding notice, because a builder without Otter cannot record a session and therefore cannot log one.'),
  S('onshape', 'Onshape', 'other',
    'CAD for the vFarm build.',
    'https://onshape.com', 'Hardik Bhatt', null, null),
  /**
   * Added on Destiny's instruction, 16 Sep 2026. No cost and no billing cycle,
   * because none was given: it shows as unpriced on the spend card until
   * somebody fills it in, which is the honest state rather than a guess.
   */
  S('aws', 'AWS', 'hosting',
    'Cloud infrastructure alongside Render.',
    'https://console.aws.amazon.com', null, null, null),
  /**
   * Added 18 Sep 2026, on the day the domain moved. Read from the
   * #bha-coordination front-door thread rather than supplied, so every claim
   * in the note is something somebody wrote down.
   *
   * Categorised `other`: it is a registrar, not hosting, and there is no
   * `domains` category to put it in. The vocabulary is the server's and
   * inventing an eighth value to file one row under is not this file's call.
   */
  S('godaddy', 'GoDaddy', 'other',
    'Registrar and DNS for bhanetwork.org and every service hostname under it.',
    'https://dcc.godaddy.com', 'Destiny Arupi', null,
    'The one account where losing access loses everything downstream at once — every service address, every certificate, every device pin. Moved off Jason’s personal GoDaddy login into an org account under admin@bhanetwork.org by GoDaddy Account Change on 18 Sep 2026: the domain stays at GoDaddy and its DNS records travel with it, which is why it completed in minutes rather than the five to seven days a registrar transfer takes. The same consolidation Render, GitHub, AWS and n8n went through on 10 Sep. Delegate access was not enough on its own — GoDaddy blocks a delegate from generating an API key, so DNS would have stayed click-by-click for good, and the Domains section is invisible below the Products & Domains delegate level. Credentials are in Bitwarden as “GoDaddy – BHA Network (admin@bhanetwork.org)”; no value of any kind is recorded here. A published GoDaddy Website Builder site still sits on the apex: it cannot serve /vfarm and /cst from one repo or read the landing-config, so it is replaced rather than extended when the front door cuts over.'),
];

/**
 * Credentials — names, types and ownership only. **No value of any kind is
 * stored here, and none may ever be added.** The page says so in a banner.
 *
 * Read from the n8n BHA Engine project on 2026-09-13, so this is the live set
 * rather than the supplied list: twenty-nine credentials against the seventeen
 * briefed. The twelve that were not on the list carry a note saying so, because
 * a credential nobody has written down is exactly what a registry is for.
 *
 * `used_by` holds the workflows each credential was actually found on across
 * the twenty-nine readable workflows. An empty list means none was found, not
 * that none exists — two workflows could not be read at all.
 */
const C = (id: string, name: string, type: string, used_by: string[], owner: string | null, notes: string | null = null): SeedRow =>
  ({ id, name, type, used_by, owner, notes });

const UNLISTED = 'Found in the n8n BHA Engine project on 13 Sep 2026 but not on the supplied credential list.';

export const CREDENTIALS: SeedRow[] = [
  C('cred-airtable', 'Airtable', 'airtableTokenApi',
    ['4qyFecIxBtK6F2K7','9wuBBHVkKGhvS3MO','Q9LyrNP3o5Qditat','WYOacTvwe6iarNSF','WjWzhVRq566A60fJ','YTpezWSOIN6TNYcX','ftonmTVMzpeTL7AS','rKRnxHhKSJUd4Q6M','seK3we7pTurvZmqe','zikfpO0wvqzPCQuz','4WxzlFKpU6v2Gl8o','lON0a0xdXze2GaxK','g2xQxuOCbH7LhgAj','KOZMm2TTFTme5YkQ','G6Myypk64kpcaVhz','GjNtBQQvVSJvsPNI','hoDXLJuQojYwiO3W','5JMxwNZn2mSYOlO1','iSr9sOV2AfhUQN7C','oojcbu9tgSme2JV1','IN9xDckKW9I7kiLh','lEyirYDareupAmlB'],
    'Destiny Arupi', 'The most widely used credential in the engine — twenty-two of the thirty workflows.'),
  C('cred-openrouter', 'OpenRouter', 'openRouterApi',
    ['9wuBBHVkKGhvS3MO','Q9LyrNP3o5Qditat','WjWzhVRq566A60fJ','YTpezWSOIN6TNYcX','ftonmTVMzpeTL7AS','rKRnxHhKSJUd4Q6M','seK3we7pTurvZmqe','u2jfe2eRQYIEtuZQ','4WxzlFKpU6v2Gl8o','aPP4AMtcB4xmOSCW','GjNtBQQvVSJvsPNI','iSr9sOV2AfhUQN7C'],
    null, null),
  C('cred-google-drive', 'Google Drive', 'googleDriveOAuth2Api',
    ['4qyFecIxBtK6F2K7','Q9LyrNP3o5Qditat','WjWzhVRq566A60fJ','YTpezWSOIN6TNYcX','rKRnxHhKSJUd4Q6M','GjNtBQQvVSJvsPNI','IN9xDckKW9I7kiLh'], null, null),
  C('cred-google-docs', 'Google Docs', 'googleDocsOAuth2Api',
    ['4qyFecIxBtK6F2K7','Q9LyrNP3o5Qditat','WYOacTvwe6iarNSF','YTpezWSOIN6TNYcX','ftonmTVMzpeTL7AS','rKRnxHhKSJUd4Q6M','GjNtBQQvVSJvsPNI','hoDXLJuQojYwiO3W'], null, null),
  C('cred-google-sheets', 'Google Sheets', 'googleSheetsOAuth2Api', ['4qyFecIxBtK6F2K7'], null, null),
  C('cred-slack-bays', 'Bays', 'slackApi',
    ['134ezjaO6gYqYjez','4qyFecIxBtK6F2K7','Q9LyrNP3o5Qditat','WYOacTvwe6iarNSF','WjWzhVRq566A60fJ','YTpezWSOIN6TNYcX','ftonmTVMzpeTL7AS','rKRnxHhKSJUd4Q6M','GjNtBQQvVSJvsPNI','ZBquodTosOOyYgUl','hoDXLJuQojYwiO3W','5JMxwNZn2mSYOlO1','iSr9sOV2AfhUQN7C','IN9xDckKW9I7kiLh','lEyirYDareupAmlB'],
    null, 'Briefed as “Slack (Bays)”; n8n names it simply “Bays”.'),
  C('cred-ns-service', 'NS Service API Key', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','5JMxwNZn2mSYOlO1','oojcbu9tgSme2JV1'], null, null),
  C('cred-rt-service', 'RT Service API Key', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','ftonmTVMzpeTL7AS','KOZMm2TTFTme5YkQ'], null, null),
  C('cred-genie-service', 'Genie Service API Key', 'httpHeaderAuth', ['WjWzhVRq566A60fJ'], null, null),
  C('cred-bharag-cluster', 'BHARAG Cluster', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','YTpezWSOIN6TNYcX','zikfpO0wvqzPCQuz','G6Myypk64kpcaVhz'], 'Jeganathan', null),
  C('cred-bharag-bays-inc', 'BHARAG - Bays Incidents', 'httpHeaderAuth', ['iSr9sOV2AfhUQN7C'], 'Jeganathan', null),
  C('cred-bharag-archives', 'BHARAG - Channel Archives', 'httpHeaderAuth', ['hoDXLJuQojYwiO3W'], 'Jeganathan', null),
  C('cred-bharag-patterns', 'BHARAG - Build Patterns', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','ftonmTVMzpeTL7AS'], 'Jeganathan', null),
  C('cred-bharag-commercial', 'BHARAG - Commercial Opps', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','ftonmTVMzpeTL7AS'], 'Jeganathan', null),
  C('cred-bharag-codex', 'BHARAG - Codex', 'httpHeaderAuth', ['WYOacTvwe6iarNSF','WjWzhVRq566A60fJ','YTpezWSOIN6TNYcX','GjNtBQQvVSJvsPNI'], 'Jeganathan',
    'Also the header-auth credential bound to the dashboard-ask-bays webhook, which is not a Codex use — worth renaming or splitting.'),
  C('cred-bharag-ns', 'BHARAG - North Star', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','seK3we7pTurvZmqe'], 'Jeganathan', null),
  C('cred-n8n-engine', 'n8n - BHA Engine', 'httpHeaderAuth', ['WjWzhVRq566A60fJ','rKRnxHhKSJUd4Q6M'], 'Destiny Arupi', null),
  // Live in n8n, absent from the supplied list.
  C('cred-slack-rt', 'Research Twin', 'slackApi', ['zikfpO0wvqzPCQuz','K1iQ72ZTEzQKrxb9','4WxzlFKpU6v2Gl8o','g2xQxuOCbH7LhgAj'], null, UNLISTED),
  C('cred-slack-ns', 'North Star', 'slackApi', ['9wuBBHVkKGhvS3MO','seK3we7pTurvZmqe','6S4X6UYtDpETB6u6','aPP4AMtcB4xmOSCW','G6Myypk64kpcaVhz'], null, UNLISTED),
  C('cred-bharag-rt', 'BHARAG - Research Twin', 'httpHeaderAuth', ['zikfpO0wvqzPCQuz'], 'Jeganathan', UNLISTED),
  C('cred-bharag-rt-inc', 'BHARAG - RT Incidents', 'httpHeaderAuth', ['4WxzlFKpU6v2Gl8o'], 'Jeganathan', UNLISTED),
  C('cred-bharag-ns-inc', 'BHARAG - NS Incidents', 'httpHeaderAuth', ['9wuBBHVkKGhvS3MO'], 'Jeganathan', UNLISTED),
  C('cred-scraper-auth', 'Scraper Auth', 'httpHeaderAuth', [], null, `${UNLISTED} No workflow was found using it.`),
  C('cred-google-sheets-acct', 'Google Sheets account', 'googleSheetsOAuth2Api', [], null, `${UNLISTED} No workflow was found using it.`),
  C('cred-gs-trigger', 'Google Sheets Trigger', 'googleSheetsTriggerOAuth2Api', [], null, `${UNLISTED} No workflow was found using it.`),
  C('cred-gs-trigger-1', 'Google Sheets Trigger account', 'googleSheetsTriggerOAuth2Api', [], null, `${UNLISTED} No workflow was found using it.`),
  C('cred-gs-trigger-2', 'Google Sheets Trigger account 2', 'googleSheetsTriggerOAuth2Api', [], null, `${UNLISTED} No workflow was found using it.`),
  C('cred-gs-trigger-3', 'Google Sheets Trigger account 3', 'googleSheetsTriggerOAuth2Api', [], null, `${UNLISTED} No workflow was found using it.`),
  C('cred-gs-trigger-4', 'Google Sheets Trigger account 4', 'googleSheetsTriggerOAuth2Api', [], null, `${UNLISTED} No workflow was found using it.`),
];

/** Endpoints the engine exposes or calls. */
const E = (id: string, name: string, url: string, method: string, auth_type: string | null, owned_by_service: string | null, what_calls_it: string | null, notes: string | null = null): SeedRow =>
  ({ id, name, url, method, auth_type, owned_by_service, what_calls_it, notes });

export const ENDPOINTS: SeedRow[] = [
  E('ep-bays', 'Bays front door', `${N8N}/webhook/bays`, 'POST', 'none (Slack signature)', 'n8n Cloud',
    'Slack events and slash commands; callbacks from Research Twin, North Star and Genie',
    'Raw Body is on, which the Callback Receiver depends on: Genie signs the literal request bytes, and a reconstructed body would not match.'),
  E('ep-north-star', 'North Star front door', `${N8N}/webhook/north-star`, 'POST', 'x-api-key header', 'n8n Cloud',
    'Slack app mentions; Bays Daily Open Loops Sweep and In Progress Loops Check-in; Genie and vFarm', null),
  E('ep-research-twin', 'Research Twin front door', `${N8N}/webhook/research-twin`, 'POST', 'x-api-key header', 'n8n Cloud',
    'Slack events; Watched Clients — Weekly Clock; commercial card payloads; Genie, Bays and North Star', null),
  E('ep-extractors', 'Commercial & pattern extractors', `${N8N}/webhook/commercial-pattern-extractors`, 'POST', null, 'n8n Cloud',
    'Bays — Submit Actions, once a Codex entry is approved', null),
  E('ep-dashboard-ask-bays', 'Dashboard Ask Bays', `${N8N}/webhook/dashboard-ask-bays`, 'POST', 'header auth (x-api-key)', 'n8n Cloud',
    "This dashboard's server, never the browser",
    'Header auth is bound to the webhook node itself, so an unauthorised request is rejected before any code runs. That is possible here because there is exactly one caller; the Slack front doors cannot do it, since Slack sends no key.'),
  E('ep-bharag-ingest', 'BHARAG ingest', 'https://bharag2.duckdns.org/api/v1/ingest', 'POST', 'header auth', 'BHARAG cluster',
    'Bays — Daily Doc Rotator and the extractor lanes', null),
  E('ep-bharag-incidents', 'BHARAG incidents', 'https://bharag2.duckdns.org/api/v1/incidents', 'POST', 'header auth', 'BHARAG cluster',
    'All three error handlers — Bays, North Star and Research Twin', null),
  E('ep-bharag-ask', 'BHARAG cluster ask', 'https://bharag2.duckdns.org/api/v1/cluster/ask', 'POST', 'header auth', 'BHARAG cluster',
    'North Star and Research Twin tools routers', null),
  E('ep-genie-messages', 'Genie messages', 'https://genie-v3-migration-u82u.onrender.com/api/genie/messages', 'POST', null, 'Genie v3',
    'Bays — Tools Router (ask_genie)',
    'Repointed 16 Sep 2026 to the canonical Genie deployment. The host recorded before this never resolved.'),
  /* Added 2026-09-22 from the engine's own nodes and this server's code. */
  E('ep-dashboard-engine', 'Dashboard engine surface', 'https://bha-engine-dashboard.onrender.com/api/engine/:kind', 'POST', 'x-dashboard-key header (DASHBOARD_INBOUND_KEY)', 'BHA Engine Dashboard',
    'Every n8n workflow that used to read or write Airtable: posts (POST), looks up (GET) and part-updates (PATCH /:id and /by-natural/:id) each record kind',
    'Airtable was retired on 22 Sep 2026; these tables are the record. Every call, lookups and refusals included, is logged to engine_writes.'),
  E('ep-dashboard-repair', 'Dashboard repair record', 'https://bha-engine-dashboard.onrender.com/api/engine/repair', 'POST', 'x-dashboard-key header (DASHBOARD_INBOUND_KEY)', 'BHA Engine Dashboard',
    'The repair bridge, with each repair result', null),
  E('ep-dashboard-early-access', 'vFarm Early Access form', 'https://bha-engine-dashboard.onrender.com/api/public/vfarm-early-access', 'POST', 'none (public; origin-checked and rate-limited)', 'BHA Engine Dashboard',
    'The Early Access form on bhanetwork.org', 'The only public write route on the dashboard.'),
  E('ep-repair-bridge', 'Repair bridge', 'https://heal.bhanetwork.org/fix-workflow', 'POST', 'x-api-key header', 'bha-repair-bridge',
    'BHA — Self Healer, for failures routed to a Claude Code repair (schema_validation, unknown)', null),
  E('ep-repair-result', 'Self-healing result webhook', `${N8N}/webhook/repair-result`, 'POST', null, 'n8n Cloud',
    'BHA — Self Healer (a retry that recovered) and the repair bridge (a repair result)',
    'Received by BHA — Self Healer Reports, which posts to #bha-self-healing and closes the BHARAG incident when the result was a fix.'),
  E('ep-engine-heal', 'Engine heal webhook', `${N8N}/webhook/engine-heal`, 'POST', null, 'n8n Cloud',
    "This dashboard's Retry now button, through its server",
    'Owned by BHA — Self Healer since 22 Sep, when the webhook moved there from Engine — Self-Healing Retry (archived in n8n).'),
  E('ep-bharag-incident-status', 'BHARAG incident status', 'https://bharag2.duckdns.org/api/v1/incidents/:entity_id/status', 'POST', 'x-api-key header (one key per lane)', 'BHARAG cluster',
    "The error handlers (open → retrying), BHA — Self Healer Reports (→ self_healed), and this dashboard's Engine health close (→ manually_resolved)",
    'The only route that moves an incident between states. A terminal state has no transition out of it.'),
  E('ep-n8n-api', 'n8n public API', `${N8N}/api/v1`, 'GET', 'X-N8N-API-KEY header', 'n8n Cloud',
    "This dashboard's server (executions, workflow names, the repair revert) and BHA — Self Healer (execution reads and retries)", null),
];

/**
 * Airtable bases. Shown beside the endpoints, because they are the other set
 * of addresses the engine talks to rather than something anyone bills for.
 */
const B = (id: string, name: string, what_it_is_for: string | null, notes: string | null = null): SeedRow =>
  ({ id, name, what_it_is_for, url: `https://airtable.com/${id}`, notes });

export const AIRTABLE_BASES: SeedRow[] = [
  B('appUVlBSGGPHw6DGh', 'Open Loops', 'Every open loop, one table per builder.', 'The table a row sits in decides its owner, not the assignee field.'),
  B('appEmdKshNVTl64Zf', 'BHA Submissions & Logs', 'Codex entries and the Layer 0 completeness gate, one table per builder.', null),
  B('apprzpppxE2yV0q84', 'BHA Channel Tracking', 'One row per tracked Slack channel, pointing at its current capture doc.', null),
  B('appINvgEoZjuYQI2O', 'engine_events',
    'The error_counts table the three error handlers share, and digest_deliveries — the send-and-arrival record for the daily open-loops digest and the 3-day check-in.',
    'digest_deliveries (tblNuMju8l1kL3Sd1) was added on 13 Sep 2026. A row is written when a digest is handed to North Star and updated when the Callback Receiver posts it; status missing means the delivery check found one that never arrived.'),
  B('appvLglfdCqOKqLpT', 'BHA Commercial Opportunities', 'Commercial cards.', null),
  B('app5ni3E8r7Lvxk22', 'BHA Build Patterns', 'Reusable build patterns.', null),
  B('appMNvZsFRb9isRRq', 'Bays Tools Router', 'Lane Backlog and Deep Think Log.', null),
  /**
   * The twins' own ledgers (17 Sep 2026). Each twin finishes every run by
   * writing its row here, mirroring it to this dashboard and ingesting it into
   * BHARAG, so nothing finishes without being recorded.
   */
  /**
   * Two bases this server has read for days and the registry never listed
   * (added 18 Sep 2026). Nothing discovers a base: this list is seeded, so a
   * base reaches it only by being written down here. A base the engine reads
   * that is missing from the registry is the same failure as a base that
   * vanished from it — it reads as one that was never there.
   */
  B('appkSUSh9ijNjP2f8', 'BHA Client Research Loop',
    'The watched clients: the Index of lanes, the shared Client Requests table, and one questions table per lane.',
    'The Clients page renders what Index (tblFJ1yuYcuanjPdn) holds, never what tables exist in the base — each lane’s questions table is read from its own row’s Table ID, so adding a client is a row rather than a deploy, and a questions table no index row names is an orphan being deleted upstream. Client Requests (tblhu29KejAPQfSuy) arrived on 17 Sep 2026 and is one shared table for every client. Read only; nothing here writes to it.'),
  B('appwnt0mEtfwDtcN5', 'BHA Pay Ledger',
    'Who is owed money, for what work, and what has been paid: Builders, Sessions and Monthly Statements.',
    'Created 17 Sep 2026. Builders (tblS6WMJugqP8GJNa) is who is paid how, Sessions (tblPVfIicEiJ2uOYC) one row per approved session, Monthly Statements (tbl5iAdfhz91PZrUg) one per monthly builder per month. Kept in step with the approved logs by a sync every 30 minutes, and read here only when somebody presses Resync — two hops, which is why the Pay Tracker prints the ledger’s own age. Read only: paid status is set by the Slack card or by a statement closing, and a second way to change it is how records drift.'),
  B('appRvx4u9V9BYp646', 'BHA North Star Ledger', 'One row per question North Star is asked, and what it answered.',
    'Created 17 Sep 2026 with no history carried in, so October 2026 is the first clean month. Mirrored to this dashboard at POST /api/engine/ns-asks.'),
  B('appv39nQzmfC9VVkG', 'BHA Research Twin Ledger', 'One row per ask Research Twin receives, plus Research Jobs — the research queue, one row per job.',
    'Created 17 Sep 2026, no history carried in. Asks mirror to POST /api/engine/rt-asks; a job is updated in place and reaches this dashboard through the Resync from Airtable button on the Research Twin page.'),
  /**
   * `[LEGACY]` in Airtable and nothing writes to them. They are listed rather
   * than deleted because they still hold real history somebody may need to
   * read, and because a base that silently vanished from the registry would
   * look like a base that was never there.
   */
  B('appkCTjhH8PtYRFI7', '[LEGACY] NS Records', "North Star's old ask log, replaced by the North Star Ledger on 17 Sep 2026.", 'No writers. Read by nothing in this dashboard.'),
  B('appud969Dw7H4tMwv', '[LEGACY] Research Queue', "Research Twin's old attempt log — one row per attempt — replaced by Research Jobs on 17 Sep 2026.", 'No writers. Read by nothing in this dashboard.'),
  B('app4QnMJ2woiKlLc0', '[LEGACY] Research Queue Resolved Events', 'The outcome table that sat beside the old attempt log.', 'No writers. A job now carries its own outcome, so there is nothing for a second table to hold.'),
  B('appSoakKvs7MLkRnX', '[LEGACY] Priority ledger', 'Lane priority evidence North Star used to read.', 'No writers. The claimed priority is on the ask itself now.'),
  B('appxkIgnLL1zBsXqD', '[LEGACY] Lane_status', 'Per-lane state North Star read alongside the priority ledger.', 'No writers.'),
];

/** People. Slack ids as supplied, cross-checked against the live workflows. */
const P = (id: string, name: string, slack_user_id: string | null, email: string | null, role: string | null, lanes_owned: string[], notes: string | null = null): SeedRow =>
  ({ id, name, slack_user_id, email, role, lanes_owned, notes });

/**
 * Work addresses, not personal ones (2026-09-16, Destiny). A live database
 * already holds these rows, and `seedRegistry` inserts `ON CONFLICT (id) DO
 * NOTHING`, so this list only ever reaches a fresh one — migration 12 is what
 * carries the same addresses to the databases that already exist.
 */
export const PEOPLE: SeedRow[] = [
  P('jason', 'Jason Bays', 'U0A9V97949F', 'jason@bhanetwork.org', 'Founder / Principal', ['CEO']),
  P('destiny', 'Destiny Arupi', 'U0AEW3TBYH1', 'destiny@bhanetwork.org', 'Engine Steward', ['RT', 'NS', 'BAYS']),
  P('jegan', 'Jeganathan', 'U0AF011R821', 'jegan@bhanetwork.org', 'Infrastructure / BHARAG', ['VFARM_HARDWARE']),
  P('kaiqi', 'Kaiqi Yang', 'U0AD1V1D65N', 'kaiqi@bhanetwork.org', 'Genie / RSS / infra', ['GENIE']),
  P('ahad', 'Ahad', 'U0AC6RFNP3P', 'ahad@bhanetwork.org', 'CS Twin', ['CST']),
  P('hardik', 'Hardik Bhatt', 'U0BKT6MAW2Y', 'hardik@bhanetwork.org', 'Media Twin / vFarm funnel', ['MEDIA', 'CAD_API'],
    'Bays — Message Capture carries a different Slack id for Hardik (U0AEYQ6QB1B). The Daily Open Loops Sweep and the North Star Tools Router both agree on U0BKT6MAW2Y, so Message Capture is probably the wrong one — confirm before re-enabling that branch.'),
  P('kavin', 'Kavin G N', 'U0BNQGG020Y', 'kavin@bhanetwork.org', 'vFarm / kiosk', ['KIOSK']),
];
