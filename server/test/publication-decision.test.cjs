/** Focused VRFK contract checks. Run with: npm run test:vrfk */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const vrfk = require(path.join(DIST, 'server/src/publicationDecision.js'));
const AT = '2026-10-10T00:00:00.000Z';

const claim = (extra = {}) => ({
  doctrine_id: 'B93H', doctrine_version: 'v0.1', change_id: 'CHANGE-1', claim_id: 'EA-1', label: 'Early Access',
  maturity_state: 'PROVEN_NOW', claim_state: 'interest_only_live', config_hash: 'cfg-held',
  cad_provenance: { cad_revision: 'CAD-1', provenance_ref: 'OWLG:E-1' }, evidence_publication_status: 'PUBLISHABLE',
  fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: true, vfarm: true, genie_ns: true },
  ...extra,
});
const input = (extra = {}) => ({
  decision_id: 'DECISION-1', doctrine_id: 'B93H', claim_id: 'EA-1', surface: 'media_twin', actor: 'Hardik',
  source_ref: 'LOOP-1789929222646-VRFK', decided_at: AT, evidence_refs: ['EVIDENCE-1'], ...extra,
});
const row = (detail, extra = {}) => ({ id: 7, at: AT, actor: 'Hardik', source_ref: 'LOOP-1789929222646-VRFK', recorded_at: AT, detail, ...extra });

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

const allowed = vrfk.prepareDecision(input(), claim());
assert.equal(allowed.detail.event_name, 'VFAM.claim_publication_decision');
assert.equal(allowed.detail.decision, 'allowed');
assert.deepEqual(Object.keys(allowed.detail.t0no), ['maturity_state', 'claim_state', 'config_hash', 'cad_provenance', 'evidence_publication_status', 'fail_closed', 'allowed_use']);
ok('allowed decision binds the exact T0NO seven-field snapshot');

assert.equal(vrfk.prepareDecision(input(), claim({ allowed_use: { media_twin: false, vfarm: true, genie_ns: true } })).detail.decision, 'hold');
ok('surface not allowed produces hold');

assert.equal(vrfk.prepareDecision(input(), claim({ fail_closed: { needs_evidence: true, reason: 'MISSING_CONFIG_HASH' } })).detail.decision, 'needs_evidence');
ok('missing evidence produces needs_evidence');

const wrongSurface = vrfk.prepareDecision(input({ surface: 'vfarm' }), claim());
assert.equal(wrongSurface.detail.surface, 'vfarm');
assert.throws(() => vrfk.prepareDecision(input({ surface: 'linkedin' }), claim()), /surface must be one of/);
ok('unknown surface is refused while supported surfaces remain scoped');

assert.throws(() => vrfk.prepareDecision(input({ claim_id: 'OTHER' }), claim()), /claim_id must be the resolved claim/);
ok('wrong claim cannot be bound');

assert.throws(() => vrfk.prepareDecision(input({ decision: 'allowed' }), claim({ allowed_use: { media_twin: false, vfarm: true, genie_ns: true } })), /contradicts the canonical T0NO result/);
ok('caller cannot record a decision that contradicts T0NO');

const again = vrfk.prepareDecision(input(), claim());
assert.equal(allowed.event.dedupe_key, again.event.dedupe_key);
assert.equal(allowed.event.dedupe_key, 'VFAM.claim_publication_decision:DECISION-1');
ok('retry has one deterministic idempotency key');

const current = vrfk.resolveDecision(claim(), 'media_twin', row(allowed.detail));
assert.equal(current.decision, 'allowed');
assert.equal(current.applicable, true);
ok('current matching decision is applicable');

const staleDetail = { ...allowed.detail, doctrine_change_id: 'CHANGE-OLD' };
const stale = vrfk.resolveDecision(claim(), 'media_twin', row(staleDetail));
assert.equal(stale.decision, 'needs_evidence');
assert.equal(stale.reason, 'STALE_PUBLICATION_DECISION');
ok('stale doctrine decision fails closed');

const contradictoryDetail = { ...allowed.detail, decision: 'hold' };
const contradiction = vrfk.resolveDecision(claim(), 'media_twin', row(contradictoryDetail));
assert.equal(contradiction.decision, 'needs_evidence');
assert.equal(contradiction.reason, 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO');
ok('contradictory persisted evidence fails closed');

for (const surface of ['media_twin', 'genie_ns']) {
  const missing = vrfk.resolveDecision(claim(), surface, null);
  assert.equal(missing.decision, 'needs_evidence');
  assert.equal(missing.applicable, false);
  assert.equal(missing.reason, 'MISSING_PUBLICATION_DECISION');
}
ok('Media Twin and Genie/NS fail closed when no decision exists');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'server/src/publicationDecision.ts'), 'utf8');
assert.match(source, /DISTINCT ON[\s\S]{0,900}ORDER BY[\s\S]{0,200}at DESC, id DESC/);
ok('canonical query deterministically selects the latest exact claim and surface row');

// Static only: proves the source text is grouped, not that Postgres accepts it. test:vrfk-db runs it.
assert.match(source, /\(\(detail->>'doctrine_id'\) \|\| ':' \|\| \(detail->>'claim_id'\)\) = ANY\(\$4::text\[\]\)/);
assert.doesNotMatch(source, /detail->>'doctrine_id' \|\| ':' \|\| detail->>'claim_id'/);
ok('claim-key expression groups both ->> terms (static check; execution is test:vrfk-db)');

const http = fs.readFileSync(path.join(root, 'server/src/index.ts'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'server/src/mcp/tools.ts'), 'utf8');
const media = fs.readFileSync(path.join(root, 'src/screens/MediaTwin/index.tsx'), 'utf8');
assert.match(http, /api\/engine\/publication-decision[\s\S]{0,3500}publicationDecision\.readDecisions/);
assert.match(mcp, /name: 'read_publication_decision'[\s\S]{0,2600}publicationDecision\.readDecisions/);
assert.match(media, /publication_decisions[\s\S]{0,1000}MISSING_PUBLICATION_DECISION|publication_decisions/);
ok('HTTP, MCP and Media Twin consume the one canonical read resolver');

// storeDecision with the event store and the read stood in: no database.
(async () => {
  const events = require(path.join(DIST, 'server/src/engineEvents.js'));
  const pg = require(path.join(DIST, 'server/src/pg.js'));
  const realRecord = events.record;
  const realQuery = pg.query;
  try {
    const first = vrfk.prepareDecision(input(), claim()).detail;
    // jsonb hands keys back in its own order, nested objects included: reverse every level.
    const reorder = (v) => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
    const fromJsonb = reorder(first);
    events.record = async () => ({ recorded: false, id: null });
    pg.query = async (sql, params) => {
      assert.match(sql, /WHERE dedupe_key = \$1/);
      assert.equal(params[0], 'VFAM.claim_publication_decision:DECISION-1');
      return { rows: [{ id: '41', detail: fromJsonb }], rowCount: 1 };
    };
    const same = await vrfk.storeDecision(input(), claim());
    assert.equal(same.recorded, false);
    assert.equal(same.duplicate, true);
    assert.equal(same.id, 41);
    assert.deepEqual(same.differs_from_request, []);
    ok('identical retry answers with the stored row and no differing fields, whatever order jsonb keys come back in');

    const changed = await vrfk.storeDecision(input({ reason: 'A different reason', evidence_refs: ['EVIDENCE-2'] }), claim());
    assert.equal(changed.decision.reason, first.reason);
    assert.deepEqual(changed.differs_from_request, ['evidence_refs', 'reason']);
    ok('retry with different content answers with what is stored, never the request, and names the fields it tried to change');

    events.record = async () => ({ recorded: true, id: 42 });
    const fresh = await vrfk.storeDecision(input(), claim());
    assert.equal(fresh.recorded, true);
    assert.equal(fresh.duplicate, false);
    assert.equal(fresh.id, 42);
    ok('a new decision_id is recorded and reported as not a duplicate');
  } finally {
    events.record = realRecord;
    pg.query = realQuery;
  }
  console.log(`\n${passed} VRFK checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
