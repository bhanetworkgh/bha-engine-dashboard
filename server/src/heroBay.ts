/**
 * The Halloween hero bay (LOOP-1793291585895-FOCB, split from 4QA2; 30 Oct 2026, Hardik —
 * CAD/API and Media Twin lane). One representative bay, P1.0 Tray A on the real farm `v-farm`,
 * told as a story asset, **read only**: this file writes nothing, sends nothing and controls
 * nothing. It is the 14 Oct spec of record's "coherent snapshot for a bay (lights, water,
 * growth stage)" with every field saying what it is.
 *
 * **Every field carries a class**, and the class is decided here in code, never on the page:
 *   - REAL — observed by hardware and stored by this server: the one DHT11 (`rack2_dht`), which
 *     sends both temperature and humidity in vFarm's own snapshot.
 *   - SIMULATED — a story value with no sensor behind it: the growth timeline and stage, and EC
 *     and pH, which are the midpoint of the crop profile's own target for the story's stage (a
 *     number from the profile, never a reading).
 *   - NOT_VERIFIED — something real exists but we cannot vouch for it: the rack geometry (a
 *     specification with no pinned Onshape version), the bay's identity (the cabinet_id and
 *     config_hash vFarm reports, read through `monitoringTwin.identityOf` and shown as reported:
 *     they are not yet tied to a pinned CAD version or the BOM, and no burn-in is passed, CLLJ),
 *     and light and water state (vFarm's command log records the LED on
 *     relay_m2_3 and the drain valve on relay_m3_1, the pump's channel is unknown, and a recorded
 *     command mapping is not an observed load state).
 *
 * **A real reading is never shown as live unless it is.** Freshness is the Monitoring Twin's own
 * rule (`monitoringTwin.freshness`, 90 s and 900 s against when vFarm looked), and a feed silent
 * for over `THRESHOLDS.feed_silent_s` is NO_FEED whatever the device said last. A device or a
 * metric that is missing reads null and UNKNOWN; nothing is filled in.
 *
 * Nothing here is a second store or a second resolver: it reads `engine_vfarm_farms`,
 * `engine_vfarm_devices` and `engine_monitoring_profiles`, the rows the snapshot and the twin
 * already keep. No light or pump is ever switched, no cycle is set on `v-farm`, and no second
 * rack is drawn: the evidence of 30 Oct supports one bay.
 */
import { query, type Queryable } from './pg';
import { freshness, identityOf, readingValue, stageAt, THRESHOLDS, type Range, type Stage } from './monitoringTwin';

export type EvidenceClass = 'REAL' | 'SIMULATED' | 'NOT_VERIFIED';
export type ReadingState = 'LIVE' | 'STALE' | 'OFFLINE' | 'NO_FEED' | 'UNKNOWN';

/** What the hero bay is drawn from. A change here is a change to what the page claims. */
export const HERO_BAY = {
  bay: 'P1.0 Tray A',
  farm_code: 'v-farm',
  climate_device_id: 'rack2_dht',
  profile_id: 'tomato-dwarf-determinate',
  /** The story's day 0: the tomato plants went into Tray A on 29 Oct (a person's report, not telemetry). */
  day0: {
    at: '2026-10-29T00:00:00Z',
    event: 'plants into P1.0 Tray A',
    source: "Jegan's P1.0 loop record, consolidated 29 Oct 2026 (nursery tomato plants on cocopeat in Tray A)",
  },
  /** The rack as the P1 specification describes it. NOT the Onshape model until a version is pinned. */
  cad: {
    cabinet_type: 'VFARM_CAB_2TIER_1200x500_P1',
    width_mm: 1200,
    depth_mm: 500,
    height_mm: 1800,
    tiers: 2,
    tray_mm: { width: 1200, depth: 500 },
    hero_tier: 1,
    source: 'BHA-VFARM-P1-001 CAD/BOM v0.1 (21 Sep 2026), specification dimensions',
    onshape_document: 'c9201af13495a63700f4553c',
    /** The immutable Onshape version id. Null until Hardik pins one; until then CAD is never canonical. */
    onshape_version: null as string | null,
    /** Who checked that version against the physical rack. Null until somebody has. */
    verified_by: null as string | null,
  },
} as const;

export interface HeroField {
  key: 'temperature' | 'humidity' | 'lights' | 'water' | 'ec' | 'ph' | 'growth_stage' | 'crop_day';
  label: string;
  value: number | string | null;
  unit: string | null;
  class: EvidenceClass;
  /** Only for a REAL reading (or one that should have been): how current it is. */
  state: ReadingState | null;
  /** When the value was observed (REAL), or null for a story value. */
  observed_at: string | null;
  source: string;
  note: string;
}

export interface HeroStoryStage {
  stage: string;
  label: string;
  where: 'supplier' | 'cabinet';
  from_day: number | null;
  to_day: number | null;
}

export interface HeroBay {
  schema: 'vfarm.hero_bay.v0';
  generated_at: string;
  read_only: true;
  bay: {
    name: string;
    farm_code: string;
    farm_id: string | null;
    class: EvidenceClass;
    /** As vFarm reports them, null where it sends none. Reported, never verified provenance. */
    cabinet_id: string | null;
    config_hash: string | null;
    burn_in_state: string | null;
    note: string;
  };
  feed: { last_snapshot_at: string | null; age_s: number | null; silent: boolean };
  cad: {
    class: EvidenceClass;
    canonical: boolean;
    cabinet_type: string;
    width_mm: number;
    depth_mm: number;
    height_mm: number;
    tiers: number;
    tray_mm: { width: number; depth: number };
    hero_tier: number;
    source: string;
    onshape_document: string;
    onshape_version: string | null;
    note: string;
  };
  fields: HeroField[];
  story: {
    class: 'SIMULATED';
    profile_id: string;
    profile_version: number | null;
    day0: { at: string; event: string; source: string };
    crop_day: number | null;
    current_stage: string | null;
    stages: HeroStoryStage[];
    note: string;
  };
  /** What this model deliberately does not show or claim, said once so no reader infers it. */
  not_claimed: string[];
}

export interface HeroBayInput {
  /** `fields` is the farm object vFarm sent, read for its identity only. */
  farm: { farm_id: string; snapshot_at: string | null; fields?: unknown } | null;
  device: {
    device_id: string;
    device_type: string | null;
    model: string | null;
    status: string | null;
    last_seen_at: string | null;
    last_reading_at: string | null;
    snapshot_at: string | null;
    latest: unknown;
  } | null;
  profile: { version: number; content: unknown } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const NOT_CLAIMED = [
  'No second rack: only one bay has evidence today.',
  'No light, pump or valve is switched from here, and none is shown as on or off.',
  'Watering is designed around a time schedule kept on the rack; it is not sensor-driven and there is no closed-loop control. The installed P1.0 schedule and controller behaviour still await runtime confirmation, and the edge code\'s local max-run cut-off is implemented and reviewed but not yet runtime-verified on the installed rack.',
  'No pollination result: the arm is a bench prototype.',
  'No finished boxed kit and no production farm.',
  'The rack geometry is a specification drawing, not a pinned Onshape model.',
];

/** The hero tier's story: the stages the profile names outside the cabinet, then the ones in it. */
function storyStages(content: unknown): { stages: HeroStoryStage[]; cabinet: Stage[] } {
  if (!isObj(content)) return { stages: [], cabinet: [] };
  const cabinet = (Array.isArray(content.stages) ? content.stages : []).filter(isObj) as unknown as Stage[];
  const reference = (Array.isArray(content.reference_only_stages) ? content.reference_only_stages : []).filter(isObj);
  const stages: HeroStoryStage[] = [
    ...reference.map((r) => ({ stage: String(r.stage), label: String(r.stage).replace(/_/g, ' '), where: 'supplier' as const, from_day: null, to_day: null })),
    ...cabinet.map((s) => ({ stage: s.stage, label: s.label ?? s.stage, where: 'cabinet' as const, from_day: s.from_day, to_day: s.to_day })),
  ];
  return { stages, cabinet };
}

const midpoint = (r: Range | undefined): number | null =>
  r && typeof r.min === 'number' && typeof r.max === 'number' ? Math.round(((r.min + r.max) / 2) * 100) / 100 : null;

/** The bay, built from the rows the snapshot and the twin already keep. Pure, so it is tested without a database. */
export function buildHeroBay(input: HeroBayInput, now = Date.now()): HeroBay {
  const nowIso = new Date(now).toISOString();
  const snapAt = input.farm?.snapshot_at ?? null;
  const feedAge = snapAt ? Math.max(0, Math.round((now - Date.parse(snapAt)) / 1000)) : null;
  const silent = feedAge === null || feedAge > THRESHOLDS.feed_silent_s;

  const climate = (key: 'temperature' | 'humidity', label: string): HeroField => {
    const d = input.device;
    const latest = isObj(d?.latest) ? d!.latest : null;
    const raw = latest ? latest[key] : undefined;
    const value = raw === undefined ? null : readingValue(raw);
    const unit = isObj(raw) && typeof raw.unit === 'string' ? raw.unit : null;
    const source = `${HERO_BAY.climate_device_id} (DHT11) in vFarm's snapshot`;
    if (!d || value === null) {
      return {
        key, label, value: null, unit, class: 'NOT_VERIFIED', state: 'UNKNOWN', observed_at: null, source,
        note: d ? `vFarm's snapshot carries no ${key} for this sensor` : 'the sensor is not in vFarm\'s snapshot for this farm',
      };
    }
    let state: ReadingState = freshness(d.last_reading_at, d.snapshot_at ?? snapAt ?? nowIso, d.status, d.last_seen_at, d.device_type).state as ReadingState;
    if (state !== 'LIVE' && state !== 'STALE' && state !== 'OFFLINE') state = 'UNKNOWN';
    if (silent) state = 'NO_FEED';
    const live = state === 'LIVE';
    return {
      key, label, value, unit, class: 'REAL', state, observed_at: d.last_reading_at, source,
      note: live
        ? 'a real reading, current when vFarm last looked'
        : state === 'NO_FEED'
          ? 'the last real reading; vFarm\'s feed has gone quiet, so this is not current'
          : state === 'STALE'
            ? 'a real reading, but older than the twin\'s 90 s live window'
            : 'the last real reading before the sensor went offline; not current',
    };
  };

  const { stages, cabinet } = storyStages(input.profile?.content);
  const at = cabinet.length ? stageAt(cabinet, HERO_BAY.day0.at, 1, now) : null;
  const stage = at?.stage ?? null;
  const stageLabel = stage ? stage.label ?? stage.stage : at?.before_start ? 'before the cabinet stages' : at?.after_end ? 'cycle complete' : null;
  const profileSrc = input.profile ? `${HERO_BAY.profile_id} v${input.profile.version}` : `${HERO_BAY.profile_id} (not held)`;

  const simulatedTarget = (key: 'ec' | 'ph', label: string): HeroField => {
    const target = stage?.targets?.[key];
    const value = midpoint(target);
    return {
      key, label, value, unit: target?.unit ?? null, class: 'SIMULATED', state: null, observed_at: null,
      source: `${profileSrc}, ${stage ? stage.label ?? stage.stage : 'no stage'} target range`,
      note: value === null
        ? `no ${label} target in the profile for this stage, so no value is shown; crop-stage nutrient targets and advanced control are still under development and validation`
        : `illustrative: the middle of the profile's ${label} target (${target!.min}–${target!.max}); crop-stage nutrient targets and advanced control are still under development and validation. Not a sensor reading, and nothing on the rack is controlled to it`,
    };
  };

  const notVerifiedState = (key: 'lights' | 'water', label: string): HeroField => ({
    key, label, value: null, unit: null, class: 'NOT_VERIFIED', state: null, observed_at: null,
    source: "vFarm's command log and relay channels",
    note: key === 'lights'
      ? 'vFarm\'s command log records the grow light (led_light_01) on relay_m2_3. That is a recorded command mapping, not an observed load state: the snapshot carries only the relay bit, last seen before the rack went offline, so the light\'s state is not shown'
      : 'vFarm\'s command log records the drain valve (drain_pump_01) on relay_m3_1 (CH9); the pump\'s channel is not yet verified. A recorded command mapping is not an observed load state, so water state is not shown',
  });

  const fields: HeroField[] = [
    climate('temperature', 'Temperature'),
    climate('humidity', 'Humidity'),
    notVerifiedState('lights', 'Lights'),
    notVerifiedState('water', 'Water'),
    simulatedTarget('ec', 'EC'),
    simulatedTarget('ph', 'pH'),
    {
      key: 'growth_stage', label: 'Growth stage', value: stageLabel, unit: null, class: 'SIMULATED', state: null, observed_at: null,
      source: profileSrc,
      note: 'a story clock over the crop profile from the reported day 0, not a measured stage',
    },
    {
      key: 'crop_day', label: 'Crop day', value: at ? at.crop_day : null, unit: 'day', class: 'SIMULATED', state: null, observed_at: null,
      source: `day 0 = ${HERO_BAY.day0.at.slice(0, 10)}, ${HERO_BAY.day0.event} (reported, not telemetry)`,
      note: 'days since the plants went in, counted on the profile\'s clock; the profile counts from first flower, which nobody has confirmed',
    },
  ];

  const canonical = !!HERO_BAY.cad.onshape_version && !!HERO_BAY.cad.verified_by;
  const id = input.farm ? identityOf(input.farm.fields) : null;
  const bayNote = !input.farm
    ? 'vFarm\'s snapshot does not list this farm'
    : id?.cabinet_id
      ? `the farm is real; vFarm reports cabinet ${id.cabinet_id}${id.config_hash ? ' and a config_hash' : ' and no config_hash'}. That is a reported identifier, not verified provenance: it is not yet tied to a pinned CAD version or the BOM, and ${id.burn_in_state === 'passed' ? 'burn-in alone does not make it canonical' : 'no burn-in has passed'}, so the cabinet's configuration is not verified (CLLJ)`
      : 'the farm is real; vFarm sends no cabinet_id yet, so which cabinet this is is not verified (CLLJ)';
  return {
    schema: 'vfarm.hero_bay.v0',
    generated_at: nowIso,
    read_only: true,
    bay: {
      name: HERO_BAY.bay, farm_code: HERO_BAY.farm_code, farm_id: input.farm?.farm_id ?? null, class: 'NOT_VERIFIED',
      cabinet_id: id?.cabinet_id ?? null, config_hash: id?.config_hash ?? null, burn_in_state: id?.burn_in_state ?? null,
      note: bayNote,
    },
    feed: { last_snapshot_at: snapAt, age_s: feedAge, silent },
    cad: {
      class: canonical ? 'REAL' : 'NOT_VERIFIED',
      canonical,
      cabinet_type: HERO_BAY.cad.cabinet_type,
      width_mm: HERO_BAY.cad.width_mm,
      depth_mm: HERO_BAY.cad.depth_mm,
      height_mm: HERO_BAY.cad.height_mm,
      tiers: HERO_BAY.cad.tiers,
      tray_mm: { ...HERO_BAY.cad.tray_mm },
      hero_tier: HERO_BAY.cad.hero_tier,
      source: HERO_BAY.cad.source,
      onshape_document: HERO_BAY.cad.onshape_document,
      onshape_version: HERO_BAY.cad.onshape_version,
      note: canonical
        ? `Onshape version ${HERO_BAY.cad.onshape_version}, checked by ${HERO_BAY.cad.verified_by}`
        : 'specification dimensions only: no immutable Onshape version is pinned, so this is not the canonical CAD',
    },
    fields,
    story: {
      class: 'SIMULATED',
      profile_id: HERO_BAY.profile_id,
      profile_version: input.profile?.version ?? null,
      day0: { ...HERO_BAY.day0 },
      crop_day: at ? at.crop_day : null,
      current_stage: stage?.stage ?? null,
      stages,
      note: 'seed and early growth happen at the supplier; the cabinet stages run on a story clock from the reported day 0. Nothing here was measured.',
    },
    not_claimed: [...NOT_CLAIMED],
  };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

/** The hero bay now, read from this server's own tables. Reads only. */
export async function heroBayData(db: Queryable = { query }): Promise<HeroBay> {
  const farms = await db.query<Record<string, unknown>>(
    `SELECT farm_id, snapshot_at, fields FROM engine_vfarm_farms WHERE code = $1 AND unlisted_at IS NULL ORDER BY snapshot_at DESC NULLS LAST LIMIT 1`,
    [HERO_BAY.farm_code],
  );
  const f = farms.rows[0];
  const farm = f ? { farm_id: String(f.farm_id), snapshot_at: iso(f.snapshot_at), fields: f.fields } : null;
  let device: HeroBayInput['device'] = null;
  if (farm) {
    const d = (await db.query<Record<string, unknown>>(
      `SELECT device_id, device_type, model, status, last_seen_at, last_reading_at, snapshot_at, latest
         FROM engine_vfarm_devices WHERE farm_id = $1 AND device_id = $2 AND gone_at IS NULL`,
      [farm.farm_id, HERO_BAY.climate_device_id],
    )).rows[0];
    if (d) {
      device = {
        device_id: String(d.device_id), device_type: (d.device_type as string) ?? null, model: (d.model as string) ?? null,
        status: (d.status as string) ?? null, last_seen_at: iso(d.last_seen_at), last_reading_at: iso(d.last_reading_at),
        snapshot_at: iso(d.snapshot_at), latest: d.latest,
      };
    }
  }
  const p = (await db.query<{ version: number; content: unknown }>(
    `SELECT version, content FROM engine_monitoring_profiles WHERE profile_id = $1 ORDER BY version DESC LIMIT 1`,
    [HERO_BAY.profile_id],
  )).rows[0];
  return buildHeroBay({ farm, device, profile: p ? { version: Number(p.version), content: p.content } : null });
}
