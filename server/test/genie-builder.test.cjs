/**
 * Genie Builder interactions (2026-11-09): the stage checks, the two-builder gate and the proof rules,
 * pure, with no database. The store's SQL runs live on the dashboard (proof in BUILD_LOG).
 * Run with: npm run test:genie-builder
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const gb = require(path.join(DIST, 'server/src/genieBuilder'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const refuses = (fn, re, m) => { assert.throws(fn, (e) => e.status === 422 && re.test(e.message)); ok(m); };

const base = { interaction_id: 'req_1', rail_id: 'genie-slack-n8n', proof_type: 'test_forced' };
const queued = { ...base, stage: 'queued', requester_id: 'U0AD1V1D65N', intent: 'publish_workflow', live_touching: true, live_touching_reason: 'publish activates a workflow', genie_plan_id: 'p1', plan_summary: 'publish it', context_sources: ['none found'], surface: 'slack', reuse_check: { result: 'built_new', matches: [], justification: 'no flow publishes this workflow yet' } };

const q = gb.parseStage(queued);
assert.equal(q.stage, 'queued'); assert.equal(q.cols.live_touching, true); ok('a full queued message parses');
refuses(() => gb.parseStage({ ...queued, proof_type: 'verified' }), /proof_type/, 'an unknown proof_type is refused');
refuses(() => gb.parseStage({ ...queued, proof_type: undefined }), /proof_type is required/, 'a missing proof_type is refused');
refuses(() => gb.parseStage({ ...queued, live_touching_reason: '' }), /live_touching_reason/, 'live-touching with no reason is refused');
refuses(() => gb.parseStage({ ...queued, context_sources: undefined }), /context_sources/, 'no context sources is refused (G4)');
refuses(() => gb.parseStage({ ...queued, stage: 'done' }), /stage/, 'an unknown stage is refused');

const appr = { ...base, stage: 'approval', approver_id: 'U0AEW3TBYH1', approvals_required: 2, two_builder_check: 'passed', approval_decision: 'granted' };
const a = gb.parseStage(appr);
const held = { rail_id: 'genie-slack-n8n', requester_id: 'U0AD1V1D65N', live_touching: true, approval_decision: null, two_builder_check: null };
gb.crossCheck(a, held); ok('a second builder granting a live-touching action passes');
refuses(() => gb.crossCheck(gb.parseStage({ ...appr, approver_id: 'U0AD1V1D65N' }), held), /approved their own/, 'the requester approving their own live-touching action is refused');
refuses(() => gb.parseStage({ ...appr, approvals_required: 2, two_builder_check: 'not_required' }), /cannot be not_required/, 'two approvals with not_required is refused');
refuses(() => gb.parseStage({ ...appr, two_builder_check: 'rejected_self_approval' }), /cannot be granted/, 'a granted rejected self-approval is refused');
const denied = gb.parseStage({ ...appr, approver_id: 'U0AD1V1D65N', two_builder_check: 'rejected_self_approval', approval_decision: 'denied' });
assert.equal(denied.cols.error_or_stop_reason, 'approval_denied'); gb.crossCheck(denied, held); ok('a denied self-approval is stored with approval_denied');

const term = { ...base, stage: 'terminal', status: 'succeeded', live_effect: true, backend_artifact_id: 'AbC', backend_debrief: { nodes: 3 }, submission: { id: 'AbC' } };
refuses(() => gb.crossCheck(gb.parseStage(term), held), /no granted approval/, 'live_effect true with no granted approval held is refused');
gb.crossCheck(gb.parseStage(term), { ...held, approval_decision: 'granted', two_builder_check: 'passed' }); ok('live_effect true after a passed two-builder grant is accepted');
refuses(() => gb.parseStage({ ...term, submission: undefined }), /submission is required/, 'a finish with no submission is refused (G3)');
gb.parseStage({ ...term, live_effect: false, backend_debrief: undefined, submission: undefined, error_or_stop_reason: 'n8n validate failed' }); ok('a stop with a reason needs no debrief or submission');
refuses(() => gb.crossCheck(gb.parseStage({ ...term, rail_id: 'other' }), held), /differs/, 'a different rail on the same interaction is refused');

const rev = { ...base, stage: 'review', rater_id: 'U0AD1V1D65N', builder_decision: 'accepted', usefulness_rating: 4 };
assert.equal(gb.parseStage(rev).cols.usefulness_rating, 4); ok('a review with a rating parses');
refuses(() => gb.parseStage({ ...rev, usefulness_rating: null }), /never null/, 'a null rating is refused (G2)');
refuses(() => gb.parseStage({ ...rev, usefulness_rating: 6 }), /1 to 5/, 'a rating of 6 is refused');

const row = (over) => ({ interaction_id: 'x', rail_id: 'r', proof_type: 'live_natural', queued_at: '2026-11-09T00:00:00Z', approved_at: null, finished_at: null, usefulness_rating: null, builder_decision: null, received_at: '', updated_at: '', ...over });
const now = Date.parse('2026-11-12T00:00:00Z');
assert.equal(gb.derive(row({}), now).stage_reached, 'queued'); ok('a queued-only row reads queued');
const late = gb.derive(row({ finished_at: '2026-11-09T12:00:00Z' }), now);
assert.equal(late.feedback_failed, true); assert.equal(late.counts_toward_proof, false); ok('finished, unreviewed for over 48h is a failed feedback loop, not counted');
const fresh = gb.derive(row({ finished_at: '2026-11-11T12:00:00Z' }), now);
assert.equal(fresh.feedback_failed, false); ok('finished and unreviewed inside 48h is awaiting review');
const done = gb.derive(row({ finished_at: '2026-11-10T00:00:00Z', usefulness_rating: 4, builder_decision: 'accepted' }), now);
assert.equal(done.counts_toward_proof, true); assert.equal(done.stage_reached, 'review'); ok('finished and reviewed counts toward the proof');
const s = gb.summarise([done, late, gb.derive(row({ proof_type: 'test_forced', finished_at: '2026-11-10T00:00:00Z', usefulness_rating: 2, builder_decision: 'rejected' }), now)]);
assert.equal(s.live_natural.counted_toward_proof, 1); assert.equal(s.live_natural.average_rating, 4); assert.equal(s.test_forced.rejected, 1); assert.equal(s.live_natural.feedback_failed, 1);
ok('the summary keeps tests apart from real use');


// 22 Nov 2026: every build is recorded, with its surface and reuse check; a build without Genie carries its reason;
// production is marked only once the rule holds.
refuses(() => gb.parseStage({ ...queued, surface: undefined }), /surface is required/, 'a planned build with no surface is refused');
refuses(() => gb.parseStage({ ...queued, reuse_check: undefined }), /reuse_check is required/, 'a planned build with no reuse check is refused');
refuses(() => gb.parseStage({ ...queued, reuse_check: { result: 'built_new', matches: [] } }), /needs a justification/, 'built new with no justification is refused');
refuses(() => gb.parseStage({ ...queued, reuse_check: { result: 'extended', matches: [] } }), /needs matches/, 'extended naming nothing is refused');
assert.equal(gb.parseStage({ ...queued, reuse_check: { result: 'extended', matches: ['BP-GENIE-1'] } }).cols.reuse_result, 'extended'); ok('an extended build naming its pattern parses');
const notUsed = { ...base, interaction_id: 'cc_1', rail_id: 'claude-code', stage: 'not_used', requester_id: 'U0AEW3TBYH1', surface: 'claude_code', build_ref: 'bha-engine-dashboard commit abc', plan_summary: 'Genie Builder record widened', not_used_category: 'not_applicable', not_used_reason: 'built in the dashboard repo directly to save tokens', reuse_check: { result: 'extended', matches: ['genie.builder.interaction.v1'] } };
const nu = gb.parseStage(notUsed);
assert.equal(nu.cols.used_genie, false); ok('a build done without Genie parses with used_genie false');
refuses(() => gb.parseStage({ ...notUsed, not_used_reason: '' }), /not_used_reason is required/, 'a build without Genie and no reason is refused');
refuses(() => gb.parseStage({ ...notUsed, not_used_category: 'lazy' }), /not_used_category/, 'an unknown not-used category is refused');
refuses(() => gb.crossCheck(gb.parseStage({ ...appr, interaction_id: 'cc_1' }), { ...held, used_genie: false }), /Genie was not used/, 'an approval on a build done without Genie is refused');
const prod = { ...base, stage: 'production', marked_by: 'U0AEW3TBYH1' };
refuses(() => gb.crossCheck(gb.parseStage(prod), null), /no Genie Builder record/, 'production with no record is refused');
refuses(() => gb.crossCheck(gb.parseStage(prod), { ...held, used_genie: true, reuse_result: 'reused', finished_at: 'x', builder_decision: null }), /not reviewed it as accepted/, 'production before an accepted review is refused');
refuses(() => gb.crossCheck(gb.parseStage(prod), { ...held, used_genie: true, reuse_result: null, finished_at: 'x', builder_decision: 'accepted' }), /no reuse check/, 'production with no reuse check is refused');
gb.crossCheck(gb.parseStage(prod), { ...held, used_genie: true, reuse_result: 'reused', finished_at: 'x', builder_decision: 'modified' }); ok('production after a modified review and a reuse check passes');
gb.crossCheck(gb.parseStage(prod), { ...held, used_genie: false, reuse_result: 'built_new', not_used_reason: 'too slow' }); ok('production for a build without Genie, reason recorded, passes');
const nuRow = gb.derive(row({ used_genie: false, not_used_reason: 'x', reuse_result: 'extended' }), now);
assert.equal(nuRow.stage_reached, 'not_used'); assert.equal(nuRow.counts_toward_proof, false); assert.deepEqual(nuRow.production_blockers, []); ok('a build without Genie reads not_used, counts nothing, and may be marked production');
const s2 = gb.summarise([done, nuRow]);
assert.equal(s2.all.without_genie, 1); assert.equal(s2.all.with_genie, 1); assert.equal(s2.all.reuse.extended, 1); ok('the summary counts builds with and without Genie and the reuse results');

console.log(`\n${n} passed`);
