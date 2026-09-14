/**
 * Phase 1 fixtures — vFarm alerts and the racks they come from.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * The sensor rollups and the (empty) lifecycle list went with the vFarm page
 * on 2026-09-14; what is left is what the Overview still reads.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { VFarmAlert } from '../types';
import { n8n } from './common';

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
