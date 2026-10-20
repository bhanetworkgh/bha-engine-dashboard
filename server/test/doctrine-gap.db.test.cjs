/**
 * SE8L (LOOP-1791557096370-SE8L) against a real Postgres and a local stand-in
 * for BHARAG's incident ledger: the sweep the watcher would run, driven by
 * hand. It pins what the code does today, which is not the same as policy
 * anybody has approved — the thresholds are PROPOSED and the watcher stays off.
 *
 * What this pins:
 *   - every sweep writes one doctrine_gap_observed row per claim per surface,
 *     each with its own id, so repeated observations are never deduplicated;
 *   - the sweep asserts no active consumer (2026-10-17): allowed_use is
 *     eligibility, not use, so an unresolved claim on all three surfaces opens
 *     no incident, however many sweeps see it;
 *   - a decision that contradicts the doctrine in force still opens a DOCTRINE
 *     incident at once, and a second sweep opens no second one;
 *   - two healthy sweeps after it is put right move the incident to retrying
 *     and then self_healed, once, and write one doctrine_gap_recovered row;
 *   - a resolver failure still opens an incident on the second sweep;
 *   - the incident's Logstream signature, and that Logstream does not exclude it.
 *
 * In process: no server, no network beyond 127.0.0.1, the watcher never started.
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:se8l-db
 * Refuses anything but a local database whose name ends in _test, and one that
 * already holds doctrine (the sweep reads every claim in force).
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:se8l-db migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const T = Date.now();
const DOC = `SE8L${T}`;
const ledger = new Map();
const calls = [];
let seq = 0;

const bharag = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const parsed = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: u.pathname, query: u.search, key: req.headers['x-api-key'], body: parsed });
    const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers['x-api-key'] !== 'bays-key-for-test') return json(401, { error: 'wrong key' });
    if (u.pathname === '/api/v1/incidents' && req.method === 'GET') {
      const st = u.searchParams.get('status');
      return json(200, { incidents: [...ledger.values()].filter((i) => i.resolution_status === st) });
    }
    if (u.pathname === '/api/v1/incidents' && req.method === 'POST') {
      const id = `INC-SE8L-TEST-${++seq}`;
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
  const logstream = require(`${DIST}/logstream.js`);

  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  const observed = async () => (await query(`SELECT count(*)::int AS n, count(DISTINCT dedupe_key)::int AS d FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1`, [DOC])).rows[0];
  const opens = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/incidents');
  const statusPosts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/status')).map((c) => c.body.resolution_status);
  const sweep = () => gap.sweepCanonical();

  try {
    await migrate();
    const held = (await query(`SELECT count(DISTINCT doctrine_id)::int AS n FROM engine_media_doctrine`)).rows[0].n;
    if (held) throw new Error(`test:se8l-db needs a database with no doctrine in it (it holds ${held}): the sweep reads every claim in force.`);

    // One claim, fail closed: no T0NO fields at all.
    await feeds.storeDoctrine({ schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-v1`, doctrine_id: DOC, version: 'v1', change_type: 'created', summary: 'SE8L db test v1', changed_at: new Date(Date.now() - 60_000).toISOString(), claims: [{ claim_id: 'GAP', label: 'SE8L test claim', maturity: 'IN_BUILD' }] });

    await sweep();
    let o = await observed();
    assert.deepEqual(o, { n: 3, d: 3 });
    assert.equal(opens().length, 0);
    ok('one sweep writes one observation per surface (media_twin, vfarm, genie_ns), each with its own id');

    for (let i = 0; i < 3; i++) await sweep();
    o = await observed();
    assert.deepEqual(o, { n: 12, d: 12 });
    assert.equal(opens().length, 0, 'four sweeps of an unresolved claim open nothing');
    const asserted = (await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1 AND detail->>'active_consumer' = 'true'`, [DOC])).rows[0].n;
    assert.equal(asserted, 0);
    const conds = (await query(`SELECT DISTINCT detail->>'surface' AS s, detail->>'condition' AS c FROM engine_events WHERE event_type = 'doctrine_gap_observed' AND detail->>'doctrine_id' = $1 ORDER BY 1`, [DOC])).rows;
    assert.deepEqual(conds, [{ s: 'genie_ns', c: 'needs_evidence' }, { s: 'media_twin', c: 'needs_evidence' }, { s: 'vfarm', c: 'needs_evidence' }]);
    ok('an unresolved claim is needs_evidence on all three surfaces for four sweeps and opens no incident: no observation asserts an active consumer, genie_ns default or not');

    // The claim clears (every T0NO field, allowed on genie_ns only), then a stored decision for this
    // very doctrine change says hold where T0NO now says allowed: a contradiction.
    await feeds.storeDoctrine({
      schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-v2`, doctrine_id: DOC, version: 'v2', previous_version: 'v1', change_type: 'amended', summary: 'SE8L db test v2', changed_at: new Date().toISOString(),
      claims: [{ claim_id: 'GAP', label: 'SE8L test claim', maturity: 'PROVEN_NOW', allowed_wording: 'Test wording.', claim_state: 'interest_only_live', config_hash: 'cfg-se8l-test', cad_provenance: { cad_revision: 'CAD-SE8L-1', provenance_ref: 'OWLG:SE8L-TEST' }, evidence_publication_status: 'PUBLISHABLE', fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: false, vfarm: false, genie_ns: true } }],
    });
    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('vfam_claim_publication_decision', now(), $1, 'MEDIA', 'test:se8l-db', 'LOOP-1791557096370-SE8L', $2::jsonb, $3)`,
      [`${DOC}:GAP:genie_ns`, JSON.stringify({ event_name: 'VFAM.claim_publication_decision', decision_id: `DEC-${DOC}-FORGED`, doctrine_id: DOC, claim_id: 'GAP', surface: 'genie_ns', decision: 'hold', reason: 'forged', doctrine_change_id: `DOC-${DOC}-v2`, evidence_refs: [] }), `VFAM.claim_publication_decision:DEC-${DOC}-FORGED`],
    );
    await sweep();
    assert.equal(opens().length, 1, 'a contradiction opens at once');
    const incident = opens()[0].body;
    assert.equal(incident.subsystem, 'DOCTRINE');
    assert.equal(incident.source, 'bays');
    assert.equal(incident.payload.error_class, 'CONTRADICTORY_EVIDENCE');
    assert.equal(incident.payload.failed_node_or_component, `genie_ns / ${DOC}:GAP`);
    assert.equal(incident.payload.retry_policy.retryable, false);
    ok('a stored decision that contradicts the doctrine in force still opens a DOCTRINE incident on the first sweep, with no consumer asserted');

    await sweep();
    assert.equal(opens().length, 1);
    ok('a second sweep of the same contradiction opens no second incident (the open marker holds)');

    const sig = logstream.signatureOf(incident.payload.workflow_or_scenario, incident.payload.failed_node_or_component);
    assert.equal(sig, `T0NO doctrine-gap monitor :: genie_ns / ${DOC}:GAP`);
    assert.equal(logstream.excludedReason({ workflow: incident.payload.workflow_or_scenario, node: incident.payload.failed_node_or_component }), null);
    ok('the incident carries a Logstream signature Logstream does not exclude, so once mirrored it counts toward Logstream thresholds (unchanged here)');

    // Put right: a real decision for this change, newer than the forged one.
    const claim = (await feeds.doctrineClaims({ doctrine_id: DOC, claim_id: 'GAP' })).claims[0];
    const decided = await vrfk.storeDecision({ decision_id: `DEC-${DOC}-1`, doctrine_id: DOC, claim_id: 'GAP', surface: 'genie_ns', actor: 'test:se8l-db', source_ref: 'LOOP-1791557096370-SE8L' }, claim);
    assert.equal(decided.decision.decision, 'allowed');

    await sweep();
    assert.deepEqual(statusPosts(), []);
    ok('the first healthy sweep does not recover yet');
    await sweep();
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    const recovered = (await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'doctrine_gap_recovered' AND subject_id = $1`, [`doctrine:genie_ns:${DOC}:GAP`])).rows[0].n;
    assert.equal(recovered, 1);
    ok('the second healthy sweep moves the incident to retrying, then self_healed, and writes one doctrine_gap_recovered row');

    await sweep();
    assert.deepEqual(statusPosts(), ['retrying', 'self_healed']);
    assert.equal(opens().length, 1);
    o = await observed();
    assert.deepEqual(o, { n: 27, d: 27 });
    ok('a further healthy sweep does nothing to the ledger; nine sweeps wrote 27 observations for one claim');

    // The resolver cannot be read: the explicit resolver-failure path, unchanged.
    const realClaims = feeds.doctrineClaims;
    try {
      feeds.doctrineClaims = async () => { throw new Error('doctrine store unreachable (test)'); };
      await sweep();
      assert.equal(opens().length, 1, 'the first resolver failure opens nothing');
      await sweep();
      assert.equal(opens().length, 2, 'the second resolver failure opens one');
      assert.equal(opens()[1].body.payload.error_class, 'RESOLVER_UNAVAILABLE');
      assert.equal(opens()[1].body.payload.failed_node_or_component, 'genie_ns / MEDIA_DOCTRINE:RESOLVER');
    } finally {
      feeds.doctrineClaims = realClaims;
    }
    ok('a resolver failure still opens an incident on the second sweep, as before');

    const s = await gap.summary(1);
    assert.equal(s.counts.limit, gap.SUMMARY_LIMIT);
    assert.equal(s.counts.truncated, false);
    assert.equal(s.policy.status, 'PROPOSED');
    ok('summary reads them back with policy PROPOSED, limit 2000 and truncated false');

    assert.ok(calls.every((c) => c.key === 'bays-key-for-test'), 'every ledger call carried the bays lane key');
    ok('every ledger call went to the local stand-in with the bays lane key');
  } finally {
    const ev = await query(`DELETE FROM engine_events WHERE subject_id LIKE $1 OR detail->>'doctrine_id' = $2 OR (event_type LIKE 'doctrine_gap_%' AND subject_id = 'doctrine:genie_ns:MEDIA_DOCTRINE:RESOLVER')`, [`%${DOC}%`, DOC]);
    const doc = await query(`DELETE FROM engine_media_doctrine WHERE doctrine_id = $1`, [DOC]);
    console.log(`  cleaned up ${ev.rowCount} event row(s) and ${doc.rowCount} doctrine row(s) written by this run`);
    await closePool();
    bharag.close();
  }
  console.log(`\n${passed} SE8L database checks passed.`);
})().catch(async (e) => { console.error(e); process.exit(1); });
