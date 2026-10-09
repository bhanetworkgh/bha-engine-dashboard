/**
 * The vFarm gates keeping themselves current (2026-10-09, 7S0O second pass),
 * in process against a real database and a local stand-in for Slack. Every
 * record is a marked fixture on a simulated farm, removed at the end.
 *
 *   1. A record can name a farm; an unknown farm and a real record on a simulated farm are refused.
 *   2. The sweep fills canopy climate from the Monitoring Twin's live verdict (passed), as a sensor
 *      check with its readings, and sets the growth stage from the crop day. A second sweep writes nothing.
 *   3. A reading out of range turns the check failed, with the event and the failed-check alert.
 *   4. A silent feed changes nothing: a verdict is never refreshed from stale readings.
 *   5. While Stage 1 is in progress the owner gets one card per check no sensor covers, and none
 *      for the sensor-fed one. A second sweep sends no second card.
 *   6. A click by somebody not allowed changes nothing. The owner's Passed and Failed clicks record
 *      the checks as manual, with their name, and the card is rewritten. A second click is refused.
 *   7. With all four passed, one card proposes Stage 1 as passed. "Not yet" changes nothing and is
 *      not asked again until a check changes. "Mark passed" passes Stage 1.
 *   8. A card nobody answers expires and is asked again after 48 hours, three times at most, and
 *      the third ask is said in the alerts channel.
 *   9. A card Slack refuses is not silent: card_failed and a VFARM_GATE_ALERT_FAILED event.
 *  10. The scoreboard carries the numbers: checks passed of four, days to target, who was asked,
 *      Stage 2 locked until Stage 1 passes, uptime against its target.
 *
 * Run with:  npm run test:vfarm-gates   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ALERTS = 'C0VFGATES01';
const DESTINY = 'U0AEW3TBYH1';
const JASON = 'U0A9V97949F';
const JEGAN = 'U0TESTJEGAN';
const STRANGER = 'U0TESTOTHER';

const posts = [];
const updates = [];
const ephemerals = [];
let ts = 1791600000;
let refuseDm = false;
const slack = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/chat.update') {
      updates.push(b);
      return res.end(JSON.stringify({ ok: true, channel: b.channel, ts: b.ts }));
    }
    if (u.pathname === '/chat.postEphemeral') {
      ephemerals.push(b);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (refuseDm && b.channel !== ALERTS) return res.end(JSON.stringify({ ok: false, error: 'cannot_dm_bot' }));
    const stamp = `${++ts}.000100`;
    posts.push({ ...b, ts: stamp });
    res.end(JSON.stringify({ ok: true, channel: b.channel.startsWith('U') ? `D${b.channel.slice(1)}` : b.channel, ts: stamp }));
  });
});

(async () => {
  const port = await new Promise((r) => slack.listen(0, '127.0.0.1', () => r(slack.address().port)));
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  process.env.VFARM_GATE_ALERT_CHANNEL = ALERTS;

  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const gates = req('vfarmGates.js');
  const auto = req('vfarmGateAuto.js');
  const twin = req('monitoringTwin.js');
  const feeds = req('systemFeeds.js');

  await migrate();
  await gates.deleteFixtures();
  await query(`UPDATE engine_vfarm_gate_prompts SET status = 'superseded' WHERE status = 'pending'`);

  const T = Date.now();
  const FARM = `SIM-GATE-${T}`;
  const PROFILE = `gate-test-${T}`;
  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log(`  ok  ${name}`);
  };
  const rowOf = async (id) => (await query('SELECT * FROM engine_vfarm_gates WHERE object_id = $1', [id])).rows[0];
  const promptsOf = async (id) => (await query('SELECT * FROM engine_vfarm_gate_prompts WHERE object_id = $1 ORDER BY id', [id])).rows;
  const eventsOf = async (id, type) => (await query('SELECT * FROM engine_events WHERE subject_id = $1 AND event_type = $2 ORDER BY id', [id, type])).rows;
  let snapN = 0;
  const snapshot = async (temperature, humidity, ageSeconds = 5) => {
    const at = new Date(Date.now() + ++snapN * 1000).toISOString();
    await feeds.storeVfarmSnapshot({
      schema: 'vfarm.snapshot.v1',
      taken_at: at,
      farms: [{ id: FARM, name: 'Gate test rack', synthetic: true }],
      devices: [{ id: `${FARM}-th`, farm_id: FARM, device_type: 'temp_humidity_sensor', last_seen_at: at, last_reading_at: new Date(Date.parse(at) - ageSeconds * 1000).toISOString(), latest: { temperature: { value: temperature, unit: 'C' }, humidity: { value: humidity, unit: '%' } } }],
      open_alerts: [],
    });
    await twin.evaluate('snapshot');
  };

  await twin.storeProfile({
    profile_id: PROFILE,
    version: 1,
    crop: 'tomato',
    reason: 'test profile for the gate sweep',
    stages: [{ stage: 'vegetative', label: 'Vegetative', from_day: 0, to_day: 400, targets: { temperature: { min: 18, max: 29, unit: 'C' }, humidity: { min: 60, max: 80, unit: '%' } } }],
  });
  await snapshot(24, 70);
  await twin.storeCycle({ farm_id: FARM, profile_id: PROFILE, transplanted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), synthetic: true, time_scale: 1 });
  await twin.evaluate('snapshot');

  /* 1 */
  const write = (kind, fields, extra = {}) => gates.writeGate({ kind, fields, fixture: true, by: DESTINY, via: 'test', ...extra });
  const refused = async (fn, reason) => {
    let err = null;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof gates.GateRefused, `expected ${reason}, got ${err ? err.message : 'a write'}`);
    assert.equal(err.reason, reason);
  };
  await refused(() => write('stage1', { monitoring_farm_id: 'NO-SUCH-FARM' }), 'unknown_farm');
  await refused(() => gates.writeGate({ kind: 'stage1', fields: { monitoring_farm_id: FARM }, by: DESTINY }), 'simulated_farm');
  await refused(() => write('stage1', { root_zone_moisture_check: { status: 'passed', source: 'sensor' } }), 'no_sensor_yet');
  const target = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const s1 = await write('stage1', { monitoring_farm_id: FARM, owner_slack_id: JEGAN, target_date: target, crop_profile: 'tomatoes' });
  const S1 = s1.record.id;
  ok('a record names its farm; an unknown farm, a real record on a simulated farm and a claimed sensor reading are refused');

  /* 2 */
  {
    const p = posts.length;
    const r = await auto.sweep();
    assert.deepEqual(r.errors, []);
    assert.equal(r.sensor_writes.length, 1);
    const row = await rowOf(S1);
    const c = row.fields.canopy_climate_check;
    assert.equal(c.status, 'passed');
    assert.equal(c.source, 'sensor');
    assert.equal(c.checked_by, 'Monitoring Twin');
    assert.deepEqual(c.value, { temperature: 24, humidity: 70 });
    assert.equal(c.thresholds.humidity.max, 80);
    assert.match(c.evidence_ref, new RegExp(`^monitoring-twin:${FARM}:`));
    assert.match(c.notes, /SIMULATED/);
    assert.equal(row.fields.growth_stage, 'tomato_veg');
    const e = (await eventsOf(S1, 'VFARM_CHECK_UPDATED')).pop();
    assert.equal(e.detail.check, 'canopy_climate_check');
    assert.equal(e.detail.source, 'sensor');
    assert.equal(e.detail.growth_stage, 'tomato_veg');
    assert.equal(posts.length, p, 'a pass posts no alert, and a planned Stage 1 sends no card');
    const again = await auto.sweep();
    assert.equal(again.sensor_writes.length, 0);
    assert.equal((await eventsOf(S1, 'VFARM_CHECK_UPDATED')).length, 1);
    ok('the sweep fills canopy climate from the twin as a sensor check and sets the growth stage; a second sweep writes nothing');
  }

  /* 3 */
  {
    await snapshot(24, 95);
    const p = posts.length;
    const r = await auto.sweep();
    assert.equal(r.sensor_writes.length, 1);
    assert.equal((await rowOf(S1)).fields.canopy_climate_check.status, 'failed');
    assert.equal(posts.length, p + 1);
    assert.equal(posts[p].channel, ALERTS);
    assert.match(posts[p].text, /check failed: Canopy climate/);
    assert.match(posts[p].text, /sensor reading/);
    ok('a reading out of range turns the check failed, with its event and the failed-check alert');
  }

  /* 4 */
  {
    await query(`UPDATE engine_vfarm_farms SET snapshot_at = now() - interval '20 minutes' WHERE farm_id = $1`, [FARM]);
    const r = await auto.sweep();
    assert.equal(r.sensor_writes.length, 0);
    assert.equal((await rowOf(S1)).fields.canopy_climate_check.status, 'failed');
    await snapshot(24, 70);
    await auto.sweep();
    assert.equal((await rowOf(S1)).fields.canopy_climate_check.status, 'passed');
    ok('a silent feed changes nothing; a fresh in-range reading passes the check again');
  }

  /* 5 */
  let cards;
  {
    await write('stage1', { status: 'in_progress' }, { object_id: S1 });
    const p = posts.length;
    const r = await auto.sweep();
    assert.deepEqual(r.errors, []);
    assert.equal(r.prompts_sent.length, 3);
    assert.deepEqual(r.prompts_sent.map((x) => x.check).sort(), ['airflow_velocity_check', 'early_disease_detection_check', 'root_zone_moisture_check']);
    assert.ok(r.prompts_sent.every((x) => x.to === JEGAN && x.ask === 1));
    cards = posts.slice(p);
    assert.equal(cards.length, 3);
    assert.ok(cards.every((c) => c.channel === JEGAN));
    const buttons = cards[0].blocks.find((b) => b.type === 'actions').elements;
    assert.deepEqual(buttons.map((b) => b.text.text), ['Passed', 'Failed']);
    assert.deepEqual(buttons.map((b) => b.action_id), ['engine_approval_approve', 'engine_approval_deny']);
    assert.match(buttons[0].value, /^VFP-\d+-[A-Z0-9]{4}$/);
    assert.ok(auto.isPromptId(buttons[0].value));
    assert.match(cards[0].text, /TEST FIXTURE/);
    const second = await auto.sweep();
    assert.equal(second.prompts_sent.length, 0);
    assert.equal(posts.length, p + 3);
    ok('in progress: one Passed/Failed card per check no sensor covers goes to the owner, none for the sensor-fed one, and none twice');
  }

  /* 6 */
  {
    const prompts = await promptsOf(S1);
    const idOf = (c) => prompts.find((x) => x.check_name === c).prompt_id;
    const no = await auto.decide({ prompt_id: idOf('airflow_velocity_check'), decision: 'approve', user_id: STRANGER });
    assert.equal(no.body.reason, 'not_allowed_to_answer');
    assert.equal(ephemerals.length, 1);
    assert.equal((await rowOf(S1)).fields.airflow_velocity_check, undefined);
    const u = updates.length;
    const yes = await auto.decide({ prompt_id: idOf('airflow_velocity_check'), decision: 'approve', user_id: JEGAN });
    assert.equal(yes.body.ok, true);
    const a = (await rowOf(S1)).fields.airflow_velocity_check;
    assert.equal(a.status, 'passed');
    assert.equal(a.source, 'manual');
    assert.equal(a.checked_by, JEGAN);
    assert.equal(updates.length, u + 1);
    assert.ok(!updates[u].blocks.some((b) => b.type === 'actions'), 'the buttons are gone once answered');
    assert.match(updates[u].text, /Recorded as passed/);
    const twice = await auto.decide({ prompt_id: idOf('airflow_velocity_check'), decision: 'deny', user_id: JEGAN });
    assert.equal(twice.body.reason, 'already_answered');
    assert.equal((await rowOf(S1)).fields.airflow_velocity_check.status, 'passed');
    const p = posts.length;
    const fail = await auto.decide({ prompt_id: idOf('root_zone_moisture_check'), decision: 'deny', user_id: JEGAN });
    assert.equal(fail.body.answer, 'failed');
    assert.equal((await rowOf(S1)).fields.root_zone_moisture_check.status, 'failed');
    assert.equal(posts.length, p + 1);
    assert.match(posts[p].text, /check failed: Root-zone moisture/);
    assert.match(posts[p].text, /checked by a person/);
    await auto.decide({ prompt_id: idOf('early_disease_detection_check'), decision: 'approve', user_id: DESTINY });
    assert.equal((await rowOf(S1)).fields.early_disease_detection_check.checked_by, DESTINY);
    assert.equal((await auto.decide({ prompt_id: 'VFP-1-NOPE', decision: 'approve', user_id: JEGAN })).status, 404);
    ok('a stranger’s click changes nothing; Passed and Failed record the check as manual with the clicker’s name; a second click is refused');
  }

  /* 7 */
  {
    let r = await auto.sweep();
    assert.equal(r.prompts_sent.length, 0, 'a failed check is not asked again, and nothing is proposed while one has failed');
    await write('stage1', { root_zone_moisture_check: { status: 'passed', checked_by: JEGAN } }, { object_id: S1 });
    const p = posts.length;
    r = await auto.sweep();
    assert.equal(r.prompts_sent.length, 1);
    assert.equal(r.prompts_sent[0].kind, 'status');
    assert.equal(r.prompts_sent[0].to, DESTINY, 'a fixture’s proposal goes to whoever made it, never to Jason');
    assert.deepEqual(posts[p].blocks.find((b) => b.type === 'actions').elements.map((b) => b.text.text), ['Mark passed', 'Not yet']);
    const id = r.prompts_sent[0].prompt_id;
    const notYet = await auto.decide({ prompt_id: id, decision: 'deny', user_id: DESTINY });
    assert.equal(notYet.body.answer, 'not_yet');
    assert.equal((await rowOf(S1)).status, 'in_progress');
    assert.equal((await auto.sweep()).prompts_sent.length, 0, 'not asked again while nothing has changed');
    await new Promise((res) => setTimeout(res, 1100));
    await write('stage1', { airflow_velocity_check: { status: 'passed', value: '0.5 m/s' } }, { object_id: S1 });
    r = await auto.sweep();
    assert.equal(r.prompts_sent.length, 1, 'asked again once a check changed');
    const done = await auto.decide({ prompt_id: r.prompts_sent[0].prompt_id, decision: 'approve', user_id: JASON });
    assert.equal(done.body.ok, true);
    const row = await rowOf(S1);
    assert.equal(row.status, 'passed');
    assert.equal(row.updated_by, JASON);
    const e = (await eventsOf(S1, 'VFARM_STAGE1_STATE_CHANGED')).pop();
    assert.equal(e.detail.new_status, 'passed');
    assert.equal(e.detail.via, 'gate-card');
    assert.equal((await auto.sweep()).prompts_sent.length, 0);
    ok('all four passed proposes Stage 1 as passed; "Not yet" changes nothing and waits for a change; "Mark passed" passes it');
  }

  /* 8 */
  const s1b = await write('stage1', { owner_slack_id: JEGAN, status: 'in_progress', canopy_climate_check: { status: 'passed' }, root_zone_moisture_check: { status: 'passed' }, early_disease_detection_check: { status: 'passed' } });
  const S1B = s1b.record.id;
  {
    let r = await auto.sweep();
    assert.equal(r.prompts_sent.length, 1);
    assert.equal(r.prompts_sent[0].ask, 1);
    const age = async (hours) => query(`UPDATE engine_vfarm_gate_prompts SET created_at = created_at - ($2 || ' hours')::interval, expires_at = expires_at - ($2 || ' hours')::interval WHERE object_id = $1`, [S1B, String(hours)]);
    await age(25);
    const u = updates.length;
    r = await auto.sweep();
    assert.equal(r.prompts_expired.length, 1);
    assert.match(updates[u].text, /Nobody answered within 24 hours/);
    assert.equal(r.prompts_sent.length, 0, 'not re-asked before 48 hours');
    await age(24);
    r = await auto.sweep();
    assert.equal(r.prompts_sent[0].ask, 2);
    await age(49);
    const p = posts.length;
    r = await auto.sweep();
    assert.equal(r.prompts_sent[0].ask, 3);
    assert.ok(posts.slice(p).some((m) => m.channel === ALERTS && /still unanswered: Airflow velocity/.test(m.text)));
    await age(49);
    r = await auto.sweep();
    assert.equal(r.prompts_sent.length, 0, 'three asks is the cap');
    ok('an unanswered card expires, is asked again after 48 hours, three times at most, and the third is said in the alerts channel');
  }

  /* 9 */
  {
    const s1c = await write('stage1', { owner_slack_id: JEGAN, status: 'in_progress', canopy_climate_check: { status: 'passed' }, root_zone_moisture_check: { status: 'passed' }, early_disease_detection_check: { status: 'passed' } });
    refuseDm = true;
    const r = await auto.sweep();
    refuseDm = false;
    assert.equal(r.prompts_sent.length, 0);
    assert.ok(r.errors.some((e) => e.includes('cannot_dm_bot')));
    const pr = await promptsOf(s1c.record.id);
    assert.equal(pr[0].status, 'card_failed');
    assert.equal((await eventsOf(s1c.record.id, 'VFARM_GATE_ALERT_FAILED')).length, 1);
    const retry = await auto.sweep();
    assert.equal(retry.prompts_sent.length, 1, 'a card that never went out does not use up an ask');
    ok('a card Slack refuses is card_failed with a VFARM_GATE_ALERT_FAILED event, and is sent on the next sweep');
  }

  /* 10 */
  {
    const s2 = await write('stage2', { stage1_ref: S1B, monitoring_farm_id: FARM, uptime_target_pct: 99, alert_volume_budget_per_week: 5, rack_count: 5 });
    const b = await auto.scoreboard();
    const one = b.boards[S1];
    assert.equal(one.checks_passed, 4);
    assert.equal(one.checks_total, 4);
    assert.equal(one.days_to_target, 10);
    assert.equal(one.days_in_status, 0);
    assert.equal(one.farm.simulated, true);
    assert.equal(one.checks.canopy_climate_check.fed_by, 'sensor');
    assert.equal(one.checks.airflow_velocity_check.fed_by, 'person');
    const two = b.boards[S1B];
    assert.equal(two.checks_passed, 3);
    assert.equal(two.checks_pending, 1);
    assert.equal(two.checks.airflow_velocity_check.asked_user, null, 'its three asks are spent and none is open');
    const st2 = b.boards[s2.record.id];
    assert.equal(st2.locked, true);
    assert.equal(st2.stage1_status, 'in_progress');
    assert.equal(st2.uptime_target_pct, 99);
    assert.equal(typeof st2.uptime_pct, 'number');
    assert.equal(typeof st2.incidents_7d, 'number');
    assert.equal(b.pipeline.length, 3);
    assert.ok(b.pipeline.every((x) => !String(x.record_id ?? '').startsWith('FIXTURE-')), 'a fixture never stands in the strip');
    assert.ok(b.prompts_waiting.some((x) => x.fixture === true));
    assert.ok(Array.isArray(b.stage1) && b.stage1.some((x) => x.id === S1));
    ok('the scoreboard carries checks passed of four, days to target, who was asked, the Stage 2 lock and uptime against its target');
  }

  await gates.deleteFixtures();
  const left = await auto.sweep();
  assert.deepEqual(left.errors, []);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_vfarm_gate_prompts WHERE status = 'pending' AND object_id LIKE 'FIXTURE-%'`)).rows[0].n, 0, 'cards about deleted fixtures are closed');
  await query(`DELETE FROM engine_vfarm_gate_prompts WHERE object_id LIKE 'FIXTURE-%'`);
  for (const t of ['engine_monitoring_device_state', 'engine_vfarm_devices']) await query(`DELETE FROM ${t} WHERE device_id = $1`, [`${FARM}-th`]);
  for (const t of ['engine_monitoring_incidents', 'engine_monitoring_cycles', 'engine_monitoring_watch', 'engine_vfarm_farms']) await query(`DELETE FROM ${t} WHERE farm_id = $1`, [FARM]);
  await query(`DELETE FROM engine_monitoring_profiles WHERE profile_id = $1`, [PROFILE]);
  console.log(`\n${passed} checks passed.`);
  slack.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
