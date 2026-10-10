/** Focused SE8L checks. Run with: npm run test:se8l */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const gap = require(path.join(DIST, 'server/src/doctrineGap.js'));

const claim = (extra = {}) => ({
  doctrine_id: 'B93H', doctrine_version: 'v0.1', change_id: 'CHANGE-1', claim_id: 'CAP-1', label: 'Capability',
  maturity_state: 'PROVEN_NOW', claim_state: 'interest_only_live', config_hash: 'cfg-held',
  cad_provenance: { cad_revision: 'CAD-1', provenance_ref: 'OWLG:E-1' }, evidence_publication_status: 'PUBLISHABLE',
  fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: true, vfarm: true, genie_ns: true },
  ...extra,
});
const publication = (extra = {}) => ({
  schema: 'vfam.claim_publication_decision.read.v1', event_name: 'VFAM.claim_publication_decision', doctrine_id: 'B93H', claim_id: 'CAP-1', surface: 'media_twin',
  decision: 'allowed', recorded_decision: 'allowed', applicable: true, reason: 'T0NO_GATE_CLEARED', decision_id: 'DEC-1', event_id: 1,
  decided_at: '2026-10-10T00:00:00.000Z', recorded_at: '2026-10-10T00:00:00.000Z', actor: 'Hardik', source_ref: 'VRFK', evidence_refs: [], doctrine_change_id: 'CHANGE-1',
  ...extra,
});
const at = (o, time) => ({ ...o, observed_at: time });
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

const healthy = gap.classify({ surface: 'media_twin', claim: claim(), publication: publication(), active_consumer: true });
assert.equal(healthy.condition, 'healthy');
assert.equal(healthy.evidence_state, 'verified');
assert.equal(gap.policyFor(healthy, []).incident, false);
ok('healthy canonical T0NO plus applicable VRFK stays quiet');

const unavailable = gap.classify({ surface: 'genie_ns', resolver_error: { message: 'connection refused' }, active_consumer: true });
assert.equal(unavailable.condition, 'resolver_unavailable');
assert.equal(gap.policyFor(unavailable, []).incident, false);
const priorUnavailable = at({ ...unavailable, observation_id: 'old' }, '2026-10-10T00:00:00.000Z');
const currentUnavailable = at({ ...unavailable, observation_id: 'new' }, '2026-10-10T00:01:00.000Z');
assert.equal(gap.policyFor(currentUnavailable, [priorUnavailable], Date.parse('2026-10-10T00:01:00.000Z')).incident, true);
ok('resolver failure incidents on the second consecutive observation');

const unauthorized = gap.classify({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' }, active_consumer: true });
assert.equal(unauthorized.condition, 'unauthorized_read');
assert.equal(gap.policyFor(unauthorized, []).incident, true);
ok('production-style authorization failure is immediate');

const malformed = gap.classify({ surface: 'vfarm', claim: { doctrine_id: 'B93H' }, active_consumer: true });
assert.equal(malformed.condition, 'malformed_response');
assert.equal(gap.policyFor(malformed, []).incident, true);
ok('malformed T0NO response fails closed immediately');

const needs = gap.classify({ surface: 'media_twin', claim: claim({ fail_closed: { needs_evidence: true, reason: 'MISSING_RUNTIME_PROOF' }, evidence_publication_status: 'NEEDS_EVIDENCE' }), publication: null, active_consumer: true });
assert.equal(needs.condition, 'needs_evidence');
assert.equal(gap.policyFor(needs, []).incident, false);
const n1 = at({ ...needs, observation_id: 'n1' }, '2026-10-10T00:00:00.000Z');
const n2 = at({ ...needs, observation_id: 'n2' }, '2026-10-10T01:00:00.000Z');
const n3 = at({ ...needs, observation_id: 'n3' }, '2026-10-10T02:00:00.000Z');
assert.equal(gap.policyFor(n3, [n1, n2], Date.parse(n3.observed_at)).incident, true);
ok('one-off needs_evidence is guidance; third active-consumer observation in 24h incidents');

const missingConfigInternal = gap.classify({ surface: 'media_twin', claim: claim({ config_hash: null }), publication: publication(), requires_mechanical_provenance: true, requested_use: 'internal' });
assert.equal(missingConfigInternal.condition, 'healthy');
const missingConfigPublic = gap.classify({ surface: 'media_twin', claim: claim({ config_hash: null }), publication: publication(), requires_mechanical_provenance: true, attempted_public_use: true, requested_use: 'render', active_consumer: true });
assert.equal(missingConfigPublic.condition, 'missing_critical_field');
assert.equal(missingConfigPublic.reason, 'MISSING_CONFIG_HASH');
assert.equal(gap.policyFor(missingConfigPublic, []).incident, true);
ok('mechanical identity blocks an attempted public render but not an unrelated internal read');

const missingCad = gap.classify({ surface: 'media_twin', claim: claim({ cad_provenance: { cad_revision: null, provenance_ref: null } }), publication: publication(), requires_mechanical_provenance: true, attempted_public_use: true, requested_use: 'render', active_consumer: true });
assert.equal(missingCad.reason, 'UNRESOLVED_CAD_PROVENANCE');
ok('unresolved CAD provenance is named rather than inferred');

const noTrace = gap.classify({ surface: 'vfarm', claim: claim(), publication: null, attempted_public_use: true, requested_use: 'public', active_consumer: true });
assert.equal(noTrace.condition, 'publication_trace_missing');
assert.equal(gap.policyFor(noTrace, []).incident, true);
ok('attempted public use without VRFK trace opens an incident');

const hold = gap.classify({ surface: 'media_twin', claim: claim(), publication: publication({ decision: 'hold', recorded_decision: 'hold', applicable: true, reason: 'OWNER_HOLD' }) });
assert.equal(hold.condition, 'publication_hold');
assert.equal(gap.policyFor(hold, []).incident, false);
ok('an applicable VRFK hold is observed without noisy incident creation');

const contradiction = gap.classify({ surface: 'media_twin', claim: claim(), publication: publication({ decision: 'needs_evidence', recorded_decision: 'allowed', applicable: false, reason: 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO' }) });
assert.equal(contradiction.condition, 'contradictory_evidence');
assert.equal(gap.policyFor(contradiction, []).incident, true);
ok('contradictory evidence is immediate and critical');

const stale = gap.classify({ surface: 'media_twin', claim: claim(), publication: publication({ decision: 'needs_evidence', applicable: false, reason: 'STALE_PUBLICATION_DECISION' }), active_consumer: true });
assert.equal(stale.condition, 'stale_evidence');
assert.equal(gap.policyFor(stale, []).incident, false);
const s1 = at({ ...stale, observation_id: 's1' }, '2026-10-10T00:00:00.000Z');
const s2 = at({ ...stale, observation_id: 's2' }, '2026-10-10T01:00:00.000Z');
const s3 = at({ ...stale, observation_id: 's3' }, '2026-10-10T02:00:00.000Z');
assert.equal(gap.policyFor(s3, [s1, s2], Date.parse(s3.observed_at)).incident, true);
ok('stale evidence stays quiet once and incidents at the proposed repeat threshold');

const paid = gap.classify({ surface: 'vfarm', claim: claim(), publication: publication({ surface: 'vfarm' }), requested_use: 'paid', attempted_public_use: true, active_consumer: true });
assert.equal(paid.condition, 'prohibited_surface_use');
assert.equal(paid.reason, 'PAID_CLAIM_BLOCKED_BY_INTEREST_ONLY_LIVE');
ok('paid claim under interest_only_live is deterministically prohibited');

const eventA = gap.observationEvent(healthy);
const eventB = gap.observationEvent(healthy);
assert.equal(eventA.dedupe_key, eventB.dedupe_key);
assert.equal(eventA.detail.recovery_key, healthy.recovery_key);
ok('same observation has deterministic event dedupe and stable recovery identity');

const h1 = at({ ...healthy, observation_id: 'h1' }, '2026-10-10T03:00:00.000Z');
const h2 = at({ ...healthy, observation_id: 'h2' }, '2026-10-10T04:00:00.000Z');
assert.equal(gap.policyFor(h1, [n1]).recover, false);
assert.equal(gap.policyFor(h2, [n1, h1]).recover, true);
assert.equal(gap.guidanceFor(h2).card_recommendation, 'none');
ok('recovery requires two healthy reads and does not auto-close owner cards/loops');

const grouped = gap.aggregateObservations([n1, n2, n3, h1, h2]);
assert.equal(grouped.find((x) => x.condition === 'needs_evidence').count, 3);
ok('Research Twin hook aggregates recurrence with denominator and time bounds');

assert.equal(gap.guidanceFor(missingConfigPublic).action, 'NEEDS_EVIDENCE');
assert.match(gap.guidanceFor(missingConfigPublic).next_action, /config_hash/);
assert.equal(gap.guidanceFor(unavailable).action, 'RESTORE_SERVICE');
ok('North Star guidance names owner action and never upgrades absent evidence');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'server/src/doctrineGap.ts'), 'utf8');
const http = fs.readFileSync(path.join(root, 'server/src/index.ts'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'server/src/mcp/tools.ts'), 'utf8');
const scopes = fs.readFileSync(path.join(root, 'server/src/mcp/index.ts'), 'utf8');
assert.match(source, /engineEvents\.record\(observationEvent\(o\)\)/);
assert.match(source, /bharag\.openIncident\('bays'/);
assert.match(source, /markRetrying\('bays'[ -￿]*closeIncident\('bays'/);
assert.match(http, /api\/engine\/doctrine-gaps[ -￿]*doctrineGap\.summary/);
assert.match(mcp, /name: 'read_doctrine_gap_summary'[ -￿]*doctrineGap\.summary/);
assert.match(scopes, /agent: 'north_star'[ -￿]{0,1100}read_doctrine_gap_summary/);
assert.match(scopes, /agent: 'research_twin'[ -￿]{0,700}read_doctrine_gap_summary/);
ok('Engine events, BHARAG lifecycle, HTTP and scoped MCP consumers share one module');

console.log(`\n${passed} SE8L checks passed.`);
