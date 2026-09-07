/**
 * Phase 1 fixtures.
 *
 * Everything here is invented, but invented to be internally consistent: the
 * headline numbers on Overview are derived from these rows rather than typed
 * separately, and the lane / subsystem / builder vocabularies match the live
 * engine. When the endpoint lands, this file goes and only src/data/index.ts
 * changes shape.
 *
 * Reference date for every relative figure below: 2026-09-07.
 */

import type {
  AskRecord,
  Builder,
  BuildPattern,
  ChatThread,
  CodexEntry,
  GapRecord,
  Incident,
  LifecycleEvent,
  Loop,
  Opportunity,
  ProposedClose,
  ReconciliationRow,
  RunRecord,
  SensorReading,
  Source,
  TransitionRecord,
  VFarmAlert,
} from './types';

export const TODAY = '2026-09-07';
export const HALLOWEEN = '2026-10-31';

export const BUILDER_NAMES: Record<string, string> = {
  destiny: 'Destiny',
  jason: 'Jason',
  jegan: 'Jegan',
  kaiqi: 'Kaiqi',
  ahad: 'Ahad',
  hardik: 'Hardik',
  kavin: 'Kavin',
};

const slack = (ref: string, channel: string): Source => ({
  kind: 'slack',
  ref,
  url: `https://bayshorizonnetwork.slack.com/archives/${channel}/p${ref}`,
});

const airtable = (ref: string, table: string): Source => ({
  kind: 'airtable',
  ref,
  url: `https://airtable.com/appUVlBSGGPHw6DGh/${table}/${ref}`,
});

const n8n = (ref: string): Source => ({
  kind: 'n8n',
  ref,
  url: `https://n8n.arupiautomates.cloud/workflow/executions/${ref}`,
});

export const sources = { slack, airtable, n8n };

/* ---------------------------------------------------------------- loops */

type LoopSeed = [
  id: string,
  title: string,
  owner: keyof typeof BUILDER_NAMES,
  status: Loop['status'],
  age: number,
  raised: string,
  lane: Loop['lane'],
];

const LOOP_SEEDS: LoopSeed[] = [
  ['LOOP-1785849612044-QVNV', 'Write the four v1 lane contracts as one versioned Codex entry', 'destiny', 'in progress', 34, '2026-08-04', 'ENGINE_INTERNAL'],
  ['LOOP-1785851330871-T2OC', 'Stand up structured twin-hop telemetry across RT and NS callbacks', 'destiny', 'in progress', 34, '2026-08-04', 'ENGINE_INTERNAL'],
  ['LOOP-1785936004192-8YKV', 'Assign an owner to vFarm burn-in discipline', 'jegan', 'open', 33, '2026-08-05', 'VFARM_CORE'],
  ['LOOP-1786021884503-3NI1', 'Lock cabinet, waste path and pollination spec in writing', 'jegan', 'open', 32, '2026-08-06', 'VFARM_CORE'],
  ['LOOP-1786108271330-2VTW', 'Authorise a Stripe or PayPal account for founding-buyer money', 'hardik', 'open', 31, '2026-08-07', 'VFARM_MEDIA'],
  ['LOOP-1786108290117-K1V3', 'Ship the v0.1 subscription link and mechanics one-pager', 'hardik', 'in progress', 31, '2026-08-07', 'VFARM_MEDIA'],
  ['LOOP-1786194669318-ZMPB', 'Re-confirm every DRAFT measurement against the real rig before tooling', 'jegan', 'open', 30, '2026-08-08', 'VFARM_CORE'],
  ['LOOP-1786281041225-LW0Q', 'Lock the Research Twin lane contract against the shared schema', 'destiny', 'open', 29, '2026-08-09', 'ENGINE_INTERNAL'],
  ['LOOP-1786281102884-0J7S', 'Lock the North Star lane contract against the shared schema', 'destiny', 'open', 29, '2026-08-09', 'ENGINE_INTERNAL'],
  ['LOOP-1786367445901-GX0U', 'Decide camera hardware and white-light capture window for Vision', 'jegan', 'open', 28, '2026-08-10', 'VFARM_CORE'],
  ['LOOP-1786453819664-44N9', 'Publish the early-access offer Media Twin can point at', 'hardik', 'open', 27, '2026-08-11', 'VFARM_MEDIA'],
  ['LOOP-1786540233107-GC8B', 'Finish the per-builder Open Loops migration and verify row counts', 'destiny', 'open', 26, '2026-08-12', 'ENGINE_INTERNAL'],
  ['LOOP-1786540298471-ZHHA', 'Write the founding-buyer FAQ before the subscription page goes live', 'hardik', 'open', 26, '2026-08-12', 'VFARM_MEDIA'],
  ['LOOP-1786626688230-LILY', 'Define what "ready" exposes on /clusters/:id/readiness', 'jegan', 'open', 25, '2026-08-13', 'VFARM_CORE'],
  ['LOOP-1786713044998-3U6S', 'Size inference for the vision pipeline against the real frame rate', 'kavin', 'open', 24, '2026-08-14', 'VFARM_CORE'],
  ['LOOP-1786799471183-E3LE', 'Answer the founder-lane question: core architecture or narrower lane', 'kaiqi', 'open', 23, '2026-08-15', 'ENGINE_INTERNAL'],
  ['LOOP-1786885900326-2NLZ', 'Document the Genie to North Star hop as the canonical twin-hop pattern', 'kaiqi', 'open', 22, '2026-08-16', 'ENGINE_INTERNAL'],
  ['LOOP-1786972314775-82YL', 'Run live Slack smoke tests on RT and NS callback routes', 'kaiqi', 'open', 21, '2026-08-17', 'ENGINE_INTERNAL'],
  ['LOOP-1786972380044-RB4K', 'Reconcile the 2-vs-3 loop cap across NS, RT and Logstream', 'jason', 'open', 21, '2026-08-17', 'ENGINE_INTERNAL'],
  ['LOOP-1787058744219-WNEM', 'Confirm bha.engine_error.v1 as the canonical signed-off envelope', 'destiny', 'open', 20, '2026-08-18', 'ENGINE_INTERNAL'],
  ['LOOP-1787145160882-P7QD', 'Move the RT and NS external-ask keys out of code nodes', 'destiny', 'open', 19, '2026-08-19', 'ENGINE_INTERNAL'],
  ['LOOP-1787145221007-8KCM', 'Draft the client-report template for watched clients', 'ahad', 'open', 19, '2026-08-19', 'CLIENT_CORE'],
  ['LOOP-1787231602558-4TWL', 'Decide whether Client 12 stays on the weekly clock', 'ahad', 'open', 18, '2026-08-20', 'CLIENT_CORE'],
  ['LOOP-1787318033411-M2XA', 'Generalise the observability checklist past the pump slice', 'destiny', 'open', 17, '2026-08-21', 'ENGINE_INTERNAL'],
  ['LOOP-1787404477190-9DVR', 'Name how RT marks a finding commercially relevant', 'destiny', 'open', 16, '2026-08-22', 'ENGINE_INTERNAL'],
  ['LOOP-1787490881044-VN3E', 'Spec the write path for vfarm.incident.v1', 'jegan', 'open', 15, '2026-08-23', 'VFARM_CORE'],
  ['LOOP-1787577290663-QT6B', 'Wire Bays — Tools Router to the error workflow by hand', 'destiny', 'open', 14, '2026-08-24', 'ENGINE_INTERNAL'],
  ['LOOP-1787663711928-HB1S', 'Agree the ambient range wording for the v1 contracts copy', 'hardik', 'open', 13, '2026-08-25', 'VFARM_MEDIA'],
  ['LOOP-1787750104337-5RJP', 'Cap Research Queue retries at three and stop the continuous sweep', 'kaiqi', 'open', 12, '2026-08-26', 'ENGINE_INTERNAL'],
  ['LOOP-1787750188556-KD0W', 'Pick the crop-profile agronomist rather than guessing thresholds', 'kavin', 'open', 12, '2026-08-26', 'VFARM_CORE'],
  ['LOOP-1787836542119-XA7T', 'Decide the fifth Logstream checkpoint for vFarm', 'jason', 'open', 11, '2026-08-27', 'ENGINE_INTERNAL'],
  ['LOOP-1787922961803-JJ2N', 'Close the alert-to-incident seam for sensor_silence', 'jegan', 'open', 10, '2026-08-28', 'VFARM_CORE'],
  ['LOOP-1788009377442-C4LB', 'Rewrite the Codex digest so a green publish cannot hide an empty write', 'destiny', 'open', 9, '2026-08-29', 'ENGINE_INTERNAL'],
  ['LOOP-1788095788015-TR9M', 'Add a degraded branch to every BHARAG call in Bays', 'destiny', 'open', 8, '2026-08-30', 'ENGINE_INTERNAL'],
  ['LOOP-1788095844290-6WQF', 'Draft BP-INFRA-003 for upstream quota exhaustion', 'kaiqi', 'open', 8, '2026-08-30', 'ENGINE_INTERNAL'],
  ['LOOP-1788182201664-YH5D', 'Get founding-buyer copy reviewed before the render drops', 'hardik', 'open', 7, '2026-08-31', 'VFARM_MEDIA'],
  ['LOOP-1788268618937-N8ZK', 'Reconcile Client 9 contradiction state after the weekly clock run', 'ahad', 'open', 6, '2026-09-01', 'CLIENT_CORE'],
  ['LOOP-1788355033118-1PVC', 'Rotate the North Star credential that sat dead for 26 hours', 'destiny', 'open', 5, '2026-09-02', 'ENGINE_INTERNAL'],
  ['LOOP-1788441449776-3GBX', 'Add COMPLETED and REJECTED_POLICY to the Logstream vocabulary', 'jason', 'open', 4, '2026-09-03', 'ENGINE_INTERNAL'],
  ['LOOP-1788527866214-D0MT', 'Persist codex_entry_id across all six builder tables', 'destiny', 'open', 3, '2026-09-04', 'ENGINE_INTERNAL'],
  ['LOOP-1788614280558-7FQA', 'Fix the Genie callback verifier failing closed on unset fields', 'destiny', 'open', 2, '2026-09-05', 'ENGINE_INTERNAL'],
  ['LOOP-1788614341882-B2LE', 'Repair the misrouted rows from the Open Loops migration', 'destiny', 'open', 2, '2026-09-05', 'ENGINE_INTERNAL'],
  ['LOOP-1788700702445-5MSK', 'Confirm nothing was lost in the Sept 5 loop reassignment', 'kaiqi', 'open', 1, '2026-09-06', 'ENGINE_INTERNAL'],
  ['LOOP-1788700771019-W9XJ', 'Decide the vision capture cadence against storage budget', 'kavin', 'open', 1, '2026-09-06', 'VFARM_CORE'],
  ['LOOP-1788787118330-A6RT', 'Reconcile Kaiqi digest count against his own loops table', 'destiny', 'open', 0, '2026-09-07', 'ENGINE_INTERNAL'],
  ['LOOP-1788787204611-K3ND', 'Point the readiness panel at a real endpoint once one exists', 'jegan', 'open', 0, '2026-09-07', 'VFARM_CORE'],
];

const SUBSYSTEM_BY_LANE: Record<Loop['lane'], Loop['spine']['subsystem']> = {
  VFARM_CORE: 'VFARM',
  VFARM_MEDIA: 'COMMERCIALOPPS',
  CLIENT_CORE: 'RESEARCHTWIN',
  ENGINE_INTERNAL: 'AGENT',
};

export const LOOPS: Loop[] = LOOP_SEEDS.map(
  ([id, title, owner, status, age, raised, lane], i) => ({
    id,
    title,
    owner,
    status,
    age_days: age,
    raised_at: raised,
    lane,
    spine: {
      session_id: `SES-${raised.replace(/-/g, '')}-${owner.slice(0, 2).toUpperCase()}-${String((i % 6) + 1).padStart(2, '0')}`,
      builder_id: owner,
      subsystem: SUBSYSTEM_BY_LANE[lane],
      lane,
    },
    tags: {
      pay_eligible: i % 5 === 0,
      is_incident: id === 'LOOP-1788355033118-1PVC' || id === 'LOOP-1788614280558-7FQA',
    },
    source: airtable(id, 'tblBJekl3ROpNZxQW'),
  }),
);

/** Per-owner totals. The listed rows are a sample; these are the real counts. */
export const LOOPS_BY_OWNER = [
  { owner: 'destiny', open: 96, in_progress: 2, oldest_days: 34 },
  { owner: 'jegan', open: 47, in_progress: 1, oldest_days: 33 },
  { owner: 'hardik', open: 38, in_progress: 1, oldest_days: 31 },
  { owner: 'kaiqi', open: 31, in_progress: 0, oldest_days: 23 },
  { owner: 'ahad', open: 22, in_progress: 0, oldest_days: 19 },
  { owner: 'jason', open: 18, in_progress: 0, oldest_days: 21 },
  { owner: 'kavin', open: 16, in_progress: 0, oldest_days: 24 },
];

export const REVIEW_QUEUE: ProposedClose[] = [
  {
    id: 'PC-01',
    loop_id: 'LOOP-1786281041225-LW0Q',
    title: 'Lock the Research Twin lane contract against the shared schema',
    owner: 'destiny',
    age_days: 29,
    reason: 'Superseded by the consolidated four-contract Codex entry raised Sept 6.',
    citation: {
      text: 'Logging it as one because it consolidates three loops already open on me asking for the same document in vaguer terms.',
      source: slack('1788700771019', 'C0AUKTND199'),
    },
  },
  {
    id: 'PC-02',
    loop_id: 'LOOP-1786281102884-0J7S',
    title: 'Lock the North Star lane contract against the shared schema',
    owner: 'destiny',
    age_days: 29,
    reason: 'Superseded by the same consolidated Codex entry.',
    citation: {
      text: 'Splitting it four ways would give me seven loops for one deliverable.',
      source: slack('1788700771020', 'C0AUKTND199'),
    },
  },
  {
    id: 'PC-03',
    loop_id: 'LOOP-1787577290663-QT6B',
    title: 'Wire Bays — Tools Router to the error workflow by hand',
    owner: 'destiny',
    age_days: 14,
    reason: 'Error workflow now resolves on the router; no failures have bypassed it in 9 days.',
    citation: {
      text: 'Bays — Tools Router still needs to be manually wired to this as its Error Workflow.',
      source: n8n('91744'),
    },
  },
  {
    id: 'PC-04',
    loop_id: 'LOOP-1786713044998-3U6S',
    title: 'Size inference for the vision pipeline against the real frame rate',
    owner: 'kavin',
    age_days: 24,
    reason: 'Inference sizing landed with the Vision subsystem spec on Sept 1.',
    citation: {
      text: 'Subsystem spec is done and posted. Today he is closing the remaining gaps: camera hardware choice, white-light capture window, inference sizing.',
      source: slack('1788255371000', 'C0A8Q2ZR4KP'),
    },
  },
];

export const RECONCILIATION: ReconciliationRow[] = [
  {
    id: 'RC-01',
    loop_id: 'LOOP-1786799471183-E3LE',
    title: 'Answer the founder-lane question: core architecture or narrower lane',
    expected_owner: 'kaiqi',
    found_in: 'destiny',
    discrepancy: 'Digest reported it against Kaiqi; the row sits in Destiny’s table.',
    source: airtable('LOOP-1786799471183-E3LE', 'tblBJekl3ROpNZxQW'),
  },
  {
    id: 'RC-02',
    loop_id: 'LOOP-1786885900326-2NLZ',
    title: 'Document the Genie to North Star hop as the canonical twin-hop pattern',
    expected_owner: 'kaiqi',
    found_in: null,
    discrepancy: 'Named in the Sept 7 digest. Present in no builder table.',
    source: slack('1788782418906549', 'C0ACC6D82AX'),
  },
  {
    id: 'RC-03',
    loop_id: 'LOOP-1786972314775-82YL',
    title: 'Run live Slack smoke tests on RT and NS callback routes',
    expected_owner: 'kaiqi',
    found_in: null,
    discrepancy: 'Named in the Sept 7 digest. Present in no builder table.',
    source: slack('1788782418906550', 'C0ACC6D82AX'),
  },
  {
    id: 'RC-04',
    loop_id: 'LOOP-1787145221007-8KCM',
    title: 'Draft the client-report template for watched clients',
    expected_owner: 'ahad',
    found_in: 'ahad, hardik',
    discrepancy: 'Row exists in two tables after the Sept 5 repair pass.',
    source: airtable('LOOP-1787145221007-8KCM', 'tbl3bTRcuUcbYXgDc'),
  },
];

/* ------------------------------------------------------------ incidents */

export const INCIDENTS: Incident[] = [
  {
    id: 'INC-8F2A41',
    opened_at: '2026-09-07 11:42',
    summary: 'Bays — Tools Router / ABC - Ask Cluster failing',
    workflow: 'Bays — Tools Router',
    failed_node: 'ABC - Ask Cluster',
    error_class: 'BILLING_QUOTA',
    state: 'escalated to human',
    health: 'failing',
    retries_attempted: 0,
    max_retries: 3,
    occurrences: 14,
    fingerprint: 'bays-tools-router::abc-ask-cluster::402',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'HTTP 500 wrapping an internal 402 from bharag2', at: '2026-09-07 11:42' },
      { action_type: 'retry', actor: 'error handler', outcome: 'skipped', reason: 'BILLING_QUOTA never auto-retries — credits must change first', at: '2026-09-07 11:42' },
      { action_type: 'escalate', actor: 'error handler', outcome: 'ok', reason: 'Tagged infra owner in #bha-pipeline-errors', at: '2026-09-07 11:43' },
    ],
    spine: { session_id: 'SES-20260907-DA-01', builder_id: 'destiny', subsystem: 'AGENT', lane: 'ENGINE_INTERNAL' },
    tags: { is_incident: true },
    source: n8n('92014'),
  },
  {
    id: 'INC-7C1B93',
    opened_at: '2026-09-07 09:15',
    summary: 'Research Twin — Tools Router / SWS - Call BHARAG failing',
    workflow: 'Research Twin — Tools Router',
    failed_node: 'SWS - Call BHARAG',
    error_class: 'NETWORK_TIMEOUT',
    state: 'auto-retry pending',
    health: 'degraded',
    retries_attempted: 2,
    max_retries: 3,
    occurrences: 6,
    fingerprint: 'rt-tools-router::sws-call-bharag::enotfound',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'ENOTFOUND bharag2.duckdns.org', at: '2026-09-07 09:15' },
      { action_type: 'retry', actor: 'error handler', outcome: 'failed', reason: 'Attempt 1 of 3 — same resolution failure', at: '2026-09-07 09:20' },
      { action_type: 'retry', actor: 'error handler', outcome: 'failed', reason: 'Attempt 2 of 3 — same resolution failure', at: '2026-09-07 09:25' },
    ],
    spine: { session_id: 'SES-20260907-DA-02', builder_id: 'destiny', subsystem: 'RESEARCHTWIN', lane: 'ENGINE_INTERNAL' },
    tags: { is_incident: true },
    source: n8n('91588'),
  },
  {
    id: 'INC-6D9E02',
    opened_at: '2026-09-06 22:04',
    summary: 'vFarm ledger batch ingest rejected on schema',
    workflow: 'BHA RAG Ingest Retry',
    failed_node: 'Batch Ingest',
    error_class: 'SCHEMA_VALIDATION',
    state: 'escalated to RT',
    health: 'degraded',
    retries_attempted: 1,
    max_retries: 3,
    occurrences: 3,
    fingerprint: 'rag-ingest-retry::batch-ingest::additionalproperties',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'incidents.v0 payload is strict — additionalProperties false', at: '2026-09-06 22:04' },
      { action_type: 'retry', actor: 'error handler', outcome: 'skipped', reason: 'SCHEMA_VALIDATION never auto-retries', at: '2026-09-06 22:04' },
      { action_type: 'escalate', actor: 'error handler', outcome: 'ok', reason: 'Routed to Research Twin for evidence on the field mismatch', at: '2026-09-06 22:06' },
    ],
    spine: { session_id: 'SES-20260906-JE-04', builder_id: 'jegan', subsystem: 'BHARAG', lane: 'VFARM_CORE' },
    tags: { is_incident: true },
    source: n8n('91902'),
  },
  {
    id: 'INC-5A3C77',
    opened_at: '2026-09-06 14:31',
    summary: 'North Star credential rejected on every execution',
    workflow: 'North Star — Tools Router',
    failed_node: 'Query_North_Star_Cluster',
    error_class: 'CONFIG_AUTH',
    state: 'resolved',
    health: 'ok',
    retries_attempted: 0,
    max_retries: 3,
    occurrences: 41,
    fingerprint: 'ns-tools-router::query-north-star-cluster::401',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'Credential expired 26 hours before detection', at: '2026-09-06 14:31' },
      { action_type: 'retry', actor: 'error handler', outcome: 'skipped', reason: 'CONFIG_AUTH never auto-retries', at: '2026-09-06 14:31' },
      { action_type: 'rotate credential', actor: 'destiny', outcome: 'ok', reason: 'Rotated by hand; next execution green', at: '2026-09-06 18:02' },
    ],
    spine: { session_id: 'SES-20260906-DA-03', builder_id: 'destiny', subsystem: 'NORTHSTAR', lane: 'ENGINE_INTERNAL' },
    tags: { is_incident: true },
    source: n8n('91744'),
  },
  {
    id: 'INC-4B8D15',
    opened_at: '2026-09-06 08:12',
    summary: 'Bays — Daily Digests posted an empty digest',
    workflow: 'Bays — Daily Digests',
    failed_node: 'Assert Digest Slack OK',
    error_class: 'SCHEMA_VALIDATION',
    state: 'resolved',
    health: 'ok',
    retries_attempted: 1,
    max_retries: 3,
    occurrences: 6,
    fingerprint: 'bays-daily-digests::assert-digest-slack-ok::empty',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'Assertion caught a 200 carrying no blocks', at: '2026-09-06 08:12' },
      { action_type: 'retry', actor: 'error handler', outcome: 'ok', reason: 'Second render produced blocks; posted', at: '2026-09-06 08:17' },
    ],
    spine: { session_id: 'SES-20260906-DA-01', builder_id: 'destiny', subsystem: 'CODEX', lane: 'ENGINE_INTERNAL' },
    tags: { is_incident: true, self_healed: true },
    source: n8n('91655'),
  },
  {
    id: 'INC-3E7F60',
    opened_at: '2026-09-05 19:48',
    summary: 'Research Twin job write rejected on renamed field',
    workflow: 'Research Twin — Tools Router',
    failed_node: 'QFR - Write Queue Rows',
    error_class: 'SCHEMA_VALIDATION',
    state: 'resolved',
    health: 'ok',
    retries_attempted: 0,
    max_retries: 3,
    occurrences: 9,
    fingerprint: 'rt-tools-router::qfr-write-queue-rows::unknown-field',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'Airtable rejected card_id — field renamed to trace_id', at: '2026-09-05 19:48' },
      { action_type: 'rename field', actor: 'destiny', outcome: 'ok', reason: 'Mapped card_id to trace_id at the write node', at: '2026-09-05 21:10' },
    ],
    spine: { session_id: 'SES-20260905-DA-02', builder_id: 'destiny', subsystem: 'RESEARCHTWIN', lane: 'ENGINE_INTERNAL' },
    tags: { is_incident: true },
    source: n8n('91143'),
  },
  {
    id: 'INC-2C6A38',
    opened_at: '2026-09-05 06:22',
    summary: 'Watched Clients weekly clock timed out on Client 9',
    workflow: 'Watched Clients — Weekly Clock',
    failed_node: 'Research Client',
    error_class: 'NETWORK_TIMEOUT',
    state: 'resolved',
    health: 'ok',
    retries_attempted: 1,
    max_retries: 3,
    occurrences: 2,
    fingerprint: 'watched-clients::research-client::timeout',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'Upstream cold start, 503', at: '2026-09-05 06:22' },
      { action_type: 'retry', actor: 'error handler', outcome: 'ok', reason: 'Attempt 1 of 3 succeeded after 5m', at: '2026-09-05 06:27' },
    ],
    spine: { session_id: 'SES-20260905-AH-01', builder_id: 'ahad', subsystem: 'RESEARCHTWIN', lane: 'CLIENT_CORE' },
    tags: { is_incident: true, self_healed: true },
    source: n8n('90988'),
  },
  {
    id: 'INC-1F5B24',
    opened_at: '2026-09-04 13:09',
    summary: 'Commercial extractor failed on an unparsable card body',
    workflow: 'Bays — Commercial & Pattern Extractors',
    failed_node: 'Comm Parse Card',
    error_class: 'UNKNOWN',
    state: 'failed',
    health: 'failing',
    retries_attempted: 3,
    max_retries: 3,
    occurrences: 5,
    fingerprint: 'commercial-extractors::comm-parse-card::unknown',
    actions: [
      { action_type: 'classify', actor: 'error handler', outcome: 'ok', reason: 'Classifier returned unknown; no fix lane derived', at: '2026-09-04 13:09' },
      { action_type: 'retry', actor: 'error handler', outcome: 'failed', reason: 'Attempt 3 of 3 — retry ceiling reached', at: '2026-09-04 13:24' },
      { action_type: 'escalate', actor: 'error handler', outcome: 'ok', reason: 'Retry ceiling reached, handed to a human', at: '2026-09-04 13:25' },
    ],
    spine: { session_id: 'SES-20260904-HB-02', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' },
    tags: { is_incident: true },
    source: n8n('90712'),
  },
];

/* ---------------------------------------------------- north star / rt */

const askSpine = (
  builder: string,
  lane: AskRecord['spine']['lane'],
  subsystem: AskRecord['spine']['subsystem'],
  n: number,
): AskRecord['spine'] => ({
  session_id: `SES-2026090${(n % 7) + 1}-${builder.slice(0, 2).toUpperCase()}-0${(n % 5) + 1}`,
  builder_id: builder,
  subsystem,
  lane,
});

type AskSeed = [q: string, by: string, cycle: number, out: AskRecord['outcome'], lane: AskRecord['spine']['lane'], at: string];

const NS_ASK_SEEDS: AskSeed[] = [
  ['What are the top build lanes right now?', 'jason', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-07 09:02'],
  ['Where should the Architect’s attention go this week?', 'jason', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-07 08:41'],
  ['Which loops block v1 telemetry wiring?', 'destiny', 2, 'answered', 'ENGINE_INTERNAL', '2026-09-06 22:48'],
  ['What are the top commercial opportunities?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-09-06 17:20'],
  ['Is the vFarm lane over capacity this week?', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-09-06 15:55'],
  ['Which lane owns the ledger schema break?', 'jegan', 1, 'thin', 'VFARM_CORE', '2026-09-06 14:30'],
  ['Rank the open loops on Kaiqi by blocking weight', 'kaiqi', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-06 13:00'],
  ['What moved on the commercial front door this week?', 'hardik', 1, 'thin', 'VFARM_MEDIA', '2026-09-06 11:12'],
  ['Should burn-in block the Halloween render?', 'jason', 2, 'answered', 'VFARM_CORE', '2026-09-05 20:04'],
  ['What is the primary bottleneck across lanes?', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-05 18:33'],
  ['Which client lane is closest to a decision?', 'ahad', 1, 'thin', 'CLIENT_CORE', '2026-09-05 16:47'],
  ['What are the top build lanes right now?', 'kavin', 1, 'failed', 'VFARM_CORE', '2026-09-05 14:02'],
  ['Where is capacity stress highest?', 'jason', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-05 10:19'],
  ['Which opportunities are ready to pitch?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-09-04 19:30'],
  ['Does the vision spec change lane ranking?', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-09-04 15:41'],
  ['What should Ahad pick up next?', 'ahad', 1, 'answered', 'CLIENT_CORE', '2026-09-04 12:08'],
  ['Rank engine-internal work against vFarm work', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-04 09:55'],
  ['Which loops are superseded by the contract entry?', 'destiny', 2, 'answered', 'ENGINE_INTERNAL', '2026-09-03 21:14'],
  ['What are the top commercial opportunities?', 'jason', 1, 'answered', 'VFARM_MEDIA', '2026-09-03 17:02'],
  ['Is Kavin blocked on the agronomist decision?', 'kavin', 1, 'thin', 'VFARM_CORE', '2026-09-03 13:26'],
  ['Where should attention go before the render?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-09-02 19:48'],
  ['Which lane owns credential rotation?', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-02 16:12'],
  ['What changed in the priority ledger this week?', 'jason', 1, 'failed', 'ENGINE_INTERNAL', '2026-09-02 11:05'],
  ['Rank the client lane against vFarm media', 'ahad', 1, 'answered', 'CLIENT_CORE', '2026-09-01 18:39'],
  ['Which build patterns apply to the ingest break?', 'kaiqi', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-01 14:51'],
  ['What are the top build lanes right now?', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-09-01 09:20'],
  ['Is there capacity for another builder on vFarm?', 'jason', 1, 'answered', 'VFARM_CORE', '2026-08-31 20:15'],
  ['Which loops did nobody touch this week?', 'destiny', 1, 'thin', 'ENGINE_INTERNAL', '2026-08-31 17:44'],
  ['What is blocking the subscription front door?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-08-31 12:30'],
  ['Rank incidents by commercial risk', 'jason', 1, 'answered', 'ENGINE_INTERNAL', '2026-08-30 19:07'],
  ['Where should Jegan spend Monday?', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-08-30 15:22'],
  ['Which lanes hit their retry ceiling?', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-08-30 10:41'],
];

const RT_ASK_SEEDS: AskSeed[] = [
  ['Does the ledger carry pH by place for the last 24h?', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-09-07 10:30'],
  ['What does Client 9 currently contradict?', 'ahad', 2, 'answered', 'CLIENT_CORE', '2026-09-07 08:12'],
  ['Is there prior evidence on tipburn thresholds?', 'kavin', 1, 'thin', 'VFARM_CORE', '2026-09-06 19:44'],
  ['What did we conclude about ebb and flow drain timing?', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-09-06 16:20'],
  ['Find prior art on white-light capture windows', 'kavin', 3, 'thin', 'VFARM_CORE', '2026-09-06 14:02'],
  ['What evidence backs the 18–26°C ambient range?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-09-06 11:38'],
  ['Has Client 12 moved since the last clock run?', 'ahad', 1, 'answered', 'CLIENT_CORE', '2026-09-06 09:15'],
  ['What is the known cause for ENOTFOUND on bharag2?', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-05 22:51'],
  ['Any prior incident matching this fingerprint?', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-05 20:33'],
  ['What do we know about strawberry pollination cadence?', 'jegan', 2, 'thin', 'VFARM_CORE', '2026-09-05 17:09'],
  ['Research the founding-buyer objection set', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-09-05 13:44'],
  ['Is there evidence the digest ran empty before Sept 1?', 'destiny', 1, 'failed', 'ENGINE_INTERNAL', '2026-09-05 10:02'],
  ['What did Client 2 ask for in the last memo?', 'ahad', 1, 'answered', 'CLIENT_CORE', '2026-09-04 18:27'],
  ['Prior art on vertical-farm waste cassettes', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-09-04 15:03'],
  ['What evidence supports the 3-retry standard?', 'destiny', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-04 11:41'],
  ['Does anything contradict the 8x4x8 footprint?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-09-03 20:16'],
  ['Find the last measured humidity range in rack A', 'kavin', 1, 'answered', 'VFARM_CORE', '2026-09-03 16:50'],
  ['What is our evidence on managed-monitoring pricing?', 'hardik', 2, 'thin', 'VFARM_MEDIA', '2026-09-03 12:22'],
  ['Any prior finding on OpenRouter credit exhaustion?', 'kaiqi', 1, 'answered', 'ENGINE_INTERNAL', '2026-09-02 19:05'],
  ['Research the Client 12 competitive position', 'ahad', 1, 'answered', 'CLIENT_CORE', '2026-09-02 14:38'],
  ['What did burn-in v0 actually measure?', 'jegan', 1, 'failed', 'VFARM_CORE', '2026-09-02 10:11'],
  ['Evidence for the single-fill multi-drain choice', 'kavin', 1, 'answered', 'VFARM_CORE', '2026-09-01 17:29'],
  ['Is the sensor rollup cadence documented anywhere?', 'destiny', 1, 'thin', 'ENGINE_INTERNAL', '2026-09-01 13:06'],
  ['What do we hold on early-buyer install environments?', 'hardik', 1, 'answered', 'VFARM_MEDIA', '2026-08-31 19:52'],
  ['Prior findings on alert-to-incident dedup', 'jegan', 1, 'answered', 'VFARM_CORE', '2026-08-31 15:14'],
  ['Research contradiction state for the watched set', 'ahad', 1, 'answered', 'CLIENT_CORE', '2026-08-31 11:40'],
  ['What evidence exists on kiosk render safety?', 'hardik', 1, 'thin', 'VFARM_MEDIA', '2026-08-30 18:22'],
  ['Any prior art on append-only derivation ledgers?', 'kaiqi', 1, 'answered', 'ENGINE_INTERNAL', '2026-08-30 14:07'],
];

const SUB_BY_TWIN = { 'North Star': 'NORTHSTAR', 'Research Twin': 'RESEARCHTWIN' } as const;

function buildAsks(seeds: AskSeed[], twin: keyof typeof SUB_BY_TWIN, prefix: string): AskRecord[] {
  return seeds.map(([question, by, cycle, outcome, lane, at], i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    question,
    asked_by: by,
    cycle,
    outcome,
    // Only a minority of records carry it — the field is not reliably written yet.
    evidence_shape_version: outcome === 'answered' && i % 4 === 0 ? 'evidence.v1' : null,
    at,
    spine: askSpine(by, lane, SUB_BY_TWIN[twin], i),
    tags: { pay_eligible: outcome === 'answered' && i % 6 === 0 },
    source: n8n(String(91000 + i * 7)),
  }));
}

export const NS_RECORDS = buildAsks(NS_ASK_SEEDS, 'North Star', 'NSA');
export const RT_RECORDS = buildAsks(RT_ASK_SEEDS, 'Research Twin', 'RTA');

/* ------------------------------------------------------- runs and gaps */

function buildRuns(records: AskRecord[], toolset: string[], prefix: string): RunRecord[] {
  return records.slice(0, 22).map((r, i) => {
    const searches = toolset.map((tool, j) => {
      const empty = (i + j) % 5 === 0;
      return { tool, returned: empty ? 0 : ((i * 3 + j * 7) % 9) + 1, empty };
    });
    const ended: RunRecord['ended'] =
      r.outcome === 'failed' ? 'error' : r.outcome === 'thin' ? (r.cycle >= 3 ? 'quarantined' : 'looping') : 'logged';
    const end_detail =
      ended === 'error'
        ? 'Upstream returned a degraded result; incident opened rather than reporting nothing found.'
        : ended === 'quarantined'
          ? 'Three cycles with no narrowing evidence — stopped and escalated to a human.'
          : ended === 'looping'
            ? 'Evidence thin; queued a narrower follow-up rather than repeating the same check.'
            : 'Evidence clear and a known fix existed; written back and logged.';
    return {
      id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
      ask_id: r.id,
      question: r.question,
      started_at: r.at,
      searches,
      ended,
      end_detail,
      spine: r.spine,
      source: r.source,
    };
  });
}

export const NS_RUNS = buildRuns(
  NS_RECORDS,
  ['Get_Priority_Evidence', 'Query_North_Star_Cluster', 'Get_Capacity_Status'],
  'NSR',
);

export const RT_RUNS = buildRuns(
  RT_RECORDS,
  ['search_workspace', 'read_research_queue', 'compute_lane_state'],
  'RTR',
);

function buildGaps(records: AskRecord[], prefix: string): GapRecord[] {
  return records
    .filter((r) => r.outcome === 'thin' || r.outcome === 'failed')
    .map((r, i) => ({
      id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
      question: r.question,
      reason: r.outcome === 'failed' ? ('empty' as const) : ('thin' as const),
      cycles: r.cycle,
      first_seen: r.at,
      spine: r.spine,
      source: r.source,
    }));
}

export const NS_GAPS = buildGaps(NS_RECORDS, 'NSG');
export const RT_GAPS = buildGaps(RT_RECORDS, 'RTG');

export const RT_TRANSITIONS: TransitionRecord[] = [
  {
    id: 'RTT-001',
    question: 'What evidence backs the 18–26°C ambient range?',
    went_thin_at: '2026-09-02 14:20',
    answered_at: '2026-09-06 11:38',
    cycles: 2,
    spine: { session_id: 'SES-20260906-HB-03', builder_id: 'hardik', subsystem: 'RESEARCHTWIN', lane: 'VFARM_MEDIA' },
    source: n8n('91480'),
  },
  {
    id: 'RTT-002',
    question: 'What did we conclude about ebb and flow drain timing?',
    went_thin_at: '2026-08-30 09:05',
    answered_at: '2026-09-06 16:20',
    cycles: 3,
    spine: { session_id: 'SES-20260906-JE-02', builder_id: 'jegan', subsystem: 'RESEARCHTWIN', lane: 'VFARM_CORE' },
    source: n8n('91512'),
  },
  {
    id: 'RTT-003',
    question: 'Prior art on vertical-farm waste cassettes',
    went_thin_at: '2026-08-28 16:41',
    answered_at: '2026-09-04 15:03',
    cycles: 2,
    spine: { session_id: 'SES-20260904-JE-01', builder_id: 'jegan', subsystem: 'RESEARCHTWIN', lane: 'VFARM_CORE' },
    source: n8n('90840'),
  },
];

/* ----------------------------------------------------------------- vfarm */

const PLACES = ['rack-a/tier-1', 'rack-a/tier-2', 'rack-a/tier-3', 'bench/burn-in'];

export const VFARM_READINGS: SensorReading[] = Array.from({ length: 48 }, (_, i) => {
  const place = PLACES[i % PLACES.length];
  const minutesAgo = i * 3;
  const hh = 14 - Math.floor(minutesAgo / 60);
  const mm = 12 - (minutesAgo % 60);
  const at = `2026-09-07 ${String(hh + (mm < 0 ? -1 : 0)).padStart(2, '0')}:${String((mm + 60) % 60).padStart(2, '0')}`;
  // The burn-in bench has no pH probe fitted. That reads as null, not zero.
  const isBench = place === 'bench/burn-in';
  const ph = isBench ? null : Number((5.8 + ((i * 7) % 11) / 20).toFixed(2));
  const temp = Number((20.4 + ((i * 5) % 13) / 5).toFixed(1));
  const hum = Number((58 + ((i * 3) % 17)).toFixed(0));
  const health: SensorReading['health'] =
    ph !== null && ph > 6.25 ? 'degraded' : temp > 22.6 ? 'degraded' : 'ok';
  return {
    id: `RD-${String(i + 1).padStart(3, '0')}`,
    at,
    place,
    ph,
    temp_c: temp,
    humidity_pct: hum,
    health,
    source: n8n(String(92100 + i)),
  };
});

export const VFARM_ALERTS: VFarmAlert[] = [
  {
    id: 'AL-014',
    at: '2026-09-07 13:48',
    place: 'rack-a/tier-3',
    kind: 'ph_out_of_band',
    detail: 'pH 6.31 held above the 6.25 ceiling across three consecutive rollups.',
    health: 'degraded',
    state: 'open',
    closed_at: null,
    spine: { session_id: 'SES-20260907-JE-01', builder_id: 'jegan', subsystem: 'VFARM', lane: 'VFARM_CORE' },
    source: n8n('92140'),
  },
  {
    id: 'AL-013',
    at: '2026-09-07 09:06',
    place: 'bench/burn-in',
    kind: 'temp_out_of_band',
    detail: 'Bench held 23.1°C for 21 minutes against a 22.6°C ceiling.',
    health: 'degraded',
    state: 'open',
    closed_at: null,
    spine: { session_id: 'SES-20260907-KV-01', builder_id: 'kavin', subsystem: 'VFARM', lane: 'VFARM_CORE' },
    source: n8n('92088'),
  },
  {
    id: 'AL-012',
    at: '2026-09-06 21:30',
    place: 'rack-a/tier-1',
    kind: 'sensor_silence',
    detail: 'Zero readings for 18 minutes. Not bad readings — none at all.',
    health: 'failing',
    state: 'closed',
    closed_at: '2026-09-06 22:04',
    spine: { session_id: 'SES-20260906-JE-03', builder_id: 'jegan', subsystem: 'VFARM', lane: 'VFARM_CORE' },
    source: n8n('91890'),
  },
  {
    id: 'AL-011',
    at: '2026-09-06 11:15',
    place: 'rack-a/tier-2',
    kind: 'humidity_out_of_band',
    detail: 'Humidity touched 76% against a 74% ceiling; recovered without intervention.',
    health: 'ok',
    state: 'closed',
    closed_at: '2026-09-06 11:33',
    spine: { session_id: 'SES-20260906-KV-02', builder_id: 'kavin', subsystem: 'VFARM', lane: 'VFARM_CORE' },
    source: n8n('91801'),
  },
  {
    id: 'AL-010',
    at: '2026-09-05 16:42',
    place: 'rack-a/tier-3',
    kind: 'ph_out_of_band',
    detail: 'pH 6.28 for two rollups after a top-up; settled on the third.',
    health: 'ok',
    state: 'closed',
    closed_at: '2026-09-05 16:51',
    spine: { session_id: 'SES-20260905-JE-02', builder_id: 'jegan', subsystem: 'VFARM', lane: 'VFARM_CORE' },
    source: n8n('91060'),
  },
];

export const VFARM_PLACES = [
  { name: 'rack-a/tier-1', last_seen: '2026-09-07 14:12', health: 'ok' as const },
  { name: 'rack-a/tier-2', last_seen: '2026-09-07 14:09', health: 'ok' as const },
  { name: 'rack-a/tier-3', last_seen: '2026-09-07 14:06', health: 'degraded' as const },
  { name: 'bench/burn-in', last_seen: '2026-09-07 14:03', health: 'degraded' as const },
];

/** Deliberately empty. Nothing emits these yet. */
export const VFARM_LIFECYCLE: LifecycleEvent[] = [];

/* ----------------------------------------------- codex / patterns / etc */

type CodexSeed = [builder: string, week: string, at: string, type: string, title: string, ingested: boolean];

const CODEX_SEEDS: CodexSeed[] = [
  ['destiny', '2026-W36', '2026-09-06 23:15', 'build', 'Codex entry id repair and first-class persistence', true],
  ['destiny', '2026-W36', '2026-09-05 22:40', 'build', 'Genie callback verifier fixed; six spine fields reaching the verifier', true],
  ['jegan', '2026-W36', '2026-09-05 19:02', 'build', 'Ledger and alert-ledger pushing through batch ingest', true],
  ['hardik', '2026-W36', '2026-09-05 17:51', 'design', 'Founding-buyer funnel copy, second pass', false],
  ['kaiqi', '2026-W36', '2026-09-05 14:25', 'build', 'Latenode MCP array-query normalisation', true],
  ['kavin', '2026-W36', '2026-09-04 20:18', 'research', 'Frame rate and storage budget for vision capture', false],
  ['ahad', '2026-W36', '2026-09-04 16:44', 'research', 'Client 9 contradiction pass', true],
  ['jason', '2026-W36', '2026-09-04 12:30', 'review', 'Logstream vocabulary review — COMPLETED and REJECTED_POLICY', true],
  ['destiny', '2026-W36', '2026-09-04 09:12', 'build', 'Degraded branch proven on a forced BHARAG failure', true],
  ['jegan', '2026-W36', '2026-09-03 18:37', 'build', 'Subsystem registry live; phantom incident lanes blocked', true],
  ['hardik', '2026-W36', '2026-09-03 11:20', 'design', 'Render-safe boundary applied to the October assets', false],
  ['destiny', '2026-W35', '2026-09-02 21:05', 'build', 'Error taxonomy codified as BP-INFRA-001', true],
  ['kaiqi', '2026-W35', '2026-09-02 15:48', 'build', 'Upstream quota exhaustion pattern drafted', true],
  ['jegan', '2026-W35', '2026-09-01 19:22', 'build', 'Canon ledger and key rotation deployed', true],
  ['ahad', '2026-W35', '2026-09-01 13:10', 'research', 'Watched clients weekly clock, three memos posted', true],
  ['kavin', '2026-W35', '2026-08-31 17:55', 'research', 'Tipburn math and px/mm sizing for the first rack', false],
  ['jegan', '2026-W35', '2026-08-31 06:30', 'design', 'vFarm mechanical spec delivered against the measured rig', true],
  ['destiny', '2026-W35', '2026-08-30 20:41', 'build', 'Per-builder open loops sweep rebuilt', true],
  ['hardik', '2026-W35', '2026-08-30 14:02', 'design', 'Subscription mechanics one-pager, first draft', false],
  ['jason', '2026-W35', '2026-08-29 18:30', 'review', 'Capacity read and lane split for vFarm', true],
];

export const CODEX_ENTRIES: CodexEntry[] = CODEX_SEEDS.map(
  ([builder, week, at, type, title, ingested], i) => ({
    id: `CDX-${at.replace(/[- :]/g, '').slice(0, 12)}-${builder.slice(0, 2).toUpperCase()}`,
    builder_id: builder,
    week,
    logged_at: at,
    session_type: type,
    title,
    narration_url: i % 7 === 3 ? null : `https://docs.google.com/document/d/1cdx${i}narration`,
    ingested,
    spine: {
      session_id: `SES-${at.slice(0, 10).replace(/-/g, '')}-${builder.slice(0, 2).toUpperCase()}-0${(i % 4) + 1}`,
      builder_id: builder,
      subsystem: 'CODEX',
      lane: builder === 'jegan' || builder === 'kavin' ? 'VFARM_CORE' : builder === 'hardik' ? 'VFARM_MEDIA' : builder === 'ahad' ? 'CLIENT_CORE' : 'ENGINE_INTERNAL',
    },
    tags: { pay_eligible: ingested, self_healed: false },
    source: slack(String(1788700000000 + i * 86400), 'C0AUKTND199'),
  }),
);

export const BUILD_PATTERNS: BuildPattern[] = [
  { id: 'BP-01', code: 'BP-INFRA-001-ERROR_TAXONOMY_GRACEFUL_DEGRADATION', title: 'Error taxonomy and graceful degradation', lane: 'ENGINE_INTERNAL', references: 14, last_referenced: '2026-09-07', author: 'destiny', source: slack('1788197870658249', 'C0ATC4CA3G9') },
  { id: 'BP-02', code: 'BP-INFRA-003-UPSTREAM_QUOTA_EXHAUSTED', title: 'Upstream quota exhausted', lane: 'ENGINE_INTERNAL', references: 6, last_referenced: '2026-09-07', author: 'kaiqi', source: slack('1788244656748529', 'C0ATC4CA3G9') },
  { id: 'BP-03', code: 'BP-RAG-001-GATHER_THEN_GATE', title: 'Gather then gate before synthesising', lane: 'ENGINE_INTERNAL', references: 11, last_referenced: '2026-09-06', author: 'destiny', source: slack('1788190000000', 'C0ATC4CA3G9') },
  { id: 'BP-04', code: 'BP-NORTHSTAR-001-THREE_TRY_CAP', title: 'Three-try cap before mandatory escalation', lane: 'ENGINE_INTERNAL', references: 9, last_referenced: '2026-09-06', author: 'jason', source: slack('1788180000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-05', code: 'BP-ALERT-001-ENVELOPE_REGISTRY_RENDERERS', title: 'One envelope, a registry, and pure renderers', lane: 'VFARM_CORE', references: 7, last_referenced: '2026-09-05', author: 'jegan', source: slack('1787170000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-06', code: 'BP-COMM-001-DUAL_CONTRACT_INTAKE_SPLIT', title: 'Dual-contract intake split, commercial versus narrative', lane: 'VFARM_MEDIA', references: 4, last_referenced: '2026-09-02', author: 'hardik', source: slack('1786840000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-07', code: 'BP-COMM-002-HOST_INDEPENDENT_FUNNEL', title: 'Host-independent commercial funnel', lane: 'VFARM_MEDIA', references: 3, last_referenced: '2026-08-30', author: 'hardik', source: slack('1786020000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-08', code: 'BP-RAG-002-INGEST_CONTRACT_BEFORE_SCHEMA', title: 'Ingest contract before schema', lane: 'ENGINE_INTERNAL', references: 5, last_referenced: '2026-08-31', author: 'kaiqi', source: slack('1785970000000', 'C0ATC4CA3G9') },
  { id: 'BP-09', code: 'BP-CLIENT-001-WEEKLY_CLOCK_CONTRADICTION_STATE', title: 'Weekly clock with contradiction state', lane: 'CLIENT_CORE', references: 2, last_referenced: '2026-09-01', author: 'ahad', source: slack('1786450000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-10', code: 'BP-VFARM-001-MEASURED_NOT_GUESSED', title: 'Measured baselines, never guessed, fenced by confidence', lane: 'VFARM_CORE', references: 8, last_referenced: '2026-09-06', author: 'jegan', source: slack('1786190000000', 'C0A8Q2ZR4KP') },
  { id: 'BP-11', code: 'BP-INFRA-002-WRITER_SERVICE_BOUNDARY', title: 'Ask-agents read, a writer service writes', lane: 'ENGINE_INTERNAL', references: 10, last_referenced: '2026-09-04', author: 'jegan', source: slack('1787050000000', 'C0ATC4CA3G9') },
  { id: 'BP-12', code: 'BP-VFARM-002-RENDER_SAFE_BOUNDARY', title: 'Render-safe versus burn-in dependent', lane: 'VFARM_MEDIA', references: 6, last_referenced: '2026-09-03', author: 'hardik', source: slack('1786690000000', 'C0A8Q2ZR4KP') },
];

export const OPPORTUNITIES: Opportunity[] = [
  { id: 'CARD-1786722433911-8S9I', title: 'vFarm founding-buyer early access', readiness: 'blocked', health: 'failing', owner: 'hardik', lane: 'VFARM_MEDIA', last_touched: '2026-09-06', blocker: 'No authorised payment account — cannot accept money.', spine: { session_id: 'SES-20260906-HB-01', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' }, source: airtable('CARD-1786722433911-8S9I', 'tblCommercial') },
  { id: 'CARD-1786808833004-4K2M', title: 'Managed monitoring as a paid contract', readiness: 'researching', health: 'ok', owner: 'kaiqi', lane: 'ENGINE_INTERNAL', last_touched: '2026-09-05', blocker: null, spine: { session_id: 'SES-20260905-KQ-01', builder_id: 'kaiqi', subsystem: 'COMMERCIALOPPS', lane: 'ENGINE_INTERNAL' }, source: airtable('CARD-1786808833004-4K2M', 'tblCommercial') },
  { id: 'CARD-1786895241887-9WQP', title: 'vFarm cabinet pre-orders for the October render', readiness: 'evidence thin', health: 'degraded', owner: 'hardik', lane: 'VFARM_MEDIA', last_touched: '2026-09-04', blocker: 'Burn-in numbers not yet real; cannot promise performance.', spine: { session_id: 'SES-20260904-HB-01', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' }, source: airtable('CARD-1786895241887-9WQP', 'tblCommercial') },
  { id: 'CARD-1786981644120-1TZB', title: 'Client 2 retained advisory extension', readiness: 'ready to pitch', health: 'ok', owner: 'ahad', lane: 'CLIENT_CORE', last_touched: '2026-09-06', blocker: null, spine: { session_id: 'SES-20260906-AH-01', builder_id: 'ahad', subsystem: 'COMMERCIALOPPS', lane: 'CLIENT_CORE' }, source: airtable('CARD-1786981644120-1TZB', 'tblCommercial') },
  { id: 'CARD-1787068050339-6JHC', title: 'Client 12 monitoring pilot', readiness: 'researching', health: 'ok', owner: 'ahad', lane: 'CLIENT_CORE', last_touched: '2026-09-01', blocker: null, spine: { session_id: 'SES-20260901-AH-02', builder_id: 'ahad', subsystem: 'COMMERCIALOPPS', lane: 'CLIENT_CORE' }, source: airtable('CARD-1787068050339-6JHC', 'tblCommercial') },
  { id: 'CARD-1787154466702-3XKD', title: 'Media Twin explainer series as lead generation', readiness: 'idea', health: 'ok', owner: 'hardik', lane: 'VFARM_MEDIA', last_touched: '2026-08-30', blocker: null, spine: { session_id: 'SES-20260830-HB-01', builder_id: 'hardik', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_MEDIA' }, source: airtable('CARD-1787154466702-3XKD', 'tblCommercial') },
  { id: 'CARD-1787240871055-8NVG', title: 'Client 9 contradiction audit as a paid engagement', readiness: 'evidence thin', health: 'degraded', owner: 'ahad', lane: 'CLIENT_CORE', last_touched: '2026-09-01', blocker: 'Contradiction state unresolved for two clock runs.', spine: { session_id: 'SES-20260901-AH-01', builder_id: 'ahad', subsystem: 'COMMERCIALOPPS', lane: 'CLIENT_CORE' }, source: airtable('CARD-1787240871055-8NVG', 'tblCommercial') },
  { id: 'CARD-1787327277418-5FBQ', title: 'Kiosk build for a partner site', readiness: 'idea', health: 'ok', owner: 'kavin', lane: 'VFARM_CORE', last_touched: '2026-08-28', blocker: null, spine: { session_id: 'SES-20260828-KV-01', builder_id: 'kavin', subsystem: 'COMMERCIALOPPS', lane: 'VFARM_CORE' }, source: airtable('CARD-1787327277418-5FBQ', 'tblCommercial') },
];

export const BUILDERS: Builder[] = [
  { id: 'destiny', name: 'Destiny', lane: 'ENGINE_INTERNAL', open_loops: 96, oldest_loop_days: 34, last_activity: '2026-09-07 14:02', contract_status: 'signed', entries_this_week: 3, health: 'degraded', source: airtable('destiny', 'tblBJekl3ROpNZxQW') },
  { id: 'jason', name: 'Jason', lane: 'ENGINE_INTERNAL', open_loops: 18, oldest_loop_days: 21, last_activity: '2026-09-07 10:31', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('jason', 'tblVOLhWULskNiIUt') },
  { id: 'jegan', name: 'Jegan', lane: 'VFARM_CORE', open_loops: 47, oldest_loop_days: 33, last_activity: '2026-09-07 10:07', contract_status: 'signed', entries_this_week: 2, health: 'degraded', source: airtable('jegan', 'tblqMepD3XGZY4tZz') },
  { id: 'kaiqi', name: 'Kaiqi', lane: 'ENGINE_INTERNAL', open_loops: 31, oldest_loop_days: 23, last_activity: '2026-09-07 13:00', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('kaiqi', 'tblOhjIS8t0dtCQmt') },
  { id: 'ahad', name: 'Ahad', lane: 'CLIENT_CORE', open_loops: 22, oldest_loop_days: 19, last_activity: '2026-09-06 16:44', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('ahad', 'tbl3bTRcuUcbYXgDc') },
  { id: 'hardik', name: 'Hardik', lane: 'VFARM_MEDIA', open_loops: 38, oldest_loop_days: 31, last_activity: '2026-09-06 17:51', contract_status: 'pending', entries_this_week: 2, health: 'degraded', source: airtable('hardik', 'tblaloC4JIRdBq5EM') },
  { id: 'kavin', name: 'Kavin', lane: 'VFARM_CORE', open_loops: 16, oldest_loop_days: 24, last_activity: '2026-09-06 20:18', contract_status: 'signed', entries_this_week: 1, health: 'ok', source: airtable('kavin', 'tbltm7QUmWAZpzTKz') },
];

/* -------------------------------------------------------------- ask bays */

export const CHAT_THREADS: ChatThread[] = [
  {
    id: 'CH-04',
    title: 'Which loops block telemetry v1',
    updated_at: '2026-09-07 11:20',
    messages: [
      { id: 'm1', role: 'user', text: 'Which of my open loops actually block the telemetry v1 wiring?', at: '2026-09-07 11:18' },
      { id: 'm2', role: 'bays', text: 'Four of the ninety-six. LOOP-1785851330871-T2OC is the wiring itself. LOOP-1787058744219-WNEM blocks it because the envelope is not signed off, so anything emitted now is emitted against a shape that may change. LOOP-1786540233107-GC8B blocks it because the per-builder migration is still producing rows in the wrong tables, and telemetry over an inconsistent source records the inconsistency. LOOP-1787318033411-M2XA blocks the proof rather than the build — without a generalised checklist there is no bar to say it worked.\n\nThe other ninety-two do not block it.', at: '2026-09-07 11:20' },
    ],
  },
  {
    id: 'CH-03',
    title: 'Why did the digest post empty',
    updated_at: '2026-09-06 08:22',
    messages: [
      { id: 'm1', role: 'user', text: 'The Codex digest posted an empty message this morning. Why?', at: '2026-09-06 08:19' },
      { id: 'm2', role: 'bays', text: 'The render node returned a 200 with no blocks, and until Sept 1 nothing checked the body — only the status code. Assert Digest Slack OK now catches that case, which is why this one opened as INC-4B8D15 rather than passing silently. It self-healed on the retry at 08:17.\n\nThe six days before Sept 1 are not recoverable. Nothing recorded what those digests should have contained.', at: '2026-09-06 08:22' },
    ],
  },
  {
    id: 'CH-02',
    title: 'vFarm readiness for Halloween',
    updated_at: '2026-09-05 19:40',
    messages: [
      { id: 'm1', role: 'user', text: 'Is vFarm on track for Halloween?', at: '2026-09-05 19:38' },
      { id: 'm2', role: 'bays', text: 'I cannot answer that honestly yet. The readiness endpoint that would carry the answer is not built — it is named in the contract as /clusters/:id/readiness and specced, not shipped.\n\nWhat I can tell you is what is live: sensor rollups are current across four places, two alerts are open, and the mechanical spec landed Aug 31 against the measured rig rather than guessed numbers. Burn-in cycles are not emitting events, so there is no burn-in record to read.', at: '2026-09-05 19:40' },
    ],
  },
  {
    id: 'CH-01',
    title: 'Error classes and what retries',
    updated_at: '2026-09-02 15:04',
    messages: [
      { id: 'm1', role: 'user', text: 'Remind me which error classes auto-retry.', at: '2026-09-02 15:03' },
      { id: 'm2', role: 'bays', text: 'One of the five. NETWORK_TIMEOUT retries, up to three times at five-minute intervals.\n\nBILLING_QUOTA, CONFIG_AUTH and SCHEMA_VALIDATION never retry — retrying a dead credential or a rejected schema fails identically. UNKNOWN does not retry either, because nothing has established that it is safe to.', at: '2026-09-02 15:04' },
    ],
  },
];
