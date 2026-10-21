/**
 * BP-INFRA-002, degraded evidence versus absent evidence, on the twins' read of
 * vFarm (LOOP-1788799250171-8AQG, 21 Oct 2026, Destiny).
 *
 * North Star and Research Twin read vFarm through `read_monitoring_twin`. The
 * pattern's four behaviours, as they land here:
 *   1. Error output: a read that fails answers ok:false with the error, never an
 *      empty success (the tool handler).
 *   2. Degraded result with an explicit non-reporting instruction: every farm
 *      carries `evidence_status`, saying live, degraded, absent or simulated, and
 *      what may and may not be reported from it (this file, pure).
 *   3. Parallel incident payload: a failed read is raised (raise:true, which n8n
 *      turns into an incident) and written as one `vfarm_read_degraded` event; a
 *      degraded farm names the open incidents that already record why.
 *   4. Honest fallback: one plain sentence a twin can say instead of a reading.
 */

export type EvidenceState = 'live' | 'degraded' | 'absent' | 'simulated';

export interface FarmLike {
  farm_id: string;
  name?: string | null;
  synthetic: boolean;
  feed: { last_snapshot_at: string | null; age_s: number | null; silent: boolean };
  devices: Array<{ device_id: string; state: string | null }>;
  open_incidents: Array<{ incident_id?: string; ledger_id?: string | null; canonical_id?: string | null; device_id?: string | null; kind?: string }>;
}

export interface EvidenceStatus {
  state: EvidenceState;
  degraded: boolean;
  reportable: boolean;
  reportable_devices: string[];
  not_reportable_devices: Array<{ device_id: string; state: string | null }>;
  reasons: string[];
  incidents: string[];
  instruction: string;
  fallback: string;
}

const LIVE = new Set(['LIVE']);

export function evidenceStatus(f: FarmLike): EvidenceStatus {
  const label = f.name || f.farm_id;
  const incidents = f.open_incidents.map((i) => i.canonical_id ?? i.ledger_id ?? i.incident_id ?? '').filter(Boolean);
  const live = f.devices.filter((d) => d.state && LIVE.has(d.state)).map((d) => d.device_id);
  const notLive = f.devices.filter((d) => !d.state || !LIVE.has(d.state)).map((d) => ({ device_id: d.device_id, state: d.state }));

  if (f.synthetic) {
    return {
      state: 'simulated', degraded: false, reportable: false, reportable_devices: [], not_reportable_devices: [],
      reasons: ['This farm is a simulator, not hardware.'], incidents,
      instruction: 'Never report anything from this farm as the real rack or as cabinet evidence. It proves the dashboard path only.',
      fallback: `${label} is a simulated farm; nothing from it describes a real cabinet.`,
    };
  }
  if (!f.feed.last_snapshot_at) {
    return {
      state: 'absent', degraded: true, reportable: false, reportable_devices: [], not_reportable_devices: notLive,
      reasons: ['No snapshot from this farm has ever been held.'], incidents,
      instruction: 'There is no evidence to read. Do not report any reading, state or health for this farm, and do not say it is fine.',
      fallback: `The dashboard has never received a snapshot from ${label}, so I can't say anything about it yet.`,
    };
  }
  if (f.feed.silent) {
    return {
      state: 'degraded', degraded: true, reportable: false, reportable_devices: [], not_reportable_devices: notLive.length ? notLive : f.devices.map((d) => ({ device_id: d.device_id, state: d.state })),
      reasons: [`The feed is silent: the newest snapshot is ${f.feed.age_s ?? '?'} s old (last at ${f.feed.last_snapshot_at}).`], incidents,
      instruction: 'The dashboard could not look at this farm just now. Do not report any current reading or call the farm healthy or empty; say the feed is silent and since when.',
      fallback: `${label}'s feed has been silent since ${f.feed.last_snapshot_at}, so I don't have current readings for it.`,
    };
  }
  if (notLive.length) {
    return {
      state: 'degraded', degraded: true, reportable: live.length > 0, reportable_devices: live, not_reportable_devices: notLive,
      reasons: [`${notLive.length} of ${f.devices.length} device(s) are not LIVE.`], incidents,
      instruction: 'Report readings only from the devices named in reportable_devices. For every other device say it is not reporting, with its state; never quote its last value as current and never read its silence as a healthy or empty reading.',
      fallback: `${label} is reporting, but ${notLive.length} of its ${f.devices.length} devices are not, so I can only speak for ${live.length}.`,
    };
  }
  return {
    state: 'live', degraded: false, reportable: true, reportable_devices: live, not_reportable_devices: [],
    reasons: [], incidents,
    instruction: 'Every device is LIVE. Readings may be reported as current cabinet telemetry, under the evidence rules in force.',
    fallback: `${label} is reporting on all ${f.devices.length} devices.`,
  };
}

/** When nothing real is held at all: absent, never "no problems". */
export function noRealFarm(): EvidenceStatus {
  return {
    state: 'absent', degraded: true, reportable: false, reportable_devices: [], not_reportable_devices: [],
    reasons: ['No real vFarm farm is held.'], incidents: [],
    instruction: 'There is no real vFarm evidence. Do not report rack health, readings or uptime.',
    fallback: 'The dashboard holds no real vFarm farm yet, so there is nothing to report.',
  };
}
