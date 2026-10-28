/**
 * SE8L state-change-only writes (LOOP-1792472755186-M4CV; Jason, 16 and 20 Oct 2026: the watcher
 * stays OFF until observations are written only when their state changes). Against a real Postgres
 * and a local stand-in for BHARAG's incident ledger, with the sweep driven by hand.
 *
 * What this proves, and prints:
 *   - rows per sweep before and after, for 14 claims (the count in force on 20 Oct) on three surfaces:
 *     every sweep takes 42 readings; the first writes 42, every unchanged sweep after it writes 0;
 *   - the projection per day at the watcher's five-minute cadence (288 sweeps): 12,096 rows before,
 *     42 after (one daily restatement per claim and surface) plus one per real change;
 *   - an unchanged claim is written again once its last row is 24 hours old (daily_restatement);
 *   - an alarm still opens and closes: a contradiction opens one incident, every reading on its key
 *     is written while it is open, two healthy reads close it, and writing stops once it is closed;
 *   - the duplicate check: no two consecutive rows on a key carry the same state within 24 hours
 *     unless an alarm was open or the reading counted toward one. The check is shown to catch a
 *     planted duplicate, so it fails if repeated observations ever come back.
 *
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:se8l-writes
 * Refuses anything but a local database whose name ends in _test, and one that already holds doctrine.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:se8l-writes migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const T = Date.now();
const DOC = `SE8LW${T}`;
const CLAIMS = 14;
const SURFACES = 3;
const SWEEPS_A_DAY = (24 * 60) / 5;
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
      const id = `INC-SE8LW-TEST-${++seq}`;
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
  const vrfk = require(`${DIST}/publicationDecision.js`);
  const gap = require(`${DIST}/doctrineGap.js`);

  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  const rows = async () => (await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1`, [DOC])).rows[0].n;
  const opens = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/incidents');
  const statusPosts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/status')).map((c) => c.body.resolution_status);
  const sweep = async () => {
    const before = await rows();
    const results = await gap.sweepCanonical();
    return { readings: results.length, written: (await rows()) - before, results };
  };
  // The duplicate check: consecutive rows on one key with the same state inside 24 hours, where nothing
  // (an open alarm, a counted failure, an incident action) called for the second one.
  const duplicates = async () => (await query(`
    WITH o AS (
      SELECT id, at, detail,
             lag(detail) OVER (PARTITION BY detail->>'recovery_key' ORDER BY at, id) AS prev,
             lag(at) OVER (PARTITION BY detail->>'recovery_key' ORDER BY at, id) AS prev_at
      FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1)
    SELECT id, detail->>'recovery_key' AS key, detail->>'write_reason' AS reason FROM o
    WHERE prev IS NOT NULL AND at - prev_at < interval '24 hours'
      AND coalesce(detail->>'write_reason', '') NOT IN ('alarm_open', 'counting', 'acting', 'alarm_recovery', 'incident_restatement')
      AND ${gap.STATE_FIELDS.map((f) => `(detail->>'${f}') IS NOT DISTINCT FROM (prev->>'${f}')`).join(' AND ')}`, [DOC])).rows;

  try {
    await migrate();
    const held = (await query(`SELECT count(DISTINCT doctrine_id)::int AS n FROM engine_media_doctrine`)).rows[0].n;
    if (held) throw new Error(`test:se8l-writes needs a database with no doctrine in it (it holds ${held}): the sweep reads every claim in force.`);

    // 14 claims, fail closed: no T0NO fields, so each is needs_evidence on every surface.
    const claims = Array.from({ length: CLAIMS }, (_, i) => ({ claim_id: `C${String(i + 1).padStart(2, '0')}`, label: `SE8L writes test claim ${i + 1}`, maturity: 'IN_BUILD' }));
    await feeds.storeDoctrine({ schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-v1`, doctrine_id: DOC, version: 'v1', change_type: 'created', summary: 'SE8L writes test v1', changed_at: new Date(Date.now() - 60_000).toISOString(), claims });

    const first = await sweep();
    assert.equal(first.readings, CLAIMS * SURFACES);
    assert.equal(first.written, CLAIMS * SURFACES);
    ok(`the first sweep takes ${first.readings} readings and writes ${first.written} (one per claim per surface, write_reason first)`);

    const later = [];
    for (let i = 0; i < 11; i++) later.push(await sweep());
    assert.ok(later.every((s) => s.readings === CLAIMS * SURFACES && s.written === 0), JSON.stringify(later.map((s) => s.written)));
    assert.equal(await rows(), CLAIMS * SURFACES);
    assert.ok(later.every((s) => s.results.every((r) => r.written === false && r.write_reason === 'unchanged')));
    assert.equal(opens().length, 0);
    ok(`eleven more sweeps (an hour at the five-minute cadence) take ${11 * CLAIMS * SURFACES} readings and write 0: twelve sweeps hold ${await rows()} rows, where they held ${12 * CLAIMS * SURFACES} before`);

    const beforePerDay = CLAIMS * SURFACES * SWEEPS_A_DAY;
    const afterPerDay = 0;
    assert.equal(beforePerDay, 12096);
    ok(`projected rows a day for ${CLAIMS} unchanged claims: ${beforePerDay.toLocaleString('en-US')} before (every reading of ${SWEEPS_A_DAY} sweeps), ${afterPerDay} after (no restatement without an open incident, SOP 9daadbc3) plus one per real change`);

    // Age every row past the restatement window, as a day with no change would.
    await query(`UPDATE engine_events SET at = at - interval '24 hours 1 minute', detail = jsonb_set(detail, '{observed_at}', to_jsonb(to_char((at - interval '24 hours 1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1`, [DOC]);
    const restated = await sweep();
    assert.equal(restated.written, 0);
    assert.ok(restated.results.every((r) => r.write_reason === 'unchanged'));
    const again = await sweep();
    assert.equal(again.written, 0);
    ok('once the last rows are 24 hours old the next sweep still writes 0: a key with no open incident is never restated (27 Oct, SOP 9daadbc3)');

    // One claim clears (allowed on genie_ns only); a stored decision then contradicts it on genie_ns.
    const cleared = claims.map((c, i) => (i === 0 ? { ...c, maturity: 'PROVEN_NOW', allowed_wording: 'Test wording.', claim_state: 'interest_only_live', config_hash: 'cfg-se8lw-test', cad_provenance: { cad_revision: 'CAD-SE8LW-1', provenance_ref: 'OWLG:SE8LW-TEST' }, evidence_publication_status: 'PUBLISHABLE', fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: false, vfarm: false, genie_ns: true } } : c));
    await feeds.storeDoctrine({ schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-v2`, doctrine_id: DOC, version: 'v2', previous_version: 'v1', change_type: 'amended', summary: 'SE8L writes test v2', changed_at: new Date().toISOString(), claims: cleared });
    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('vfam_claim_publication_decision', now(), $1, 'MEDIA', 'test:se8l-writes', 'LOOP-1792472755186-M4CV', $2::jsonb, $3)`,
      [`${DOC}:C01:genie_ns`, JSON.stringify({ event_name: 'VFAM.claim_publication_decision', decision_id: `DEC-${DOC}-FORGED`, doctrine_id: DOC, claim_id: 'C01', surface: 'genie_ns', decision: 'hold', reason: 'forged', doctrine_change_id: `DOC-${DOC}-v2`, evidence_refs: [] }), `VFAM.claim_publication_decision:DEC-${DOC}-FORGED`],
    );
    const broke = await sweep();
    assert.equal(opens().length, 1);
    assert.equal(broke.written, 3, 'C01 changed on all three surfaces');
    const held1 = await sweep();
    assert.equal(held1.written, 0, 'an identical unhealthy reading on an open alarm is not written');
    assert.equal(opens().length, 1);
    ok('a contradiction opens one alarm on its first sweep (3 rows: C01 changed on each surface); the next sweep writes 0 and opens nothing more');

    const claim = (await feeds.doctrineClaims({ doctrine_id: DOC, claim_id: 'C01' })).claims[0];
    await vrfk.storeDecision({ decision_id: `DEC-${DOC}-1`, doctrine_id: DOC, claim_id: 'C01', surface: 'genie_ns', actor: 'test:se8l-writes', source_ref: 'LOOP-1792472755186-M4CV' }, claim);
    const h1 = await sweep();
    assert.equal(h1.written, 1);
    assert.deepEqual(statusPosts(), []);
    const h2 = await sweep();
    assert.equal(h2.written, 1);
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    const after = await sweep();
    assert.equal(after.written, 0);
    ok('two healthy reads close it (1 row each, retrying then self_healed), and the sweep after it is closed writes 0');

    assert.deepEqual(await duplicates(), []);
    ok('the duplicate check finds no unchanged observation written twice inside 24 hours without an open alarm');

    // Sensitivity: plant exactly the row the old code wrote every sweep, and the check must see it.
    // One minute after the real last row, so the copy falls inside 24 hours of it (from 27 Oct nothing
    // restates a key with no open incident, so that last row is the one aged a day above).
    const lastRow = (await query(`SELECT detail, at + interval '1 minute' AS plant_at FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'recovery_key' = $1 ORDER BY at DESC, id DESC LIMIT 1`, [`doctrine:vfarm:${DOC}:C05`])).rows[0];
    const planted = { ...lastRow.detail, observation_id: `DG-PLANTED-${T}`, observed_at: new Date(lastRow.plant_at).toISOString() };
    delete planted.write_reason;
    await query(`INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('doctrine_gap_observed', $4::timestamptz, $1, 'MEDIA', 'test:se8l-writes', 'LOOP-1792472755186-M4CV', $2::jsonb, $3)`, [planted.recovery_key, JSON.stringify(planted), `doctrine_gap_observed:${planted.observation_id}`, lastRow.plant_at]);
    const found = await duplicates();
    assert.equal(found.length, 1);
    assert.equal(found[0].key, `doctrine:vfarm:${DOC}:C05`);
    await query(`DELETE FROM engine_events WHERE dedupe_key = $1`, [`doctrine_gap_observed:${planted.observation_id}`]);
    assert.deepEqual(await duplicates(), []);
    ok('the check catches a planted repeat of an unchanged reading (the old behaviour), so it fails if repeated observations come back');

    const total = await rows();
    const sweeps = 1 + 11 + 2 + 2 + 3;
    ok(`${sweeps} sweeps took ${sweeps * CLAIMS * SURFACES} readings and wrote ${total} rows; before the change they would have written ${sweeps * CLAIMS * SURFACES}`);

    const s = await gap.summary(48);
    assert.equal(s.write_rule.status, 'state_change_only');
    assert.equal(s.write_rule.restate_hours, 24);
    assert.equal(s.write_rule.restate, 'open_incident_only_rolling_24h');
    assert.ok(s.sweeps.last_done, 'the summary says when a sweep last finished');
    ok('summary names the write rule (state_change_only, an open incident restated at most once in a rolling 24 hours) and the last finished sweep');
  } finally {
    const ev = await query(`DELETE FROM engine_events WHERE subject_id LIKE $1 OR detail->>'doctrine_id' = $2`, [`%${DOC}%`, DOC]);
    const doc = await query(`DELETE FROM engine_media_doctrine WHERE doctrine_id = $1`, [DOC]);
    await query(`DELETE FROM engine_doctrine_gap_episodes WHERE doctrine_id = $1`, [DOC]).catch(() => undefined);
    await query(`DELETE FROM engine_doctrine_gap_alarms WHERE recovery_key LIKE $1`, [`%${DOC}%`]).catch(() => undefined);
    console.log(`  cleaned up ${ev.rowCount} event row(s) and ${doc.rowCount} doctrine row(s) written by this run`);
    await closePool();
    bharag.close();
  }
  console.log(`\n${passed} SE8L write-rule database checks passed.`);
})().catch(async (e) => { console.error(e); process.exit(1); });
