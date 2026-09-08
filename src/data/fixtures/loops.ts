/**
 * Phase 1 fixtures — open loops, the review queue and reconciliation.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { Loop, ProposedClose, ReconciliationRow } from '../types';
import { BUILDER_NAMES, airtable, n8n, slack } from './common';

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
  // Closed. A sample of the rows the per-builder tables hold as closed.
  ['LOOP-1785590002117-Q7AD', 'Add Assert Digest Slack OK so an empty render cannot pass green', 'destiny', 'closed', 37, '2026-08-01', 'ENGINE_INTERNAL'],
  ['LOOP-1785676411029-M4RE', 'Turn on Raw Body at the Bays webhook for Genie signatures', 'destiny', 'closed', 36, '2026-08-02', 'ENGINE_INTERNAL'],
  ['LOOP-1785762820044-7HHT', 'Rotate the Research Twin external-ask key to the six-secret architecture', 'destiny', 'closed', 35, '2026-08-03', 'ENGINE_INTERNAL'],
  ['LOOP-1786021801118-X2PL', 'Deliver the vFarm mechanical spec against the measured rig', 'jegan', 'closed', 32, '2026-08-06', 'VFARM_CORE'],
  ['LOOP-1786367400021-N9SB', 'Create the Bays incidents key in the BHARAG2 console', 'destiny', 'closed', 28, '2026-08-10', 'ENGINE_INTERNAL'],
  ['LOOP-1786885811203-V1CQ', 'Normalise Latenode MCP array queries', 'kaiqi', 'closed', 22, '2026-08-16', 'ENGINE_INTERNAL'],
  ['LOOP-1787404400987-D8KA', 'Post the three watched-client memos from the weekly clock', 'ahad', 'closed', 16, '2026-08-22', 'CLIENT_CORE'],
  ['LOOP-1787836500112-B5WM', 'Review the Logstream vocabulary for COMPLETED and REJECTED_POLICY', 'jason', 'closed', 11, '2026-08-27', 'ENGINE_INTERNAL'],
  ['LOOP-1788009300415-Z3QE', 'Apply the render-safe boundary to the October assets', 'hardik', 'closed', 9, '2026-08-29', 'VFARM_MEDIA'],
  ['LOOP-1788268600772-H6TN', 'Work out tipburn math and px/mm sizing for the first rack', 'kavin', 'closed', 6, '2026-09-01', 'VFARM_CORE'],
];

/** When a closed seed was closed. Only the closed rows have one. */
const CLOSED_AT: Record<string, string> = {
  'LOOP-1785590002117-Q7AD': '2026-09-01',
  'LOOP-1785676411029-M4RE': '2026-08-29',
  'LOOP-1785762820044-7HHT': '2026-08-29',
  'LOOP-1786021801118-X2PL': '2026-08-31',
  'LOOP-1786367400021-N9SB': '2026-08-19',
  'LOOP-1786885811203-V1CQ': '2026-09-05',
  'LOOP-1787404400987-D8KA': '2026-09-01',
  'LOOP-1787836500112-B5WM': '2026-09-04',
  'LOOP-1788009300415-Z3QE': '2026-09-03',
  'LOOP-1788268600772-H6TN': '2026-09-06',
};

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
    closed_at: CLOSED_AT[id] ?? null,
    note: null,
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
  { owner: 'destiny', open: 96, in_progress: 2, closed: 41, oldest_days: 34 },
  { owner: 'jegan', open: 47, in_progress: 1, closed: 12, oldest_days: 33 },
  { owner: 'hardik', open: 38, in_progress: 1, closed: 7, oldest_days: 31 },
  { owner: 'kaiqi', open: 31, in_progress: 0, closed: 9, oldest_days: 23 },
  { owner: 'ahad', open: 22, in_progress: 0, closed: 6, oldest_days: 19 },
  { owner: 'jason', open: 18, in_progress: 0, closed: 5, oldest_days: 21 },
  { owner: 'kavin', open: 16, in_progress: 0, closed: 4, oldest_days: 24 },
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
