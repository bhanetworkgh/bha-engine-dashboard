/**
 * Phase 1 fixtures — vFarm sensor rollups, alerts and lifecycle events.
 *
 * Values here are invented but internally consistent, and the lane, subsystem
 * and error-class vocabularies match the live engine. When the endpoint lands
 * this whole directory goes; nothing outside src/data/ should notice.
 *
 * Reference date for every relative figure: 2026-09-07.
 */

import type { LifecycleEvent, SensorReading, VFarmAlert } from '../types';
import { n8n } from './common';

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
