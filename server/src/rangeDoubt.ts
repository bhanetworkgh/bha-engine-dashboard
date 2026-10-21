/**
 * A reading judged against a range nobody has confirmed goes to Research Twin as
 * a question (LOOP-1792470655993-NJP4, the sensor side; 21 Oct 2026, Destiny).
 *
 * The crop profile's ranges carry a `source`. Some are published references
 * (temperature and humidity, Shamshiri et al. 2018); some say outright that
 * they are not yet confirmed for this cabinet (pH and EC "to be confirmed
 * against the Coimbatore growing medium", CO2 "not yet tied to one reference").
 * When a real farm's reading falls outside one of those, the doubt is about the
 * range as much as the reading, so the incident stays open as before AND one
 * Research Twin question is opened through `researchSignals.open()`, the one
 * way an automatic job is opened: one job per farm, stage and metric (the key),
 * the incident as its ref, so a repeat adds a line and never a second job, and
 * the daily budget and credit floor apply.
 *
 * Never for a simulated farm. Jegan's five vision cases (low confidence, a
 * person disagreeing with the model, a failed eval, validator refusals, counts
 * jumping) are the other half of NJP4 and wait on the camera signals (F0UG).
 */
import { query } from './pg';
import * as researchSignals from './researchSignals';

export interface TargetLike {
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  source?: string | null;
  note?: string | null;
  confirmed?: boolean;
}

/** Words a profile uses when it says its own range is not settled. */
export const UNCONFIRMED_SOURCE = /to be confirmed|not yet tied|not yet confirmed|unconfirmed|owner_threshold_required|\btbd\b|placeholder/i;

/**
 * Confirmed only when the profile says so or names a source that does not
 * call itself provisional. An explicit `confirmed` on the target wins; a missing
 * source is never confirmed. Pure.
 */
export function rangeConfirmed(t: TargetLike | null | undefined): { confirmed: boolean; why: string } {
  if (!t) return { confirmed: false, why: 'no target range is held for this metric' };
  if (t.confirmed === true) return { confirmed: true, why: 'the profile marks this range confirmed' };
  if (t.confirmed === false) return { confirmed: false, why: 'the profile marks this range unconfirmed' };
  const src = (t.source ?? '').trim();
  if (!src) return { confirmed: false, why: 'the range names no source' };
  if (UNCONFIRMED_SOURCE.test(src) || UNCONFIRMED_SOURCE.test(t.note ?? '')) return { confirmed: false, why: `its source says it is not settled: "${src}"` };
  return { confirmed: true, why: `source: "${src}"` };
}

export function question(r: { farm_name: string; metric: string; stage: string | null; value: number | null; min: number | null; max: number | null; unit: string | null; source: string | null }): string {
  const range = `${r.min ?? '−∞'} to ${r.max ?? '∞'}${r.unit ? ` ${r.unit}` : ''}`;
  return `On the real vFarm rack ${r.farm_name}, ${r.metric} read ${r.value ?? '?'}${r.unit ? ` ${r.unit}` : ''}, outside the ${r.stage ?? '?'}-stage range of ${range}. That range is not confirmed for this cabinet (${r.source ? `source: "${r.source}"` : 'no source'}). Is this reading a real fault, or is the range wrong for this cabinet's medium and crop stage? Find a source that confirms or corrects the range, and say which.`;
}

interface OpenRow {
  incident_id: string;
  farm_id: string;
  farm_name: string | null;
  metric: string;
  stage: string | null;
  last_value: number | null;
  range_min: number | null;
  range_max: number | null;
  ledger_id: string | null;
  detail: string;
  target: TargetLike | null;
}

let sweeping = false;

/** After every judging pass. Never throws. Safe to repeat: the incident is the ref. */
export async function sweep(): Promise<{ checked: number; asked: number; held: number; failed: number }> {
  const out = { checked: 0, asked: 0, held: 0, failed: 0 };
  if (sweeping) return out;
  sweeping = true;
  try {
    const rows = await query<OpenRow>(
      `SELECT i.incident_id, i.farm_id, coalesce(f.name, i.farm_id) AS farm_name, i.metric, i.stage, i.last_value, i.range_min, i.range_max, i.ledger_id, i.detail,
              (SELECT s->'targets'->i.metric FROM jsonb_array_elements(p.content->'stages') s WHERE s->>'stage' = i.stage LIMIT 1) AS target
         FROM engine_monitoring_incidents i
         JOIN engine_monitoring_cycles c ON c.farm_id = i.farm_id
         JOIN engine_monitoring_profiles p ON p.profile_id = c.profile_id AND p.version = c.profile_version
         LEFT JOIN engine_vfarm_farms f ON f.farm_id = i.farm_id
        WHERE i.kind = 'out_of_range' AND i.closed_at IS NULL AND i.synthetic = false AND c.synthetic = false AND i.metric IS NOT NULL`,
    );
    for (const r of rows.rows) {
      out.checked++;
      const c = rangeConfirmed(r.target);
      if (c.confirmed) continue;
      try {
        const g = await researchSignals.open({
          trigger: 'MONITORING',
          key: `range:${r.farm_id}:${r.stage ?? 'none'}:${r.metric}`,
          source: 'Monitoring Twin',
          ref: r.incident_id,
          question: question({ farm_name: r.farm_name ?? r.farm_id, metric: r.metric, stage: r.stage, value: r.last_value, min: r.range_min, max: r.range_max, unit: r.target?.unit ?? null, source: r.target?.source ?? null }),
          context: `Incident ${r.ledger_id ?? r.incident_id} (${r.detail}). The range is doubtful because ${c.why}. Opened by the Monitoring Twin's unconfirmed-range rule (NJP4).`,
          rearm_days: researchSignals.RULE.rearm_fault_days,
          detail: { incident_id: r.incident_id, ledger_id: r.ledger_id, farm_id: r.farm_id, metric: r.metric, stage: r.stage, why: c.why },
        });
        if (g.state === 'failed') out.failed++;
        else if (g.state === 'held_budget' || g.state === 'held_credit') out.held++;
        else out.asked++;
      } catch (e) {
        out.failed++;
        console.error(`[monitoring-twin] range doubt ${r.incident_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    out.failed++;
    console.error(`[monitoring-twin] range doubt sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    sweeping = false;
  }
  return out;
}
