/**
 * The QNDM drill (doctrineDrill.ts, run_doctrine_drill) against a real Postgres and a local
 * stand-in for BHARAG's incident ledger: the whole sequence Jason approved on 20 Oct 2026, run
 * the way it will run live, one hand sweep at a time, the watcher's timer never started.
 *
 * What this pins:
 *   - create logs the drill doctrine; the start decision goes through VRFK's normal path;
 *   - the first sweep writes every first reading (the drill claim's three surfaces and the other
 *     claims in force) and opens nothing; the next writes nothing;
 *   - break records one contradicting decision (the one write no normal path allows), and the
 *     next sweep opens exactly one critical DOCTRINE incident, tagged drill, asking for no
 *     research, so the drill never opens a real Research Twin job;
 *   - while it is open each sweep writes the drill key's row and opens no second incident;
 *   - the real decision put back, one healthy read does not close it and the second does
 *     (retrying, then self_healed), and the sweep after writes nothing;
 *   - retire takes the drill doctrine out of force, the sweep after writes nothing, and the
 *     other claims are never touched;
 *   - the tool refuses anyone but Destiny or Jason, and any step without confirm "DRILL QNDM".
 *
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:qndm-drill
 * Refuses anything but a local database whose name ends in _test, and one that already holds
 * doctrine (the sweep reads every claim in force).
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:qndm-drill migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const T = Date.now();
const REAL = `QNDMREAL${T}`;
const RUN = `test-${T}`;
const DESTINY = 'U0AEW3TBYH1';
const ledger = new Map();
const calls = [];
let seq = 0;

const bharag = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const parsed = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: u.pathname, body: parsed });
    const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers['x-api-key'] !== 'bays-key-for-test') return json(401, { error: 'wrong key' });
    if (u.pathname === '/api/v1/incidents' && req.method === 'GET') return json(200, { incidents: [...ledger.values()].filter((i) => i.resolution_status === u.searchParams.get('status')) });
    if (u.pathname === '/api/v1/incidents' && req.method === 'POST') {
      const id = `INC-QNDM-TEST-${++seq}`;
      const inc = { id, entity_id: id, resolution_status: 'open', ...parsed };
      ledger.set(id, inc);
      return json(201, { incident: inc });
    }
    const m = u.pathname.match(/^\/api\/v1\/incidents\/([^/]+)\/status$/);
    if (m && req.method === 'POST') {
      const inc = ledger.get(decodeURIComponent(m[1]));
      if (!inc) return json(404, { error: 'no such incident' });
      inc.resolution_status = parsed.resolution_status;
      return json(200, inc);
    }
    json(404, { error: 'stand-in has no such route' });
  });
});

(async () => {
  await new Promise((r) => bharag.listen(0, '127.0.0.1', r));
  process.env.BHARAG_API_URL = `http://127.0.0.1:${bharag.address().port}/api/v1`;
  process.env.BHARAG_BAYS_INCIDENTS = 'bays-key-for-test';
  delete process.env.DOCTRINE_GAP_WATCH_ENABLED;

  const DIST = path.join(__dirname, '../../server-dist/server/src');
  const { migrate } = require(`${DIST}/migrations.js`);
  const { query, closePool } = require(`${DIST}/pg.js`);
  const feeds = require(`${DIST}/systemFeeds.js`);
  const drill = require(`${DIST}/doctrineDrill.js`);
  const logstream = require(`${DIST}/logstream.js`);
  const heldIncident = async (id) => (await query(`SELECT natural_id, open_now, resolved_by, fields->'payload'->>'workflow_or_scenario' AS workflow, fields->'payload'->>'failed_node_or_component' AS node, ARRAY(SELECT jsonb_array_elements_text(fields->'payload'->'impact_tags')) AS tags FROM engine_incidents WHERE natural_id = $1`, [id])).rows[0];
  const { runDoctrineDrillTool } = require(`${DIST}/mcp/doctrineDrillTools.js`);

  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  const opens = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/incidents');
  const statusPosts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/status')).map((c) => c.body.resolution_status);
  const realRows = async () => (await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1`, [REAL])).rows[0].n;
  const g = (s) => s.drill.find((d) => d.surface === 'genie_ns');
  const tool = (args) => runDoctrineDrillTool.handler({ requester_user_id: DESTINY, confirm: 'DRILL QNDM', run: RUN, ...args }, { access: 'write' });

  try {
    await migrate();
    const held = (await query(`SELECT count(DISTINCT doctrine_id)::int AS n FROM engine_media_doctrine`)).rows[0].n;
    if (held) throw new Error(`test:qndm-drill needs a database with no doctrine in it (it holds ${held}).`);

    // Two real-looking claims, both fail closed, standing in for the 14 in force.
    await feeds.storeDoctrine({ schema: 'media.doctrine.v1', change_id: `DOC-${REAL}-v1`, doctrine_id: REAL, version: 'v1', change_type: 'created', summary: 'QNDM drill test: other claims', changed_at: new Date(Date.now() - 60_000).toISOString(), claims: [{ claim_id: 'A', label: 'a', maturity: 'IN_BUILD' }, { claim_id: 'B', label: 'b', maturity: 'IN_BUILD' }] });

    let r = await runDoctrineDrillTool.handler({ step: 'create', run: RUN, confirm: 'DRILL QNDM', requester_user_id: 'U0OTHER' }, { access: 'write' });
    assert.equal(r.reason, 'not_permitted');
    r = await tool({ step: 'create', confirm: 'yes' });
    assert.equal(r.reason, 'confirm_required');
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_media_doctrine WHERE doctrine_id = $1`, [drill.DOCTRINE_ID])).rows[0].n, 0);
    ok('the tool refuses anyone but Destiny or Jason, and a step without confirm "DRILL QNDM", and writes nothing');

    r = await tool({ step: 'create' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.inserted, 1);
    r = await tool({ step: 'create' });
    assert.equal(r.reason, 'already_in_force');
    r = await tool({ step: 'record_decision', label: 'start' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.decision.decision, 'allowed');
    ok('create logs the drill doctrine once, and the start decision goes through the normal path as allowed');

    let s = (await tool({ step: 'sweep' })).result;
    assert.equal(s.readings, 9, 'three claims, three surfaces');
    assert.equal(s.written, 9);
    assert.equal(g(s).condition, 'healthy');
    assert.equal(s.incidents.length, 0);
    assert.equal(opens().length, 0);
    ok('sweep 1: every first reading written (3 drill, 6 other), drill genie_ns healthy, no incident');

    s = (await tool({ step: 'sweep' })).result;
    assert.equal(s.written, 0);
    ok('sweep 2: nothing changed, nothing written');

    r = await tool({ step: 'break' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.decision, 'hold');
    assert.equal(r.result.expected, 'allowed');
    s = (await tool({ step: 'sweep' })).result;
    assert.equal(g(s).condition, 'contradictory_evidence');
    assert.equal(g(s).write_reason, 'changed');
    assert.equal(g(s).incident, 'opened');
    assert.equal(s.written, 1);
    assert.equal(opens().length, 1);
    const inc = opens()[0].body;
    assert.equal(inc.subsystem, 'DOCTRINE');
    assert.equal(inc.severity, 'critical');
    assert.equal(inc.payload.research_needed, false, 'a drill incident must not open a real Research Twin job');
    assert.ok(inc.payload.impact_tags.includes('drill'));
    assert.equal(inc.payload.workflow_or_scenario, 'T0NO doctrine-gap monitor');
    const ledgerId = g(s).ledger_id;
    let h = await heldIncident(ledgerId);
    assert.ok(h, 'Engine health holds the incident the moment it opens');
    assert.equal(h.open_now, true);
    assert.equal(logstream.thresholdExcludedReason(h), 'doctrine', 'Logstream keeps it out of its counts as a DOCTRINE incident');
    ok('break + sweep 3: one critical DOCTRINE incident, tagged drill, asking for no research; one row written; Engine health holds it open, Logstream leaves it out of its counts');

    s = (await tool({ step: 'sweep' })).result;
    assert.equal(g(s).write_reason, 'unchanged');
    assert.equal(s.written, 0);
    assert.equal(opens().length, 1, 'no second incident');
    ok('sweep 4: an identical reading on the open alarm writes nothing (SOP 9daadbc3), and no second incident opens');

    r = await tool({ step: 'record_decision', label: 'fix' });
    assert.equal(r.ok, true, JSON.stringify(r));
    s = (await tool({ step: 'sweep' })).result;
    assert.equal(g(s).condition, 'healthy');
    assert.equal(g(s).incident, 'none');
    assert.equal(s.written, 1);
    assert.deepEqual(statusPosts(), []);
    ok('fix + sweep 5: healthy and written, not closed yet (one healthy read)');

    s = (await tool({ step: 'sweep' })).result;
    assert.equal(g(s).incident, 'closed_after_two_healthy_reads');
    assert.equal(g(s).write_reason, 'alarm_recovery');
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    h = await heldIncident(ledgerId);
    assert.equal(h.open_now, false);
    assert.equal(h.resolved_by, 'doctrine-gap-monitor (two healthy reads)');
    ok('sweep 6: the second healthy read closes it, retrying then self_healed, and Engine health marks its copy closed');

    s = (await tool({ step: 'sweep' })).result;
    assert.equal(s.written, 0);
    ok('sweep 7: closed, nothing written');

    const before = await realRows();
    r = await tool({ step: 'retire' });
    assert.equal(r.ok, true, JSON.stringify(r));
    s = (await tool({ step: 'sweep' })).result;
    assert.equal(s.readings, 6, 'the drill claim is out of force');
    assert.equal(s.drill.length, 0);
    assert.equal(s.written, 0);
    assert.equal(await realRows(), before);
    assert.equal(before, 6, 'the other claims wrote their first readings once and nothing else');
    r = await tool({ step: 'break' });
    assert.equal(r.reason, 'not_in_force');
    ok('retire + sweep 8: drill out of force, nothing written, the other claims untouched, and break refuses once retired');

    const st = (await tool({ step: 'status' })).result;
    assert.equal(st.doctrine_in_force, false);
    const events = st.rows.map((x) => x.event);
    assert.equal(events.filter((e) => e === 'doctrine_gap_incident_opened').length, 1);
    assert.equal(events.filter((e) => e === 'doctrine_gap_recovered').length, 1);
    assert.equal(events.filter((e) => e === 'vfam_claim_publication_decision').length, 3);
    assert.equal(events.filter((e) => e === 'doctrine_gap_observed').length, 6, '3 first + break + fix + close (an identical reading on the open alarm is not written, 27 Oct)');
    const audits = (await query(`SELECT count(*)::int AS n FROM engine_mcp_writes WHERE tool = 'run_doctrine_drill' AND arguments->>'run' = $1`, [RUN])).rows[0].n;
    assert.ok(audits >= 14);
    ok('status gives the whole record: 1 open, 1 recovery, 3 decisions, 6 rows; every call audited');
  } finally {
    await query(`DELETE FROM engine_events WHERE detail->>'doctrine_id' IN ($1, $2) OR subject_id LIKE $3`, [REAL, drill.DOCTRINE_ID, `%${drill.DOCTRINE_ID}%`]);
    await query(`DELETE FROM engine_media_doctrine WHERE doctrine_id IN ($1, $2)`, [REAL, drill.DOCTRINE_ID]);
    await query(`DELETE FROM engine_incidents WHERE natural_id LIKE 'INC-QNDM-TEST-%'`);
    await query(`DELETE FROM engine_doctrine_gap_episodes WHERE doctrine_id IN ($1, $2)`, [REAL, drill.DOCTRINE_ID]).catch(() => undefined);
    await query(`DELETE FROM engine_doctrine_gap_alarms WHERE recovery_key LIKE $1 OR recovery_key LIKE $2`, [`%${drill.DOCTRINE_ID}%`, `%${REAL}%`]).catch(() => undefined);
    await query(`DELETE FROM engine_mcp_writes WHERE tool = 'run_doctrine_drill' AND (arguments->>'run' = $1 OR arguments->>'run' IS NULL)`, [RUN]);
    await closePool();
    bharag.close();
  }
  console.log(`\nqndm-drill: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
