/**
 * T0NO's locked seven-field primitive, tested without a database. The runtime
 * wrapper doctrineClaims() supplies doctrineData(); this suite pins the pure
 * canonical resolver and verifies that HTTP and MCP invoke that one wrapper.
 *
 * Run with: npm run test:t0no
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const feeds = require(path.join(DIST, 'server/src/systemFeeds.js'));
const READ_AT = '2026-10-09T00:00:00.000Z';

const claim = (extra = {}) => ({
  claim_id: 'EA-1',
  label: 'Early Access',
  maturity: 'PROVEN_NOW',
  allowed_wording: 'Join Early Access.',
  prohibited_wording: 'Paid access is live.',
  claim_state: 'interest_only_live',
  config_hash: 'cfg-canonical-from-store',
  cad_provenance: { cad_revision: 'CAD-REV-1', provenance_ref: 'OWLG:EVIDENCE-1' },
  evidence_publication_status: 'PUBLISHABLE',
  fail_closed: { needs_evidence: false, reason: null },
  allowed_use: { media_twin: true, vfarm: true, genie_ns: true },
  ...extra,
});

const data = (claims = [claim()]) => ({
  doctrines: [{
    change_id: 'DOC-B93H-v0.1', doctrine_id: 'B93H', doctrine_name: 'Buyer capability list', version: 'v0.1', previous_version: null,
    change_type: 'created', summary: 'test', contract_ids: [], default_patterns: [], claims, approved_by: 'Jason', approved_at: READ_AT,
    changed_at: READ_AT, loop_id: 'LOOP-T0NO', doc_url: null, posted_by: 'Hardik', received_at: READ_AT, changes: 1, retired: false,
  }],
  changes: [], meta: { changes: 1, first_change_at: READ_AT, last_change_at: READ_AT, last_received_at: READ_AT },
  summary: { doctrines_in_force: 1, retired: 0, changes_last_30_days: 1, claims_in_force: claims.length, claims_by_maturity: [], contracts_bound: [], default_patterns: [] },
});

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

const resolved = feeds.resolveDoctrineClaims(data(), {}, READ_AT);
assert.equal(resolved.claims.length, 1);
assert.equal(resolved.claims[0].maturity_state, 'PROVEN_NOW');
assert.equal(resolved.claims[0].fail_closed.needs_evidence, false);
ok('resolver happy path normalizes legacy maturity to maturity_state');

const core = Object.fromEntries(feeds.T0NO_CORE_FIELDS.map((k) => [k, resolved.claims[0][k]]));
assert.deepEqual(Object.keys(core), ['maturity_state', 'claim_state', 'config_hash', 'cad_provenance', 'evidence_publication_status', 'fail_closed', 'allowed_use']);
assert.equal(Object.values(core).some((v) => v === undefined), false);
ok('exact seven-field output shape is present');

assert.equal(resolved.claims[0].config_hash, 'cfg-canonical-from-store');
assert.equal(JSON.stringify(resolved).includes('cfg-canonical-from-store'), true);
ok('config_hash passes through unchanged and is not recomputed');

const missing = feeds.resolveDoctrineClaims(data([claim({ claim_state: null, config_hash: null, cad_provenance: null, evidence_publication_status: null, fail_closed: null, allowed_use: null })]), {}, READ_AT);
assert.deepEqual(missing.claims[0].cad_provenance, { cad_revision: null, provenance_ref: null });
assert.equal(missing.claims[0].evidence_publication_status, 'NEEDS_EVIDENCE');
assert.equal(missing.claims[0].fail_closed.needs_evidence, true);
assert.equal(missing.claims[0].fail_closed.reason, 'MISSING_CLAIM_STATE_AND_CONFIG_HASH_AND_CAD_PROVENANCE_AND_EVIDENCE_PUBLICATION_STATUS_AND_ALLOWED_USE');
assert.deepEqual(missing.claims[0].allowed_use, { media_twin: false, vfarm: false, genie_ns: true });
ok('missing evidence emits the exact evidence classes and fails closed');

const unresolvedCad = feeds.resolveDoctrineClaims(data([claim({ cad_provenance: { cad_revision: null, provenance_ref: 'OWLG:EVIDENCE-1' } })]), {}, READ_AT);
assert.equal(unresolvedCad.claims[0].fail_closed.reason, 'MISSING_CAD_PROVENANCE');
assert.equal(unresolvedCad.claims[0].allowed_use.media_twin, false);
ok('unresolved cad_provenance holds Media Twin publication');

const none = feeds.resolveDoctrineClaims({ ...data([]), doctrines: [] }, { doctrine_id: 'B93H' }, READ_AT);
assert.equal(none.claims.length, 0);
assert.equal(none.warnings.some((w) => w.includes('No doctrine has been posted')), true);
ok('missing doctrine is explicit rather than a silent empty result');

const fallback = feeds.vfarmDoctrineState(missing);
assert.equal(fallback.mode, 'EARLY_ACCESS_SAFE_FALLBACK');
assert.equal(fallback.claim_state, 'interest_only_live');
assert.equal(fallback.paid_subscription_url, null);
assert.equal(fallback.fail_closed.needs_evidence, true);
ok('/vfarm public projection fails closed to interest-only with no paid CTA');

const publishable = feeds.vfarmDoctrineState(resolved);
assert.equal(publishable.mode, 'CANONICAL_DOCTRINE');
assert.deepEqual(publishable.allowed_wording, ['Join Early Access.']);
ok('/vfarm public projection exposes wording only after the canonical gate clears');

const root = path.join(__dirname, '../..');
const httpSource = fs.readFileSync(path.join(root, 'server/src/index.ts'), 'utf8');
const mcpSource = fs.readFileSync(path.join(root, 'server/src/mcp/tools.ts'), 'utf8');
assert.match(httpSource, /api\/engine\/media-doctrine[\s\S]{0,900}systemFeeds\.doctrineClaims\(/);
assert.match(mcpSource, /name: 'read_media_doctrine'[\s\S]{0,2200}systemFeeds\.doctrineClaims\(/);
ok('HTTP and MCP use the same canonical doctrineClaims resolver');

const mediaSource = fs.readFileSync(path.join(root, 'src/screens/MediaTwin/index.tsx'), 'utf8');
assert.match(mediaSource, /data\.resolved/);
assert.match(mediaSource, /data\.publication_decisions/);
assert.match(mediaSource, /d\.decision !== 'allowed' \|\| !d\.applicable/);
ok('Media Twin consumes canonical doctrine plus the persisted publication decision and renders hold');

console.log(`\n${passed} T0NO checks passed.`);
