/**
 * SE8L resolver recovery against a real Postgres and a local stand-in for BHARAG's incident ledger:
 * the sweep the watcher would run, driven by hand, with the doctrine read made to fail and recover.
 *
 * What this pins:
 *   - a fully successful sweep with no resolver incident open writes nothing on the resolver key;
 *   - the existing threshold (a second failure within 24 hours, healthy sweeps between or not) opens
 *     one incident, and a further failure opens no second one;
 *   - while it is open, each fully successful sweep writes one resolver reading under the same key;
 *     the first does not close it and the second moves it to retrying, then self_healed, once, with
 *     one doctrine_gap_recovered row — across a reload of every module between the two;
 *   - a sweep that fails partway writes the failure and no resolver reading, so the count restarts;
 *   - once recovered, healthy sweeps write nothing on the resolver key;
 *   - a read that returns no claims is RESOLVER_READ_OK_NO_CLAIMS, and no doctrine or claim reads
 *     as healthy because of it;
 *   - the watcher stays off with DOCTRINE_GAP_WATCH_ENABLED unset.
 *
 * In process: no server, no network beyond 127.0.0.1, the watcher never started.
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:se8l-resolver-db
 * Refuses anything but a local database whose name ends in _test, one that already holds doctrine
 * (the sweep reads every claim in force), and one that already holds resolver-key events.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:se8l-resolver-db migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const T = Date.now();
const DOC = `SE8LR${T}`;
const KEY = 'doctrine:genie_ns:MEDIA_DOCTRINE:RESOLVER';
// Any surface's resolver key, so a build that files a reading under the wrong surface is still refused and cleaned up.
const ANY_RESOLVER_KEY = 'doctrine:%:MEDIA_DOCTRINE:RESOLVER';
const ledger = new Map();
const calls = [];
let seq = 0;

const bharag = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const parsed = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: u.pathname, key: req.headers['x-api-key'], body: parsed });
    const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers['x-api-key'] !== 'bays-key-for-test') return json(401, { error: 'wrong key' });
    if (u.pathname === '/api/v1/incidents' && req.method === 'GET') {
      const st = u.searchParams.get('status');
      return json(200, { incidents: [...ledger.values()].filter((i) => i.resolution_status === st) });
    }
    if (u.pathname === '/api/v1/incidents' && req.method === 'POST') {
      const id = `INC-SE8LR-TEST-${++seq}`;
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
  const load = () => ({
    pg: require(`${DIST}/pg.js`),
    feeds: require(`${DIST}/systemFeeds.js`),
    vrfk: require(`${DIST}/publicationDecision.js`),
    gap: require(`${DIST}/doctrineGap.js`),
  });
  let m = load();
  const { migrate } = require(`${DIST}/migrations.js`);
  const q = (sql, args) => m.pg.query(sql, args);

  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  const resolverRows = async () => (await q(`SELECT detail->>'condition' AS c, detail->>'reason' AS r FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND subject_id = $1 ORDER BY at, id`, [KEY])).rows;
  const healthyResolver = async () => (await resolverRows()).filter((x) => x.c === 'healthy');
  const marker = async (type) => (await q(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = $1 AND subject_id = $2`, [type, KEY])).rows[0].n;
  const opens = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/incidents');
  const statusPosts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/status')).map((c) => c.body.resolution_status);
  const sweep = () => m.gap.sweepCanonical();
  const failing = async (fn) => {
    const real = m.feeds.doctrineClaims;
    m.feeds.doctrineClaims = async () => { throw new Error('doctrine store unreachable (test)'); };
    try { return await fn(); } finally { m.feeds.doctrineClaims = real; }
  };

  try {
    await migrate();
    const held = (await q(`SELECT count(DISTINCT doctrine_id)::int AS n FROM engine_media_doctrine`)).rows[0].n;
    if (held) throw new Error(`test:se8l-resolver-db needs a database with no doctrine in it (it holds ${held}): the sweep reads every claim in force.`);
    const prior = (await q(`SELECT count(*)::int AS n FROM engine_events WHERE subject_id LIKE $1`, [ANY_RESOLVER_KEY])).rows[0].n;
    if (prior) throw new Error(`test:se8l-resolver-db needs a database with no resolver-key events (it holds ${prior}).`);

    // One claim in good order on genie_ns, with a decision, so the claim reads stay quiet throughout.
    await m.feeds.storeDoctrine({
      schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-v1`, doctrine_id: DOC, version: 'v1', change_type: 'created', summary: 'SE8L resolver db test', changed_at: new Date(Date.now() - 60_000).toISOString(),
      claims: [{ claim_id: 'OK', label: 'SE8L resolver test claim', maturity: 'PROVEN_NOW', allowed_wording: 'Test wording.', claim_state: 'interest_only_live', config_hash: 'cfg-se8lr-test', cad_provenance: { cad_revision: 'CAD-SE8LR-1', provenance_ref: 'OWLG:SE8LR-TEST' }, evidence_publication_status: 'PUBLISHABLE', fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: false, vfarm: false, genie_ns: true } }],
    });
    const claim = (await m.feeds.doctrineClaims({ doctrine_id: DOC, claim_id: 'OK' })).claims[0];
    assert.equal((await m.vrfk.storeDecision({ decision_id: `DEC-${DOC}-1`, doctrine_id: DOC, claim_id: 'OK', surface: 'genie_ns', actor: 'test:se8l-resolver-db', source_ref: 'LOOP-1791557096370-SE8L' }, claim)).decision.decision, 'allowed');

    await sweep();
    await sweep();
    assert.deepEqual(await resolverRows(), []);
    assert.equal(opens().length, 0);
    ok('fully successful sweeps with no resolver incident open write nothing on the resolver key');

    await failing(sweep);
    assert.equal(opens().length, 0);
    await sweep();
    assert.deepEqual(await healthyResolver(), [], 'no open marker, so no resolver reading');
    await failing(sweep);
    assert.equal(opens().length, 1);
    assert.equal(opens()[0].body.payload.error_class, 'RESOLVER_UNAVAILABLE');
    assert.equal(opens()[0].body.payload.failed_node_or_component, 'genie_ns / MEDIA_DOCTRINE:RESOLVER');
    assert.equal(opens()[0].body.payload.execution_id, KEY);
    ok('existing threshold kept: one failure opens nothing and writes no recovery reading; a second within 24 hours opens one incident even with a healthy sweep between (owner question)');

    await failing(sweep);
    assert.equal(opens().length, 1);
    assert.equal(await marker('doctrine_gap_incident_opened'), 1);
    ok('a further failure opens no second incident and writes no second opened marker');

    await sweep();
    assert.deepEqual(await healthyResolver(), [{ c: 'healthy', r: 'RESOLVER_READ_OK' }]);
    assert.deepEqual(statusPosts(), []);
    ok('the first successful sweep writes one RESOLVER_READ_OK reading under the same key and does not close');

    const realDecisions = m.vrfk.readDecisions;
    m.vrfk.readDecisions = async (claims, surface) => { if (surface === 'vfarm') throw new Error('decision read failed (test)'); return realDecisions(claims, surface); };
    try { await sweep(); } finally { m.vrfk.readDecisions = realDecisions; }
    const rows = await resolverRows();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[rows.length - 1], { c: 'resolver_unavailable', r: 'decision read failed (test)' });
    assert.equal((await healthyResolver()).length, 1);
    assert.deepEqual(statusPosts(), []);
    ok('a sweep that fails partway records the failure and no resolver reading');

    await sweep();
    assert.equal((await healthyResolver()).length, 2);
    assert.deepEqual(statusPosts(), [], 'the partial failure restarted the count');
    ok('the next successful sweep is the first since the failure again, and does not close');

    // Restart between the two confirmations: every module reloaded, nothing carried in memory.
    await m.pg.closePool();
    for (const k of Object.keys(require.cache)) if (k.startsWith(DIST)) delete require.cache[k];
    m = load();
    await sweep();
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    assert.equal(ledger.get('INC-SE8LR-TEST-1').resolution_status, 'self_healed');
    assert.equal(await marker('doctrine_gap_recovered'), 1);
    ok('after a reload of every module, the second successful sweep moves the incident to retrying, then self_healed, once, with one recovered row');

    const before = (await resolverRows()).length;
    await sweep();
    await sweep();
    assert.equal((await resolverRows()).length, before);
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    assert.equal(await marker('doctrine_gap_recovered'), 1);
    ok('once recovered, further successful sweeps write nothing on the resolver key and touch nothing');

    await failing(sweep);
    await failing(sweep);
    assert.equal(opens().length, 2);
    assert.equal(await marker('doctrine_gap_incident_opened'), 2);
    const realClaims = m.feeds.doctrineClaims;
    m.feeds.doctrineClaims = async () => ({ claims: [] });
    const docRows = async () => (await q(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1`, [DOC])).rows[0].n;
    const docBefore = await docRows();
    const sinceId = (await q(`SELECT coalesce(max(id), 0) AS id FROM engine_events`)).rows[0].id;
    try { await sweep(); } finally { m.feeds.doctrineClaims = realClaims; }
    const last = (await healthyResolver()).at(-1);
    assert.deepEqual(last, { c: 'healthy', r: 'RESOLVER_READ_OK_NO_CLAIMS' });
    assert.equal(await docRows(), docBefore);
    const healthyNow = (await q(`SELECT detail->>'doctrine_id' AS d, detail->>'claim_id' AS c FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND id > $1 AND detail->>'condition' = 'healthy'`, [sinceId])).rows;
    assert.deepEqual(healthyNow, [{ d: 'MEDIA_DOCTRINE', c: 'RESOLVER' }]);
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    ok('with a second resolver incident open, a read returning no claims is RESOLVER_READ_OK_NO_CLAIMS on the resolver key only: no doctrine or claim reads as healthy');

    m.feeds.doctrineClaims = async () => ({ claims: [] });
    try { await sweep(); } finally { m.feeds.doctrineClaims = realClaims; }
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed', 'retrying', 'self_healed']);
    assert.equal(await marker('doctrine_gap_recovered'), 2);
    ok('a second no-claims read recovers the resolver incident: the resolver answered, which is what the incident was about (whether no doctrine is its own gap is an owner question)');

    const timers = [];
    const realTimeout = global.setTimeout, realInterval = global.setInterval, realLog = console.log;
    const logs = [];
    global.setTimeout = (...a) => { timers.push('timeout'); return realTimeout(() => {}, 0); };
    global.setInterval = (...a) => { timers.push('interval'); return realInterval(() => {}, 1e9); };
    console.log = (...a) => logs.push(a.join(' '));
    try { m.gap.startWatching(); } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; console.log = realLog; }
    assert.equal(process.env.DOCTRINE_GAP_WATCH_ENABLED, undefined);
    assert.deepEqual(timers, []);
    assert.ok(logs.some((l) => l.includes('watcher OFF')));
    ok('with DOCTRINE_GAP_WATCH_ENABLED unset the watcher schedules nothing and says it is off');

    assert.ok(calls.every((c) => c.key === 'bays-key-for-test'));
    ok('every ledger call went to the local stand-in with the bays lane key');
  } finally {
    const ev = await q(`DELETE FROM engine_events WHERE subject_id LIKE $1 OR detail->>'doctrine_id' = $2 OR subject_id LIKE $3`, [`%${DOC}%`, DOC, ANY_RESOLVER_KEY]);
    const doc = await q(`DELETE FROM engine_media_doctrine WHERE doctrine_id = $1`, [DOC]);
    console.log(`  cleaned up ${ev.rowCount} event row(s) and ${doc.rowCount} doctrine row(s) written by this run`);
    await m.pg.closePool();
    bharag.close();
  }
  console.log(`\n${passed} SE8L resolver database checks passed.`);
})().catch(async (e) => { console.error(e); process.exit(1); });
