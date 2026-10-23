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
  /** false when vFarm's snapshot stopped naming this farm (migration 90). Absent means listed. */
  listed?: boolean;
  unlisted_since?: string | null;
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
  if (f.listed === false) {
    return {
      state: 'absent', degraded: true, reportable: false, reportable_devices: [], not_reportable_devices: f.devices.map((d) => ({ device_id: d.device_id, state: d.state })),
      reasons: [`vFarm no longer lists this farm: its snapshot has left it out since ${f.unlisted_since ?? '?'} (the last one naming it was at ${f.feed.last_snapshot_at}).`], incidents,
      instruction: 'vFarm stopped sending this farm. Do not report any reading, state, health or uptime for it, and do not call it offline, silent, healthy or empty; say vFarm no longer lists it and when it was last sent.',
      fallback: `vFarm no longer lists ${label}; the last snapshot that named it was at ${f.feed.last_snapshot_at}, so I have nothing current on it.`,
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
      fallback: live.length
        ? `${label} is reporting, but ${notLive.length} of its ${f.devices.length} devices are not, so I can only speak for ${live.length}.`
        : `${label}'s feed is arriving, but none of its ${f.devices.length} devices is reporting, so I have no current readings for it.`,
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

/**
 * Which held farms a caller means (24 Oct 2026, D6). Genie asked for "vFarm_01" and the read matched
 * only internal ids, so the farm named Vfarm_01 (code vfarm-01) was not found and the answer said no
 * real farm was held at all. A farm is matched by its id exactly, else by its code or name compared
 * without case or punctuation ("vFarm_01", "vfarm-01" and "Vfarm 01" are one key). Pure.
 */
export const farmKey = (v: string | null | undefined) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export function matchFarms<T extends { farm_id: string; code?: string | null; name?: string | null }>(farms: T[], ref: string): { farms: T[]; matched_by: 'farm_id' | 'code_or_name' | null } {
  const exact = farms.filter((f) => f.farm_id === ref);
  if (exact.length) return { farms: exact, matched_by: 'farm_id' };
  const k = farmKey(ref);
  if (!k) return { farms: [], matched_by: null };
  const byKey = farms.filter((f) => farmKey(f.farm_id) === k || farmKey(f.code) === k || farmKey(f.name) === k);
  return { farms: byKey, matched_by: byKey.length ? 'code_or_name' : null };
}

/** When a farm was asked for by a name nothing held answers to: unknown, never "no real farm". */
export function unknownFarm(ref: string, held: Array<{ farm_id: string; code?: string | null; name?: string | null; synthetic?: boolean; listed?: boolean }>): EvidenceStatus {
  const names = held.map((f) => `${f.name ?? f.farm_id} (${f.farm_id}${f.synthetic ? ', simulated' : ''}${f.listed === false ? ', no longer listed by vFarm' : ''})`);
  return {
    state: 'absent', degraded: true, reportable: false, reportable_devices: [], not_reportable_devices: [],
    reasons: [`No held farm has the id, code or name "${ref}".`], incidents: [],
    instruction: 'The farm asked about is not held under that name. Do not report it as live, offline, simulated, healthy or empty; say no farm by that name is held and name the farms that are, so the asker can say which one they meant.',
    fallback: names.length ? `I don't hold a farm called "${ref}". The farms I do hold are: ${names.join('; ')}.` : `I don't hold a farm called "${ref}", and no vFarm farm is held yet.`,
  };
}
