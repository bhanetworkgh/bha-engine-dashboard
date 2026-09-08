/**
 * Phase 1 fixtures — Codex entries.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { CodexEntry } from '../types';
import { slack } from './common';

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
    status: ingested ? 'ingested' : 'posted',
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
