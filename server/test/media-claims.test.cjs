// Jason's target rule (4 Nov 2026): a reliability claim stated as today's behaviour is `target`, and the
// same words framed as what we are building or testing are not. Pure, no database or network.
const assert = require('node:assert');
const path = require('node:path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'x';
const dist = path.join(process.env.SERVER_DIST || path.join(__dirname, '../../server-dist'), 'server/src');
const m = require(path.join(dist, 'mediaPosts.js'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

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
console.log(n, 'checks passed');
