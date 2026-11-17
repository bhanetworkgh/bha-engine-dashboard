/**
 * Adding to a Decision Watch's next step (17 Nov 2026, DW-1793021830042-3ZQV, INC-BAYS.AGENT-105/106).
 * Pure text rules, no database. Run with: npm run test:decision-watch-add
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const t = require(path.join(DIST, 'server/src/watchText.js'));

const now = new Date('2026-11-17T07:00:00Z');
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const held = 'Still owed from Destiny:\n(1) one\n(2) two\nUpdate 2026-11-13: Update 2026-11-14 (Jason): order';
const jason = "v1 CST rollout is not blocked on a natural 4-hour escalation case; v1 may go live once wording, Hardik's v2 Honest Gate, forced escalation + voice/WhatsApp tests, and PR #59 are verified. The first natural 4-hour escalation is a follow-on gate tracked here, not a rollout blocker.";

ok('an add keeps every held word and puts the new line below it, dated', () => {
  const out = t.addedField('next_step', held, jason, now);
  assert.ok(out.startsWith(held + '\n'));
  assert.equal(out.slice(held.length + 1), `Update 2026-11-17: ${jason}`);
});
ok('a line that already carries its own date gets no second label', () => {
  const out = t.addedField('next_step', held, 'Update 2026-11-16 (Jason, this thread): x', now);
  assert.equal(out, `${held}\nUpdate 2026-11-16 (Jason, this thread): x`);
  assert.ok(!/Update 2026-11-17: Update/.test(out));
});
ok('text already held is not added twice', () => {
  assert.equal(t.addedField('next_step', held, '(2) TWO', now), held);
});
ok('refs still add with a semicolon', () => {
  assert.equal(t.addedField('sop_refs', 'SOP A', 'SOP B', now), 'SOP A; SOP B');
});
ok("3ZQV's real case fits: 2,761 held plus Jason's line is under the new limit", () => {
  const out = t.addedField('next_step', 'x'.repeat(2761), jason, now);
  assert.ok(out.length > 3000 && out.length <= t.NEXT_STEP_LIMIT, String(out.length));
});
ok('limits: next step 6,000, refs 1,200', () => {
  assert.equal(t.fieldLimit('next_step'), 6000);
  assert.equal(t.fieldLimit('ns_refs'), 1200);
});
ok('a full next step on an add says do not rewrite it, ask Destiny or Jason', () => {
  const m = t.tooLongMessage('next_step', 6100, true);
  assert.match(m, /Do not rewrite/);
  assert.match(m, /Destiny or Jason/);
  assert.doesNotMatch(m, /replace: true/);
});
ok('a replace that is too long keeps the old advice', () => {
  assert.match(t.tooLongMessage('next_step', 6100, false), /replace: true/);
});
console.log(`${n} of ${n} passed`);
