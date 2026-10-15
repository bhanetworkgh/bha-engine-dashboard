/**
 * UN9D acceptance and the first real vFarm data (2026-10-15, Destiny — D3).
 *
 * Two things, both about the moment vFarm's own rack starts sending:
 *
 *  1. **firstRealData** — the first time a real (not simulated) snapshot or
 *     alert reaches this dashboard, Bays DMs Destiny once: the farm, how many
 *     devices, when, and whether it was a dry run, stored or refused. Three
 *     separate "firsts", each claimed in `meta` before the DM, so it fires once
 *     each and two instances cannot both send. A DM that does not land gives the
 *     claim back and is logged, so the next post tries again.
 *
 *  2. **check** — Hardik's two UN9D acceptance tests (30 Sep / 1 Oct, locked by
 *     Jason 2 Oct) run against what this dashboard holds for one farm. Every
 *     condition is `pass`, `fail` or `not_yet_possible` with the reason; a test
 *     passes only when every condition does. A simulated farm can be checked, and
 *     every answer says so: a pass on simulated data proves the path, never the
 *     rack, and is NOT_SAFE_TO_CLAIM. The result is one
 *     `un9d_acceptance_checked` row in engine_events.
 *
 * Neither changes a farm, a device or an incident.
 */
import { query } from './db';
import * as engineEvents from './engineEvents';
import * as slack from './slack';
import * as monitoringTwin from './monitoringTwin';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const NOTIFY_USER = 'U0AEW3TBYH1'; // Destiny, Engine Steward
export type Arrival = 'dry_run' | 'stored' | 'refused';
const META_KEY = (a: Arrival) => `vfarm.first_real.${a}`;

/* ------------------------------------------------------ first real data */

/** Real means no farm in the post says synthetic, and no farm it names is a simulated farm held here. */
export async function isRealPost(route: 'snapshot' | 'alert', body: Obj): Promise<{ real: boolean; farms: string[]; devices: number }> {
  const farms = new Set<string>();
  let declaredSynthetic = false;
  let devices = 0;
  if (route === 'snapshot') {
    for (const f of Array.isArray(body.farms) ? body.farms : []) {
      if (!isObj(f)) continue;
      const id = str(f.id);
      if (id) farms.add(id);
      if (f.synthetic === true) declaredSynthetic = true;
    }
    devices = Array.isArray(body.devices) ? body.devices.length : 0;
  } else {
    const place = isObj(body.place) ? body.place : {};
    if (str(place.farm_id)) farms.add(str(place.farm_id)!);
    for (const d of Array.isArray(body.devices) ? body.devices : []) {
      if (!isObj(d)) continue;
      devices++;
      const p = isObj(d.place) ? d.place : {};
      if (str(p.farm_id)) farms.add(str(p.farm_id)!);
    }
  }
  if (declaredSynthetic) return { real: false, farms: [...farms], devices };
  if (farms.size) {
    const sim = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM engine_vfarm_farms WHERE farm_id = ANY($1::text[]) AND coalesce((fields->>'synthetic')::boolean, false)`,
      [[...farms]],
    );
    if ((sim.rows[0]?.n ?? 0) > 0) return { real: false, farms: [...farms], devices };
  }
  return { real: true, farms: [...farms], devices };
}

export function noticeText(a: { route: 'snapshot' | 'alert'; arrival: Arrival; farms: string[]; devices: number; at: string; detail: string | null }): string {
  const what = a.route === 'snapshot' ? 'snapshot' : 'alert';
  const head =
    a.arrival === 'stored'
      ? `First real vFarm ${what} stored on the dashboard.`
      : a.arrival === 'dry_run'
        ? `First real vFarm ${what} dry run reached the dashboard (checked and rolled back, nothing kept).`
        : `First real vFarm ${what} reached the dashboard and was refused.`;
  const lines = [
    head,
    `Farm: ${a.farms.length ? a.farms.join(', ') : 'none named'}`,
    `Devices in it: ${a.devices}`,
    `When: ${a.at}`,
  ];
  if (a.detail) lines.push(a.arrival === 'refused' ? `Why it was refused: ${a.detail}` : `What landed: ${a.detail}`);
  if (a.arrival === 'stored') lines.push('Next: run check_un9d_acceptance on this farm.');
  if (a.arrival === 'refused') lines.push('The sender got the same reason back. Nothing was stored.');
  return lines.join('\n');
}

let sendDm: (user: string, text: string) => Promise<{ ok: boolean; detail: string; ts?: string }> = slack.dm;
/** Tests only. */
export function setDmForTest(fn: typeof sendDm): void {
  sendDm = fn;
}

/**
 * Called after every post to the two vFarm routes, stored, dry run or refused.
 * Never throws and never delays the answer to vFarm: the caller does not await it.
 */
export async function firstRealData(route: 'snapshot' | 'alert', body: Obj, arrival: Arrival, detail: string | null): Promise<{ sent: boolean; reason: string }> {
  try {
    const r = await isRealPost(route, body);
    if (!r.real) return { sent: false, reason: 'simulated' };
    const at = new Date().toISOString();
    const key = META_KEY(arrival);
    const claim = await query(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, JSON.stringify({ route, farms: r.farms, devices: r.devices, at, state: 'sending' })]);
    if (!claim.rowCount) return { sent: false, reason: 'already_sent' };
    const text = noticeText({ route, arrival, farms: r.farms, devices: r.devices, at, detail });
    const dm = await sendDm(NOTIFY_USER, text);
    if (!dm.ok) {
      await query(`DELETE FROM meta WHERE key = $1`, [key]);
      console.error(`[un9d] first real vFarm ${route} (${arrival}) DM not sent, will try on the next post: ${dm.detail}`);
      await engineEvents.record({ event_type: 'vfarm_first_real_data_notice_failed', subject_id: r.farms[0] ?? 'vfarm', lane: 'VFARM_HARDWARE', actor: 'dashboard', detail: { route, arrival, error: dm.detail } }).catch(() => undefined);
      return { sent: false, reason: dm.detail };
    }
    await query(`UPDATE meta SET value = $2 WHERE key = $1`, [key, JSON.stringify({ route, farms: r.farms, devices: r.devices, at, state: 'sent', ts: dm.ts ?? null })]);
    await engineEvents.record({ event_type: 'vfarm_first_real_data', subject_id: r.farms[0] ?? 'vfarm', lane: 'VFARM_HARDWARE', actor: 'dashboard', dedupe_key: key, detail: { route, arrival, farms: r.farms, devices: r.devices, notified: NOTIFY_USER, slack_ts: dm.ts ?? null } }).catch((e) => console.error(`[un9d] event not recorded: ${(e as Error).message}`));
    return { sent: true, reason: 'sent' };
  } catch (e) {
    console.error(`[un9d] first-real-data check failed: ${(e as Error).message}`);
    return { sent: false, reason: (e as Error).message };
  }
}

/* --------------------------------------------------------- acceptance */

export type Verdict = 'pass' | 'fail' | 'not_yet_possible';
export interface Condition { id: string; condition: string; verdict: Verdict; reason: string }
export interface TestResult { test: string; verdict: Verdict; conditions: Condition[] }

/** A test passes only when every condition does; any fail fails it; otherwise not yet possible. */
export function rollUp(conds: Condition[]): Verdict {
  if (conds.some((c) => c.verdict === 'fail')) return 'fail';
  if (conds.every((c) => c.verdict === 'pass')) return 'pass';
  return 'not_yet_possible';
}

const C = (id: string, condition: string, verdict: Verdict, reason: string): Condition => ({ id, condition, verdict, reason });

interface Device { device_id: string; place: string | null; device_type: string | null; last_reading_at: string | null; last_seen_at: string | null; snapshot_at: string | null; gone: boolean; state: string | null }
interface Incident { incident_id: string; device_id: string | null; kind: string; opened_at: string; closed_at: string | null; ledger_id: string | null; ledger_state: string }
interface HealthRow { natural_id: string; resolved_at: string | null; status: string | null }

/** Test 1, from the stored rows and the Monitoring Twin's own read of the same farm. Pure. */
export function test1(farm: { snapshot_at: string; synthetic: boolean } , devices: Device[], read: { feed_silent: boolean; devices: Array<{ device_id: string; state: string | null; last_reading_at: string | null }> } | null, now: number): TestResult {
  const live = devices.filter((d) => !d.gone);
  const conds: Condition[] = [];
  if (!live.length) {
    conds.push(C('identity', 'Every device has an id and a farm', 'not_yet_possible', 'No device is held for this farm.'));
    return { test: 'Test 1: canonical sensor-state read', verdict: 'not_yet_possible', conditions: conds };
  }
  const missing = (k: keyof Device) => live.filter((d) => !d[k]).map((d) => d.device_id);
  const each = (id: string, label: string, k: keyof Device, what: string) => {
    const m = missing(k);
    conds.push(C(id, label, m.length ? 'fail' : 'pass', m.length ? `${m.length} of ${live.length} device(s) have no ${what}: ${m.slice(0, 5).join(', ')}.` : `All ${live.length} device(s) carry a ${what}.`));
  };
  conds.push(C('identity', 'Every device has an id and a farm', 'pass', `All ${live.length} device(s) carry device_id and farm_id (the route refuses one without).`));
  each('placement', 'Every device says where it sits', 'place', 'place');
  each('signal_type', 'Every device says what it measures', 'device_type', 'device_type');
  each('observed_time', 'Every device carries when it last read', 'last_reading_at', 'last_reading_at');
  conds.push(C('received_time', 'The dashboard knows when it received the state', farm.snapshot_at ? 'pass' : 'fail', farm.snapshot_at ? `Last snapshot received ${farm.snapshot_at}.` : 'No snapshot time is held.'));
  conds.push(C('evidence_flag', 'The data says whether it is real evidence', 'pass', farm.synthetic ? 'The farm is marked synthetic: simulated, not evidence about any rack.' : 'The farm carries no synthetic flag: it is vFarm data, counted as evidence.'));

  // Stale shown as live: judged against now, not against when vFarm last looked.
  const feedAge = Math.round((now - Date.parse(farm.snapshot_at)) / 1000);
  const feedSilent = feedAge > monitoringTwin.THRESHOLDS.feed_silent_s;
  if (!read) {
    conds.push(C('freshness', 'Stale data is never shown as live', 'not_yet_possible', 'The Monitoring Twin read has no entry for this farm.'));
    conds.push(C('agreement', 'The dashboard and the feed agree', 'not_yet_possible', 'The Monitoring Twin read has no entry for this farm.'));
  } else {
    const liveWrong = feedSilent ? read.devices.filter((d) => d.state === 'LIVE').map((d) => d.device_id) : [];
    const ageWrong = read.devices.filter((d) => d.state === 'LIVE' && d.last_reading_at && (now - Date.parse(d.last_reading_at)) / 1000 > monitoringTwin.THRESHOLDS.offline_s + monitoringTwin.THRESHOLDS.feed_silent_s).map((d) => d.device_id);
    const wrong = [...new Set([...liveWrong, ...ageWrong])];
    conds.push(
      C(
        'freshness',
        'Stale data is never shown as live',
        wrong.length ? 'fail' : 'pass',
        wrong.length
          ? `${wrong.length} device(s) read LIVE although the feed is ${Math.round(feedAge / 60)} min old: ${wrong.slice(0, 5).join(', ')}.`
          : feedSilent
            ? `The feed is ${Math.round(feedAge / 60)} min old and the read says so (feed silent; no device shown LIVE).`
            : `The feed is ${feedAge} s old; every state is judged from it.`,
      ),
    );
    const byId = new Map(read.devices.map((d) => [d.device_id, d]));
    const disagree: string[] = [];
    for (const d of live) {
      const r = byId.get(d.device_id);
      if (!r) disagree.push(`${d.device_id} missing from the read`);
      else if ((r.last_reading_at ?? null) !== (d.last_reading_at ?? null) && !(r.last_reading_at && d.last_reading_at && Date.parse(r.last_reading_at) === Date.parse(d.last_reading_at))) disagree.push(`${d.device_id} last reading differs`);
      else if ((r.state ?? null) !== (d.state ?? null)) disagree.push(`${d.device_id} state differs`);
    }
    conds.push(
      C(
        'agreement',
        'The dashboard and the feed agree',
        disagree.length ? 'fail' : 'pass',
        disagree.length
          ? `${disagree.slice(0, 5).join('; ')}.`
          : `The Monitoring Twin read and the stored feed rows agree on all ${live.length} device(s). This compares the dashboard with what vFarm sent; it does not read vFarm's own database.`,
      ),
    );
  }
  return { test: 'Test 1: canonical sensor-state read', verdict: rollUp(conds), conditions: conds };
}

/** Test 2, from the twin's incidents and Engine health's copy. Pure. */
export function test2(incidents: Incident[], health: HealthRow[]): TestResult {
  const conds: Condition[] = [];
  const silent = incidents.filter((i) => i.kind === 'offline' || i.kind === 'feed_silent');
  if (!silent.length) {
    conds.push(C('incident_opened', 'A silent device opens an incident', 'not_yet_possible', 'No device on this farm has gone quiet past the 15-minute line yet, so nothing has been opened to judge. It needs a real outage, or one made on purpose (unplug a sensor for 16 minutes).'));
    return { test: 'Test 2: silent device to incident and back', verdict: 'not_yet_possible', conditions: conds };
  }
  const newest = [...silent].sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))[0];
  conds.push(C('incident_opened', 'A silent device opens an incident', 'pass', `${silent.length} silent-device incident(s); newest ${newest.incident_id} on ${newest.device_id ?? 'the farm'} at ${newest.opened_at}.`));

  const ledgered = silent.filter((i) => i.ledger_id);
  conds.push(
    C(
      'on_monitoring',
      'It shows on Monitoring and has one canonical id',
      ledgered.length ? 'pass' : newest.ledger_state === 'not_sent' ? 'not_yet_possible' : 'fail',
      ledgered.length ? `${ledgered.length} of ${silent.length} carry a ledger id (newest ${ledgered.sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))[0].ledger_id}).` : `None has a ledger id yet (newest is ${newest.ledger_state}).`,
    ),
  );

  // No duplicates: no two silent incidents for one device overlap in time, and no ledger id is used twice.
  const dupes: string[] = [];
  const byKey = new Map<string, Incident[]>();
  for (const i of silent) byKey.set(`${i.device_id ?? ''}|${i.kind}`, [...(byKey.get(`${i.device_id ?? ''}|${i.kind}`) ?? []), i]);
  for (const [k, list] of byKey) {
    const s = [...list].sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at));
    for (let j = 1; j < s.length; j++) {
      const prevEnd = s[j - 1].closed_at ? Date.parse(s[j - 1].closed_at!) : Infinity;
      if (Date.parse(s[j].opened_at) < prevEnd) dupes.push(`${k.split('|')[0]}: ${s[j - 1].incident_id} and ${s[j].incident_id} open together`);
    }
  }
  const lids = ledgered.map((i) => i.ledger_id!);
  for (const l of new Set(lids)) if (lids.filter((x) => x === l).length > 1) dupes.push(`${l} used twice`);
  const closed = silent.filter((i) => i.closed_at);
  conds.push(
    C(
      'recovers_once',
      'It recovers without a duplicate incident',
      dupes.length ? 'fail' : closed.length ? 'pass' : 'not_yet_possible',
      dupes.length ? dupes.slice(0, 5).join('; ') + '.' : closed.length ? `${closed.length} closed on recovery; no two open at once for one device, no ledger id reused.` : 'None has recovered yet.',
    ),
  );

  // Downstream: Engine health holds the same ledger id, and agrees whether it is closed.
  if (!ledgered.length) {
    conds.push(C('downstream_agrees', 'A downstream reader sees the same incident', 'not_yet_possible', 'Nothing has a ledger id for Engine health to hold.'));
  } else {
    const hOf = new Map<string, HealthRow[]>();
    for (const h of health) hOf.set(h.natural_id, [...(hOf.get(h.natural_id) ?? []), h]);
    // Before 4 Oct 19:00 UTC the ledger's incidents were not copied into Engine health (UN9D path 2), so only those after are judged.
    const judged = ledgered.filter((i) => Date.parse(i.opened_at) >= Date.parse('2026-10-04T19:00:00Z'));
    if (!judged.length) {
      conds.push(C('downstream_agrees', 'A downstream reader sees the same incident', 'not_yet_possible', 'Every ledgered incident predates the copy into Engine health (4 Oct 2026).'));
    } else {
      const bad: string[] = [];
      for (const i of judged) {
        const h = hOf.get(i.ledger_id!) ?? [];
        if (h.length === 0) bad.push(`${i.ledger_id} not on Engine health`);
        else if (h.length > 1) bad.push(`${i.ledger_id} held ${h.length} times on Engine health`);
        else if (!!i.closed_at !== !!h[0].resolved_at) bad.push(`${i.ledger_id} ${i.closed_at ? 'closed' : 'open'} here, ${h[0].resolved_at ? 'closed' : 'open'} on Engine health`);
      }
      conds.push(C('downstream_agrees', 'A downstream reader sees the same incident', bad.length ? 'fail' : 'pass', bad.length ? bad.slice(0, 5).join('; ') + '.' : `Engine health holds each of ${judged.length} incident(s) once, under the same id, open or closed as the twin says.`));
    }
  }
  return { test: 'Test 2: silent device to incident and back', verdict: rollUp(conds), conditions: conds };
}

export class CheckError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function check(farmId: string, opts: { record?: boolean; actor?: string } = {}) {
  const now = Date.now();
  const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const farm = await query<{ farm_id: string; snapshot_at: string; synthetic: boolean }>(
    `SELECT farm_id, ${ISO('snapshot_at')} AS snapshot_at, coalesce((fields->>'synthetic')::boolean, false) AS synthetic FROM engine_vfarm_farms WHERE farm_id = $1`,
    [farmId],
  );
  if (!farm.rows.length) {
    const held = await query<{ farm_id: string; synthetic: boolean }>(`SELECT farm_id, coalesce((fields->>'synthetic')::boolean, false) AS synthetic FROM engine_vfarm_farms ORDER BY farm_id`);
    throw new CheckError(404, `No farm "${farmId}" is held. Held: ${held.rows.map((r) => `${r.farm_id}${r.synthetic ? ' (simulated)' : ''}`).join(', ') || 'none; vFarm has not sent a snapshot yet'}.`);
  }
  const f = farm.rows[0];
  const devices = await query<Device>(
    `SELECT d.device_id, d.place, d.device_type, ${ISO('d.last_reading_at')} AS last_reading_at, ${ISO('d.last_seen_at')} AS last_seen_at, ${ISO('d.snapshot_at')} AS snapshot_at,
            d.gone_at IS NOT NULL AS gone, s.state
       FROM engine_vfarm_devices d LEFT JOIN engine_monitoring_device_state s ON s.device_id = d.device_id WHERE d.farm_id = $1 ORDER BY d.device_id`,
    [farmId],
  );
  const incidents = await query<Incident>(
    `SELECT incident_id, device_id, kind, ${ISO('opened_at')} AS opened_at, ${ISO('closed_at')} AS closed_at, ledger_id, ledger_state FROM engine_monitoring_incidents WHERE farm_id = $1 ORDER BY opened_at`,
    [farmId],
  );
  const ids = incidents.rows.map((i) => i.ledger_id).filter((x): x is string => !!x);
  const health = ids.length
    ? await query<HealthRow>(`SELECT natural_id, ${ISO('resolved_at')} AS resolved_at, fields->>'resolution_status' AS status FROM engine_incidents WHERE natural_id = ANY($1::text[])`, [ids])
    : { rows: [] as HealthRow[] };
  const twin = (await monitoringTwin.monitoringData()) as unknown as { farms: Array<{ farm_id: string; feed: { silent: boolean }; devices: Array<{ device_id: string; state: string | null; last_reading_at: string | null }> }> };
  const mine = twin.farms.find((x) => x.farm_id === farmId) ?? null;
  const t1 = test1(f, devices.rows, mine ? { feed_silent: mine.feed.silent, devices: mine.devices } : null, now);
  const t2 = test2(incidents.rows, health.rows);
  const both = rollUp([...t1.conditions, ...t2.conditions]);
  const result = {
    farm_id: farmId,
    simulated: f.synthetic,
    checked_at: new Date(now).toISOString(),
    verdict: both,
    tests: [t1, t2],
    claim: f.synthetic
      ? 'Simulated farm: this proves the dashboard path, not any rack. NOT_SAFE_TO_CLAIM until both tests pass on a real farm.'
      : both === 'pass'
        ? 'Both tests pass on this farm, as the dashboard holds it. Publication still follows the publication decision record.'
        : 'Not both passing: no monitoring or incident claim about this farm is public or current truth (UN9D publication rule).',
    rule: "Hardik's UN9D tests (30 Sep / 1 Oct 2026, locked by Jason 2 Oct). A test passes only when every condition does.",
    recorded: false as boolean,
    event_id: null as number | null,
  };
  if (opts.record !== false) {
    const ev = await engineEvents.record({
      event_type: 'un9d_acceptance_checked',
      subject_id: farmId,
      lane: 'VFARM_HARDWARE',
      actor: opts.actor ?? 'dashboard',
      detail: { simulated: f.synthetic, verdict: both, test1: t1.verdict, test2: t2.verdict, conditions: [...t1.conditions, ...t2.conditions].map((c) => ({ id: c.id, verdict: c.verdict })) },
    });
    result.recorded = ev.recorded;
    result.event_id = ev.id;
  }
  return result;
}
