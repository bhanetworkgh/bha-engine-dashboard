/**
 * The missing Codex log check (2026-10-22, DW-9EP8). Part 1: the rule, no database. Part 2: against a
 * LOCAL _test database with Slack stood in: one DM per gap, a refused DM is retried, a new log resets it.
 * Run with:  npm run test:codex-gap
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const gap = require(path.join(DIST, 'server/src', 'codexGap.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const H = 3_600_000;

(async () => {
  const now = new Date('2026-10-22T18:00:00Z');
  const b = (user_id, days_logged, hoursAgo) => ({ user_id, name: null, days_logged, last_log_at: new Date(now.getTime() - hoursAgo * H).toISOString() });
  const gaps = gap.findGaps([b('UREG', 9, 31), b('UFRESH', 9, 29), b('URARE', 4, 80), b('U0A9V97949F', 9, 90)], now);
  assert.deepEqual(gaps.map((g) => g.user_id), ['UREG']);
  ok('only a regular logger past 30 hours is flagged; a recent log, a rare logger and Jason are not');
  assert.equal(gaps[0].dedupe_key, `codex_gap:UREG:${new Date(now.getTime() - 31 * H).toISOString()}`);
  assert.match(gap.builderText(gaps[0]), /no Codex log from you has reached the engine since .* \(31 hours ago\)/);
  ok('the gap is keyed on the builder and their newest log, and the DM says how long');

  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  await migrate();
  const wipe = async () => {
    await query(`DELETE FROM engine_events WHERE event_type = 'codex_log_gap_flagged' AND subject_id LIKE 'UTESTGAP%'`);
    await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TESTGAP-%'`);
  };
  await wipe();
  const ins = async (id, uid, at) => query(
    `INSERT INTO engine_codex_submissions (natural_id, builder_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, 'testgap', $2, $3::jsonb, 'engine', $2, $2)`,
    [id, at.toISOString(), JSON.stringify({ 'Submission ID': id, 'Builder User ID': uid })],
  );
  for (let d = 2; d <= 7; d++) await ins(`TESTGAP-${d}`, 'UTESTGAP1', new Date(now.getTime() - d * 24 * H));
  const sent = [];
  const okSend = async (to, text) => { sent.push({ to, text }); return { ok: true, detail: 'sent' }; };
  const failSend = async () => ({ ok: false, detail: 'channel_not_found' });

  const dry = await gap.check({ now, dry_run: true, send: okSend });
  assert.equal(dry.gaps.find((g) => g.user_id === 'UTESTGAP1').outcome, 'would_flag');
  assert.equal(sent.length, 0);
  ok('a dry run lists the gap and sends nothing');

  const failed = await gap.check({ now, send: failSend });
  assert.equal(failed.gaps.find((g) => g.user_id === 'UTESTGAP1').outcome, 'dm_failed');
  assert.equal((await query(`SELECT count(*)::int AS c FROM engine_events WHERE subject_id = 'UTESTGAP1'`)).rows[0].c, 0);
  ok('a DM Slack refuses gives the claim back, so the next pass tries again');

  const first = await gap.check({ now, send: okSend });
  assert.equal(first.gaps.find((g) => g.user_id === 'UTESTGAP1').outcome, 'flagged');
  assert.deepEqual(sent.map((s) => s.to), ['UTESTGAP1', gap.DESTINY]);
  const again = await gap.check({ now: new Date(now.getTime() + 2 * H), send: okSend });
  assert.equal(again.gaps.find((g) => g.user_id === 'UTESTGAP1').outcome, 'already_flagged');
  assert.equal(sent.length, 2);
  ok('one DM to the builder and one copy to Destiny per gap, never repeated');

  await ins('TESTGAP-NEW', 'UTESTGAP1', new Date(now.getTime() + 3 * H));
  const later = new Date(now.getTime() + 40 * H);
  const next = await gap.check({ now: later, send: okSend });
  assert.equal(next.gaps.find((g) => g.user_id === 'UTESTGAP1').outcome, 'flagged');
  ok('a new log resets it, and the next gap is flagged once');

  await wipe();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
