/**
 * VRFK and SE8L against a real Postgres: the SQL that test:vrfk and test:se8l
 * can only read as text. It executes readDecisions(), storeDecision()'s
 * duplicate read and doctrineGap.summary(), and shows the claim-key expression
 * VRFK shipped with is refused by Postgres.
 *
 * Needs DATABASE_URL on localhost or 127.0.0.1 whose database name ends in
 * _test. It refuses anything else: it creates engine_events when the table is
 * absent (the definition from migrations.ts, "engine_events: the engine's own
 * structured events") and deletes every row it wrote.
 *
 * Run with: DATABASE_URL=postgres://user@127.0.0.1:5432/name_test npm run test:vrfk-db
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:vrfk-db writes and deletes engine_events rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { query, closePool } = require(path.join(DIST, 'server/src/pg.js'));
const vrfk = require(path.join(DIST, 'server/src/publicationDecision.js'));
const gap = require(path.join(DIST, 'server/src/doctrineGap.js'));

const RUN = `vrfkdb-${process.pid}-${Date.now()}`;
const claim = (claim_id, extra = {}) => ({
  doctrine_id: 'B93H', doctrine_version: 'v0.1', change_id: 'CHANGE-1', claim_id, label: 'Early Access',
  maturity_state: 'PROVEN_NOW', claim_state: 'interest_only_live', config_hash: 'cfg-held',
  cad_provenance: { cad_revision: 'CAD-1', provenance_ref: 'OWLG:E-1' }, evidence_publication_status: 'PUBLISHABLE',
  fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: true, vfarm: true, genie_ns: true },
  ...extra,
});
const input = (claim_id, extra = {}) => ({
  decision_id: `DEC-${RUN}`, doctrine_id: 'B93H', claim_id, surface: 'media_twin', actor: 'test:vrfk-db',
  source_ref: 'LOOP-1789929222646-VRFK', decided_at: '2026-10-10T00:00:00.000Z', evidence_refs: ['EVIDENCE-1'], ...extra,
});

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  await query(`CREATE TABLE IF NOT EXISTS engine_events (
     id          bigserial PRIMARY KEY,
     event_type  text NOT NULL,
     at          timestamptz NOT NULL DEFAULT now(),
     subject_id  text NOT NULL,
     lane        text,
     actor       text,
     source_ref  text,
     detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
     dedupe_key  text UNIQUE,
     recorded_at timestamptz NOT NULL DEFAULT now()
   )`);
  const version = (await query('SELECT version() AS v')).rows[0].v;
  console.log(`  against ${version.split(',')[0]}`);
  try {
    await assert.rejects(
      query(`SELECT 1 FROM engine_events WHERE (detail->>'doctrine_id' || ':' || detail->>'claim_id') = ANY($1::text[]) LIMIT 1`, [['B93H:x']]),
      /operator does not exist: text ->> unknown/,
    );
    ok('the claim-key expression as VRFK shipped it is refused by Postgres: text ->> unknown');

    const a = `EA-${RUN}`;
    const b = `OTHER-${RUN}`;
    const empty = await vrfk.readDecisions([claim(a), claim(b)], 'media_twin');
    assert.deepEqual(empty.decisions.map((d) => d.reason), ['MISSING_PUBLICATION_DECISION', 'MISSING_PUBLICATION_DECISION']);
    ok('readDecisions executes and fails closed when no decision is held');

    const stored = await vrfk.storeDecision(input(a), claim(a));
    assert.equal(stored.recorded, true);
    assert.equal(stored.duplicate, false);
    await vrfk.storeDecision(input(a, { decision_id: `DEC-VFARM-${RUN}`, surface: 'vfarm' }), claim(a));
    const read = await vrfk.readDecisions([claim(a), claim(b)], 'media_twin');
    assert.equal(read.decisions[0].decision, 'allowed');
    assert.equal(read.decisions[0].applicable, true);
    assert.equal(read.decisions[0].event_id, stored.id);
    assert.equal(read.decisions[1].reason, 'MISSING_PUBLICATION_DECISION');
    assert.deepEqual(read.counts, { claims: 2, allowed: 1, held: 1 });
    ok('a stored decision reads back as applicable for its own claim and surface only');

    const again = await vrfk.storeDecision(input(a, { reason: 'A different reason' }), claim(a));
    assert.equal(again.recorded, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, stored.id);
    assert.equal(again.decision.reason, 'T0NO_GATE_CLEARED');
    assert.deepEqual(again.differs_from_request, ['reason']);
    const same = await vrfk.storeDecision(input(a), claim(a));
    assert.deepEqual(same.differs_from_request, []);
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE dedupe_key = $1`, [`VFAM.claim_publication_decision:DEC-${RUN}`])).rows[0].n, 1);
    ok('a reused decision_id writes nothing, answers with the stored row, and only a real difference is named');

    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key)
       SELECT 'doctrine_gap_observed', now() - (n || ' seconds')::interval, $1, 'MEDIA', 'test:vrfk-db', 'LOOP-1791557096370-SE8L',
              jsonb_build_object('recovery_key', $1::text, 'condition', 'needs_evidence', 'surface', 'media_twin', 'doctrine_id', 'B93H',
                                 'claim_id', $2::text, 'observed_at', to_char((now() - (n || ' seconds')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                                 'evidence_state', 'not_had', 'owner_hint', 'Hardik / doctrine owner'),
              $1 || ':' || n
         FROM generate_series(1, $3::int) AS n`,
      [`doctrine:media_twin:B93H:${RUN}`, a, gap.SUMMARY_LIMIT + 1],
    );
    const s = await gap.summary(1);
    assert.equal(s.counts.observations, gap.SUMMARY_LIMIT);
    assert.equal(s.counts.limit, gap.SUMMARY_LIMIT);
    assert.equal(s.counts.truncated, true);
    assert.match(s.note, /every count here is a floor/);
    ok(`summary executes and reports truncated past ${gap.SUMMARY_LIMIT} observations instead of cutting silently`);
  } finally {
    const del = await query(`DELETE FROM engine_events WHERE subject_id LIKE $1`, [`%${RUN}%`]);
    console.log(`  cleaned up ${del.rowCount} row(s) written by this run`);
    await closePool();
  }
  console.log(`\n${passed} VRFK database checks passed.`);
})().catch(async (e) => { console.error(e); try { await closePool(); } catch {} process.exit(1); });
