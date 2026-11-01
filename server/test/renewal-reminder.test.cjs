/**
 * The renewal reminder (1 Nov 2026, after n8n Cloud lapsed on an unfunded card). Part 1: the rule and
 * the card, no database. Part 2: against a LOCAL _test database with Slack stood in: one card per
 * stage, a refused post is retried and Destiny told, a passed date rolls forward by its cycle.
 * Run with:  npm run test:renewal-reminder
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
// Part 1 needs no database: where pg is not installed, load the pure functions against the stub.
try { require.resolve('pg'); } catch {
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'pg') return require.resolve('./_pg-stub.cjs');
    return realResolve.call(this, request, ...rest);
  };
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const r = require(path.join(DIST, 'server/src', 'renewalReminder.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

(async () => {
  assert.deepEqual([8, 7, 5, 4, 3, 2, 1, 0, -1].map(r.stageFor), [null, 7, 7, 7, 3, 3, 1, 1, null]);
  ok('7 days out is the 7-day card, 3 or 2 the 3-day card, 1 or today the last call, past or far away nothing');

  assert.equal(r.daysUntil('2026-12-01', '2026-11-24'), 7);
  assert.equal(r.nextRenewal('2026-11-01', 'monthly', '2026-11-02'), '2026-12-01');
  assert.equal(r.nextRenewal('2026-01-31', 'monthly', '2026-02-01'), '2026-02-28');
  assert.equal(r.nextRenewal('2026-09-01', 'monthly', '2026-11-02'), '2026-12-01');
  assert.equal(r.nextRenewal('2026-11-01', 'yearly', '2026-11-02'), '2027-11-01');
  assert.equal(r.nextRenewal('2026-11-01', 'monthly', '2026-11-01'), null);
  assert.equal(r.nextRenewal('2026-11-01', 'one-off', '2026-11-05'), null);
  ok('a passed date moves on by its cycle (month ends clamp, missed months skip), today and one-offs stay');

  const n8n = { id: 'n8n-cloud', name: 'n8n Cloud', url: 'https://app.n8n.cloud', plan: 'Cloud Pro-2', paid_with: 'Visa 6967 (Destiny)', cost_amount: 155.52, cost_currency: 'USD', billing_cycle: 'monthly', renewal_date: '2026-12-01', status: 'active' };
  const due = r.due([n8n, { ...n8n, id: 'gone', status: 'retired' }, { ...n8n, id: 'nodate', renewal_date: null }], '2026-11-28');
  assert.deepEqual(due.map((d) => [d.service.id, d.days, d.stage]), [['n8n-cloud', 3, 3]]);
  ok('only active tools with a date are due; a retired tool and a tool with no date are skipped');

  const m = r.message(n8n, 3, 3);
  assert.equal(m.blocks[0].text.text, ':large_orange_circle: n8n Cloud renews in 3 days');
  const fields = m.blocks[2].fields.map((f) => f.text);
  assert.deepEqual(fields, ['*Renews*\nTue 1 Dec 2026', '*Amount*\n$155.52 monthly', '*Paid with*\nVisa 6967 (Destiny)', '*Plan*\nCloud Pro-2']);
  assert.match(m.blocks[4].elements[0].text, /cc <@U0AEW3TBYH1> <@U0A9V97949F>/);
  assert.match(r.message(n8n, 1, 1).blocks[0].text.text, /renews tomorrow$/);
  assert.match(r.message(n8n, 1, 1).blocks[1].text.text, /^\*Last call/);
  assert.equal(r.amountText({ ...n8n, cost_amount: null }), 'Not recorded');
  assert.match(r.message({ ...n8n, what_it_is_for: 'Runs every workflow.' }, 1, 1).blocks[1].text.text, /Runs every workflow\.$/);
  ok('the card names when, the date, the amount, the card that pays and the plan, and tags Destiny and Jason');

  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  const registry = require(path.join(DIST, 'server/src', 'registry.js'));
  await migrate();
  const wipe = async () => {
    await query(`DELETE FROM engine_events WHERE subject_id LIKE 'test-renewal%'`);
    await query(`DELETE FROM registry_services WHERE id LIKE 'test-renewal%'`);
  };
  await wipe();
  await assert.rejects(registry.create('services', { name: 'Test renewal card', paid_with: '4111 1111 1111 1111' }), /never a card number/);
  ok('a full card number is refused in paid_with and nothing is written');
  await registry.create('services', { name: 'Test renewal tool', cost_amount: 10, billing_cycle: 'monthly', renewal_date: '2026-11-04', paid_with: 'Visa 6967 (Destiny)' });
  const id = 'test-renewal-tool';
  const posts = [];
  const dms = [];
  const okPost = async (ch, msg) => { posts.push({ ch, msg }); return { ok: true, detail: 'posted', ts: '1.1' }; };
  const failPost = async () => ({ ok: false, detail: 'Slack refused the renewal alert: not_in_channel' });
  const dm = async (to, text) => { dms.push({ to, text }); return { ok: true, detail: 'sent' }; };

  const dry = await r.check({ today: '2026-11-01', only: id, dry_run: true, post: okPost, dm });
  assert.deepEqual(dry.alerts.map((a) => [a.stage, a.outcome]), [[3, 'would_post']]);
  assert.equal(posts.length, 0);
  ok('a dry run names the 3-day card and posts nothing');

  const failed = await r.check({ today: '2026-11-01', only: id, post: failPost, dm });
  assert.equal(failed.alerts[0].outcome, 'post_failed');
  assert.equal((await query(`SELECT count(*)::int c FROM engine_events WHERE subject_id = $1 AND event_type = 'registry_renewal_alert_sent'`, [id])).rows[0].c, 0);
  assert.equal(dms.length, 1);
  await r.check({ today: '2026-11-01', only: id, post: failPost, dm });
  assert.equal(dms.length, 1);
  ok('a refused post gives the claim back and tells Destiny once that day');

  const sent = await r.check({ today: '2026-11-01', only: id, post: okPost, dm });
  assert.equal(sent.alerts[0].outcome, 'posted');
  const again = await r.check({ today: '2026-11-02', only: id, post: okPost, dm });
  assert.equal(again.alerts[0].outcome, 'already_posted');
  const last = await r.check({ today: '2026-11-03', only: id, post: okPost, dm });
  assert.deepEqual(last.alerts.map((a) => [a.stage, a.outcome]), [[1, 'posted']]);
  assert.equal(posts.length, 2);
  ok('each stage posts once: the 3-day card, nothing the next day, then the last call');

  const test = await r.check({ today: '2026-11-03', only: id, channel_override: 'CSANDBOX', post: okPost, dm });
  assert.equal(test.alerts[0].outcome, 'posted');
  assert.equal(posts[2].ch, 'CSANDBOX');
  ok('a sandbox run posts again without claiming');

  const rolled = await r.check({ today: '2026-11-05', only: id, post: okPost, dm });
  assert.deepEqual(rolled.rolled, [{ id, from: '2026-11-04', to: '2026-12-04' }]);
  assert.equal((await query(`SELECT renewal_date FROM registry_services WHERE id = $1`, [id])).rows[0].renewal_date, '2026-12-04');
  ok('the day after renewal the date rolls a month on, and the next cycle starts clean');

  await wipe();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
