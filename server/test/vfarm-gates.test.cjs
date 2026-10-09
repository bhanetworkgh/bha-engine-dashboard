/**
 * The vFarm stage gates and 5-rack offer (2026-10-09, LOOP-1791479575963-7S0O),
 * pinned in process against a real database and a local stand-in for Slack.
 * This is the repeatable procedure Jason asked for: every record it writes is
 * a marked fixture, and it removes them at the end.
 *
 *   1. A Stage 1 fixture is created as planned, with a VFARM_STAGE1_STATE_CHANGED event and one alert.
 *   2. A Stage 2 with no Stage 1 is refused (stage1_required); one can be created as planned.
 *   3. HARD GATE: Stage 2 cannot go in_progress, passed or failed while Stage 1 is not passed
 *      (stage1_not_passed): nothing written, no event, no alert.
 *   4. A failed check writes VFARM_CHECK_UPDATED (which check, outcome, value, manual, who, when,
 *      crop and growth-stage tags) and posts the failed-check alert.
 *   5. The three checks with no sensor refuse source "sensor" (no_sensor_yet); canopy climate takes it.
 *   6. A field the contract does not have is refused (unknown_field); a bad status too.
 *   7. Once Stage 1 is passed, Stage 2 starts, with VFARM_STAGE2_STATE_CHANGED pointing at the checks.
 *   8. HARD GATE: an offer cannot be offered or signed without a Stage 2 row (stage2_required);
 *      tied by stage2_ref it can, and VFARM_OFFER_STATE_CHANGED carries the Stage 2 row.
 *   9. A real record cannot point at a fixture, and a fixture cannot point at a real record.
 *  10. An Early Access lead is tied to an offer; an unknown lead is refused; a fixture offer is
 *      not shown on the lead, a real one is.
 *  11. A Slack post that is refused is not silent: raise: true and a VFARM_GATE_ALERT_FAILED event.
 *  12. The same write twice changes nothing and sends nothing. A dry run writes nothing.
 *  13. The MCP tool refuses the same way and audits it; the Bays token has it, not the delete.
 *  14. Deleting fixtures removes fixtures only; their events stay, marked fixture.
 *
 * Run with:  npm run test:vfarm-gates   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:vfarm-gates writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ALERTS = 'C0VFGATES01';
const DESTINY = 'U0AEW3TBYH1';
const JASON = 'U0A9V97949F';

const posts = [];
let ts = 1791500000;
let refuse = false;
const slack = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (refuse) return res.end(JSON.stringify({ ok: false, error: 'not_in_channel' }));
    const stamp = `${++ts}.000100`;
    posts.push({ ...b, ts: stamp });
    res.end(JSON.stringify({ ok: true, channel: b.channel, ts: stamp }));
  });
});

(async () => {
  const port = await new Promise((r) => slack.listen(0, '127.0.0.1', () => r(slack.address().port)));
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  process.env.VFARM_GATE_ALERT_CHANNEL = ALERTS;
  process.env.MCP_AGENT_TOKEN_BAYS = 'test-bays-token';

  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const gates = req('vfarmGates.js');
  const earlyAccess = req('earlyAccess.js');
  const { toolByName, toolCatalogue } = req('mcp/tools.js');

  await migrate();
  await gates.deleteFixtures();

  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log(`  ok  ${name}`);
  };
  const write = (kind, fields, extra = {}) => gates.writeGate({ kind, fields, fixture: true, by: DESTINY, via: 'test', ...extra });
  const refused = async (fn, reason) => {
    const rows = (await query('SELECT count(*)::int AS n FROM engine_vfarm_gates')).rows[0].n;
    const evs = (await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type LIKE 'VFARM%'`)).rows[0].n;
    const p = posts.length;
    let err = null;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof gates.GateRefused, `expected a refusal (${reason}), got ${err ? err.message : 'a write'}`);
    assert.equal(err.reason, reason);
    assert.equal((await query('SELECT count(*)::int AS n FROM engine_vfarm_gates')).rows[0].n, rows, 'a refusal wrote a row');
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type LIKE 'VFARM%'`)).rows[0].n, evs, 'a refusal wrote an event');
    assert.equal(posts.length, p, 'a refusal posted an alert');
    return err;
  };
  const eventsOf = async (id, type) => (await query('SELECT * FROM engine_events WHERE subject_id = $1 AND event_type = $2 ORDER BY id', [id, type])).rows;
  const rowOf = async (id) => (await query('SELECT * FROM engine_vfarm_gates WHERE object_id = $1', [id])).rows[0];

  /* 1 */
  const s1 = await write('stage1', { loop_ref: 'LOOP-1791428275782-TU4O', target_cabinet_config_hash: 'fixture-hash-01', cad_revision: 'fixture-rev-A', crop_profile: 'tomatoes', growth_stage: 'tomato_veg', owner_slack_id: DESTINY, target_date: '2026-10-20' });
  const S1 = s1.record.id;
  {
    assert.equal(s1.written, true);
    assert.match(S1, /^FIXTURE-VFS1-\d+-[A-Z0-9]{4}$/);
    assert.equal(s1.record.status, 'planned');
    assert.equal(s1.record.contract, 'VFARM_STAGE1_LAB_VALIDATION_v1');
    assert.equal(s1.record.fixture, true);
    const e = await eventsOf(S1, 'VFARM_STAGE1_STATE_CHANGED');
    assert.equal(e.length, 1);
    assert.equal(e[0].detail.old_status, null);
    assert.equal(e[0].detail.new_status, 'planned');
    assert.equal(e[0].detail.fixture, true);
    assert.equal(e[0].detail.crop_profile, 'tomatoes');
    assert.equal(e[0].detail.growth_stage, 'tomato_veg');
    assert.equal(e[0].detail.changed_by, DESTINY);
    assert.equal(e[0].detail.checks.canopy_climate_check.status, 'pending');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, ALERTS);
    assert.match(posts[0].text, /TEST FIXTURE/);
    assert.match(posts[0].text, /created as \*planned\*/);
    ok('Stage 1 fixture created as planned, with its event and one labelled alert');
  }

  /* 2 */
  await refused(() => write('stage2', { rack_count: 5 }), 'stage1_required');
  await refused(() => write('stage2', { stage1_ref: 'VFS1-0-NOPE' }), 'stage1_required');
  const s2 = await write('stage2', { stage1_ref: S1, loop_ref: 'LOOP-1791428275782-TU4O', rack_count: 5, crop_profile: 'tomatoes', growth_stage: 'tomato_veg', pilot_site_profile_id: 'fixture-site-01' });
  const S2 = s2.record.id;
  assert.equal(s2.record.status, 'planned');
  assert.equal(s2.record.stage1_ref, S1);
  ok('Stage 2 needs a Stage 1 row; with one it is created as planned');

  /* 3 — the first hard gate */
  for (const st of ['in_progress', 'passed', 'failed']) {
    const e = await refused(() => write('stage2', { status: st }, { object_id: S2 }), 'stage1_not_passed');
    assert.equal(e.extra.stage1_status, 'planned');
    assert.match(e.message, /Stage 1 .* is planned, not passed/);
  }
  await refused(() => write('stage2', { stage1_ref: S1, status: 'in_progress' }), 'stage1_not_passed');
  await write('stage1', { status: 'in_progress' }, { object_id: S1 });
  await refused(() => write('stage2', { status: 'in_progress' }, { object_id: S2 }), 'stage1_not_passed');
  assert.equal((await rowOf(S2)).status, 'planned');
  ok('HARD GATE: Stage 2 is refused in_progress, passed and failed while Stage 1 is not passed');

  /* 4 — a failed check */
  {
    const p = posts.length;
    const r = await write('stage1', { airflow_velocity_check: { status: 'failed', value: '0.1 m/s', thresholds: 'fixture threshold', notes: 'fixture: airflow below the test band', checked_by: JASON, evidence_ref: 'fixture-evidence-1' } }, { object_id: S1 });
    assert.deepEqual(r.checks_updated, ['airflow_velocity_check']);
    assert.deepEqual(r.events, ['VFARM_CHECK_UPDATED']);
    const e = (await eventsOf(S1, 'VFARM_CHECK_UPDATED')).pop();
    assert.equal(e.detail.check, 'airflow_velocity_check');
    assert.equal(e.detail.outcome, 'failed');
    assert.equal(e.detail.value, '0.1 m/s');
    assert.equal(e.detail.source, 'manual');
    assert.equal(e.detail.checked_by, JASON);
    assert.ok(!Number.isNaN(Date.parse(e.detail.checked_at)));
    assert.equal(e.detail.growth_stage, 'tomato_veg');
    assert.equal(e.detail.crop_profile, 'tomatoes');
    assert.equal(posts.length, p + 1);
    assert.match(posts[p].text, /check failed: Airflow velocity/);
    assert.match(posts[p].text, /checked by a person/);
    assert.match(posts[p].text, /TEST FIXTURE/);
    assert.equal(r.alerts[0].ok, true);
    // A pass is an event and no alert.
    const q = await write('stage1', { canopy_climate_check: { status: 'passed', source: 'sensor', value: { temp_c: 24 } } }, { object_id: S1 });
    assert.deepEqual(q.events, ['VFARM_CHECK_UPDATED']);
    assert.equal(q.alerts.length, 0);
    assert.equal(q.record.canopy_climate_check.checked_by, DESTINY);
    ok('a failed check writes VFARM_CHECK_UPDATED with its provenance and tags, and posts the alert; a pass posts none');
  }

  /* 5 */
  for (const c of ['root_zone_moisture_check', 'airflow_velocity_check', 'early_disease_detection_check']) {
    await refused(() => write('stage1', { [c]: { status: 'passed', source: 'sensor' } }, { object_id: S1 }), 'no_sensor_yet');
  }
  ok('the three checks with no sensor refuse source "sensor"; canopy climate accepted it');

  /* 6 */
  {
    const e = await refused(() => write('stage1', { humidity_check: { status: 'passed' } }, { object_id: S1 }), 'unknown_field');
    assert.deepEqual(e.extra.unknown_fields, ['humidity_check']);
    await refused(() => write('stage1', { status: 'done' }, { object_id: S1 }), 'bad_status');
    await refused(() => write('offer', { status: 'passed' }), 'bad_status');
    await refused(() => write('stage1', { canopy_climate_check: { status: 'ok' } }, { object_id: S1 }), 'bad_check_status');
    await refused(() => write('stage1', { canopy_climate_check: { verdict: 'x' } }, { object_id: S1 }), 'unknown_field');
    await refused(() => write('stage1', { target_date: '20 October' }, { object_id: S1 }), 'bad_value');
    await refused(() => gates.writeGate({ kind: 'stage1', fields: {}, fixture: true, by: '' }), 'who_is_required');
    await refused(() => write('stage3', {}), 'unknown_kind');
    await refused(() => write('stage1', {}, { object_id: S2 }), 'kind_mismatch');
    await refused(() => write('stage2', { stage1_ref: 'OTHER' }, { object_id: S2 }), 'ref_is_fixed');
    ok('a field or status the contract does not have is refused, and so is a change with no author');
  }

  /* 7 */
  {
    await write('stage1', { airflow_velocity_check: { status: 'passed', value: '0.4 m/s' } }, { object_id: S1 });
    // Jason, 9 Oct: Stage 1 is passed only when all four checks are passed, at the write boundary.
    const n0 = (await query(`SELECT count(*)::int AS n FROM engine_events WHERE subject_id = $1`, [S1])).rows[0].n;
    const p0 = posts.length;
    const no = await refused(() => write('stage1', { status: 'passed' }, { object_id: S1 }), 'checks_not_passed');
    assert.deepEqual(no.extra.checks_not_passed, { root_zone_moisture_check: 'pending', early_disease_detection_check: 'pending' });
    assert.match(no.message, /only when all four checks are passed/);
    // a check failed in the same call as status passed is refused as well, and nothing of it is kept
    const no2 = await refused(() => write('stage1', { status: 'passed', root_zone_moisture_check: { status: 'failed' }, early_disease_detection_check: { status: 'passed' } }, { object_id: S1 }), 'checks_not_passed');
    assert.deepEqual(no2.extra.checks_not_passed, { root_zone_moisture_check: 'failed' });
    // so is a new record created as passed, and a dry run of the same
    await refused(() => write('stage1', { status: 'passed', canopy_climate_check: { status: 'passed' } }), 'checks_not_passed');
    await refused(() => write('stage1', { status: 'passed' }, { object_id: S1, dry_run: true }), 'checks_not_passed');
    assert.equal((await query(`SELECT status FROM engine_vfarm_gates WHERE object_id = $1`, [S1])).rows[0].status, 'in_progress');
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE subject_id = $1`, [S1])).rows[0].n, n0, 'a refused write leaves no event');
    assert.equal(posts.length, p0, 'a refused write posts no alert');
    await write('stage1', { root_zone_moisture_check: { status: 'passed' }, early_disease_detection_check: { status: 'passed' } }, { object_id: S1 });
    const p = posts.length;
    const a = await write('stage1', { status: 'passed' }, { object_id: S1 });
    assert.deepEqual(a.status_change, { from: 'in_progress', to: 'passed' });
    assert.match(posts[p].text, /in_progress → \*passed\*/);
    const r = await write('stage2', { status: 'in_progress', growth_stage: 'tomato_flower' }, { object_id: S2 });
    assert.deepEqual(r.status_change, { from: 'planned', to: 'in_progress' });
    const e = (await eventsOf(S2, 'VFARM_STAGE2_STATE_CHANGED')).pop();
    assert.equal(e.detail.old_status, 'planned');
    assert.equal(e.detail.new_status, 'in_progress');
    assert.equal(e.detail.stage1_ref, S1);
    assert.equal(e.detail.stage1_status, 'passed');
    assert.equal(e.detail.checks_ref, S1);
    assert.equal(e.detail.checks.airflow_velocity_check.status, 'passed');
    assert.equal(e.detail.pilot_site_profile_id, 'fixture-site-01');
    assert.equal(e.detail.rack_count, 5);
    assert.equal(e.detail.growth_stage, 'tomato_flower');
    ok('once Stage 1 is passed, Stage 2 starts, and its event points at the checks behind it');
  }

  /* 8 — the second hard gate */
  let OF;
  {
    const o = await write('offer', { loop_ref: 'LOOP-1791428275485-L2KO', rack_count: 5 });
    OF = o.record.id;
    assert.equal(o.record.status, 'draft');
    await write('offer', { status: 'under_review' }, { object_id: OF });
    await write('offer', { status: 'final' }, { object_id: OF });
    for (const st of ['offered', 'signed']) await refused(() => write('offer', { status: st }, { object_id: OF }), 'stage2_required');
    await refused(() => write('offer', { status: 'offered' }), 'stage2_required');
    await refused(() => write('offer', { stage2_ref: S1 }, { object_id: OF }), 'stage2_required');
    await refused(() => write('offer', { stage2_ref: 'VFS2-0-NOPE', status: 'offered' }, { object_id: OF }), 'stage2_required');
    assert.equal((await rowOf(OF)).status, 'final');
    const r = await write('offer', { stage2_ref: S2, status: 'offered' }, { object_id: OF });
    assert.deepEqual(r.status_change, { from: 'final', to: 'offered' });
    const e = (await eventsOf(OF, 'VFARM_OFFER_STATE_CHANGED')).pop();
    assert.equal(e.detail.stage2_ref, S2);
    assert.equal(e.detail.stage2.id, S2);
    assert.equal(e.detail.stage2.status, 'in_progress');
    assert.equal(e.detail.stage2.stage1_ref, S1);
    assert.equal(e.detail.stage2.growth_stage, 'tomato_flower');
    await refused(() => write('offer', { stage2_ref: 'SOMETHING-ELSE' }, { object_id: OF }), 'ref_is_fixed');
    ok('HARD GATE: an offer is refused offered and signed without a Stage 2 row; tied, its event carries the pilot');
  }

  /* 9 */
  {
    await refused(() => gates.writeGate({ kind: 'stage2', fields: { stage1_ref: S1 }, by: DESTINY }), 'fixture_ref');
    await refused(() => gates.writeGate({ kind: 'offer', fields: { stage2_ref: S2 }, by: DESTINY }), 'fixture_ref');
    await refused(() => write('stage1', {}, { object_id: S1, fixture: false }), 'fixture_is_fixed');
    ok('a real record cannot be tied to a fixture, and a fixture cannot be made real');
  }

  /* 10 — the Early Access tie */
  const BUYER = `FIXTURE-BUYER-${Date.now()}`;
  let realStage1 = null;
  {
    const lead = await earlyAccess.storeFormA({ buyer_intake_id: BUYER, name: 'Fixture Pilot Lead', email: `fixture-${Date.now()}@example.com`, answers: { 'Full name': 'Fixture Pilot Lead' } });
    await refused(() => write('offer', { linked_lead_ids: ['no-such-lead'] }, { object_id: OF }), 'unknown_lead');
    const r = await write('offer', { linked_lead_ids: [BUYER] }, { object_id: OF });
    assert.deepEqual(r.record.linked_lead_ids, [lead.id]);
    assert.deepEqual(r.events, []);
    const page = await gates.gates();
    assert.equal(page.offers.find((x) => x.id === OF).linked_leads[0].full_name, 'Fixture Pilot Lead');
    const shown = (await earlyAccess.leads()).leads.find((l) => l.id === lead.id);
    assert.deepEqual(shown.pilot_offers, [], 'a fixture offer must not show on a lead');
    // A real offer does show. Written and removed here by hand: there is no delete for a real record.
    const real = await gates.writeGate({ kind: 'offer', fields: { linked_lead_ids: [lead.id] }, by: DESTINY, via: 'test' });
    realStage1 = real.record.id;
    assert.match(realStage1, /^VFOF-/);
    assert.deepEqual((await earlyAccess.leads()).leads.find((l) => l.id === lead.id).pilot_offers, [{ id: realStage1, status: 'draft' }]);
    assert.deepEqual((await earlyAccess.leads()).leads.filter((l) => l.id !== lead.id && l.pilot_offers.length), [], 'no other lead was given an offer');
    ok('a pilot lead is tied to an offer; an unknown lead is refused; no offer is made for anybody else');
  }

  /* 11 — a refused Slack post is not silent */
  {
    // a check that stops passing on a record already passed is refused unless the status moves with it
    const slip = await refused(() => write('stage1', { root_zone_moisture_check: { status: 'failed', notes: 'fixture' } }, { object_id: S1 }), 'checks_not_passed');
    assert.match(slip.message, /set status back to in_progress or failed in the same write/);
    refuse = true;
    const r = await write('stage1', { status: 'failed', root_zone_moisture_check: { status: 'failed', notes: 'fixture' } }, { object_id: S1 });
    refuse = false;
    assert.equal(r.written, true);
    assert.equal(r.raise, true);
    assert.equal(r.alerts[0].ok, false);
    assert.equal(r.alerts[0].error, 'not_in_channel');
    assert.match(r.message, /not delivered/);
    const e = await eventsOf(S1, 'VFARM_GATE_ALERT_FAILED');
    assert.equal(e.length, 2, 'the status alert and the failed-check alert were both refused, and both are recorded');
    assert.equal(e[0].detail.error, 'not_in_channel');
    ok('a Slack alert that is refused says raise: true and leaves a VFARM_GATE_ALERT_FAILED event');
  }

  /* 12 */
  {
    const p = posts.length;
    const n = (await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type LIKE 'VFARM%'`)).rows[0].n;
    const again = await write('stage1', { status: 'failed', root_zone_moisture_check: { status: 'failed', notes: 'fixture' } }, { object_id: S1 });
    assert.equal(again.written, false);
    assert.equal(again.changed, false);
    // a dry run posts nothing and says what a real write would post
    const dryFail = await write('stage1', { status: 'in_progress', early_disease_detection_check: { status: 'failed', notes: 'fixture' } }, { object_id: S1, dry_run: true });
    assert.deepEqual(dryFail.alerts, []);
    assert.deepEqual(dryFail.alerts_would_send.map((x) => x.about), [`status:${S1}`, `check:${S1}:early_disease_detection_check`]);
    assert.match(dryFail.alerts_would_send[1].text, /check failed: Early disease detection/);
    assert.match(dryFail.message, /no alert was posted.*post 2 Slack alerts/);
    const dry = await write('stage1', { status: 'in_progress' }, { object_id: S1, dry_run: true });
    assert.equal(dry.written, false);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.status_change, { from: 'failed', to: 'in_progress' });
    assert.equal((await rowOf(S1)).status, 'failed');
    assert.equal(posts.length, p);
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type LIKE 'VFARM%'`)).rows[0].n, n);
    ok('the same write twice changes nothing and sends nothing; a dry run writes nothing');
  }

  /* 13 — over MCP */
  {
    const deps = { access: 'write', startedAt: new Date().toISOString(), dispatch: async () => ({ status: 404, body: null }) };
    const tool = toolByName('write_vfarm_gate', 'write');
    const fresh = await tool.handler({ kind: 'stage2', fields: { stage1_ref: S1, status: 'planned' }, fixture: true, requester_user_id: DESTINY }, deps);
    assert.equal(fresh.ok, true);
    const s1b = await tool.handler({ kind: 'stage1', fields: {}, fixture: true, requester_user_id: `<@${DESTINY}>` }, deps);
    const blocked = await tool.handler({ kind: 'stage2', fields: { stage1_ref: s1b.record.id, status: 'in_progress' }, fixture: true, requester_user_id: DESTINY }, deps);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.written, false);
    assert.equal(blocked.reason, 'stage1_not_passed');
    assert.match(blocked.message, /Nothing was written\.$/);
    const a = (await query('SELECT tool, kind, outcome, detail, requester_user_id FROM engine_mcp_writes WHERE id = $1', [blocked.audit_id])).rows[0];
    assert.equal(a.outcome, 'refused');
    assert.equal(a.kind, 'vfarm_gates');
    assert.match(a.detail, /^stage1_not_passed:/);
    assert.equal(a.requester_user_id, DESTINY);
    assert.equal((await query('SELECT outcome FROM engine_mcp_writes WHERE id = $1', [s1b.audit_id])).rows[0].outcome, 'inserted');
    assert.ok(toolByName('get_vfarm_gates', 'read'), 'the read is on the read connection');
    assert.equal(toolByName('write_vfarm_gate', 'read'), null);
    assert.ok(toolCatalogue('write').some((t) => t.name === 'delete_vfarm_gate_fixtures'));
    const read = await toolByName('get_vfarm_gates', 'read').handler({}, deps);
    assert.ok(read.stage1.some((x) => x.id === S1 && x.fixture === true));
    assert.equal(read.checks.filter((c) => c.recorded_by === 'a person').length, 3);
    const src = require('node:fs').readFileSync(path.join(__dirname, '../src/mcp/index.ts'), 'utf8');
    const bays = src.slice(src.indexOf("agent: 'bays'"), src.indexOf('] as Array<Omit<AgentKey'));
    assert.ok(bays.includes("'write_vfarm_gate'") && bays.includes("'get_vfarm_gates'"));
    assert.ok(!src.includes("'delete_vfarm_gate_fixtures'"), 'no agent may delete fixtures');
    ok('the MCP tool refuses the same way and audits it; Bays has the read and the write, not the delete');
  }

  /* 14 — clean up */
  {
    const dry = await toolByName('delete_vfarm_gate_fixtures', 'write').handler({ requester_user_id: DESTINY }, { access: 'write' });
    assert.ok(dry.would_delete.includes(S1));
    assert.deepEqual(dry.deleted, []);
    assert.ok(await rowOf(S1));
    const del = await toolByName('delete_vfarm_gate_fixtures', 'write').handler({ requester_user_id: DESTINY, confirm: true }, { access: 'write' });
    assert.ok(del.deleted.includes(S1) && del.deleted.includes(S2) && del.deleted.includes(OF));
    assert.equal((await query('SELECT count(*)::int AS n FROM engine_vfarm_gates WHERE is_fixture')).rows[0].n, 0);
    assert.ok(await rowOf(realStage1), 'a real record was deleted by the fixture delete');
    assert.ok((await eventsOf(S1, 'VFARM_STAGE1_STATE_CHANGED')).every((e) => e.detail.fixture === true));
    ok('deleting fixtures removes fixtures only; their events stay, marked fixture');
  }

  // The test's own non-fixture rows, removed by hand.
  await query('DELETE FROM engine_vfarm_gates WHERE object_id = $1', [realStage1]);
  await query(`DELETE FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' = $1`, [BUYER]);
  console.log(`\n${passed} checks passed.`);
  slack.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
