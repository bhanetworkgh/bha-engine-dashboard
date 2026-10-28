/**
 * SE8L / YEAO, the database half: fencing, takeover, the seq guard, the alarm claim, the rolling
 * restatement, and a doctrine gap reaching Research Twin through researchSignals.open() exactly once.
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:se8l-episode-db
 *
 * Refuses anything but a local database whose name ends in _test, and one that already holds
 * doctrine. Writes its own rows (sweeps, episodes, alarms, one fixture rt-jobs row per case, events)
 * and deletes them. BHARAG and OpenRouter are local stand-ins; nothing leaves this machine.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:se8l-episode-db migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const T = Date.now();
const DOC = `SE8LE${T}`;
const WRITER = `test-writer-se8l-${T}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bharag = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ incidents: [] })); });

(async () => {
  await new Promise((r) => bharag.listen(0, '127.0.0.1', r));
  process.env.BHARAG_API_URL = `http://127.0.0.1:${bharag.address().port}/api/v1`;
  process.env.BHARAG_BAYS_INCIDENTS = 'bays-key-for-test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  delete process.env.DOCTRINE_GAP_WATCH_ENABLED;
  global.fetch = ((real) => async (u, o) => (String(u).endsWith('/credits') ? { status: 200, text: async () => JSON.stringify({ data: { total_credits: 100, total_usage: 0 } }) } : real(u, o)))(global.fetch);

  const DIST = path.join(__dirname, '../../server-dist/server/src');
  const { migrate } = require(`${DIST}/migrations.js`);
  const { query, withTransaction, closePool } = require(`${DIST}/pg.js`);
  const store = require(`${DIST}/doctrineEpisodes.js`);
  const gap = require(`${DIST}/doctrineGap.js`);
  const rs = require(`${DIST}/researchSignals.js`);

  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  const KEY = `doctrine:media_twin:${DOC}:C1`;
  const RKEY = `doctrine-gap:${DOC}:C1:t0no_needs_evidence`;
  const obs = { recovery_key: KEY, surface: 'media_twin', doctrine_id: DOC, claim_id: 'C1', condition: 'needs_evidence', reason: 'X', gap_source: 't0no', observation_id: 'o' };
  const finishAll = () => query(`UPDATE engine_doctrine_gap_sweeps SET state = 'done', finished_at = now() WHERE state = 'running'`);

  try {
    await migrate();
    const held = (await query(`SELECT count(DISTINCT doctrine_id)::int AS n FROM engine_media_doctrine`)).rows[0].n;
    if (held) throw new Error(`test:se8l-episode-db needs a database with no doctrine in it (it holds ${held}).`);
    await finishAll();

    /* -------------------------------------------------------------- sweeps */
    const claims = await Promise.all([store.claimSweep(), store.claimSweep(), store.claimSweep()]);
    const won = claims.filter((c) => c.sweep);
    assert.equal(won.length, 1, 'three claims at once: one sweep');
    const a = won[0].sweep;
    ok('three workers claiming at once get one sweep: the partial unique index decides, not a read beforehand');

    await query(`UPDATE engine_doctrine_gap_sweeps SET heartbeat_at = now() - interval '11 minutes' WHERE seq = $1`, [a.seq]);
    const taken = await store.claimSweep();
    assert.equal(taken.sweep.seq, a.seq, 'the same seq');
    assert.equal(taken.sweep.resumed, true);
    assert.equal(taken.sweep.version, a.version + 1);
    assert.notEqual(taken.sweep.token, a.token);
    const b = taken.sweep;
    await assert.rejects(store.fenced(a, async () => 'x'), store.FencedError);
    assert.equal(await store.finishSweep(a, { keys: 0, claims_read: 0, resolver_error: null }), false);
    await assert.rejects(store.fenced(a, (db) => store.claimAlarmOpen(db, KEY)), store.FencedError);
    assert.equal(await store.readAlarm(KEY), null, 'the stale worker claimed nothing');
    ok('a quiet sweep is taken over under the same seq with a new token, and the old worker can no longer write, finish or claim an alarm');

    // The fence holds the row: a takeover attempted while the owner's transaction is open waits, and
    // then finds the heartbeat the owner just refreshed.
    await query(`UPDATE engine_doctrine_gap_sweeps SET heartbeat_at = now() - interval '11 minutes' WHERE seq = $1`, [b.seq]);
    let takeoverDone = null;
    const inside = store.fenced(b, async () => { const t = store.claimSweep(); takeoverDone = t; await sleep(300); return 'committed'; });
    assert.equal(await inside, 'committed');
    assert.equal((await takeoverDone).sweep, null, 'the takeover waited for the owner and then saw a fresh heartbeat');
    ok('a takeover racing an owner\'s fenced write waits for it and then refuses: the owner\'s write landed under its own token');
    assert.equal(await store.finishSweep(b, { keys: 0, claims_read: 0, resolver_error: null }), true);

    /* ------------------------------------------------------------ episodes */
    const s1 = (await store.claimSweep()).sweep;
    const now1 = await store.fenced(s1, async (db, dbNow) => {
      const e = await store.readEpisode(db, KEY);
      const step = gap.episodeStep(e.open, e.maxSeq, RKEY, { seq: s1.seq, at: s1.at, db_now: dbNow });
      assert.equal(step.action, 'start');
      await store.applyEpisode(db, step, obs, s1.seq);
      return dbNow;
    });
    // The same seq again: a replay, and the guard in SQL as well as in the step.
    await store.fenced(s1, async (db, dbNow) => {
      const e = await store.readEpisode(db, KEY);
      assert.equal(gap.episodeStep(e.open, e.maxSeq, RKEY, { seq: s1.seq, at: s1.at, db_now: dbNow }).action, 'replay');
      const forced = await store.applyEpisode(db, { action: 'confirm', episode_id: e.open.episode_id, at: dbNow }, obs, s1.seq);
      assert.equal(forced.changed, false, 'even a confirm computed on a stale read is refused by last_sweep_seq < seq');
    });
    const ep1 = (await query(`SELECT confirmations, last_sweep_seq::int AS s FROM engine_doctrine_gap_episodes WHERE recovery_key = $1 AND ended_at IS NULL`, [KEY])).rows[0];
    assert.deepEqual(ep1, { confirmations: 1, s: s1.seq });
    await assert.rejects(
      query(`INSERT INTO engine_doctrine_gap_episodes (episode_id, recovery_key, research_key, surface, doctrine_id, claim_id, condition, first_sweep_seq, last_sweep_seq, started_at, last_confirmed_at) VALUES ('DGE-DUP', $1, $2, 'media_twin', $3, 'C1', 'needs_evidence', 1, 1, now(), now())`, [KEY, RKEY, DOC]),
      /duplicate key|unique/,
    );
    assert.ok(now1);
    ok('a replayed reading changes nothing (confirmations 1), a stale confirm is refused in SQL, and a key cannot hold two open episodes');
    await store.finishSweep(s1, { keys: 1, claims_read: 1, resolver_error: null });

    /* -------------------------------------------------------------- alarms */
    const s2 = (await store.claimSweep()).sweep;
    const tokens = await Promise.all([1, 2, 3].map(() => store.fenced(s2, (db) => store.claimAlarmOpen(db, KEY))));
    assert.equal(tokens.filter(Boolean).length, 1, 'one claim wins');
    const token = tokens.find(Boolean);
    assert.equal(await store.recordAlarmOpen(KEY, token, 'INC-SE8LE-1'), true);
    assert.equal(await store.recordAlarmOpen(KEY, 'not-mine', 'INC-SE8LE-2'), false);
    ok('three claims to open one key\'s incident: one wins, and only the winner\'s ledger id is recorded');

    assert.equal(await store.fenced(s2, (db) => store.takeRestatement(db, KEY)), null, 'just opened: not due');
    await query(`UPDATE engine_doctrine_gap_alarms SET last_restated_at = now() - interval '23 hours 59 minutes' WHERE recovery_key = $1`, [KEY]);
    assert.equal(await store.fenced(s2, (db) => store.takeRestatement(db, KEY)), null, 'one minute short of 24 hours');
    await query(`UPDATE engine_doctrine_gap_alarms SET last_restated_at = now() - interval '24 hours' WHERE recovery_key = $1`, [KEY]);
    const slots = await Promise.all([1, 2].map(() => store.fenced(s2, (db) => store.takeRestatement(db, KEY))));
    assert.deepEqual(slots.filter(Boolean), [{ ledger_id: 'INC-SE8LE-1', n: 1 }], 'two at once: one restatement');
    assert.equal(await store.fenced(s2, (db) => store.takeRestatement(db, KEY)), null, 'the window rolls from the restatement just taken');
    ok('an open incident is restated only once 24 hours have passed since the last (rolling, on the database clock), once, however many workers ask');
    await store.recordAlarmClosed(KEY, 'INC-SE8LE-1');
    await store.finishSweep(s2, { keys: 0, claims_read: 0, resolver_error: null });

    /* ---------------------------------------- research, end to end, fixture */
    await query(`UPDATE engine_doctrine_gap_episodes SET started_at = now() - interval '8 days', last_confirmed_at = now() - interval '1 minute' WHERE recovery_key = $1 AND ended_at IS NULL`, [KEY]);
    assert.deepEqual(await rs.detectDoctrineGaps(), [], 'production writers (none): nothing');
    assert.deepEqual(rs.doctrineRefusals().find((r) => r.research_key === RKEY).refusals, ['no_verified_consumer', 'no_real_hit']);
    assert.deepEqual(await rs.detectDoctrineGaps({ writers: [WRITER] }), [], 'a writer but no use: nothing');
    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('doctrine_claim_used', now() - interval '1 day', $1, 'MEDIA', $2, 'YEAO-TEST', $3::jsonb, $4)`,
      [`${DOC}:C1`, WRITER, JSON.stringify({ schema: 'doctrine.claim.use.v1', doctrine_id: DOC, claim_id: 'C1', surface: 'media_twin', consumer: WRITER }), `doctrine_claim_used:${DOC}:1`],
    );
    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('doctrine_claim_used', now(), $1, 'MEDIA', $2, 'YEAO-TEST', $3::jsonb, $4)`,
      [`${DOC}:C1`, `${WRITER}-unlisted`, JSON.stringify({ schema: 'doctrine.claim.use.v1', doctrine_id: DOC, claim_id: 'C1', synthetic: true }), `doctrine_claim_used:${DOC}:2`],
    );
    const sigs = await rs.detectDoctrineGaps({ writers: [WRITER] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].key, RKEY);
    assert.equal(sigs[0].trigger, 'T4');
    assert.equal(sigs[0].rearm_days, 0);
    const fixture = (s) => ({ ...s, fixture: true });
    const opened = await Promise.all([rs.open(fixture(sigs[0])), rs.open(fixture(sigs[0])), rs.open(fixture(sigs[0]))]);
    const jobs = async () => (await query(`SELECT natural_id, fields->>'Status' AS status FROM engine_rt_jobs WHERE fields->>'Signal Key' = $1 ORDER BY id`, [RKEY])).rows;
    assert.equal((await jobs()).length, 1, 'three passes at once, one job (the real advisory lock)');
    assert.ok(opened.some((o) => o.state === 'job_opened'));
    ok('seven verified days, a verified writer\'s use and a real hit open exactly one Research Twin job through open(), even with three passes at once');

    const again = await rs.detectDoctrineGaps({ writers: [WRITER] });
    for (const s of again) await rs.open(fixture(s));
    assert.equal((await jobs()).length, 1, 'while the job is open: nothing new');
    const jobId = (await jobs())[0].natural_id;
    await query(`UPDATE engine_rt_jobs SET fields = jsonb_set(fields, '{Status}', '"Resolved"') WHERE natural_id = $1`, [jobId]);
    assert.deepEqual(await rs.detectDoctrineGaps({ writers: [WRITER] }), [], 'resolved, same episode: skipped');
    ok('a resolved job for the same episode is never reopened, though the signal re-arms at 0 days');

    // Lose the bookkeeping on a second episode's job, resolve it, and run the detector again. The second
    // episode is backdated to make seven days, so the first job is backdated before it, as it would be.
    await query(`UPDATE engine_rt_jobs SET fields = jsonb_set(fields, '{Opened At}', to_jsonb(to_char((now() - interval '9 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE natural_id = $1`, [jobId]);
    await query(`UPDATE engine_doctrine_gap_episodes SET ended_at = now(), end_reason = 'recovered' WHERE recovery_key = $1 AND ended_at IS NULL`, [KEY]);
    await query(
      `INSERT INTO engine_doctrine_gap_episodes (episode_id, recovery_key, research_key, surface, doctrine_id, claim_id, condition, first_sweep_seq, last_sweep_seq, started_at, last_confirmed_at) VALUES ($1, $2, $3, 'media_twin', $4, 'C1', 'needs_evidence', 1000000, 1000000, now() - interval '7 days 1 hour', now())`,
      [`DGE-SE8LE-2-${T}`, KEY, RKEY, DOC],
    );
    await query(`INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('doctrine_claim_used', now(), $1, 'MEDIA', $2, 'YEAO-TEST', $3::jsonb, $4)`, [`${DOC}:C1`, WRITER, JSON.stringify({ schema: 'doctrine.claim.use.v1', doctrine_id: DOC, claim_id: 'C1' }), `doctrine_claim_used:${DOC}:3`]);
    const next = await rs.detectDoctrineGaps({ writers: [WRITER] });
    assert.equal(next.length, 1);
    assert.equal((await rs.open(fixture(next[0]))).state, 'job_opened');
    assert.equal((await jobs()).length, 2, 'a new episode after the job was resolved: one new job');
    await query(`UPDATE engine_research_signals SET job_id = NULL, state = 'opening', opened_at = now() - interval '1 hour' WHERE signal_key = $1`, [RKEY]);
    const second = (await jobs())[1].natural_id;
    await query(`UPDATE engine_rt_jobs SET fields = jsonb_set(fields, '{Status}', '"Resolved"') WHERE natural_id = $1`, [second]);
    for (const s of await rs.detectDoctrineGaps({ writers: [WRITER] })) await rs.open(fixture(s));
    assert.equal((await jobs()).length, 2, 'the lost write is found from the job, never a third job');
    ok('a gap that recovers and returns opens one new job; a lost bookkeeping write on it never opens a third');

    // A resolver outage of any length opens no research.
    const s3 = (await store.claimSweep()).sweep;
    await store.fenced(s3, async (db, dbNow) => {
      const r = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_error: { message: 'down' }, active_consumer: true });
      assert.equal(gap.researchKeyFor(r), null);
      const e = await store.readEpisode(db, r.recovery_key);
      assert.equal(gap.episodeStep(e.open, e.maxSeq, null, { seq: s3.seq, at: s3.at, db_now: dbNow }).action, 'none');
    });
    await store.finishSweep(s3, { keys: 0, claims_read: null, resolver_error: 'down' });
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_doctrine_gap_episodes WHERE recovery_key LIKE '%MEDIA_DOCTRINE:RESOLVER'`)).rows[0].n, 0);
    ok('a resolver outage starts no episode, so no length of outage can reach Research Twin');
  } finally {
    const jobs = await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Signal Key' = $1`, [RKEY]);
    await query(`DELETE FROM engine_research_signals WHERE signal_key = $1`, [RKEY]);
    await query(`DELETE FROM engine_events WHERE subject_id LIKE $1 OR detail->>'doctrine_id' = $2 OR detail->>'key' = $3`, [`%${DOC}%`, DOC, RKEY]);
    await query(`DELETE FROM engine_doctrine_gap_episodes WHERE doctrine_id = $1`, [DOC]);
    await query(`DELETE FROM engine_doctrine_gap_alarms WHERE recovery_key LIKE $1`, [`%${DOC}%`]);
    await finishAll();
    console.log(`  cleaned up ${jobs.rowCount} fixture job(s) and every row this run wrote`);
    await closePool();
    bharag.close();
  }
  console.log(`\n${passed} SE8L episode database checks passed.`);
})().catch(async (e) => { console.error(e); process.exit(1); });
