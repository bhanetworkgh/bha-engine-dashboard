/**
 * The Halloween hero bay (FOCB, 30 Oct 2026). Pure, plus a stand-in database that records every
 * statement: no real database, no network.
 * Run with:  npm run test:hero-bay   (builds the server first)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const hb = require(path.join(DIST, 'server/src', 'heroBay.js'));
const SRC = path.join(__dirname, '../src');
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const NOW = Date.parse('2026-10-30T16:15:00Z');
const PROFILE = {
  version: 2,
  content: {
    crop: 'tomato',
    day0: 'first_flower_entry',
    reference_only_stages: [{ stage: 'nursery', where: 'supplier' }, { stage: 'vegetative', where: 'supplier' }],
    stages: [
      { stage: 'flowering', label: 'Flowering and pollination', from_day: 0, to_day: 9, targets: { ph: { min: 5.8, max: 6.4, unit: 'pH' }, ec: { min: 2, max: 3, unit: 'mS/cm' } } },
      { stage: 'fruit_set', label: 'Fruit set and development', from_day: 10, to_day: 44, targets: { ph: { min: 5.8, max: 6.3, unit: 'pH' } } },
      { stage: 'harvest', label: 'Harvest window', from_day: 45, to_day: 85, targets: {} },
    ],
  },
};
const dht = (o = {}) => ({
  device_id: 'rack2_dht', device_type: 'temp_humidity_sensor', model: 'dht11', status: 'online',
  last_seen_at: '2026-10-30T16:14:30Z', last_reading_at: '2026-10-30T16:14:30Z', snapshot_at: '2026-10-30T16:14:50Z',
  latest: { temperature: { value: 29.6, unit: 'celsius', status: 'ok' }, humidity: { value: 56, unit: 'percent_rh', status: 'ok' } },
  ...o,
});
const farm = (snap = '2026-10-30T16:14:50Z') => ({ farm_id: '21dde23e-f7f6-46bc-9b54-e97fabaaafd7', snapshot_at: snap });
const build = (input = {}, now = NOW) => hb.buildHeroBay({ farm: farm(), device: dht(), profile: PROFILE, ...input }, now);
const field = (b, k) => b.fields.find((f) => f.key === k);

// ── 1. stale real telemetry never reads live ────────────────────────────
let b = build();
assert.equal(field(b, 'temperature').state, 'LIVE'); assert.equal(field(b, 'temperature').class, 'REAL');
assert.equal(field(b, 'temperature').value, 29.6); assert.equal(field(b, 'humidity').value, 56);
assert.equal(field(b, 'temperature').observed_at, '2026-10-30T16:14:30Z');
ok('a DHT11 reading 20 s old at a 25 s old snapshot is REAL and LIVE, with its observation time');

b = build({ device: dht({ last_reading_at: '2026-10-30T16:10:00Z' }) });
assert.equal(field(b, 'temperature').state, 'STALE'); assert.equal(field(b, 'temperature').class, 'REAL');
assert.match(field(b, 'temperature').note, /older than the twin's 90 s live window/);
b = build({ device: dht({ last_reading_at: '2026-10-30T15:00:00Z' }) });
assert.equal(field(b, 'humidity').state, 'OFFLINE');
b = build({ device: dht({ status: 'offline' }) });
assert.equal(field(b, 'temperature').state, 'OFFLINE'); assert.equal(field(b, 'temperature').value, 29.6);
assert.match(field(b, 'temperature').note, /last real reading before the sensor went offline; not current/);
ok('older than 90 s is STALE, older than 900 s or status offline is OFFLINE; the last value stays, marked not current');

b = build({ farm: farm('2026-10-30T16:13:04Z'), device: dht({ last_reading_at: '2026-10-30T16:13:00Z', snapshot_at: '2026-10-30T16:13:04Z' }) }, Date.parse('2026-10-30T23:30:00Z'));
assert.equal(field(b, 'temperature').state, 'NO_FEED'); assert.equal(b.feed.silent, true);
assert.match(field(b, 'temperature').note, /feed has gone quiet/);
ok('a reading that was LIVE when vFarm last looked is NO_FEED once the feed is silent past 600 s (the 30 Oct case)');

// ── 2. missing telemetry is UNKNOWN, never filled ───────────────────────
b = build({ device: null });
for (const k of ['temperature', 'humidity']) {
  assert.equal(field(b, k).value, null); assert.equal(field(b, k).state, 'UNKNOWN'); assert.equal(field(b, k).class, 'NOT_VERIFIED');
}
b = build({ device: dht({ latest: { temperature: { value: 28, unit: 'celsius' } } }) });
assert.equal(field(b, 'humidity').value, null); assert.equal(field(b, 'humidity').state, 'UNKNOWN');
assert.equal(field(b, 'temperature').value, 28);
b = build({ farm: null, device: null });
assert.equal(b.bay.farm_id, null); assert.match(b.bay.note, /does not list this farm/); assert.equal(b.feed.silent, true);
ok('no sensor, a missing metric or no farm reads null and UNKNOWN; nothing is invented');

// ── 3. every field is classed, sourced and explained ────────────────────
const CLASSES = ['REAL', 'SIMULATED', 'NOT_VERIFIED'];
for (const input of [{}, { device: null }, { farm: null, device: null }, { profile: null }, { device: dht({ status: 'offline' }) }]) {
  const out = build(input);
  assert.deepEqual(out.fields.map((f) => f.key), ['temperature', 'humidity', 'lights', 'water', 'ec', 'ph', 'growth_stage', 'crop_day']);
  for (const f of out.fields) {
    assert.ok(CLASSES.includes(f.class), `${f.key} class`);
    assert.ok(f.source && f.note, `${f.key} source and note`);
    if (f.class !== 'REAL') assert.equal(f.observed_at, null, `${f.key}: only a REAL value has an observation time`);
    if (f.class === 'REAL') assert.ok(f.observed_at && f.value !== null && f.state, `${f.key}: REAL has value, time and state`);
    if (f.class === 'SIMULATED') assert.equal(f.state, null, `${f.key}: a story value has no freshness`);
  }
  assert.ok(CLASSES.includes(out.bay.class) && CLASSES.includes(out.cad.class));
  assert.equal(out.story.class, 'SIMULATED'); assert.equal(out.read_only, true);
}
ok('every displayed field is REAL, SIMULATED or NOT_VERIFIED, with a source and a note, across five input shapes');

// ── 4. simulated crop progress is labelled, and never borrows a reading ─
b = build({ device: dht({ latest: { temperature: { value: 29 }, humidity: { value: 50 }, ph: { value: 9.9 }, ec: { value: 9.9 } } }) });
assert.equal(field(b, 'growth_stage').class, 'SIMULATED'); assert.equal(field(b, 'growth_stage').value, 'Flowering and pollination');
assert.equal(field(b, 'crop_day').class, 'SIMULATED'); assert.equal(field(b, 'crop_day').value, 1.7);
assert.equal(field(b, 'ph').class, 'SIMULATED'); assert.equal(field(b, 'ph').value, 6.1);
assert.equal(field(b, 'ec').value, 2.5);
assert.match(field(b, 'ph').note, /illustrative.*still under development and validation\. Not a sensor reading, and nothing on the rack is controlled to it/);
assert.deepEqual(b.story.stages.map((s) => `${s.where}:${s.stage}`), ['supplier:nursery', 'supplier:vegetative', 'cabinet:flowering', 'cabinet:fruit_set', 'cabinet:harvest']);
assert.equal(b.story.current_stage, 'flowering'); assert.match(b.story.note, /Nothing here was measured/);
b = build({}, Date.parse('2026-11-10T00:00:00Z'));
assert.equal(field(b, 'ec').value, null); assert.match(field(b, 'ec').note, /no EC target in the profile for this stage/);
b = build({ profile: null });
assert.equal(field(b, 'growth_stage').value, null); assert.equal(b.story.stages.length, 0);
ok('stage, day, EC and pH are SIMULATED from the profile; a reading named ph or ec is never borrowed; no target means no value');

// ── 5. no relay map, no light or pump state ─────────────────────────────
for (const out of [build(), build({ device: null })]) {
  for (const k of ['lights', 'water']) {
    assert.equal(field(out, k).class, 'NOT_VERIFIED'); assert.equal(field(out, k).value, null); assert.equal(field(out, k).state, null);
    assert.match(field(out, k).note, /recorded command mapping is not an observed load state|recorded command mapping, not an observed load state/);
  }
  assert.match(field(out, 'lights').note, /led_light_01\) on relay_m2_3/);
  assert.match(field(out, 'water').note, /drain_pump_01\) on relay_m3_1 \(CH9\); the pump's channel is not yet verified/);
}
assert.ok(!/relay_m\d_\d['"]?\s*[:=]/.test(fs.readFileSync(path.join(SRC, 'heroBay.ts'), 'utf8')), 'no relay channel drives a state in code');
ok('lights and water are NOT_VERIFIED and empty; the notes name the recorded LED and drain mappings, the unverified pump, and that a mapping is not a load state');

// ── Jason's wording contract (31 Oct 2026) ──────────────────────────────
const words = JSON.stringify(build());
for (const bad of [/no autonomous irrigation/i, /\bself[- ]?(heal|repair)/i, /repairs? (the )?hardware/i, /smart irrigation/i,
  /cannot overrun/i, /max-run (cut-off )?(is )?(active|verified) on/i, /(?<!not )sensor-driven (irrigation|watering)/i]) {
  assert.ok(!bad.test(words), `the bay never says ${bad}`);
}
const irrigation = build().not_claimed.find((s) => /time schedule/.test(s));
assert.match(irrigation, /not sensor-driven/); assert.match(irrigation, /await runtime confirmation/);
assert.match(irrigation, /implemented and reviewed but not yet runtime-verified on the installed rack/);
ok('scheduled, time-based watering is stated; no sensor-driven irrigation, no repair claim, max-run only as code not yet verified on the rack');

// ── 6. unverified CAD is never canonical ────────────────────────────────
b = build();
assert.equal(b.cad.canonical, false); assert.equal(b.cad.class, 'NOT_VERIFIED'); assert.equal(b.cad.onshape_version, null);
assert.match(b.cad.note, /not the canonical CAD/);
assert.deepEqual([b.cad.width_mm, b.cad.depth_mm, b.cad.height_mm, b.cad.tiers], [1200, 500, 1800, 2]);
const cad = hb.HERO_BAY.cad;
cad.onshape_version = 'v-test';
assert.equal(build().cad.canonical, false, 'a version nobody checked against the rack is still not canonical');
cad.verified_by = 'test';
assert.equal(build().cad.canonical, true); assert.equal(build().cad.class, 'REAL');
cad.onshape_version = null; cad.verified_by = null;
ok('CAD is NOT_VERIFIED and never canonical without both a pinned Onshape version and a person who checked it');

// ── 6b. reported cabinet identity is shown, never verified ──────────────
const HASH = '5a7f8948f7e8ff3de5abe2a0dbefe262f87b0c1e4e16dd5022869c5b09ee0363';
b = build({ farm: { ...farm(), fields: { cabinet_id: 'VFARM-CAB-001', config_hash: HASH, burn_in_state: null } } });
assert.equal(b.bay.cabinet_id, 'VFARM-CAB-001'); assert.equal(b.bay.config_hash, HASH); assert.equal(b.bay.burn_in_state, null);
assert.equal(b.bay.class, 'NOT_VERIFIED'); assert.equal(b.cad.class, 'NOT_VERIFIED'); assert.equal(b.cad.canonical, false);
assert.match(b.bay.note, /vFarm reports cabinet VFARM-CAB-001 and a config_hash/);
assert.match(b.bay.note, /reported identifier, not verified provenance/); assert.match(b.bay.note, /no burn-in has passed/);
assert.doesNotMatch(b.bay.note, /sends no cabinet_id/);
b = build({ farm: { ...farm(), fields: { cabinet_id: 'VFARM-CAB-001', burn_in_state: 'passed' } } });
assert.equal(b.bay.class, 'NOT_VERIFIED'); assert.equal(b.bay.config_hash, null); assert.match(b.bay.note, /and no config_hash/);
assert.match(b.bay.note, /burn-in alone does not make it canonical/);
ok('a reported cabinet_id and config_hash are shown as reported; the bay and CAD stay NOT_VERIFIED, even with burn-in passed');

for (const fields of [undefined, null, {}, { cabinet_id: '  ', config_hash: 42 }, 'not an object']) {
  b = build({ farm: { ...farm(), fields } });
  assert.equal(b.bay.cabinet_id, null, `cabinet_id from ${JSON.stringify(fields)}`); assert.equal(b.bay.class, 'NOT_VERIFIED');
  assert.match(b.bay.note, /vFarm sends no cabinet_id yet/);
}
b = build({ farm: null });
assert.equal(b.bay.cabinet_id, null); assert.equal(b.bay.config_hash, null); assert.equal(b.bay.burn_in_state, null);
ok('no identity, a null, blank or non-object fields block, or no farm gives nulls and says vFarm sends no cabinet_id; nothing is guessed');

// ── 7 and 8. read only: SELECTs, one GET route, no write or control path ─
(async () => {
  const seen = [];
  const db = {
    async query(sql, params) {
      seen.push(sql.trim());
      if (/engine_vfarm_farms/.test(sql)) return { rows: [{ farm_id: farm().farm_id, snapshot_at: new Date('2026-10-30T16:14:50Z'), fields: { cabinet_id: 'VFARM-CAB-001', config_hash: HASH } }], rowCount: 1 };
      if (/engine_vfarm_devices/.test(sql)) {
        const d = dht();
        return { rows: [{ ...d, last_seen_at: new Date(d.last_seen_at), last_reading_at: new Date(d.last_reading_at), snapshot_at: new Date(d.snapshot_at) }], rowCount: 1 };
      }
      if (/engine_monitoring_profiles/.test(sql)) return { rows: [PROFILE], rowCount: 1 };
      throw new Error('unexpected query: ' + sql);
    },
  };
  const out = await hb.heroBayData(db);
  assert.equal(seen.length, 3); assert.ok(seen.every((s) => /^SELECT\b/i.test(s)), 'every statement is a SELECT');
  assert.equal(field(out, 'temperature').observed_at, '2026-10-30T16:14:30.000Z');
  assert.match(seen[0], /SELECT farm_id, snapshot_at, fields FROM engine_vfarm_farms/);
  assert.equal(out.bay.cabinet_id, 'VFARM-CAB-001'); assert.equal(out.bay.class, 'NOT_VERIFIED');
  ok('heroBayData issues three SELECTs and nothing else, reads the farm\'s reported identity, and passes database dates through as ISO');

  const src = fs.readFileSync(path.join(SRC, 'heroBay.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const w of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /withTransaction/, /\bfetch\(/, /mirror\./, /engineWrite/, /device_commands/, /storeCycle|storeProfile/]) {
    assert.ok(!w.test(src), `heroBay.ts has no ${w}`);
  }
  const index = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  const at = index.indexOf("case '/api/vfarm-hero-bay'");
  assert.ok(at > 0 && index.lastIndexOf("if (method === 'GET')", at) > 0, 'the route sits in the GET switch');
  assert.equal(index.split('/api/vfarm-hero-bay').length - 1, 1, 'one route, no other method');
  ok('heroBay.ts has no write, transaction, network call or command; its only route is one GET');

  // Existing consumers: nothing in the twin or the snapshot path was changed to make this work.
  const mt = require(path.join(DIST, 'server/src', 'monitoringTwin.js'));
  assert.deepEqual(mt.THRESHOLDS, { stale_s: 90, offline_s: 900, feed_silent_s: 600 });
  assert.equal(mt.freshness('2026-10-30T16:14:30Z', '2026-10-30T16:14:50Z', 'online', null, 'temp_humidity_sensor').state, 'LIVE');
  ok('the Monitoring Twin\'s thresholds and freshness rule are the ones the hero bay reads, unchanged');

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
