/**
 * engineStrain.assess (27 Oct 2026, 7RZT): the state and what each audience is told.
 * Pure: no database, no network. Run with `npm run test:engine-strain`.
 */
const assert = require('node:assert/strict');
const { assess } = require('../../server-dist/server/src/engineStrain.js');

const base = {
  hours: 24, credit_out_total: 0, credit_out_last_hour: 0, credit_out_latest_at: null,
  openrouter_held_now: 0, openrouter_balance_usd: null, fallbacks_total: 0, fallbacks_last_hour: 0,
  fallbacks_answered: 0, fallbacks_failed: 0, fallbacks_unchecked: 0,
  draft_evals_on_backup: 0, draft_evals_stopped_for_credit: 0, voided_logs: 0,
};
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('ok', passed, '-', name); };
const OUTSIDE = ['pilot_operator', 'early_buyer', 'genie'];
const MECHANICS = /openrouter|anthropic|402|credit floor|recovery watcher|incident|execution/i;

check('nothing happened is normal, and says so with the window', () => {
  const a = assess(base);
  assert.equal(a.state, 'normal');
  assert.match(a.summary, /running normally/);
  assert.match(a.summary, /24 hours/);
  assert.equal(a.reasons.length, 0);
});

check('a hold now is strained, and the team line names the count and the balance', () => {
  const a = assess({ ...base, openrouter_held_now: 2, openrouter_balance_usd: 0.69 });
  assert.equal(a.state, 'strained');
  assert.match(a.audiences.team, /2 OpenRouter run\(s\) are held/);
  assert.match(a.audiences.team, /\$0\.69/);
  assert.match(a.audiences.genie, /2 held run\(s\) will be re-run/);
});

check('a credit refusal or a backup answer in the last hour is strained', () => {
  assert.equal(assess({ ...base, credit_out_total: 1, credit_out_last_hour: 1 }).state, 'strained');
  assert.equal(assess({ ...base, fallbacks_total: 3, fallbacks_last_hour: 1 }).state, 'strained');
});

check('earlier in the window only is recovering, and says none in the last hour', () => {
  const a = assess({ ...base, credit_out_total: 5, fallbacks_total: 49 });
  assert.equal(a.state, 'recovering');
  assert.match(a.audiences.team, /none in the last hour/);
  assert.match(a.audiences.genie, /back to normal/);
});

check('outside audiences never hear the mechanics and never hear "down"', () => {
  for (const counts of [base, { ...base, openrouter_held_now: 4, credit_out_last_hour: 2, credit_out_total: 2 }, { ...base, fallbacks_total: 9 }]) {
    const a = assess(counts);
    for (const k of OUTSIDE) {
      const line = k === 'genie' ? a.audiences.genie.split('If asked how it is answering')[0] : a.audiences[k];
      assert.doesNotMatch(line, MECHANICS, `${k} leaked mechanics: ${line}`);
      assert.doesNotMatch(line, /\bdown\b/i, `${k} said down: ${line}`);
    }
  }
});

check('pilot and buyer lines do not change with strain: a person stands in front of both', () => {
  const calm = assess(base), busy = assess({ ...base, openrouter_held_now: 3, credit_out_last_hour: 1, credit_out_total: 1 });
  assert.equal(calm.audiences.pilot_operator, busy.audiences.pilot_operator);
  assert.equal(calm.audiences.early_buyer, busy.audiences.early_buyer);
  assert.match(busy.audiences.pilot_operator, /a person answers within 4 hours/);
});

check('failed and unchecked fallbacks are named apart, never counted as answered', () => {
  const a = assess({ ...base, fallbacks_total: 6, fallbacks_answered: 3, fallbacks_failed: 1, fallbacks_unchecked: 2 });
  assert.match(a.audiences.team, /1 fallback\(s\) did not produce a real answer/);
  assert.match(a.audiences.team, /2 fallback\(s\) were recorded before answers were checked/);
});

check('a voided log is named as housekeeping and alone does not make the engine strained', () => {
  const a = assess({ ...base, voided_logs: 2 });
  assert.equal(a.state, 'normal');
  assert.match(a.audiences.team, /housekeeping, not strain/);
});

check('the Media Twin line allows the backup claim with its evidence and forbids uptime', () => {
  const a = assess(base);
  assert.match(a.audiences.media_twin, /49651/);
  assert.match(a.audiences.media_twin, /Not safe to claim: any uptime figure/);
});

console.log(`\n${passed} passed`);
