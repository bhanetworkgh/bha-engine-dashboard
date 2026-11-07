// Jason's target rule (4 Nov 2026): a reliability claim stated as today's behaviour is `target`, and the
// same words framed as what we are building or testing are not. Pure, no database or network.
const assert = require('node:assert');
const path = require('node:path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'x';
const dist = path.join(process.env.SERVER_DIST || path.join(__dirname, '../../server-dist'), 'server/src');
const m = require(path.join(dist, 'mediaPosts.js'));
let n = 0;
const pending = [];
const ok = (name, fn) => { const r = fn(); const done = () => { n++; console.log('ok', name); }; if (r && typeof r.then === 'function') pending.push(r.then(done)); else done(); };

const REVISED = `Only runs when needed. That's the reliability rule we're designing vFarm around, and we're testing it in Stage 1. We haven't proven it in the field yet.

On 3 Nov, a soil moisture probe failed in one of our trays. The system didn't flag it, and the charts hid the pattern. We're now adding ingest checks, chart fixes and alert rules so a failure like that gets caught, not found later. That work is still in progress.

Until the Stage 1 gates pass and we have a real cabinet log, treat this as the target, not the track record.`;

ok('the accepted post passes', () => assert.equal(m.claimCheck(REVISED).status, 'clean'));
ok('Jason\'s words, as fact, are target', () => {
  for (const t of ['No surprises.', 'It only runs when a tray needs it.', 'It already feels like an appliance, not a science project.', 'No puddles.', 'No stuck valves.', 'You forget to check the cabinet for two days.', 'It ran for two days with no issues.'])
    assert.equal(m.claimCheck(t).status, 'target', t);
});
ok('"small rule" and "is built" do not frame a claim', () => {
  assert.equal(m.claimCheck("Small rule, big difference: it's why this feels like an appliance, not a science project.").status, 'target');
  assert.equal(m.claimCheck("It's how vFarm's watering is built: it only runs when it's actually needed.").status, 'target');
});
ok('framing on the sentence or the next one clears it', () => {
  assert.equal(m.claimCheck("We're building vFarm so it only runs when a tray needs it.").status, 'clean');
  assert.equal(m.claimCheck('No surprises. That is the target we are testing in Stage 1.').status, 'clean');
});
ok('framing further away does not', () => assert.equal(m.claimCheck('No surprises. Then a line. We are testing this in Stage 1.').status, 'target'));
ok('9MSP: goal and not-there-yet framing clears a claim, and a run of claims is framed by the line after it', () => {
  assert.equal(m.claimCheck("No puddles. No stuck valves. No surprises. That's the goal.").status, 'clean');
  assert.equal(m.claimCheck("No surprises. We're not there yet, and we're testing it in Stage 1.").status, 'clean');
  assert.equal(m.claimCheck("Here's a small thing we're working hard to get right: we want vFarm's watering pump to only turn on when a tray actually needs water.").status, 'clean');
  // the rewrite Jason was shown on 6 Nov (MTP-1793984717628-JHYC), Facebook and Instagram, now clean
  assert.equal(m.claimCheck("Here's a small thing we're working hard to get right: we want vFarm's watering pump to only turn on when a tray actually needs water, and shut off the second that job is done.\n\nWe're not there yet and we won't pretend otherwise.").status, 'clean');
  assert.equal(m.claimCheck("No puddles. No stuck valves. No surprises. That's the goal. 💧\n\nWe're designing vFarm's watering to only run when a tray actually needs it, and we're testing that in Stage 1.").status, 'clean');
  // a non-claim between the run and the framing still breaks it
  assert.equal(m.claimCheck("No puddles. Then a line. That's the goal.").status, 'target');
});
ok('9MSP: "acting up" is a failure story', () => {
  assert.equal(m.failureSourceFindings('The monitoring twin learns from every hiccup, like a sensor acting up on our test rack.', [], []).length, 1);
});
ok('blocked outranks target', () => assert.equal(m.claimCheck('No surprises, a fully automated farm.').status, 'blocked'));
ok('the 4 Nov draft Jason sent back is target on every platform and the card', () => {
  const texts = {
    x: "Picture this: you forget to check the cabinet for two days. No puddles. No stuck valve. No surprises. That's not luck, it's how vFarm's watering is built: it only runs when it's actually needed. Less babysitting, more appliance.",
    facebook: "Here's a small thing that matters more than it sounds like: in vFarm, the watering pump only turns on when a tray is actually ready for water, and it shuts off the second that's done. No guessing, no stuck valves, no puddles to find later.\n\nIt's a tiny rule, but it's the difference between a science project you have to babysit and something that just works quietly in the corner of your kitchen. That's the kind of boring reliability we're building vFarm around.",
    linkedin: "Picture this: you forget to check the cabinet for two days. No water pooling at the bottom. No valve stuck open. Nothing ran when it shouldn't have.\n\nThat's not luck. That's the point.\n\nEvery plumbing run in vFarm is built so the pump only turns on when a tray is actually calling for water.",
    instagram: "No puddles. No stuck valves. No surprises.\n\nIn vFarm, the watering only runs when a tray actually needs it, and it stops the second the job's done. Small rule, big difference: it's why this feels like an appliance, not a science project you have to babysit.",
    card: "Why vFarm\nOnly runs *when needed.*\nThe watering in vFarm only turns on when a tray is ready, and stops the moment it's done.\nJoin vFarm Early Access",
  };
  for (const [k, t] of Object.entries(texts)) assert.equal(m.claimCheck(t).status, 'target', k);
});
const gate = (cleared) => ({ cleared, checks: [], missing: cleared ? [] : ['no real Stage 1 record has passed'], read_at: 'now' });
ok('an uncleared gate keeps target and names what is missing', () => {
  const r = m.settleTarget(m.claimCheck('No surprises.').findings, gate(false));
  assert.equal(r.status, 'target');
  assert.match(r.findings[0].why, /no real Stage 1 record/);
});
ok('a cleared gate leaves it flagged for Jason', () => assert.equal(m.settleTarget(m.claimCheck('No surprises.').findings, gate(true)).status, 'flagged'));

// Jason's reference pattern (6 Nov 2026): food and harvest claims are flagged, and a failure story rests on a held record.
const TRAY_A = `Picture this: a soil moisture probe died in one of our grow trays, and for a while, every reading still said "ok."

That happened on 3 Nov, on Tray A, while we were running Stage 1 tests on our rack. The sensor failed, and because we hadn't built the right checks yet, the charts didn't catch it either.

We don't want vFarm to be a cabinet you have to babysit. The rule we're designing it around: if something fails, you hear about it before it matters, not after. We're not there yet.

So we're building it: plausibility and jump checks at the point data comes in. That work is in progress, not finished.

Join vFarm Early Access: bhanetwork.org/vfarm`;
ok('the Tray A post Jason approved passes the text rules', () => assert.equal(m.claimCheck(TRAY_A).status, 'clean'));
ok('food and ingredient claims are flagged', () => {
  for (const t of ["No additive you can't pronounce.", 'Pesticide-free greens at home.', 'Healthier than the store.', 'Grown without chemicals.'])
    assert.equal(m.claimCheck(t).findings.some((f) => f.rule === 'food_or_ingredient_claim'), true, t);
});
ok('harvest timing claims are flagged', () => {
  for (const t of ['It tastes better when you picked it an hour ago.', 'Fresh from your harvest tonight.', 'Minutes from harvest to plate.'])
    assert.equal(m.claimCheck(t).findings.some((f) => f.rule === 'harvest_timing_claim'), true, t);
});
ok('ordinary lines are not', () => {
  for (const t of ['You watch it grow and pick it yourself.', 'Open the door, grab fresh strawberries.'])
    assert.equal(m.claimCheck(t).status, 'clean', t);
});
ok('source ids are read from anywhere in the sources', () =>
  assert.deepEqual(m.sourceIds({ loops: ['LOOP-1791428275782-TU4O'], codex: ['CODEX-20261030-ahad-vfarm-sensor-timeout'], slack: [] }), ['LOOP-1791428275782-TU4O', 'CODEX-20261030-ahad-vfarm-sensor-timeout']));
ok('a failure story with no record is flagged', () => assert.equal(m.failureSourceFindings(TRAY_A, [], [])[0].rule, 'failure_story_unsourced'));
ok('a failure story whose records are not held is flagged', () => assert.equal(m.failureSourceFindings(TRAY_A, ['LOOP-1000000000000-ABCD'], [])[0].rule, 'failure_story_source_not_found'));
ok('a failure story on a held record passes', () => assert.equal(m.failureSourceFindings(TRAY_A, ['LOOP-1791428275782-TU4O'], ['LOOP-1791428275782-TU4O']).length, 0));
ok('a post with no failure needs no record', () => assert.equal(m.failureSourceFindings('Open the door, grab fresh strawberries.', [], []).length, 0));
// The approver-of-record trial (7 Nov 2026): Approve posts live on weekdays to Sat 14 Nov, never on a weekend, then the pattern gate again.
const noDb = { query: async () => { throw new Error('the trial must not read the database'); } };
ok('trial: a weekday approval posts without a pattern', async () => {
  const r = await m.autoPostFor(noDb, { pattern_ref: null, test: false }, 'x', new Date('2026-11-09T15:00:00Z'));
  assert.equal(r.post, true); assert.equal(r.mode, 'post');
});
ok('trial: a weekend approval only records', () => {
  assert.equal(m.trialWindow(new Date('2026-11-08T15:00:00Z')).open, false);
  assert.equal(m.trialWindow(new Date('2026-11-14T15:00:00Z')).open, false);
});
ok('trial: Friday evening in New York is still a weekday', () => assert.equal(m.trialWindow(new Date('2026-11-14T03:00:00Z')).open, true));
ok('trial: LinkedIn stays by hand', async () => assert.equal((await m.autoPostFor(noDb, { pattern_ref: null, test: false }, 'linkedin', new Date('2026-11-10T15:00:00Z'))).post, false));
ok('trial: a test draft only checks', async () => assert.equal((await m.autoPostFor(noDb, { pattern_ref: null, test: true }, 'instagram', new Date('2026-11-10T15:00:00Z'))).mode, 'check'));
ok('after the trial the pattern gate holds again', async () => assert.equal((await m.autoPostFor(noDb, { pattern_ref: null, test: false }, 'x', new Date('2026-11-16T15:00:00Z'))).post, false));
Promise.all(pending).then(() => console.log(n, 'checks passed'), (e) => { console.error(e); process.exit(1); });
