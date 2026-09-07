/**
 * Phase 1 fixtures — North Star and Research Twin asks, runs, gaps and transitions.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { AskRecord, GapRecord, RunRecord, TransitionRecord } from '../types';
import { n8n } from './common';

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
